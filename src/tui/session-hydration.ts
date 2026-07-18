import type { SessionHydrationSnapshot } from "../engine/session-runtime.js";
import {
  isMessageHiddenFromTranscript,
  isToolResultErrorMessage,
  type Message,
  type ToolCall,
} from "../schema/message.js";
import type { TuiEntry } from "./tui-reporter.js";
import type { TuiReporter } from "./tui-reporter.js";
import {
  projectTranscriptEntriesForRendering,
  projectTranscriptEvents,
} from "../presentation/transcript-event-store.js";

/**
 * RuntimeEventStore 是模型上下文的权威源，TUI EventStore 是当前界面 segment。
 * 恢复/热切换时从前者重建最小可见 transcript，不暴露 system injection。
 */
export function hydrateTuiEntries(snapshot: SessionHydrationSnapshot): TuiEntry[] {
  // 结构化 transcript 是稳定 ID、reasoning、Skill/system 及子代理终态的权威源。
  // 仅保留旧 Session（尚未写入 transcriptEvents）的 messages fallback。
  if (snapshot.transcriptEvents.length > 0) {
    return projectHydratedTranscriptEntries(snapshot.transcriptEvents);
  }
  const toolResults = indexToolResults(snapshot.messages);
  const entries: TuiEntry[] = [];

  for (const message of snapshot.messages) {
    if (
      message.role === "system" ||
      message.toolCallId !== undefined ||
      isMessageHiddenFromTranscript(message)
    ) {
      continue;
    }

    if (message.role === "user") {
      const content = visibleText(message.content);
      if (content) entries.push({ kind: "user", content });
      continue;
    }

    const content = visibleText(message.content);
    const reasoning = visibleText(message.reasoning ?? "");
    if (reasoning) entries.push({ kind: "thinking", content: reasoning });
    if (content) entries.push({ kind: "assistant", content });
    for (const call of message.toolCalls ?? []) {
      entries.push(hydrateToolEntry(call, shiftToolResult(toolResults, call.id)));
    }
  }

  return entries;
}

/**
 * 用 Reporter 的领域事件重建权威投影。工具必须走 started/completed，
 * 否则内部 tool ID、完整 inline result 与 artifactRef 会在热切换后丢失。
 */
export function hydrateTuiReporter(
  reporter: Pick<
    TuiReporter,
    | "pushUserMessage"
    | "onMessage"
    | "onReasoningDelta"
    | "onToolCall"
    | "onToolResult"
    | "onFinish"
  > & {
    hydrateTranscriptEvents?: (events: SessionHydrationSnapshot["transcriptEvents"]) => void;
    withoutDurableTranscript?: (callback: () => void) => void;
  },
  snapshot: SessionHydrationSnapshot,
): void {
  // Reporter 在 Repl 中已用 initialEvents 水合；避免再次从 messages 双写。
  if (snapshot.transcriptEvents.length > 0) {
    reporter.hydrateTranscriptEvents?.(snapshot.transcriptEvents);
    return;
  }
  const hydrateLegacyMessages = (): void => {
    const toolResults = indexToolResults(snapshot.messages);
    for (const message of snapshot.messages) {
      if (
        message.role === "system" ||
        message.toolCallId !== undefined ||
        isMessageHiddenFromTranscript(message)
      ) {
        continue;
      }

      if (message.role === "user") {
        const content = visibleText(message.content);
        if (content) reporter.pushUserMessage(content);
        continue;
      }

      const content = visibleText(message.content);
      const reasoning = visibleText(message.reasoning ?? "");
      if (reasoning && reporter.onReasoningDelta) reporter.onReasoningDelta(reasoning);
      if (content) reporter.onMessage(content);
      for (const call of message.toolCalls ?? []) {
        const result = shiftToolResult(toolResults, call.id);
        reporter.onToolCall(call.name, call.arguments, call.id);
        reporter.onToolResult(
          call.name,
          result?.content ?? "Interrupted before a result was recorded.",
          result === undefined || isHydratedToolError(result),
          call.id,
        );
      }
    }
    reporter.onFinish();
  };
  if (reporter.withoutDurableTranscript) {
    reporter.withoutDurableTranscript(hydrateLegacyMessages);
  } else {
    hydrateLegacyMessages();
  }
}

function projectHydratedTranscriptEntries(
  events: SessionHydrationSnapshot["transcriptEvents"],
): TuiEntry[] {
  return projectTranscriptEntriesForRendering(projectTranscriptEvents(events));
}

function indexToolResults(messages: readonly Message[]): Map<string, Message[]> {
  const results = new Map<string, Message[]>();
  for (const message of messages) {
    if (message.role === "user" && message.toolCallId !== undefined) {
      const ordered = results.get(message.toolCallId) ?? [];
      ordered.push(message);
      results.set(message.toolCallId, ordered);
    }
  }
  return results;
}

function shiftToolResult(results: Map<string, Message[]>, toolCallId: string): Message | undefined {
  const ordered = results.get(toolCallId);
  const result = ordered?.shift();
  if (ordered?.length === 0) results.delete(toolCallId);
  return result;
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

  const failed = isHydratedToolError(result);
  return {
    kind: "tool",
    name: call.name,
    args: call.arguments,
    status: failed ? "error" : "success",
    summary: compactToolResult(result.content),
  };
}

function isHydratedToolError(result: Message): boolean {
  return isToolResultErrorMessage(result);
}

function visibleText(value: string): string {
  return value.trim();
}

function compactToolResult(value: string): string {
  const inline = value.replace(/\s+/gu, " ").trim();
  if (inline.length <= 160) return inline;
  return `${inline.slice(0, 159)}…`;
}
