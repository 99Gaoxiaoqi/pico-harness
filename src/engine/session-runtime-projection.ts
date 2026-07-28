import {
  SESSION_RUNTIME_STATE_VERSION,
  createEmptyUsageSnapshot,
  type SessionRuntimeStateSnapshot,
  type SessionUsageSnapshot,
} from "./session-runtime.js";
import { toCanonicalUsage, type Message } from "../schema/message.js";
import type { TranscriptEvent } from "../presentation/transcript-event-store.js";
import {
  projectRuntimeModelMessage,
  projectRuntimeToolResultEnvelope,
  runtimeEventHasModelHistoryEntry,
  type RuntimeModelHistoryEvent,
} from "./runtime-model-message.js";
import type { RuntimeEvent, RuntimeToolResultRecordedEvent } from "./session-runtime-event.js";
import type { RuntimeHistoryProjectionEntry } from "./session-runtime-read-model.js";
import type { ToolResultEnvelope } from "./tool-result-contract.js";

export interface SequencedRuntimeEvent {
  readonly sequence: number;
  readonly event: RuntimeEvent;
}

export interface RuntimeSessionSequencedMessageEntry extends RuntimeHistoryProjectionEntry {
  readonly sequence: number;
  readonly runId: string;
  readonly turnId: string;
}

export interface RuntimeSessionModelHistoryEntry extends RuntimeHistoryProjectionEntry {
  readonly event: RuntimeModelHistoryEvent;
}

export interface RuntimeSessionTranscriptEventEntry {
  readonly sequence: number;
  readonly event: TranscriptEvent;
}

export interface RuntimeSessionToolResultEntry {
  readonly sequence: number;
  readonly eventId: string;
  readonly envelope: ToolResultEnvelope;
}

/**
 * Session projection contract. Runtime owns the concrete event store, while
 * these pure projections belong to the engine's durable-session boundary.
 */
export function projectRuntimeSessionMessages(events: readonly RuntimeEvent[]): Message[] {
  return projectRuntimeSessionMessageEntries(events).map(({ message }) => message);
}

export function projectRuntimeSessionMessageEntries(
  events: readonly RuntimeEvent[],
): RuntimeHistoryProjectionEntry[] {
  return projectRuntimeSessionModelHistoryEntries(events).map(({ eventId, message }) => ({
    eventId,
    message,
  }));
}

export function projectRuntimeSessionModelHistoryEntries(
  events: readonly RuntimeEvent[],
): RuntimeSessionModelHistoryEntry[] {
  return projectModelHistoryEvents(events).map((event) => ({
    eventId: event.eventId,
    message: requiredRuntimeModelMessage(event),
    event,
  }));
}

export function projectRuntimeSessionSequencedMessageEntries(
  entries: readonly SequencedRuntimeEvent[],
): RuntimeSessionSequencedMessageEntry[] {
  return projectBranchEventIndexes(
    entries.map(({ event }) => event),
    runtimeEventHasModelHistoryEntry,
  ).map(({ eventIndex, event }) => ({
    eventId: event.eventId,
    message: requiredRuntimeModelMessage(event),
    sequence: entries[eventIndex]!.sequence,
    runId: event.runId,
    turnId: event.turnId,
  }));
}

export function projectRuntimeSessionTranscriptEventEntries(
  entries: readonly SequencedRuntimeEvent[],
): RuntimeSessionTranscriptEventEntry[] {
  return entries.flatMap(({ sequence, event }) =>
    event.kind === "transcript.event.recorded"
      ? [{ sequence, event: structuredClone(event.data.event) }]
      : [],
  );
}

/**
 * Hydrates only ToolResults that remain on the active Runtime branch. The raw
 * body never crosses this boundary; host surfaces receive the bounded envelope.
 */
export function projectRuntimeSessionToolResultEntries(
  entries: readonly SequencedRuntimeEvent[],
): RuntimeSessionToolResultEntry[] {
  return projectBranchEventIndexes(
    entries.map(({ event }) => event),
    isRuntimeToolResult,
  ).map(({ eventIndex, event }) => ({
    sequence: entries[eventIndex]!.sequence,
    eventId: event.eventId,
    envelope: projectRuntimeToolResultEnvelope(event),
  }));
}

export function projectRuntimeSessionState(
  events: readonly RuntimeEvent[],
): SessionRuntimeStateSnapshot {
  let settings: SessionRuntimeStateSnapshot["settings"];
  let goal: SessionRuntimeStateSnapshot["goal"];
  for (const event of events) {
    if (event.kind !== "session.state.committed") continue;
    if (event.data.patch.settings) settings = structuredClone(event.data.patch.settings);
    if (event.data.patch.goal) goal = structuredClone(event.data.patch.goal);
  }
  return {
    stateVersion: SESSION_RUNTIME_STATE_VERSION,
    ...(settings ? { settings } : {}),
    ...(goal ? { goal } : {}),
    usage: projectRuntimeSessionUsage(events),
  };
}

export function projectRuntimeSessionUsage(events: readonly RuntimeEvent[]): SessionUsageSnapshot {
  let usage = createEmptyUsageSnapshot();
  let sawSuccessfulCallFact = false;
  let legacyProviderCallBaseline = 0;
  const successfulCallFacts: Array<Extract<RuntimeEvent, { kind: "model.call.settled" }>> = [];
  for (const event of events) {
    if (event.kind === "model.call.settled" && event.data.status === "succeeded") {
      sawSuccessfulCallFact = true;
      successfulCallFacts.push(event);
      continue;
    }
    if (event.kind !== "session.state.committed" || !event.data.patch.usage) continue;
    if (!sawSuccessfulCallFact) {
      legacyProviderCallBaseline = Math.max(
        legacyProviderCallBaseline,
        event.data.patch.usage.totalProviderCalls,
      );
    }
    usage = structuredClone(event.data.patch.usage);
  }

  let coveredCallFacts = Math.max(0, usage.totalProviderCalls - legacyProviderCallBaseline);
  for (const event of successfulCallFacts) {
    if (coveredCallFacts > 0) {
      coveredCallFacts--;
      continue;
    }
    usage.totalProviderCalls++;
    const reportedUsage = event.data.usage;
    if (!reportedUsage) continue;

    const canonical = toCanonicalUsage(reportedUsage);
    usage.totalUsageReports++;
    usage.totalPromptTokens += Math.max(0, canonical.totalPromptTokens);
    usage.totalCompletionTokens += Math.max(0, canonical.totalCompletionTokens);
    usage.totalInputTokens += canonical.inputTokens;
    usage.totalCacheReadTokens += canonical.cacheReadTokens;
    usage.totalCacheWriteTokens += canonical.cacheWriteTokens;
    usage.totalReasoningTokens += canonical.reasoningTokens;
    usage.totalCostCNY += event.data.costCNY ?? 0;

    const status = event.data.costStatus ?? "unknown";
    usage.lastCostStatus = status;
    if (status === "estimated") usage.totalEstimatedCostReports++;
    else if (status === "included") usage.totalIncludedCostReports++;
    else usage.totalUnknownCostReports++;

    const fields = new Set(reportedUsage.reportedFields ?? ["prompt", "completion"]);
    if (fields.has("input")) usage.totalInputReports++;
    if (fields.has("cacheRead")) usage.totalCacheReadReports++;
    if (fields.has("cacheWrite")) usage.totalCacheWriteReports++;
    if (fields.has("reasoning")) usage.totalReasoningReports++;
  }
  return usage;
}

function projectModelHistoryEvents(events: readonly RuntimeEvent[]): RuntimeModelHistoryEvent[] {
  return projectBranchEventIndexes(events, runtimeEventHasModelHistoryEntry).map(
    ({ event }) => event,
  );
}

function projectBranchEventIndexes<Event extends RuntimeEvent>(
  events: readonly RuntimeEvent[],
  select: (event: RuntimeEvent) => event is Event,
): Array<{ readonly eventIndex: number; readonly event: Event }> {
  const eventIndexes = new Map<string, number>();
  const projected: Array<{ readonly eventIndex: number; readonly event: Event }> = [];
  for (const [eventIndex, event] of events.entries()) {
    if (eventIndexes.has(event.eventId)) {
      throw new Error(`Runtime session projection contains duplicate event ID ${event.eventId}`);
    }
    if (event.kind === "history.rewound") {
      if (event.data.throughEventId === undefined) {
        projected.length = 0;
      } else {
        const throughEventIndex = eventIndexes.get(event.data.throughEventId);
        if (throughEventIndex === undefined) {
          throw new Error(
            `Runtime session projection rewind references unknown event ${event.data.throughEventId}`,
          );
        }
        const firstRemoved = projected.findIndex(
          (candidate) => candidate.eventIndex > throughEventIndex,
        );
        if (firstRemoved !== -1) projected.splice(firstRemoved);
      }
    } else if (select(event)) {
      projected.push({ eventIndex, event: structuredClone(event) });
    }
    eventIndexes.set(event.eventId, eventIndex);
  }
  return projected;
}

function requiredRuntimeModelMessage(event: RuntimeModelHistoryEvent): Message {
  const message = projectRuntimeModelMessage(event);
  if (!message) {
    throw new Error(`Runtime event ${event.eventId} has no model projection`);
  }
  return message;
}

function isRuntimeToolResult(event: RuntimeEvent): event is RuntimeToolResultRecordedEvent {
  return event.kind === "tool.result.recorded";
}
