import type { ConversationItemView } from "./types.js";

export const MAX_LIVE_REASONING_CHARS = 64 * 1024;
export const MAX_LIVE_ASSISTANT_CHARS = 64 * 1024;
const LIVE_REASONING_TRUNCATION = "\n…[实时思考内容已截断]";
const LIVE_ASSISTANT_TRUNCATION = "\n…[实时回答内容已截断]";

export interface LiveReasoningUpdate {
  readonly runId: string;
  readonly operation: "append" | "complete" | "clear";
  readonly streamId?: string;
  readonly turnId?: string;
  readonly delta?: string;
  readonly truncated?: boolean;
  readonly at?: number;
}

export interface LiveAssistantUpdate {
  readonly runId: string;
  readonly operation: "append" | "complete" | "clear";
  readonly streamId?: string;
  readonly turnId?: string;
  readonly delta?: string;
  readonly truncated?: boolean;
  readonly at?: number;
}

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

/** Preserve only the still-live item for the exact active Run across transcript hydration. */
export function mergeHydratedConversationItems(
  hydrated: readonly ConversationItemView[],
  current: readonly ConversationItemView[],
  activeRunId: string | undefined,
): readonly ConversationItemView[] {
  if (!activeRunId) return hydrated;
  const currentDurableKeys = new Set(
    current
      .filter((item) => item.kind === "thinking" && item.streaming !== true)
      .map(conversationItemKey),
  );
  // A live Run's durable thinking can only appear after that Run's persisted user message.
  // On first hydration this prevents an older turn with the same prefix from consuming live text.
  const activeTurnStart = hydrated.findLastIndex((item) => item.kind === "userMessage");
  const newlyHydratedThinking = hydrated
    .filter(
      (item, index) =>
        activeTurnStart >= 0 &&
        index > activeTurnStart &&
        item.kind === "thinking" &&
        item.streaming !== true &&
        item.text.trim() &&
        !currentDurableKeys.has(conversationItemKey(item)),
    )
    .filter(
      (item): item is Extract<ConversationItemView, { readonly kind: "thinking" }> =>
        item.kind === "thinking",
    );
  const live = current.filter(
    (item) =>
      item.kind === "thinking" &&
      item.streaming === true &&
      item.runId === activeRunId &&
      !newlyHydratedThinking.some((durable) => {
        if (item.runId && item.turnId && durable.runId && durable.turnId) {
          return item.runId === durable.runId && item.turnId === durable.turnId;
        }
        if (item.truncated !== true) return false;
        const livePrefix = liveReasoningPrefix(item);
        return Boolean(livePrefix) && durable.text.trim().startsWith(livePrefix);
      }),
  );
  const liveAssistant = current.filter(
    (item): item is Extract<ConversationItemView, { readonly kind: "assistantMessage" }> =>
      item.kind === "assistantMessage" && item.streaming === true && item.runId === activeRunId,
  );
  const retainedAssistant = liveAssistant.filter(
    (item) =>
      !hydrated.some(
        (durable) =>
          durable.kind === "assistantMessage" &&
          durable.streaming !== true &&
          Boolean(item.turnId) &&
          durable.runId === item.runId &&
          durable.turnId === item.turnId,
      ),
  );
  return mergeConversationItemGroups(hydrated, live, retainedAssistant);
}

/** Apply a best-effort Desktop answer update without turning it into durable transcript. */
export function applyLiveAssistantUpdate(
  items: readonly ConversationItemView[],
  update: LiveAssistantUpdate,
): readonly ConversationItemView[] {
  if (
    items.some(
      (item) =>
        item.kind === "assistantMessage" &&
        item.streaming === true &&
        item.runId !== undefined &&
        item.runId !== update.runId,
    )
  ) {
    return items;
  }
  const matches = (item: ConversationItemView): boolean =>
    item.kind === "assistantMessage" &&
    item.runId === update.runId &&
    (update.streamId ? item.id === update.streamId : true);

  if (update.operation === "clear" || update.operation === "complete") {
    let matched = false;
    const terminal = items.map((item) => {
      if (!matches(item) || item.kind !== "assistantMessage") return item;
      matched = true;
      return {
        ...item,
        streaming: false,
        liveTerminal: true,
        ...(update.streamId ? {} : { terminalRun: true }),
        ...(update.operation === "clear" ? { text: "", cleared: true } : {}),
      };
    });
    if (matched) return terminal;
    return items;
  }
  if (!update.streamId || !update.delta) return items;

  if (
    update.turnId &&
    items.some(
      (item) =>
        item.kind === "assistantMessage" &&
        item.streaming !== true &&
        item.runId === update.runId &&
        item.turnId === update.turnId,
    )
  ) {
    return items;
  }

  if (
    items.some(
      (item) =>
        item.kind === "assistantMessage" &&
        item.runId === update.runId &&
        item.liveTerminal === true &&
        (item.terminalRun === true || item.id === update.streamId),
    )
  ) {
    return items;
  }

  const index = items.findIndex(
    (item) =>
      item.kind === "assistantMessage" &&
      item.runId === update.runId &&
      item.id === update.streamId,
  );
  if (index < 0) {
    const bounded = boundLiveAssistant(update.delta, update.truncated === true);
    return [
      ...items,
      {
        id: update.streamId,
        kind: "assistantMessage",
        text: bounded.text,
        streaming: true,
        runId: update.runId,
        ...(update.turnId ? { turnId: update.turnId } : {}),
        ...(update.at ? { at: update.at } : {}),
        ...(bounded.truncated ? { truncated: true } : {}),
      },
    ];
  }
  const current = items[index];
  if (
    !current ||
    current.kind !== "assistantMessage" ||
    current.truncated ||
    current.streaming === false
  ) {
    return items;
  }
  const bounded = boundLiveAssistant(`${current.text}${update.delta}`, update.truncated === true);
  return items.map((item, itemIndex) =>
    itemIndex === index
      ? {
          ...current,
          text: bounded.text,
          streaming: true,
          ...(bounded.truncated ? { truncated: true } : {}),
        }
      : item,
  );
}

/** Apply a best-effort Desktop reasoning update without turning it into durable transcript. */
export function applyLiveReasoningUpdate(
  items: readonly ConversationItemView[],
  update: LiveReasoningUpdate,
): readonly ConversationItemView[] {
  if (
    items.some(
      (item) =>
        item.kind === "thinking" &&
        item.streaming === true &&
        item.runId !== undefined &&
        item.runId !== update.runId,
    )
  ) {
    return items;
  }
  const matches = (item: ConversationItemView): boolean =>
    item.kind === "thinking" &&
    item.runId === update.runId &&
    (update.streamId ? item.id === update.streamId : true);

  if (update.operation === "clear" || update.operation === "complete") {
    let matched = false;
    const terminal = items.map((item) => {
      if (!matches(item) || item.kind !== "thinking") return item;
      matched = true;
      return {
        ...item,
        streaming: false,
        liveTerminal: true,
        ...(update.streamId ? {} : { terminalRun: true }),
        ...(update.operation === "clear" ? { text: "", cleared: true } : {}),
      };
    });
    if (matched) return terminal;
    return [
      ...terminal,
      {
        id: update.streamId ?? `thinking:live-terminal:${update.runId}`,
        kind: "thinking",
        text: "",
        streaming: false,
        runId: update.runId,
        liveTerminal: true,
        ...(update.streamId ? {} : { terminalRun: true }),
        cleared: true,
        ...(update.at ? { at: update.at } : {}),
      },
    ];
  }
  if (!update.streamId || !update.delta) return items;

  if (
    items.some(
      (item) =>
        item.kind === "thinking" &&
        item.runId === update.runId &&
        item.liveTerminal === true &&
        (item.terminalRun === true || item.id === update.streamId),
    )
  ) {
    return items;
  }

  const index = items.findIndex(
    (item) =>
      item.kind === "thinking" && item.runId === update.runId && item.id === update.streamId,
  );
  if (index < 0) {
    const bounded = boundLiveReasoning(update.delta, update.truncated === true);
    return [
      ...items,
      {
        id: update.streamId,
        kind: "thinking",
        text: bounded.text,
        streaming: true,
        runId: update.runId,
        ...(update.turnId ? { turnId: update.turnId } : {}),
        ...(update.at ? { at: update.at } : {}),
        ...(bounded.truncated ? { truncated: true } : {}),
      },
    ];
  }
  const current = items[index];
  if (!current || current.kind !== "thinking" || current.truncated || current.streaming === false)
    return items;
  const bounded = boundLiveReasoning(`${current.text}${update.delta}`, update.truncated === true);
  return items.map((item, itemIndex) =>
    itemIndex === index
      ? {
          ...current,
          text: bounded.text,
          streaming: true,
          ...(bounded.truncated ? { truncated: true } : {}),
        }
      : item,
  );
}

function boundLiveReasoning(
  value: string,
  forceTruncated = false,
): { readonly text: string; readonly truncated: boolean } {
  if (!forceTruncated && value.length <= MAX_LIVE_REASONING_CHARS) {
    return { text: value, truncated: false };
  }
  const contentLimit = Math.max(0, MAX_LIVE_REASONING_CHARS - LIVE_REASONING_TRUNCATION.length);
  return {
    text: `${value.slice(0, contentLimit)}${LIVE_REASONING_TRUNCATION}`,
    truncated: true,
  };
}

function boundLiveAssistant(
  value: string,
  forceTruncated = false,
): { readonly text: string; readonly truncated: boolean } {
  if (!forceTruncated && value.length <= MAX_LIVE_ASSISTANT_CHARS) {
    return { text: value, truncated: false };
  }
  const contentLimit = Math.max(0, MAX_LIVE_ASSISTANT_CHARS - LIVE_ASSISTANT_TRUNCATION.length);
  return {
    text: `${value.slice(0, contentLimit)}${LIVE_ASSISTANT_TRUNCATION}`,
    truncated: true,
  };
}

function liveReasoningPrefix(item: ConversationItemView & { readonly kind: "thinking" }): string {
  const text =
    item.truncated === true && item.text.endsWith(LIVE_REASONING_TRUNCATION)
      ? item.text.slice(0, -LIVE_REASONING_TRUNCATION.length)
      : item.text;
  return text.trim();
}
