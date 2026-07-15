import type { Message, ToolCall } from "../schema/message.js";
import type {
  RuntimeCheckpointRecordedEvent,
  RuntimeEvent,
  RuntimeRollingCheckpointData,
} from "./runtime-event.js";

export interface RuntimeHistoryProjectionEntry {
  /** The immutable event that currently contributes this model-visible message. */
  readonly eventId: string;
  readonly message: Message;
}

export class RuntimeEventReadModelIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeEventReadModelIntegrityError";
  }
}

/**
 * Projects the current model-visible history from immutable runtime facts.
 * `history.rewound` changes this projection only; the source events remain intact.
 */
export function projectRuntimeEventsToMessages(events: readonly RuntimeEvent[]): Message[] {
  return materializeRuntimeHistory(events);
}

export function materializeRuntimeHistory(events: readonly RuntimeEvent[]): Message[] {
  return materializeRuntimeHistoryEntries(events).map(({ message }) => message);
}

/**
 * Returns the model-history projection together with the immutable event IDs that
 * currently own each entry. Checkpoint summaries are owned by their checkpoint event.
 */
export function projectRuntimeEventsToMessageEntries(
  events: readonly RuntimeEvent[],
): RuntimeHistoryProjectionEntry[] {
  return materializeRuntimeHistoryEntries(events);
}

export function materializeRuntimeHistoryEntries(
  events: readonly RuntimeEvent[],
): RuntimeHistoryProjectionEntry[] {
  const knownEventIds = new Set<string>();
  const projected: RuntimeHistoryProjectionEntry[] = [];

  for (const event of events) {
    if (knownEventIds.has(event.eventId)) {
      throw new RuntimeEventReadModelIntegrityError(
        `Runtime history contains duplicate event ID ${event.eventId}`,
      );
    }

    if (event.kind === "history.rewound") {
      rewindProjectedMessages(projected, event.data.throughEventId, knownEventIds, event.eventId);
    } else if (event.kind === "context.checkpoint.recorded" && isRollingCheckpoint(event)) {
      replaceProjectedPrefixWithCheckpoint(projected, event, knownEventIds);
    } else if (
      event.kind === "message.committed" &&
      event.visibility === "model" &&
      !event.partial
    ) {
      projected.push({ eventId: event.eventId, message: cloneMessage(event.data.message) });
    }

    knownEventIds.add(event.eventId);
  }

  assertToolCallPairing(projected.map(({ message }) => message));
  return projected;
}

function rewindProjectedMessages(
  projected: RuntimeHistoryProjectionEntry[],
  throughEventId: string | undefined,
  knownEventIds: ReadonlySet<string>,
  rewindEventId: string,
): void {
  if (throughEventId === undefined) {
    projected.length = 0;
    return;
  }

  const throughProjectedIndex = findProjectedEventIndex(
    projected,
    throughEventId,
    knownEventIds,
    `Runtime history rewind ${rewindEventId}`,
  );
  projected.splice(throughProjectedIndex + 1);
}

function replaceProjectedPrefixWithCheckpoint(
  projected: RuntimeHistoryProjectionEntry[],
  checkpoint: RuntimeCheckpointRecordedEvent & { readonly data: RuntimeRollingCheckpointData },
  knownEventIds: ReadonlySet<string>,
): void {
  const throughProjectedIndex = findProjectedEventIndex(
    projected,
    checkpoint.data.throughEventId,
    knownEventIds,
    `Runtime checkpoint ${checkpoint.eventId}`,
  );
  projected.splice(0, throughProjectedIndex + 1, {
    eventId: checkpoint.eventId,
    message: cloneMessage(checkpoint.data.summary),
  });
}

function findProjectedEventIndex(
  projected: readonly RuntimeHistoryProjectionEntry[],
  eventId: string,
  knownEventIds: ReadonlySet<string>,
  referenceKind: string,
): number {
  const projectedIndex = projected.findIndex((entry) => entry.eventId === eventId);
  if (projectedIndex !== -1) return projectedIndex;
  if (knownEventIds.has(eventId)) {
    throw new RuntimeEventReadModelIntegrityError(
      `${referenceKind} references event ${eventId}, but it is not in the current model projection`,
    );
  }
  throw new RuntimeEventReadModelIntegrityError(
    `${referenceKind} references an unknown prior event ${eventId}`,
  );
}

function isRollingCheckpoint(
  event: RuntimeCheckpointRecordedEvent,
): event is RuntimeCheckpointRecordedEvent & { readonly data: RuntimeRollingCheckpointData } {
  return event.data.throughEventId !== undefined && event.data.summary !== undefined;
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
