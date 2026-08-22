import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
} from "../control/root-authority.js";
import { performance } from "node:perf_hooks";
import {
  requireClientInstanceId,
  validateProtocolRange,
  type ClientSurface,
  type HostIncompatible,
  type ProtocolRange,
} from "../protocol/index.js";
import {
  connectResolvedRuntimeHost,
  type ConnectRuntimeHostResult,
  type RuntimeHostConnection,
} from "./connection.js";
import { launchDetachedRuntimeHostCandidate, type CandidateLauncher } from "./launcher.js";
import {
  isPermanentCandidateStartupFailure,
  type CandidateStartupFailure,
  type CandidateStartupFailureReason,
} from "../candidate-startup-failure.js";

const DEFAULT_ELECTION_DEADLINE_MS = 45_000;
const DEFAULT_BACKOFF_MIN_MS = 20;
const DEFAULT_BACKOFF_MAX_MS = 250;
// 候选 launch 有意不设数量上限（2026-08-17 回滚 A6 封顶与名额返还，对齐
// maka 形态）：仅靠 250ms 最小间隔 + 45s 选举窗口 + flock 淘汰 loser 约束。
// 已知代价：慢冷启动环境（实测候选 19-31s 就绪）单窗口可积数十在途候选；
// 确定性失败场景（候选秒退循环）缺 fast-fail 刹车，会以 ~4/s 空转到 deadline。
const MIN_CANDIDATE_INTERVAL_MS = 250;

export interface ConnectOrSpawnRuntimeHostInput {
  rootPath: string;
  surface: ClientSurface;
  protocol: ProtocolRange;
  clientInstanceId?: string;
  electionDeadlineMs?: number;
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
  | { kind: "connected"; connection: RuntimeHostConnection }
  | { kind: "incompatible"; handshake: HostIncompatible }
  | {
      kind: "failed";
      reason: "startup_timeout" | "host_unresponsive" | CandidateStartupFailureReason;
    };

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
    throw new RangeError("electionDeadlineMs must be an integer between 1 and 120000");
  }
  validateProtocolRange(input.protocol);
  requireOptionalTimeout(input.connectTimeoutMs, "connectTimeoutMs", 1);
  requireOptionalTimeout(input.handshakeTimeoutMs, "handshakeTimeoutMs", 1);
  requireOptionalTimeout(input.operationDeadlineMs, "operationDeadlineMs", 1);
  const clientInstanceId = requireClientInstanceId(input.clientInstanceId ?? randomUUID());
  const capability = await resolveStorageRoot({ path: input.rootPath, kind: "interactive" });
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  // Root authority initialization must settle before the bounded election window begins.
  const startedAt = performance.now();
  const deadline = startedAt + deadlineMs;
  let nextCandidateAt = startedAt;
  let backoffMs = DEFAULT_BACKOFF_MIN_MS;
  let sawUnresponsiveEndpoint = false;
  // 退出码协议的消费端：候选 startupFailure 报告异步到达（exit 事件），记账
  // 在途报告数；只保留"最永久"的一条（永久类可覆盖非永久类，反之不可——
  // 偶发内部失败不能抹掉已确认的永久失败）。刹车条件=已有永久失败且所有在
  // 途报告收齐（pending===0），避免并发候选中另一个正走在成功路上时用局部
  // 信息提前放弃。
  let startupFailure: CandidateStartupFailure | undefined;
  let pendingCandidateReports = 0;

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
    if (result.kind === "election_deadline_elapsed") {
      if (result.endpointConnected) sawUnresponsiveEndpoint = true;
      break;
    }
    if (result.kind === "connected") return { kind: "connected", connection: result.connection };
    if (result.kind === "unavailable" && result.reason === "handshake_failed") {
      sawUnresponsiveEndpoint = true;
    }
    if (isBlockingIncompatibility(result)) {
      return { kind: "incompatible", handshake: result.handshake };
    }
    if (isPermanentCandidateStartupFailure(startupFailure) && pendingCandidateReports === 0) {
      return { kind: "failed", reason: startupFailure.reason };
    }

    const now = performance.now();
    if (shouldLaunchCandidate(result) && now >= nextCandidateAt) {
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
          logDirectory: input.candidateLogDirectory ?? join(controlDirectory, "candidate-logs"),
        });
        const attempt = await settleBeforeDeadline(launch.spawned, deadline);
        if (attempt.startupFailure) {
          pendingCandidateReports += 1;
          void attempt.startupFailure
            .then(
              (failure) => {
                if (
                  failure &&
                  (!startupFailure ||
                    (!isPermanentCandidateStartupFailure(startupFailure) &&
                      isPermanentCandidateStartupFailure(failure)))
                ) {
                  startupFailure = failure;
                }
              },
              () => undefined,
            )
            .finally(() => {
              pendingCandidateReports -= 1;
            });
        }
      } catch {
        // A failed Candidate attempt is ordinary election evidence; discovery continues.
      }
      nextCandidateAt = now + MIN_CANDIDATE_INTERVAL_MS;
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    const random = dependencies.random();
    const jitter = 0.75 + Math.min(1, Math.max(0, Number.isFinite(random) ? random : 0.5)) * 0.5;
    await sleep(Math.min(remaining, Math.max(1, Math.round(backoffMs * jitter))));
    backoffMs = Math.min(DEFAULT_BACKOFF_MAX_MS, backoffMs * 2);
  }
  if (startupFailure) return { kind: "failed", reason: startupFailure.reason };
  return {
    kind: "failed",
    reason: sawUnresponsiveEndpoint ? "host_unresponsive" : "startup_timeout",
  };
}

function isBlockingIncompatibility(
  result: ConnectRuntimeHostResult,
): result is Extract<ConnectRuntimeHostResult, { kind: "incompatible" }> {
  return result.kind === "incompatible" && result.handshake.replacement === "blocked_by_residency";
}

function shouldLaunchCandidate(result: ConnectRuntimeHostResult): boolean {
  return result.kind === "unavailable" || result.kind === "draining";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settleBeforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.reject(new Error("Runtime Host election deadline elapsed"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Runtime Host election deadline elapsed")),
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
