import {
  SESSION_RUNTIME_STATE_VERSION,
  createEmptyUsageSnapshot,
  type SessionRuntimeStateSnapshot,
  type SessionUsageSnapshot,
} from "../engine/session-runtime.js";
import { toCanonicalUsage, type Message } from "../schema/message.js";
import {
  runtimeEventHasModelMessage,
  type RuntimeEvent,
  type RuntimeMessageCommittedEvent,
} from "./runtime-event.js";
import type { RuntimeHistoryProjectionEntry } from "./runtime-event-read-model.js";
import type { TranscriptEvent } from "../presentation/transcript-event-store.js";

export interface SequencedRuntimeEvent {
  readonly sequence: number;
  readonly event: RuntimeEvent;
}

export interface RuntimeSessionSequencedMessageEntry extends RuntimeHistoryProjectionEntry {
  readonly sequence: number;
}

export interface RuntimeSessionTranscriptEventEntry {
  readonly sequence: number;
  readonly event: TranscriptEvent;
}

export function projectRuntimeSessionMessages(events: readonly RuntimeEvent[]): Message[] {
  return projectRuntimeSessionMessageEntries(events).map(({ message }) => message);
}

/**
 * Projects the complete transcript from immutable message facts. Checkpoints affect
 * the model read model only; rewind facts replace the active transcript branch.
 */
export function projectRuntimeSessionMessageEntries(
  events: readonly RuntimeEvent[],
): RuntimeHistoryProjectionEntry[] {
  return projectMessageEvents(events).map((event) => ({
    eventId: event.eventId,
    message: structuredClone(event.data.message),
  }));
}

export function projectRuntimeSessionSequencedMessageEntries(
  entries: readonly SequencedRuntimeEvent[],
): RuntimeSessionSequencedMessageEntry[] {
  return projectBranchEventIndexes(
    entries.map(({ event }) => event),
    (event): event is RuntimeMessageCommittedEvent => runtimeEventHasModelMessage(event),
  ).map(({ eventIndex, event }) => ({
    eventId: event.eventId,
    message: structuredClone(event.data.message),
    sequence: entries[eventIndex]!.sequence,
  }));
}

export function projectRuntimeSessionTranscriptEventEntries(
  entries: readonly SequencedRuntimeEvent[],
): RuntimeSessionTranscriptEventEntry[] {
  return projectBranchEventIndexes(
    entries.map(({ event }) => event),
    (event): event is Extract<RuntimeEvent, { kind: "transcript.event.recorded" }> =>
      event.kind === "transcript.event.recorded",
  ).map(({ eventIndex, event }) => ({
    sequence: entries[eventIndex]!.sequence,
    event: structuredClone(event.data.event),
  }));
}

export function projectRuntimeSessionState(
  events: readonly RuntimeEvent[],
): SessionRuntimeStateSnapshot {
  let settings: SessionRuntimeStateSnapshot["settings"];
  let goal: SessionRuntimeStateSnapshot["goal"];
  let persistedUsage: SessionUsageSnapshot | undefined;
  for (const event of events) {
    if (event.kind !== "session.state.committed") continue;
    if (event.data.patch.settings) settings = structuredClone(event.data.patch.settings);
    if (event.data.patch.goal) goal = structuredClone(event.data.patch.goal);
    if (event.data.patch.usage) persistedUsage = structuredClone(event.data.patch.usage);
  }
  const usage = mergeUsage(projectRuntimeSessionUsage(events), persistedUsage);
  return {
    stateVersion: SESSION_RUNTIME_STATE_VERSION,
    ...(settings ? { settings } : {}),
    ...(goal ? { goal } : {}),
    usage,
  };
}

export function projectRuntimeSessionUsage(events: readonly RuntimeEvent[]): SessionUsageSnapshot {
  const usage = createEmptyUsageSnapshot();
  for (const event of events) {
    if (event.kind !== "model.call.settled" || event.data.status !== "succeeded") continue;
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

function projectMessageEvents(events: readonly RuntimeEvent[]): RuntimeMessageCommittedEvent[] {
  return projectBranchEventIndexes(events, (event): event is RuntimeMessageCommittedEvent =>
    runtimeEventHasModelMessage(event),
  ).map(({ event }) => event);
}

function projectBranchEventIndexes<Event extends RuntimeEvent>(
  events: readonly RuntimeEvent[],
  select: (event: RuntimeEvent) => event is Event,
): Array<{ readonly eventIndex: number; readonly event: Event }> {
  const eventIndexes = new Map<string, number>();
  const projected: Array<{
    readonly eventIndex: number;
    readonly event: Event;
  }> = [];
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

function mergeUsage(
  derived: SessionUsageSnapshot,
  persisted: SessionUsageSnapshot | undefined,
): SessionUsageSnapshot {
  if (!persisted) return derived;
  const usePersistedStatus = persisted.totalProviderCalls >= derived.totalProviderCalls;
  return {
    totalPromptTokens: Math.max(derived.totalPromptTokens, persisted.totalPromptTokens),
    totalCompletionTokens: Math.max(derived.totalCompletionTokens, persisted.totalCompletionTokens),
    totalInputTokens: Math.max(derived.totalInputTokens, persisted.totalInputTokens),
    totalCacheReadTokens: Math.max(derived.totalCacheReadTokens, persisted.totalCacheReadTokens),
    totalCacheWriteTokens: Math.max(derived.totalCacheWriteTokens, persisted.totalCacheWriteTokens),
    totalReasoningTokens: Math.max(derived.totalReasoningTokens, persisted.totalReasoningTokens),
    totalCostCNY: Math.max(derived.totalCostCNY, persisted.totalCostCNY),
    lastCostStatus: usePersistedStatus ? persisted.lastCostStatus : derived.lastCostStatus,
    totalProviderCalls: Math.max(derived.totalProviderCalls, persisted.totalProviderCalls),
    totalUsageReports: Math.max(derived.totalUsageReports, persisted.totalUsageReports),
    totalInputReports: Math.max(derived.totalInputReports, persisted.totalInputReports),
    totalCacheReadReports: Math.max(derived.totalCacheReadReports, persisted.totalCacheReadReports),
    totalCacheWriteReports: Math.max(
      derived.totalCacheWriteReports,
      persisted.totalCacheWriteReports,
    ),
    totalReasoningReports: Math.max(derived.totalReasoningReports, persisted.totalReasoningReports),
    totalEstimatedCostReports: Math.max(
      derived.totalEstimatedCostReports,
      persisted.totalEstimatedCostReports,
    ),
    totalIncludedCostReports: Math.max(
      derived.totalIncludedCostReports,
      persisted.totalIncludedCostReports,
    ),
    totalUnknownCostReports: Math.max(
      derived.totalUnknownCostReports,
      persisted.totalUnknownCostReports,
    ),
  };
}
