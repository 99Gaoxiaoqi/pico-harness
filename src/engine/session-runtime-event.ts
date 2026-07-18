import type { TranscriptEvent } from "../presentation/transcript-event-store.js";
import type { Message, Usage } from "../schema/message.js";
import { SESSION_RUNTIME_STATE_VERSION, type SessionRuntimeStatePatch } from "./session-runtime.js";

/** Durable Session event contract. Runtime owns validation and storage adapters. */
export const RUNTIME_EVENT_SCHEMA_VERSION = 1 as const;

export type RuntimeEventVisibility = "model" | "transcript" | "internal";
export type RuntimeTerminalStatus = "completed" | "failed" | "cancelled" | "interrupted";

export interface RuntimeEvidenceReference {
  readonly schemaVersion: 1;
  readonly contentHash: string;
  readonly sessionId: string;
  readonly kind: "tool-exchange";
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

interface RuntimeCheckpointRecordedEventDataBase {
  readonly checkpointId: string;
  readonly coveredEventCount: number;
  readonly sourceDigest: string;
}
export interface RuntimeRollingCheckpointData extends RuntimeCheckpointRecordedEventDataBase {
  readonly throughEventId: string;
  readonly summary: Message;
}
interface RuntimeLegacyCheckpointData extends RuntimeCheckpointRecordedEventDataBase {
  readonly throughEventId?: undefined;
  readonly summary?: undefined;
}
export type RuntimeCheckpointRecordedEventData =
  | RuntimeLegacyCheckpointData
  | RuntimeRollingCheckpointData;

export interface RuntimeCheckpointRecordedEvent extends RuntimeEventBase {
  readonly kind: "context.checkpoint.recorded";
  readonly data: RuntimeCheckpointRecordedEventData;
}
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
    readonly stateVersion: typeof SESSION_RUNTIME_STATE_VERSION;
    readonly patch: SessionRuntimeStatePatch;
  };
}
export interface RuntimeTranscriptEventRecordedEvent extends RuntimeEventBase {
  readonly kind: "transcript.event.recorded";
  readonly data: { readonly event: TranscriptEvent };
}
export interface RuntimeRunTerminalEvent extends RuntimeEventBase {
  readonly kind: "run.terminal";
  readonly data: {
    readonly status: RuntimeTerminalStatus;
    readonly reason?: string;
    readonly recovered?: boolean;
  };
}

export type RuntimeEvent =
  | RuntimeRunStartedEvent
  | RuntimeMessageCommittedEvent
  | RuntimeToolStartedEvent
  | RuntimeApprovalRequestedEvent
  | RuntimeApprovalSettledEvent
  | RuntimeModelCallStartedEvent
  | RuntimeModelCallSettledEvent
  | RuntimeCheckpointRecordedEvent
  | RuntimeHistoryRewoundEvent
  | RuntimeSessionForkedEvent
  | RuntimeSessionStateCommittedEvent
  | RuntimeTranscriptEventRecordedEvent
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
