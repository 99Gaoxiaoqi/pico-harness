import type { WorkspaceId } from "../paths/pico-paths.js";
import { FileStorageIntegrityError } from "../storage/local-file-storage.js";
import type {
  Fact,
  FactState,
  Job,
  MemoryJobCursor,
  MemoryJobStatus,
  MemoryKind,
  MemoryReviewMode,
  Mutation,
  MutationEntityType,
  Proposal,
  ProposalConflictStatus,
  ProposalStatus,
  Settings,
  Source,
  SourceAvailability,
} from "./domain.js";
import type { EvidenceRef } from "../engine/evidence-ref.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Memory 事实权威的共享契约(票 09,JSONL 纪元退役)。
 *
 * 旧文件实现的 MemoryRepository 类(state.json 整文档事务)已删除;契约、
 * 错误类与通知常量保留,SQLite 纪元实现见
 * src/storage/sqlite/sqlite-memory-repository.ts(ADR 24 §4.4)。
 */
export const MEMORY_FORGOTTEN_NOTIFICATION_JOB_TYPE = "notification.memory.forgotten" as const;
export const MEMORY_FORGOTTEN_NOTIFICATION_VERSION = "memory-forgotten-notification-v1" as const;
export const MEMORY_PROPOSED_NOTIFICATION_JOB_TYPE = "notification.memory.proposed" as const;
export const MEMORY_PROPOSED_NOTIFICATION_VERSION_PREFIX =
  "memory-proposed-notification-v1:" as const;
export const MEMORY_SOURCE_NOTIFICATION_JOB_TYPE = "notification.memory.source-changed" as const;
export const MEMORY_SOURCE_UNAVAILABLE_NOTIFICATION_VERSION =
  "memory-source-notification-v1:unavailable" as const;

export type RejectAsyncTransactionArguments<Result> = [Result] extends [never]
  ? []
  : Result extends PromiseLike<unknown>
    ? ["MemoryRepository.transaction callback must be synchronous"]
    : [];

export interface MemoryRepositoryOptions {
  readonly storageRoot: string;
  readonly workspaceId: WorkspaceId;
  readonly now?: () => Date;
  readonly busyTimeoutMs?: number;
}

/**
 * MemoryRepository 的引擎无关公共面(票 07):文件实现与 SQLite 实现共同满足,
 * 消费方(proposal-engine/worker/daemon/kernel 装配)按此契约编程。
 */
export interface MemoryRepositoryContract {
  readonly storageRoot: string;
  readonly workspaceId: WorkspaceId;

  close(): void;
  transaction<Result>(
    operation: (repository: MemoryRepositoryContract) => Result,
    ...rejectAsync: RejectAsyncTransactionArguments<Result>
  ): Result;

  getSettings(): Settings;
  updateSettings(input: UpdateSettingsInput): Settings;

  createSource(input: CreateSourceInput): Source;
  getSource(sourceId: string): Source | undefined;
  listSources(limit?: number): Source[];
  listSessionSources(sessionId: string, options?: SessionSourceListOptions): Source[];
  updateSourceAvailability(input: UpdateSourceAvailabilityInput): Source;

  createFact(input: CreateFactInput): Fact;
  getFact(factId: string): Fact | undefined;
  listFacts(options?: FactListOptions): Fact[];
  updateFact(input: UpdateFactInput): Fact;
  forgetFact(input: ForgetFactInput): Fact;

  createProposal(input: CreateProposalInput): Proposal;
  getProposal(proposalId: string): Proposal | undefined;
  listProposals(options?: ProposalListOptions): Proposal[];
  listPendingProposalsForSources(sourceIds: readonly string[]): Proposal[];
  updateProposal(input: UpdateProposalInput): Proposal;
  deleteProposal(input: DeleteProposalInput): Proposal;
  resolveProposal(input: ResolveProposalInput): ResolveProposalResult;

  listMutations(options?: MutationListOptions): Mutation[];

  createJob(input: CreateJobInput): Job;
  getJob(jobId: string): Job | undefined;
  listJobs(options?: JobListOptions): Job[];
  rescheduleQueuedJobs(input: RescheduleQueuedJobsInput): number;
  cancelSessionJobs(input: CancelSessionJobsInput): number;
  updateJob(input: UpdateJobInput): Job;

  enqueueProposedNotification(proposal: Proposal, idempotencyKey?: string): Job;
}

export interface IdempotentWriteOptions {
  readonly idempotencyKey?: string;
}

export interface UpdateSettingsInput extends IdempotentWriteOptions {
  readonly expectedVersion: number;
  readonly enabled?: boolean;
  readonly autoPropose?: boolean;
  readonly autoCommit?: boolean;
  readonly injectionEnabled?: boolean;
  readonly reviewMode?: MemoryReviewMode;
}

export interface CreateSourceInput extends IdempotentWriteOptions {
  readonly sourceId?: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly branchId?: string;
  readonly eventIds?: readonly string[];
  readonly startSequence?: number;
  readonly endSequence?: number;
  readonly digest: string;
  /** 可选统一溯源 overlay，校验失败时静默降级（不阻断 source 创建）。 */
  readonly evidenceRef?: EvidenceRef;
}

export interface UpdateSourceAvailabilityInput extends IdempotentWriteOptions {
  readonly sourceId: string;
  readonly expectedVersion: number;
  readonly availability: SourceAvailability;
  readonly invalidationCode?: string;
}

export interface CreateFactInput extends IdempotentWriteOptions {
  readonly factId?: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  readonly confidence?: number;
  readonly sourceId?: string;
  readonly state?: Exclude<FactState, "forgotten">;
  readonly pinned?: boolean;
  readonly expiresAt?: string;
  readonly lastUsedAt?: string;
}

export interface UpdateFactInput extends IdempotentWriteOptions {
  readonly factId: string;
  readonly expectedVersion: number;
  readonly kind?: MemoryKind;
  readonly title?: string;
  readonly content?: string;
  readonly confidence?: number;
  readonly sourceId?: string | null;
  readonly state?: Exclude<FactState, "forgotten">;
  readonly pinned?: boolean;
  readonly expiresAt?: string | null;
  readonly lastUsedAt?: string | null;
}

export interface ForgetFactInput extends IdempotentWriteOptions {
  readonly factId: string;
  readonly expectedVersion: number;
}

export interface FactListOptions {
  readonly states?: readonly FactState[];
  readonly kinds?: readonly MemoryKind[];
  readonly limit?: number;
}

export interface CreateProposalInput extends IdempotentWriteOptions {
  readonly proposalId?: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  readonly reason: string;
  readonly confidence?: number;
  readonly sourceId?: string;
  readonly conflictStatus?: ProposalConflictStatus;
  readonly conflictFactId?: string;
}

export interface UpdateProposalInput extends IdempotentWriteOptions {
  readonly proposalId: string;
  readonly expectedVersion: number;
  readonly kind?: MemoryKind;
  readonly title?: string;
  readonly content?: string;
  readonly reason?: string;
  readonly confidence?: number;
  readonly sourceId?: string | null;
  readonly conflictStatus?: ProposalConflictStatus;
  readonly conflictFactId?: string | null;
}

export interface DeleteProposalInput extends IdempotentWriteOptions {
  readonly proposalId: string;
  readonly expectedVersion: number;
}

export interface ResolveProposalInput extends IdempotentWriteOptions {
  readonly proposalId: string;
  readonly expectedVersion: number;
  readonly resolution: "accepted" | "rejected";
  readonly factId?: string;
  readonly patch?: {
    readonly kind?: MemoryKind;
    readonly title?: string;
    readonly content?: string;
    readonly reason?: string;
    readonly confidence?: number;
  };
}

export interface ResolveProposalResult {
  readonly proposal: Proposal;
  readonly fact?: Fact;
}

export interface ProposalListOptions {
  readonly statuses?: readonly ProposalStatus[];
  readonly limit?: number;
}

export interface SessionSourceListOptions {
  readonly availability?: SourceAvailability;
  readonly afterSequence?: number;
  readonly afterSourceId?: string;
  readonly limit?: number;
}

export interface MutationListOptions {
  readonly afterSequence?: number;
  readonly entityType?: MutationEntityType;
  readonly entityId?: string;
  readonly limit?: number;
}

export interface CreateJobInput extends IdempotentWriteOptions {
  readonly jobId?: string;
  readonly type: string;
  readonly terminalEventId: string;
  readonly extractorVersion: string;
  readonly cursor: MemoryJobCursor;
  readonly sourceId?: string;
  readonly maxAttempts?: number;
  readonly nextAttemptAt?: string;
}

export interface UpdateJobInput extends IdempotentWriteOptions {
  readonly jobId: string;
  readonly expectedVersion: number;
  readonly status?: MemoryJobStatus;
  readonly sourceId?: string | null;
  readonly attemptCount?: number;
  readonly maxAttempts?: number;
  readonly nextAttemptAt?: string | null;
  readonly errorCode?: string | null;
  readonly modelCalls?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

export interface JobListOptions {
  readonly statuses?: readonly MemoryJobStatus[];
  readonly type?: string;
  readonly extractorVersion?: string;
  /** 点查某个 terminal 事件的 Job((terminalEventId, extractorVersion) 幂等身份)。 */
  readonly terminalEventId?: string;
  /** Only return jobs whose retry delay has elapsed (or which have no delay). */
  readonly readyAt?: string;
  /** Exclude jobs which have already consumed their configured attempt budget. */
  readonly attemptsRemaining?: true;
  /** Restrict to jobs carrying actual model-call usage, including zero-call batch shares. */
  readonly withModelUsage?: true;
  readonly order?: "newest" | "oldest";
  readonly limit?: number;
}

export interface RescheduleQueuedJobsInput {
  readonly type: string;
  readonly extractorVersion: string;
  readonly requestedAt: string;
  readonly maxWaitMs: number;
  readonly idempotencyKeyPrefix: string;
}

export interface CancelSessionJobsInput {
  readonly sessionId: string;
  readonly type: string;
  readonly extractorVersion: string;
  readonly afterSequence?: number;
  readonly errorCode: string;
  readonly idempotencyKeyPrefix: string;
}

export class MemoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryConflictError";
  }
}

export class MemoryNotFoundError extends Error {
  constructor(
    readonly entityType: string,
    readonly entityId: string,
  ) {
    super(`Unknown memory ${entityType}: ${entityId}`);
    this.name = "MemoryNotFoundError";
  }
}

export class MemoryIdempotencyConflictError extends MemoryConflictError {
  constructor(operation: string) {
    super(`Memory ${operation} idempotency key was used for another request`);
    this.name = "MemoryIdempotencyConflictError";
  }
}

export class MemoryAsyncTransactionError extends TypeError {
  constructor() {
    super("MemoryRepository.transaction callback must return synchronously");
    this.name = "MemoryAsyncTransactionError";
  }
}

export class MemoryFileCleanupError extends FileStorageIntegrityError {
  constructor(path: string, cause: unknown) {
    super(`Failed to clean stale memory temporary file ${path}: ${errorMessage(cause)}`);
    this.name = "MemoryFileCleanupError";
  }
}

export class MemoryPlaintextVerificationError extends FileStorageIntegrityError {
  constructor(path: string, cause?: unknown) {
    super(
      cause === undefined
        ? `Deleted memory text remains in live file ${path}`
        : `Failed to verify deleted memory text in ${path}: ${errorMessage(cause)}`,
    );
    this.name = "MemoryPlaintextVerificationError";
  }
}

