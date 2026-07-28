import { createHash } from "node:crypto";
import type { DurableTranscriptEvent } from "../presentation/transcript-event-store.js";
import type { ToolCall } from "../schema/message.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEventRefs,
  type RuntimeTranscriptEventRecordedEvent,
} from "./session-runtime-event.js";

const TRANSCRIPT_TOOL_START_IDENTITY_VERSION = 1;

export type CanonicalTranscriptToolStart = Extract<
  DurableTranscriptEvent,
  { readonly type: "tool.started" }
>;

export interface TranscriptToolStartIdentityInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly callIndex: number;
  /** Recovery branches need a fresh visible start after transcript rewind. */
  readonly scope?: string;
}

export interface CanonicalTranscriptToolStartInput extends TranscriptToolStartIdentityInput {
  readonly toolCall: ToolCall;
  readonly sequence: number;
  readonly createdAt: number;
}

export interface TranscriptToolStartIdentity {
  readonly eventId: string;
  readonly entryId: string;
  readonly toolCallId: string;
  readonly runtimeEventId: string;
}

export interface RuntimeTranscriptToolStartEventInput {
  readonly sessionId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly start: CanonicalTranscriptToolStart;
  readonly refs?: RuntimeEventRefs;
}

/**
 * A provider call ID may be reused across turns. The canonical presentation
 * identity therefore belongs to one accepted call position in one Runtime turn.
 */
export function createTranscriptToolStartIdentity(
  input: TranscriptToolStartIdentityInput,
): TranscriptToolStartIdentity {
  if (!Number.isSafeInteger(input.callIndex) || input.callIndex < 0) {
    throw new Error("Transcript tool start call index must be a non-negative safe integer");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        TRANSCRIPT_TOOL_START_IDENTITY_VERSION,
        input.sessionId,
        input.runId,
        input.turnId,
        input.callIndex,
        input.scope ?? "accepted",
      ]),
    )
    .digest("hex");
  const eventId = `tool-start:event:${digest}`;
  return {
    eventId,
    entryId: `tool-start:entry:${digest}`,
    toolCallId: `tool-start:call:${digest}`,
    runtimeEventId: `transcript:${eventId}`,
  };
}

export function createCanonicalTranscriptToolStart(
  input: CanonicalTranscriptToolStartInput,
): CanonicalTranscriptToolStart {
  if (!Number.isSafeInteger(input.sequence) || input.sequence <= 0) {
    throw new Error("Transcript tool start sequence must be a positive safe integer");
  }
  if (!Number.isFinite(input.createdAt)) {
    throw new Error("Transcript tool start timestamp must be finite");
  }
  const identity = createTranscriptToolStartIdentity(input);
  return {
    eventId: identity.eventId,
    sequence: input.sequence,
    createdAt: input.createdAt,
    type: "tool.started",
    entryId: identity.entryId,
    toolCallId: identity.toolCallId,
    providerCallId: input.toolCall.id,
    name: input.toolCall.name,
    args: input.toolCall.arguments,
  };
}

export function canonicalTranscriptToolStartRuntimeEventId(
  event: CanonicalTranscriptToolStart,
): string {
  return `transcript:${event.eventId}`;
}

export function createRuntimeTranscriptToolStartEvent(
  input: RuntimeTranscriptToolStartEventInput,
): RuntimeTranscriptEventRecordedEvent {
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: canonicalTranscriptToolStartRuntimeEventId(input.start),
    sessionId: input.sessionId,
    invocationId: input.invocationId,
    runId: input.runId,
    turnId: input.turnId,
    at: new Date(input.start.createdAt).toISOString(),
    partial: false,
    visibility: "transcript",
    refs: {
      ...(input.refs ?? {}),
      providerCallId: input.start.providerCallId,
    },
    kind: "transcript.event.recorded",
    data: { event: structuredClone(input.start) },
  };
}
