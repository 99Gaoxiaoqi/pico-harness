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
  type TranscriptEvent,
} from "../presentation/transcript-event-store.js";

type HydrationEventDraft<Event extends TranscriptEvent = TranscriptEvent> = Event extends unknown
  ? Omit<Event, "eventId" | "sequence" | "createdAt">
  : never;

/**
 * RuntimeEventStore 是模型上下文的权威源，TUI EventStore 是当前界面 segment。
 * 恢复/热切换时从前者重建最小可见 transcript，不暴露 system injection。
 */
export function hydrateTuiEntries(snapshot: SessionHydrationSnapshot): TuiEntry[] {
  const hydrationEvents = combinedHydrationEvents(snapshot);
  if (hydrationEvents.length > 0) return projectHydratedTranscriptEntries(hydrationEvents);

  // 防御旧的非结构化快照；正常 SessionHydrationSnapshot 会由上面的兼容事件覆盖。
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
    replaceTranscriptEvents?: (events: SessionHydrationSnapshot["transcriptEvents"]) => void;
    withoutDurableTranscript?: (callback: () => void) => void;
  },
  snapshot: SessionHydrationSnapshot,
  options: { readonly replace?: boolean } = {},
): void {
  const hydrationEvents = combinedHydrationEvents(snapshot);
  if (options.replace && reporter.replaceTranscriptEvents) {
    reporter.replaceTranscriptEvents(hydrationEvents);
    if (hydrationEvents.length > 0) return;
  }
  if (reporter.hydrateTranscriptEvents && hydrationEvents.length > 0) {
    reporter.hydrateTranscriptEvents(hydrationEvents);
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

/**
 * 旧 Session 在第一次结构化写入后会形成 legacy messages + transcript events 的混合快照。
 * 只把首条结构化 RuntimeEvent 之前的 message 前缀合成为稳定事件，再接上真实事件；
 * 本地 sequence 只服务 reducer，durable sequence 仍由 Session 账本保存。
 */
function combinedHydrationEvents(snapshot: SessionHydrationSnapshot): TranscriptEvent[] {
  const structured = snapshot.transcriptEvents;
  const sequencesAligned =
    snapshot.messageSequences.length === snapshot.messages.length &&
    snapshot.transcriptEventSequences.length === structured.length;
  if (!sequencesAligned)
    return structured.map((event, index) => ({ ...event, sequence: index + 1 }));

  const firstStructuredSequence =
    structured.length > 0
      ? Math.min(...snapshot.transcriptEventSequences)
      : Number.POSITIVE_INFINITY;
  const legacyMessageIndexes = snapshot.messageSequences.flatMap((sequence, index) =>
    sequence < firstStructuredSequence ? [index] : [],
  );
  const legacy = synthesizeLegacyTranscriptEvents(snapshot, legacyMessageIndexes);
  return [...legacy, ...structured].map((event, index) => ({ ...event, sequence: index + 1 }));
}

function synthesizeLegacyTranscriptEvents(
  snapshot: SessionHydrationSnapshot,
  messageIndexes: readonly number[],
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const toolResults = indexToolResults(snapshot.messages);
  const selected = new Set(messageIndexes);
  const baseCreatedAt = Number.isFinite(Date.parse(snapshot.createdAt))
    ? Date.parse(snapshot.createdAt)
    : 0;
  const append = (draft: HydrationEventDraft): TranscriptEvent => {
    const event = {
      ...draft,
      eventId: `legacy:${snapshot.sessionId}:event:${events.length + 1}`,
      sequence: events.length + 1,
      createdAt: baseCreatedAt + events.length,
    } as TranscriptEvent;
    events.push(event);
    return event;
  };

  for (const [messageIndex, message] of snapshot.messages.entries()) {
    if (!selected.has(messageIndex)) continue;
    if (
      message.role === "system" ||
      message.toolCallId !== undefined ||
      isMessageHiddenFromTranscript(message)
    ) {
      continue;
    }
    const runtimeSequence = snapshot.messageSequences[messageIndex]!;
    const entryId = (kind: string, ordinal = 0): string =>
      `legacy:${snapshot.sessionId}:message:${runtimeSequence}:${kind}:${ordinal}`;

    if (message.role === "user") {
      const content = visibleText(message.content);
      if (content) {
        append({
          type: "entry.appended",
          entryId: entryId("user"),
          entry: { kind: "user", content },
        });
      }
      continue;
    }

    const reasoning = visibleText(message.reasoning ?? "");
    const content = visibleText(message.content);
    if (reasoning) {
      append({
        type: "entry.appended",
        entryId: entryId("thinking"),
        entry: { kind: "thinking", content: reasoning },
      });
    }
    if (content) {
      append({
        type: "entry.appended",
        entryId: entryId("assistant"),
        entry: { kind: "assistant", content },
      });
    }
    for (const [callIndex, call] of (message.toolCalls ?? []).entries()) {
      const result = shiftToolResult(toolResults, call.id);
      const toolCallId = entryId("tool-call", callIndex);
      append({
        type: "tool.started",
        entryId: entryId("tool", callIndex),
        toolCallId,
        providerCallId: call.id,
        name: call.name,
        args: call.arguments,
      });
      const failed = result === undefined || isHydratedToolError(result);
      const rawResult = result?.content ?? "Interrupted before a result was recorded.";
      const summary = compactToolResult(rawResult);
      append({
        type: "tool.completed",
        toolCallId,
        status: failed ? "error" : "success",
        summary,
        inlineResult: summary,
        size: rawResult.length,
        truncated: summary.length < rawResult.length,
      });
    }
  }
  return events;
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
