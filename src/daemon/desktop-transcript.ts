import { createHash } from "node:crypto";
import type { SessionHydrationSnapshot } from "../engine/session-runtime.js";
import {
  isMessageHiddenFromTranscript,
  isToolResultErrorMessage,
  type Message,
} from "../schema/message.js";
import type { RuntimeConversationItem } from "./protocol.js";

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
  },
): RuntimeTranscriptPage {
  const items = projectVisibleItems(snapshot);
  const revision = transcriptRevision(snapshot, items);
  if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
    throw new TranscriptRevisionConflict(options.expectedRevision, revision);
  }

  const limit = normalizeLimit(options.limit);
  const end = options.before ? decodeCursor(options.before, revision) : items.length;
  const start = Math.max(0, end - limit);
  return {
    items: items.slice(start, end),
    ...(start > 0 ? { nextBefore: encodeCursor(revision, start) } : {}),
    revision,
  };
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

    const content = message.content.trim();
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
        summary: compactToolResult(result?.content ?? "Interrupted before a result was recorded."),
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

function decodeCursor(cursor: string, revision: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !isRecord(parsed) ||
      parsed["revision"] !== revision ||
      !Number.isSafeInteger(parsed["offset"]) ||
      (parsed["offset"] as number) < 0
    ) {
      throw new Error("stale cursor");
    }
    return parsed["offset"] as number;
  } catch {
    throw new TranscriptRevisionConflict("cursor", revision);
  }
}

function compactToolResult(value: string): string {
  const inline = value.replace(/\s+/gu, " ").trim();
  return inline.length <= 240 ? inline : `${inline.slice(0, 239)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
