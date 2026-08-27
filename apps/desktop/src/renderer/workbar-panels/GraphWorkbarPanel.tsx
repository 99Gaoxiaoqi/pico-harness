import { Activity, CircleAlert, GitFork, RefreshCw } from "lucide-react";

export interface WorkbarGraphSummary {
  readonly graphId: string;
  readonly epoch: number;
  readonly phase: "open" | "finished";
  readonly headRevision: number;
  readonly createdAt: number;
  readonly finishedAt?: number;
  readonly counts: {
    readonly operators: number;
    readonly intents: number;
    readonly claims: number;
    readonly records: number;
    readonly resources: number;
    readonly wakes: number;
  };
}

export interface WorkbarGraphDetail {
  readonly summary: WorkbarGraphSummary;
  readonly operators: readonly {
    readonly operatorId: string;
    readonly role: string;
    readonly profileId?: string;
  }[];
  readonly intents: readonly {
    readonly intentId: string;
    readonly operatorId: string;
    readonly instruction: string;
  }[];
  readonly claims: readonly {
    readonly claimId: string;
    readonly intentId: string;
    readonly state: string;
  }[];
}

export interface WorkbarGraphTimelineItem {
  readonly id: string;
  readonly at: number;
  readonly kind: string;
  readonly status?: string;
  readonly subjectId?: string;
  readonly detail?: string;
}

export interface GraphWorkbarPanelProps {
  readonly graphs: readonly WorkbarGraphSummary[];
  readonly selectedGraphId?: string;
  readonly detail?: WorkbarGraphDetail;
  readonly timeline: readonly WorkbarGraphTimelineItem[];
  readonly loading: boolean;
  readonly error?: string;
  readonly onRefresh: () => void;
  readonly onSelectGraph: (graphId: string) => void;
}

export function GraphWorkbarPanel({
  graphs,
  selectedGraphId,
  detail,
  timeline,
  loading,
  error,
  onRefresh,
  onSelectGraph,
}: GraphWorkbarPanelProps) {
  return (
    <section className="tool-panel tool-panel--graph" aria-label="Graph">
      <header className="tool-panel__header">
        <div>
          <span className="tool-panel__eyebrow">持久调度</span>
          <strong>Graph</strong>
        </div>
        <div className="tool-panel__header-meta">
          <span>{detail ? `epoch ${detail.summary.epoch}` : `${graphs.length} 个周期`}</span>
          <button
            type="button"
            className="tool-panel__icon-button"
            aria-label="刷新 Graph"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw aria-hidden="true" size={15} />
          </button>
        </div>
      </header>

      {error && (
        <p className="tool-panel__error" role="alert">
          <CircleAlert aria-hidden="true" size={14} />
          {error}
        </p>
      )}

      <div className="graph-panel__epochs" aria-label="Graph 周期">
        {graphs.map((graph) => (
          <button
            type="button"
            key={graph.graphId}
            data-active={graph.graphId === selectedGraphId || undefined}
            data-phase={graph.phase}
            onClick={() => onSelectGraph(graph.graphId)}
          >
            <span>e{graph.epoch}</span>
            <small>{graph.phase === "open" ? "运行中" : "已完成"}</small>
          </button>
        ))}
      </div>

      <div className="tool-panel__scroll" aria-busy={loading}>
        {loading && !detail ? (
          <p className="tool-panel__state" role="status">
            正在读取 Graph…
          </p>
        ) : !detail ? (
          <div className="tool-panel__state">
            <GitFork aria-hidden="true" size={22} />
            <strong>没有调度周期</strong>
            <span>当前任务进入 Graph 模式后，持久调度事实会显示在这里。</span>
          </div>
        ) : (
          <>
            <GraphMetrics summary={detail.summary} />
            <section className="graph-panel__section" aria-label="Operator">
              <div className="graph-panel__section-title">
                <strong>Operator</strong>
                <span>{detail.operators.length}</span>
              </div>
              <ul className="graph-panel__operators">
                {detail.operators.map((operator) => (
                  <li key={operator.operatorId}>
                    <span className="graph-panel__node" aria-hidden="true" />
                    <div>
                      <strong>{operator.role}</strong>
                      <small>{operator.profileId ?? operator.operatorId}</small>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
            <section className="graph-panel__section" aria-label="意图">
              <div className="graph-panel__section-title">
                <strong>意图</strong>
                <span>{detail.intents.length}</span>
              </div>
              <ul className="graph-panel__intents">
                {detail.intents.map((intent) => {
                  const claim = detail.claims.find(
                    (candidate) => candidate.intentId === intent.intentId,
                  );
                  return (
                    <li key={intent.intentId}>
                      <div>
                        <strong>{intent.instruction}</strong>
                        <small>{intent.operatorId}</small>
                      </div>
                      <span data-state={claim?.state ?? "planned"}>
                        {claim?.state ?? "planned"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
            <section className="graph-panel__section" aria-label="Graph 时间线">
              <div className="graph-panel__section-title">
                <strong>时间线</strong>
                <span>{timeline.length}</span>
              </div>
              <ol className="graph-panel__timeline">
                {timeline.map((item) => (
                  <li key={item.id}>
                    <Activity aria-hidden="true" size={13} />
                    <div>
                      <strong>{timelineLabel(item.kind)}</strong>
                      <small>
                        {formatTimestamp(item.at)}
                        {item.status ? ` · ${item.status}` : ""}
                      </small>
                      {item.detail && <p>{item.detail}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
      </div>
    </section>
  );
}

function GraphMetrics({ summary }: { readonly summary: WorkbarGraphSummary }) {
  const metrics = [
    ["意图", summary.counts.intents],
    ["执行", summary.counts.claims],
    ["产出", summary.counts.records],
    ["资源", summary.counts.resources],
  ] as const;
  return (
    <div className="graph-panel__metrics">
      {metrics.map(([label, value]) => (
        <div key={label}>
          <strong>{value}</strong>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

function timelineLabel(kind: string): string {
  const labels: Record<string, string> = {
    "graph.created": "周期创建",
    "graph.finished": "周期完成",
    "schedule.committed": "调度更新",
    "operator.provisioned": "Operator 就绪",
    "operator.stopped": "Operator 停止",
    "activation.claimed": "执行已认领",
    "activation.executing": "执行开始",
    "activation.cancelled": "执行取消",
    "record.committed": "正式产出",
    "resource.retained": "资源保留",
    "yield.registered": "根等待",
    "yield.resolved": "等待结束",
    "wake.enqueued": "根唤醒入队",
    "wake.settled": "根唤醒完成",
    "wake.attempted": "根唤醒尝试",
  };
  return labels[kind] ?? kind;
}

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}
