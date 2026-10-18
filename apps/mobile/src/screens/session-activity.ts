import type { RuntimeRun, RuntimeSession } from "@pico/protocol/mobile";

export type SessionActivityGroup = "需检查" | "进行中" | "最近" | "已归档";
export type SessionActivityFilter = "全部" | Exclude<SessionActivityGroup, "已归档">;
export type SessionActivityItem = {
  session: RuntimeSession;
  run?: RuntimeRun;
  group: SessionActivityGroup;
  label: string;
  summary: string;
  updatedAt: number;
};

const priority: Record<SessionActivityGroup, number> = {
  需检查: 0,
  进行中: 1,
  最近: 2,
  已归档: 3,
};

function describeRun(run: RuntimeRun): Pick<SessionActivityItem, "group" | "label" | "summary"> {
  switch (run.status) {
    case "failed":
      return {
        group: "需检查",
        label: "运行失败",
        summary: run.error?.trim() || "打开会话查看失败原因",
      };
    case "paused":
      return { group: "需检查", label: "已暂停", summary: "打开会话后可继续任务" };
    case "queued":
      return { group: "进行中", label: "排队中", summary: "等待开始任务" };
    case "running":
      return {
        group: "进行中",
        label: "进行中",
        summary: run.description.trim() || "任务正在执行",
      };
    case "pause_requested":
      return { group: "进行中", label: "正在暂停", summary: "等待当前任务暂停" };
    case "cancelling":
      return { group: "进行中", label: "正在取消", summary: "等待当前任务停止" };
    case "cancelled":
      return { group: "最近", label: "已取消", summary: "最近一次任务已取消" };
    case "succeeded":
      return { group: "最近", label: "已完成", summary: "最近一次任务已完成" };
  }
}

function sessionKey(workspacePath: string, sessionId: string) {
  return JSON.stringify([workspacePath, sessionId]);
}

/**
 * Join session.list with one workspace-level runs.list response. Session active means
 * unarchived, not running. Neither response contains unread or pending-input counts.
 * Omit runs when the read is unavailable; an empty array means it succeeded with no runs.
 */
export function buildSessionActivityList({
  sessions,
  runs,
  query = "",
  includeArchived = false,
  filter = "全部",
}: {
  sessions: readonly RuntimeSession[];
  runs?: readonly RuntimeRun[];
  query?: string;
  includeArchived?: boolean;
  filter?: SessionActivityFilter;
}) {
  const latest = new Map<string, RuntimeRun>();
  for (const run of runs ?? []) {
    if (!run.sessionId) continue;
    const key = sessionKey(run.workspacePath, run.sessionId);
    const previous = latest.get(key);
    // A late update to an older run must not replace the newer attempt.
    if (
      !previous ||
      run.startedAt > previous.startedAt ||
      (run.startedAt === previous.startedAt &&
        (run.updatedAt > previous.updatedAt ||
          (run.updatedAt === previous.updatedAt && run.runId.localeCompare(previous.runId) > 0)))
    )
      latest.set(key, run);
  }
  const text = query.trim().toLocaleLowerCase();
  const items: SessionActivityItem[] = sessions
    .filter(
      (session) =>
        (includeArchived || session.status !== "archived") &&
        session.title.toLocaleLowerCase().includes(text),
    )
    .map((session) => {
      const run = latest.get(sessionKey(session.workspacePath, session.sessionId));
      const activity: Pick<SessionActivityItem, "group" | "label" | "summary"> =
        session.status === "archived"
          ? { group: "已归档", label: "已归档", summary: "恢复后可继续会话" }
          : run
            ? describeRun(run)
            : {
                group: "最近",
                label: "最近会话",
                summary: runs === undefined ? "运行状态暂不可用" : "暂无运行记录",
              };
      return {
        session,
        ...(run ? { run } : {}),
        ...activity,
        updatedAt: Math.max(session.updatedAt, run?.updatedAt ?? session.updatedAt),
      };
    })
    .sort(
      (a, b) =>
        priority[a.group] - priority[b.group] ||
        Number(b.session.pinned) - Number(a.session.pinned) ||
        b.updatedAt - a.updatedAt ||
        a.session.sessionId.localeCompare(b.session.sessionId),
    );
  const counts = { 全部: items.length, 需检查: 0, 进行中: 0, 最近: 0 };
  let archived = 0;
  for (const item of items) {
    if (item.group === "已归档") archived++;
    else counts[item.group]++;
  }
  const activityKnown = runs !== undefined;
  const summary = activityKnown
    ? `${counts.需检查} 个需检查 · ${counts.进行中} 个进行中 · ${counts.最近} 个最近会话${archived ? ` · ${archived} 个已归档` : ""}`
    : `共 ${counts.全部} 个会话 · 运行状态暂不可用`;
  return {
    items: filter === "全部" ? items : items.filter((item) => item.group === filter),
    counts,
    summary,
    activityKnown,
  };
}
