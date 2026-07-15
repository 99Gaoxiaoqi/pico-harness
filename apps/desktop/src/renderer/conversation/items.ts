import type { ConversationItemView } from "./types.js";

export function conversationItemKey(item: ConversationItemView): string {
  const kindPrefix = `${item.kind}:`;
  const stableId = item.id.startsWith(kindPrefix) ? item.id.slice(kindPrefix.length) : item.id;
  return `${item.kind}:${stableId}`;
}

/**
 * Earlier groups have higher authority. Persisted transcript entries should be
 * passed first so a durable completed state replaces equivalent live or
 * synthetic entries without moving in the transcript.
 */
export function mergeConversationItemGroups(
  ...groups: readonly (readonly ConversationItemView[])[]
): readonly ConversationItemView[] {
  const seen = new Set<string>();
  const merged: ConversationItemView[] = [];

  for (const group of groups) {
    for (const item of group) {
      const key = conversationItemKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }

  return merged;
}
