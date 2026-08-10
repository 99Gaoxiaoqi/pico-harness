import { createHash } from "node:crypto";
import type { Message, ToolCall } from "../schema/message.js";
import type { RuntimeCheckpointRecordedEvent, RuntimeEvent } from "./session-runtime-event.js";
import {
  claimKindForEvent,
  projectRuntimeModelMessage,
} from "./runtime-model-message.js";
import {
  computeCheckpointSourceDigest,
  CONTENT_DIGEST_V1_PREFIX,
} from "../context/runtime-compaction-checkpoint.js";
import type { RuntimeProjectionDiagnostic } from "./runtime-projection-diagnostics.js";
import { makeDiagnostic } from "./runtime-projection-diagnostics.js";

export interface RuntimeHistoryProjectionEntry {
  /** The immutable event that currently contributes this model-visible message. */
  readonly eventId: string;
  readonly message: Message;
}

/**
 * 投影结果：entries + 结构化诊断。
 * hard 诊断在 materializeRuntimeHistoryProjection 内已 throw（fail-closed），
 * 这里的 diagnostics 只含 soft 诊断（unclaimed_control_fact / partial_event_skipped）。
 */
export interface RuntimeHistoryProjection {
  readonly entries: RuntimeHistoryProjectionEntry[];
  readonly diagnostics: readonly RuntimeProjectionDiagnostic[];
}

export class RuntimeEventReadModelIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeEventReadModelIntegrityError";
  }
}

/**
 * Engine-owned pure read model for Session durable facts. The Runtime adapter
 * re-exports this implementation for existing callers, but no Runtime value
 * is imported by this module.
 */
export function projectRuntimeEventsToMessages(events: readonly RuntimeEvent[]): Message[] {
  return materializeRuntimeHistory(events);
}

export function materializeRuntimeHistory(events: readonly RuntimeEvent[]): Message[] {
  return materializeRuntimeHistoryEntries(events).map(({ message }) => message);
}

export function projectRuntimeEventsToMessageEntries(
  events: readonly RuntimeEvent[],
): RuntimeHistoryProjectionEntry[] {
  return materializeRuntimeHistoryEntries(events);
}

export function materializeRuntimeHistoryEntries(
  events: readonly RuntimeEvent[],
): RuntimeHistoryProjectionEntry[] {
  return materializeRuntimeHistoryProjection(events).entries;
}

/**
 * 带诊断的投影入口。hard 诊断仍 throw（fail-closed 不变）；soft 诊断收集到结果里。
 * 这是新增的主投影函数，其余三个旧函数委托它、签名不变——现有消费者零改动。
 */
export function materializeRuntimeHistoryProjection(events: readonly RuntimeEvent[]): RuntimeHistoryProjection {
  const diagnostics: RuntimeProjectionDiagnostic[] = [];
  const eventIndexes = new Map<string, number>();
  for (const [eventIndex, event] of events.entries()) {
    if (eventIndexes.has(event.eventId)) {
      throw new RuntimeEventReadModelIntegrityError(
        `Runtime history contains duplicate event ID ${event.eventId}`,
      );
    }
    eventIndexes.set(event.eventId, eventIndex);
  }

  const { projected, prefixDiagnostics } = materializePrefix(events, events.length, eventIndexes);
  diagnostics.push(...prefixDiagnostics);
  // assertToolCallPairing 检测的都是 hard 违规（配对错位/悬空/重复），仍直接 throw
  assertToolCallPairing(projected.map(({ message }) => message));
  return { entries: projected, diagnostics };
}

function materializePrefix(
  events: readonly RuntimeEvent[],
  endExclusive: number,
  eventIndexes: ReadonlyMap<string, number>,
): { projected: RuntimeHistoryProjectionEntry[]; prefixDiagnostics: RuntimeProjectionDiagnostic[] } {
  const prefixDiagnostics: RuntimeProjectionDiagnostic[] = [];
  const projected: RuntimeHistoryProjectionEntry[] = [];
  for (let eventIndex = 0; eventIndex < endExclusive; eventIndex++) {
    const event = events[eventIndex]!;
    // history.rewound handling removed: rewind is now a non-destructive fork and
    // no new rewound events are produced. A legacy rewound fact (if any) falls
    // through to the claim contract below and surfaces as an unclaimed control
    // fact diagnostic, which is harmless.
    if (event.kind === "context.checkpoint.recorded") {
      replaceProjectedPrefixWithCheckpoint(projected, event, eventIndexes, eventIndex);
      continue;
    }
    // claim coverage 契约：每个 kind 必须显式 claim，未知 kind 不再静默丢失
    const claim = claimKindForEvent(event);
    if (claim === undefined) {
      // 纵深防御：解码层已拦截 unknown_kind，投影层再防一道
      throw new RuntimeEventReadModelIntegrityError(
        `Runtime event ${event.eventId} has unsupported kind ${event.kind}`,
      );
    }
    if (claim === "message") {
      if (event.partial) {
        prefixDiagnostics.push(
          makeDiagnostic("partial_event_skipped", event.eventId, `partial ${event.kind}`),
        );
        continue;
      }
      if (event.visibility !== "model") {
        // transcript/internal 可见度的 message 事件不进 model 投影（control 语义）
        prefixDiagnostics.push(
          makeDiagnostic("unclaimed_control_fact", event.eventId, `${event.kind} visibility=${event.visibility}`),
        );
        continue;
      }
      const message = projectRuntimeModelMessage(event);
      if (!message) {
        throw new RuntimeEventReadModelIntegrityError(
          `Runtime event ${event.eventId} has no model projection`,
        );
      }
      projected.push({ eventId: event.eventId, message: cloneMessage(message) });
    } else {
      // claim === "control"：控制事实无 chat 行是正常的，产 soft 诊断
      prefixDiagnostics.push(
        makeDiagnostic("unclaimed_control_fact", event.eventId, event.kind),
      );
    }
  }
  return { projected, prefixDiagnostics };
}

function replaceProjectedPrefixWithCheckpoint(
  projected: RuntimeHistoryProjectionEntry[],
  checkpoint: RuntimeCheckpointRecordedEvent,
  eventIndexes: ReadonlyMap<string, number>,
  checkpointEventIndex: number,
): void {
  const throughProjectedIndex = findProjectedEventIndex(
    projected,
    checkpoint.data.throughEventId,
    eventIndexes,
    checkpointEventIndex,
    `Runtime checkpoint ${checkpoint.eventId}`,
  );
  const covered = projected.slice(0, throughProjectedIndex + 1);
  // 内容哈希校验(新格式 v1)或旧格式(eventId 序列哈希)兼容。
  const storedDigest = checkpoint.data.sourceDigest;
  const recomputedDigest = storedDigest.startsWith(CONTENT_DIGEST_V1_PREFIX)
    ? computeCheckpointSourceDigest(covered)
    : createHash("sha256").update(covered.map(({ eventId }) => eventId).join("\n")).digest("hex");
  if (
    checkpoint.data.coveredEventCount !== covered.length ||
    storedDigest !== recomputedDigest
  ) {
    throw new RuntimeEventReadModelIntegrityError(
      `Runtime checkpoint ${checkpoint.eventId} does not match its covered model prefix`,
    );
  }
  projected.splice(0, throughProjectedIndex + 1, {
    eventId: checkpoint.eventId,
    message: cloneMessage(checkpoint.data.summary),
  });
}

function findProjectedEventIndex(
  projected: readonly RuntimeHistoryProjectionEntry[],
  eventId: string,
  eventIndexes: ReadonlyMap<string, number>,
  currentEventIndex: number,
  referenceKind: string,
): number {
  const projectedIndex = projected.findIndex((entry) => entry.eventId === eventId);
  if (projectedIndex !== -1) return projectedIndex;
  if (eventIndexes.has(eventId) && eventIndexes.get(eventId)! < currentEventIndex) {
    throw new RuntimeEventReadModelIntegrityError(
      `${referenceKind} references event ${eventId}, but it is not in the current model projection`,
    );
  }
  throw new RuntimeEventReadModelIntegrityError(
    `${referenceKind} references an unknown prior event ${eventId}`,
  );
}

function assertToolCallPairing(messages: readonly Message[]): void {
  let pending: Map<string, ToolCall> | undefined;

  for (const [historyIndex, message] of messages.entries()) {
    assertMessageToolFields(message, historyIndex);

    if (pending) {
      if (message.role !== "user" || message.toolCallId === undefined) {
        throw new RuntimeEventReadModelIntegrityError(
          "Assistant tool-call batch is missing one or more consecutive observations",
        );
      }
      if (!pending.delete(message.toolCallId)) {
        throw new RuntimeEventReadModelIntegrityError(
          `Tool result ${message.toolCallId} does not match its preceding tool-call batch`,
        );
      }
      if (pending.size === 0) pending = undefined;
      continue;
    }

    if (message.toolCallId !== undefined) {
      throw new RuntimeEventReadModelIntegrityError(
        `Tool result ${message.toolCallId} has no preceding tool-call batch`,
      );
    }
    if (!message.toolCalls || message.toolCalls.length === 0) continue;

    pending = new Map(message.toolCalls.map((call) => [call.id, call]));
    if (pending.size !== message.toolCalls.length) {
      throw new RuntimeEventReadModelIntegrityError(
        "Assistant tool-call batch contains duplicate call IDs",
      );
    }
  }

  if (pending && pending.size > 0) {
    throw new RuntimeEventReadModelIntegrityError(
      `Assistant tool-call batch is missing results for ${[...pending.keys()].join(", ")}`,
    );
  }
}

function assertMessageToolFields(message: Message, historyIndex: number): void {
  if (message.toolCalls !== undefined) {
    if (message.role !== "assistant") {
      throw new RuntimeEventReadModelIntegrityError(
        `History message ${historyIndex} has tool calls outside an assistant batch`,
      );
    }
    if (!Array.isArray(message.toolCalls) || !message.toolCalls.every(isToolCall)) {
      throw new RuntimeEventReadModelIntegrityError(
        `History message ${historyIndex} has invalid tool calls`,
      );
    }
  }
  if (message.toolCallId !== undefined && !isNonEmptyString(message.toolCallId)) {
    throw new RuntimeEventReadModelIntegrityError(
      `History message ${historyIndex} has an invalid tool result ID`,
    );
  }
  if (message.toolCalls !== undefined && message.toolCallId !== undefined) {
    throw new RuntimeEventReadModelIntegrityError(
      `History message ${historyIndex} cannot contain both tool calls and a tool result`,
    );
  }
}

function cloneMessage(message: Message): Message {
  try {
    return structuredClone(message);
  } catch {
    throw new RuntimeEventReadModelIntegrityError("Runtime message cannot be deep-cloned");
  }
}

function isToolCall(value: unknown): value is ToolCall {
  return (
    isRecord(value) &&
    isNonEmptyString(value["id"]) &&
    isNonEmptyString(value["name"]) &&
    typeof value["arguments"] === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
