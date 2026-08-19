import {
  SESSION_RUNTIME_STATE_VERSION,
  normalizeSessionRuntimeStatePatch,
  createEmptyUsageSnapshot,
  type SessionRuntimeStateSnapshot,
  type SessionUsageSnapshot,
} from "./session-runtime.js";
import { toCanonicalUsage, type Message } from "../schema/message.js";
import type { DurableTranscriptEvent } from "../presentation/transcript-event-store.js";
import {
  projectRuntimeModelMessage,
  projectRuntimeToolResultEnvelope,
  runtimeEventHasModelHistoryEntry,
  type RuntimeModelHistoryEvent,
} from "./runtime-model-message.js";
import type {
  RuntimeEvent,
  RuntimeEventVisibility,
  RuntimeToolResultRecordedEvent,
} from "./session-runtime-event.js";
import type { RuntimeHistoryProjectionEntry } from "./session-runtime-read-model.js";
import { RUNTIME_MODEL_MESSAGE_EVENT_KINDS } from "./session-runtime-read-model.js";
import type { ToolResultEnvelope } from "./tool-result-contract.js";

export interface SequencedRuntimeEvent {
  readonly sequence: number;
  readonly event: RuntimeEvent;
}

// ---------------------------------------------------------------------------
// 票 04 数据来源窄化:下列 kind 集精确描述各投影函数消费的事件子集,
// 消费方以此做 kind 切片查询替代全量 readSession;投影折叠规则不变。
// ---------------------------------------------------------------------------

/** projectRuntimeSessionState 消费的 kind 集(state patch + usage)。 */
export const RUNTIME_SESSION_STATE_EVENT_KINDS = [
  "session.state.committed",
  "model.call.settled",
] as const;

/** projectRuntimeSessionUsage 消费的 kind 集。 */
export const RUNTIME_SESSION_USAGE_EVENT_KINDS = ["model.call.settled"] as const;

/** projectRuntimeSessionTranscriptEventEntries 消费的 kind 集。 */
export const RUNTIME_SESSION_TRANSCRIPT_EVENT_KINDS = ["transcript.event.recorded"] as const;

/** transcript 读模型(desktop-transcript)消费的完整 kind 集。 */
export const RUNTIME_TRANSCRIPT_READ_MODEL_EVENT_KINDS = [
  ...RUNTIME_MODEL_MESSAGE_EVENT_KINDS,
  "transcript.event.recorded",
  ...RUNTIME_SESSION_STATE_EVENT_KINDS,
] as const;

/** fork seed 投影(model + transcript 事实)消费的 kind 集。 */
export const RUNTIME_SESSION_FORK_SEED_EVENT_KINDS = [
  ...RUNTIME_MODEL_MESSAGE_EVENT_KINDS,
  "transcript.event.recorded",
] as const;

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
  readonly event: DurableTranscriptEvent;
}

export interface RuntimeSessionToolResultEntry {
  readonly sequence: number;
  readonly eventId: string;
  readonly visibility: RuntimeEventVisibility;
  readonly envelope: ToolResultEnvelope;
}

/** Frozen fork input ordered by the source Runtime ledger, not by either projection alone. */
export type RuntimeSessionForkSeedEntry =
  | {
      readonly kind: "model";
      readonly sourceSequence: number;
      readonly event: RuntimeModelHistoryEvent;
    }
  | {
      readonly kind: "transcript";
      readonly sourceSequence: number;
      readonly event: DurableTranscriptEvent;
    };

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
  return selectRuntimeEvents(
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
 * Forks must preserve the relative order between canonical model facts and durable
 * transcript facts. Importing the two projections in separate batches can invert
 * a reused provider call ID and bind a ToolResult to the wrong UI tool entry.
 */
export function projectRuntimeSessionForkSeedEntries(
  entries: readonly SequencedRuntimeEvent[],
): RuntimeSessionForkSeedEntry[] {
  const sequenceByEventId = new Map(
    entries.map(({ sequence, event }) => [event.eventId, sequence] as const),
  );
  const model = projectRuntimeSessionModelHistoryEntries(entries.map(({ event }) => event)).map(
    ({ event }) => {
      const sourceSequence = sequenceByEventId.get(event.eventId);
      if (sourceSequence === undefined) {
        throw new Error(`Runtime fork model fact ${event.eventId} has no source sequence`);
      }
      return {
        kind: "model" as const,
        sourceSequence,
        event: structuredClone(event),
      };
    },
  );
  const transcript = projectRuntimeSessionTranscriptEventEntries(entries).map(
    ({ sequence, event }) => ({
      kind: "transcript" as const,
      sourceSequence: sequence,
      event: structuredClone(event),
    }),
  );
  return [...model, ...transcript].toSorted(
    (left, right) => left.sourceSequence - right.sourceSequence,
  );
}

/** Projects ToolResults on the active branch across model and transcript visibility. */
export function projectRuntimeSessionActiveToolResultEntries(
  entries: readonly SequencedRuntimeEvent[],
): RuntimeSessionToolResultEntry[] {
  return selectRuntimeEvents(
    entries.map(({ event }) => event),
    isRuntimeToolResult,
  ).map(({ eventIndex, event }) => ({
    sequence: entries[eventIndex]!.sequence,
    eventId: event.eventId,
    visibility: event.visibility,
    envelope: projectRuntimeToolResultEnvelope(event),
  }));
}

/** Top-level Session/host hydration contains only model-visible ToolResults. */
export function projectRuntimeSessionModelToolResultEntries(
  entries: readonly SequencedRuntimeEvent[],
): RuntimeSessionToolResultEntry[] {
  return projectRuntimeSessionActiveToolResultEntries(entries).filter(
    ({ visibility }) => visibility === "model",
  );
}

export function projectRuntimeSessionState(
  events: readonly RuntimeEvent[],
): SessionRuntimeStateSnapshot {
  let settings: SessionRuntimeStateSnapshot["settings"];
  let goal: SessionRuntimeStateSnapshot["goal"];
  let promptCache: SessionRuntimeStateSnapshot["promptCache"];
  for (const event of events) {
    if (event.kind !== "session.state.committed") continue;
    const patch = normalizeSessionRuntimeStatePatch(event.data.patch);
    if (!patch) continue;
    if (patch.settings) settings = structuredClone(patch.settings);
    if (patch.goal) goal = structuredClone(patch.goal);
    if (patch.promptCache) {
      promptCache = structuredClone(patch.promptCache);
    }
  }
  return {
    stateVersion: SESSION_RUNTIME_STATE_VERSION,
    ...(settings ? { settings } : {}),
    ...(goal ? { goal } : {}),
    ...(promptCache ? { promptCache } : {}),
    usage: projectRuntimeSessionUsage(events),
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
    if (fields.has("cacheRead")) {
      usage.totalCacheReadReports++;
      if (canonical.cacheReadTokens > 0) {
        usage.totalCacheHitCalls = (usage.totalCacheHitCalls ?? 0) + 1;
      }
    }
    if (fields.has("cacheWrite")) usage.totalCacheWriteReports++;
    if (fields.has("reasoning")) usage.totalReasoningReports++;
  }
  return usage;
}

function projectModelHistoryEvents(events: readonly RuntimeEvent[]): RuntimeModelHistoryEvent[] {
  return selectRuntimeEvents(events, runtimeEventHasModelHistoryEntry).map(({ event }) => event);
}

/**
 * Selects events matching `select`, indexed by their original position, while
 * detecting duplicate event IDs. The destructive rewind/branch truncation that
 * previously lived here has been removed (rewind is now a non-destructive fork),
 * so this is a pure filter + map.
 */
function selectRuntimeEvents<Event extends RuntimeEvent>(
  events: readonly RuntimeEvent[],
  select: (event: RuntimeEvent) => event is Event,
): Array<{ readonly eventIndex: number; readonly event: Event }> {
  const seenEventIds = new Set<string>();
  const projected: Array<{ readonly eventIndex: number; readonly event: Event }> = [];
  for (const [eventIndex, event] of events.entries()) {
    if (seenEventIds.has(event.eventId)) {
      throw new Error(`Runtime session projection contains duplicate event ID ${event.eventId}`);
    }
    if (select(event)) {
      projected.push({ eventIndex, event: structuredClone(event) });
    }
    seenEventIds.add(event.eventId);
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
