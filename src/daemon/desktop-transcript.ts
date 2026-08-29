import { createHash } from "node:crypto";
import type { SessionHydrationSnapshot } from "../engine/session-runtime.js";
import type { ToolResultEnvelope } from "../engine/tool-result-contract.js";
import {
  projectTranscriptEvents,
  type TranscriptToolCallStatus,
} from "../presentation/transcript-event-store.js";
import { hydrateCanonicalTranscriptEvents } from "../presentation/transcript-tool-result-hydration.js";
import type { RuntimeEventStoreEntry } from "../storage/runtime-event-store-contracts.js";
import {
  projectRuntimeSessionSequencedMessageEntries,
  projectRuntimeSessionState,
  projectRuntimeSessionModelToolResultEntries,
  projectRuntimeSessionTranscriptEventEntries,
} from "../engine/session-runtime-projection.js";
import { isMessageHiddenFromTranscript } from "../schema/message.js";
import { isAgentGraphSupervisorToolName } from "../agent-graph/core/tool-names.js";
import {
  MAX_RUNTIME_FRAME_BYTES,
  type JsonObject,
  type RuntimeConversationItem,
  type RuntimeTranscriptCursor,
  type RuntimeTranscriptFragment,
  type RuntimeToolResultEnvelope,
} from "./protocol.js";

const DEFAULT_TRANSCRIPT_PAGE_BYTES = MAX_RUNTIME_FRAME_BYTES - 64 * 1024;

export interface RuntimeTranscriptPage {
  readonly items: readonly RuntimeConversationItem[];
  readonly fragments?: readonly RuntimeTranscriptFragment[];
  readonly nextCursor?: RuntimeTranscriptCursor;
  readonly nextBefore?: string;
  readonly revision: string;
}

export interface RuntimeTranscriptProjectionOptions {
  readonly cursor?: RuntimeTranscriptCursor;
  readonly before?: string;
  readonly limit?: number;
  readonly expectedRevision?: string;
  readonly maxBytes?: number;
  /**
   * 源账本水位(票 04):kind 切片读取代全量读后,revision 的
   * persistenceSequence 不能取切片末条,必须显式传入全会话水位
   * (revision 即该水位的字符串形态,窗口无关);缺省时回退 entries
   * 末条 sequence(全量读口径)。
   */
  readonly persistenceSequence?: number;
}

type RuntimeTranscriptSnapshot = Pick<
  SessionHydrationSnapshot,
  | "persistenceSequence"
  | "sessionId"
  | "messages"
  | "messageSequences"
  | "transcriptEvents"
  | "transcriptEventSequences"
  | "runtime"
> & {
  readonly messageRunIds?: readonly (string | undefined)[];
  readonly messageTurnIds?: readonly (string | undefined)[];
  readonly toolResults: readonly SequencedToolResultEnvelope[];
};

interface SequencedToolResultEnvelope {
  readonly sequence: number;
  readonly eventId: string;
  readonly envelope: ToolResultEnvelope;
}

/** Builds the Desktop transcript read model directly from canonical RuntimeEvent facts. */
export function projectRuntimeTranscriptEntries(
  sessionId: string,
  entries: readonly RuntimeEventStoreEntry[],
  options: RuntimeTranscriptProjectionOptions,
): RuntimeTranscriptPage {
  const events = entries.map(({ event }) => event);
  const messages = projectRuntimeSessionSequencedMessageEntries(entries);
  const transcript = projectRuntimeSessionTranscriptEventEntries(entries);
  return projectRuntimeTranscript(
    {
      persistenceSequence: options.persistenceSequence ?? entries.at(-1)?.sequence ?? null,
      sessionId,
      messages: messages.map(({ message }) => message),
      messageSequences: messages.map(({ sequence }) => sequence),
      messageRunIds: messages.map(({ runId }) => runId),
      messageTurnIds: messages.map(({ turnId }) => turnId),
      transcriptEvents: transcript.map(({ event }) => event),
      transcriptEventSequences: transcript.map(({ sequence }) => sequence),
      toolResults: projectRuntimeSessionModelToolResultEntries(entries),
      runtime: projectRuntimeSessionState(events),
    },
    options,
  );
}

export function projectRuntimeTranscript(
  snapshot: RuntimeTranscriptSnapshot,
  options: RuntimeTranscriptProjectionOptions,
): RuntimeTranscriptPage {
  const orderedItems = projectVisibleItems(snapshot);
  const currentRevision = transcriptRevision(snapshot);
  const cursor =
    options.cursor ?? decodeOptionalCursor(options.before, currentRevision, orderedItems);
  if (
    cursor &&
    (cursor.position > cursor.throughTranscriptSequence ||
      (snapshot.persistenceSequence !== null &&
        cursor.throughTranscriptSequence > snapshot.persistenceSequence))
  ) {
    throw new TranscriptRevisionConflict(cursor.revision, currentRevision);
  }
  const revision = cursor?.revision ?? currentRevision;
  if (
    options.expectedRevision !== undefined &&
    options.expectedRevision !== (cursor?.revision ?? currentRevision)
  ) {
    throw new TranscriptRevisionConflict(options.expectedRevision, currentRevision);
  }

  const limit = normalizeLimit(options.limit);
  const throughTranscriptSequence =
    cursor?.throughTranscriptSequence ?? snapshot.persistenceSequence;
  const items = orderedItems.filter(
    (item) => throughTranscriptSequence === null || item.sequence <= throughTranscriptSequence,
  );
  return selectPage(
    items,
    cursor,
    limit,
    revision,
    throughTranscriptSequence ?? 0,
    normalizeMaxBytes(options.maxBytes),
  );
}

export class TranscriptRevisionConflict extends Error {
  constructor(
    readonly expectedRevision: string,
    readonly currentRevision: string,
  ) {
    super("Session transcript revision changed");
    this.name = "TranscriptRevisionConflict";
  }
}

function projectVisibleItems(snapshot: RuntimeTranscriptSnapshot): OrderedConversationItem[] {
  const structured = projectStructuredItems(snapshot);
  const structuredItems = structured.items;
  const structuredThinkingMatches = matchStructuredThinkingMessages(snapshot, structuredItems);
  const structuredThinkingPlacements = new Map<
    string,
    {
      readonly sequence: number;
      readonly ordinal: number;
      readonly runId?: string;
      readonly turnId?: string;
    }
  >();
  const items: OrderedConversationItem[] = [];
  let ordinal = 0;

  const append = (item: RuntimeConversationItem, sequence: number): void => {
    items.push({ item, sequence, ordinal: transcriptItemOrdinal(ordinal++) });
  };

  snapshot.messages.forEach((message, messageIndex) => {
    if (
      message.role === "system" ||
      message.toolCallId !== undefined ||
      isMessageHiddenFromTranscript(message)
    ) {
      return;
    }

    const desktopDisplayText =
      message.role === "user" && message.providerData?.["picoKind"] === "desktop_user_input"
        ? message.providerData["displayText"]
        : undefined;
    const content =
      typeof desktopDisplayText === "string" && desktopDisplayText.trim()
        ? desktopDisplayText.trim()
        : message.content.trim();
    const sequence = snapshot.messageSequences[messageIndex] ?? messageIndex + 1;
    const runId = snapshot.messageRunIds?.[messageIndex];
    const turnId = snapshot.messageTurnIds?.[messageIndex];
    const reasoningIdentity = runId && turnId ? { runId, turnId } : {};
    if (message.role === "user") {
      if (content) {
        append(
          {
            id: stableItemId(snapshot.sessionId, sequence, "user", content),
            kind: "userMessage",
            content,
          },
          sequence,
        );
      }
      return;
    }

    const reasoning = message.role === "assistant" ? message.reasoning?.trim() : undefined;
    if (reasoning) {
      const structuredMatch = structuredThinkingMatches.get(messageIndex);
      if (structuredMatch) {
        // Runtime message commits happen before the async reporter sink. Keep the durable
        // structured entry ID while anchoring matched reasoning before its assistant answer.
        structuredThinkingPlacements.set(structuredMatch.item.id, {
          sequence,
          ordinal: precedingTranscriptItemOrdinal(ordinal),
          ...reasoningIdentity,
        });
      } else {
        const item: RuntimeConversationItem =
          runId && turnId
            ? {
                id: stableItemId(snapshot.sessionId, sequence, "thinking", reasoning),
                kind: "thinking",
                content: reasoning,
                runId,
                turnId,
              }
            : {
                id: stableItemId(snapshot.sessionId, sequence, "thinking", reasoning),
                kind: "thinking",
                content: reasoning,
              };
        append(item, sequence);
      }
    }

    if (content) {
      const item: RuntimeConversationItem =
        runId && turnId
          ? {
              id: stableItemId(snapshot.sessionId, sequence, "assistant", content),
              kind: "assistantMessage",
              content,
              runId,
              turnId,
            }
          : {
              id: stableItemId(snapshot.sessionId, sequence, "assistant", content),
              kind: "assistantMessage",
              content,
            };
      append(item, sequence);
    }
  });

  const activeGoal = snapshot.runtime.goal?.goals.find((goal) => goal.status === "active");
  if (activeGoal) {
    append(
      {
        id: `goal:${activeGoal.id}`,
        kind: "goal",
        title: activeGoal.title,
        detail: activeGoal.progress ?? activeGoal.description,
        state: activeGoal.status,
        data: { goalId: activeGoal.id },
      },
      snapshot.persistenceSequence ?? Number.MAX_SAFE_INTEGER,
    );
  }
  items.push(
    ...structuredItems.map((ordered) => {
      if (ordered.item.kind !== "thinking") return ordered;
      const placement = structuredThinkingPlacements.get(ordered.item.id);
      if (placement === undefined) return ordered;
      const { runId, turnId, ...order } = placement;
      return {
        ...ordered,
        ...order,
        item: {
          ...ordered.item,
          ...(runId && turnId ? { runId, turnId } : {}),
        },
      };
    }),
  );
  items.sort((left, right) => left.sequence - right.sequence || left.ordinal - right.ordinal);
  return items;
}

function matchStructuredThinkingMessages(
  snapshot: RuntimeTranscriptSnapshot,
  structuredItems: readonly OrderedConversationItem[],
): ReadonlyMap<number, OrderedConversationItem> {
  const matches = new Map<number, OrderedConversationItem>();
  const claimedMessages = new Set<number>();
  const candidates = structuredItems
    .filter(
      (
        ordered,
      ): ordered is OrderedConversationItem & {
        readonly item: Extract<RuntimeConversationItem, { kind: "thinking" }>;
      } => ordered.item.kind === "thinking" && Boolean(ordered.item.content.trim()),
    )
    .toSorted((left, right) => left.sequence - right.sequence || left.ordinal - right.ordinal);

  for (const candidate of candidates) {
    const eligible = snapshot.messages.flatMap((message, messageIndex) => {
      if (
        claimedMessages.has(messageIndex) ||
        message.role !== "assistant" ||
        message.reasoning?.trim() !== candidate.item.content.trim()
      ) {
        return [];
      }
      const sequence = snapshot.messageSequences[messageIndex] ?? messageIndex + 1;
      const runId = snapshot.messageRunIds?.[messageIndex];
      const turnId = snapshot.messageTurnIds?.[messageIndex];
      const identityMatch =
        candidate.item.runId !== undefined && candidate.item.turnId !== undefined
          ? candidate.item.runId === runId && candidate.item.turnId === turnId
          : false;
      return [{ messageIndex, sequence, identityMatch }];
    });
    const selected = eligible.toSorted(
      (left, right) =>
        Number(right.identityMatch) - Number(left.identityMatch) ||
        Math.abs(left.sequence - candidate.sequence) -
          Math.abs(right.sequence - candidate.sequence) ||
        right.sequence - left.sequence,
    )[0];
    if (!selected) continue;
    claimedMessages.add(selected.messageIndex);
    matches.set(selected.messageIndex, candidate);
  }
  return matches;
}

interface OrderedConversationItem {
  readonly item: RuntimeConversationItem;
  readonly sequence: number;
  readonly ordinal: number;
}

interface StructuredConversationProjection {
  readonly items: readonly OrderedConversationItem[];
}

// The wire cursor contract requires a non-negative safe integer ordinal. Reserve
// the even slot immediately before every ordinary item for a matched structured
// thinking entry: ordinary n => 2n+1, matched thinking => 2n. This preserves the
// former n-0.5 ordering without emitting fractional cursors/fragments.
function transcriptItemOrdinal(index: number): number {
  const ordinal = index * 2 + 1;
  if (!Number.isSafeInteger(ordinal)) {
    throw new Error("Session transcript item ordinal exceeds the safe integer range");
  }
  return ordinal;
}

function precedingTranscriptItemOrdinal(index: number): number {
  const ordinal = index * 2;
  if (!Number.isSafeInteger(ordinal)) {
    throw new Error("Session transcript item ordinal exceeds the safe integer range");
  }
  return ordinal;
}

function projectStructuredItems(
  snapshot: RuntimeTranscriptSnapshot,
): StructuredConversationProjection {
  const projection = projectTranscriptEvents(
    hydrateCanonicalTranscriptEvents({
      sessionId: snapshot.sessionId,
      updatedAt: new Date(snapshot.transcriptEvents.at(-1)?.createdAt ?? 0).toISOString(),
      transcriptEvents: snapshot.transcriptEvents,
      transcriptEventSequences: snapshot.transcriptEventSequences,
      toolResults: snapshot.toolResults,
      rejectUnmatchedResults: true,
    }),
  );
  const createdAtByEntryId = new Map<string, number>();
  const sequenceByEntryId = new Map<string, number>();
  for (const [eventIndex, event] of snapshot.transcriptEvents.entries()) {
    if (!("entryId" in event)) continue;
    if (!createdAtByEntryId.has(event.entryId)) {
      createdAtByEntryId.set(event.entryId, event.createdAt);
    }
    if (!sequenceByEntryId.has(event.entryId)) {
      sequenceByEntryId.set(
        event.entryId,
        snapshot.transcriptEventSequences[eventIndex] ?? snapshot.messages.length + eventIndex + 1,
      );
    }
  }
  const items: OrderedConversationItem[] = [];
  const coalescedIndexes = new Map<string, number>();
  for (const [projectedIndex, projected] of projection.entries.entries()) {
    const entry = projected.entry;
    const at = createdAtByEntryId.get(projected.id);
    const sequence = sequenceByEntryId.get(projected.id) ?? Number.MAX_SAFE_INTEGER - 1;
    const ordered = (item: RuntimeConversationItem): OrderedConversationItem => ({
      item,
      sequence,
      ordinal: transcriptItemOrdinal(projectedIndex),
    });
    switch (entry.kind) {
      case "plan":
        items.push(
          ordered({
            id: projected.id,
            kind: "plan",
            title: entry.title,
            ...(entry.detail ? { detail: entry.detail } : {}),
            ...(entry.state ? { state: entry.state } : {}),
            ...(at === undefined ? {} : { at }),
          }),
        );
        break;
      case "approval":
      case "prompt":
      case "changes": {
        const data = toJsonObject(entry.data);
        const item = ordered({
          id: projected.id,
          kind: entry.kind,
          title: entry.title,
          ...(entry.detail ? { detail: entry.detail } : {}),
          ...(entry.state ? { state: entry.state } : {}),
          ...(at === undefined ? {} : { at }),
          ...(data ? { data } : {}),
        });
        const key = structuredItemKey(entry.kind, data);
        const priorIndex = key ? coalescedIndexes.get(key) : undefined;
        if (priorIndex === undefined) {
          if (key) coalescedIndexes.set(key, items.length);
          items.push(item);
        } else {
          const prior = items[priorIndex]!;
          items[priorIndex] = {
            ...item,
            sequence: Math.min(prior.sequence, item.sequence),
            ordinal: prior.ordinal,
          };
        }
        break;
      }
      case "run-boundary":
        items.push(
          ordered({
            id: projected.id,
            kind: "runBoundary",
            runId: entry.runId,
            status: entry.status,
            startedAt: entry.startedAt,
            ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
            ...(entry.error ? { error: entry.error } : {}),
          }),
        );
        break;
      case "subagent-activity":
        items.push(
          ordered({
            id: projected.id,
            kind: "subagent",
            ...(entry.agentName ? { name: entry.agentName } : {}),
            title: entry.agentName ? `${entry.agentName}: ${entry.task}` : entry.task,
            ...((entry.summary ?? entry.currentAction)
              ? { detail: entry.summary ?? entry.currentAction }
              : {}),
            state: entry.status,
            ...(at === undefined ? {} : { at }),
            data: {
              ...(projected.subagentActivityId ? { activityId: projected.subagentActivityId } : {}),
              ...(entry.mode ? { mode: entry.mode } : {}),
            },
          }),
        );
        break;
      case "skill":
        items.push(
          ordered({
            id: projected.id,
            kind: "skill",
            name: entry.name,
            args: entry.args,
            trigger: entry.trigger,
            ...(at === undefined ? {} : { at }),
          }),
        );
        break;
      case "tool": {
        if (isAgentGraphSupervisorToolName(entry.name)) break;
        const result =
          projected.toolCallId === undefined
            ? undefined
            : projection.toolCalls[projected.toolCallId]?.resultEnvelope;
        items.push(
          ordered({
            id: projected.id,
            kind: "tool",
            name: entry.name,
            args: entry.args,
            status: transcriptToolStatus(entry.status),
            ...(entry.summary ? { summary: entry.summary } : {}),
            ...(result ? { result: protocolToolResultEnvelope(result) } : {}),
            ...(at === undefined ? {} : { at }),
          }),
        );
        break;
      }
      case "error":
        items.push(
          ordered({
            id: projected.id,
            kind: "error",
            content: entry.message,
            ...(at === undefined ? {} : { at }),
          }),
        );
        break;
      case "thinking":
        if (entry.content?.trim()) {
          items.push(
            ordered({
              id: projected.id,
              kind: "thinking",
              content: entry.content,
              ...(at === undefined ? {} : { at }),
            }),
          );
        }
        break;
      case "system":
        if (entry.content.trim()) {
          items.push(
            ordered({
              id: projected.id,
              kind: "systemNotice",
              content: entry.content,
              ...(at === undefined ? {} : { at }),
            }),
          );
        }
        break;
      case "logo":
      case "user":
      case "assistant":
        // 消息正文由同一 RuntimeEvent ledger 中的 message events 投影，避免重复。
        break;
    }
  }
  return { items };
}

function structuredItemKey(
  kind: "approval" | "prompt" | "changes",
  data: JsonObject | undefined,
): string | undefined {
  if (!data) return undefined;
  const value =
    kind === "approval" ? data["approvalId"] : kind === "prompt" ? data["promptId"] : data["runId"];
  return typeof value === "string" && value ? `${kind}:${value}` : undefined;
}

function transcriptRevision(snapshot: RuntimeTranscriptSnapshot): string {
  // 第 1 轮审查问题 2 修复:revision 只基于全账本水位(窗口无关的稳定值)。
  // 账本是 append-only:head 相�� ⇒ 全账本相同 ⇒ 全量投影相同;窗口内容随
  // 读取预算漂移不该改变 revision(否则同 head 的分页游标会被误判冲突)。
  return `${snapshot.persistenceSequence ?? 0}`;
}

function stableItemId(
  sessionId: string,
  ledgerSequence: number,
  kind: string,
  content: string,
): string {
  // 锚定事件 seq(绝对值)而非窗口内 messageIndex:预算窗口前后移动时,
  // 同一条消息的 item id 保持稳定,不因窗口起点漂移而变化。
  const digest = createHash("sha256")
    .update(`${sessionId}\0${ledgerSequence}\0${kind}\0${content}`)
    .digest("hex")
    .slice(0, 20);
  return `item_${digest}`;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("session.transcript limit must be between 1 and 200");
  }
  return limit;
}

function encodeCursor(cursor: RuntimeTranscriptCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeOptionalCursor(
  encoded: string | undefined,
  revision: string,
  items: readonly OrderedConversationItem[],
): RuntimeTranscriptCursor | undefined {
  if (!encoded) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (isTranscriptCursor(parsed)) return parsed;
    // Compatibility with schema v12's opaque `{revision, offset}` cursor. It is
    // converted once at the boundary; paging below has only one cursor authority.
    if (
      isRecord(parsed) &&
      parsed["revision"] === revision &&
      Number.isSafeInteger(parsed["offset"])
    ) {
      const offset = parsed["offset"] as number;
      if (offset < 0 || offset > items.length || items.length === 0)
        throw new Error("stale cursor");
      const boundary = items[offset] ?? items.at(-1);
      if (!boundary) throw new Error("stale cursor");
      const throughTranscriptSequence = Number(revision);
      if (!Number.isSafeInteger(throughTranscriptSequence) || throughTranscriptSequence < 1) {
        throw new Error("stale cursor");
      }
      return transcriptCursor(revision, throughTranscriptSequence, boundary, "older");
    }
    throw new Error("stale cursor");
  } catch {
    throw new TranscriptRevisionConflict("cursor", revision);
  }
}

function isTranscriptCursor(value: unknown): value is RuntimeTranscriptCursor {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).length === 6 &&
    typeof value["revision"] === "string" &&
    value["revision"].length > 0 &&
    Number.isSafeInteger(value["throughTranscriptSequence"]) &&
    (value["throughTranscriptSequence"] as number) > 0 &&
    Number.isSafeInteger(value["position"]) &&
    (value["position"] as number) >= 0 &&
    Number.isSafeInteger(value["ordinal"]) &&
    (value["ordinal"] as number) >= 0 &&
    Number.isSafeInteger(value["byteOffset"]) &&
    (value["byteOffset"] as number) >= 0 &&
    (value["direction"] === "older" || value["direction"] === "newer")
  );
}

function selectPage(
  items: readonly OrderedConversationItem[],
  cursor: RuntimeTranscriptCursor | undefined,
  limit: number,
  revision: string,
  throughTranscriptSequence: number,
  maxBytes: number,
): RuntimeTranscriptPage {
  if (items.length === 0) return { items: [], revision };
  if (throughTranscriptSequence < 1) return { items: [], revision };
  if (cursor?.direction === "newer") {
    return selectNewerPage(items, cursor, limit, revision, throughTranscriptSequence, maxBytes);
  }

  if (cursor && cursor.byteOffset > 0) {
    const index = items.findIndex((item) => comparePosition(item, cursor) === 0);
    if (index < 0) throw new TranscriptRevisionConflict(cursor.revision, revision);
    return selectOversizedFragment(
      items[index]!,
      index,
      items.length,
      "older",
      cursor.byteOffset,
      revision,
      throughTranscriptSequence,
      maxBytes,
    );
  }

  let end =
    cursor === undefined
      ? items.length
      : items.findIndex((item) => comparePosition(item, cursor) >= 0);
  if (end < 0) end = items.length;
  let start = end;
  let selected: RuntimeConversationItem[] = [];
  while (start > 0 && selected.length < limit) {
    const candidateStart = start - 1;
    const boundary = items[candidateStart]!;
    const nextCursor =
      candidateStart > 0
        ? transcriptCursor(revision, throughTranscriptSequence, boundary, "older")
        : undefined;
    const candidate = [boundary.item, ...selected];
    if (pageBytes(candidate, nextCursor, revision) <= maxBytes) {
      selected = candidate;
      start = candidateStart;
      continue;
    }
    if (selected.length === 0) {
      return selectOversizedFragment(
        boundary,
        candidateStart,
        items.length,
        "older",
        utf8Bytes(boundary.item),
        revision,
        throughTranscriptSequence,
        maxBytes,
      );
    }
    break;
  }
  const nextCursor =
    start > 0
      ? transcriptCursor(revision, throughTranscriptSequence, items[start]!, "older")
      : undefined;
  const nextBefore = nextCursor ? encodeCursor(nextCursor) : undefined;
  return {
    items: selected,
    ...(nextCursor ? { nextCursor } : {}),
    ...(nextBefore ? { nextBefore } : {}),
    revision,
  };
}

function selectNewerPage(
  items: readonly OrderedConversationItem[],
  cursor: RuntimeTranscriptCursor,
  limit: number,
  revision: string,
  throughTranscriptSequence: number,
  maxBytes: number,
): RuntimeTranscriptPage {
  if (cursor.byteOffset > 0) {
    const continuationIndex = items.findIndex((item) => comparePosition(item, cursor) === 0);
    if (continuationIndex < 0) throw new TranscriptRevisionConflict(cursor.revision, revision);
    return selectOversizedFragment(
      items[continuationIndex]!,
      continuationIndex,
      items.length,
      "newer",
      cursor.byteOffset,
      revision,
      throughTranscriptSequence,
      maxBytes,
    );
  }
  let index = items.findIndex((item) => comparePosition(item, cursor) > 0);
  if (index < 0) return { items: [], revision };
  const selected: RuntimeConversationItem[] = [];
  while (index < items.length && selected.length < limit) {
    const candidate = [...selected, items[index]!.item];
    const hasMore = index + 1 < items.length;
    const nextCursor = hasMore
      ? transcriptCursor(revision, throughTranscriptSequence, items[index]!, "newer")
      : undefined;
    if (pageBytes(candidate, nextCursor, revision) <= maxBytes) {
      selected.push(items[index]!.item);
      index += 1;
      continue;
    }
    if (selected.length === 0) {
      return selectOversizedFragment(
        items[index]!,
        index,
        items.length,
        "newer",
        0,
        revision,
        throughTranscriptSequence,
        maxBytes,
      );
    }
    break;
  }
  const nextCursor =
    index < items.length
      ? transcriptCursor(revision, throughTranscriptSequence, items[index - 1]!, "newer")
      : undefined;
  return {
    items: selected,
    ...(nextCursor ? { nextCursor, nextBefore: encodeCursor(nextCursor) } : {}),
    revision,
  };
}

function selectOversizedFragment(
  ordered: OrderedConversationItem,
  itemIndex: number,
  itemCount: number,
  direction: RuntimeTranscriptCursor["direction"],
  boundaryOffset: number,
  revision: string,
  throughTranscriptSequence: number,
  maxBytes: number,
): RuntimeTranscriptPage {
  const encoded = Buffer.from(JSON.stringify(ordered.item), "utf8");
  const totalBytes = encoded.length;
  let start = direction === "older" ? 0 : boundaryOffset;
  let end = direction === "older" ? boundaryOffset : totalBytes;
  const fits = (candidateStart: number, candidateEnd: number): boolean => {
    const fragment: RuntimeTranscriptFragment = {
      itemId: ordered.item.id,
      position: ordered.sequence,
      ordinal: ordered.ordinal,
      byteOffset: candidateStart,
      byteLength: candidateEnd - candidateStart,
      totalBytes,
      json: encoded.subarray(candidateStart, candidateEnd).toString("utf8"),
    };
    const hasSameItem = direction === "older" ? candidateStart > 0 : candidateEnd < totalBytes;
    const nextCursor = hasSameItem
      ? {
          revision,
          throughTranscriptSequence,
          position: ordered.sequence,
          ordinal: ordered.ordinal,
          byteOffset: direction === "older" ? candidateStart : candidateEnd,
          direction,
        }
      : itemIndex > 0 && direction === "older"
        ? transcriptCursor(revision, throughTranscriptSequence, ordered, "older")
        : direction === "newer" && itemIndex + 1 < itemCount
          ? transcriptCursor(revision, throughTranscriptSequence, ordered, "newer")
          : undefined;
    return (
      utf8Bytes({
        items: [],
        fragments: [fragment],
        ...(nextCursor ? { nextCursor, nextBefore: encodeCursor(nextCursor) } : {}),
        revision,
      }) <= maxBytes
    );
  };
  if (direction === "older") {
    start = utf8BackwardStart(encoded, end, Math.max(1, maxBytes - 512));
    while (start < end && !fits(start, end)) {
      start = utf8BackwardStart(encoded, end, Math.max(1, end - start - 64));
    }
  } else {
    end = utf8ForwardEnd(encoded, start, Math.max(1, maxBytes - 512));
    while (end > start && !fits(start, end)) {
      end = utf8ForwardEnd(encoded, start, Math.max(1, end - start - 64));
    }
  }
  if (start >= end || !fits(start, end)) {
    throw new Error("session.transcript byte budget is too small for fragment metadata");
  }
  const fragment: RuntimeTranscriptFragment = {
    itemId: ordered.item.id,
    position: ordered.sequence,
    ordinal: ordered.ordinal,
    byteOffset: start,
    byteLength: end - start,
    totalBytes,
    json: encoded.subarray(start, end).toString("utf8"),
  };
  const sameItemContinues = direction === "older" ? start > 0 : end < totalBytes;
  const nextCursor = sameItemContinues
    ? {
        revision,
        throughTranscriptSequence,
        position: ordered.sequence,
        ordinal: ordered.ordinal,
        byteOffset: direction === "older" ? start : end,
        direction,
      }
    : itemIndex > 0 && direction === "older"
      ? transcriptCursor(revision, throughTranscriptSequence, ordered, "older")
      : direction === "newer" && itemIndex + 1 < itemCount
        ? transcriptCursor(revision, throughTranscriptSequence, ordered, "newer")
        : undefined;
  return {
    items: [],
    fragments: [fragment],
    ...(nextCursor ? { nextCursor, nextBefore: encodeCursor(nextCursor) } : {}),
    revision,
  };
}

function transcriptCursor(
  revision: string,
  throughTranscriptSequence: number,
  item: OrderedConversationItem,
  direction: RuntimeTranscriptCursor["direction"],
): RuntimeTranscriptCursor {
  return {
    revision,
    throughTranscriptSequence,
    position: item.sequence,
    ordinal: item.ordinal,
    byteOffset: 0,
    direction,
  };
}

function comparePosition(item: OrderedConversationItem, cursor: RuntimeTranscriptCursor): number {
  return item.sequence - cursor.position || item.ordinal - cursor.ordinal;
}

function pageBytes(
  items: readonly RuntimeConversationItem[],
  nextCursor: RuntimeTranscriptCursor | undefined,
  revision: string,
): number {
  return utf8Bytes({
    items,
    ...(nextCursor ? { nextCursor, nextBefore: encodeCursor(nextCursor) } : {}),
    revision,
  });
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function utf8ForwardEnd(bytes: Buffer, start: number, budget: number): number {
  let end = Math.min(bytes.length, start + budget);
  while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}

function utf8BackwardStart(bytes: Buffer, end: number, budget: number): number {
  let start = Math.max(0, end - budget);
  while (start < end && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return start;
}

function normalizeMaxBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TRANSCRIPT_PAGE_BYTES;
  if (!Number.isSafeInteger(value) || value < 1024 || value > MAX_RUNTIME_FRAME_BYTES) {
    throw new Error(
      `session.transcript maxBytes must be between 1024 and ${MAX_RUNTIME_FRAME_BYTES}`,
    );
  }
  return value;
}

function transcriptToolStatus(status: TranscriptToolCallStatus): "running" | "success" | "error" {
  if (status === "success") return "success";
  if (status === "error" || status === "denied") return "error";
  return "running";
}

function toJsonObject(
  value: Readonly<Record<string, unknown>> | undefined,
): JsonObject | undefined {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const converted = toJsonValue(entry);
      return converted === undefined ? [] : [[key, converted]];
    }),
  );
}

function protocolToolResultEnvelope(envelope: ToolResultEnvelope): RuntimeToolResultEnvelope {
  const result = toJsonObject(envelope as unknown as Readonly<Record<string, unknown>>);
  if (!result) throw new Error("ToolResult envelope is not JSON serializable");
  return result as RuntimeToolResultEnvelope;
}

function toJsonValue(value: unknown): JsonObject[string] | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const converted = value.map(toJsonValue);
    return converted.every((entry) => entry !== undefined)
      ? (converted as readonly NonNullable<JsonObject[string]>[])
      : undefined;
  }
  return isRecord(value) ? toJsonObject(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
