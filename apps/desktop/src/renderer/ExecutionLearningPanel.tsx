import { useEffect, useId, useRef, useState } from "react";
import type {
  ExecutionAcceptanceClaim,
  ExecutionCondition,
  ExecutionLearningState,
  ExecutionLearningStatus,
  MemoryItemSource,
} from "@pico/core";
import { Button, InlineNotice } from "./components.js";

export interface ExecutionLearningInspection {
  readonly claim?: ExecutionAcceptanceClaim;
  readonly hypothesis?: string;
  readonly reason?: string;
  readonly sources?: readonly MemoryItemSource[];
}

export interface ExecutionLearningPanelProps {
  readonly statuses: readonly ExecutionLearningStatus[];
  readonly workspaceKey: string;
  readonly sessionId?: string;
  readonly mode?: "memory" | "conversation";
  readonly onInspect: (candidateId: string) => Promise<ExecutionLearningInspection | undefined>;
  readonly onDiscard: (candidateId: string, revision: number) => Promise<void>;
}

const stateLabels: Readonly<Record<ExecutionLearningState, string>> = {
  waiting: "待自然验收",
  ready: "待整理",
  working: "整理中",
  saved: "已保存经验",
  insufficient: "证据不足",
  invalidated: "待复核",
  discarded: "已丢弃",
  expired: "过期",
};
const predicateLabels = {
  "test-target-pass.v1": "测试验收",
  "command-conditions.v1": "环境条件验收",
};

/** Persistent status is supplied by the caller; this panel never promotes or removes candidates. */
export function ExecutionLearningPanel({
  statuses,
  workspaceKey,
  sessionId,
  mode = "memory",
  onInspect,
  onDiscard,
}: ExecutionLearningPanelProps) {
  const scoped = statuses.filter(
    (status) =>
      status.workspaceKey === workspaceKey &&
      (sessionId === undefined || status.sessionId === sessionId),
  );
  if (scoped.length === 0) return null;

  const cards = (items: readonly ExecutionLearningStatus[]) => (
    <div className="memory-list">
      {items.map((status) => (
        <CandidateCard
          key={JSON.stringify([
            status.workspaceKey,
            status.sessionId,
            status.candidateId,
            status.revision,
            status.updatedAt,
            status.state,
          ])}
          status={status}
          onInspect={onInspect}
          onDiscard={onDiscard}
        />
      ))}
    </div>
  );

  if (mode === "conversation") {
    const runs = new Map<string, ExecutionLearningStatus[]>();
    for (const status of scoped) {
      const key = JSON.stringify([status.sessionId, status.runId]);
      const run = runs.get(key) ?? [];
      run.push(status);
      runs.set(key, run);
    }
    return (
      <div className="execution-learning__runs">
        {[...runs].map(([key, items]) => (
          <details
            className="execution-learning execution-learning--conversation"
            key={key}
            data-run-id={items[0]?.runId}
            aria-label="本轮执行经验"
          >
            <summary>
              <span>本轮执行经验</span>
              <span className="execution-learning__summary-state">
                {[...new Set(items.map((item) => stateLabels[item.state]))].join("、")}
              </span>
              <span>{items.length} 项</span>
            </summary>
            {cards(items)}
          </details>
        ))}
      </div>
    );
  }

  return (
    <details className="execution-learning" aria-label="执行经验候选">
      <summary>
        <span>执行经验候选</span>
        <span>{scoped.length} 项</span>
      </summary>
      {cards(scoped)}
    </details>
  );
}

function CandidateCard({
  status,
  onInspect,
  onDiscard,
}: Pick<ExecutionLearningPanelProps, "onInspect" | "onDiscard"> & {
  readonly status: ExecutionLearningStatus;
}) {
  const detailId = useId();
  const [open, setOpen] = useState(false);
  const [inspection, setInspection] = useState<ExecutionLearningInspection>();
  const [inspecting, setInspecting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const request = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, []);

  const inspect = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (inspection || inspecting) return;
    const sequence = ++request.current;
    setInspecting(true);
    setError("");
    try {
      const result = await onInspect(status.candidateId);
      if (!mounted.current || sequence !== request.current) return;
      if (
        result?.claim &&
        (result.claim.candidateId !== status.candidateId ||
          result.claim.revision !== status.revision ||
          result.claim.predicateId !== status.predicateId ||
          result.claim.target.targetId !== status.targetId ||
          result.claim.admission.workspaceKey !== status.workspaceKey ||
          result.claim.admission.sessionId !== status.sessionId ||
          result.claim.admission.runId !== status.runId)
      ) {
        setError("候选已更新，请刷新后重试。");
      } else if (result) {
        setInspection(result);
      } else {
        setError("无法读取候选详情，请刷新后重试。");
      }
    } catch {
      if (mounted.current && sequence === request.current) setError("无法读取候选详情，请重试。");
    } finally {
      if (mounted.current && sequence === request.current) setInspecting(false);
    }
  };

  const discard = async () => {
    if (discarding || discarded) return;
    request.current += 1;
    setInspecting(false);
    setDiscarding(true);
    setError("");
    try {
      await onDiscard(status.candidateId, status.revision);
      if (mounted.current) setDiscarded(true);
    } catch {
      if (mounted.current) setError("丢弃失败，候选可能已更新，请刷新后重试。");
    } finally {
      if (mounted.current) setDiscarding(false);
    }
  };

  const sources = uniqueSources([
    ...status.sources,
    ...(inspection?.sources ?? []),
    ...(inspection?.claim
      ? [inspection.claim.failure, ...inspection.claim.recipe.map((step) => step.source)]
      : []),
  ]);
  const canDiscard = status.state !== "discarded" && status.state !== "expired";
  return (
    <article
      className="memory-card execution-learning__candidate"
      data-candidate-id={status.candidateId}
      data-state={status.state}
    >
      <div className="memory-card__meta">
        <span>{stateLabels[status.state]}</span>
        <span>{predicateLabels[status.predicateId]}</span>
      </div>
      <h4>{status.targetLabel}</h4>
      {status.reason && <p className="memory-card__reason">{status.reason}</p>}
      {status.state === "waiting" && <p>等待后续任务中的实际执行满足验收条件。</p>}
      <SourceDetails sources={sources} itemId={status.itemId} />
      <div className="memory-card__actions">
        <Button
          variant="quiet"
          aria-label={`查看候选详情 ${status.targetLabel}`}
          aria-expanded={open}
          aria-controls={detailId}
          disabled={discarding || discarded}
          onClick={() => void inspect()}
        >
          {open ? "收起详情" : "查看详情"}
        </Button>
        {canDiscard && (
          <Button
            variant="quiet"
            aria-label={`丢弃候选 ${status.targetLabel}`}
            disabled={discarding || discarded}
            onClick={() => void discard()}
          >
            {discarding ? "丢弃中…" : "丢弃"}
          </Button>
        )}
      </div>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {discarded && <p role="status">丢弃请求已完成，等待最新状态。</p>}
      {open && (
        <div id={detailId} className="execution-learning__inspection" aria-busy={inspecting}>
          {inspecting && <p role="status">正在读取详情…</p>}
          {inspection && <InspectionDetails inspection={inspection} />}
        </div>
      )}
    </article>
  );
}

function InspectionDetails({ inspection }: { readonly inspection: ExecutionLearningInspection }) {
  const claim = inspection.claim;
  return (
    <>
      {inspection.hypothesis && (
        <div>
          <h5>假设（未验证）</h5>
          <p>{inspection.hypothesis}</p>
        </div>
      )}
      {inspection.reason && <p>{inspection.reason}</p>}
      {claim && (
        <dl>
          <div>
            <dt>验收方式</dt>
            <dd>{predicateLabels[claim.predicateId]}</dd>
          </div>
          <div>
            <dt>执行命令</dt>
            <dd>
              <code>{claim.target.command}</code>
            </dd>
          </div>
          <div>
            <dt>工作目录</dt>
            <dd>{claim.target.cwd}</dd>
          </div>
          {claim.failedTestIds.length > 0 && (
            <div>
              <dt>失败测试</dt>
              <dd>{claim.failedTestIds.join("、")}</dd>
            </div>
          )}
          {claim.conditions.length > 0 && (
            <div>
              <dt>验收条件</dt>
              <dd>
                <ul>
                  {claim.conditions.map((condition, index) => (
                    <li key={index}>{conditionLabel(condition)}</li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
        </dl>
      )}
    </>
  );
}

function SourceDetails({
  sources,
  itemId,
}: {
  readonly sources: readonly MemoryItemSource[];
  readonly itemId?: string;
}) {
  return (
    <details className="memory-source">
      <summary>查看来源{sources.length > 0 ? `（${sources.length} 条）` : ""}</summary>
      {itemId && <p>已保存记忆：{itemId}</p>}
      {sources.length === 0 ? (
        <p>来源详情未提供。</p>
      ) : (
        sources.map((source) => (
          <dl key={JSON.stringify(source)}>
            <div>
              <dt>来源会话</dt>
              <dd>{source.sessionId}</dd>
            </div>
            <div>
              <dt>来源运行</dt>
              <dd>{source.runId}</dd>
            </div>
            <div>
              <dt>来源回合</dt>
              <dd>{source.turnId}</dd>
            </div>
            <div>
              <dt>来源引用</dt>
              <dd>{source.eventId}</dd>
            </div>
          </dl>
        ))
      )}
    </details>
  );
}

function uniqueSources(sources: readonly MemoryItemSource[]): MemoryItemSource[] {
  const unique = new Map<string, MemoryItemSource>();
  for (const source of sources) {
    unique.set(
      JSON.stringify([source.sessionId, source.runId, source.turnId, source.eventId]),
      source,
    );
  }
  return [...unique.values()];
}

function conditionLabel(condition: ExecutionCondition): string {
  switch (condition.kind) {
    case "cwd":
      return `工作目录：${condition.path}`;
    case "file":
      return `文件：${condition.path}（内容摘要 ${condition.hash}）`;
    case "json":
      return `配置：${condition.path} · ${condition.field.join(".")} = ${JSON.stringify(condition.value)}`;
    case "node-package":
      return `本地 Node 依赖：${condition.name}@${condition.version} · ${condition.path}`;
  }
}
