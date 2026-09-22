import type { RuntimeExecutionSummary } from "@pico/protocol";

export function ExecutionUsageSummary({ summary }: { summary: RuntimeExecutionSummary }) {
  return (
    <section className="tool-panel__section" aria-label="会话用量">
      <h3>会话用量</h3>
      <dl className="tool-panel__metrics">
        <div>
          <dt>模型调用记录</dt>
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
        {summary.cachedInputTokens !== undefined && (
          <div>
            <dt>缓存读取 Token</dt>
            <dd>{tokens(summary.cachedInputTokens)}</dd>
          </div>
        )}
        {summary.reasoningTokens !== undefined && (
          <div>
            <dt>推理 Token（包含在输出中）</dt>
            <dd>{tokens(summary.reasoningTokens)}</dd>
          </div>
        )}
        {summary.cacheCoverage === "complete" &&
          summary.inputTokens !== undefined &&
          summary.inputTokens > 0 &&
          summary.cachedInputTokens !== undefined && (
            <div>
              <dt>输入 Token 缓存复用率</dt>
              <dd>{((summary.cachedInputTokens / summary.inputTokens) * 100).toFixed(1)}%</dd>
            </div>
          )}
        {summary.physicalAttempts !== undefined && (
          <div>
            <dt>已记录底层尝试</dt>
            <dd>{summary.physicalAttempts} 次</dd>
          </div>
        )}
        {summary.retries !== undefined && (
          <div>
            <dt>已记录重试</dt>
            <dd>{summary.retries} 次</dd>
          </div>
        )}
        {summary.toolCalls !== undefined && (
          <div>
            <dt>工具调用</dt>
            <dd>{summary.toolCalls} 次</dd>
          </div>
        )}
        {summary.toolDurationMs !== undefined && (
          <div>
            <dt>工具耗时</dt>
            <dd>{duration(summary.toolDurationMs)}</dd>
          </div>
        )}
        <div>
          <dt>已知费用</dt>
          <dd>{money(summary.costCNY)}</dd>
        </div>
        <div>
          <dt>模型耗时</dt>
          <dd>{duration(summary.latencyMs)}</dd>
        </div>
      </dl>
      <p className="tool-panel__muted">统计范围：整个会话。费用采用记录时的估算或已包含金额。</p>

      {summary.unpricedCalls > 0 && (
        <p className="tool-panel__muted">
          {summary.unpricedCalls} 次调用费用未知，已知费用不代表完整总额。
        </p>
      )}
      {summary.meteredCalls < summary.modelCalls && (
        <p className="tool-panel__muted">部分调用没有 Token 用量记录。</p>
      )}
    </section>
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
