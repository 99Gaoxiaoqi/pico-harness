import type { SessionHydrationSnapshot } from "../engine/session-runtime.js";
import type { Message, ToolCall } from "../schema/message.js";
import type { TuiEntry } from "./tui-reporter.js";

/**
 * Session JSONL 是模型上下文的权威源，TUI EventStore 是当前界面 segment。
 * 恢复/热切换时从前者重建最小可见 transcript，不暴露 system injection。
 */
export function hydrateTuiEntries(snapshot: SessionHydrationSnapshot): TuiEntry[] {
  const toolResults = indexToolResults(snapshot.messages);
  const entries: TuiEntry[] = [];

  for (const message of snapshot.messages) {
    if (message.role === "system" || message.toolCallId !== undefined) continue;

    if (message.role === "user") {
      const content = visibleText(message.content);
      if (content) entries.push({ kind: "user", content });
      continue;
    }

    const content = visibleText(message.content);
    if (content) entries.push({ kind: "assistant", content });
    for (const call of message.toolCalls ?? []) {
      entries.push(hydrateToolEntry(call, toolResults.get(call.id)));
    }
  }

  return entries;
}

function indexToolResults(messages: readonly Message[]): Map<string, Message> {
  const results = new Map<string, Message>();
  for (const message of messages) {
    if (message.role === "user" && message.toolCallId !== undefined) {
      results.set(message.toolCallId, message);
    }
  }
  return results;
}

function hydrateToolEntry(call: ToolCall, result: Message | undefined): TuiEntry {
  if (!result) {
    return {
      kind: "tool",
      name: call.name,
      args: call.arguments,
      status: "error",
      summary: "Interrupted before a result was recorded.",
    };
  }

  const failed = result.content.startsWith("[ERROR]");
  return {
    kind: "tool",
    name: call.name,
    args: call.arguments,
    status: failed ? "error" : "success",
    summary: compactToolResult(result.content),
  };
}

function visibleText(value: string): string {
  return value.trim();
}

function compactToolResult(value: string): string {
  const inline = value.replace(/\s+/gu, " ").trim();
  if (inline.length <= 160) return inline;
  return `${inline.slice(0, 159)}…`;
}
