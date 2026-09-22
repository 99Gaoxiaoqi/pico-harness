import type { RuntimeExecutionSummary } from "@pico/protocol";

type Slice = { label: string; value?: number; color: string };
const valid = (value?: number): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0;
const tokens = (value?: number) => (valid(value) ? value.toLocaleString("zh-CN") : "未知");
const duration = (value?: number) =>
  !valid(value)
    ? "耗时未知"
    : value < 1000
      ? `${Math.round(value)} 毫秒`
      : `${(value / 1000).toFixed(1)} 秒`;

function UsageRing({
  label,
  slices,
  unit,
  format,
}: {
  label: string;
  slices: Slice[];
  unit: string;
  format: (value?: number) => string;
}) {
  const known = slices.every((slice) => valid(slice.value));
  const total = known ? slices.reduce((sum, slice) => sum + slice.value!, 0) : undefined;
  let offset = 0;
  return (
    <div className="inspector-overview__chart" aria-label={label}>
      <div className="inspector-overview__ring">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle
            className="inspector-overview__ring-track"
            cx="60"
            cy="60"
            r="49"
            fill="none"
            strokeWidth="15"
          />
          {total !== undefined &&
            total > 0 &&
            slices.map((slice) => {
              const share = (slice.value! / total) * 100;
              const start = offset;
              offset += share;
              return share > 0 ? (
                <circle
                  key={slice.label}
                  data-segment={slice.label}
                  cx="60"
                  cy="60"
                  r="49"
                  fill="none"
                  stroke={`var(${slice.color})`}
                  strokeWidth="15"
                  pathLength="100"
                  strokeDasharray={`${share} ${100 - share}`}
                  strokeDashoffset={-start}
                  transform="rotate(-90 60 60)"
                />
              ) : null;
            })}
        </svg>
        <div className="inspector-overview__ring-label">
          <strong>{format(total)}</strong>
          <span>{unit}</span>
        </div>
      </div>
      <dl className="inspector-overview__legend">
        {slices.map((slice) => (
          <div key={slice.label}>
            <dt>
              <i aria-hidden="true" style={{ background: `var(${slice.color})` }} />
              {slice.label}
            </dt>
            <dd>{format(slice.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function ExecutionUsageSummary({ summary }: { summary: RuntimeExecutionSummary }) {
  const cacheComplete =
    summary.cacheCoverage === "complete" &&
    valid(summary.inputTokens) &&
    valid(summary.cachedInputTokens) &&
    summary.cachedInputTokens <= summary.inputTokens;
  const tokenSlices: Slice[] = cacheComplete
    ? [
        { label: "缓存输入", value: summary.cachedInputTokens, color: "--inspector-purple" },
        {
          label: "非缓存输入",
          value: summary.inputTokens! - summary.cachedInputTokens!,
          color: "--inspector-teal",
        },
        { label: "输出（含推理）", value: summary.outputTokens, color: "--inspector-blue" },
      ]
    : [
        { label: "输入", value: summary.inputTokens, color: "--inspector-teal" },
        { label: "输出（含推理）", value: summary.outputTokens, color: "--inspector-blue" },
      ];
  const cacheStatus =
    summary.cacheCoverage === "complete"
      ? "完整"
      : summary.cacheCoverage === "partial"
        ? "部分"
        : "未记录";
  return (
    <section className="inspector-overview" aria-label="会话用量">
      <h3>会话累计</h3>
      <UsageRing label="会话 Token 组成" slices={tokenSlices} unit="Token" format={tokens} />
      {!cacheComplete && (
        <p className="inspector-overview__note">
          缓存记录不完整或不可用；已知缓存读取 {tokens(summary.cachedInputTokens)}{" "}
          Token，不计算缓存复用率。
        </p>
      )}
      {summary.meteredCalls < summary.modelCalls && (
        <p className="inspector-overview__note">
          部分调用没有 Token 用量记录（已计量 {summary.meteredCalls} / {summary.modelCalls}{" "}
          次），图中仅为已知用量。
        </p>
      )}
      <UsageRing
        label="累计记录耗时组成"
        slices={[
          {
            label: `模型 · ${summary.modelCalls} 次`,
            value: summary.latencyMs,
            color: "--inspector-blue",
          },
          {
            label: `工具 · ${tokens(summary.toolCalls)} 次`,
            value: summary.toolDurationMs,
            color: "--inspector-teal",
          },
        ]}
        unit="累计耗时"
        format={duration}
      />
      <p className="inspector-overview__note">累计记录耗时，非会话实际时长；缺失记录不参与比例。</p>
      <dl className="inspector-overview__cost">
        <div>
          <dt>已知费用</dt>
          <dd>{valid(summary.costCNY) ? `¥${summary.costCNY.toFixed(4)}` : "费用未知"}</dd>
        </div>
      </dl>
      {summary.unpricedCalls > 0 && (
        <p className="inspector-overview__note">
          {summary.unpricedCalls} 次调用费用未知，已知费用不代表完整总额。
        </p>
      )}
      <details>
        <summary>完整用量明细</summary>
        <dl className="inspector-overview__facts">
          <div>
            <dt>模型调用记录</dt>
            <dd>{summary.modelCalls} 次</dd>
          </div>
          <div>
            <dt>失败调用</dt>
            <dd>{summary.failedCalls} 次</dd>
          </div>
          <div>
            <dt>已计量调用</dt>
            <dd>{summary.meteredCalls} 次</dd>
          </div>
          <div>
            <dt>费用未知调用</dt>
            <dd>{summary.unpricedCalls} 次</dd>
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
            <dt>缓存读取 Token</dt>
            <dd>{tokens(summary.cachedInputTokens)}</dd>
          </div>
          <div>
            <dt>缓存记录覆盖</dt>
            <dd>{cacheStatus}</dd>
          </div>
          <div>
            <dt>推理 Token（包含在输出中）</dt>
            <dd>{tokens(summary.reasoningTokens)}</dd>
          </div>
          {cacheComplete && summary.inputTokens! > 0 && (
            <div>
              <dt>输入 Token 缓存复用率</dt>
              <dd>{((summary.cachedInputTokens! / summary.inputTokens!) * 100).toFixed(1)}%</dd>
            </div>
          )}
          <div>
            <dt>已记录底层尝试</dt>
            <dd>{tokens(summary.physicalAttempts)} 次</dd>
          </div>
          <div>
            <dt>已记录重试</dt>
            <dd>{tokens(summary.retries)} 次</dd>
          </div>
          <div>
            <dt>工具调用</dt>
            <dd>{tokens(summary.toolCalls)} 次</dd>
          </div>
          <div>
            <dt>工具耗时</dt>
            <dd>{duration(summary.toolDurationMs)}</dd>
          </div>
          <div>
            <dt>模型耗时</dt>
            <dd>{duration(summary.latencyMs)}</dd>
          </div>
        </dl>
        <p className="inspector-overview__note">
          统计范围：整个会话。费用采用记录时的估算或已包含金额。
        </p>
      </details>
    </section>
  );
}
