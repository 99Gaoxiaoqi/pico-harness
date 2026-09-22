import { type Message } from "@pico/core";
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
  readonly incomplete: boolean;
  readonly invalid: boolean;
}

function isToolResult(message: Message | undefined): message is Message & { toolCallId: string } {
  return message?.role === "user" && message.toolCallId !== undefined;
}

function isOrdinaryUser(message: Message | undefined): boolean {
  return message?.role === "user" && message.toolCallId === undefined;
}

/** Tool-call IDs are scoped to one assistant batch, not the entire history. */
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
      incomplete: seen.size < expected.size,
      invalid,
    });
    index = endExclusive - 1;
  }
  return batches;
}

export { hasIncompleteToolExchange } from "@pico/core";

/** A retained suffix may not begin or end in the middle of a tool exchange. */
export function isSafeCompactionCut(messages: readonly Message[], cut: number): boolean {
  if (cut <= 0 || cut > messages.length) return false;

  const batches = inspectToolBatches(messages);
  if (batches.some((batch) => batch.invalid || (batch.incomplete && batch.start < cut)))
    return false;

  const previous = messages[cut - 1];
  const next = messages[cut];
  if (previous?.role === "assistant" && (previous.toolCalls?.length ?? 0) > 0) return false;
  if (isToolResult(next)) return false;
  return !batches.some((batch) => batch.start < cut && cut < batch.endExclusive);
}

/** Finds the newest safe prefix while retaining at least the requested token budget. */
export function findSafeCompactionCut(
  messages: readonly Message[],
  targetRetainedTokens: number,
  maxCoveredCount = messages.length,
): SafeCompactionCut | undefined {
  if (messages.length === 0) return undefined;
  const target = Math.max(0, targetRetainedTokens);
  // Live steering remains verbatim in the successor suffix. Prior-turn steering
  // may be summarized once a newer ordinary user task has begun.
  const anchorIndex = messages.findLastIndex(
    (message) => isOrdinaryUser(message) && !message.providerData?.["picoKind"],
  );
  // A textual checkpoint cannot carry the current user image. Keep that full
  // message and the following exchange in the uncompressed suffix.
  if (anchorIndex >= 0 && messages[anchorIndex]?.images?.length) {
    maxCoveredCount = Math.min(maxCoveredCount, anchorIndex);
  }
  const pinnedIndex = messages.findIndex(
    (message, index) => index > anchorIndex && message.providerData?.["picoKind"] === "steer",
  );
  let retainedTokens = 0;
  for (let cut = messages.length; cut >= 1; cut--) {
    if (cut < messages.length) retainedTokens += estimateMessageTokens(messages[cut]!);
    if (cut > maxCoveredCount || retainedTokens < target || (pinnedIndex >= 0 && cut > pinnedIndex))
      continue;
    if (isSafeCompactionCut(messages, cut)) {
      return { compactedCount: cut, retainedTokens };
    }
  }
  return undefined;
}
