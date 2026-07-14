import type { Message } from "../schema/message.js";
import { estimateMessageTokens } from "./context-budget.js";

export interface SafeCompactionCut {
  /** Number of raw Session messages folded into the compacted prefix. */
  readonly compactedCount: number;
  /** Estimated tokens left in the retained suffix. */
  readonly retainedTokens: number;
}

interface ToolBatch {
  readonly start: number;
  readonly endExclusive: number;
  readonly incompleteAtTail: boolean;
  readonly invalid: boolean;
}

function isToolResult(message: Message | undefined): message is Message & { toolCallId: string } {
  return message?.role === "user" && message.toolCallId !== undefined;
}

function isOrdinaryUser(message: Message | undefined): boolean {
  return message?.role === "user" && message.toolCallId === undefined;
}

/**
 * ToolCall IDs are only unique inside one assistant batch. Some providers
 * restart their IDs on every response, so protocol inspection must stay local
 * to the consecutive ToolResult segment following that assistant message.
 */
function inspectToolBatches(messages: readonly Message[]): ToolBatch[] {
  const batches: ToolBatch[] = [];
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
    batches.push({
      start: index,
      endExclusive,
      incompleteAtTail: endExclusive === messages.length && seen.size < expected.size,
      invalid,
    });
    index = endExclusive - 1;
  }
  return batches;
}

export function hasIncompleteToolExchange(messages: readonly Message[]): boolean {
  return inspectToolBatches(messages).some((batch) => batch.incompleteAtTail || batch.invalid);
}

/**
 * A cut is the first raw index of the retained suffix. It may follow a complete
 * parallel tool batch, but may not split that batch or leave a ToolResult at
 * the beginning of the retained suffix.
 */
export function isSafeCompactionCut(messages: readonly Message[], cut: number): boolean {
  if (cut <= 0 || cut >= messages.length) return false;

  const batches = inspectToolBatches(messages);
  if (batches.some((batch) => batch.incompleteAtTail || batch.invalid)) return false;

  const previous = messages[cut - 1];
  const next = messages[cut];
  if (isOrdinaryUser(previous)) return false;
  if (previous?.role === "assistant" && (previous.toolCalls?.length ?? 0) > 0) return false;
  if (isToolResult(next)) return false;
  return !batches.some((batch) => batch.start < cut && cut < batch.endExclusive);
}

/**
 * Find the newest safe prefix that retains at least targetRetainedTokens.
 * The target is soft: a large tool exchange can make the retained suffix
 * larger, because protocol completeness wins over the token target.
 */
export function findSafeCompactionCut(
  messages: readonly Message[],
  targetRetainedTokens: number,
): SafeCompactionCut | undefined {
  if (messages.length < 2 || hasIncompleteToolExchange(messages)) return undefined;
  const target = Math.max(1, targetRetainedTokens);
  let retainedTokens = 0;
  for (let cut = messages.length - 1; cut >= 1; cut--) {
    retainedTokens += estimateMessageTokens(messages[cut]!);
    if (retainedTokens < target) continue;
    if (isSafeCompactionCut(messages, cut)) {
      return { compactedCount: cut, retainedTokens };
    }
  }
  return undefined;
}
