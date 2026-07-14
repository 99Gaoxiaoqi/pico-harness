import { createHash } from "node:crypto";
import type { SessionHydrationSnapshot } from "../engine/session-runtime.js";
import { projectTranscriptEvents } from "../presentation/transcript-event-store.js";
import {
  isMessageHiddenFromTranscript,
  isToolResultErrorMessage,
  type Message,
} from "../schema/message.js";
import {
  MAX_RUNTIME_FRAME_BYTES,
  type JsonObject,
  type RuntimeConversationItem,
} from "./protocol.js";

const DEFAULT_TRANSCRIPT_PAGE_BYTES = MAX_RUNTIME_FRAME_BYTES - 64 * 1024;

export interface RuntimeTranscriptPage {
  readonly items: readonly RuntimeConversationItem[];
  readonly nextBefore?: string;
  readonly revision: string;
}

export function projectRuntimeTranscript(
  snapshot: SessionHydrationSnapshot,
  options: {
    readonly before?: string;
    readonly limit?: number;
    readonly expectedRevision?: string;
    readonly maxBytes?: number;
  },
): RuntimeTranscriptPage {
  const items = projectVisibleItems(snapshot);
  const revision = transcriptRevision(snapshot, items);
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

function projectVisibleItems(snapshot: SessionHydrationSnapshot): RuntimeConversationItem[] {
  const toolResults = indexToolResults(snapshot.messages);
  const items: RuntimeConversationItem[] = [];

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
    if (message.role === "user") {
      if (content) {
        items.push({
          id: stableItemId(snapshot.sessionId, messageIndex, "user", content),
          kind: "userMessage",
          content,
        });
      }
      return;
    }

    if (content) {
      items.push({
        id: stableItemId(snapshot.sessionId, messageIndex, "assistant", content),
        kind: "assistantMessage",
        content,
      });
    }
    for (const call of message.toolCalls ?? []) {
      const result = toolResults.get(call.id)?.shift();
      const failed = result === undefined || isToolResultErrorMessage(result);
      items.push({
        id: stableItemId(snapshot.sessionId, messageIndex, `tool:${call.id}`, call.arguments),
        kind: "tool",
        name: call.name,
        args: call.arguments,
        status: failed ? "error" : "success",
        summary:
          result === undefined
            ? "Interrupted before a result was recorded."
            : `${failed ? "Tool failed" : "Tool completed"} · ${Buffer.byteLength(result.content, "utf8")} bytes`,
      });
    }
  });

  const activeGoal = snapshot.runtime.goal?.goals.find((goal) => goal.status === "active");
  if (activeGoal) {
    items.push({
      id: `goal:${activeGoal.id}`,
      kind: "goal",
      title: activeGoal.title,
      detail: activeGoal.progress ?? activeGoal.description,
      state: activeGoal.status,
      data: { goalId: activeGoal.id },
    });
  }
  items.push(...projectStructuredItems(snapshot));
  return items;
}

function projectStructuredItems(snapshot: SessionHydrationSnapshot): RuntimeConversationItem[] {
  if (snapshot.transcriptEvents.length === 0) return [];
  const projection = projectTranscriptEvents(snapshot.transcriptEvents);
  const createdAtByEntryId = new Map<string, number>();
  for (const event of snapshot.transcriptEvents) {
    if ("entryId" in event) createdAtByEntryId.set(event.entryId, event.createdAt);
  }
  const messageToolSignatures = new Set(
    snapshot.messages.flatMap((message) =>
      (message.toolCalls ?? []).map((call) => `${call.name}\0${call.arguments}`),
    ),
  );
  const items: RuntimeConversationItem[] = [];
  for (const projected of projection.entries) {
    const entry = projected.entry;
    const at = createdAtByEntryId.get(projected.id);
    switch (entry.kind) {
      case "plan":
        items.push({
          id: projected.id,
          kind: "plan",
          title: entry.title,
          ...(entry.detail ? { detail: entry.detail } : {}),
          ...(entry.state ? { state: entry.state } : {}),
          ...(at === undefined ? {} : { at }),
        });
        break;
      case "approval":
      case "prompt":
      case "changes": {
        const data = toJsonObject(entry.data);
        items.push({
          id: projected.id,
          kind: entry.kind,
          title: entry.title,
          ...(entry.detail ? { detail: entry.detail } : {}),
          ...(entry.state ? { state: entry.state } : {}),
          ...(at === undefined ? {} : { at }),
          ...(data ? { data } : {}),
        });
        break;
      }
      case "run-boundary":
        items.push({
          id: projected.id,
          kind: "runBoundary",
          runId: entry.runId,
          status: entry.status,
          startedAt: entry.startedAt,
          ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
        });
        break;
      case "subagent-activity":
        items.push({
          id: projected.id,
          kind: "subagent",
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
        });
        break;
      case "skill":
        items.push({
          id: projected.id,
          kind: "skill",
          name: entry.name,
          args: entry.args,
          trigger: entry.trigger,
          ...(at === undefined ? {} : { at }),
        });
        break;
      case "tool":
        if (messageToolSignatures.has(`${entry.name}\0${entry.args}`)) break;
        items.push({
          id: projected.id,
          kind: "tool",
          name: entry.name,
          args: entry.args,
          status: transcriptToolStatus(entry.status),
          ...(entry.summary ? { summary: entry.summary } : {}),
          ...(at === undefined ? {} : { at }),
        });
        break;
      case "error":
        items.push({
          id: projected.id,
          kind: "error",
          content: entry.message,
          ...(at === undefined ? {} : { at }),
        });
        break;
      case "logo":
      case "user":
      case "system":
      case "assistant":
      case "thinking":
        // 消息正文仍由同一 JSONL 中的 message events 投影；系统注入不对 Renderer 暴露。
        break;
    }
  }
  return items;
}

function indexToolResults(messages: readonly Message[]): Map<string, Message[]> {
  const results = new Map<string, Message[]>();
  for (const message of messages) {
    if (message.role !== "user" || message.toolCallId === undefined) continue;
    const ordered = results.get(message.toolCallId) ?? [];
    ordered.push(message);
    results.set(message.toolCallId, ordered);
  }
  return results;
}

function transcriptRevision(
  snapshot: SessionHydrationSnapshot,
  items: readonly RuntimeConversationItem[],
): string {
  const digest = createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 16);
  return `${snapshot.persistenceSequence ?? 0}.${digest}`;
}

function stableItemId(
  sessionId: string,
  messageIndex: number,
  kind: string,
  content: string,
): string {
  const digest = createHash("sha256")
    .update(`${sessionId}\0${messageIndex}\0${kind}\0${content}`)
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
        ...metadata,
      };
    case "runBoundary":
      return { ...item, id, runId: text(item.runId) ?? "", ...metadata };
    case "approval":
    case "prompt":
    case "changes":
    case "subagent":
    case "goal":
      return {
        ...item,
        id,
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

function transcriptToolStatus(status: string): "running" | "success" | "error" {
  if (status === "success" || status === "done") return "success";
  if (status === "error" || status === "failed" || status === "denied") return "error";
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
