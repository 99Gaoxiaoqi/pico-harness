/**
 * 兼容 Engine 导入路径。RuntimeEvent 的稳定联合属于 Core；Engine 只在
 * Transcript 事实处提供展示层的具体类型。
 */
import type { RuntimeEvent as CoreRuntimeEvent } from "@pico/core";
import type { DurableTranscriptEvent } from "@pico/core";

export {
  isRuntimeMessageEvent,
  isRuntimeTerminalEvent,
  RUNTIME_EVENT_SCHEMA_VERSION,
  runtimeEventHasModelMessage,
} from "@pico/core";

export type {
  AgentSwarmAuthorizationSource,
  RuntimeAgentOutputEvent,
  RuntimeAgentOutputPayload,
  RuntimeAgentOutputStatus,
  RuntimeApprovalRequestedEvent,
  RuntimeApprovalSettledEvent,
  RuntimeCheckpointRecordedEvent,
  RuntimeCheckpointRecordedEventData,
  RuntimeEventBase,
  RuntimeEventRefs,
  RuntimeEventVisibility,
  RuntimeEvidenceReference,
  RuntimeMessageCommittedEvent,
  RuntimeModelCallSettledEvent,
  RuntimeModelCallStartedEvent,
  RuntimePlanApprovedEvent,
  RuntimePlanEvent,
  RuntimePlanExecutionCancelledEvent,
  RuntimePlanExecutionCompletedEvent,
  RuntimePlanExecutionInterruptedEvent,
  RuntimePlanExecutionReplannedEvent,
  RuntimePlanExecutionResumedEvent,
  RuntimePlanExecutionStartedEvent,
  RuntimePlanProposedEvent,
  RuntimePlanRejectedEvent,
  RuntimePlanRevisedEvent,
  RuntimePlanRevisionRequestedEvent,
  RuntimePlanReviewClaimedEvent,
  RuntimePlanStepRecoveredEvent,
  RuntimePlanStepUpdatedEvent,
  RuntimeRunContinuationOf,
  RuntimeRunStartedEvent,
  RuntimeRunTerminalEvent,
  RuntimeSessionForkedEvent,
  RuntimeSessionStateCommittedEvent,
  RuntimeTerminalStatus,
  RuntimeToolGroupLoadedEvent,
  RuntimeToolRecoveryClassification,
  RuntimeToolRecoveryResolvedEvent,
  RuntimeToolResultRecordedEvent,
  RuntimeToolResultRecoveryMarker,
  RuntimeToolStartedEvent,
} from "@pico/core";

export type RuntimeTranscriptEventRecordedEvent =
  import("@pico/core").RuntimeTranscriptEventRecordedEvent<DurableTranscriptEvent>;

export type RuntimeEvent = CoreRuntimeEvent<DurableTranscriptEvent>;
