export const TASK_RUN_FILE_SCHEMA_VERSION = 1 as const;
export const TASK_RUN_EVENT_SCHEMA_VERSION = 1 as const;
export const RECOVERABLE_TASK_LAUNCH_RECEIPT_SCHEMA_VERSION = 1 as const;

export const TASK_RUN_TERMINAL_STATUSES = ["succeeded", "failed", "cancelled"] as const;
export type TaskRunTerminalStatus = (typeof TASK_RUN_TERMINAL_STATUSES)[number];

export const TASK_ATTEMPT_TERMINAL_STATUSES = [
  ...TASK_RUN_TERMINAL_STATUSES,
  "interrupted",
] as const;
export type TaskAttemptTerminalStatus = (typeof TASK_ATTEMPT_TERMINAL_STATUSES)[number];

export const TASK_RESUME_PARK_REASONS = [
  "adapter_missing",
  "adapter_version_mismatch",
  "task_terminal",
  "source_attempt_missing",
  "source_attempt_not_interrupted",
  "resume_already_claimed",
  "max_attempts_exhausted",
  "storage_root_mismatch",
  "workspace_path_mismatch",
  "runtime_session_missing",
  "runtime_run_missing",
  "runtime_high_water_mismatch",
  "runtime_terminal_missing",
  "pending_tool_effect",
  "pending_approval",
  "background_operation_pending",
  "tool_catalog_mismatch",
  "checkpoint_unavailable",
  "ledger_corrupt",
] as const;
export type TaskResumeParkReason = (typeof TASK_RESUME_PARK_REASONS)[number];

export interface RecoverableTaskAdapterIdentity {
  readonly id: string;
  readonly version: number;
  readonly input: Readonly<Record<string, unknown>>;
  readonly inputHash: string;
}

export interface TaskRuntimeBoundary {
  readonly sessionId: string;
  readonly runId: string;
  readonly eventHighWater: number;
  readonly terminalEventId?: string;
}

/**
 * Body-free durable identity for one idempotent Runtime launch.
 *
 * `runStartedSequence` is the canonical Session sequence of `runStartedEventId`.
 * The stable `launchId` binds adapter reconciliation to one launch request.
 */
export interface RecoverableTaskLaunchReceipt {
  readonly schemaVersion: typeof RECOVERABLE_TASK_LAUNCH_RECEIPT_SCHEMA_VERSION;
  readonly launchId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly runStartedEventId: string;
  readonly runStartedSequence: number;
}

export interface TaskSafeBoundary {
  readonly storageRootId: string;
  readonly workspacePath: string;
  readonly backgroundOperationsSettled: boolean;
  readonly runtime?: TaskRuntimeBoundary;
  readonly toolCatalogHash?: string;
  readonly checkpointRef?: string;
}

export interface TaskRunFileHeader {
  readonly type: "task-run";
  readonly schemaVersion: typeof TASK_RUN_FILE_SCHEMA_VERSION;
  readonly taskRunId: string;
  readonly workDir: string;
  readonly storageRootId: string;
  readonly adapter: RecoverableTaskAdapterIdentity;
  readonly maxAttempts: number;
  readonly createdAt: string;
}

interface TaskRunEventBase {
  readonly schemaVersion: typeof TASK_RUN_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly taskRunId: string;
  readonly at: string;
}

export interface TaskAttemptStartedEvent extends TaskRunEventBase {
  readonly kind: "attempt.started";
  readonly data: {
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly sourceAttemptId?: string;
  };
}

export interface TaskAttemptExecutionClaimedEvent extends TaskRunEventBase {
  readonly kind: "attempt.execution.claimed";
  readonly data: {
    readonly attemptId: string;
    readonly ownerId: string;
    readonly leaseEpoch: number;
    readonly expiresAt: string;
  };
}

export interface TaskAttemptExecutionRenewedEvent extends TaskRunEventBase {
  readonly kind: "attempt.execution.renewed";
  readonly data: {
    readonly attemptId: string;
    readonly ownerId: string;
    readonly leaseEpoch: number;
    readonly expiresAt: string;
  };
}

export interface TaskAttemptExecutionReleasedEvent extends TaskRunEventBase {
  readonly kind: "attempt.execution.released";
  readonly data: {
    readonly attemptId: string;
    readonly ownerId: string;
    readonly leaseEpoch: number;
  };
}

export interface TaskAttemptCheckpointedEvent extends TaskRunEventBase {
  readonly kind: "attempt.checkpointed";
  readonly data: {
    readonly attemptId: string;
    readonly ownerId: string;
    readonly leaseEpoch: number;
    readonly boundary: TaskSafeBoundary;
  };
}

export interface TaskAttemptFinishedEvent extends TaskRunEventBase {
  readonly kind: "attempt.finished";
  readonly data: {
    readonly attemptId: string;
    readonly ownerId: string;
    readonly leaseEpoch: number;
    readonly status: TaskAttemptTerminalStatus;
    readonly result?: Readonly<Record<string, unknown>>;
    readonly error?: string;
  };
}

export interface TaskResumeClaimedEvent extends TaskRunEventBase {
  readonly kind: "task.resume.claimed";
  readonly data: {
    readonly claimId: string;
    readonly sourceAttemptId: string;
    readonly successorAttemptId: string;
    readonly ownerId: string;
    readonly leaseEpoch: number;
  };
}

export interface TaskAttemptLaunchClaimedEvent extends TaskRunEventBase {
  readonly kind: "attempt.launch.claimed";
  readonly data: {
    readonly attemptId: string;
    readonly launchId: string;
    readonly ownerId: string;
    readonly leaseEpoch: number;
    readonly expiresAt: string;
  };
}

export interface TaskAttemptLaunchSucceededEvent extends TaskRunEventBase {
  readonly kind: "attempt.launch.succeeded";
  readonly data: {
    readonly attemptId: string;
    readonly launchId: string;
    readonly ownerId: string;
    readonly leaseEpoch: number;
    readonly receipt: RecoverableTaskLaunchReceipt;
  };
}

export interface TaskAttemptLaunchFailedEvent extends TaskRunEventBase {
  readonly kind: "attempt.launch.failed";
  readonly data: {
    readonly attemptId: string;
    readonly launchId: string;
    readonly ownerId: string;
    readonly leaseEpoch: number;
    readonly error: string;
  };
}

export interface TaskRunParkedEvent extends TaskRunEventBase {
  readonly kind: "task.parked";
  readonly data: {
    readonly sourceAttemptId?: string;
    readonly reasons: readonly TaskResumeParkReason[];
    readonly diagnostics?: readonly string[];
  };
}

export interface TaskRunFinishedEvent extends TaskRunEventBase {
  readonly kind: "task.finished";
  readonly data: {
    readonly status: TaskRunTerminalStatus;
    readonly attemptId?: string;
    readonly result?: Readonly<Record<string, unknown>>;
    readonly error?: string;
  };
}

export type TaskRunEvent =
  | TaskAttemptStartedEvent
  | TaskAttemptExecutionClaimedEvent
  | TaskAttemptExecutionRenewedEvent
  | TaskAttemptExecutionReleasedEvent
  | TaskAttemptCheckpointedEvent
  | TaskAttemptFinishedEvent
  | TaskResumeClaimedEvent
  | TaskAttemptLaunchClaimedEvent
  | TaskAttemptLaunchSucceededEvent
  | TaskAttemptLaunchFailedEvent
  | TaskRunParkedEvent
  | TaskRunFinishedEvent;

export interface TaskRunEventEntry {
  readonly sequence: number;
  readonly committedAt: string;
  readonly event: TaskRunEvent;
}

export interface TaskRunEventBatch {
  readonly type: "task-event-batch";
  readonly schemaVersion: typeof TASK_RUN_FILE_SCHEMA_VERSION;
  readonly txId: string;
  readonly entries: readonly TaskRunEventEntry[];
}

export interface TaskAttemptProjection {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly execution: TaskAttemptExecutionProjection;
  readonly sourceAttemptId?: string;
  readonly status: "running" | TaskAttemptTerminalStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly boundary?: TaskSafeBoundary;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: string;
  readonly launch?: TaskAttemptLaunchProjection;
}

export interface TaskAttemptExecutionProjection {
  readonly ownerId: string;
  readonly leaseEpoch: number;
  readonly claimedAt: string;
  readonly expiresAt: string;
  readonly renewedAt?: string;
  readonly releasedAt?: string;
}

export interface TaskAttemptLaunchProjection {
  readonly launchId: string;
  readonly status: "claimed" | "succeeded" | "failed";
  readonly ownerId: string;
  readonly leaseEpoch: number;
  /** Execution lease epoch that admitted this launch lease. */
  readonly executionLeaseEpoch: number;
  readonly claimedAt: string;
  readonly expiresAt: string;
  readonly settledAt?: string;
  readonly receipt?: RecoverableTaskLaunchReceipt;
  readonly error?: string;
}

export interface TaskRunProjection {
  readonly header: TaskRunFileHeader;
  readonly revision: number;
  readonly lastTransactionId?: string;
  readonly status: "queued" | "running" | "parked" | TaskRunTerminalStatus;
  readonly attempts: readonly TaskAttemptProjection[];
  readonly parkReasons: readonly TaskResumeParkReason[];
  readonly parkDiagnostics: readonly string[];
  readonly terminal?: TaskRunFinishedEvent["data"];
}

export interface TaskResumeDiagnostic {
  readonly reason: TaskResumeParkReason;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export type TaskResumePlan =
  | {
      readonly disposition: "continue";
      readonly taskRunId: string;
      readonly sourceAttemptId: string;
      readonly boundary: TaskSafeBoundary;
    }
  | {
      readonly disposition: "park";
      readonly taskRunId: string;
      readonly reasons: readonly TaskResumeParkReason[];
      readonly diagnostics: readonly TaskResumeDiagnostic[];
    };
