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

/**
 * ADR 29 续跑锚:目标 run 的 run.started 声明其对某个 interrupted 源 run
 * 前缀的确定性引用。三元组与 `runtime_continuation_claims` 行的
 * source_run_id / source_high_water / source_prefix_digest 同口径,由调用方
 * 在 claim 成功后取得;前缀事件位于同一 session 事件流,模型上下文无需特判。
 */
export interface RuntimeRunContinuationOf {
  readonly runId: string;
  readonly highWater: number;
  readonly prefixDigest: string;
}

export interface RuntimeRunStartedEvent extends RuntimeEventBase {
  readonly kind: "run.started";
  readonly data: {
    readonly workDir: string;
    /** 仅续跑目标 run 携带;普通 run 不得设置。 */
    readonly continuationOf?: RuntimeRunContinuationOf;
  };
}

export interface RuntimeMessageCommittedEvent extends RuntimeEventBase {
  readonly kind: "message.committed";
  readonly data: { readonly message: Message };
}

export interface RuntimeToolStartedEvent extends RuntimeEventBase {
  readonly kind: "tool.started";
  readonly data: { readonly toolName: string; readonly argumentsHash: string };
}

/** load_tools 组级激活的 durable 事实：披露状态经 ledger 重播恢复。 */
export interface RuntimeToolGroupLoadedEvent extends RuntimeEventBase {
  readonly kind: "tool.group.loaded";
  readonly data: {
    readonly groupId: string;
    readonly toolNames: readonly string[];
  };
}

/**
 * ADR 27 P0 恢复分类标记：悬空 tool call 的合成 tool.result.recorded
 * 携带的半执行判定。`indeterminate` = 已派发（tool.started 已落库）但结果未知，
 * 副作用可能已发生；`not_dispatched` = 从未派发，无副作用。
 */
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
    readonly toolName: string;
    readonly status: RuntimeToolResultStatus;
    readonly body: RuntimeToolResultBody;
    readonly projection: RuntimeToolResultProjection;
    /** 仅恢复期合成结果携带；正常执行路径不得设置。 */
    readonly recovery?: RuntimeToolResultRecoveryMarker;
  };
}

export type RuntimeAgentOutputStatus = "success" | "failure";

/** Stable semantic body committed by the operator-only agent_output tool. */
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

/** Canonical reference source for one Graph operator activation output. */
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
 * @legacy-only 不可生产，仅旧账本解码。rewind / branchId 破坏性机制已移除
 * （rewind 现为非破坏性 fork）：本类型不在 RUNTIME_EVENT_KINDS 中，append
 * 校验会拒绝；保留在判别联合中仅为了让历史持久化的 `history.rewound`
 * 事件解码不崩溃。新代码不得构造或检查此事件。
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

/**
 * Graph Mode (Lesson 17). Graph events model incrementally submitted work dependencies: each
 * Legacy Graph v1 add_work declared an instruction plus optional upstream record ids; the
 * orchestrator dispatches each work once its inputs are ready and records the
 * output. Every graph event shares the same operationId + fingerprint CAS
 * envelope as Plan events, so the underlying store treats them identically.
 */
interface RuntimeGraphEventBase extends RuntimeEventBase {
  readonly partial: false;
  readonly visibility: "internal";
  readonly data: {
    readonly operationId: string;
    readonly fingerprint: string;
    readonly graphId: string;
  };
}

export interface RuntimeGraphWorkAddedEvent extends RuntimeGraphEventBase {
  readonly kind: "graph.work.added";
  readonly data: RuntimeGraphEventBase["data"] & {
    readonly workId: string;
    readonly instruction: string;
    readonly inputIds: readonly string[];
    readonly mode: "explore" | "worker";
  };
}

export interface RuntimeGraphWorkDispatchedEvent extends RuntimeGraphEventBase {
  readonly kind: "graph.work.dispatched";
  readonly data: RuntimeGraphEventBase["data"] & {
    readonly workId: string;
    readonly delegationId: string;
  };
}

export interface RuntimeGraphWorkRecordedEvent extends RuntimeGraphEventBase {
  readonly kind: "graph.work.recorded";
  readonly data: RuntimeGraphEventBase["data"] & {
    readonly workId: string;
    readonly recordId: string;
    readonly outputSummary: string;
    readonly evidenceRefs?: readonly string[];
  };
}

export interface RuntimeGraphWorkFailedEvent extends RuntimeGraphEventBase {
  readonly kind: "graph.work.failed";
  readonly data: RuntimeGraphEventBase["data"] & {
    readonly workId: string;
    readonly error: string;
  };
}

export interface RuntimeGraphClosedEvent extends RuntimeGraphEventBase {
  readonly kind: "graph.closed";
  readonly data: RuntimeGraphEventBase["data"] & {
    readonly resultRecordIds?: readonly string[];
  };
}

export type RuntimeGraphEvent =
  | RuntimeGraphWorkAddedEvent
  | RuntimeGraphWorkDispatchedEvent
  | RuntimeGraphWorkRecordedEvent
  | RuntimeGraphWorkFailedEvent
  | RuntimeGraphClosedEvent;

export type RuntimeEvent =
  | RuntimeRunStartedEvent
  | RuntimeMessageCommittedEvent
  | RuntimeToolStartedEvent
  | RuntimeToolGroupLoadedEvent
  | RuntimeToolResultRecordedEvent
  | RuntimeAgentOutputEvent
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
  | RuntimeGraphEvent
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
