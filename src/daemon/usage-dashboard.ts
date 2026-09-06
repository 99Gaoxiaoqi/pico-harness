import type {
  UsageActivity,
  UsageBreakdown,
  UsageCostStatus,
  UsageDashboardDetails,
  UsagePrice,
} from "@pico/protocol";
import type { ProviderCallRecord } from "../tasks/runtime-types.js";
import { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";

export interface UsageDashboardInput {
  readonly sources: readonly {
    workspacePath: string;
    storageRoot: string;
    calls: readonly ProviderCallRecord[];
  }[];
  readonly from?: number;
  readonly to?: number;
  readonly sessionId?: string;
  readonly pricing: readonly UsagePrice[];
  readonly unavailableWorkspaces: readonly { workspacePath: string; error: string }[];
}
const MAX_ACTIVITIES = 5000;
const zeroTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
};

export async function buildUsageDashboard(
  input: UsageDashboardInput,
): Promise<UsageDashboardDetails> {
  const activities: UsageActivity[] = [];
  const warnings: string[] = [];
  let knownCacheReadTokens = 0,
    knownCacheWriteTokens = 0,
    cacheReadReportedCallCount = 0,
    cacheWriteReportedCallCount = 0;
  for (const source of input.sources) {
    const titles = new Map<string, string>();
    let store: SqliteRuntimeEventStore | undefined;
    try {
      store = new SqliteRuntimeEventStore({ storageRoot: source.storageRoot });
      for (const { summary } of await store.listSessionCatalogEntries()) {
        if (summary.title || summary.firstMessage)
          titles.set(summary.id, (summary.title || summary.firstMessage)!.slice(0, 160));
      }
      const toolCalls = new Map<string, UsageActivity>();
      const terminalRuns = new Map<string, string>();
      for (const event of store.readUsageToolMetadata(input.sessionId)) {
        if (event.runId.startsWith("fork-bootstrap:")) continue;
        const runKey = JSON.stringify([event.sessionId, event.runId]);
        if (event.kind === "run.terminal") {
          terminalRuns.set(runKey, event.status ?? "");
          continue;
        }
        if (!event.toolCallId || !event.toolName) continue;
        const key = JSON.stringify([event.sessionId, event.runId, event.toolCallId]);
        const at = Date.parse(event.at);
        if (!Number.isFinite(at)) continue;
        const previous = toolCalls.get(key);
        const done = event.kind === "tool.result.recorded";
        toolCalls.set(key, {
          id: JSON.stringify([source.workspacePath, "tool", key]),
          kind: "tool",
          name: event.toolName,
          workspacePath: source.workspacePath,
          sessionId: event.sessionId,
          ...(titles.has(event.sessionId) ? { sessionTitle: titles.get(event.sessionId)! } : {}),
          ...zeroTokens,
          at,
          status: done ? activityStatus(event.status) : "running",
          costStatus: "none",
          ...(done && previous && at >= previous.at ? { durationMs: at - previous.at } : {}),
        });
      }
      for (const [key, activity] of toolCalls) {
        if (!inRange(activity.at, input)) continue;
        const [sessionId, runId] = JSON.parse(key) as [string, string, string];
        const terminal = terminalRuns.get(JSON.stringify([sessionId, runId]));
        activities.push(
          activity.status === "running" && terminal
            ? { ...activity, status: terminal === "failed" ? "error" : "aborted" }
            : activity,
        );
      }
    } catch (error) {
      warnings.push(
        `${source.workspacePath}：工具明细暂不可用（${error instanceof Error ? error.message : String(error)}）`,
      );
    } finally {
      store?.close();
    }
    for (const call of source.calls) {
      knownCacheReadTokens += call.cacheReadTokens;
      knownCacheWriteTokens += call.cacheWriteTokens;
      const reportedFields = call.reported?.["reportedFields"];
      if (call.reported?.["usageMetadata"] === "reported" && Array.isArray(reportedFields)) {
        if (reportedFields.includes("cacheRead")) cacheReadReportedCallCount++;
        if (reportedFields.includes("cacheWrite")) cacheWriteReportedCallCount++;
      }
      const costStatus =
        call.reported?.["costStatus"] === "estimated"
          ? "estimated"
          : call.reported?.["costStatus"] === "included"
            ? "included"
            : "unknown";
      const latency = call.reported?.["latencyMs"];
      const provider = providerLabel(call);
      activities.push({
        id: JSON.stringify([source.workspacePath, "model", call.callId]),
        kind: "model",
        name: call.model,
        model: call.model,
        provider,
        workspacePath: source.workspacePath,
        ...(call.sessionId ? { sessionId: call.sessionId } : {}),
        ...(call.sessionId && titles.has(call.sessionId)
          ? { sessionTitle: titles.get(call.sessionId)! }
          : {}),
        at: call.createdAt,
        status: activityStatus(call.status),
        inputTokens: call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens,
        outputTokens: call.outputTokens,
        cacheReadTokens: call.cacheReadTokens,
        cacheWriteTokens: call.cacheWriteTokens,
        totalTokens:
          call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens + call.outputTokens,
        costStatus,
        ...(costStatus !== "unknown" ? { costCNY: call.cost } : {}),
        ...(typeof latency === "number" && Number.isFinite(latency) && latency >= 0
          ? { durationMs: latency }
          : {}),
      });
    }
  }
  activities.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return {
    activities: activities.slice(0, MAX_ACTIVITIES),
    activityCount: activities.length,
    activitiesTruncated: activities.length > MAX_ACTIVITIES,
    providers: groupActivities(
      activities.filter((a) => a.kind === "model"),
      (a) => a.provider ?? "未知厂商",
    ),
    models: groupActivities(
      activities.filter((a) => a.kind === "model"),
      (a) => JSON.stringify([a.provider, a.model]),
    ),
    tools: groupActivities(
      activities.filter((a) => a.kind === "tool"),
      (a) => a.name,
    ),
    pricing: input.pricing,
    unavailableWorkspaces: input.unavailableWorkspaces,
    knownCacheReadTokens,
    knownCacheWriteTokens,
    cacheReadReportedCallCount,
    cacheWriteReportedCallCount,
    warnings,
  };
}
function providerLabel(call: ProviderCallRecord): string {
  if (call.route) {
    try {
      return `${new URL(call.route).host + new URL(call.route).pathname.replace(/\/$/, "")} · ${call.provider}`;
    } catch {
      /* Legacy route IDs are not URLs. */
    }
  }
  return call.provider;
}
function inRange(at: number, input: UsageDashboardInput): boolean {
  return (
    (input.from === undefined || at >= input.from) && (input.to === undefined || at <= input.to)
  );
}
function activityStatus(status: string | undefined): UsageActivity["status"] {
  return status === "succeeded" || status === "completed"
    ? "success"
    : status === "cancelled" || status === "interrupted"
      ? "aborted"
      : "error";
}
function groupActivities(
  activities: readonly UsageActivity[],
  key: (activity: UsageActivity) => string,
): UsageBreakdown[] {
  const groups = new Map<string, UsageActivity[]>();
  for (const a of activities) {
    const id = key(a);
    const group = groups.get(id) ?? [];
    group.push(a);
    groups.set(id, group);
  }
  return [...groups]
    .map(([id, rows]) => {
      const first = rows[0]!;
      const priced = rows.filter((r) => r.costCNY !== undefined);
      const kinds = new Set(rows.map((r) => r.costStatus));
      const costStatus: UsageCostStatus =
        first.kind === "tool"
          ? "none"
          : priced.length === 0
            ? "unknown"
            : priced.length < rows.length || kinds.size > 1
              ? "partial"
              : first.costStatus;
      const durations = rows.flatMap((r) => (r.durationMs === undefined ? [] : [r.durationMs]));
      return {
        id,
        name: id === first.provider ? first.provider : first.name,
        ...(first.provider ? { provider: first.provider } : {}),
        count: rows.length,
        successCount: rows.filter((r) => r.status === "success").length,
        errorCount: rows.filter((r) => r.status === "error").length,
        abortedCount: rows.filter((r) => r.status === "aborted").length,
        ...rows.reduce(
          (sum, r) => ({
            inputTokens: sum.inputTokens + r.inputTokens,
            outputTokens: sum.outputTokens + r.outputTokens,
            cacheReadTokens: sum.cacheReadTokens + r.cacheReadTokens,
            cacheWriteTokens: sum.cacheWriteTokens + r.cacheWriteTokens,
            totalTokens: sum.totalTokens + r.totalTokens,
          }),
          { ...zeroTokens },
        ),
        costStatus,
        ...(priced.length ? { costCNY: priced.reduce((sum, r) => sum + r.costCNY!, 0) } : {}),
        ...(durations.length
          ? { averageDurationMs: durations.reduce((sum, n) => sum + n, 0) / durations.length }
          : {}),
      };
    })
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}
