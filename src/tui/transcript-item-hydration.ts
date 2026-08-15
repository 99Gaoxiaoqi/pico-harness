import type { RuntimeConversationItem } from "@pico/protocol";
import type {
  TranscriptEntryData,
  TranscriptEvent,
} from "../presentation/transcript-event-store.js";
import type { SubagentActivityEvent } from "../engine/reporter.js";

/**
 * RPC transcript 页（session.transcript 的 RuntimeConversationItem[]）→
 * TranscriptEvent[] 转换器（3-D Phase 2）。
 *
 * RPC item 是 daemon 侧已投影的渲染视图（有损、无流语义），客户端水化走
 * `entry.appended` 全量重建（replaceTranscriptEvents），不做增量流回放——
 * 这与 Desktop 的"complete 后重水化"对账策略同构。未知 kind 静默跳过
 * （wire 前向兼容，与 run.live 未知 kind 容忍语义一致）。
 */

const SUBAGENT_ACTIVITY_STATUSES = new Set<string>([
  "pending",
  "running",
  "done",
  "failed",
  "timed_out",
  "cancelled",
]);

export function transcriptEventsFromRuntimeItems(
  items: readonly RuntimeConversationItem[],
  sessionId: string,
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  let sequence = 0;
  for (const item of items) {
    const entry = entryDataFromRuntimeItem(item);
    if (!entry) continue;
    sequence += 1;
    const at = numberOrUndefined((item as Record<string, unknown>)["at"]);
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
        status: item.status === "running" ? "running" : item.status === "success" ? "success" : "error",
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
    case "subagent":
      return {
        kind: "subagent-activity",
        task: item.title,
        status: subagentStatusOf(item.state),
        mode: "worker",
        completionPolicy: "required",
        ...(item.detail ? { summary: item.detail } : {}),
        ...(item.name ? { agentName: item.name } : {}),
      };
    default:
      // goal 等暂无 TranscriptEntry 对应的 kind：静默跳过（前向兼容）。
      return undefined;
  }
}

function subagentStatusOf(state: string | undefined): SubagentActivityEvent["status"] {
  return state && SUBAGENT_ACTIVITY_STATUSES.has(state)
    ? (state as SubagentActivityEvent["status"])
    : "running";
}
