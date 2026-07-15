import type { Message, ToolCall } from "../schema/message.js";
import type { RuntimeEvent } from "./runtime-event.js";

interface ProjectedMessage {
  readonly eventIndex: number;
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
  const eventIndexes = new Map<string, number>();
  const projected: ProjectedMessage[] = [];

  for (const [eventIndex, event] of events.entries()) {
    if (eventIndexes.has(event.eventId)) {
      throw new RuntimeEventReadModelIntegrityError(
        `Runtime history contains duplicate event ID ${event.eventId}`,
      );
    }

    if (event.kind === "history.rewound") {
      rewindProjectedMessages(projected, event.data.throughEventId, eventIndexes);
    } else if (
      event.kind === "message.committed" &&
      event.visibility === "model" &&
      !event.partial
    ) {
      projected.push({ eventIndex, message: cloneMessage(event.data.message) });
    }

    eventIndexes.set(event.eventId, eventIndex);
  }

  const messages = projected.map(({ message }) => message);
  assertToolCallPairing(messages);
  return messages;
}

function rewindProjectedMessages(
  projected: ProjectedMessage[],
  throughEventId: string | undefined,
  eventIndexes: ReadonlyMap<string, number>,
): void {
  if (throughEventId === undefined) {
    projected.length = 0;
    return;
  }

  const throughEventIndex = eventIndexes.get(throughEventId);
  if (throughEventIndex === undefined) {
    throw new RuntimeEventReadModelIntegrityError(
      `Runtime history rewind references an unknown prior event ${throughEventId}`,
    );
  }

  const firstRemoved = projected.findIndex(({ eventIndex }) => eventIndex > throughEventIndex);
  if (firstRemoved !== -1) projected.splice(firstRemoved);
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
