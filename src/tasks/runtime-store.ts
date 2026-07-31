import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import { parseAnyCredentialRef, type CredentialRef } from "../provider/credential-vault.js";
import { parseBackgroundYoloPolicySnapshot } from "../safety/background-yolo-policy-schema.js";
import {
  assertPrivateDataFileSync,
  commitFileTransactionSync,
  readJsonFileSync,
  readJsonLinesSync,
  recoverFileTransactionSync,
  withFileLockSync,
} from "../storage/local-file-storage.js";
import {
  assertWorkspaceStorageRootIdentitySync,
  ensurePrivateWorkspaceStorageDirectorySync,
  prepareWorkspaceStorageLayoutSync,
  WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
  WORKSPACE_STORAGE_LOCK_DIRECTORY,
  type WorkspaceStorageRootIdentity,
} from "../storage/workspace-storage-layout.js";
import { LeaseConflictError } from "../storage/owner-lease.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import {
  DAEMON_RUN_STATUSES,
  CRON_RUN_STATUSES,
  JOB_COMMAND_KINDS,
  JOB_COMPLETION_POLICIES,
  JOB_EXECUTION_CLASSES,
  JOB_STATUSES,
  MERGE_REQUEST_STATUSES,
  PROVIDER_CALL_PURPOSES,
  PROVIDER_CALL_STATUSES,
  TERMINAL_JOB_STATUSES,
  type CompletionOutboxRecord,
  type CronJobRecord,
  type CronRunRecord,
  type CronRunStatus,
  type DaemonRunRecord,
  type JobAttemptRecord,
  type JobCommandKind,
  type JobCommandRecord,
  type JobCompletionPolicy,
  type JobExecutionClass,
  type JobListFilter,
  type JobRecord,
  type MergeRequestRecord,
  type MergeRequestStatus,
  type ProviderCallRecord,
  type RuntimeLeaseRecord,
  type RuntimeEventRecord,
  type TerminalJobStatus,
  type UsageBaselineRecord,
  type UsageLedgerFilter,
  type UsageLedgerSummary,
  type UsageLedgerTotals,
  type YoloPolicySnapshot,
  isTerminalJobStatus,
} from "./runtime-types.js";

const DEFAULT_LEASE_TTL_MS = 30_000;
const STATE_SCHEMA_VERSION = 1 as const;
const LEDGER_SCHEMA_VERSION = 1 as const;
const DAEMON_RUN_RECOVERY_EVENT_PREFIX = "daemon-run-recovery:";
const STATE_FILE = "control/state.json";
const DAEMON_EVENTS_FILE = "control/daemon-events.jsonl";
const USAGE_LEDGER_FILE = "control/usage-ledger.jsonl";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const lockSleepArray = new Int32Array(new SharedArrayBuffer(4));

export class RuntimeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConflictError";
  }
}

export interface RuntimeStoreOptions {
  workDir: string;
  /** Canonical Pico workspace state root containing sessions/, task-runs/, control/, and .storage/. */
  storageRoot?: string;
  picoHome?: string;
  now?: () => number;
}

export interface DaemonIdempotentCommandResult<Result extends Record<string, unknown>> {
  result: Result;
  replayed: boolean;
  resourceId?: string;
}

export interface CreateJobInput {
  jobId: string;
  type: string;
  executionClass: JobExecutionClass;
  completionPolicy: JobCompletionPolicy;
  description: string;
  ownerSessionId?: string;
  childSessionId?: string;
  toolUseId?: string;
  outputPath?: string;
  data?: Record<string, unknown>;
}

export interface StartJobInput {
  jobId: string;
  attemptId: string;
  ownerId: string;
  leaseEpoch: number;
  expectedVersion: number;
  outputPath?: string;
}

export interface StartRecoverableJobSuccessorInput {
  jobId: string;
  sourceAttemptId: string;
  successorAttemptId: string;
  ownerId: string;
  leaseEpoch: number;
  expectedJobVersion: number;
  expectedSourceAttemptVersion: number;
  outputPath?: string;
  reason?: string;
}

export interface StartRecoverableJobSuccessorResult {
  inserted: boolean;
  job: JobRecord;
  sourceAttempt: JobAttemptRecord;
  successorAttempt: JobAttemptRecord;
}

export type RecoverableJobTerminalStatus = Extract<
  TerminalJobStatus,
  "succeeded" | "failed" | "cancelled"
>;

export interface SettleRecoverableJobAfterTaskTerminalInput {
  jobId: string;
  attemptId: string;
  ownerId: string;
  leaseEpoch: number;
  completionId: string;
  status: RecoverableJobTerminalStatus;
  outputOffset?: number;
  error?: string;
  result?: Record<string, unknown>;
  completionPayload?: Record<string, unknown>;
  completionAlreadyDelivered?: boolean;
}

export interface SettleRecoverableJobAfterTaskTerminalResult extends FinishJobResult {
  inserted: boolean;
}

export interface FinishJobInput {
  jobId: string;
  attemptId: string;
  ownerId: string;
  status: TerminalJobStatus;
  expectedJobVersion: number;
  expectedAttemptVersion: number;
  leaseEpoch: number;
  completionId: string;
  outputOffset?: number;
  error?: string;
  result?: Record<string, unknown>;
  completionPayload?: Record<string, unknown>;
  completionAlreadyDelivered?: boolean;
}

export interface FinishJobResult {
  job: JobRecord;
  attempt: JobAttemptRecord;
  completion: CompletionOutboxRecord;
}

export interface CancelQueuedJobInput {
  jobId: string;
  expectedVersion: number;
  completionId: string;
  reason?: string;
}

export interface CreateCronJobInput {
  cronJobId: string;
  workspacePath: string;
  name?: string;
  schedule: string;
  timeZone: string;
  prompt: string;
  policySnapshot: YoloPolicySnapshot;
  credentialRef?: CredentialRef;
  modelRouteId?: string;
  enabled?: boolean;
}

export interface UpdateCronJobInput {
  cronJobId: string;
  expectedVersion: number;
  name?: string;
  schedule?: string;
  prompt?: string;
}

export interface CreateCronRunInput {
  cronRunId: string;
  cronJobId: string;
  scheduledFor: number;
  status: Extract<CronRunStatus, "queued" | "blocked" | "skipped">;
  reason?: string;
}

export interface ClaimCronRunInput {
  cronRunId: string;
  ownerId: string;
  leaseEpoch: number;
}

export interface FinishCronRunInput {
  cronRunId: string;
  ownerId: string;
  leaseEpoch: number;
  expectedVersion: number;
  status: Extract<CronRunStatus, "succeeded" | "failed" | "cancelled" | "blocked">;
  reason?: string;
  result?: Record<string, unknown>;
}

export interface DaemonCommandState {
  commandType: string;
  idempotencyKey: string;
  requestHash: string;
  requestJson: string;
  status: "pending" | "completed";
  result?: Record<string, unknown>;
  resourceId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeControlState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  revision: number;
  lastTransactionId?: string;
  nextRuntimeEventSequence: number;
  jobs: Record<string, JobRecord>;
  attempts: Record<string, JobAttemptRecord>;
  leases: Record<string, RuntimeLeaseRecord>;
  cronJobs: Record<string, CronJobRecord>;
  cronRuns: Record<string, CronRunRecord>;
  daemonCommands: Record<string, DaemonCommandState>;
  daemonRuns: Record<string, DaemonRunRecord>;
  jobCommands: Record<string, JobCommandRecord>;
  completions: Record<string, CompletionOutboxRecord>;
  mergeRequests: Record<string, MergeRequestRecord>;
}

export interface RuntimeEventEnvelope {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  type: "runtime-event";
  txId: string;
  sequence: number;
  event: RuntimeEventRecord;
}

export type UsageLedgerEnvelope =
  | {
      schemaVersion: typeof LEDGER_SCHEMA_VERSION;
      type: "provider-call";
      txId: string;
      record: ProviderCallRecord;
    }
  | {
      schemaVersion: typeof LEDGER_SCHEMA_VERSION;
      type: "usage-baseline";
      txId: string;
      record: UsageBaselineRecord;
    };

interface RuntimeTransaction {
  state: RuntimeControlState;
  baseRevision: number;
  baseTransactionId?: string;
  baseNextRuntimeEventSequence: number;
  events: Array<Omit<RuntimeEventEnvelope, "txId">>;
  usage: BufferedUsageLedgerEnvelope[];
}

type BufferedUsageLedgerEnvelope =
  | Omit<Extract<UsageLedgerEnvelope, { type: "provider-call" }>, "txId">
  | Omit<Extract<UsageLedgerEnvelope, { type: "usage-baseline" }>, "txId">;

const activeTransactions = new Map<string, RuntimeTransaction>();

interface RuntimeStoreIndex {
  stateRevision: number;
  stateTransactionId?: string;
  daemonFileSize: number;
  usageFileSize: number;
  events: Array<Omit<RuntimeEventEnvelope, "txId">>;
  eventIds: Set<string>;
  providerCalls: Map<string, ProviderCallRecord>;
  baselines: Map<string, UsageBaselineRecord>;
  fullRebuildCount: number;
  incrementalRefreshCount: number;
}

const runtimeStoreIndexes = new Map<string, RuntimeStoreIndex>();

export interface RuntimeStoreIndexDiagnostics {
  stateRevision: number;
  daemonFileSize: number;
  usageFileSize: number;
  eventCount: number;
  providerCallCount: number;
  baselineCount: number;
  fullRebuildCount: number;
  incrementalRefreshCount: number;
}

/** Test-only visibility into the disposable process-local index. */
export function inspectRuntimeStoreIndexForTesting(
  storageRoot: string,
): RuntimeStoreIndexDiagnostics | undefined {
  const resolvedRoot = resolve(storageRoot);
  const index = runtimeStoreIndexes.get(
    existsSync(resolvedRoot) ? realpathSync.native(resolvedRoot) : resolvedRoot,
  );
  if (!index) return undefined;
  return {
    stateRevision: index.stateRevision,
    daemonFileSize: index.daemonFileSize,
    usageFileSize: index.usageFileSize,
    eventCount: index.events.length,
    providerCallCount: index.providerCalls.size,
    baselineCount: index.baselines.size,
    fullRebuildCount: index.fullRebuildCount,
    incrementalRefreshCount: index.incrementalRefreshCount,
  };
}

/** Local JSON/JSONL control plane for recoverable tasks and daemon replay. */
export class RuntimeStore {
  readonly storageRoot: string;
  private readonly now: () => number;
  private readonly rootIdentity: WorkspaceStorageRootIdentity;

  constructor(options: RuntimeStoreOptions) {
    if (options.storageRoot !== undefined && !options.storageRoot.trim()) {
      throw new Error("RuntimeStore storageRoot must not be empty");
    }
    const requestedStorageRoot = resolve(
      options.storageRoot ??
        resolvePicoPaths(options.workDir, { picoHome: options.picoHome }).workspace.root,
    );
    this.now = options.now ?? Date.now;
    this.rootIdentity = prepareWorkspaceStorageLayoutSync(requestedStorageRoot).rootIdentity;
    this.storageRoot = realpathSync.native(requestedStorageRoot);
    ensurePrivateWorkspaceStorageDirectorySync(join(this.storageRoot, "control"));
    this.write(() => undefined);
  }

  close(): void {}

  acquireLease(
    resourceKey: string,
    ownerId: string,
    ttlMs = DEFAULT_LEASE_TTL_MS,
  ): RuntimeLeaseRecord {
    if (ttlMs <= 0 || !Number.isFinite(ttlMs)) throw new Error("lease ttlMs 必须为正数");
    return this.write((tx) => {
      const now = this.now();
      const current = tx.state.leases[resourceKey];
      if (current && current.expiresAt > now && current.ownerId !== ownerId) {
        throw new RuntimeConflictError(
          `资源 ${resourceKey} 已由 ${current.ownerId} 持有至 ${current.expiresAt}`,
        );
      }
      const next: RuntimeLeaseRecord = current
        ? {
            ...current,
            ownerId,
            leaseEpoch:
              current.expiresAt > now && current.ownerId === ownerId
                ? current.leaseEpoch
                : current.leaseEpoch + 1,
            heartbeatAt: now,
            expiresAt: now + ttlMs,
            version: current.version + 1,
          }
        : {
            resourceKey,
            ownerId,
            leaseEpoch: 1,
            heartbeatAt: now,
            expiresAt: now + ttlMs,
            version: 1,
          };
      tx.state.leases[resourceKey] = next;
      return clone(next);
    });
  }

  heartbeatLease(
    resourceKey: string,
    ownerId: string,
    leaseEpoch: number,
    ttlMs = DEFAULT_LEASE_TTL_MS,
  ): RuntimeLeaseRecord {
    return this.write((tx) => {
      const current = tx.state.leases[resourceKey];
      const now = this.now();
      if (
        !current ||
        current.ownerId !== ownerId ||
        current.leaseEpoch !== leaseEpoch ||
        current.expiresAt <= now
      ) {
        throw new RuntimeConflictError(`资源 ${resourceKey} 的 lease 已失效`);
      }
      const next = {
        ...current,
        heartbeatAt: now,
        expiresAt: now + ttlMs,
        version: current.version + 1,
      };
      tx.state.leases[resourceKey] = next;
      return clone(next);
    });
  }

  releaseLease(resourceKey: string, ownerId: string, leaseEpoch: number): void {
    this.write((tx) => {
      const current = tx.state.leases[resourceKey];
      if (!current || current.ownerId !== ownerId || current.leaseEpoch !== leaseEpoch) {
        throw new RuntimeConflictError(`资源 ${resourceKey} 的 lease 所有权已变化`);
      }
      tx.state.leases[resourceKey] = {
        ...current,
        expiresAt: this.now(),
        version: current.version + 1,
      };
    });
  }

  createJob(input: CreateJobInput): JobRecord {
    return this.write((tx) => {
      if (tx.state.jobs[input.jobId]) throw new RuntimeConflictError(`任务 ${input.jobId} 已存在`);
      const now = this.now();
      const job: JobRecord = compact({
        ...input,
        status: "queued" as const,
        version: 1,
        leaseEpoch: 0,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      tx.state.jobs[input.jobId] = job;
      return clone(job);
    });
  }

  startJob(input: StartJobInput): { job: JobRecord; attempt: JobAttemptRecord } {
    return this.write((tx) => {
      const current = this.requireJob(input.jobId, tx);
      if (current.status !== "queued") {
        throw new RuntimeConflictError(`任务 ${input.jobId} 当前为 ${current.status}，不能启动`);
      }
      if (current.version !== input.expectedVersion) {
        throw new RuntimeConflictError(
          `任务 ${input.jobId} 版本已从 ${input.expectedVersion} 变化`,
        );
      }
      if (tx.state.attempts[input.attemptId]) {
        throw new RuntimeConflictError(`attempt ${input.attemptId} 已存在`);
      }
      this.assertLease(tx, `job:${input.jobId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const attemptNumber = current.attemptCount + 1;
      const attempt: JobAttemptRecord = compact({
        attemptId: input.attemptId,
        jobId: input.jobId,
        attemptNumber,
        status: "running" as const,
        ownerId: input.ownerId,
        leaseEpoch: input.leaseEpoch,
        outputPath: input.outputPath ?? current.outputPath,
        outputOffset: 0,
        startedAt: now,
        updatedAt: now,
        version: 1,
      });
      const job: JobRecord = compact({
        ...current,
        status: "running" as const,
        outputPath: input.outputPath ?? current.outputPath,
        leaseEpoch: input.leaseEpoch,
        attemptCount: attemptNumber,
        updatedAt: now,
        version: current.version + 1,
      });
      tx.state.attempts[input.attemptId] = attempt;
      tx.state.jobs[input.jobId] = job;
      return clone({ job, attempt });
    });
  }

  /**
   * Atomically replaces an expired recoverable Attempt without publishing a terminal outbox.
   *
   * The caller must first acquire the expired Job lease. Only the eventual TaskRun terminal fact
   * is allowed to settle the Job and create its completion record.
   */
  startRecoverableJobSuccessor(
    input: StartRecoverableJobSuccessorInput,
  ): StartRecoverableJobSuccessorResult {
    return this.write((tx) => {
      const currentJob = this.requireJob(input.jobId, tx);
      const source = this.requireAttempt(input.sourceAttemptId, tx);
      const existing = tx.state.attempts[input.successorAttemptId];
      const reason = input.reason ?? "owner_lost_recovering";
      if (existing) {
        if (
          currentJob.executionClass !== "recoverable" ||
          currentJob.status !== "running" ||
          currentJob.leaseEpoch !== input.leaseEpoch ||
          source.jobId !== input.jobId ||
          source.status !== "interrupted" ||
          source.error !== reason ||
          existing.jobId !== input.jobId ||
          existing.status !== "running" ||
          existing.attemptNumber !== source.attemptNumber + 1 ||
          existing.ownerId !== input.ownerId ||
          existing.leaseEpoch !== input.leaseEpoch ||
          existing.outputPath !== (input.outputPath ?? currentJob.outputPath)
        ) {
          throw new RuntimeConflictError(
            `recoverable successor ${input.successorAttemptId} 已绑定到其他执行`,
          );
        }
        this.assertLease(tx, `job:${input.jobId}`, input.ownerId, input.leaseEpoch);
        return clone({
          inserted: false,
          job: currentJob,
          sourceAttempt: source,
          successorAttempt: existing,
        });
      }
      if (
        currentJob.executionClass !== "recoverable" ||
        currentJob.status !== "running" ||
        currentJob.version !== input.expectedJobVersion ||
        currentJob.attemptCount !== source.attemptNumber ||
        currentJob.leaseEpoch !== source.leaseEpoch ||
        source.jobId !== input.jobId ||
        source.status !== "running" ||
        source.version !== input.expectedSourceAttemptVersion ||
        input.leaseEpoch <= source.leaseEpoch
      ) {
        throw new RuntimeConflictError(
          `recoverable Job ${input.jobId} 的 source/version/lease 已变化`,
        );
      }
      this.assertLease(tx, `job:${input.jobId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const sourceAttempt: JobAttemptRecord = {
        ...source,
        status: "interrupted",
        error: reason,
        finishedAt: now,
        updatedAt: now,
        version: source.version + 1,
      };
      const successorAttempt: JobAttemptRecord = compact({
        attemptId: input.successorAttemptId,
        jobId: input.jobId,
        attemptNumber: source.attemptNumber + 1,
        status: "running" as const,
        ownerId: input.ownerId,
        leaseEpoch: input.leaseEpoch,
        outputPath: input.outputPath ?? currentJob.outputPath,
        outputOffset: 0,
        startedAt: now,
        updatedAt: now,
        version: 1,
      });
      const job: JobRecord = compact({
        ...currentJob,
        status: "running" as const,
        leaseEpoch: input.leaseEpoch,
        attemptCount: successorAttempt.attemptNumber,
        outputPath: input.outputPath ?? currentJob.outputPath,
        updatedAt: now,
        version: currentJob.version + 1,
      });
      tx.state.attempts[input.sourceAttemptId] = sourceAttempt;
      tx.state.attempts[input.successorAttemptId] = successorAttempt;
      tx.state.jobs[input.jobId] = job;
      return clone({
        inserted: true,
        job,
        sourceAttempt,
        successorAttempt,
      });
    });
  }

  /**
   * Converges a recoverable Job/outbox from an already-durable TaskRun terminal fact.
   *
   * A running Job requires the current live lease. The lease may be the Attempt's existing lease
   * or a higher epoch acquired after expiry. Exact terminal replays are read-only apart from an
   * optional deliveredAt acknowledgement.
   */
  settleRecoverableJobAfterTaskTerminal(
    input: SettleRecoverableJobAfterTaskTerminalInput,
  ): SettleRecoverableJobAfterTaskTerminalResult {
    return this.write((tx) => {
      const currentJob = this.requireJob(input.jobId, tx);
      const currentAttempt = this.requireAttempt(input.attemptId, tx);
      const existingCompletion = tx.state.completions[input.completionId];
      if (currentJob.executionClass !== "recoverable" || currentAttempt.jobId !== input.jobId) {
        throw new RuntimeConflictError(
          `TaskRun terminal cannot settle non-recoverable Job ${input.jobId}`,
        );
      }
      if (isTerminalJobStatus(currentJob.status)) {
        if (
          currentJob.status !== input.status ||
          currentJob.error !== input.error ||
          currentAttempt.status !== input.status ||
          currentAttempt.error !== input.error ||
          currentAttempt.outputOffset !== (input.outputOffset ?? currentAttempt.outputOffset) ||
          !sameJson(currentAttempt.result, input.result) ||
          existingCompletion?.jobId !== input.jobId ||
          existingCompletion.attemptId !== input.attemptId ||
          existingCompletion.status !== input.status ||
          !sameJson(existingCompletion.payload, input.completionPayload)
        ) {
          throw new RuntimeConflictError(
            `TaskRun completion ${input.completionId} conflicts with Job ${input.jobId} terminal`,
          );
        }
        if (input.completionAlreadyDelivered && existingCompletion.deliveredAt === undefined) {
          existingCompletion.deliveredAt = this.now();
        }
        return clone({
          inserted: false,
          job: currentJob,
          attempt: currentAttempt,
          completion: existingCompletion,
        });
      }
      const sameFence =
        currentAttempt.ownerId === input.ownerId && currentAttempt.leaseEpoch === input.leaseEpoch;
      const takeoverFence = input.leaseEpoch > currentAttempt.leaseEpoch;
      if (
        currentJob.status !== "running" ||
        currentAttempt.status !== "running" ||
        currentJob.attemptCount !== currentAttempt.attemptNumber ||
        currentJob.leaseEpoch !== currentAttempt.leaseEpoch ||
        (!sameFence && !takeoverFence)
      ) {
        throw new RuntimeConflictError(
          `recoverable Job ${input.jobId} has no matching running Attempt ${input.attemptId}`,
        );
      }
      this.assertLease(tx, `job:${input.jobId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const attempt = compact<JobAttemptRecord>({
        ...currentAttempt,
        status: input.status,
        ownerId: input.ownerId,
        leaseEpoch: input.leaseEpoch,
        outputOffset: input.outputOffset ?? currentAttempt.outputOffset,
        error: input.error,
        result: input.result,
        finishedAt: now,
        updatedAt: now,
        version: currentAttempt.version + 1,
      });
      const job = compact<JobRecord>({
        ...currentJob,
        status: input.status,
        leaseEpoch: input.leaseEpoch,
        terminalAt: now,
        updatedAt: now,
        error: input.error,
        version: currentJob.version + 1,
      });
      tx.state.attempts[input.attemptId] = attempt;
      tx.state.jobs[input.jobId] = job;
      this.insertCompletion(tx, {
        completionId: input.completionId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        policy: currentJob.completionPolicy,
        status: input.status,
        payload: input.completionPayload,
        createdAt: now,
      });
      const completion = this.requireCompletion(input.completionId, tx);
      if (input.completionAlreadyDelivered) completion.deliveredAt = now;
      return clone({
        inserted: true,
        job,
        attempt,
        completion,
      });
    });
  }

  finishJob(input: FinishJobInput): FinishJobResult {
    return this.write((tx) => {
      const currentJob = this.requireJob(input.jobId, tx);
      const currentAttempt = this.requireAttempt(input.attemptId, tx);
      const existingCompletion = tx.state.completions[input.completionId];
      if (
        currentAttempt.jobId !== input.jobId ||
        currentAttempt.ownerId !== input.ownerId ||
        currentJob.leaseEpoch !== input.leaseEpoch ||
        currentAttempt.leaseEpoch !== input.leaseEpoch
      ) {
        throw new RuntimeConflictError(`任务 ${input.jobId} 的 ownerId/leaseEpoch 与调用者不一致`);
      }
      if (
        isTerminalJobStatus(currentJob.status) &&
        currentJob.status === input.status &&
        currentAttempt.status === input.status &&
        existingCompletion?.jobId === input.jobId &&
        existingCompletion.attemptId === input.attemptId
      ) {
        if (input.completionAlreadyDelivered && existingCompletion.deliveredAt === undefined) {
          existingCompletion.deliveredAt = this.now();
        }
        return clone({
          job: currentJob,
          attempt: currentAttempt,
          completion: this.requireCompletion(input.completionId, tx),
        });
      }
      if (currentJob.status !== "running" || currentAttempt.status !== "running") {
        throw new RuntimeConflictError(
          `任务 ${input.jobId} 或 attempt ${input.attemptId} 已非运行态`,
        );
      }
      if (
        currentJob.version !== input.expectedJobVersion ||
        currentAttempt.version !== input.expectedAttemptVersion
      ) {
        throw new RuntimeConflictError(`任务 ${input.jobId} 的 version/leaseEpoch CAS 失败`);
      }
      this.assertLease(tx, `job:${input.jobId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const attempt = compact<JobAttemptRecord>({
        ...currentAttempt,
        status: input.status,
        outputOffset: input.outputOffset ?? currentAttempt.outputOffset,
        error: input.error,
        result: input.result,
        finishedAt: now,
        updatedAt: now,
        version: currentAttempt.version + 1,
      });
      const job = compact<JobRecord>({
        ...currentJob,
        status: input.status,
        terminalAt: now,
        updatedAt: now,
        error: input.error,
        version: currentJob.version + 1,
      });
      tx.state.attempts[input.attemptId] = attempt;
      tx.state.jobs[input.jobId] = job;
      this.insertCompletion(tx, {
        completionId: input.completionId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        policy: currentJob.completionPolicy,
        status: input.status,
        payload: input.completionPayload,
        createdAt: now,
      });
      if (input.completionAlreadyDelivered) {
        tx.state.completions[input.completionId]!.deliveredAt = now;
      }
      return clone({
        job,
        attempt,
        completion: this.requireCompletion(input.completionId, tx),
      });
    });
  }

  cancelQueuedJob(input: CancelQueuedJobInput): {
    job: JobRecord;
    completion: CompletionOutboxRecord;
  } {
    return this.write((tx) => {
      const current = this.requireJob(input.jobId, tx);
      const existing = tx.state.completions[input.completionId];
      if (current.status === "cancelled" && existing?.jobId === input.jobId) {
        return clone({ job: current, completion: existing });
      }
      if (current.status !== "queued" || current.version !== input.expectedVersion) {
        throw new RuntimeConflictError(`任务 ${input.jobId} 已非可取消的 queued 版本`);
      }
      const now = this.now();
      const job: JobRecord = {
        ...current,
        status: "cancelled",
        error: input.reason ?? "cancelled",
        terminalAt: now,
        updatedAt: now,
        version: current.version + 1,
      };
      tx.state.jobs[input.jobId] = job;
      this.insertCompletion(
        tx,
        compact<CompletionOutboxRecord>({
          completionId: input.completionId,
          jobId: input.jobId,
          policy: current.completionPolicy,
          status: "cancelled" as const,
          payload: input.reason ? { reason: input.reason } : undefined,
          createdAt: now,
        }),
      );
      return clone({ job, completion: tx.state.completions[input.completionId]! });
    });
  }

  retryJob(jobId: string, expectedVersion: number): JobRecord {
    return this.write((tx) => {
      const current = this.requireJob(jobId, tx);
      if (!isTerminalJobStatus(current.status) || current.version !== expectedVersion) {
        throw new RuntimeConflictError(`任务 ${jobId} 已非可重试的终态版本`);
      }
      const job = withoutKeys(
        {
          ...current,
          status: "queued" as const,
          updatedAt: this.now(),
          version: current.version + 1,
        },
        "terminalAt",
        "error",
      );
      tx.state.jobs[jobId] = job;
      return clone(job);
    });
  }

  interruptExpiredJobs(reason = "owner_lost"): JobRecord[] {
    return this.write((tx) => {
      const now = this.now();
      const interrupted: JobRecord[] = [];
      for (const current of Object.values(tx.state.jobs)) {
        const lease = tx.state.leases[`job:${current.jobId}`];
        if (
          current.status !== "running" ||
          current.executionClass === "recoverable" ||
          (lease && lease.expiresAt > now)
        ) {
          continue;
        }
        const attempt = Object.values(tx.state.attempts)
          .filter((value) => value.jobId === current.jobId && value.status === "running")
          .sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
        if (!attempt) continue;
        const nextAttempt: JobAttemptRecord = {
          ...attempt,
          status: "interrupted",
          error: reason,
          finishedAt: now,
          updatedAt: now,
          version: attempt.version + 1,
        };
        const job: JobRecord = {
          ...current,
          status: "interrupted",
          error: reason,
          terminalAt: now,
          updatedAt: now,
          version: current.version + 1,
        };
        tx.state.attempts[attempt.attemptId] = nextAttempt;
        tx.state.jobs[current.jobId] = job;
        const completionId = `completion:${attempt.attemptId}`;
        this.insertCompletion(tx, {
          completionId,
          jobId: current.jobId,
          attemptId: attempt.attemptId,
          policy: job.completionPolicy,
          status: "interrupted",
          payload: interruptedCompletionPayload(job, completionId, reason, now),
          createdAt: now,
        });
        interrupted.push(clone(job));
      }
      return interrupted;
    });
  }

  getJob(jobId: string): JobRecord | undefined {
    return this.read((tx) => optionalClone(tx.state.jobs[jobId]));
  }

  getAttempt(attemptId: string): JobAttemptRecord | undefined {
    return this.read((tx) => optionalClone(tx.state.attempts[attemptId]));
  }

  listAttempts(jobId: string): JobAttemptRecord[] {
    return this.read((tx) =>
      clone(
        Object.values(tx.state.attempts)
          .filter((attempt) => attempt.jobId === jobId)
          .sort((left, right) => left.attemptNumber - right.attemptNumber),
      ),
    );
  }

  listJobs(filter: JobListFilter = {}): JobRecord[] {
    return this.read((tx) => {
      const limit = Math.max(1, Math.min(filter.limit ?? 1_000, 10_000));
      return clone(
        Object.values(tx.state.jobs)
          .filter(
            (job) =>
              (!filter.statuses?.length || filter.statuses.includes(job.status)) &&
              (filter.ownerSessionId === undefined ||
                job.ownerSessionId === filter.ownerSessionId) &&
              (filter.completionPolicy === undefined ||
                job.completionPolicy === filter.completionPolicy),
          )
          .sort(compareCreatedAndId("jobId"))
          .slice(0, limit),
      );
    });
  }

  createCronJob(input: CreateCronJobInput): CronJobRecord {
    return this.write((tx) => {
      if (tx.state.cronJobs[input.cronJobId]) {
        throw new RuntimeConflictError(`Cron Job ${input.cronJobId} 已存在`);
      }
      const policySnapshot = parseBackgroundYoloPolicySnapshot(input.policySnapshot);
      const parsedCredential =
        input.credentialRef === undefined ? undefined : parseAnyCredentialRef(input.credentialRef);
      const modelRouteId = normalizeOptionalModelRouteId(input.modelRouteId);
      validateCredentialRoute(parsedCredential, modelRouteId);
      const now = this.now();
      const job: CronJobRecord = compact({
        cronJobId: input.cronJobId,
        workspacePath: input.workspacePath,
        name: normalizeCronJobName(input.name, input.prompt),
        schedule: input.schedule,
        timeZone: input.timeZone,
        prompt: input.prompt,
        enabled: input.enabled !== false,
        policySnapshot,
        credentialRef: parsedCredential?.ref,
        modelRouteId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      tx.state.cronJobs[input.cronJobId] = job;
      this.insertRuntimeEvent(tx, {
        topic: "cron.job.created",
        workspacePath: input.workspacePath,
        cronJobId: input.cronJobId,
        payload: { enabled: job.enabled, schedule: input.schedule, timeZone: input.timeZone },
      });
      return clone(job);
    });
  }

  updateCronJob(input: UpdateCronJobInput): CronJobRecord {
    return this.write((tx) => {
      const current = this.requireCronJob(input.cronJobId, tx);
      if (current.version !== input.expectedVersion) {
        throw new RuntimeConflictError(`Cron Job ${input.cronJobId} 的版本已变化`);
      }
      const name = input.name === undefined ? current.name : normalizeCronJobName(input.name);
      const schedule = input.schedule ?? current.schedule;
      const prompt =
        input.prompt === undefined ? current.prompt : normalizeCronPrompt(input.prompt);
      const job = {
        ...current,
        name,
        schedule,
        prompt,
        updatedAt: this.now(),
        version: current.version + 1,
      };
      tx.state.cronJobs[input.cronJobId] = job;
      this.insertRuntimeEvent(tx, {
        topic: "cron.job.updated",
        workspacePath: current.workspacePath,
        cronJobId: input.cronJobId,
        payload: { name, schedule },
      });
      return clone(job);
    });
  }

  getCronJob(cronJobId: string): CronJobRecord | undefined {
    return this.read((tx) => optionalClone(tx.state.cronJobs[cronJobId]));
  }

  listCronJobs(input: { workspacePath?: string; enabled?: boolean } = {}): CronJobRecord[] {
    return this.read((tx) =>
      clone(
        Object.values(tx.state.cronJobs)
          .filter(
            (job) =>
              (input.workspacePath === undefined || job.workspacePath === input.workspacePath) &&
              (input.enabled === undefined || job.enabled === input.enabled),
          )
          .sort(compareCreatedAndId("cronJobId")),
      ),
    );
  }

  setCronJobEnabled(cronJobId: string, expectedVersion: number, enabled: boolean): CronJobRecord {
    return this.write((tx) => {
      const current = this.requireCronJob(cronJobId, tx);
      if (current.version !== expectedVersion) {
        throw new RuntimeConflictError(`Cron Job ${cronJobId} 的版本已变化`);
      }
      const job = { ...current, enabled, updatedAt: this.now(), version: current.version + 1 };
      tx.state.cronJobs[cronJobId] = job;
      this.insertRuntimeEvent(tx, {
        topic: enabled ? "cron.job.enabled" : "cron.job.disabled",
        workspacePath: current.workspacePath,
        cronJobId,
      });
      return clone(job);
    });
  }

  deleteCronJob(cronJobId: string, expectedVersion: number): CronJobRecord {
    return this.write((tx) => {
      const current = this.requireCronJob(cronJobId, tx);
      if (current.enabled)
        throw new RuntimeConflictError(`Cron Job ${cronJobId} 必须先禁用才能删除`);
      if (current.version !== expectedVersion) {
        throw new RuntimeConflictError(`Cron Job ${cronJobId} 的版本已变化`);
      }
      const running = Object.values(tx.state.cronRuns).find(
        (run) => run.cronJobId === cronJobId && run.status === "running",
      );
      if (running) {
        throw new RuntimeConflictError(
          `Cron Job ${cronJobId} 仍有运行中的 Run ${running.cronRunId}`,
        );
      }
      delete tx.state.cronJobs[cronJobId];
      for (const [id, run] of Object.entries(tx.state.cronRuns)) {
        if (run.cronJobId === cronJobId) delete tx.state.cronRuns[id];
      }
      this.insertRuntimeEvent(tx, {
        topic: "cron.job.deleted",
        workspacePath: current.workspacePath,
        payload: { cronJobId },
      });
      return clone(current);
    });
  }

  createCronRun(input: CreateCronRunInput): CronRunRecord {
    return this.write((tx) => {
      const job = this.requireCronJob(input.cronJobId, tx);
      const existing = Object.values(tx.state.cronRuns).find(
        (run) => run.cronJobId === input.cronJobId && run.scheduledFor === input.scheduledFor,
      );
      if (existing) return clone(existing);
      if (tx.state.cronRuns[input.cronRunId]) {
        throw new RuntimeConflictError(`Cron Run ${input.cronRunId} 已存在`);
      }
      let status = input.status;
      let reason = input.reason;
      if (
        status === "queued" &&
        Object.values(tx.state.cronRuns).some(
          (run) =>
            run.workspacePath === job.workspacePath &&
            (run.status === "queued" || run.status === "running"),
        )
      ) {
        status = "skipped";
        reason = "workspace_busy";
      }
      const now = this.now();
      const run: CronRunRecord = compact({
        cronRunId: input.cronRunId,
        cronJobId: input.cronJobId,
        workspacePath: job.workspacePath,
        scheduledFor: input.scheduledFor,
        status,
        leaseEpoch: 0,
        createdAt: now,
        finishedAt: status === "queued" ? undefined : now,
        reason,
        version: 1,
      });
      tx.state.cronRuns[input.cronRunId] = run;
      this.insertRuntimeEvent(tx, {
        topic: `cron.run.${status}`,
        workspacePath: job.workspacePath,
        cronJobId: job.cronJobId,
        cronRunId: input.cronRunId,
        payload: { scheduledFor: input.scheduledFor, ...(reason ? { reason } : {}) },
      });
      return clone(run);
    });
  }

  getCronRun(cronRunId: string): CronRunRecord | undefined {
    return this.read((tx) => optionalClone(tx.state.cronRuns[cronRunId]));
  }

  listCronRuns(
    input: { cronJobId?: string; workspacePath?: string; limit?: number } = {},
  ): CronRunRecord[] {
    return this.read((tx) => {
      const limit = Math.max(1, Math.min(input.limit ?? 100, 10_000));
      return clone(
        Object.values(tx.state.cronRuns)
          .filter(
            (run) =>
              (input.cronJobId === undefined || run.cronJobId === input.cronJobId) &&
              (input.workspacePath === undefined || run.workspacePath === input.workspacePath),
          )
          .sort(
            (left, right) =>
              right.scheduledFor - left.scheduledFor ||
              right.cronRunId.localeCompare(left.cronRunId),
          )
          .slice(0, limit),
      );
    });
  }

  listActiveCronRuns(workspacePath: string): CronRunRecord[] {
    return this.read((tx) =>
      clone(
        Object.values(tx.state.cronRuns)
          .filter(
            (run) =>
              run.workspacePath === workspacePath &&
              (run.status === "queued" || run.status === "running"),
          )
          .sort(
            (left, right) =>
              right.scheduledFor - left.scheduledFor ||
              right.cronRunId.localeCompare(left.cronRunId),
          ),
      ),
    );
  }

  recoverInterruptedCronRuns(reason = "daemon_interrupted_after_lease_expiry"): CronRunRecord[] {
    return this.write((tx) => {
      const now = this.now();
      const recovered: CronRunRecord[] = [];
      for (const current of Object.values(tx.state.cronRuns)) {
        const lease = tx.state.leases[`cron-run:${current.cronRunId}`];
        if (current.status !== "running" || (lease && lease.expiresAt > now)) continue;
        const run: CronRunRecord = {
          ...current,
          status: "failed",
          finishedAt: now,
          reason,
          version: current.version + 1,
        };
        tx.state.cronRuns[current.cronRunId] = run;
        if (lease && lease.expiresAt <= now) {
          tx.state.leases[lease.resourceKey] = {
            ...lease,
            expiresAt: now,
            version: lease.version + 1,
          };
        }
        this.insertRuntimeEvent(tx, {
          topic: "cron.run.failed",
          workspacePath: current.workspacePath,
          cronJobId: current.cronJobId,
          cronRunId: current.cronRunId,
          payload: { reason, recovered: true },
        });
        recovered.push(clone(run));
      }
      return recovered;
    });
  }

  claimCronRun(input: ClaimCronRunInput): CronRunRecord {
    return this.write((tx) => {
      const current = this.requireCronRun(input.cronRunId, tx);
      if (current.status !== "queued") {
        throw new RuntimeConflictError(
          `Cron Run ${input.cronRunId} 当前为 ${current.status}，不能启动`,
        );
      }
      this.assertLease(tx, `cron-run:${input.cronRunId}`, input.ownerId, input.leaseEpoch);
      const run: CronRunRecord = {
        ...current,
        status: "running",
        ownerId: input.ownerId,
        leaseEpoch: input.leaseEpoch,
        startedAt: this.now(),
        version: current.version + 1,
      };
      tx.state.cronRuns[input.cronRunId] = run;
      this.insertRuntimeEvent(tx, {
        topic: "cron.run.running",
        workspacePath: current.workspacePath,
        cronJobId: current.cronJobId,
        cronRunId: current.cronRunId,
      });
      return clone(run);
    });
  }

  finishCronRun(input: FinishCronRunInput): CronRunRecord {
    return this.write((tx) => {
      const current = this.requireCronRun(input.cronRunId, tx);
      if (
        current.status !== "running" ||
        current.ownerId !== input.ownerId ||
        current.leaseEpoch !== input.leaseEpoch ||
        current.version !== input.expectedVersion
      ) {
        throw new RuntimeConflictError(`Cron Run ${input.cronRunId} 的 owner/version/lease 已变化`);
      }
      this.assertLease(tx, `cron-run:${input.cronRunId}`, input.ownerId, input.leaseEpoch);
      const run = compact<CronRunRecord>({
        ...current,
        status: input.status,
        finishedAt: this.now(),
        reason: input.reason,
        result: input.result,
        version: current.version + 1,
      });
      tx.state.cronRuns[input.cronRunId] = run;
      this.insertRuntimeEvent(tx, {
        topic: `cron.run.${input.status}`,
        workspacePath: current.workspacePath,
        cronJobId: current.cronJobId,
        cronRunId: current.cronRunId,
        payload: input.reason ? { reason: input.reason } : {},
      });
      return clone(run);
    });
  }

  blockQueuedCronRun(cronRunId: string, reason: string): CronRunRecord {
    return this.closeQueuedCronRun(cronRunId, "blocked", reason);
  }

  skipQueuedCronRun(cronRunId: string, reason = "workspace_busy"): CronRunRecord {
    return this.closeQueuedCronRun(cronRunId, "skipped", reason);
  }

  listRuntimeEvents(
    input: {
      afterEventId?: string;
      throughEventId?: string;
      workspacePath?: string;
      limit?: number;
    } = {},
  ): RuntimeEventRecord[] {
    return this.read((tx) => {
      const events = this.runtimeEvents(tx);
      let start = 0;
      if (input.afterEventId !== undefined) {
        const index = events.findIndex(
          ({ event }) =>
            event.eventId === input.afterEventId &&
            (input.workspacePath === undefined || event.workspacePath === input.workspacePath),
        );
        if (index < 0) return [];
        start = index + 1;
      }
      let end = events.length;
      if (input.throughEventId !== undefined) {
        const index = events.findIndex(
          ({ event }) =>
            event.eventId === input.throughEventId &&
            (input.workspacePath === undefined || event.workspacePath === input.workspacePath),
        );
        if (index < 0) return [];
        end = index + 1;
      }
      const limit = Math.max(1, Math.min(input.limit ?? 100, 10_000));
      return clone(
        events
          .slice(start, end)
          .filter(
            ({ event }) =>
              input.workspacePath === undefined || event.workspacePath === input.workspacePath,
          )
          .slice(0, limit)
          .map(({ event }) => event),
      );
    });
  }

  hasRuntimeEvent(eventId: string, workspacePath?: string): boolean {
    return this.read((tx) =>
      this.runtimeEvents(tx).some(
        ({ event }) =>
          event.eventId === eventId &&
          (workspacePath === undefined || event.workspacePath === workspacePath),
      ),
    );
  }

  getRuntimeEventHighWatermark(workspacePath?: string): RuntimeEventRecord | undefined {
    return this.read((tx) => {
      const found = this.runtimeEvents(tx)
        .filter(({ event }) => workspacePath === undefined || event.workspacePath === workspacePath)
        .at(-1)?.event;
      return optionalClone(found);
    });
  }

  listDaemonRunRecoveryEvents(workspacePath: string): RuntimeEventRecord[] {
    return this.read((tx) =>
      clone(
        this.runtimeEvents(tx)
          .map(({ event }) => event)
          .filter(
            (event) =>
              event.workspacePath === workspacePath &&
              event.eventId.startsWith(DAEMON_RUN_RECOVERY_EVENT_PREFIX),
          ),
      ),
    );
  }

  appendRuntimeEvent(
    input: Omit<RuntimeEventRecord, "eventId" | "createdAt"> & {
      eventId?: string;
      createdAt?: number;
    },
    projection?: { daemonRun: DaemonRunRecord },
  ): RuntimeEventRecord {
    if (projection && projection.daemonRun.workspacePath !== input.workspacePath) {
      throw new RuntimeConflictError(
        `Run ${projection.daemonRun.runId} 的工作区与事件工作区不一致`,
      );
    }
    return this.write((tx) => {
      if (projection) this.persistDaemonRun(tx, projection.daemonRun);
      return clone(this.insertRuntimeEvent(tx, input));
    });
  }

  executeIdempotentDaemonCommand<Result extends Record<string, unknown>>(
    input: {
      commandType: string;
      idempotencyKey: string;
      request: Record<string, unknown>;
    },
    execute: () => { result: Result; resourceId?: string },
  ): DaemonIdempotentCommandResult<Result> {
    const commandType = input.commandType.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!commandType) throw new Error("daemon commandType 必须是非空字符串");
    if (!idempotencyKey) throw new Error("daemon idempotencyKey 必须是非空字符串");
    const requestJson = canonicalJson(input.request);
    const requestHash = createHash("sha256").update(requestJson).digest("hex");
    return this.write((tx) => {
      const key = daemonCommandKey(commandType, idempotencyKey);
      const existing = tx.state.daemonCommands[key];
      if (existing) {
        if (existing.requestHash !== requestHash || existing.requestJson !== requestJson) {
          throw new RuntimeConflictError(
            `${commandType} 的幂等键 ${idempotencyKey} 已用于其他参数`,
          );
        }
        if (existing.status !== "completed" || !existing.result) {
          throw new RuntimeConflictError(
            `${commandType} 的幂等键 ${idempotencyKey} 尚未完成持久化`,
          );
        }
        return compact({
          result: clone(existing.result) as Result,
          replayed: true,
          resourceId: existing.resourceId,
        });
      }
      const now = this.now();
      tx.state.daemonCommands[key] = {
        commandType,
        idempotencyKey,
        requestHash,
        requestJson,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      const executed = execute();
      tx.state.daemonCommands[key] = compact({
        ...tx.state.daemonCommands[key]!,
        status: "completed" as const,
        result: clone(executed.result),
        resourceId: executed.resourceId,
        updatedAt: this.now(),
      });
      return compact({ result: executed.result, replayed: false, resourceId: executed.resourceId });
    });
  }

  upsertDaemonRun(input: DaemonRunRecord): DaemonRunRecord {
    return this.write((tx) => clone(this.persistDaemonRun(tx, input)));
  }

  getDaemonRun(workspacePath: string, runId: string): DaemonRunRecord | undefined {
    return this.read((tx) => {
      const run = tx.state.daemonRuns[runId];
      return run?.workspacePath === workspacePath ? clone(run) : undefined;
    });
  }

  listDaemonRuns(input: { workspacePath: string; sessionId?: string }): DaemonRunRecord[] {
    return this.read((tx) =>
      clone(
        Object.values(tx.state.daemonRuns)
          .filter(
            (run) =>
              run.workspacePath === input.workspacePath &&
              (input.sessionId === undefined || run.sessionId === input.sessionId),
          )
          .sort(
            (left, right) =>
              left.startedAt - right.startedAt || left.runId.localeCompare(right.runId),
          ),
      ),
    );
  }

  recoverInterruptedDaemonRuns(
    workspacePath: string,
    reason = "daemon restarted before the Run reached a terminal state",
  ): DaemonRunRecord[] {
    return this.write((tx) => {
      const active = new Set(DAEMON_RUN_STATUSES.slice(0, 4));
      const now = this.now();
      const recovered: DaemonRunRecord[] = [];
      for (const current of Object.values(tx.state.daemonRuns)) {
        if (current.workspacePath !== workspacePath || !active.has(current.status)) continue;
        const run: DaemonRunRecord = {
          ...current,
          status: "failed",
          error: reason,
          updatedAt: now,
          finishedAt: now,
          version: current.version + 1,
        };
        tx.state.daemonRuns[run.runId] = run;
        recovered.push(clone(run));
        this.insertRuntimeEvent(tx, daemonRunRecoveryEvent(run));
      }
      return recovered;
    });
  }

  insertCommand(input: {
    commandId: string;
    jobId: string;
    kind: JobCommandKind;
    payload?: Record<string, unknown>;
  }): { record: JobCommandRecord; inserted: boolean } {
    return this.write((tx) => {
      this.requireJob(input.jobId, tx);
      const existing = tx.state.jobCommands[input.commandId];
      if (existing) {
        if (
          existing.jobId !== input.jobId ||
          existing.kind !== input.kind ||
          !sameJson(existing.payload, input.payload)
        ) {
          throw new RuntimeConflictError(`命令 ID ${input.commandId} 已被其他命令使用`);
        }
        return { record: clone(existing), inserted: false };
      }
      const record: JobCommandRecord = compact({ ...input, createdAt: this.now() });
      tx.state.jobCommands[input.commandId] = record;
      return { record: clone(record), inserted: true };
    });
  }

  listPendingCommands(jobId: string): JobCommandRecord[] {
    return this.read((tx) =>
      clone(
        Object.values(tx.state.jobCommands)
          .filter((record) => record.jobId === jobId && record.deliveredAt === undefined)
          .sort(compareCreatedAndId("commandId")),
      ),
    );
  }

  markCommandDelivered(commandId: string): JobCommandRecord {
    return this.write((tx) => {
      const current = this.requireCommand(commandId, tx);
      if (current.deliveredAt === undefined) current.deliveredAt = this.now();
      return clone(current);
    });
  }

  getCompletion(completionId: string): CompletionOutboxRecord | undefined {
    return this.read((tx) => optionalClone(tx.state.completions[completionId]));
  }

  listPendingCompletions(
    input: number | { limit?: number; ownerSessionId?: string } = 100,
  ): CompletionOutboxRecord[] {
    const options = typeof input === "number" ? { limit: input } : input;
    return this.read((tx) => {
      const limit = Math.max(1, Math.min(options.limit ?? 100, 10_000));
      return clone(
        Object.values(tx.state.completions)
          .filter((record) => {
            if (record.deliveredAt !== undefined) return false;
            if (options.ownerSessionId === undefined) return true;
            return tx.state.jobs[record.jobId]?.ownerSessionId === options.ownerSessionId;
          })
          .sort(compareCreatedAndId("completionId"))
          .slice(0, limit),
      );
    });
  }

  markCompletionDelivered(completionId: string): CompletionOutboxRecord {
    return this.write((tx) => {
      const current = this.requireCompletion(completionId, tx);
      if (current.deliveredAt === undefined) current.deliveredAt = this.now();
      return clone(current);
    });
  }

  createMergeRequest(
    input: Omit<MergeRequestRecord, "version" | "createdAt" | "updatedAt">,
  ): MergeRequestRecord {
    return this.write((tx) => {
      if (tx.state.mergeRequests[input.mergeRequestId]) {
        throw new RuntimeConflictError(`合并请求 ${input.mergeRequestId} 已存在`);
      }
      this.requireJob(input.jobId, tx);
      if (input.attemptId) {
        const attempt = this.requireAttempt(input.attemptId, tx);
        if (attempt.jobId !== input.jobId) {
          throw new RuntimeConflictError(
            `合并请求 ${input.mergeRequestId} 的 attempt ${input.attemptId} 不属于 job ${input.jobId}`,
          );
        }
      }
      const now = this.now();
      const record: MergeRequestRecord = compact({
        ...input,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      tx.state.mergeRequests[input.mergeRequestId] = record;
      return clone(record);
    });
  }

  updateMergeRequest(
    mergeRequestId: string,
    expectedVersion: number,
    status: MergeRequestStatus,
    error?: string,
  ): MergeRequestRecord {
    return this.write((tx) => {
      const current = this.requireMerge(mergeRequestId, tx);
      if (current.version !== expectedVersion) {
        throw new RuntimeConflictError(`合并请求 ${mergeRequestId} 的版本 CAS 失败`);
      }
      const record = compact<MergeRequestRecord>({
        ...current,
        status,
        error,
        updatedAt: this.now(),
        version: current.version + 1,
      });
      tx.state.mergeRequests[mergeRequestId] = record;
      return clone(record);
    });
  }

  listMergeRequests(jobId?: string): MergeRequestRecord[] {
    return this.read((tx) =>
      clone(
        Object.values(tx.state.mergeRequests)
          .filter((record) => jobId === undefined || record.jobId === jobId)
          .sort(compareCreatedAndId("mergeRequestId")),
      ),
    );
  }

  recordProviderCall(record: Omit<ProviderCallRecord, "createdAt"> & { createdAt?: number }): {
    record: ProviderCallRecord;
    inserted: boolean;
  } {
    return this.write((tx) => {
      if (record.jobId) this.requireJob(record.jobId, tx);
      if (record.attemptId) {
        const attempt = this.requireAttempt(record.attemptId, tx);
        if (record.jobId && attempt.jobId !== record.jobId) {
          throw new RuntimeConflictError(
            `Provider call ${record.callId} 的 attempt ${record.attemptId} 不属于 job ${record.jobId}`,
          );
        }
      }
      const existing = this.usageRecords(tx).providerCalls.get(record.callId);
      if (existing) {
        if (!sameProviderCall(existing, record)) {
          throw new RuntimeConflictError(`Provider call ID ${record.callId} 已被其他调用使用`);
        }
        return { record: clone(existing), inserted: false };
      }
      const stored: ProviderCallRecord = compact({
        ...record,
        createdAt: record.createdAt ?? this.now(),
      });
      tx.usage.push({
        schemaVersion: LEDGER_SCHEMA_VERSION,
        type: "provider-call",
        record: stored,
      });
      return { record: clone(stored), inserted: true };
    });
  }

  putUsageBaseline(record: UsageBaselineRecord): {
    record: UsageBaselineRecord;
    inserted: boolean;
  } {
    return this.write((tx) => {
      const existing = this.usageRecords(tx).baselines.get(record.baselineId);
      if (existing) return { record: clone(existing), inserted: false };
      tx.usage.push({
        schemaVersion: LEDGER_SCHEMA_VERSION,
        type: "usage-baseline",
        record: clone(record),
      });
      return { record: clone(record), inserted: true };
    });
  }

  listProviderCalls(filter: UsageLedgerFilter = {}): ProviderCallRecord[] {
    return this.read((tx) =>
      clone(
        [...this.usageRecords(tx).providerCalls.values()]
          .filter((record) => matchesUsageFilter(record, filter))
          .sort(compareCreatedAndId("callId")),
      ),
    );
  }

  listUsageBaselines(filter: Omit<UsageLedgerFilter, "jobId"> = {}): UsageBaselineRecord[] {
    return this.read((tx) =>
      clone(
        [...this.usageRecords(tx).baselines.values()]
          .filter((record) => matchesUsageFilter(record, filter))
          .sort(
            (left, right) =>
              left.importedAt - right.importedAt || left.baselineId.localeCompare(right.baselineId),
          ),
      ),
    );
  }

  getUsageSummary(filter: UsageLedgerFilter = {}): UsageLedgerSummary {
    const providerCalls = this.listProviderCalls(filter);
    const baselines = filter.jobId ? [] : this.listUsageBaselines(filter);
    const providerTotals = sumUsage(providerCalls);
    const baselineTotals = sumUsage(baselines);
    return {
      providerCallCount: providerCalls.length,
      baselineCount: baselines.length,
      providerCalls: providerTotals,
      baselines: baselineTotals,
      total: addUsage(providerTotals, baselineTotals),
    };
  }

  private closeQueuedCronRun(
    cronRunId: string,
    status: "blocked" | "skipped",
    reason: string,
  ): CronRunRecord {
    return this.write((tx) => {
      const current = this.requireCronRun(cronRunId, tx);
      if (current.status === status) return clone(current);
      if (current.status !== "queued") {
        throw new RuntimeConflictError(
          `Cron Run ${cronRunId} 已进入 ${current.status}，不能${
            status === "blocked" ? "阻断" : "跳过"
          }`,
        );
      }
      const run: CronRunRecord = {
        ...current,
        status,
        reason,
        finishedAt: this.now(),
        version: current.version + 1,
      };
      tx.state.cronRuns[cronRunId] = run;
      this.insertRuntimeEvent(tx, {
        topic: `cron.run.${status}`,
        workspacePath: current.workspacePath,
        cronJobId: current.cronJobId,
        cronRunId,
        payload: { reason },
      });
      return clone(run);
    });
  }

  private assertLease(
    tx: RuntimeTransaction,
    resourceKey: string,
    ownerId: string,
    leaseEpoch: number,
  ): void {
    const current = tx.state.leases[resourceKey];
    if (
      !current ||
      current.ownerId !== ownerId ||
      current.leaseEpoch !== leaseEpoch ||
      current.expiresAt <= this.now()
    ) {
      throw new RuntimeConflictError(`资源 ${resourceKey} 的 lease 所有权已变化或过期`);
    }
  }

  private insertCompletion(tx: RuntimeTransaction, record: CompletionOutboxRecord): void {
    const existing = tx.state.completions[record.completionId];
    if (existing) {
      if (
        existing.jobId !== record.jobId ||
        existing.attemptId !== record.attemptId ||
        existing.status !== record.status ||
        !sameJson(existing.payload, record.payload)
      ) {
        throw new RuntimeConflictError(`Completion ID ${record.completionId} 已被其他终态使用`);
      }
      return;
    }
    tx.state.completions[record.completionId] = clone(record);
  }

  private persistDaemonRun(tx: RuntimeTransaction, input: DaemonRunRecord): DaemonRunRecord {
    const existing = tx.state.daemonRuns[input.runId];
    if (existing && existing.workspacePath !== input.workspacePath) {
      throw new RuntimeConflictError(`Run ID ${input.runId} 已属于其他工作区`);
    }
    if (!existing || input.version >= existing.version) {
      tx.state.daemonRuns[input.runId] = clone(input);
    }
    return tx.state.daemonRuns[input.runId]!;
  }

  private insertRuntimeEvent(
    tx: RuntimeTransaction,
    input: Omit<RuntimeEventRecord, "eventId" | "createdAt"> & {
      eventId?: string;
      createdAt?: number;
    },
  ): RuntimeEventRecord {
    const eventId = input.eventId ?? generateRuntimeId("event");
    if (this.runtimeEvents(tx).some(({ event }) => event.eventId === eventId)) {
      throw new RuntimeConflictError(`Runtime event ID ${eventId} 已存在`);
    }
    const event: RuntimeEventRecord = compact({
      ...input,
      eventId,
      createdAt: input.createdAt ?? this.now(),
    });
    tx.events.push({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      type: "runtime-event",
      sequence: tx.state.nextRuntimeEventSequence++,
      event,
    });
    return event;
  }

  private runtimeEvents(tx: RuntimeTransaction): Array<Omit<RuntimeEventEnvelope, "txId">> {
    const index = this.ensureStorageIndex(tx);
    const events = [...index.events, ...tx.events].sort(
      (left, right) => left.sequence - right.sequence,
    );
    if (
      events.length + 1 !== tx.state.nextRuntimeEventSequence ||
      new Set(events.map(({ event }) => event.eventId)).size !== events.length
    ) {
      throw new Error("daemon-events.jsonl 与 Runtime control state 不一致");
    }
    return events;
  }

  private usageRecords(tx: RuntimeTransaction): {
    providerCalls: Map<string, ProviderCallRecord>;
    baselines: Map<string, UsageBaselineRecord>;
  } {
    const index = this.ensureStorageIndex(tx);
    if (tx.usage.length === 0) {
      return { providerCalls: index.providerCalls, baselines: index.baselines };
    }
    const providerCalls = new Map(index.providerCalls);
    const baselines = new Map(index.baselines);
    for (const envelope of tx.usage) {
      if (envelope.type === "provider-call") {
        if (providerCalls.has(envelope.record.callId)) {
          throw new Error(`usage-ledger.jsonl 包含重复 callId: ${envelope.record.callId}`);
        }
        providerCalls.set(envelope.record.callId, envelope.record);
      } else {
        if (baselines.has(envelope.record.baselineId)) {
          throw new Error(`usage-ledger.jsonl 包含重复 baselineId: ${envelope.record.baselineId}`);
        }
        baselines.set(envelope.record.baselineId, envelope.record);
      }
    }
    return { providerCalls, baselines };
  }

  private ensureStorageIndex(tx: RuntimeTransaction): RuntimeStoreIndex {
    const state = {
      revision: tx.baseRevision,
      lastTransactionId: tx.baseTransactionId,
      nextRuntimeEventSequence: tx.baseNextRuntimeEventSequence,
    };
    const existing = runtimeStoreIndexes.get(this.storageRoot);
    if (
      existing &&
      existing.stateRevision === state.revision &&
      existing.stateTransactionId === state.lastTransactionId
    ) {
      return existing;
    }
    const refreshed = existing
      ? refreshRuntimeStoreIndex(this.storageRoot, state, existing)
      : rebuildRuntimeStoreIndex(this.storageRoot, state);
    runtimeStoreIndexes.set(this.storageRoot, refreshed);
    return refreshed;
  }

  private refreshExistingStorageIndex(state: RuntimeControlState): void {
    const existing = runtimeStoreIndexes.get(this.storageRoot);
    if (!existing) return;
    runtimeStoreIndexes.set(
      this.storageRoot,
      refreshRuntimeStoreIndex(this.storageRoot, state, existing),
    );
  }

  private updateStorageIndexAfterCommit(tx: RuntimeTransaction, transactionId: string): void {
    const index = runtimeStoreIndexes.get(this.storageRoot);
    if (!index) return;
    for (const event of tx.events) {
      if (index.eventIds.has(event.event.eventId)) {
        runtimeStoreIndexes.delete(this.storageRoot);
        return;
      }
      index.events.push(clone(event));
      index.eventIds.add(event.event.eventId);
    }
    for (const envelope of tx.usage) {
      if (envelope.type === "provider-call") {
        index.providerCalls.set(envelope.record.callId, clone(envelope.record));
      } else {
        index.baselines.set(envelope.record.baselineId, clone(envelope.record));
      }
    }
    index.stateRevision = tx.state.revision;
    index.stateTransactionId = transactionId;
    index.daemonFileSize = fileSize(join(this.storageRoot, DAEMON_EVENTS_FILE));
    index.usageFileSize = fileSize(join(this.storageRoot, USAGE_LEDGER_FILE));
  }

  private requireJob(jobId: string, tx: RuntimeTransaction): JobRecord {
    const value = tx.state.jobs[jobId];
    if (!value) throw new Error(`未知任务: ${jobId}`);
    return value;
  }

  private requireAttempt(attemptId: string, tx: RuntimeTransaction): JobAttemptRecord {
    const value = tx.state.attempts[attemptId];
    if (!value) throw new Error(`未知 attempt: ${attemptId}`);
    return value;
  }

  private requireCommand(commandId: string, tx: RuntimeTransaction): JobCommandRecord {
    const value = tx.state.jobCommands[commandId];
    if (!value) throw new Error(`未知命令: ${commandId}`);
    return value;
  }

  private requireCompletion(completionId: string, tx: RuntimeTransaction): CompletionOutboxRecord {
    const value = tx.state.completions[completionId];
    if (!value) throw new Error(`未知 completion: ${completionId}`);
    return value;
  }

  private requireMerge(mergeRequestId: string, tx: RuntimeTransaction): MergeRequestRecord {
    const value = tx.state.mergeRequests[mergeRequestId];
    if (!value) throw new Error(`未知合并请求: ${mergeRequestId}`);
    return value;
  }

  private requireCronJob(cronJobId: string, tx: RuntimeTransaction): CronJobRecord {
    const value = tx.state.cronJobs[cronJobId];
    if (!value) throw new Error(`未知 Cron Job: ${cronJobId}`);
    return value;
  }

  private requireCronRun(cronRunId: string, tx: RuntimeTransaction): CronRunRecord {
    const value = tx.state.cronRuns[cronRunId];
    if (!value) throw new Error(`未知 Cron Run: ${cronRunId}`);
    return value;
  }

  private read<Result>(operation: (tx: RuntimeTransaction) => Result): Result {
    const active = activeTransactions.get(this.storageRoot);
    if (active) return operation(active);
    return this.withRuntimeLock(() => {
      recoverFileTransactionSync(this.storageRoot, WORKSPACE_RUNTIME_TRANSACTION_OPTIONS);
      const state = this.loadState();
      this.refreshExistingStorageIndex(state);
      return operation(createRuntimeTransaction(state));
    });
  }

  private write<Result>(operation: (tx: RuntimeTransaction) => Result): Result {
    const active = activeTransactions.get(this.storageRoot);
    if (active) {
      const savepoint = clone(active);
      try {
        return operation(active);
      } catch (error) {
        active.state = savepoint.state;
        active.events = savepoint.events;
        active.usage = savepoint.usage;
        throw error;
      }
    }
    return this.withRuntimeLock(() => {
      recoverFileTransactionSync(this.storageRoot, WORKSPACE_RUNTIME_TRANSACTION_OPTIONS);
      const stateExists = existsSync(join(this.storageRoot, STATE_FILE));
      const state = this.loadState();
      this.refreshExistingStorageIndex(state);
      const tx = createRuntimeTransaction(state);
      const initialState = clone(tx.state);
      activeTransactions.set(this.storageRoot, tx);
      try {
        const result = operation(tx);
        if (
          stateExists &&
          tx.events.length === 0 &&
          tx.usage.length === 0 &&
          isDeepStrictEqual(tx.state, initialState)
        ) {
          return result;
        }
        const transactionId = randomUUID();
        tx.state.revision += 1;
        tx.state.lastTransactionId = transactionId;
        const appends: Array<{ relativePath: string; content: string }> = [];
        if (tx.events.length) {
          appends.push({
            relativePath: DAEMON_EVENTS_FILE,
            content: tx.events
              .map((event) => JSON.stringify({ ...event, txId: transactionId }))
              .join("\n")
              .concat("\n"),
          });
        }
        if (tx.usage.length) {
          appends.push({
            relativePath: USAGE_LEDGER_FILE,
            content: tx.usage
              .map((record) => JSON.stringify({ ...record, txId: transactionId }))
              .join("\n")
              .concat("\n"),
          });
        }
        commitFileTransactionSync(
          this.storageRoot,
          {
            replacements: [
              { relativePath: STATE_FILE, content: `${JSON.stringify(tx.state, null, 2)}\n` },
            ],
            appends,
          },
          { ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS, transactionId },
        );
        this.updateStorageIndexAfterCommit(tx, transactionId);
        return result;
      } catch (error) {
        runtimeStoreIndexes.delete(this.storageRoot);
        throw error;
      } finally {
        activeTransactions.delete(this.storageRoot);
      }
    });
  }

  private withRuntimeLock<Result>(operation: () => Result): Result {
    assertWorkspaceStorageRootIdentitySync(this.storageRoot, this.rootIdentity);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        return withFileLockSync(
          join(this.storageRoot, WORKSPACE_STORAGE_LOCK_DIRECTORY),
          `runtime:${process.pid}`,
          () => {
            assertWorkspaceStorageRootIdentitySync(this.storageRoot, this.rootIdentity);
            return operation();
          },
          { timeoutMs: Math.max(0, deadline - Date.now()) },
        );
      } catch (error) {
        // rm of a just-released lock has a tiny interval where the directory exists but owner.json
        // does not. Waiting is safe; taking ownership would not be.
        if (!(error instanceof LeaseConflictError) || Date.now() >= deadline) throw error;
        Atomics.wait(lockSleepArray, 0, 0, LOCK_RETRY_MS);
      }
    }
  }

  private loadState(): RuntimeControlState {
    const path = join(this.storageRoot, STATE_FILE);
    if (!existsSync(path)) return emptyState();
    return decodeRuntimeControlState(readJsonFileSync(path), path);
  }
}

interface RuntimeIndexState {
  revision: number;
  lastTransactionId?: string;
  nextRuntimeEventSequence: number;
}

function createRuntimeTransaction(state: RuntimeControlState): RuntimeTransaction {
  return {
    state,
    baseRevision: state.revision,
    baseTransactionId: state.lastTransactionId,
    baseNextRuntimeEventSequence: state.nextRuntimeEventSequence,
    events: [],
    usage: [],
  };
}

function refreshRuntimeStoreIndex(
  storageRoot: string,
  state: RuntimeIndexState,
  current: RuntimeStoreIndex,
): RuntimeStoreIndex {
  const daemonPath = join(storageRoot, DAEMON_EVENTS_FILE);
  const usagePath = join(storageRoot, USAGE_LEDGER_FILE);
  const daemonSize = fileSize(daemonPath);
  const usageSize = fileSize(usagePath);
  if (
    state.revision === current.stateRevision &&
    state.lastTransactionId === current.stateTransactionId &&
    daemonSize === current.daemonFileSize &&
    usageSize === current.usageFileSize
  ) {
    return current;
  }
  if (
    state.revision <= current.stateRevision ||
    state.lastTransactionId === current.stateTransactionId ||
    daemonSize < current.daemonFileSize ||
    usageSize < current.usageFileSize
  ) {
    return rebuildRuntimeStoreIndex(storageRoot, state, current);
  }

  try {
    const daemonValues = readJsonLineAppend(daemonPath, current.daemonFileSize, daemonSize);
    const usageValues = readJsonLineAppend(usagePath, current.usageFileSize, usageSize);
    if (!daemonValues || !usageValues) {
      return rebuildRuntimeStoreIndex(storageRoot, state, current);
    }
    if (state.revision === current.stateRevision + 1) {
      const appendedTransactionIds = [...daemonValues, ...usageValues].map((value) =>
        isRecord(value) && typeof value["txId"] === "string" ? value["txId"] : undefined,
      );
      if (
        appendedTransactionIds.some((transactionId) => transactionId !== state.lastTransactionId)
      ) {
        return rebuildRuntimeStoreIndex(storageRoot, state, current);
      }
    }

    const appendedEvents = decodeRuntimeEvents(daemonValues, current.events.length + 1);
    const events = [...current.events, ...appendedEvents];
    const eventIds = new Set(current.eventIds);
    for (const envelope of appendedEvents) {
      if (eventIds.has(envelope.event.eventId)) {
        return rebuildRuntimeStoreIndex(storageRoot, state, current);
      }
      eventIds.add(envelope.event.eventId);
    }
    if (events.length + 1 !== state.nextRuntimeEventSequence) {
      return rebuildRuntimeStoreIndex(storageRoot, state, current);
    }

    const appendedUsage = decodeUsageLedger(usageValues);
    const providerCalls = new Map(current.providerCalls);
    const baselines = new Map(current.baselines);
    for (const envelope of appendedUsage) {
      if (envelope.type === "provider-call") {
        if (providerCalls.has(envelope.record.callId)) {
          return rebuildRuntimeStoreIndex(storageRoot, state, current);
        }
        providerCalls.set(envelope.record.callId, envelope.record);
      } else {
        if (baselines.has(envelope.record.baselineId)) {
          return rebuildRuntimeStoreIndex(storageRoot, state, current);
        }
        baselines.set(envelope.record.baselineId, envelope.record);
      }
    }
    return {
      stateRevision: state.revision,
      stateTransactionId: state.lastTransactionId,
      daemonFileSize: daemonSize,
      usageFileSize: usageSize,
      events,
      eventIds,
      providerCalls,
      baselines,
      fullRebuildCount: current.fullRebuildCount,
      incrementalRefreshCount: current.incrementalRefreshCount + 1,
    };
  } catch {
    return rebuildRuntimeStoreIndex(storageRoot, state, current);
  }
}

function rebuildRuntimeStoreIndex(
  storageRoot: string,
  state: RuntimeIndexState,
  previous?: RuntimeStoreIndex,
): RuntimeStoreIndex {
  const daemonPath = join(storageRoot, DAEMON_EVENTS_FILE);
  const usagePath = join(storageRoot, USAGE_LEDGER_FILE);
  const events = decodeRuntimeEvents(readJsonLinesSync(daemonPath, true));
  const eventIds = new Set(events.map(({ event }) => event.eventId));
  if (events.length + 1 !== state.nextRuntimeEventSequence || eventIds.size !== events.length) {
    throw new Error("daemon-events.jsonl 与 Runtime control state 不一致");
  }
  const providerCalls = new Map<string, ProviderCallRecord>();
  const baselines = new Map<string, UsageBaselineRecord>();
  for (const envelope of decodeUsageLedger(readJsonLinesSync(usagePath, true))) {
    if (envelope.type === "provider-call") {
      if (providerCalls.has(envelope.record.callId)) {
        throw new Error(`usage-ledger.jsonl 包含重复 callId: ${envelope.record.callId}`);
      }
      providerCalls.set(envelope.record.callId, envelope.record);
    } else {
      if (baselines.has(envelope.record.baselineId)) {
        throw new Error(`usage-ledger.jsonl 包含重复 baselineId: ${envelope.record.baselineId}`);
      }
      baselines.set(envelope.record.baselineId, envelope.record);
    }
  }
  return {
    stateRevision: state.revision,
    stateTransactionId: state.lastTransactionId,
    daemonFileSize: fileSize(daemonPath),
    usageFileSize: fileSize(usagePath),
    events,
    eventIds,
    providerCalls,
    baselines,
    fullRebuildCount: (previous?.fullRebuildCount ?? 0) + 1,
    incrementalRefreshCount: previous?.incrementalRefreshCount ?? 0,
  };
}

function readJsonLineAppend(path: string, offset: number, size: number): unknown[] | undefined {
  if (size === offset) return [];
  if (size < offset || !existsSync(path)) return undefined;
  const length = size - offset;
  const buffer = Buffer.allocUnsafe(length);
  const descriptor = openSync(path, "r");
  try {
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readSync(descriptor, buffer, bytesRead, length - bytesRead, offset + bytesRead);
      if (count === 0) return undefined;
      bytesRead += count;
    }
  } finally {
    closeSync(descriptor);
  }
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) return undefined;
  return buffer
    .toString("utf8")
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line) as unknown);
}

function fileSize(path: string): number {
  if (!existsSync(path)) return 0;
  assertPrivateDataFileSync(path);
  return statSync(path).size;
}

function emptyState(): RuntimeControlState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: 0,
    nextRuntimeEventSequence: 1,
    jobs: {},
    attempts: {},
    leases: {},
    cronJobs: {},
    cronRuns: {},
    daemonCommands: {},
    daemonRuns: {},
    jobCommands: {},
    completions: {},
    mergeRequests: {},
  };
}

export function decodeRuntimeControlState(value: unknown, path: string): RuntimeControlState {
  if (!isRecord(value) || value["schemaVersion"] !== STATE_SCHEMA_VERSION) {
    throw new Error(`Runtime control state schema 不受支持: ${path}`);
  }
  const requiredMaps = [
    "jobs",
    "attempts",
    "leases",
    "cronJobs",
    "cronRuns",
    "daemonCommands",
    "daemonRuns",
    "jobCommands",
    "completions",
    "mergeRequests",
  ] as const;
  if (
    !isNonNegativeSafeInteger(value["revision"]) ||
    !isPositiveSafeInteger(value["nextRuntimeEventSequence"]) ||
    (value["lastTransactionId"] !== undefined && typeof value["lastTransactionId"] !== "string") ||
    requiredMaps.some((key) => !isRecord(value[key]))
  ) {
    throw new Error(`Runtime control state 已损坏: ${path}`);
  }
  validateRecordMap(value["jobs"], "jobs", "jobId", validateJob);
  validateRecordMap(value["attempts"], "attempts", "attemptId", validateAttempt);
  validateRecordMap(value["leases"], "leases", "resourceKey", validateLease);
  validateRecordMap(value["cronJobs"], "cronJobs", "cronJobId", validateCronJob);
  validateRecordMap(value["cronRuns"], "cronRuns", "cronRunId", validateCronRun);
  validateRecordMap(value["daemonCommands"], "daemonCommands", undefined, validateDaemonCommand);
  validateRecordMap(value["daemonRuns"], "daemonRuns", "runId", validateDaemonRun);
  validateRecordMap(value["jobCommands"], "jobCommands", "commandId", validateJobCommand);
  validateRecordMap(value["completions"], "completions", "completionId", validateCompletion);
  validateRecordMap(
    value["mergeRequests"],
    "mergeRequests",
    "mergeRequestId",
    validateMergeRequest,
  );
  validateRuntimeRelationships(value);
  return clone(value) as unknown as RuntimeControlState;
}

export function decodeRuntimeEvents(
  values: unknown[],
  firstExpectedSequence = 1,
): Array<Omit<RuntimeEventEnvelope, "txId">> {
  let expectedSequence = firstExpectedSequence;
  return values.map((value, index) => {
    if (
      !isRecord(value) ||
      value["schemaVersion"] !== LEDGER_SCHEMA_VERSION ||
      value["type"] !== "runtime-event" ||
      typeof value["txId"] !== "string" ||
      value["sequence"] !== expectedSequence ||
      !isRuntimeEventRecord(value["event"])
    ) {
      throw new Error(`daemon-events.jsonl 第 ${firstExpectedSequence + index} 条记录已损坏`);
    }
    expectedSequence += 1;
    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      type: "runtime-event",
      sequence: value["sequence"] as number,
      event: clone(value["event"]),
    };
  });
}

export function decodeUsageLedger(values: unknown[]): BufferedUsageLedgerEnvelope[] {
  return values.map((value, index) => {
    if (
      !isRecord(value) ||
      value["schemaVersion"] !== LEDGER_SCHEMA_VERSION ||
      typeof value["txId"] !== "string"
    ) {
      throw new Error(`usage-ledger.jsonl 第 ${index + 1} 条记录已损坏`);
    }
    if (value["type"] === "provider-call" && isProviderCall(value["record"])) {
      return {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        type: "provider-call",
        record: clone(value["record"]),
      };
    }
    if (value["type"] === "usage-baseline" && isUsageBaseline(value["record"])) {
      return {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        type: "usage-baseline",
        record: clone(value["record"]),
      };
    }
    throw new Error(`usage-ledger.jsonl 第 ${index + 1} 条记录类型无效`);
  });
}

function validateRecordMap(
  value: unknown,
  field: string,
  idField: string | undefined,
  validate: (record: Record<string, unknown>, field: string) => void,
): void {
  if (!isRecord(value)) throw invalidRuntimeState(`${field} must be an object`);
  for (const [id, record] of Object.entries(value)) {
    if (!isRecord(record)) throw invalidRuntimeState(`${field}.${id} must be an object`);
    if (idField !== undefined && record[idField] !== id) {
      throw invalidRuntimeState(`${field}.${id} has a mismatched ${idField}`);
    }
    validate(record, `${field}.${id}`);
  }
}

function validateJob(value: Record<string, unknown>, field: string): void {
  requireStrings(value, field, ["jobId", "type", "description"]);
  requireEnum(value, field, "status", JOB_STATUSES);
  requireEnum(value, field, "executionClass", JOB_EXECUTION_CLASSES);
  requireEnum(value, field, "completionPolicy", JOB_COMPLETION_POLICIES);
  requireIntegers(value, field, [
    "version",
    "leaseEpoch",
    "attemptCount",
    "createdAt",
    "updatedAt",
  ]);
  optionalStrings(value, field, [
    "ownerSessionId",
    "childSessionId",
    "toolUseId",
    "outputPath",
    "error",
  ]);
  optionalInteger(value, field, "terminalAt");
  optionalRecord(value, field, "data");
}

function validateAttempt(value: Record<string, unknown>, field: string): void {
  requireStrings(value, field, ["attemptId", "jobId", "ownerId"]);
  requireEnum(value, field, "status", JOB_STATUSES);
  requireIntegers(value, field, [
    "attemptNumber",
    "leaseEpoch",
    "outputOffset",
    "startedAt",
    "updatedAt",
    "version",
  ]);
  optionalStrings(value, field, ["outputPath", "error"]);
  optionalInteger(value, field, "finishedAt");
  optionalRecord(value, field, "result");
}

function validateLease(value: Record<string, unknown>, field: string): void {
  requireStrings(value, field, ["resourceKey", "ownerId"]);
  requireIntegers(value, field, ["leaseEpoch", "heartbeatAt", "expiresAt", "version"]);
}

function validateCronJob(value: Record<string, unknown>, field: string): void {
  requireStrings(value, field, [
    "cronJobId",
    "workspacePath",
    "name",
    "schedule",
    "timeZone",
    "prompt",
  ]);
  if (typeof value["enabled"] !== "boolean") throw invalidRuntimeState(`${field}.enabled`);
  requireIntegers(value, field, ["version", "createdAt", "updatedAt"]);
  try {
    parseBackgroundYoloPolicySnapshot(value["policySnapshot"]);
  } catch {
    throw invalidRuntimeState(`${field}.policySnapshot`);
  }
  if (value["credentialRef"] !== undefined) {
    if (typeof value["credentialRef"] !== "string") {
      throw invalidRuntimeState(`${field}.credentialRef`);
    }
    try {
      parseAnyCredentialRef(value["credentialRef"]);
    } catch {
      throw invalidRuntimeState(`${field}.credentialRef`);
    }
  }
  optionalStrings(value, field, ["modelRouteId"]);
}

function validateCronRun(value: Record<string, unknown>, field: string): void {
  requireStrings(value, field, ["cronRunId", "cronJobId", "workspacePath"]);
  requireEnum(value, field, "status", CRON_RUN_STATUSES);
  requireIntegers(value, field, ["scheduledFor", "leaseEpoch", "createdAt", "version"]);
  optionalStrings(value, field, ["ownerId", "reason"]);
  optionalInteger(value, field, "startedAt");
  optionalInteger(value, field, "finishedAt");
  optionalRecord(value, field, "result");
}

function validateDaemonCommand(value: Record<string, unknown>, field: string): void {
  requireStrings(value, field, ["commandType", "idempotencyKey", "requestHash", "requestJson"]);
  requireEnum(value, field, "status", ["pending", "completed"] as const);
  requireIntegers(value, field, ["createdAt", "updatedAt"]);
  optionalStrings(value, field, ["resourceId"]);
  optionalRecord(value, field, "result");
}

function validateDaemonRun(value: Record<string, unknown>, field: string): void {
  requireStrings(value, field, ["runId", "workspacePath", "description"]);
  requireEnum(value, field, "status", DAEMON_RUN_STATUSES);
  requireIntegers(value, field, ["startedAt", "updatedAt", "version"]);
  optionalStrings(value, field, ["sessionId", "checkpointId", "error"]);
  optionalInteger(value, field, "finishedAt");
  optionalRecord(value, field, "result");
}

function validateJobCommand(value: Record<string, unknown>, field: string): void {
  requireStrings(value, field, ["commandId", "jobId"]);
  requireEnum(value, field, "kind", JOB_COMMAND_KINDS);
  requireIntegers(value, field, ["createdAt"]);
  optionalInteger(value, field, "deliveredAt");
  optionalRecord(value, field, "payload");
}

function validateCompletion(value: Record<string, unknown>, field: string): void {
  requireStrings(value, field, ["completionId", "jobId"]);
  requireEnum(value, field, "policy", JOB_COMPLETION_POLICIES);
  requireEnum(value, field, "status", TERMINAL_JOB_STATUSES);
  requireIntegers(value, field, ["createdAt"]);
  optionalStrings(value, field, ["attemptId"]);
  optionalInteger(value, field, "deliveredAt");
  optionalRecord(value, field, "payload");
}

function validateMergeRequest(value: Record<string, unknown>, field: string): void {
  requireStrings(value, field, [
    "mergeRequestId",
    "jobId",
    "sourceBranch",
    "sourceWorktree",
    "targetBranch",
    "targetWorktree",
  ]);
  requireEnum(value, field, "status", MERGE_REQUEST_STATUSES);
  requireIntegers(value, field, ["version", "createdAt", "updatedAt"]);
  optionalStrings(value, field, ["attemptId", "sourceHead", "error"]);
}

function validateRuntimeRelationships(state: Record<string, unknown>): void {
  const jobs = state["jobs"] as Record<string, Record<string, unknown>>;
  const attempts = state["attempts"] as Record<string, Record<string, unknown>>;
  const cronJobs = state["cronJobs"] as Record<string, Record<string, unknown>>;
  const cronRuns = state["cronRuns"] as Record<string, Record<string, unknown>>;
  const jobCommands = state["jobCommands"] as Record<string, Record<string, unknown>>;
  const completions = state["completions"] as Record<string, Record<string, unknown>>;
  const mergeRequests = state["mergeRequests"] as Record<string, Record<string, unknown>>;

  const attemptNumbers = new Set<string>();
  for (const [attemptId, attempt] of Object.entries(attempts)) {
    const jobId = attempt["jobId"] as string;
    if (!(jobId in jobs)) throw invalidRuntimeState(`attempts.${attemptId}.jobId is orphaned`);
    const identity = `${jobId}\0${String(attempt["attemptNumber"])}`;
    if (attemptNumbers.has(identity)) {
      throw invalidRuntimeState(`attempts has duplicate jobId/attemptNumber ${jobId}`);
    }
    attemptNumbers.add(identity);
  }
  for (const [commandId, command] of Object.entries(jobCommands)) {
    if (!((command["jobId"] as string) in jobs)) {
      throw invalidRuntimeState(`jobCommands.${commandId}.jobId is orphaned`);
    }
  }

  const completedAttempts = new Set<string>();
  for (const [completionId, completion] of Object.entries(completions)) {
    const jobId = completion["jobId"] as string;
    if (!(jobId in jobs)) {
      throw invalidRuntimeState(`completions.${completionId}.jobId is orphaned`);
    }
    const attemptId = completion["attemptId"];
    if (typeof attemptId === "string") {
      if (!(attemptId in attempts) || attempts[attemptId]?.["jobId"] !== jobId) {
        throw invalidRuntimeState(`completions.${completionId}.attemptId is orphaned`);
      }
      if (completedAttempts.has(attemptId)) {
        throw invalidRuntimeState(`completions has duplicate attemptId ${attemptId}`);
      }
      completedAttempts.add(attemptId);
    }
  }
  for (const [mergeRequestId, request] of Object.entries(mergeRequests)) {
    const jobId = request["jobId"] as string;
    if (!(jobId in jobs)) {
      throw invalidRuntimeState(`mergeRequests.${mergeRequestId}.jobId is orphaned`);
    }
    const attemptId = request["attemptId"];
    if (
      typeof attemptId === "string" &&
      (!(attemptId in attempts) || attempts[attemptId]?.["jobId"] !== jobId)
    ) {
      throw invalidRuntimeState(`mergeRequests.${mergeRequestId}.attemptId is orphaned`);
    }
  }

  const scheduledRuns = new Set<string>();
  for (const [cronRunId, run] of Object.entries(cronRuns)) {
    const cronJobId = run["cronJobId"] as string;
    if (!(cronJobId in cronJobs)) {
      throw invalidRuntimeState(`cronRuns.${cronRunId}.cronJobId is orphaned`);
    }
    const identity = `${cronJobId}\0${String(run["scheduledFor"])}`;
    if (scheduledRuns.has(identity)) {
      throw invalidRuntimeState(`cronRuns has duplicate cronJobId/scheduledFor ${cronJobId}`);
    }
    scheduledRuns.add(identity);
  }
}

function isRuntimeEventRecord(value: unknown): value is RuntimeEventRecord {
  return (
    isRecord(value) &&
    isNonEmptyString(value["eventId"]) &&
    isNonEmptyString(value["topic"]) &&
    isNonEmptyString(value["workspacePath"]) &&
    isFiniteNumber(value["createdAt"]) &&
    isOptionalString(value["cronJobId"]) &&
    isOptionalString(value["cronRunId"]) &&
    isOptionalRecord(value["payload"])
  );
}

function isProviderCall(value: unknown): value is ProviderCallRecord {
  return (
    isRecord(value) &&
    isNonEmptyString(value["callId"]) &&
    (PROVIDER_CALL_PURPOSES as readonly unknown[]).includes(value["purpose"]) &&
    isNonEmptyString(value["provider"]) &&
    isNonEmptyString(value["model"]) &&
    (PROVIDER_CALL_STATUSES as readonly unknown[]).includes(value["status"]) &&
    isUsageNumbers(value) &&
    isFiniteNumber(value["createdAt"]) &&
    ["sessionId", "conversationId", "goalId", "jobId", "attemptId", "route"].every((field) =>
      isOptionalString(value[field]),
    ) &&
    isOptionalRecord(value["reported"])
  );
}

function isUsageBaseline(value: unknown): value is UsageBaselineRecord {
  return (
    isRecord(value) &&
    isNonEmptyString(value["baselineId"]) &&
    isUsageNumbers(value) &&
    isFiniteNumber(value["importedAt"]) &&
    isOptionalString(value["sessionId"]) &&
    isOptionalString(value["goalId"]) &&
    isOptionalRecord(value["source"])
  );
}

function requireStrings(
  value: Record<string, unknown>,
  field: string,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (!isNonEmptyString(value[key])) throw invalidRuntimeState(`${field}.${key}`);
  }
}

function optionalStrings(
  value: Record<string, unknown>,
  field: string,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (!isOptionalString(value[key])) throw invalidRuntimeState(`${field}.${key}`);
  }
}

function requireIntegers(
  value: Record<string, unknown>,
  field: string,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (!isNonNegativeSafeInteger(value[key])) throw invalidRuntimeState(`${field}.${key}`);
  }
}

function optionalInteger(value: Record<string, unknown>, field: string, key: string): void {
  if (value[key] !== undefined && !isNonNegativeSafeInteger(value[key])) {
    throw invalidRuntimeState(`${field}.${key}`);
  }
}

function optionalRecord(value: Record<string, unknown>, field: string, key: string): void {
  if (!isOptionalRecord(value[key])) throw invalidRuntimeState(`${field}.${key}`);
}

function requireEnum(
  value: Record<string, unknown>,
  field: string,
  key: string,
  allowed: readonly unknown[],
): void {
  if (!allowed.includes(value[key])) throw invalidRuntimeState(`${field}.${key}`);
}

function invalidRuntimeState(field: string): Error {
  return new Error(`Runtime control state 已损坏: ${field}`);
}

function isUsageNumbers(value: Record<string, unknown>): boolean {
  return ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost"].every(
    (field) => isFiniteNonNegativeNumber(value[field]),
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function daemonCommandKey(commandType: string, idempotencyKey: string): string {
  return `${commandType}\0${idempotencyKey}`;
}

function validateCredentialRoute(
  credential: ReturnType<typeof parseAnyCredentialRef> | undefined,
  modelRouteId: string | undefined,
): void {
  if (credential?.version === "v2" && modelRouteId === undefined) {
    throw new Error("v2 Provider credentialRef 必须配套固定 modelRouteId");
  }
  if (
    credential?.version === "v1" &&
    modelRouteId !== undefined &&
    credential.modelRouteId !== modelRouteId
  ) {
    throw new Error("modelRouteId 与 v1 credentialRef 绑定的路由不一致");
  }
  if (
    credential?.version === "v2" &&
    modelRouteId !== undefined &&
    providerIdFromModelRoute(modelRouteId) !== credential.providerId
  ) {
    throw new Error("modelRouteId 与 v2 credentialRef 绑定的 Provider 不一致");
  }
}

function normalizeOptionalModelRouteId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^[^/\s]+\/.+$/u.test(normalized)) {
    throw new Error("modelRouteId 必须使用 providerID/modelID 格式");
  }
  return normalized;
}

function providerIdFromModelRoute(modelRouteId: string): string {
  return modelRouteId.slice(0, modelRouteId.indexOf("/"));
}

function normalizeCronJobName(name: string | undefined, prompt = ""): string {
  const normalized = (name ?? prompt).trim().replace(/\s+/gu, " ");
  if (!normalized) throw new Error("Cron Job name 必须是非空字符串");
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 79)}…`;
}

function normalizeCronPrompt(prompt: string): string {
  const normalized = prompt.trim();
  if (!normalized) throw new Error("Cron Job prompt 必须是非空字符串");
  return normalized;
}

function interruptedCompletionPayload(
  job: JobRecord,
  completionId: string,
  reason: string,
  completionSeq: number,
): Record<string, unknown> {
  const base = { reason, executionClass: job.executionClass };
  if (job.type !== "local_agent" || !job.ownerSessionId) return base;
  const activityIds = Array.isArray(job.data?.["activityIds"])
    ? job.data["activityIds"].filter((value): value is string => typeof value === "string")
    : [];
  const error = `子代理运行时 lease 过期，已中断：${reason}`;
  return {
    ...base,
    delegationCompletion: {
      completionId,
      jobId: job.jobId,
      ownerSessionId: job.ownerSessionId,
      completionSeq,
      activityIds,
      completionPolicy: job.completionPolicy,
      status: "error",
      outputSummary: error,
      error: reason,
    },
  };
}

function daemonRunRecoveryEvent(run: DaemonRunRecord): RuntimeEventRecord {
  const eventId = `${DAEMON_RUN_RECOVERY_EVENT_PREFIX}${createHash("sha256")
    .update(`${run.workspacePath}\0${run.runId}\0${run.version}`)
    .digest("hex")}`;
  return {
    eventId,
    topic: "run.finished",
    workspacePath: run.workspacePath,
    payload: {
      scope: compact({
        workspacePath: run.workspacePath,
        sessionId: run.sessionId,
        runId: run.runId,
      }),
      resourceVersion: run.version,
      payload: {
        run: compact({
          runId: run.runId,
          workspacePath: run.workspacePath,
          sessionId: run.sessionId,
          description: run.description,
          status: run.status,
          startedAt: run.startedAt,
          updatedAt: run.updatedAt,
          finishedAt: run.finishedAt,
          error: run.error,
          result: run.result,
          version: run.version,
        }),
      },
    },
    createdAt: run.finishedAt ?? run.updatedAt,
  };
}

function sameJson(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  return isDeepStrictEqual(left, right);
}

function sameProviderCall(
  stored: ProviderCallRecord,
  input: Omit<ProviderCallRecord, "createdAt"> & { createdAt?: number },
): boolean {
  return (
    stored.callId === input.callId &&
    stored.sessionId === input.sessionId &&
    stored.conversationId === input.conversationId &&
    stored.goalId === input.goalId &&
    stored.jobId === input.jobId &&
    stored.attemptId === input.attemptId &&
    stored.purpose === input.purpose &&
    stored.provider === input.provider &&
    stored.model === input.model &&
    stored.route === input.route &&
    stored.status === input.status &&
    stored.inputTokens === input.inputTokens &&
    stored.outputTokens === input.outputTokens &&
    stored.cacheReadTokens === input.cacheReadTokens &&
    stored.cacheWriteTokens === input.cacheWriteTokens &&
    stored.cost === input.cost &&
    isDeepStrictEqual(stored.reported, input.reported)
  );
}

function matchesUsageFilter(
  record: ProviderCallRecord | UsageBaselineRecord,
  filter: UsageLedgerFilter | Omit<UsageLedgerFilter, "jobId">,
): boolean {
  return (
    (filter.sessionId === undefined || record.sessionId === filter.sessionId) &&
    (filter.goalId === undefined || record.goalId === filter.goalId) &&
    (!("jobId" in filter) ||
      filter.jobId === undefined ||
      ("jobId" in record && record.jobId === filter.jobId))
  );
}

function sumUsage(
  records: readonly (ProviderCallRecord | UsageBaselineRecord)[],
): UsageLedgerTotals {
  return records.reduce<UsageLedgerTotals>(
    (total, record) => ({
      inputTokens: total.inputTokens + record.inputTokens,
      outputTokens: total.outputTokens + record.outputTokens,
      cacheReadTokens: total.cacheReadTokens + record.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + record.cacheWriteTokens,
      cost: total.cost + record.cost,
    }),
    emptyUsage(),
  );
}

function addUsage(left: UsageLedgerTotals, right: UsageLedgerTotals): UsageLedgerTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    cost: left.cost + right.cost,
  };
}

function emptyUsage(): UsageLedgerTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareCreatedAndId<
  Id extends string,
  RecordType extends { createdAt: number } & Record<Id, string>,
>(id: Id): (left: RecordType, right: RecordType) => number {
  return (left, right) => left.createdAt - right.createdAt || left[id].localeCompare(right[id]);
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, current]) => current !== undefined),
  ) as T;
}

function withoutKeys<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  for (const key of keys) delete value[key];
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function optionalClone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function generateRuntimeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
