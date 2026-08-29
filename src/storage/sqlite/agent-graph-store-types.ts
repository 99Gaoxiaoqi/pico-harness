export type AgentGraphPhase = "open" | "finished";
export type AgentGraphScheduleKind = "add" | "stop" | "finish" | "batch";
export type AgentGraphProvisionState = "requested" | "provisioned" | "stopping" | "stopped";
export type AgentGraphClaimState = "claimed" | "executing" | "cancelled";
export type AgentGraphRecordKind = "agent_output" | "artifact" | "evidence";
export type AgentGraphWakeCause =
  | "schedule_updated"
  | "runtime_terminal"
  | "startup_recovery"
  | "retry";
export type AgentGraphWakeStatus =
  | "pending"
  | "running"
  | "delivered"
  | "waiting_permission"
  | "retryable_failed"
  | "needs_attention";
export type AgentGraphWakeAttemptStatus = "running" | "completed" | "waiting_permission" | "failed";
export type AgentGraphYieldInterestState = "registered" | "consumed" | "cancelled";

export interface AgentGraphRecord {
  readonly graphId: string;
  readonly rootSessionId: string;
  readonly epoch: number;
  readonly phase: AgentGraphPhase;
  readonly headRevision: number;
  readonly createdAt: number;
  readonly finishedAt?: number;
}

export interface CreateAgentGraphInput {
  readonly graphId: string;
  readonly rootSessionId: string;
  readonly epoch: number;
}

export interface AgentGraphScheduleRevisionRecord {
  readonly graphId: string;
  readonly revision: number;
  readonly operationId: string;
  readonly requestFingerprint: string;
  readonly kind: AgentGraphScheduleKind;
  readonly command: unknown;
  readonly sourceSessionId: string;
  readonly sourceTurnId: string;
  readonly sourceRunId: string;
  readonly sourceToolCallId: string;
  readonly createdAt: number;
}

export interface CommitAgentGraphScheduleInput {
  readonly graphId: string;
  readonly expectedRevision: number;
  readonly operationId: string;
  readonly requestFingerprint: string;
  readonly kind: AgentGraphScheduleKind;
  readonly command: unknown;
  readonly sourceSessionId: string;
  readonly sourceTurnId: string;
  readonly sourceRunId: string;
  readonly sourceToolCallId: string;
}

export interface CommitAgentGraphScheduleResult {
  readonly revision: AgentGraphScheduleRevisionRecord;
  readonly graph: AgentGraphRecord;
  readonly replayed: boolean;
}

export interface AgentGraphOperatorProvisionRecord {
  readonly provisionId: string;
  readonly graphId: string;
  readonly operatorId: string;
  readonly generation: number;
  readonly scheduleRevision: number;
  readonly provisionFingerprint: string;
  readonly childSessionId: string;
  readonly profileSnapshot: unknown;
  readonly workspaceBinding: unknown;
  readonly state: AgentGraphProvisionState;
  readonly version: number;
  readonly createdAt: number;
  readonly provisionedAt?: number;
  readonly stoppedAt?: number;
}

export interface EnsureAgentGraphOperatorProvisionInput {
  readonly provisionId: string;
  readonly graphId: string;
  readonly operatorId: string;
  readonly generation: number;
  readonly scheduleRevision: number;
  readonly provisionFingerprint: string;
  readonly childSessionId: string;
  readonly profileSnapshot: unknown;
  readonly workspaceBinding: unknown;
}

export interface TransitionAgentGraphProvisionInput {
  readonly provisionId: string;
  readonly expectedVersion: number;
  readonly from: AgentGraphProvisionState;
  readonly to: Extract<AgentGraphProvisionState, "provisioned" | "stopping" | "stopped">;
}

export interface AgentGraphActivationClaimRecord {
  readonly claimId: string;
  readonly graphId: string;
  readonly intentId: string;
  readonly operatorId: string;
  readonly operatorGeneration: number;
  readonly scheduleRevision: number;
  readonly intentFingerprint: string;
  readonly readinessFingerprint: string;
  readonly state: AgentGraphClaimState;
  readonly targetSessionId: string;
  readonly targetTurnId: string;
  readonly targetRunId: string;
  readonly targetInvocationId: string;
  readonly runStartedEventId: string;
  readonly version: number;
  readonly claimedAt: number;
  readonly executingAt?: number;
  readonly cancelledAt?: number;
  readonly cancellationReason?: string;
}

export interface ClaimAgentGraphActivationInput {
  readonly claimId: string;
  readonly graphId: string;
  readonly intentId: string;
  readonly operatorId: string;
  readonly operatorGeneration: number;
  readonly expectedGraphRevision: number;
  readonly intentFingerprint: string;
  readonly readinessFingerprint: string;
  readonly targetSessionId: string;
  readonly targetTurnId: string;
  readonly targetRunId: string;
  readonly targetInvocationId: string;
  readonly runStartedEventId: string;
}

export interface TransitionAgentGraphClaimInput {
  readonly claimId: string;
  readonly expectedVersion: number;
  readonly from: AgentGraphClaimState;
  readonly to: Extract<AgentGraphClaimState, "executing" | "cancelled">;
  readonly cancellationReason?: string;
}

export interface AgentGraphRecordRefRecord {
  readonly recordId: string;
  readonly graphId: string;
  readonly claimId: string;
  readonly operatorId: string;
  readonly operatorGeneration: number;
  readonly recordFingerprint: string;
  readonly sourceSessionId: string;
  readonly sourceTurnId: string;
  readonly sourceRunId: string;
  readonly sourceEventId: string;
  readonly kind: AgentGraphRecordKind;
  readonly createdAt: number;
}

export interface PutAgentGraphRecordRefInput {
  readonly recordId: string;
  readonly graphId: string;
  readonly claimId: string;
  readonly operatorId: string;
  readonly operatorGeneration: number;
  readonly recordFingerprint: string;
  readonly sourceSessionId: string;
  readonly sourceTurnId: string;
  readonly sourceRunId: string;
  readonly sourceEventId: string;
  readonly kind: AgentGraphRecordKind;
}

export type AgentGraphResourceKind = "artifact" | "evidence";

export interface AgentGraphResourceRefRecord {
  readonly resourceId: string;
  readonly graphId: string;
  readonly claimId: string;
  readonly kind: AgentGraphResourceKind;
  readonly sourceRef: string;
  readonly sourceSessionId: string;
  readonly sourceResourceId: string;
  readonly contentDigest: string;
  readonly contentBytes: number;
  readonly mediaType?: string;
  readonly title?: string;
  readonly metadata: unknown;
  readonly createdAt: number;
}

export interface PutAgentGraphResourceRefInput {
  readonly resourceId: string;
  readonly graphId: string;
  readonly claimId: string;
  readonly kind: AgentGraphResourceKind;
  readonly sourceRef: string;
  readonly sourceSessionId: string;
  readonly sourceResourceId: string;
  readonly contentDigest: string;
  readonly contentBytes: number;
  readonly mediaType?: string;
  readonly title?: string;
  readonly metadata: unknown;
}

export type AgentGraphWorkspaceResourceState = "requested" | "active" | "retained" | "cleaned";

export interface AgentGraphWorkspaceResourceRecord {
  readonly resourceId: string;
  readonly graphId: string;
  readonly provisionId: string;
  readonly childSessionId: string;
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly state: AgentGraphWorkspaceResourceState;
  readonly version: number;
  readonly retainReason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly retainedAt?: number;
  readonly cleanedAt?: number;
}

export interface EnsureAgentGraphWorkspaceResourceInput {
  readonly resourceId: string;
  readonly graphId: string;
  readonly provisionId: string;
  readonly childSessionId: string;
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseCommit: string;
}

export interface TransitionAgentGraphWorkspaceResourceInput {
  readonly resourceId: string;
  readonly expectedVersion: number;
  readonly from: AgentGraphWorkspaceResourceState;
  readonly to: Extract<AgentGraphWorkspaceResourceState, "active" | "retained" | "cleaned">;
  readonly baseCommit?: string;
  readonly retainReason?: string;
}

export interface AgentGraphSupervisorWakeRecord {
  readonly wakeId: string;
  readonly graphId: string;
  readonly dedupeKey: string;
  readonly wakeFingerprint: string;
  readonly cause: AgentGraphWakeCause;
  readonly payload: unknown;
  readonly status: AgentGraphWakeStatus;
  readonly availableAt: number;
  readonly attemptCount: number;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deliveredAt?: number;
  readonly lastError?: string;
  readonly yieldPermitId?: string;
  readonly attentionVersion?: number;
  readonly needsAttentionAt?: number;
  readonly attentionResolvedAt?: number;
  readonly lastRetryOperationId?: string;
}

export type AgentGraphDiagnosticPhase =
  | "load"
  | "stop"
  | "provision"
  | "resolve-inputs"
  | "claim"
  | "begin-executing"
  | "project-record";
export type AgentGraphDiagnosticClassification = "transient" | "configuration" | "integrity";
export type AgentGraphDiagnosticState = "retry_scheduled" | "needs_attention" | "resolved";

export interface AgentGraphDiagnosticRecord {
  readonly diagnosticId: string;
  readonly graphId: string;
  readonly phase: AgentGraphDiagnosticPhase;
  readonly subjectId: string;
  readonly classification: AgentGraphDiagnosticClassification;
  readonly state: AgentGraphDiagnosticState;
  readonly message: string;
  readonly attemptCount: number;
  readonly lastObservationId: string;
  readonly nextRetryAt?: number;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly resolvedAt?: number;
}

export interface RecordAgentGraphDiagnosticInput {
  readonly diagnosticId: string;
  readonly graphId: string;
  readonly phase: AgentGraphDiagnosticPhase;
  readonly subjectId: string;
  readonly classification: AgentGraphDiagnosticClassification;
  readonly message: string;
  readonly observationId: string;
  readonly retryDelayMs?: number;
}

export interface RetryAgentGraphSupervisorWakeInput {
  readonly wakeId: string;
  readonly retryOperationId: string;
  readonly expectedWakeVersion: number;
  readonly expectedAttentionVersion: number;
}

export interface AgentGraphYieldInterestRecord {
  readonly permitId: string;
  readonly graphId: string;
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly rootRunId: string;
  readonly toolCallId: string;
  readonly state: AgentGraphYieldInterestState;
  readonly version: number;
  readonly createdAt: number;
  readonly resolvedAt?: number;
}

export interface RegisterAgentGraphYieldInterestInput {
  readonly permitId: string;
  readonly graphId: string;
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly rootRunId: string;
  readonly toolCallId: string;
}

export interface CancelAgentGraphYieldInterestInput {
  readonly permitId: string;
  readonly expectedVersion: number;
}

export interface EnqueueAgentGraphSupervisorWakeInput {
  readonly wakeId: string;
  readonly graphId: string;
  readonly dedupeKey: string;
  readonly wakeFingerprint: string;
  readonly cause: AgentGraphWakeCause;
  readonly payload: unknown;
  readonly availableAt?: number;
}

export type EnqueueAgentGraphSupervisorWakeForYieldResult =
  | { readonly status: "not_waiting" }
  | {
      readonly status: "enqueued";
      readonly wake: AgentGraphSupervisorWakeRecord;
      readonly interest: AgentGraphYieldInterestRecord;
      readonly replayed: boolean;
    };

export interface AgentGraphSupervisorWakeAttemptRecord {
  readonly attemptId: string;
  readonly wakeId: string;
  readonly attemptNumber: number;
  readonly rootSessionId: string;
  readonly targetTurnId: string;
  readonly targetRunId: string;
  readonly status: AgentGraphWakeAttemptStatus;
  readonly version: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly finishedAt?: number;
  readonly error?: string;
}

export interface RecoverableAgentGraphSupervisorWakeRecord {
  readonly graph: AgentGraphRecord;
  readonly wake: AgentGraphSupervisorWakeRecord;
  readonly attempt?: AgentGraphSupervisorWakeAttemptRecord;
}

export interface ClaimAgentGraphSupervisorWakeInput {
  readonly wakeId: string;
  readonly expectedWakeVersion: number;
  readonly attemptId: string;
  readonly rootSessionId: string;
  readonly targetTurnId: string;
  readonly targetRunId: string;
}

export interface SettleAgentGraphSupervisorWakeInput {
  readonly wakeId: string;
  readonly attemptId: string;
  readonly expectedWakeVersion: number;
  readonly expectedAttemptVersion: number;
  readonly outcome: Extract<
    AgentGraphWakeStatus,
    "delivered" | "waiting_permission" | "retryable_failed" | "needs_attention"
  >;
  readonly error?: string;
  readonly retryAt?: number;
}

export interface IdempotentStoreResult<T> {
  readonly record: T;
  readonly replayed: boolean;
}

export interface ClaimAgentGraphSupervisorWakeResult {
  readonly wake: AgentGraphSupervisorWakeRecord;
  readonly attempt: AgentGraphSupervisorWakeAttemptRecord;
  readonly replayed: boolean;
}

export interface SettleAgentGraphSupervisorWakeResult {
  readonly wake: AgentGraphSupervisorWakeRecord;
  readonly attempt: AgentGraphSupervisorWakeAttemptRecord;
  readonly replayed: boolean;
}
