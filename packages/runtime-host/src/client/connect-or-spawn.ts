import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
} from '../control/root-authority.js';
import { performance } from 'node:perf_hooks';
import {
  requireClientInstanceId,
  validateProtocolRange,
  type ClientSurface,
  type HostIncompatible,
  type ProtocolRange,
} from '../protocol/index.js';
import {
  connectResolvedRuntimeHost,
  type ConnectRuntimeHostResult,
  type RuntimeHostConnection,
} from './connection.js';
import { launchDetachedRuntimeHostCandidate, type CandidateLauncher } from './launcher.js';

const DEFAULT_ELECTION_DEADLINE_MS = 45_000;
const DEFAULT_BACKOFF_MIN_MS = 20;
const DEFAULT_BACKOFF_MAX_MS = 250;
const MIN_CANDIDATE_INTERVAL_MS = 250;
// 单次选举窗口内候选 launch 总数上限（A6）：候选冷启动慢的环境（实测 19-31s）
// 下，"每 250ms 补一个候选"会在 45s 窗口内堆积几十个在途候选——晚到的候选
// 可能在 winner 落定甚至优雅关停之后才接手注册写锁/守卫锁，把关停确定性打穿。
// 封顶后选举循环仍持续轮询直到 deadline：无论哪个候选先就绪都能连上，损失的
// 只是"同一窗口内第 4 个及以后的冗余候选"。真正的候选失败由后续调用的全新
// 选举窗口兜底（connectOrSpawn 每次调用重置计数）。
// 修正（2026-08-16）：真机事故暴露"窗口烧光"形态——首候选在启动后期崩溃
// （EPERM/任何原因），后续兄弟候选又被其残留 legacy 锁拒绝，3 个名额全部
// 耗尽后窗口只能等死。活满 MEANINGFUL_CANDIDATE_LIFETIME_MS 后死亡的候选
// （真实启动过、非秒退的守卫拒绝）不占名额：给一次补发机会，风暴防护不
// 变——秒退候选（守卫拒绝）仍全额计数。
const DEFAULT_MAX_CANDIDATE_LAUNCHES = 3;
const MEANINGFUL_CANDIDATE_LIFETIME_MS = 5_000;

export interface ConnectOrSpawnRuntimeHostInput {
  rootPath: string;
  surface: ClientSurface;
  protocol: ProtocolRange;
  clientInstanceId?: string;
  electionDeadlineMs?: number;
  /**
   * Cap on candidate launches within a single election window (default 3).
   * Slow-candidate environments must not turn the election loop into a spawn
   * storm; polling continues until the deadline regardless of the cap.
   */
  maxCandidateLaunches?: number;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** Forwarded to a spawned candidate (its idle self-exit grace). */
  idleGraceMs?: number;
  /** Forwarded to a spawned candidate (its server-side operation deadline). */
  operationDeadlineMs?: number;
  candidateEntrypoint?: string | URL;
  legacyConfigurationRoot?: string;
  /**
   * Extra env merged into a spawned candidate (overrides the client's own env).
   * Domain candidates may need it, e.g. a pico daemon candidate resolving a
   * PICO_HOME-derived legacy endpoint guard independently of the client's env.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Directory receiving each spawned candidate's stdout/stderr log. Defaults to
   * `<control directory>/candidate-logs` so crash evidence exists by the time
   * anyone goes looking for it; override for tests or to concentrate diagnostics.
   */
  candidateLogDirectory?: string;
}

interface ConnectOrSpawnRuntimeHostDependencies {
  launchCandidate: CandidateLauncher;
  random(): number;
}

const defaultDependencies: ConnectOrSpawnRuntimeHostDependencies = {
  launchCandidate: launchDetachedRuntimeHostCandidate,
  random: Math.random,
};

export type ConnectOrSpawnRuntimeHostResult =
  | { kind: 'connected'; connection: RuntimeHostConnection }
  | { kind: 'incompatible'; handshake: HostIncompatible }
  | { kind: 'failed'; reason: 'startup_timeout' | 'host_unresponsive' };

export async function connectOrSpawnRuntimeHost(
  input: ConnectOrSpawnRuntimeHostInput,
): Promise<ConnectOrSpawnRuntimeHostResult> {
  return connectOrSpawnRuntimeHostWithDependencies(input, defaultDependencies);
}

export async function connectOrSpawnRuntimeHostWithDependencies(
  input: ConnectOrSpawnRuntimeHostInput,
  dependencies: ConnectOrSpawnRuntimeHostDependencies,
): Promise<ConnectOrSpawnRuntimeHostResult> {
  const deadlineMs = input.electionDeadlineMs ?? DEFAULT_ELECTION_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 120_000) {
    throw new RangeError('electionDeadlineMs must be an integer between 1 and 120000');
  }
  const maxCandidateLaunches = input.maxCandidateLaunches ?? DEFAULT_MAX_CANDIDATE_LAUNCHES;
  if (
    !Number.isSafeInteger(maxCandidateLaunches) ||
    maxCandidateLaunches < 1 ||
    maxCandidateLaunches > 16
  ) {
    throw new RangeError('maxCandidateLaunches must be an integer between 1 and 16');
  }
  validateProtocolRange(input.protocol);
  requireOptionalTimeout(input.connectTimeoutMs, 'connectTimeoutMs', 1);
  requireOptionalTimeout(input.handshakeTimeoutMs, 'handshakeTimeoutMs', 1);
  requireOptionalTimeout(input.operationDeadlineMs, 'operationDeadlineMs', 1);
  const clientInstanceId = requireClientInstanceId(input.clientInstanceId ?? randomUUID());
  const capability = await resolveStorageRoot({ path: input.rootPath, kind: 'interactive' });
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  // Root authority initialization must settle before the bounded election window begins.
  const startedAt = performance.now();
  const deadline = startedAt + deadlineMs;
  let nextCandidateAt = startedAt;
  let candidateLaunches = 0;
  const launchedCandidates: Array<{ pid?: number; launchedAt: number; discounted: boolean }> = [];
  let backoffMs = DEFAULT_BACKOFF_MIN_MS;
  let sawUnresponsiveEndpoint = false;

  while (performance.now() < deadline) {
    const result = await connectResolvedRuntimeHost({
      capability,
      controlDirectory,
      surface: input.surface,
      protocol: input.protocol,
      clientInstanceId,
      connectTimeoutMs: input.connectTimeoutMs,
      handshakeTimeoutMs: input.handshakeTimeoutMs,
      electionDeadline: deadline,
    });
    if (result.kind === 'election_deadline_elapsed') {
      if (result.endpointConnected) sawUnresponsiveEndpoint = true;
      break;
    }
    if (result.kind === 'connected') return { kind: 'connected', connection: result.connection };
    if (result.kind === 'unavailable' && result.reason === 'handshake_failed') {
      sawUnresponsiveEndpoint = true;
    }
    if (isBlockingIncompatibility(result)) {
      return { kind: 'incompatible', handshake: result.handshake };
    }

    const now = performance.now();
    discountDeadMeaningfulCandidates(launchedCandidates, () => {
      candidateLaunches -= 1;
    });
    if (
      shouldLaunchCandidate(result) &&
      now >= nextCandidateAt &&
      candidateLaunches < maxCandidateLaunches
    ) {
      try {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        const launch = dependencies.launchCandidate({
          rootPath: capability.canonicalPath,
          expectedRootId: capability.rootId,
          ...(input.idleGraceMs === undefined ? {} : { idleGraceMs: input.idleGraceMs }),
          ...(input.handshakeTimeoutMs === undefined
            ? {}
            : { handshakeTimeoutMs: input.handshakeTimeoutMs }),
          ...(input.operationDeadlineMs === undefined
            ? {}
            : { operationDeadlineMs: input.operationDeadlineMs }),
          ...(input.candidateEntrypoint === undefined
            ? {}
            : { entrypoint: input.candidateEntrypoint }),
          ...(input.legacyConfigurationRoot === undefined
            ? {}
            : { legacyConfigurationRoot: input.legacyConfigurationRoot }),
          ...(input.env === undefined ? {} : { env: input.env }),
          logDirectory:
            input.candidateLogDirectory ?? join(controlDirectory, 'candidate-logs'),
        });
        const attempt = await settleBeforeDeadline(launch.spawned, deadline);
        launchedCandidates.push({
          pid: attempt.pid,
          launchedAt: performance.now(),
          discounted: false,
        });
      } catch {
        // A failed Candidate attempt is ordinary election evidence; discovery continues.
      }
      nextCandidateAt = now + MIN_CANDIDATE_INTERVAL_MS;
      candidateLaunches += 1;
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    const random = dependencies.random();
    const jitter = 0.75 + Math.min(1, Math.max(0, Number.isFinite(random) ? random : 0.5)) * 0.5;
    await sleep(Math.min(remaining, Math.max(1, Math.round(backoffMs * jitter))));
    backoffMs = Math.min(DEFAULT_BACKOFF_MAX_MS, backoffMs * 2);
  }
  return {
    kind: 'failed',
    reason: sawUnresponsiveEndpoint ? 'host_unresponsive' : 'startup_timeout',
  };
}

function isBlockingIncompatibility(
  result: ConnectRuntimeHostResult,
): result is Extract<ConnectRuntimeHostResult, { kind: 'incompatible' }> {
  return result.kind === 'incompatible' && result.handshake.replacement === 'blocked_by_residency';
}

function shouldLaunchCandidate(result: ConnectRuntimeHostResult): boolean {
  return result.kind === 'unavailable' || result.kind === 'draining';
}

/**
 * 活满 MEANINGFUL_CANDIDATE_LIFETIME_MS 后死亡的候选不占 launch 名额（一次性
 * 折扣）：真实启动过又崩溃的候选值得补发，而秒退的守卫拒绝候选全额计数——
 * 后者正是 A6 封顶要防的堆叠形态。
 */
function discountDeadMeaningfulCandidates(
  launched: Array<{ pid?: number; launchedAt: number; discounted: boolean }>,
  discount: () => void,
): void {
  for (const candidate of launched) {
    if (candidate.discounted || candidate.pid === undefined) continue;
    if (performance.now() - candidate.launchedAt < MEANINGFUL_CANDIDATE_LIFETIME_MS) continue;
    if (isProcessAlive(candidate.pid)) continue;
    candidate.discounted = true;
    discount();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Windows 上对其他用户的活进程返回 EPERM——仍视为存活。
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settleBeforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.reject(new Error('Runtime Host election deadline elapsed'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Runtime Host election deadline elapsed')),
      remaining,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function requireOptionalTimeout(value: number | undefined, label: string, minimum: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < minimum || value > 120_000) {
    throw new RangeError(`${label} must be an integer between ${minimum} and 120000`);
  }
}
