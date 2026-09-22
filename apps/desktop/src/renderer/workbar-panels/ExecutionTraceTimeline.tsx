import type { RuntimeExecutionPage, RuntimeExecutionStep } from "@pico/protocol";

export function ExecutionTraceTimeline({
  execution,
  selectedTraceId,
  onSelectTrace,
}: {
  readonly execution: RuntimeExecutionPage;
  readonly selectedTraceId?: string;
  readonly onSelectTrace: (id: string) => void;
}) {
  const { summary, coverage } = execution;
  const selected = execution.runs
    .flatMap((run) => run.steps)
    .find((step) => step.id === selectedTraceId);
  const gaps = [
    coverage.oversizedRunIds.length > 0 &&
      `${coverage.oversizedRunIds.length} 次运行过大，步骤未完整展示`,
    coverage.missingModelCallRunIds.length > 0 &&
      `${coverage.missingModelCallRunIds.length} 次运行缺少模型调用记录`,
    coverage.incompleteRunIds.length > 0 && `${coverage.incompleteRunIds.length} 次运行记录不完整`,
  ].filter(Boolean);
  return (
    <>
      <section className="tool-panel__section" aria-label="会话用量">
        <h3>会话用量</h3>
        <dl className="tool-panel__metrics">
          <div>
            <dt>模型调用</dt>
            <dd>{summary.modelCalls} 次</dd>
          </div>
          <div>
            <dt>失败调用</dt>
            <dd>{summary.failedCalls} 次</dd>
          </div>
          <div>
            <dt>输入 Token</dt>
            <dd>{tokens(summary.inputTokens)}</dd>
          </div>
          <div>
            <dt>输出 Token</dt>
            <dd>{tokens(summary.outputTokens)}</dd>
          </div>
          <div>
            <dt>已知费用</dt>
            <dd>{money(summary.costCNY)}</dd>
          </div>
          <div>
            <dt>模型耗时</dt>
            <dd>{duration(summary.latencyMs)}</dd>
          </div>
        </dl>
        <p className="tool-panel__muted">
          统计范围：整个会话。仅记录逻辑调用，不包含底层重试次数。
        </p>
        {summary.unpricedCalls > 0 && (
          <p className="tool-panel__muted">
            {summary.unpricedCalls} 次调用费用未知，已知费用不代表完整总额。
          </p>
        )}
        {summary.meteredCalls < summary.modelCalls && (
          <p className="tool-panel__muted">部分调用没有 Token 用量记录。</p>
        )}
      </section>
      <section className="tool-panel__section" aria-label="执行时间线">
        <h3>时间线</h3>
        {gaps.length > 0 && (
          <p className="tool-panel__error" role="status">
            追踪覆盖不足：{gaps.join("；")}。
          </p>
        )}
        {execution.runs.length === 0 && (
          <p className="tool-panel__state">
            {gaps.length > 0 ? "部分执行记录暂不可展示。" : "当前任务还没有追踪记录。"}
          </p>
        )}
        <div className="tool-panel__trace-groups">
          {execution.runs.map((run) => {
            const turns = new Map<string, RuntimeExecutionStep[]>();
            for (const step of run.steps)
              turns.set(step.turnId, [...(turns.get(step.turnId) ?? []), step]);
            return (
              <section className="tool-panel__trace-group" data-status={run.status} key={run.runId}>
                <header>
                  <span>
                    <strong>{timestamp(run.at)}</strong>
                    <small>{status(run.status)}</small>
                  </span>
                  <small>{duration(run.durationMs)}</small>
                </header>
                {run.reason && (
                  <p
                    className={run.status === "failed" ? "tool-panel__error" : "tool-panel__muted"}
                  >
                    {run.reason}
                  </p>
                )}
                {turns.size === 0 && <p className="tool-panel__muted">没有可展示的执行步骤。</p>}
                {[...turns].map(([turnId, steps], index) => (
                  <section key={turnId} aria-label={`轮次 ${index + 1}`}>
                    <h4>轮次 {index + 1}</h4>
                    <ol className="tool-panel__timeline">
                      {steps.map((step) => (
                        <li key={step.id} data-status={step.status}>
                          <button
                            type="button"
                            aria-pressed={selectedTraceId === step.id}
                            onClick={() => onSelectTrace(step.id)}
                          >
                            <span className="tool-panel__timeline-marker" aria-hidden="true" />
                            <span className="tool-panel__timeline-copy">
                              <strong>{step.title}</strong>
                              <span>
                                {kind(step.kind)} · {status(step.status)}
                                {step.purpose ? ` · ${purpose(step.purpose)}` : ""}
                              </span>
                              {step.detail && <span>{step.detail}</span>}
                              {step.error && <span>{step.error}</span>}
                              <small>
                                {duration(step.durationMs)}
                                {step.kind === "model"
                                  ? ` · 输入 ${tokens(step.inputTokens)} / 输出 ${tokens(step.outputTokens)} Token · ${step.costStatus === "included" ? "费用已包含" : money(step.costCNY)}${step.costStatus === "estimated" ? "（估算）" : ""}`
                                  : ""}
                              </small>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </section>
                ))}
              </section>
            );
          })}
        </div>
      </section>
      {selected && (
        <section className="tool-panel__section tool-panel__preview" aria-label="执行步骤详情">
          <h3>{selected.title}</h3>
          {selected.truncated && <p className="tool-panel__muted">内容已截断</p>}
          {selected.input && <Detail label="输入" value={selected.input} />}
          {selected.output && <Detail label="输出" value={selected.output} />}
          {selected.error && <Detail label="错误" value={selected.error} />}
          {!selected.input && !selected.output && !selected.error && (
            <p className="tool-panel__muted">{selected.detail ?? "没有记录更多详情。"}</p>
          )}
        </section>
      )}
    </>
  );
}
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="tool-panel__code-block">
      <strong>{label}</strong>
      <pre>{value}</pre>
    </div>
  );
}
function tokens(value?: number) {
  return value === undefined ? "未知" : value.toLocaleString("zh-CN");
}
function money(value?: number) {
  return value === undefined ? "费用未知" : `¥${value.toFixed(4)}`;
}
function duration(value?: number) {
  return value === undefined
    ? "耗时未知"
    : value < 1000
      ? `${Math.round(value)} 毫秒`
      : `${(value / 1000).toFixed(1)} 秒`;
}
function timestamp(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN") : value;
}
function status(value: string) {
  return (
    (
      {
        running: "进行中",
        completed: "已完成",
        failed: "失败",
        cancelled: "已取消",
        interrupted: "已中断",
      } as Record<string, string>
    )[value] ?? value
  );
}
function kind(value: RuntimeExecutionStep["kind"]) {
  return {
    model: "模型调用",
    tool: "工具",
    permission: "批准",
    compaction: "上下文压缩",
    error: "错误",
  }[value];
}
function purpose(value: string) {
  return (
    (
      {
        main: "主任务",
        compaction: "上下文压缩",
        history_compact: "历史压缩",
        title: "标题生成",
      } as Record<string, string>
    )[value] ?? value
  );
}
