import { useId, useState, type KeyboardEvent } from "react";
import type {
  RuntimeExecutionPage,
  RuntimeExecutionSummary,
  RuntimeSessionContextSnapshot,
} from "@pico/protocol";
import { ContextComposition } from "./ContextComposition.js";
import { CurrentModelHistory } from "./CurrentModelHistory.js";
import { ExecutionTraceTimeline } from "./ExecutionTraceTimeline.js";
import { ExecutionUsageSummary } from "./ExecutionUsageSummary.js";
import { ChevronDown, CircleAlert, RefreshCw, Wrench } from "lucide-react";

export type InspectorContextSnapshot = RuntimeSessionContextSnapshot;

export interface InspectorTraceItem {
  readonly id: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly kind: string;
  readonly category?:
    | "run"
    | "model"
    | "tool"
    | "approval"
    | "context"
    | "plan"
    | "graph"
    | "other";
  readonly runId?: string;
  readonly title: string;
  readonly summary?: string;
  readonly status?: "pending" | "running" | "completed" | "failed" | "interrupted";
  readonly durationMs?: number;
  readonly toolCallId?: string;
}

export interface InspectorTraceGroup {
  readonly id: string;
  readonly label: string;
  readonly createdAt?: string;
  readonly status?: InspectorTraceItem["status"];
  readonly durationMs?: number;
  readonly items: readonly InspectorTraceItem[];
}

export interface InspectorToolPreview {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly input?: string;
  readonly output?: string;
  readonly error?: string;
  readonly truncated?: boolean;
}

export interface InspectorWorkbarPanelProps {
  readonly summary?: RuntimeExecutionSummary;
  readonly summaryLoading?: boolean;
  readonly summaryError?: string;
  readonly loadingEarlier?: boolean;
  readonly canHideEarlier?: boolean;
  readonly onHideEarlier?: () => void;
  readonly execution?: RuntimeExecutionPage;
  readonly contextError?: string;
  readonly context?: InspectorContextSnapshot;
  readonly trace: readonly InspectorTraceItem[];
  readonly selectedTraceId?: string;
  readonly preview?: InspectorToolPreview | null;
  readonly loading: boolean;
  readonly error?: string | null;
  readonly hasMore?: boolean;
  readonly onRefresh: () => void;
  readonly onSelectTrace: (traceId: string | undefined) => void;
  readonly onLoadMore?: () => void;
  readonly onOpenPreview?: (traceId: string) => void;
}

export function contextUsagePercent(context?: InspectorContextSnapshot): number | undefined {
  const request = context?.latestRequest;
  if (
    request?.status !== "available" ||
    request.inputTokens === undefined ||
    request.usageStatus === "missing" ||
    !request.contextWindow
  )
    return undefined;
  return Math.min(100, Math.max(0, (request.inputTokens / request.contextWindow) * 100));
}

export function groupInspectorTraceItems(
  trace: readonly InspectorTraceItem[],
): readonly InspectorTraceGroup[] {
  const groups = new Map<string, { run?: InspectorTraceItem; items: InspectorTraceItem[] }>();
  for (const item of trace) {
    const id = item.runId ?? "session";
    const group = groups.get(id) ?? { items: [] };
    if (item.category === "run") group.run = item;
    else group.items.push(item);
    groups.set(id, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.items.length > 0 || group.run?.status !== "completed")
    .map(([id, group], index) => ({
      id,
      label: id === "session" ? "会话事件" : `运行 ${index + 1}`,
      createdAt: group.run?.createdAt ?? group.items[0]?.createdAt,
      status: group.run?.status,
      durationMs: group.run?.durationMs,
      items: group.items,
    }));
}

export function InspectorWorkbarPanel({
  context,
  summary,
  summaryLoading,
  summaryError,
  loadingEarlier,
  canHideEarlier,
  onHideEarlier,
  execution,
  contextError,
  trace,
  selectedTraceId,
  preview,
  loading,
  error,
  hasMore = false,
  onRefresh,
  onSelectTrace,
  onLoadMore,
  onOpenPreview,
}: InspectorWorkbarPanelProps) {
  const [tab, setTab] = useState<"timeline" | "overview">("timeline");
  const tabId = useId();
  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? "timeline"
        : event.key === "End"
          ? "overview"
          : tab === "timeline"
            ? "overview"
            : "timeline";
    setTab(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
  }
  const traceGroups = groupInspectorTraceItems(trace);
  const visibleTraceCount = traceGroups.reduce((count, group) => count + group.items.length, 0);

  return (
    <section className="tool-panel tool-panel--inspector" aria-label="追踪">
      <header className="tool-panel__header">
        <div>
          <strong>执行追踪</strong>
        </div>
        <button
          type="button"
          className="tool-panel__icon-button"
          aria-label="刷新追踪"
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden="true" size={15} />
        </button>
      </header>

      {error && (
        <p className="tool-panel__error" role="alert">
          <CircleAlert aria-hidden="true" size={14} />
          {error}
        </p>
      )}

      <div className="inspector-tabs" role="tablist" aria-label="追踪视图" onKeyDown={navigateTabs}>
        {(
          [
            ["timeline", "时间线"],
            ["overview", "总览"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            data-tab={value}
            id={`${tabId}-${value}-tab`}
            aria-selected={tab === value}
            aria-controls={`${tabId}-${value}-panel`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id={`${tabId}-overview-panel`}
        role="tabpanel"
        aria-labelledby={`${tabId}-overview-tab`}
        hidden={tab !== "overview"}
        className="inspector-page tool-panel__scroll"
        tabIndex={0}
      >
        {contextError && (
          <p className="tool-panel__error" role="alert">
            上下文读取失败：{contextError}
          </p>
        )}
        <ContextComposition request={context?.latestRequest} />
        {summaryLoading && !summary && !execution && (
          <p className="tool-panel__muted" role="status">
            正在加载会话用量…
          </p>
        )}
        {summaryError && (
          <p className="tool-panel__error" role="status">
            会话用量读取失败：{summaryError}
          </p>
        )}
        {(summary ?? execution?.summary) && (
          <ExecutionUsageSummary summary={(summary ?? execution?.summary)!} />
        )}
        {!summaryLoading && !summary && !execution && !summaryError && (
          <p className="tool-panel__state">尚无会话用量记录。</p>
        )}
        <CurrentModelHistory context={context} />
      </div>
      <div
        id={`${tabId}-timeline-panel`}
        role="tabpanel"
        aria-labelledby={`${tabId}-timeline-tab`}
        hidden={tab !== "timeline"}
        className="inspector-page tool-panel__scroll"
        aria-busy={loading}
        tabIndex={0}
      >
        {execution ? (
          <ExecutionTraceTimeline
            execution={execution}
            selectedTraceId={selectedTraceId}
            onSelectTrace={onSelectTrace}
          />
        ) : (
          <section className="tool-panel__section" aria-labelledby="inspector-trace-title">
            <div className="tool-panel__section-heading">
              <h3 id="inspector-trace-title">时间线</h3>
              <span>
                {traceGroups.length} 次运行 · {visibleTraceCount} 项
              </span>
            </div>
            {loading && trace.length === 0 ? (
              <p className="tool-panel__state" role="status">
                正在加载追踪…
              </p>
            ) : trace.length === 0 ? (
              <p className="tool-panel__state">当前任务还没有追踪记录。</p>
            ) : (
              <div className="tool-panel__trace-groups">
                {traceGroups.map((group) => (
                  <section
                    className="tool-panel__trace-group"
                    data-status={group.status}
                    key={group.id}
                  >
                    <header>
                      <span>
                        <strong>{group.label}</strong>
                        {group.status && <small>{statusLabel(group.status)}</small>}
                      </span>
                      <small>
                        {group.durationMs === undefined
                          ? formatTimestamp(group.createdAt ?? "")
                          : formatDuration(group.durationMs)}
                      </small>
                    </header>
                    {group.items.length === 0 ? (
                      <p className="tool-panel__muted">没有可展示的执行步骤。</p>
                    ) : (
                      <ol className="tool-panel__timeline">
                        {group.items.map((item) => (
                          <li key={item.id} data-status={item.status ?? "completed"}>
                            <button
                              type="button"
                              aria-pressed={selectedTraceId === item.id}
                              onClick={() => onSelectTrace(item.id)}
                              onDoubleClick={() => onOpenPreview?.(item.id)}
                            >
                              <span className="tool-panel__timeline-marker" aria-hidden="true" />
                              <span className="tool-panel__timeline-copy">
                                <strong>{item.title}</strong>
                                {item.summary && <span>{item.summary}</span>}
                                <small>
                                  {item.durationMs === undefined
                                    ? formatTimestamp(item.createdAt)
                                    : formatDuration(item.durationMs)}
                                  {` · ${item.kind}`}
                                </small>
                              </span>
                              {item.toolCallId && <Wrench aria-label="工具调用" size={13} />}
                            </button>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                ))}
              </div>
            )}
          </section>
        )}
        {hasMore && onLoadMore && (
          <button
            type="button"
            className="tool-panel__load-more"
            disabled={loading}
            onClick={onLoadMore}
          >
            <ChevronDown aria-hidden="true" size={14} />
            {loadingEarlier ? "正在加载较早记录…" : "加载较早记录"}
          </button>
        )}

        {canHideEarlier && onHideEarlier && (
          <button
            type="button"
            className="tool-panel__load-more"
            disabled={loading}
            onClick={onHideEarlier}
          >
            隐藏较早记录
          </button>
        )}

        {preview && (
          <section className="tool-panel__section tool-panel__preview" aria-label="工具详情预览">
            <div className="tool-panel__section-heading">
              <h3>{preview.title}</h3>
              {preview.truncated && <span>已截断</span>}
            </div>
            {preview.subtitle && <p className="tool-panel__muted">{preview.subtitle}</p>}
            {preview.input && <PreviewBlock label="输入" value={preview.input} />}
            {preview.output && <PreviewBlock label="输出" value={preview.output} />}
            {preview.error && <PreviewBlock label="错误" value={preview.error} error />}
          </section>
        )}
      </div>
    </section>
  );
}

function PreviewBlock({
  label,
  value,
  error = false,
}: {
  label: string;
  value: string;
  error?: boolean;
}) {
  return (
    <div className="tool-panel__code-block" data-error={error || undefined}>
      <strong>{label}</strong>
      <pre>{value}</pre>
    </div>
  );
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))} 毫秒`;
  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

function statusLabel(status: NonNullable<InspectorTraceItem["status"]>): string {
  if (status === "pending") return "等待中";
  if (status === "running") return "进行中";
  if (status === "failed") return "失败";
  if (status === "interrupted") return "已中断";
  return "已完成";
}
