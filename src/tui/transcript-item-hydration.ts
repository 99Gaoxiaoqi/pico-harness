import type { RuntimeConversationItem } from "@pico/protocol";
import type { ToolResultEnvelope } from "../engine/tool-result-contract.js";
import type {
  TranscriptEntryData,
  TranscriptEvent,
} from "../presentation/transcript-event-store.js";
import type { SubagentActivityEvent } from "../engine/reporter.js";

/**
 * Durable transcript 投影页的 RuntimeConversationItem[] → TranscriptEvent[] 转换器。
 *
 * RPC item 是 daemon 侧已投影的渲染视图（有损、无流语义），客户端水化走
 * 共享 Replica 用稳定 Item ID 合并页面与增量；此处仅负责把渲染视图转换为
 * TUI Reporter 事件。未知 kind 静默跳过以保持 wire 前向兼容。
 */

export function transcriptEventsFromRuntimeItems(
  items: readonly RuntimeConversationItem[],
  sessionId: string,
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  let sequence = 0;
  for (const item of items) {
    const at = numberOrUndefined((item as Record<string, unknown>)["at"]);
    const createdAt = at ?? sequence + 1;
    if (item.kind === "tool" && item.result) {
      const toolCallId = `rpc-tool:${sessionId}:${item.id}`;
      sequence += 1;
      events.push({
        type: "tool.started",
        eventId: `rpc:${sessionId}:${item.id}:started`,
        sequence,
        createdAt,
        entryId: item.id,
        toolCallId,
        providerCallId: item.result.toolCallId,
        name: item.name,
        args: item.args,
      });
      sequence += 1;
      events.push({
        type: "tool.completed",
        eventId: `rpc:${sessionId}:${item.id}:completed`,
        sequence,
        createdAt,
        toolCallId,
        summary: item.summary ?? item.result.projection.text,
        result: item.result as unknown as ToolResultEnvelope,
      });
      continue;
    }
    if (item.kind === "subagent") {
      const data = item.data as Record<string, unknown> | undefined;
      const activityId = stringOrUndefined(data?.["activityId"]) ?? item.id;
      sequence += 1;
      events.push({
        type: "subagent.activity.updated",
        eventId: `rpc:${sessionId}:${item.id}:activity`,
        sequence,
        createdAt,
        entryId: item.id,
        activityId,
        activity: {
          task: item.title,
          status: subagentStatusOf(item.state),
          mode: data?.["mode"] === "explore" ? "explore" : "worker",
          completionPolicy: "required",
          ...(item.detail ? { summary: item.detail } : {}),
          ...(item.name ? { agentName: item.name } : {}),
        },
      });
      continue;
    }
    const entry = entryDataFromRuntimeItem(item);
    if (!entry) continue;
    sequence += 1;
    events.push({
      type: "entry.appended",
      eventId: `rpc:${sessionId}:${item.id}`,
      sequence,
      createdAt: at ?? sequence,
      entryId: item.id,
      entry,
    });
  }
  return events;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function entryDataFromRuntimeItem(item: RuntimeConversationItem): TranscriptEntryData | undefined {
  switch (item.kind) {
    case "userMessage":
      return { kind: "user", content: item.content };
    case "systemNotice":
      return { kind: "system", content: item.content };
    case "error":
      return { kind: "error", message: item.content };
    case "assistantMessage":
      return { kind: "assistant", content: item.content };
    case "thinking":
      return { kind: "thinking", content: item.content };
    case "skill":
      return { kind: "skill", name: item.name, args: item.args, trigger: item.trigger };
    case "tool":
      return {
        kind: "tool",
        name: item.name,
        args: item.args,
        status:
          item.status === "running" ? "running" : item.status === "success" ? "success" : "error",
        ...(item.summary ? { summary: item.summary } : {}),
      };
    case "plan":
      return {
        kind: "plan",
        title: item.title,
        ...(item.detail ? { detail: item.detail } : {}),
        ...(item.state ? { state: item.state } : {}),
      };
    case "approval":
    case "prompt":
    case "changes":
      return {
        kind: item.kind,
        title: item.title,
        ...(item.detail ? { detail: item.detail } : {}),
        ...(item.state ? { state: item.state } : {}),
        ...(item.data ? { data: item.data } : {}),
      };
    case "runBoundary":
      return {
        kind: "run-boundary",
        runId: item.runId ?? item.id,
        status: item.status,
        startedAt: item.startedAt,
        ...(item.finishedAt !== undefined ? { finishedAt: item.finishedAt } : {}),
        ...(item.error ? { error: item.error } : {}),
      };
    default:
      // goal 等暂无 TranscriptEntry 对应的 kind：静默跳过（前向兼容）。
      return undefined;
  }
}

function subagentStatusOf(state: string | undefined): SubagentActivityEvent["status"] {
  if (state === "pending" || state === "queued") return "queued";
  if (state === "done" || state === "completed") return "completed";
  if (state === "partial") return "partial";
  if (state === "failed" || state === "timed_out" || state === "cancelled") return state;
  return "running";
}
