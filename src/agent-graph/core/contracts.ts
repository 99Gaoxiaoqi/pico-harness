export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type AgentGraphAdmissionPhase = "open" | "sealed";

export interface AgentGraph {
  readonly graphId: string;
  readonly rootSessionId: string;
  readonly epoch: number;
  readonly admissionPhase: AgentGraphAdmissionPhase;
  readonly headRevision: number;
  readonly selectedRecordIds: readonly string[];
  readonly createdAt: number;
  readonly sealedAt?: number;
}

export interface AgentGraphOperationSource {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly toolCallId: string;
}

export interface AgentGraphProfileSnapshot {
  readonly profileId: string;
  readonly model?: string;
  readonly tools: readonly string[];
  readonly permissionPolicy: JsonValue;
  readonly systemPromptVersion: string;
}

export type AgentGraphWorkspacePolicy =
  | { readonly kind: "shared" }
  | { readonly kind: "isolated-worktree"; readonly baseRef?: string };

export interface AgentGraphOperator {
  readonly graphId: string;
  readonly operatorId: string;
  readonly generation: number;
  readonly role: string;
  readonly description?: string;
  readonly profileSnapshot: AgentGraphProfileSnapshot;
  readonly workspacePolicy: AgentGraphWorkspacePolicy;
}

export interface AgentGraphInputRef {
  readonly recordId: string;
}

export interface AgentGraphActivationIntent {
  readonly graphId: string;
  readonly intentId: string;
  readonly operatorId: string;
  readonly operatorGeneration: number;
  readonly instruction: string;
  readonly inputRefs: readonly AgentGraphInputRef[];
  readonly createdAtRevision: number;
  readonly requestedBy: AgentGraphOperationSource;
}

export interface AgentGraphAddCommand {
  readonly kind: "add";
  readonly operator: AgentGraphOperator;
  readonly intent: AgentGraphActivationIntent;
}

export type AgentGraphStopTarget =
  | { readonly kind: "intent"; readonly intentId: string }
  | {
      readonly kind: "operator";
      readonly operatorId: string;
      readonly generation: number;
    };

export interface AgentGraphStopCommand {
  readonly kind: "stop";
  readonly target: AgentGraphStopTarget;
  readonly reason?: string;
}

export interface AgentGraphFinishCommand {
  readonly kind: "finish";
  readonly selectedRecordIds?: readonly string[];
}

export type AgentGraphScheduleCommand =
  | AgentGraphAddCommand
  | AgentGraphStopCommand
  | AgentGraphFinishCommand;

export interface AgentGraphScheduleRevision {
  readonly graphId: string;
  readonly revision: number;
  readonly expectedPreviousRevision: number;
  readonly operationId: string;
  readonly fingerprint: string;
  readonly source: AgentGraphOperationSource;
  readonly commands: readonly AgentGraphScheduleCommand[];
  readonly createdAt: number;
}

export interface AppliedAgentGraphOperation {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly revision: number;
}

export interface AgentGraphScheduleState {
  readonly graph: AgentGraph;
  readonly operators: readonly AgentGraphOperator[];
  readonly intents: readonly AgentGraphActivationIntent[];
  readonly stops: readonly AgentGraphStopCommand[];
  readonly revisions: readonly AgentGraphScheduleRevision[];
  readonly operations: readonly AppliedAgentGraphOperation[];
}

export type AgentGraphProvisionState = "requested" | "provisioned" | "stopping" | "stopped";

export interface AgentGraphOperatorProvision {
  readonly provisionId: string;
  readonly graphId: string;
  readonly operatorId: string;
  readonly operatorGeneration: number;
  readonly childSessionId: string;
  readonly state: AgentGraphProvisionState;
  /** CAS version owned by the Graph control store. */
  readonly version: number;
  readonly profileSnapshot: AgentGraphProfileSnapshot;
  readonly workspaceBinding: JsonValue;
  readonly createdAt: number;
  readonly provisionedAt?: number;
  readonly stoppedAt?: number;
}

export type AgentGraphClaimState = "claimed" | "executing" | "cancelled";

export interface AgentGraphActivationClaim {
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
  readonly claimedAt: number;
  readonly executingAt?: number;
  readonly cancelledAt?: number;
  readonly cancellationReason?: string;
}

export type AgentGraphRecordKind = "agent-output" | "artifact" | "evidence";

/** A reference to execution truth. Content remains in the Runtime ledger or artifact store. */
export interface AgentGraphRecordRef {
  readonly recordId: string;
  readonly graphId: string;
  readonly operatorId: string;
  readonly operatorGeneration: number;
  readonly activationClaimId: string;
  readonly sourceSessionId: string;
  readonly sourceTurnId: string;
  readonly sourceRunId: string;
  readonly sourceEventId: string;
  readonly kind: AgentGraphRecordKind;
}

export type AgentGraphWakeCause =
  | "schedule-updated"
  | "runtime-terminal"
  | "startup-recovery"
  | "retry";

export type AgentGraphWakeState =
  | "pending"
  | "running"
  | "delivered"
  | "waiting-permission"
  | "retryable-failed";

export interface AgentGraphSupervisorWake {
  readonly wakeId: string;
  readonly graphId: string;
  readonly dedupeKey: string;
  readonly cause: AgentGraphWakeCause;
  readonly state: AgentGraphWakeState;
  readonly availableAt: number;
  readonly attemptCount: number;
  readonly createdAt: number;
  readonly deliveredAt?: number;
}

export type AgentGraphWakeAttemptState = "running" | "completed" | "failed";

export interface AgentGraphSupervisorWakeAttempt {
  readonly attemptId: string;
  readonly wakeId: string;
  readonly rootSessionId: string;
  readonly targetTurnId: string;
  readonly targetRunId: string;
  readonly state: AgentGraphWakeAttemptState;
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly error?: string;
}

export type AgentGraphYieldInterestState = "registered" | "consumed" | "cancelled";

export interface AgentGraphYieldInterest {
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
