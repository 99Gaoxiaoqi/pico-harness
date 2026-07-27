import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
  RuntimeConflictError,
  RuntimeStore,
  generateRuntimeId,
  type FinishJobResult,
  type RecoverableJobTerminalStatus,
  type RuntimeStoreOptions,
  type SettleRecoverableJobAfterTaskTerminalResult,
  type StartRecoverableJobSuccessorResult,
} from "./runtime-store.js";
import {
  isTerminalJobStatus,
  type CompletionOutboxRecord,
  type JobAttemptRecord,
  type JobCommandRecord,
  type JobCompletionPolicy,
  type JobExecutionClass,
  type JobListFilter,
  type JobRecord,
  type JobWithAttempts,
  type MergeRequestRecord,
  type MergeRequestStatus,
  type ProviderCallRecord,
  type RuntimeLeaseRecord,
  type TerminalJobStatus,
  type UsageBaselineRecord,
  type UsageLedgerFilter,
  type UsageLedgerSummary,
} from "./runtime-types.js";

export interface JobServiceOptions extends RuntimeStoreOptions {
  ownerId?: string;
  generateId?: (prefix: "job" | "attempt" | "command" | "merge") => string;
}

export interface JobServiceCreateResult {
  service: JobService;
}

export interface DispatchJobInput {
  jobId?: string;
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

export interface StartJobOptions {
  expectedVersion: number;
  attemptId?: string;
  outputPath?: string;
  leaseTtlMs?: number;
}

export interface StartJobResult {
  job: JobRecord;
  attempt: JobAttemptRecord;
  lease: RuntimeLeaseRecord;
}

export interface StartRecoverableJobSuccessorOptions {
  sourceAttemptId: string;
  successorAttemptId: string;
  expectedJobVersion: number;
  expectedSourceAttemptVersion: number;
  outputPath?: string;
  reason?: string;
  leaseTtlMs?: number;
}

export interface StartRecoverableJobSuccessorServiceResult extends StartRecoverableJobSuccessorResult {
  lease: RuntimeLeaseRecord;
}

export interface SettleRecoverableJobAfterTaskTerminalOptions {
  jobId: string;
  attemptId: string;
  completionId: string;
  status: RecoverableJobTerminalStatus;
  outputOffset?: number;
  error?: string;
  result?: Record<string, unknown>;
  completionPayload?: Record<string, unknown>;
  completionAlreadyDelivered?: boolean;
  leaseTtlMs?: number;
}

export interface TerminalJobInput {
  jobId: string;
  attemptId: string;
  status: TerminalJobStatus;
  expectedJobVersion: number;
  expectedAttemptVersion: number;
  leaseEpoch: number;
  completionId?: string;
  outputOffset?: number;
  error?: string;
  result?: Record<string, unknown>;
  completionPayload?: Record<string, unknown>;
  /** 结果由外层编排器同步交付时，在同一事务中将 outbox 标为已交付。 */
  completionAlreadyDelivered?: boolean;
}

export interface CancelJobInput {
  commandId?: string;
  expectedVersion: number;
  reason?: string;
}

export interface CancelJobResult {
  job: JobRecord;
  command: JobCommandRecord;
  completion?: CompletionOutboxRecord;
}

/**
 * Stable task control API. Executors own processes/worktrees; JobService owns durable state,
 * leases, attempts, commands and exactly-once completion identifiers.
 */
export class JobService {
  readonly store: RuntimeStore;
  readonly ownerId: string;
  private readonly generateId: NonNullable<JobServiceOptions["generateId"]>;

  constructor(options: JobServiceOptions) {
    this.store = new RuntimeStore(options);
    this.ownerId = options.ownerId ?? `host:${process.pid}`;
    this.generateId = options.generateId ?? generateRuntimeId;
  }

  static async create(options: JobServiceOptions): Promise<JobServiceCreateResult> {
    const service = new JobService(options);
    return { service };
  }

  dispatch(input: DispatchJobInput): JobRecord {
    return this.store.createJob({
      ...input,
      jobId: input.jobId ?? this.generateId("job"),
    });
  }

  start(jobId: string, options: StartJobOptions): StartJobResult {
    const lease = this.store.acquireLease(`job:${jobId}`, this.ownerId, options.leaseTtlMs);
    try {
      const started = this.store.startJob({
        jobId,
        attemptId: options.attemptId ?? this.generateId("attempt"),
        ownerId: this.ownerId,
        leaseEpoch: lease.leaseEpoch,
        expectedVersion: options.expectedVersion,
        outputPath: options.outputPath,
      });
      return { ...started, lease };
    } catch (error) {
      const current = this.store.getJob(jobId);
      if (current?.status === "queued") {
        this.store.releaseLease(`job:${jobId}`, this.ownerId, lease.leaseEpoch);
      }
      throw error;
    }
  }

  startRecoverableSuccessor(
    jobId: string,
    options: StartRecoverableJobSuccessorOptions,
  ): StartRecoverableJobSuccessorServiceResult {
    const lease = this.store.acquireLease(`job:${jobId}`, this.ownerId, options.leaseTtlMs);
    try {
      const result = this.store.startRecoverableJobSuccessor({
        jobId,
        sourceAttemptId: options.sourceAttemptId,
        successorAttemptId: options.successorAttemptId,
        ownerId: this.ownerId,
        leaseEpoch: lease.leaseEpoch,
        expectedJobVersion: options.expectedJobVersion,
        expectedSourceAttemptVersion: options.expectedSourceAttemptVersion,
        ...(options.outputPath ? { outputPath: options.outputPath } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      });
      return { ...result, lease };
    } catch (error) {
      const current = this.store.getJob(jobId);
      const successor = this.store.getAttempt(options.successorAttemptId);
      const committed =
        current?.status === "running" &&
        current.leaseEpoch === lease.leaseEpoch &&
        successor?.jobId === jobId &&
        successor.status === "running" &&
        successor.ownerId === this.ownerId &&
        successor.leaseEpoch === lease.leaseEpoch;
      if (!committed) {
        try {
          this.store.releaseLease(`job:${jobId}`, this.ownerId, lease.leaseEpoch);
        } catch (releaseError) {
          if (!(releaseError instanceof RuntimeConflictError)) throw releaseError;
        }
      }
      throw error;
    }
  }

  settleRecoverableJobAfterTaskTerminal(
    options: SettleRecoverableJobAfterTaskTerminalOptions,
  ): SettleRecoverableJobAfterTaskTerminalResult {
    const current = this.store.getJob(options.jobId);
    if (!current) throw new Error(`未知任务: ${options.jobId}`);
    const lease = isTerminalJobStatus(current.status)
      ? undefined
      : this.store.acquireLease(`job:${options.jobId}`, this.ownerId, options.leaseTtlMs);
    try {
      const result = this.store.settleRecoverableJobAfterTaskTerminal({
        jobId: options.jobId,
        attemptId: options.attemptId,
        ownerId: this.ownerId,
        leaseEpoch: lease?.leaseEpoch ?? current.leaseEpoch,
        completionId: options.completionId,
        status: options.status,
        ...(options.outputOffset !== undefined ? { outputOffset: options.outputOffset } : {}),
        ...(options.error !== undefined ? { error: options.error } : {}),
        ...(options.result !== undefined ? { result: options.result } : {}),
        ...(options.completionPayload !== undefined
          ? { completionPayload: options.completionPayload }
          : {}),
        ...(options.completionAlreadyDelivered !== undefined
          ? { completionAlreadyDelivered: options.completionAlreadyDelivered }
          : {}),
      });
      if (lease) {
        try {
          this.store.releaseLease(`job:${options.jobId}`, this.ownerId, lease.leaseEpoch);
        } catch (error) {
          if (!(error instanceof RuntimeConflictError)) throw error;
        }
      }
      return result;
    } catch (error) {
      if (lease) {
        try {
          this.store.releaseLease(`job:${options.jobId}`, this.ownerId, lease.leaseEpoch);
        } catch (releaseError) {
          if (!(releaseError instanceof RuntimeConflictError)) {
            throw new AggregateError(
              [error, releaseError],
              `recoverable Job ${options.jobId} terminal settlement and lease release both failed`,
              { cause: releaseError },
            );
          }
        }
      }
      throw error;
    }
  }

  heartbeat(jobId: string, leaseEpoch: number, ttlMs?: number): RuntimeLeaseRecord {
    return this.store.heartbeatLease(`job:${jobId}`, this.ownerId, leaseEpoch, ttlMs);
  }

  terminal(input: TerminalJobInput): FinishJobResult {
    const result = this.store.finishJob({
      ...input,
      ownerId: this.ownerId,
      completionId: input.completionId ?? `completion:${input.attemptId}`,
    });
    try {
      this.store.releaseLease(`job:${input.jobId}`, this.ownerId, input.leaseEpoch);
    } catch (error) {
      if (!(error instanceof RuntimeConflictError)) throw error;
    }
    return result;
  }

  retry(jobId: string, expectedVersion: number): JobRecord {
    return this.store.retryJob(jobId, expectedVersion);
  }

  cancel(jobId: string, input: CancelJobInput): CancelJobResult {
    const commandId = input.commandId ?? this.generateId("command");
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`未知任务: ${jobId}`);
    const existingCommand = this.store
      .listPendingCommands(jobId)
      .find((command) => command.commandId === commandId);
    if (job.version !== input.expectedVersion && !(job.status === "cancelled" && existingCommand)) {
      throw new RuntimeConflictError(`任务 ${jobId} 版本已从 ${input.expectedVersion} 变化`);
    }
    const { record: command } = this.store.insertCommand({
      commandId,
      jobId,
      kind: "cancel",
      payload: input.reason ? { reason: input.reason } : undefined,
    });
    if (job.status !== "queued") {
      return {
        job,
        command,
        ...(job.status === "cancelled"
          ? { completion: this.store.getCompletion(`completion:${commandId}`) }
          : {}),
      };
    }

    const cancelled = this.store.cancelQueuedJob({
      jobId,
      expectedVersion: input.expectedVersion,
      completionId: `completion:${commandId}`,
      reason: input.reason,
    });
    return { ...cancelled, command };
  }

  sendMessage(
    jobId: string,
    message: string,
    commandId = this.generateId("command"),
  ): { command: JobCommandRecord; inserted: boolean } {
    if (!message.trim()) throw new Error("发送给任务的消息不能为空");
    if (this.store.getJob(jobId)?.status !== "running") {
      throw new RuntimeConflictError(`任务 ${jobId} 不在 running 状态，不能发送消息`);
    }
    const inserted = this.store.insertCommand({
      commandId,
      jobId,
      kind: "message",
      payload: { message },
    });
    return { command: inserted.record, inserted: inserted.inserted };
  }

  get(jobId: string): JobWithAttempts | undefined {
    const job = this.store.getJob(jobId);
    return job ? { job, attempts: this.store.listAttempts(jobId) } : undefined;
  }

  list(filter: JobListFilter = {}): JobRecord[] {
    return this.store.listJobs(filter);
  }

  tail(jobId: string, maxChars = 8_000): string {
    const attempts = this.store.listAttempts(jobId);
    const latest = attempts.at(-1);
    const outputPath = latest?.outputPath ?? this.store.getJob(jobId)?.outputPath;
    if (!outputPath) return "";
    return readFileTail(outputPath, maxChars);
  }

  pendingCommands(jobId: string): JobCommandRecord[] {
    return this.store.listPendingCommands(jobId);
  }

  markCommandDelivered(commandId: string): JobCommandRecord {
    return this.store.markCommandDelivered(commandId);
  }

  pendingCompletions(
    input?: number | { limit?: number; ownerSessionId?: string },
  ): CompletionOutboxRecord[] {
    return this.store.listPendingCompletions(input);
  }

  markCompletionDelivered(completionId: string): CompletionOutboxRecord {
    return this.store.markCompletionDelivered(completionId);
  }

  recordProviderCall(record: Omit<ProviderCallRecord, "createdAt"> & { createdAt?: number }): {
    record: ProviderCallRecord;
    inserted: boolean;
  } {
    return this.store.recordProviderCall(record);
  }

  putUsageBaseline(record: UsageBaselineRecord): {
    record: UsageBaselineRecord;
    inserted: boolean;
  } {
    return this.store.putUsageBaseline(record);
  }

  getUsageSummary(filter: UsageLedgerFilter = {}): UsageLedgerSummary {
    return this.store.getUsageSummary(filter);
  }

  enqueueMerge(
    input: Omit<
      MergeRequestRecord,
      "mergeRequestId" | "status" | "version" | "createdAt" | "updatedAt"
    > & {
      mergeRequestId?: string;
    },
  ): MergeRequestRecord {
    return this.store.createMergeRequest({
      ...input,
      mergeRequestId: input.mergeRequestId ?? this.generateId("merge"),
      status: "queued",
    });
  }

  updateMerge(
    mergeRequestId: string,
    expectedVersion: number,
    status: MergeRequestStatus,
    error?: string,
  ): MergeRequestRecord {
    return this.store.updateMergeRequest(mergeRequestId, expectedVersion, status, error);
  }

  listMerges(jobId?: string): MergeRequestRecord[] {
    return this.store.listMergeRequests(jobId);
  }

  reconcileExpiredJobs(reason?: string): JobRecord[] {
    return this.store.interruptExpiredJobs(reason);
  }

  close(): void {
    this.store.close();
  }
}

function readFileTail(path: string, maxChars: number): string {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) return "";
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const size = fstatSync(descriptor).size;
    const bytesToRead = Math.min(size, maxChars * 4);
    const buffer = Buffer.alloc(bytesToRead);
    readSync(descriptor, buffer, 0, bytesToRead, size - bytesToRead);
    return buffer.toString("utf8").slice(-maxChars);
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return "";
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export { RuntimeConflictError };
