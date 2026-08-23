import { ChevronDown, CircleAlert, RefreshCw, Wrench } from "lucide-react";

export interface InspectorContextSection {
  readonly id: string;
  readonly label: string;
  readonly tokens?: number;
  readonly state?: "included" | "compacted" | "omitted" | "unknown";
}

export interface InspectorContextSnapshot {
  readonly version: number;
  readonly routeId?: string;
  readonly estimatedInputTokens?: number;
  readonly inputBudgetTokens?: number;
  readonly remainingTokens?: number;
  readonly contextWindowTokens?: number;
  readonly usedPercent?: number;
  readonly estimation?: "actual" | "estimated" | "unknown";
  readonly compactedCount?: number;
  readonly sections?: readonly InspectorContextSection[];
}

export interface InspectorTraceItem {
  readonly id: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly kind: string;
  readonly title: string;
  readonly summary?: string;
  readonly status?: "pending" | "running" | "completed" | "failed" | "interrupted";
  readonly toolCallId?: string;
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
  if (context?.usedPercent !== undefined && Number.isFinite(context.usedPercent)) {
    return Math.min(100, Math.max(0, context.usedPercent));
  }
  if (
    context?.estimatedInputTokens === undefined ||
    context.inputBudgetTokens === undefined ||
    context.inputBudgetTokens <= 0
  ) {
    return undefined;
  }
  return Math.min(
    100,
    Math.max(0, (context.estimatedInputTokens / context.inputBudgetTokens) * 100),
  );
}

export function InspectorWorkbarPanel({
  context,
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
  const usage = contextUsagePercent(context);

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
        <section className="tool-panel__section" aria-labelledby="inspector-context-title">
          <div className="tool-panel__section-heading">
            <h3 id="inspector-context-title">上下文</h3>
            {context?.routeId && <code>{context.routeId}</code>}
          </div>
          {!context ? (
            <p className="tool-panel__muted">尚未生成上下文快照。</p>
          ) : (
            <>
              <dl className="tool-panel__metrics">
                <div>
                  <dt>已使用</dt>
                  <dd>{usage === undefined ? "未知" : `${usage.toFixed(1)}%`}</dd>
                </div>
                <div>
                  <dt>输入</dt>
                  <dd>{formatTokens(context.estimatedInputTokens)}</dd>
                </div>
                <div>
                  <dt>剩余</dt>
                  <dd>{formatTokens(context.remainingTokens)}</dd>
                </div>
                <div>
                  <dt>压缩</dt>
                  <dd>{context.compactedCount ?? 0} 次</dd>
                </div>
              </dl>
              {usage !== undefined && (
                <div
                  className="tool-panel__progress"
                  role="progressbar"
                  aria-label="上下文使用率"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(usage)}
                >
                  <span style={{ width: `${usage}%` }} />
                </div>
              )}
              {context.sections && context.sections.length > 0 && (
                <ul className="tool-panel__compact-list" aria-label="上下文组成">
                  {context.sections.map((section) => (
                    <li key={section.id} data-state={section.state ?? "unknown"}>
                      <span>{section.label}</span>
                      <small>{formatTokens(section.tokens)}</small>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        <section className="tool-panel__section" aria-labelledby="inspector-trace-title">
          <div className="tool-panel__section-heading">
            <h3 id="inspector-trace-title">时间线</h3>
            <span>{trace.length} 条</span>
          </div>
          {loading && trace.length === 0 ? (
            <p className="tool-panel__state" role="status">
              正在加载追踪…
            </p>
          ) : trace.length === 0 ? (
            <p className="tool-panel__state">当前任务还没有追踪记录。</p>
          ) : (
            <ol className="tool-panel__timeline">
              {trace.map((item) => (
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
                        #{item.sequence} · {item.kind} · {formatTimestamp(item.createdAt)}
                      </small>
                    </span>
                    {item.toolCallId && <Wrench aria-label="工具调用" size={13} />}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {hasMore && onLoadMore && (
            <button type="button" className="tool-panel__load-more" onClick={onLoadMore}>
              <ChevronDown aria-hidden="true" size={14} />
              加载更早记录
            </button>
          )}
        </section>

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
