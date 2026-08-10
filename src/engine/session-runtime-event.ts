import type { DurableTranscriptEvent } from "../presentation/transcript-event-store.js";
import type { Message, Usage } from "../schema/message.js";
import type {
  PlanOperationFact,
  PlanProposal,
  PlanReviewedBy,
  PlanStepStatus,
} from "../plan/contract.js";
import type {
  SessionRuntimeStateWritePatch,
  SessionRuntimeStateVersion,
} from "./session-runtime.js";
import type {
  RuntimeEvidenceReference,
  RuntimeToolResultBody,
  RuntimeToolResultProjection,
  RuntimeToolResultStatus,
} from "./tool-result-contract.js";
export type { RuntimeEvidenceReference } from "./tool-result-contract.js";

/** Durable Session event contract. Runtime owns validation and storage adapters. */
export const RUNTIME_EVENT_SCHEMA_VERSION = 2 as const;

export type RuntimeEventVisibility = "model" | "transcript" | "internal";
export type RuntimeTerminalStatus = "completed" | "failed" | "cancelled" | "interrupted";

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

export interface RuntimeRunStartedEvent extends RuntimeEventBase {
  readonly kind: "run.started";
  readonly data: { readonly workDir: string };
}

export interface RuntimeMessageCommittedEvent extends RuntimeEventBase {
  readonly kind: "message.committed";
  readonly data: { readonly message: Message };
}

export interface RuntimeToolStartedEvent extends RuntimeEventBase {
  readonly kind: "tool.started";
  readonly data: { readonly toolName: string; readonly argumentsHash: string };
}

export interface RuntimeToolResultRecordedEvent extends RuntimeEventBase {
  readonly kind: "tool.result.recorded";
  readonly refs: RuntimeEventRefs & {
    readonly toolCallId: string;
    readonly evidence?: RuntimeEvidenceReference;
  };
  readonly data: {
    readonly toolName: string;
    readonly status: RuntimeToolResultStatus;
    readonly body: RuntimeToolResultBody;
    readonly projection: RuntimeToolResultProjection;
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
    readonly provider?: string;
    readonly model?: string;
    readonly purpose: string;
  };
}

export interface RuntimeModelCallSettledEvent extends RuntimeEventBase {
  readonly kind: "model.call.settled";
  readonly data: {
    readonly providerCallId: string;
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
  readonly summary: Message;
  /** 滚动摘要链:上一个 checkpoint 的 id(若存在),用于增量更新。 */
  readonly previousCheckpointId?: string;
}

export interface RuntimeCheckpointRecordedEvent extends RuntimeEventBase {
  readonly kind: "context.checkpoint.recorded";
  readonly data: RuntimeCheckpointRecordedEventData;
}
/**
 * @deprecated The destructive rewind / branchId mechanism has been removed
 * (rewind is now a non-destructive fork). This type is retained only so that
 * decoding legacy persisted `history.rewound` events does not crash; no new
 * code should construct or inspect this event.
 */
export interface RuntimeHistoryRewoundEvent extends RuntimeEventBase {
  readonly kind: "history.rewound";
  readonly data: { readonly branchId: string; readonly throughEventId?: string };
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
export interface RuntimeSessionStateCommittedEvent extends RuntimeEventBase {
  readonly kind: "session.state.committed";
  readonly data: {
    readonly stateVersion: SessionRuntimeStateVersion;
    readonly patch: SessionRuntimeStateWritePatch;
  };
}
export interface RuntimeTranscriptEventRecordedEvent extends RuntimeEventBase {
  readonly kind: "transcript.event.recorded";
  readonly data: { readonly event: DurableTranscriptEvent };
}
export interface RuntimeRunTerminalEvent extends RuntimeEventBase {
  readonly kind: "run.terminal";
  readonly data: {
    readonly status: RuntimeTerminalStatus;
    readonly reason?: string;
    readonly recovered?: boolean;
  };
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
  readonly data: PlanOperationFact & { readonly planId: string; readonly revision: number };
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
  | RuntimePlanApprovedEvent
  | RuntimePlanRejectedEvent
  | RuntimePlanExecutionStartedEvent
  | RuntimePlanStepUpdatedEvent
  | RuntimePlanExecutionInterruptedEvent
  | RuntimePlanExecutionResumedEvent
  | RuntimePlanExecutionReplannedEvent
  | RuntimePlanExecutionCompletedEvent
  | RuntimePlanExecutionCancelledEvent;

export type RuntimeEvent =
  | RuntimeRunStartedEvent
  | RuntimeMessageCommittedEvent
  | RuntimeToolStartedEvent
  | RuntimeToolResultRecordedEvent
  | RuntimeApprovalRequestedEvent
  | RuntimeApprovalSettledEvent
  | RuntimeModelCallStartedEvent
  | RuntimeModelCallSettledEvent
  | RuntimeCheckpointRecordedEvent
  | RuntimeHistoryRewoundEvent
  | RuntimeSessionForkedEvent
  | RuntimeSessionStateCommittedEvent
  | RuntimeTranscriptEventRecordedEvent
  | RuntimePlanEvent
  | RuntimeRunTerminalEvent;

export function isRuntimeTerminalEvent(event: RuntimeEvent): event is RuntimeRunTerminalEvent {
  return event.kind === "run.terminal";
}
export function isRuntimeMessageEvent(event: RuntimeEvent): event is RuntimeMessageCommittedEvent {
  return event.kind === "message.committed";
}
export function runtimeEventHasModelMessage(
  event: RuntimeEvent,
): event is RuntimeMessageCommittedEvent {
  return event.kind === "message.committed" && event.visibility === "model" && !event.partial;
}
