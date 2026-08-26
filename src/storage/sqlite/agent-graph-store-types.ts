export type AgentGraphPhase = "open" | "finished";
export type AgentGraphScheduleKind = "add" | "stop" | "finish";
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
  | "retryable_failed";
export type AgentGraphWakeAttemptStatus = "running" | "completed" | "waiting_permission" | "failed";

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
  readonly createdAt: number;
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
    "delivered" | "waiting_permission" | "retryable_failed"
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
