import type { MobileConversationItem, MobileRealtimeEvent } from "@pico/protocol";

export const MAX_MOBILE_LIVE_CHARS = 64 * 1024;
const LIVE_TRUNCATION = "\n…[实时内容已截断]";

export interface MobileLiveConversationItem {
  readonly id: string;
  readonly kind: "thinking" | "assistantMessage";
  readonly content: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly streaming: boolean;
  readonly terminal?: true;
  readonly truncated?: true;
}

export type MobileRenderedConversationItem = MobileConversationItem | MobileLiveConversationItem;

type MobileLiveEvent = Extract<MobileRealtimeEvent, { readonly type: "live" }>;

export function applyMobileLiveEvent(
  current: readonly MobileLiveConversationItem[],
  event: MobileLiveEvent,
  durable: readonly MobileConversationItem[],
): readonly MobileLiveConversationItem[] {
  const { item, runId } = event;
  const matches = (candidate: MobileLiveConversationItem): boolean =>
    candidate.kind === item.kind &&
    candidate.runId === runId &&
    (item.streamId ? candidate.id === item.streamId : true);

  if (item.operation === "clear") return current.filter((candidate) => !matches(candidate));
  if (item.operation === "complete") {
    return current.map((candidate) =>
      matches(candidate) ? { ...candidate, streaming: false, terminal: true } : candidate,
    );
  }
  if (!item.streamId || !item.delta) return current;
  if (hasDurableIdentity(durable, item.kind, runId, item.turnId)) {
    return current.filter((candidate) => !matches(candidate));
  }

  const index = current.findIndex(matches);
  if (index < 0) {
    const bounded = boundLiveContent(item.delta, item.truncated === true);
    return [
      ...current,
      {
        id: item.streamId,
        kind: item.kind,
        content: bounded.content,
        runId,
        ...(item.turnId ? { turnId: item.turnId } : {}),
        streaming: true,
        ...(bounded.truncated ? { truncated: true } : {}),
      },
    ];
  }

  const existing = current[index];
  if (!existing || existing.terminal || existing.truncated) return current;
  const bounded = boundLiveContent(`${existing.content}${item.delta}`, item.truncated === true);
  return current.map((candidate, candidateIndex) =>
    candidateIndex === index
      ? {
          ...existing,
          content: bounded.content,
          ...(bounded.truncated ? { truncated: true } : {}),
        }
      : candidate,
  );
}

export function reconcileMobileLiveItems(
  durable: readonly MobileConversationItem[],
  live: readonly MobileLiveConversationItem[],
): readonly MobileLiveConversationItem[] {
  return live.filter((item) => !hasDurableIdentity(durable, item.kind, item.runId, item.turnId));
}

export function mergeMobileConversationItems(
  durable: readonly MobileConversationItem[],
  live: readonly MobileLiveConversationItem[],
): readonly MobileRenderedConversationItem[] {
  return [...durable, ...reconcileMobileLiveItems(durable, live).filter((item) => item.content)];
}

function hasDurableIdentity(
  durable: readonly MobileConversationItem[],
  kind: MobileLiveConversationItem["kind"],
  runId: string,
  turnId: string | undefined,
): boolean {
  if (!turnId) return false;
  return durable.some(
    (item) => item.kind === kind && item.runId === runId && item.turnId === turnId,
  );
}

function boundLiveContent(
  value: string,
  forceTruncated: boolean,
): { readonly content: string; readonly truncated: boolean } {
  if (!forceTruncated && value.length <= MAX_MOBILE_LIVE_CHARS) {
    return { content: value, truncated: false };
  }
  const limit = Math.max(0, MAX_MOBILE_LIVE_CHARS - LIVE_TRUNCATION.length);
  return { content: `${value.slice(0, limit)}${LIVE_TRUNCATION}`, truncated: true };
}
