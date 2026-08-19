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
import {
  MAX_RUNTIME_FRAME_BYTES,
  type JsonObject,
  type RuntimeConversationItem,
  type RuntimeToolResultEnvelope,
} from "./protocol.js";

const DEFAULT_TRANSCRIPT_PAGE_BYTES = MAX_RUNTIME_FRAME_BYTES - 64 * 1024;

export interface RuntimeTranscriptPage {
  readonly items: readonly RuntimeConversationItem[];
  readonly nextBefore?: string;
  readonly revision: string;
}

export interface RuntimeTranscriptProjectionOptions {
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
  const items = projectVisibleItems(snapshot);
  const revision = transcriptRevision(snapshot);
  if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
    throw new TranscriptRevisionConflict(options.expectedRevision, revision);
  }

  const limit = normalizeLimit(options.limit);
  const end = options.before ? decodeCursor(options.before, revision, items.length) : items.length;
  return selectPage(items, end, limit, revision, normalizeMaxBytes(options.maxBytes));
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

function projectVisibleItems(snapshot: RuntimeTranscriptSnapshot): RuntimeConversationItem[] {
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
    items.push({ item, sequence, ordinal: ordinal++ });
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
          ordinal: ordinal - 0.5,
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
      Number.MAX_SAFE_INTEGER,
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
  return items.map(({ item }) => item);
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
      ordinal: projectedIndex,
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

function encodeCursor(revision: string, offset: number): string {
  return Buffer.from(JSON.stringify({ revision, offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, revision: string, itemCount: number): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !isRecord(parsed) ||
      parsed["revision"] !== revision ||
      !Number.isSafeInteger(parsed["offset"]) ||
      (parsed["offset"] as number) < 0 ||
      (parsed["offset"] as number) > itemCount
    ) {
      throw new Error("stale cursor");
    }
    return parsed["offset"] as number;
  } catch {
    throw new TranscriptRevisionConflict("cursor", revision);
  }
}

function selectPage(
  items: readonly RuntimeConversationItem[],
  end: number,
  limit: number,
  revision: string,
  maxBytes: number,
): RuntimeTranscriptPage {
  let start = end;
  let selected: RuntimeConversationItem[] = [];
  while (start > 0 && selected.length < limit) {
    const candidateStart = start - 1;
    const nextBefore = candidateStart > 0 ? encodeCursor(revision, candidateStart) : undefined;
    const candidate = [items[candidateStart]!, ...selected];
    if (pageBytes(candidate, nextBefore, revision) <= maxBytes) {
      selected = candidate;
      start = candidateStart;
      continue;
    }
    if (selected.length === 0) {
      selected = [fitItemToPage(items[candidateStart]!, nextBefore, revision, maxBytes)];
      start = candidateStart;
    }
    break;
  }
  const nextBefore = start > 0 ? encodeCursor(revision, start) : undefined;
  return {
    items: selected,
    ...(nextBefore ? { nextBefore } : {}),
    revision,
  };
}

function fitItemToPage(
  item: RuntimeConversationItem,
  nextBefore: string | undefined,
  revision: string,
  maxBytes: number,
): RuntimeConversationItem {
  const originalBytes = utf8Bytes(item);
  let low = 0;
  let high = longestStringLength(item);
  let fitted = truncateConversationItem(item, 0, originalBytes);
  if (pageBytes([fitted], nextBefore, revision) > maxBytes) {
    throw new Error("session.transcript byte budget is too small for item metadata");
  }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = truncateConversationItem(item, middle, originalBytes);
    if (pageBytes([candidate], nextBefore, revision) <= maxBytes) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return fitted;
}

function truncateConversationItem(
  item: RuntimeConversationItem,
  maxCodePoints: number,
  originalBytes: number,
): RuntimeConversationItem {
  const text = (value: string | undefined) =>
    value === undefined ? undefined : Array.from(value).slice(0, maxCodePoints).join("");
  const metadata = { truncated: true as const, originalBytes };
  const id = boundedItemId(item.id);
  switch (item.kind) {
    case "userMessage":
    case "assistantMessage":
    case "systemNotice":
    case "error":
    case "thinking":
      return { ...item, id, content: text(item.content) ?? "", ...metadata };
    case "skill":
      return {
        ...item,
        id,
        name: text(item.name) ?? "",
        args: text(item.args) ?? "",
        ...metadata,
      };
    case "plan":
      return {
        ...item,
        id,
        title: text(item.title) ?? "",
        ...(item.detail === undefined ? {} : { detail: text(item.detail) ?? "" }),
        ...metadata,
      };
    case "tool":
      return {
        ...item,
        id,
        name: text(item.name) ?? "",
        args: text(item.args) ?? "",
        ...(item.summary === undefined ? {} : { summary: text(item.summary) ?? "" }),
        ...(item.result === undefined
          ? {}
          : {
              result: {
                ...item.result,
                projection: {
                  ...item.result.projection,
                  text: text(item.result.projection.text) ?? "",
                  truncated:
                    item.result.projection.truncated ||
                    Array.from(item.result.projection.text).length > maxCodePoints,
                },
              },
            }),
        ...metadata,
      };
    case "runBoundary":
      return {
        ...item,
        id,
        runId: text(item.runId) ?? "",
        ...(item.error === undefined ? {} : { error: text(item.error) ?? "" }),
        ...metadata,
      };
    case "approval":
    case "prompt":
    case "changes":
    case "subagent":
    case "goal":
      return {
        ...item,
        id,
        ...(item.kind === "subagent" && item.name !== undefined
          ? { name: text(item.name) ?? "" }
          : {}),
        title: text(item.title) ?? "",
        ...(item.detail === undefined ? {} : { detail: text(item.detail) ?? "" }),
        ...(item.state === undefined ? {} : { state: text(item.state) ?? "" }),
        data: { truncated: true },
        ...metadata,
      };
  }
}

function boundedItemId(id: string): string {
  if (Buffer.byteLength(id, "utf8") <= 256) return id;
  return `item_truncated_${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}

function pageBytes(
  items: readonly RuntimeConversationItem[],
  nextBefore: string | undefined,
  revision: string,
): number {
  return utf8Bytes({ items, ...(nextBefore ? { nextBefore } : {}), revision });
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function longestStringLength(value: unknown): number {
  if (typeof value === "string") return Array.from(value).length;
  if (Array.isArray(value))
    return value.reduce((max, entry) => Math.max(max, longestStringLength(entry)), 0);
  if (!isRecord(value)) return 0;
  return Object.values(value).reduce<number>(
    (max, entry) => Math.max(max, longestStringLength(entry)),
    0,
  );
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
