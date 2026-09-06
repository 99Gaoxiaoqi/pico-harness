import { useMemo, useState, type ReactNode } from "react";
import type {
  UsageActivity,
  UsageBreakdown,
  UsageCostStatus,
  UsageDashboardDetails,
} from "@pico/protocol";
import type { UsageView, WorkspaceView } from "../model.js";

export interface UsageSettingsPageProps {
  readonly usage: UsageView & { readonly details?: UsageDashboardDetails };
  readonly workspaces: readonly WorkspaceView[];
  readonly loading: boolean;
  readonly error?: string;
  readonly onQuery: (input: {
    workspacePath?: string;
    from?: number;
    to?: number;
  }) => Promise<void>;
  readonly onOpenSession: (workspacePath: string, sessionId: string) => void;
}
const ranges = [
  { id: "24h", label: "24 小时", days: 1 },
  { id: "7d", label: "7 天", days: 7 },
  { id: "30d", label: "30 天", days: 30 },
  { id: "all", label: "全部", days: 0 },
] as const;
const tabs = [
  { id: "requests", label: "请求日志" },
  { id: "providers", label: "厂商" },
  { id: "models", label: "模型" },
  { id: "tools", label: "工具" },
  { id: "pricing", label: "定价" },
] as const;
type Tab = (typeof tabs)[number]["id"];
const number = (value: number | undefined) =>
  value === undefined ? "未知" : value.toLocaleString("zh-CN");
const statuses: Record<UsageActivity["status"], string> = {
  success: "成功",
  error: "失败",
  aborted: "已取消",
  running: "进行中",
};
const costLabels: Record<UsageCostStatus, string> = {
  none: "无费用",
  estimated: "估算",
  included: "套餐内",
  unknown: "未知",
  partial: "已知部分",
};
function cost(value: number | undefined, status: UsageCostStatus = "unknown") {
  if (status === "unknown") return "未知";
  if (status === "included") return "套餐内";
  if (status === "none") return "—";
  return `${value === undefined ? "未知" : `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`} · ${costLabels[status]}`;
}
function duration(value: number | undefined) {
  return value === undefined
    ? "—"
    : value < 1000
      ? `${Math.round(value)} ms`
      : `${(value / 1000).toFixed(1)} s`;
}
function Metric({
  title,
  value,
  children,
}: {
  title: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <div className="usage-summary-card">
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{children}</small>
    </div>
  );
}
function Table({
  label,
  headers,
  rows,
  page,
  onPage,
}: {
  label: string;
  headers: readonly string[];
  rows: readonly { id: string; cells: readonly ReactNode[] }[];
  page: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(rows.length / 25));
  const current = Math.min(page, pages - 1);
  return (
    <>
      <div
        className="usage-table-scroll"
        tabIndex={0}
        role="region"
        aria-label={`${label}表格，可横向滚动`}
      >
        <table className="usage-table" aria-label={label}>
          <thead>
            <tr>
              {headers.map((header) => (
                <th scope="col" key={header}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(current * 25, (current + 1) * 25).map((row) => (
              <tr key={row.id}>
                {row.cells.map((cell, index) => (
                  <td key={index}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="usage-empty" role="status">
            暂无记录{label === "请求日志" ? "，可调整时间、项目或筛选条件" : ""}
          </div>
        )}
      </div>
      {rows.length > 0 && (
        <div className="usage-pagination">
          <span>
            共 {number(rows.length)} 条 · 第 {current + 1} / {pages} 页
          </span>
          <button type="button" disabled={current === 0} onClick={() => onPage(current - 1)}>
            上一页
          </button>
          <button type="button" disabled={current + 1 >= pages} onClick={() => onPage(current + 1)}>
            下一页
          </button>
        </div>
      )}
    </>
  );
}
export function UsageSettingsPage({
  usage,
  workspaces,
  loading,
  error,
  onQuery,
  onOpenSession,
}: UsageSettingsPageProps) {
  const [range, setRange] = useState<(typeof ranges)[number]["id"]>("all");
  const [workspacePath, setWorkspacePath] = useState(usage.workspacePath ?? "");
  const [tab, setTab] = useState<Tab>("requests");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [showDetails, setShowDetails] = useState(true);
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState(false);
  const [queryError, setQueryError] = useState<string>();
  const details = usage.details;
  const busy = loading || pending;
  async function query(nextRange = range, nextWorkspace = workspacePath) {
    setPending(true);
    setQueryError(undefined);
    setPage(0);
    const days = ranges.find((item) => item.id === nextRange)?.days ?? 0;
    const to = Date.now();
    try {
      await onQuery({
        ...(nextWorkspace ? { workspacePath: nextWorkspace } : {}),
        ...(days ? { from: to - days * 86_400_000, to } : {}),
      });
    } catch (cause) {
      setQueryError(cause instanceof Error ? cause.message : "加载用量失败，请重试");
    } finally {
      setPending(false);
    }
  }
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return (details?.activities ?? []).filter(
      (row) =>
        (status === "all" || status === row.status) &&
        (!needle ||
          [row.name, row.provider, row.model, row.sessionTitle, row.sessionId].some((value) =>
            value?.toLocaleLowerCase().includes(needle),
          )),
    );
  }, [details, search, status]);
  const counts: Record<Tab, number> = {
    requests: details?.activityCount ?? 0,
    providers: details?.providers.length ?? 0,
    models: details?.models.length ?? 0,
    tools: details?.tools.length ?? 0,
    pricing: details?.pricing.length ?? 0,
  };
  const read = details?.knownCacheReadTokens ?? usage.cacheReadTokens;
  const write = details?.knownCacheWriteTokens ?? usage.cacheWriteTokens;
  const input =
    usage.inputTokens === undefined ? undefined : usage.inputTokens + (read ?? 0) + (write ?? 0);
  const cacheTotal = read === undefined || write === undefined ? undefined : read + write;
  const warnings = [
    ...(details?.warnings ?? []),
    ...(usage.cacheAlerts ?? []),
    ...((usage.baselineCount ?? 0) > 0
      ? [
          `总量包含 ${usage.baselineCount} 条历史汇总；这些记录没有逐次调用明细，因此分类明细与总量可能不同。`,
        ]
      : []),
  ];
  const unavailable = details?.unavailableWorkspaces ?? [];
  const hasDiagnostics =
    warnings.length > 0 ||
    unavailable.length > 0 ||
    (usage.unavailableWorkspaceCount ?? 0) > 0 ||
    details?.activitiesTruncated;
  const breakdown = (rows: readonly UsageBreakdown[], tools = false) =>
    rows.map((row) => ({
      id: row.id,
      cells: tools
        ? [
            row.name,
            number(row.count),
            number(row.successCount),
            number(row.errorCount),
            number(row.abortedCount),
            duration(row.averageDurationMs),
          ]
        : [
            <span>
              {row.name}
              {row.provider && <small className="usage-cell-secondary">{row.provider}</small>}
            </span>,
            number(row.count),
            number(row.totalTokens),
            number(row.inputTokens),
            number(row.outputTokens),
            cost(row.costCNY, row.costStatus),
          ],
    }));
  return (
    <section className="usage-settings" aria-label="用量统计" aria-busy={busy}>
      <header className="usage-page-heading">
        <div>
          <h2>用量</h2>
          <p>查看模型调用、工具活动与本地费用估算。</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void query()} aria-label="刷新用量">
          {busy ? "刷新中…" : "刷新"}
        </button>
      </header>
      <div className="usage-toolbar">
        <div className="usage-ranges" role="group" aria-label="统计时间范围">
          {ranges.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={range === item.id}
              disabled={busy}
              onClick={() => {
                setRange(item.id);
                void query(item.id);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="usage-project">
          项目
          <select
            aria-label="统计项目"
            disabled={busy}
            value={workspacePath}
            onChange={(event) => {
              const value = event.target.value;
              setWorkspacePath(value);
              void query(range, value);
            }}
          >
            <option value="">全部项目</option>
            {workspaces.map((workspace) => (
              <option key={workspace.path} value={workspace.path}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(error || queryError) && (
        <div className="usage-error" role="alert">
          {queryError || error}
          <button type="button" disabled={busy} onClick={() => void query()}>
            重试
          </button>
        </div>
      )}
      <div className="usage-summary" role="group" aria-label="用量汇总">
        <Metric title="模型请求" value={number(usage.providerCallCount)}>
          已上报用量 {number(usage.usageReportCount)} 次
        </Metric>
        <Metric title="估算费用 · CNY" value={cost(usage.costCNY, usage.costStatus)}>
          本地估算，不代表厂商账单
        </Metric>
        <Metric title="总 Token" value={number(usage.totalTokens)}>
          输入 {number(input)} · 输出 {number(usage.outputTokens)}
          <br />
          输入包含缓存 Token
        </Metric>
        <Metric title="缓存 Token" value={number(cacheTotal)}>
          读取 {number(read)} · 写入 {number(write)}
          <br />
          未缓存输入 {number(usage.uncachedInputTokens ?? usage.inputTokens)}
        </Metric>
      </div>
      {details && (
        <p className="usage-coverage">
          缓存上报覆盖：读取 {number(details.cacheReadReportedCallCount)} /{" "}
          {number(usage.providerCallCount)} 次，写入 {number(details.cacheWriteReportedCallCount)} /{" "}
          {number(usage.providerCallCount)} 次。未完整上报时仅显示已知缓存量。
        </p>
      )}
      {hasDiagnostics && (
        <details className="usage-diagnostics">
          <summary>
            统计说明与诊断
            {unavailable.length > 0 || (usage.unavailableWorkspaceCount ?? 0) > 0
              ? ` · ${unavailable.length || usage.unavailableWorkspaceCount} 个项目不可读`
              : ""}
          </summary>
          {details?.activitiesTruncated && (
            <p>
              请求日志显示最近 {number(details.activities.length)} / {number(details.activityCount)}{" "}
              条。可缩小时间或项目范围查找更早记录；汇总仍覆盖完整统计范围。
            </p>
          )}
          {unavailable.map((item) => (
            <p key={item.workspacePath}>
              <strong>{item.workspacePath}</strong>
              <br />
              {item.error}
            </p>
          ))}
          {warnings.map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
          {!unavailable.length && (usage.unavailableWorkspaceCount ?? 0) > 0 && (
            <p>部分项目未能读取；刷新可重新获取详细原因。</p>
          )}
        </details>
      )}
      <div className="usage-tabs" role="tablist" aria-label="用量分类">
        {tabs.map((item) => (
          <button
            key={item.id}
            id={`usage-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls="usage-tab-panel"
            tabIndex={tab === item.id ? 0 : -1}
            onKeyDown={(event) => {
              const index = tabs.findIndex((entry) => entry.id === item.id);
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index - 1 + tabs.length) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              const target = tabs[next];
              if (!target) return;
              setTab(target.id);
              setPage(0);
              document.getElementById(`usage-tab-${target.id}`)?.focus();
            }}
            onClick={() => {
              setTab(item.id);
              setPage(0);
            }}
          >
            {item.label}
            <span>{number(counts[item.id])}</span>
          </button>
        ))}
      </div>
      <div id="usage-tab-panel" role="tabpanel" aria-labelledby={`usage-tab-${tab}`}>
        {busy ? (
          <div className="usage-empty" role="status">
            正在加载所选范围的用量…
          </div>
        ) : (
          <>
            {tab === "requests" && (
              <>
                <div className="usage-filters">
                  <input
                    type="search"
                    aria-label="搜索请求"
                    placeholder="搜索模型、厂商、工具或任务"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setPage(0);
                    }}
                  />
                  <select
                    aria-label="请求状态"
                    value={status}
                    onChange={(event) => {
                      setStatus(event.target.value);
                      setPage(0);
                    }}
                  >
                    <option value="all">全部状态</option>
                    {Object.entries(statuses).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <label className="usage-detail-toggle">
                    <input
                      type="checkbox"
                      checked={showDetails}
                      onChange={(event) => setShowDetails(event.target.checked)}
                    />
                    显示明细
                  </label>
                  {(search || status !== "all") && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearch("");
                        setStatus("all");
                        setPage(0);
                      }}
                    >
                      清除筛选
                    </button>
                  )}
                </div>
                {showDetails ? (
                  <Table
                    label="请求日志"
                    page={page}
                    onPage={setPage}
                    headers={[
                      "时间",
                      "类型",
                      "模型 / 工具",
                      "任务",
                      "Token",
                      "费用 · CNY",
                      "耗时",
                      "状态",
                    ]}
                    rows={filtered.map((row) => ({
                      id: row.id,
                      cells: [
                        new Date(row.at).toLocaleString("zh-CN", { hour12: false }),
                        row.kind === "model" ? "模型" : "工具",
                        <span title={row.name}>
                          {row.name}
                          <small className="usage-cell-secondary">{row.provider}</small>
                        </span>,
                        row.sessionId ? (
                          <button
                            type="button"
                            className="usage-session-link"
                            title={`打开任务：${row.sessionTitle || row.sessionId}`}
                            onClick={() => {
                              if (row.sessionId) onOpenSession(row.workspacePath, row.sessionId);
                            }}
                          >
                            {row.sessionTitle || `任务 ${row.sessionId.slice(0, 8)}`}
                          </button>
                        ) : (
                          "未知"
                        ),
                        <span
                          title={`输入 ${number(row.inputTokens)} · 输出 ${number(row.outputTokens)} · 缓存读取 ${number(row.cacheReadTokens)} · 写入 ${number(row.cacheWriteTokens)}`}
                        >
                          {number(row.totalTokens)}
                        </span>,
                        cost(row.costCNY, row.costStatus),
                        duration(row.durationMs),
                        <span className={`usage-status usage-status-${row.status}`}>
                          {statuses[row.status]}
                        </span>,
                      ],
                    }))}
                  />
                ) : (
                  <div className="usage-empty">
                    仅显示汇总 ·{" "}
                    <button type="button" onClick={() => setShowDetails(true)}>
                      显示请求明细
                    </button>
                  </div>
                )}
              </>
            )}
            {(tab === "providers" || tab === "models") && (
              <Table
                label={tab === "providers" ? "厂商" : "模型"}
                headers={[
                  tab === "providers" ? "厂商" : "模型",
                  "请求数",
                  "总 Token",
                  "输入 Token（含缓存）",
                  "输出 Token",
                  "费用 · CNY",
                ]}
                rows={breakdown(details?.[tab] ?? [])}
                page={page}
                onPage={setPage}
              />
            )}
            {tab === "tools" && (
              <Table
                label="工具"
                headers={["工具", "调用数", "成功", "失败", "已取消", "平均耗时"]}
                rows={breakdown(details?.tools ?? [], true)}
                page={page}
                onPage={setPage}
              />
            )}
            {tab === "pricing" && (
              <>
                <p className="usage-coverage">
                  价格单位：USD / 百万 Token。费用汇总以 CNY 显示；此处为当前定价的只读快照。
                </p>
                <Table
                  label="定价"
                  headers={["厂商", "模型", "输入", "输出", "缓存读取", "缓存写入", "来源"]}
                  rows={(details?.pricing ?? []).map((row) => ({
                    id: `${row.provider}/${row.model}`,
                    cells: [
                      row.provider,
                      row.model,
                      ...[
                        row.inputPerMillion,
                        row.outputPerMillion,
                        row.cacheReadPerMillion,
                        row.cacheWritePerMillion,
                      ].map((value) => (value === null ? "未知" : `$${value}`)),
                      {
                        configured: "配置",
                        official_docs_snapshot: "官方文档快照",
                        included: "套餐内",
                      }[row.source],
                    ],
                  }))}
                  page={page}
                  onPage={setPage}
                />
              </>
            )}
            {!details && <p className="usage-coverage">暂无分类明细，刷新以加载最新统计。</p>}
          </>
        )}
      </div>
      {usage.refreshedAt !== undefined && (
        <p className="usage-updated">
          更新于 {new Date(usage.refreshedAt).toLocaleString("zh-CN", { hour12: false })}
        </p>
      )}
    </section>
  );
}
