import type {
  RuntimeExecutionPage,
  RuntimeExecutionSummary,
  RuntimeSessionContextSnapshot,
} from "@pico/protocol";
import { ContextComposition } from "./ContextComposition.js";
import { ExecutionTraceTimeline, ExecutionUsageSummary } from "./ExecutionTraceTimeline.js";
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
  readonly onSelectTrace: (traceId: string) => void;
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
  const traceGroups = groupInspectorTraceItems(trace);
  const visibleTraceCount = traceGroups.reduce((count, group) => count + group.items.length, 0);

  return (
    <section className="tool-panel tool-panel--inspector" aria-label="追踪">
      <header className="tool-panel__header">
        <div>
          <span className="tool-panel__eyebrow">Context v{context?.version ?? "—"}</span>
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

      <div className="tool-panel__scroll" aria-busy={loading}>
        {summaryLoading && (
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
        {contextError && (
          <p className="tool-panel__error" role="alert">
            上下文读取失败：{contextError}
          </p>
        )}
        <ContextComposition request={context?.latestRequest} />
        <section className="tool-panel__section" aria-labelledby="inspector-context-title">
          <div className="tool-panel__section-heading">
            <h3 id="inspector-context-title">当前模型历史</h3>
          </div>
          {!context ? (
            <p className="tool-panel__muted">尚未生成上下文快照。</p>
          ) : (
            <>
              <p className="tool-panel__muted">
                压缩摘要与后续消息的有效模型视图；Token
                按字符与媒体估算，不包含完整请求的系统指令、工具定义及协议开销。
              </p>
              <dl className="tool-panel__metrics">
                <div>
                  <dt>估算 Token</dt>
                  <dd>≈{formatTokens(context.modelHistory.estimatedTokens)}</dd>
                </div>
                <div>
                  <dt>历史消息</dt>
                  <dd>{context.modelHistory.messageCount} 条</dd>
                </div>
                <div>
                  <dt>压缩</dt>
                  <dd>{context.modelHistory.compactedCount} 次</dd>
                </div>
              </dl>
              <details>
                <summary>历史投影详情</summary>
                <p className="tool-panel__muted">
                  读取水位 {context.modelHistory.throughSequence} · 算法{" "}
                  {context.modelHistory.estimationAlgorithm}
                </p>
                {context.modelHistory.latestCompaction && (
                  <>
                    <p className="tool-panel__muted">
                      最近压缩 · 覆盖 {context.modelHistory.latestCompaction.coveredEventCount} 条
                    </p>
                    <p className="tool-panel__muted">
                      压缩记录 <code>{context.modelHistory.latestCompaction.checkpointId}</code>
                    </p>
                    <p className="tool-panel__muted">
                      覆盖边界 <code>{context.modelHistory.latestCompaction.throughEventId}</code>
                    </p>
                  </>
                )}
              </details>
            </>
          )}
        </section>

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

function formatTokens(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "未知";
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
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
