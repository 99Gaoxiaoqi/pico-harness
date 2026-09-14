import type { Message } from "./message.js";

interface ToolBatch {
  readonly endExclusive: number;
  readonly incompleteAtTail: boolean;
  readonly invalid: boolean;
}

function isToolResult(message: Message | undefined): message is Message & { toolCallId: string } {
  return message?.role === "user" && message.toolCallId !== undefined;
}

/**
 * True when a transcript ends in an incomplete/invalid assistant tool batch.
 * Tool IDs are scoped to one assistant message, so only its consecutive result
 * segment participates in the check.
 */
export function hasIncompleteToolExchange(messages: readonly Message[]): boolean {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;

    const ids = message.toolCalls.map((call) => call.id);
    const expected = new Set(ids);
    const invalid = ids.some((id) => id.length === 0) || expected.size !== ids.length;
    const seen = new Set<string>();
    let endExclusive = index + 1;
    while (endExclusive < messages.length && isToolResult(messages[endExclusive])) {
      const resultId = messages[endExclusive]!.toolCallId!;
      if (expected.has(resultId)) seen.add(resultId);
      endExclusive++;
    }
    const batch: ToolBatch = {
      endExclusive,
      incompleteAtTail: endExclusive === messages.length && seen.size < expected.size,
      invalid,
    };
    if (batch.incompleteAtTail || batch.invalid) return true;
    index = batch.endExclusive - 1;
  }
  return false;
}
