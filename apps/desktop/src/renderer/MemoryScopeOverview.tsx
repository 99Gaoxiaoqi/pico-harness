import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { BookOpen, RefreshCw } from "lucide-react";
import { Button, EmptyState, InlineNotice } from "./components.js";
import { TextField } from "./ui-controls.js";
import type { RuntimeStore } from "./runtime.js";
import type { MemoryScopePage, MemoryScopeTab } from "./memory-scope.js";
import {
  experienceIsSaved,
  experienceNeedsReview,
  experiencePromotionLabel,
  experienceReviewReason,
  experienceStatusLabel,
  isExperienceSuggestion,
} from "./TaskExperiencePanel.js";
import { referenceBody } from "./ExperienceUsagePanel.js";
import { experienceManagementHref } from "./experience-management-route.js";
import { sessionHref, workspaceDisplayName } from "./workspace-session.js";

const labels: Record<MemoryScopeTab, string> = {
  saved: "已保存",
  pending: "待审核",
  archived: "已归档",
  usage: "使用记录",
};
type ScopeRead = { page?: MemoryScopePage; error?: string; loading?: boolean };

export function MemoryScopeOverview({
  runtime,
  scope,
}: {
  readonly runtime: RuntimeStore;
  readonly scope: "all" | "global" | "unassigned";
}) {
  const { data, actions } = runtime;
  const location = useLocation();
  const navigate = useNavigate();
  const requested = new URLSearchParams(location.search).get("tab");
  const tab: MemoryScopeTab =
    requested && Object.hasOwn(labels, requested) ? (requested as MemoryScopeTab) : "saved";
  const [search, setSearch] = useState("");
  const [refresh, setRefresh] = useState(0);
  const workspaces = data.workspaces
    .map((workspace) => ({
      ...workspace,
      trusted: workspace.trusted && (workspace.path !== data.workspacePath || data.trusted),
    }))
    .filter(
      (workspace) => scope !== "unassigned" || workspace.temporary || workspace.projectId === null,
    );
  const key = JSON.stringify([
    data.picoHome,
    scope,
    tab,
    workspaces.map((w) => [w.path, w.trusted]),
    refresh,
    runtime.executionLearningRevision,
    runtime.taskExperienceSupported,
  ]);
  const generation = useRef({ key, value: 0 });
  if (generation.current.key !== key)
    generation.current = { key, value: generation.current.value + 1 };
  const [reads, setReads] = useState<{ key: string; values: Record<string, ScopeRead> }>({
    key: "",
    values: {},
  });
  const snapshot = reads.key === key ? reads.values : {};
  useEffect(() => {
    let disposed = false;
    const epoch = generation.current.value;
    setReads({ key, values: {} });
    const queue = workspaces.filter((w) => w.trusted);
    const readNext = async () => {
      while (!disposed && generation.current.value === epoch && queue.length) {
        const workspace = queue.shift()!;
        try {
          if (!actions.queryMemoryScope)
            throw new Error("当前连接不支持集中查看，请选择具体项目管理。");
          let page: MemoryScopePage =
            scope === "global" && (tab === "pending" || tab === "usage")
              ? {}
              : await actions.queryMemoryScope(workspace.path, tab);
          if (tab === "saved" && scope !== "global" && runtime.taskExperienceSupported) {
            try {
              const experiencePage = await actions.queryMemoryScope(workspace.path, "pending");
              if (experiencePage.suggestions)
                page = { ...page, suggestions: experiencePage.suggestions };
            } catch {
              // Keep saved memory visible if this Host predates task-experience support.
            }
          }
          if (disposed || generation.current.value !== epoch) return;
          setReads((previous) => ({
            key,
            values: { ...previous.values, [workspace.path]: { page } },
          }));
        } catch (error) {
          if (disposed || generation.current.value !== epoch) return;
          setReads((previous) => ({
            key,
            values: {
              ...previous.values,
              [workspace.path]: {
                error: error instanceof Error ? error.message : "读取失败，请重试。",
              },
            },
          }));
        }
      }
    };
    void Promise.all([readNext(), readNext(), readNext()]);
    return () => {
      disposed = true;
    };
  }, [key, actions]);
  const loadMore = async (path: string, cursor: string) => {
    const epoch = generation.current.value;
    const old = snapshot[path]?.page;
    if (!old || !actions.queryMemoryScope) return;
    setReads((previous) => ({
      key,
      values: { ...previous.values, [path]: { page: old, loading: true } },
    }));
    try {
      const next = await actions.queryMemoryScope(path, tab, cursor);
      if (generation.current.value !== epoch) return;
      if (
        old.memory?.pageInfo &&
        next.memory?.pageInfo &&
        old.memory.pageInfo.revision !== next.memory.pageInfo.revision
      )
        throw new Error("记忆列表已变化，请刷新后继续。");
      const page: MemoryScopePage = {
        ...next,
        ...(next.memory
          ? {
              memory: {
                ...next.memory,
                items: [...(old.memory?.items ?? []), ...next.memory.items],
              },
            }
          : {}),
        ...(next.usage
          ? { usage: { ...next.usage, uses: [...(old.usage?.uses ?? []), ...next.usage.uses] } }
          : {}),
      };
      setReads((previous) => ({ key, values: { ...previous.values, [path]: { page } } }));
    } catch (error) {
      if (generation.current.value === epoch)
        setReads((previous) => ({
          key,
          values: {
            ...previous.values,
            [path]: { page: old, error: error instanceof Error ? error.message : "读取失败" },
          },
        }));
    }
  };
  const rows: Array<{ key: string; label: string; content: string; status: string; href: string }> =
    [];
  const seen = new Set<string>();
  const projectedCandidateIds = new Set<string>();
  for (const workspace of workspaces.filter((w) => w.trusted)) {
    const page = snapshot[workspace.path]?.page;
    const workspaceLabel = workspace.temporary
      ? "无项目任务"
      : workspaceDisplayName(workspace.path, workspace);
    for (const item of page?.memory?.items ?? []) {
      if (
        String(item.sourceType) === "execution-evidence" ||
        item.executionEvidence ||
        (scope === "global" && item.scopeType !== "global")
      )
        continue;
      if (item.lifecycleState !== (tab === "archived" ? "archived" : "active")) continue;
      const id =
        item.scopeType === "global" ? `global:${item.itemId}` : `${workspace.path}:${item.itemId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({
        key: id,
        label: item.scopeType === "global" ? "全局" : workspaceLabel,
        content: item.content,
        status: item.taskExperience
          ? item.lifecycleState === "archived"
            ? "已归档"
            : experienceStatusLabel(item.taskExperience) +
              (item.taskExperience.maturity === "active" || item.taskExperience.maturity === "trial"
                ? " · " + experiencePromotionLabel(item.taskExperience)
                : "")
          : item.kind === "preference"
            ? "偏好"
            : "记忆",
        href: experienceManagementHref(
          workspace.path,
          { itemId: item.itemId },
          tab === "archived" ? "archived" : "saved",
        ),
      });
      if (item.taskExperience) projectedCandidateIds.add(item.taskExperience.candidateId);
    }
    for (const candidate of page?.suggestions?.items ?? []) {
      if (
        candidate.kind !== "task-lesson" ||
        !isExperienceSuggestion(candidate) ||
        candidate.lifecycleState === "archived" ||
        projectedCandidateIds.has(candidate.candidateId) ||
        (tab === "pending" ? !experienceNeedsReview(candidate) : !experienceIsSaved(candidate))
      )
        continue;
      const needsReview = experienceNeedsReview(candidate);
      rows.push({
        key: `${workspace.path}:${candidate.candidateId}`,
        label: workspaceLabel,
        content: candidate.content,
        status: needsReview
          ? "待审核 · " + experienceReviewReason(candidate)
          : experienceStatusLabel(candidate) + " · " + experiencePromotionLabel(candidate),
        href: experienceManagementHref(
          workspace.path,
          { candidateId: candidate.candidateId },
          needsReview ? "pending" : "saved",
        ),
      });
    }
    for (const use of page?.usage?.uses ?? []) {
      if (use.source.kind === "execution-evidence" || use.deleted) continue;
      rows.push({
        key: `${workspace.path}:${use.useId}`,
        label: workspaceLabel,
        content: referenceBody(use.referenceContent || "经验引用（无正文）"),
        status:
          use.delivery === "carried" && !use.historical
            ? `已引用 · ${use.adoption === "observed" ? "观察到采用" : use.adoption === "not_applied" ? "未采用" : "采用未知"} · 本次验证${use.validation === "pass" ? "通过（仅本次范围）" : use.validation === "fail" ? "失败" : use.validation === "stale" ? "需重新验证" : "未知"}`
            : use.historical
              ? "历史引用，时序不完整；执行结果不能归因于本条经验"
              : "引用未确认；执行结果不能归因于本条经验",
        href: sessionHref({ workspacePath: workspace.path, sessionId: use.sessionId }),
      });
    }
  }
  const filtered = rows.filter(
    (row) =>
      !search ||
      `${row.content}${row.label}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const pending = workspaces.some((w) => w.trusted && !snapshot[w.path]);
  return (
    <section className="memory-scope-overview" aria-label="集中查看记忆">
      <div className="memory-scope-overview__toolbar">
        <TextField
          label="搜索记忆内容"
          type="search"
          placeholder="搜索已加载内容"
          value={search}
          onValueChange={setSearch}
        />
        <Button onClick={() => setRefresh((n) => n + 1)}>
          <RefreshCw size={15} aria-hidden="true" />
          刷新
        </Button>
      </div>
      <TabList
        role="tablist"
        className="memory-tablist"
        aria-label="集中记忆状态"
        value={tab}
        onChange={(value) => {
          const params = new URLSearchParams(location.search);
          params.set("tab", String(value));
          navigate({ pathname: location.pathname, search: params.toString() });
        }}
      >
        {Object.entries(labels).map(([value, label]) => (
          <Tab
            key={value}
            value={value}
            label={label}
            id={`memory-overview-tab-${value}`}
            panelId={`memory-overview-panel-${value}`}
          />
        ))}
      </TabList>
      <div
        role="tabpanel"
        id={`memory-overview-panel-${tab}`}
        aria-labelledby={`memory-overview-tab-${tab}`}
      >
        <p className="memory-scope-overview__help">
          {scope === "global"
            ? "全局内容集中去重展示。打开条目后可在同一设置页管理；经验建议与使用记录按工作区保存。"
            : "集中查看已信任工作区的内容。打开条目后，在同一设置页进入所属范围管理。"}{" "}
          显示 {filtered.length} 条已加载内容。
        </p>
        {pending && <p role="status">正在读取记忆…</p>}
        <div className="memory-scope-overview__rows">
          {filtered.map((row) => (
            <Link className="memory-overview-row" key={row.key} to={row.href}>
              <div>
                <span>{row.label}</span>
                <small>{row.status}</small>
              </div>
              <p>{row.content}</p>
              <small>{tab === "usage" ? "查看来源会话与证据" : "查看与管理"}</small>
            </Link>
          ))}
        </div>
        {!pending && !filtered.length && (
          <EmptyState
            icon={<BookOpen />}
            title="暂无可显示的内容"
            detail="可以切换范围或状态；手动添加记忆请先选择具体项目。"
          />
        )}
        {workspaces.map((workspace) => {
          const value = snapshot[workspace.path];
          const cursor =
            value?.page?.memory?.pageInfo?.nextCursor ?? value?.page?.usage?.nextCursor;
          return (
            <div key={workspace.path}>
              {!workspace.trusted && (
                <InlineNotice>
                  {workspaceDisplayName(workspace.path, workspace)} 尚未信任，未读取内容。
                </InlineNotice>
              )}
              {value?.error && (
                <InlineNotice tone="warning">
                  {workspaceDisplayName(workspace.path, workspace)}：{value.error}
                </InlineNotice>
              )}
              {cursor && (
                <Button
                  disabled={value?.loading}
                  onClick={() => void loadMore(workspace.path, cursor)}
                >
                  加载更多 · {workspaceDisplayName(workspace.path, workspace)}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
