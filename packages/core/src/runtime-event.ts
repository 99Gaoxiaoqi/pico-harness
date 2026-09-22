import type { ProviderPhysicalAttempt } from "./provider-interface.js";
import type { Message, Usage } from "./message.js";
import type {
  PlanGraphBinding,
  PlanOperationFact,
  PlanProposal,
  PlanReviewedBy,
  PlanReviewAction,
  PlanStepStatus,
} from "./plan-contract.js";
import type {
  SessionRuntimeStateVersion,
  SessionRuntimeStateWritePatch,
} from "./session-runtime-state.js";
import type { ToolRecoveryMode } from "./tool-recovery-contract.js";
import type {
  RuntimeEvidenceReference,
  RuntimeToolResultBody,
  RuntimeToolResultProjection,
  RuntimeToolResultStatus,
} from "./tool-result.js";

/** Durable Session event contract version. Runtime owns validation and storage adapters. */
export const RUNTIME_EVENT_SCHEMA_VERSION = 2 as const;

export type RuntimeEventVisibility = "model" | "transcript" | "internal";
export type RuntimeTerminalStatus = "completed" | "failed" | "cancelled" | "interrupted";

export interface RuntimePresentationProvenance {
  readonly audience: "internal";
  readonly source: "agent_graph_control";
}

export interface RuntimeEventRefs {
  readonly stepId?: string;
  readonly toolCallId?: string;
  readonly parentRunId?: string;
  readonly parentToolCallId?: string;
  readonly providerCallId?: string;
  readonly evidence?: RuntimeEvidenceReference;
}

export interface RuntimeEventBase {
  readonly schemaVersion: typeof RUNTIME_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly at: string;
  readonly partial: boolean;
  readonly visibility: RuntimeEventVisibility;
  readonly refs?: RuntimeEventRefs;
}

/** Stable continuation anchor for a run resumed from an interrupted prefix. */
export interface RuntimeRunContinuationOf {
  readonly runId: string;
  readonly highWater: number;
  readonly prefixDigest: string;
}

/** Trusted host decision frozen as part of every current Run admission. */
export type AgentSwarmAuthorizationSource = "none" | "session_mode" | "turn_override";

export interface RuntimeRunStartedEvent extends RuntimeEventBase {
  readonly kind: "run.started";
  readonly data: {
    readonly workDir: string;
    readonly agentSwarmAuthorization: AgentSwarmAuthorizationSource;
    /** Host-owned presentation identity; model/runtime facts remain durable. */
    readonly presentation?: RuntimePresentationProvenance;
    /** Present only on a continuation target. */
    readonly continuationOf?: RuntimeRunContinuationOf;
  };
}

export interface RuntimeMessageCommittedEvent extends RuntimeEventBase {
  readonly kind: "message.committed";
  readonly data: { readonly message: Message };
}

/** load_tools group activation is audited per turn and never implicitly inherited. */
export interface RuntimeToolGroupLoadedEvent extends RuntimeEventBase {
  readonly kind: "tool.group.loaded";
  readonly data: { readonly groupId: string; readonly toolNames: readonly string[] };
}

export interface RuntimeToolRecoveryResolvedEvent extends RuntimeEventBase {
  readonly kind: "tool.recovery.resolved";
  readonly data: {
    readonly recoveryEventId: string;
    readonly outcome: "effects_verified" | "not_dispatched_verified";
    readonly evidenceUri: string;
    readonly summary: string;
  };
}

export type RuntimeToolRecoveryClassification = "indeterminate" | "not_dispatched";

export interface RuntimeToolResultRecoveryMarker {
  readonly classification: RuntimeToolRecoveryClassification;
}

export interface RuntimeToolResultRecordedEvent extends RuntimeEventBase {
  readonly kind: "tool.result.recorded";
  readonly refs: RuntimeEventRefs & {
    readonly toolCallId: string;
    readonly evidence?: RuntimeEvidenceReference;
  };
  readonly data: {
    readonly origin?: "model" | "code_mode";
    readonly toolName: string;
    readonly status: RuntimeToolResultStatus;
    readonly body: RuntimeToolResultBody;
    readonly projection: RuntimeToolResultProjection;
    readonly recovery?: RuntimeToolResultRecoveryMarker;
  };
}

/** Durable change to model visibility; original tool result remains immutable. */
export interface RuntimeToolResultProjectionRecordedEvent extends RuntimeEventBase {
  readonly kind: "tool.result.projection.recorded";
  readonly refs: RuntimeEventRefs & { readonly toolCallId: string };
  readonly data: {
    readonly sourceEventId: string;
    readonly sourceProjectionSha256: string;
    readonly projection: RuntimeToolResultProjection;
    readonly reason:
      | "stale"
      | "active_large"
      | "exact_duplicate"
      | "newer_read_covers_range"
      | "newer_snapshot"
      | "failure_resolved";
    readonly supersededByToolCallId?: string;
  };
}

export type RuntimeAgentOutputStatus = "success" | "failure";

export interface RuntimeAgentOutputPayload {
  readonly schemaVersion: "pico.agent_output.v1";
  readonly graphId: string;
  readonly operatorId: string;
  readonly operatorGeneration: number;
  readonly activationId: string;
  readonly status: RuntimeAgentOutputStatus;
  readonly output: string;
  readonly outputBytes: number;
  readonly evidenceRefs: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

export interface RuntimeAgentOutputEvent extends RuntimeEventBase {
  readonly kind: "agent.output";
  readonly partial: false;
  readonly visibility: "internal";
  readonly refs: RuntimeEventRefs & { readonly toolCallId: string };
  readonly data: {
    readonly toolCallId: string;
    readonly idempotencyKey: string;
    readonly fingerprint: string;
    readonly payload: RuntimeAgentOutputPayload;
  };
}

export interface RuntimeApprovalRequestedEvent extends RuntimeEventBase {
  readonly kind: "approval.requested";
  readonly data: { readonly approvalId: string; readonly toolName: string };
}

export interface RuntimeApprovalSettledEvent extends RuntimeEventBase {
  readonly kind: "approval.settled";
  readonly data: { readonly approvalId: string; readonly decision: "approved" | "rejected" };
}

export interface RuntimeModelCallStartedEvent extends RuntimeEventBase {
  readonly kind: "model.call.started";
  readonly data: {
    readonly providerCallId: string;
    readonly logicalCallId?: string;
    readonly retryAttempt?: number;
    readonly provider?: string;
    readonly model?: string;
    readonly purpose: string;
  };
}

export interface RuntimeModelCallSettledEvent extends RuntimeEventBase {
  readonly kind: "model.call.settled";
  readonly data: {
    readonly providerCallId: string;
    readonly logicalCallId?: string;
    readonly retryAttempt?: number;
    /** Settled facts only: a crash before this event leaves the started call incomplete. */
    readonly attempts?: readonly ProviderPhysicalAttempt[];
    readonly attemptCoverage?: "complete" | "partial";
    readonly status: "succeeded" | "failed" | "cancelled";
    readonly latencyMs: number;
    readonly usage?: Usage;
    readonly costCNY?: number;
    readonly costStatus?: "estimated" | "included" | "unknown";
    readonly error?: string;
  };
}

export interface RuntimeCheckpointRecordedEventData {
  readonly checkpointId: string;
  readonly coveredEventCount: number;
  readonly sourceDigest: string;
  readonly throughEventId: string;
  readonly memoryExtractionBoundary?: {
    readonly runtimeEventId: string;
    readonly disposition: "eligible" | "policy_denied";
  };
  readonly summary: Message;
  readonly previousCheckpointId?: string;
}

export interface RuntimeCheckpointRecordedEvent extends RuntimeEventBase {
  readonly kind: "context.checkpoint.recorded";
  readonly data: RuntimeCheckpointRecordedEventData;
}

export interface RuntimeSessionForkedEvent extends RuntimeEventBase {
  readonly kind: "session.forked";
  readonly data: {
    readonly parentSessionId: string;
    readonly throughEventId?: string;
    readonly sourceDigest?: string;
    readonly messageCount?: number;
  };
}

export interface RuntimeToolStartedEvent extends RuntimeEventBase {
  readonly kind: "tool.started";
  readonly data: {
    readonly toolName: string;
    readonly argumentsHash: string;
    readonly argumentsJson: string;
    readonly argumentsRedacted: boolean;
    readonly recoveryMode: ToolRecoveryMode;
    /** Present only when the committed recovery policy has a stable binding key. */
    readonly recoveryKey?: string;
    readonly origin?: "model" | "code_mode";
  };
}

export interface RuntimeSessionStateCommittedEvent extends RuntimeEventBase {
  readonly kind: "session.state.committed";
  readonly data: {
    readonly stateVersion: SessionRuntimeStateVersion;
    readonly patch: SessionRuntimeStateWritePatch;
  };
}

/**
 * Transcript facts are specialized by the presentation layer. Core keeps their
 * event envelope generic so durable storage never needs a UI dependency.
 */
export interface RuntimeTranscriptEventRecordedEvent<
  TTranscriptEvent = unknown,
> extends RuntimeEventBase {
  readonly kind: "transcript.event.recorded";
  readonly data: { readonly event: TTranscriptEvent };
}

interface RuntimePlanEventBase extends RuntimeEventBase {
  readonly partial: false;
  readonly visibility: "internal";
  readonly data: PlanOperationFact;
}

export interface RuntimePlanProposedEvent extends RuntimePlanEventBase {
  readonly kind: "plan.proposed";
  readonly data: PlanOperationFact & { readonly proposal: PlanProposal };
}

export interface RuntimePlanRevisedEvent extends RuntimePlanEventBase {
  readonly kind: "plan.revised";
  readonly data: PlanOperationFact & {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly proposal: PlanProposal;
  };
}

export interface RuntimePlanRevisionRequestedEvent extends RuntimePlanEventBase {
  readonly kind: "plan.revision.requested";
  readonly data: PlanOperationFact & {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly feedback: string;
  };
}

export interface RuntimePlanReviewClaimedEvent extends RuntimePlanEventBase {
  readonly kind: "plan.review.claimed";
  readonly data: PlanOperationFact & {
    readonly planId: string;
    readonly revision: number;
    readonly controlEpoch: string;
    readonly action: PlanReviewAction;
    readonly feedback?: string;
  };
}

interface RuntimePlanReviewedEvent<
  K extends "plan.approved" | "plan.rejected",
> extends RuntimePlanEventBase {
  readonly kind: K;
  readonly data: PlanOperationFact & {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly reviewedBy: PlanReviewedBy;
    readonly reason?: string;
  };
}

export type RuntimePlanApprovedEvent = RuntimePlanReviewedEvent<"plan.approved">;
export type RuntimePlanRejectedEvent = RuntimePlanReviewedEvent<"plan.rejected">;

export interface RuntimePlanExecutionStartedEvent extends RuntimePlanEventBase {
  readonly kind: "plan.execution.started";
  readonly data: PlanOperationFact & {
    readonly planId: string;
    readonly revision: number;
    readonly graph?: PlanGraphBinding;
  };
}

export interface RuntimePlanStepUpdatedEvent extends RuntimePlanEventBase {
  readonly kind: "plan.step.updated";
  readonly data: PlanOperationFact & {
    readonly planId: string;
    readonly stepId: string;
    readonly status: PlanStepStatus;
    readonly note?: string;
  };
}

export interface RuntimePlanStepRecoveredEvent extends RuntimePlanEventBase {
  readonly kind: "plan.step.recovered";
  readonly data: PlanOperationFact & {
    readonly planId: string;
    readonly stepId: string;
    readonly note?: string;
  };
}

interface RuntimePlanExecutionLifecycleEvent<
  K extends
    | "plan.execution.interrupted"
    | "plan.execution.resumed"
    | "plan.execution.replanned"
    | "plan.execution.completed"
    | "plan.execution.cancelled",
> extends RuntimePlanEventBase {
  readonly kind: K;
  readonly data: PlanOperationFact & { readonly planId: string; readonly reason?: string };
}

export type RuntimePlanExecutionInterruptedEvent =
  RuntimePlanExecutionLifecycleEvent<"plan.execution.interrupted">;
export type RuntimePlanExecutionResumedEvent =
  RuntimePlanExecutionLifecycleEvent<"plan.execution.resumed">;
export type RuntimePlanExecutionReplannedEvent =
  RuntimePlanExecutionLifecycleEvent<"plan.execution.replanned">;
export type RuntimePlanExecutionCompletedEvent =
  RuntimePlanExecutionLifecycleEvent<"plan.execution.completed">;
export type RuntimePlanExecutionCancelledEvent =
  RuntimePlanExecutionLifecycleEvent<"plan.execution.cancelled">;

export type RuntimePlanEvent =
  | RuntimePlanProposedEvent
  | RuntimePlanRevisedEvent
  | RuntimePlanRevisionRequestedEvent
  | RuntimePlanReviewClaimedEvent
  | RuntimePlanApprovedEvent
  | RuntimePlanRejectedEvent
  | RuntimePlanExecutionStartedEvent
  | RuntimePlanStepUpdatedEvent
  | RuntimePlanStepRecoveredEvent
  | RuntimePlanExecutionInterruptedEvent
  | RuntimePlanExecutionResumedEvent
  | RuntimePlanExecutionReplannedEvent
  | RuntimePlanExecutionCompletedEvent
  | RuntimePlanExecutionCancelledEvent;

export interface RuntimeRunTerminalEvent extends RuntimeEventBase {
  readonly kind: "run.terminal";
  readonly data: {
    readonly status: RuntimeTerminalStatus;
    readonly reason?: string;
    readonly recovered?: boolean;
  };
}

export type RuntimeEvent<TTranscriptEvent = unknown> =
  | RuntimeRunStartedEvent
  | RuntimeMessageCommittedEvent
  | RuntimeToolStartedEvent
  | RuntimeToolGroupLoadedEvent
  | RuntimeToolRecoveryResolvedEvent
  | RuntimeToolResultRecordedEvent
  | RuntimeToolResultProjectionRecordedEvent
  | RuntimeAgentOutputEvent
  | RuntimeApprovalRequestedEvent
  | RuntimeApprovalSettledEvent
  | RuntimeModelCallStartedEvent
  | RuntimeModelCallSettledEvent
  | RuntimeCheckpointRecordedEvent
  | RuntimeSessionForkedEvent
  | RuntimeSessionStateCommittedEvent
  | RuntimeTranscriptEventRecordedEvent<TTranscriptEvent>
  | RuntimePlanEvent
  | RuntimeRunTerminalEvent;

export function isRuntimeTerminalEvent<TTranscriptEvent>(
  event: RuntimeEvent<TTranscriptEvent>,
): event is RuntimeRunTerminalEvent {
  return event.kind === "run.terminal";
}

export function isRuntimeMessageEvent<TTranscriptEvent>(
  event: RuntimeEvent<TTranscriptEvent>,
): event is RuntimeMessageCommittedEvent {
  return event.kind === "message.committed";
}

export function runtimeEventHasModelMessage<TTranscriptEvent>(
  event: RuntimeEvent<TTranscriptEvent>,
): event is RuntimeMessageCommittedEvent {
  return event.kind === "message.committed" && event.visibility === "model" && !event.partial;
}
