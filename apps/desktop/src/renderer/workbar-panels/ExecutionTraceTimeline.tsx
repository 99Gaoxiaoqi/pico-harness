import { useEffect, useId, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import type {
  RuntimeExecutionPage,
  RuntimeExecutionRun,
  RuntimeExecutionStep,
} from "@pico/protocol";
import { partitionTimelineRuns } from "./inspector-timeline-state.js";
import { displayExecutionError } from "../provider-retry.js";

export function ExecutionTraceTimeline({
  execution,
  selectedTraceId,
  onSelectTrace,
}: {
  readonly execution: RuntimeExecutionPage;
  readonly selectedTraceId?: string;
  readonly onSelectTrace: (id: string | undefined) => void;
}) {
  const id = useId();
  const [overrides, setOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const [emptyExpanded, setEmptyExpanded] = useState(false);
  const { visible, empty } = partitionTimelineRuns(execution);
  const selectedRun = execution.runs.find((run) =>
    run.steps.some((step) => step.id === selectedTraceId),
  );
  // Refreshes and a shrinking pagination window must not retain dead selections or overrides.
  useEffect(() => {
    const valid = new Set(execution.runs.map((run) => run.runId));
    setOverrides((previous) => {
      const entries = Object.entries(previous).filter(([runId]) => valid.has(runId));
      return entries.length === Object.keys(previous).length
        ? previous
        : Object.fromEntries(entries);
    });
    if (selectedTraceId && !selectedRun) onSelectTrace(undefined);
  }, [execution.runs, selectedRun, selectedTraceId, onSelectTrace]);
  const { coverage } = execution;
  const gaps = [
    coverage.oversizedRunIds.length > 0 &&
      `${coverage.oversizedRunIds.length} 次运行过大，步骤未完整展示`,
    coverage.missingModelCallRunIds.length > 0 &&
      `${coverage.missingModelCallRunIds.length} 次运行缺少模型调用记录`,
    coverage.incompleteRunIds.length > 0 &&
      `${coverage.incompleteRunIds.length} 次运行尚未结束或记录未闭合`,
  ].filter(Boolean);
  return (
    <section className="inspector-timeline" aria-label="执行时间线">
      {gaps.length > 0 && (
        <p className="inspector-timeline__warning" role="status">
          追踪覆盖不足：{gaps.join("；")}。
        </p>
      )}
      {coverage.modelAttempts !== "physical" && (
        <p className="inspector-timeline__coverage" role="status">
          {coverage.modelAttempts === "partial"
            ? "部分底层调用尝试记录不完整。"
            : "暂无底层调用尝试记录。"}
        </p>
      )}
      {execution.runs.length === 0 && (
        <p className="inspector-timeline__empty">
          {gaps.length > 0 ? "部分执行记录暂不可展示。" : "当前任务还没有追踪记录。"}
        </p>
      )}
      {visible.map((run, index) => {
        const expanded =
          selectedRun?.runId === run.runId ||
          (overrides[run.runId] ?? (index === 0 || run.status === "running"));
        const contentId = `${id}-run-${index}`;
        const reason = runReason(run);
        return (
          <div key={run.runId}>
            {(index === 0 || day(run.at) !== day(visible[index - 1]!.at)) && (
              <p className="inspector-timeline__date">{day(run.at)}</p>
            )}
            <section
              className="inspector-timeline__run"
              data-run-id={run.runId}
              data-status={run.status}
            >
              <button
                className="inspector-timeline__run-toggle"
                data-run-toggle={run.runId}
                type="button"
                aria-expanded={expanded}
                aria-controls={contentId}
                onClick={() => {
                  setOverrides((previous) => ({ ...previous, [run.runId]: !expanded }));
                  if (expanded && selectedRun?.runId === run.runId) onSelectTrace(undefined);
                }}
              >
                {expanded ? (
                  <ChevronDown aria-hidden="true" />
                ) : (
                  <ChevronRight aria-hidden="true" />
                )}
                <time dateTime={run.at} title={timestamp(run.at)}>
                  {time(run.at)}
                </time>
                <span className="inspector-timeline__badge" data-status={run.status}>
                  {status(run.status)}
                </span>
                <span className="inspector-timeline__run-duration">{duration(run.durationMs)}</span>
                {reason && (
                  <span className="inspector-timeline__reason" title={reason}>
                    {reason}
                  </span>
                )}
                <span className="inspector-timeline__run-counts">{runCounts(run)}</span>
              </button>
              {expanded && (
                <RunSteps
                  run={run}
                  contentId={contentId}
                  selectedTraceId={selectedTraceId}
                  onSelectTrace={onSelectTrace}
                />
              )}
            </section>
          </div>
        );
      })}
      {empty.length > 0 && (
        <section className="inspector-timeline__empty-group">
          <button
            className="inspector-timeline__empty-toggle"
            type="button"
            aria-expanded={emptyExpanded}
            aria-controls={`${id}-empty`}
            onClick={() => setEmptyExpanded((value) => !value)}
          >
            {emptyExpanded ? (
              <ChevronDown aria-hidden="true" />
            ) : (
              <ChevronRight aria-hidden="true" />
            )}
            无步骤记录 · {empty.length} 条
          </button>
          {emptyExpanded && (
            <ul id={`${id}-empty`} className="inspector-timeline__empty-runs">
              {empty.map((run) => (
                <li key={run.runId} data-run-id={run.runId}>
                  <time dateTime={run.at}>{timestamp(run.at)}</time>
                  <span>{duration(run.durationMs)} · 已完成</span>
                  <code>运行 {run.runId}</code>
                  <code>调用 {run.invocationId}</code>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {coverage.modelAttempts === "physical" && (
        <details className="inspector-timeline__coverage">
          <summary>追踪记录说明</summary>
          <p>包含底层调用尝试与重试记录。</p>
        </details>
      )}
    </section>
  );
}

function RunSteps({
  run,
  contentId,
  selectedTraceId,
  onSelectTrace,
}: {
  run: RuntimeExecutionRun;
  contentId: string;
  selectedTraceId: string | undefined;
  onSelectTrace: (id: string | undefined) => void;
}) {
  const turns = new Map<string, RuntimeExecutionStep[]>();
  for (const step of run.steps) turns.set(step.turnId, [...(turns.get(step.turnId) ?? []), step]);
  return (
    <div id={contentId} className="inspector-timeline__run-content">
      {runReason(run, true) && (
        <p className="inspector-timeline__full-reason">{runReason(run, true)}</p>
      )}
      {turns.size === 0 && <p className="inspector-timeline__empty">没有可展示的执行步骤。</p>}
      <div className="inspector-timeline__turns">
        {[...turns].map(([turnId, steps], index) => (
          <section
            className="inspector-timeline__turn"
            key={turnId}
            aria-label={`轮次 ${index + 1}`}
          >
            <h4>
              轮次 {index + 1} ·{" "}
              <time dateTime={steps[0]!.at} title={timestamp(steps[0]!.at)}>
                {time(steps[0]!.at)}
              </time>
            </h4>
            <ol className="inspector-timeline__steps">
              {steps.map((step, stepIndex) => {
                const expanded = selectedTraceId === step.id;
                const detailId = `${contentId}-turn-${index}-step-${stepIndex}`;
                return (
                  <li className="inspector-timeline__step" key={step.id} data-status={step.status}>
                    <button
                      type="button"
                      className="inspector-timeline__step-toggle"
                      data-step-id={step.id}
                      aria-expanded={expanded}
                      aria-controls={detailId}
                      onClick={() => onSelectTrace(expanded ? undefined : step.id)}
                    >
                      {expanded ? (
                        <ChevronDown aria-hidden="true" />
                      ) : (
                        <ChevronRight aria-hidden="true" />
                      )}
                      <span className="inspector-timeline__step-name">
                        {step.kind === "model" ? (step.modelId ?? step.title) : step.title}
                      </span>
                      <span className="inspector-timeline__step-metrics">
                        {step.retries !== undefined && step.retries > 0 && (
                          <span>重试 {step.retries} 次</span>
                        )}
                        <span>{duration(step.durationMs)}</span>
                      </span>
                      {(step.status !== "completed" || step.kind === "permission") && (
                        <span className="inspector-timeline__step-status">
                          {status(step.status)}
                          {step.kind === "permission"
                            ? ` · ${permission(step.permissionDecision)}`
                            : ""}
                          {step.error ? ` · ${displayExecutionError(step.error)}` : ""}
                        </span>
                      )}
                    </button>
                    {expanded && <StepDetail step={step} detailId={detailId} turnSteps={steps} />}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
      <details className="inspector-timeline__identity">
        <summary>运行标识</summary>
        <dl>
          <dt>运行</dt>
          <dd>{run.runId}</dd>
          <dt>调用</dt>
          <dd>{run.invocationId}</dd>
          {run.parentRunId && (
            <>
              <dt>上级运行</dt>
              <dd>{run.parentRunId}</dd>
            </>
          )}
        </dl>
      </details>
    </div>
  );
}

function StepDetail({
  step,
  detailId,
  turnSteps,
}: {
  step: RuntimeExecutionStep;
  detailId: string;
  turnSteps: readonly RuntimeExecutionStep[];
}) {
  return (
    <section id={detailId} className="inspector-timeline__detail" aria-label="执行步骤详情">
      <p className="inspector-timeline__detail-status" data-status={step.status}>
        {step.status === "completed" && <Check aria-hidden="true" />}
        {status(step.status)}
        {step.kind === "permission" ? ` · ${permission(step.permissionDecision)}` : ""}
      </p>
      {step.truncated && <p className="inspector-timeline__warning">内容已截断</p>}
      {step.input !== undefined && <Detail label="输入" value={step.input} />}
      {step.output !== undefined && <Detail label="输出" value={step.output} />}
      {step.error && <Detail label="错误" value={displayExecutionError(step.error, true)} />}
      <details className="inspector-timeline__metadata">
        <summary>请求与执行明细</summary>
        <dl>
          <dt>类型</dt>
          <dd>{kind(step.kind)}</dd>
          <dt>名称</dt>
          <dd>{step.title}</dd>
          <dt>时间</dt>
          <dd>{timestamp(step.at)}</dd>
          <dt>耗时</dt>
          <dd>{duration(step.durationMs)}</dd>
          {step.purpose && (
            <>
              <dt>用途</dt>
              <dd>{purpose(step.purpose)}</dd>
            </>
          )}
          {step.detail && (
            <>
              <dt>记录</dt>
              <dd>{step.detail}</dd>
            </>
          )}
          {step.providerId && (
            <>
              <dt>提供商</dt>
              <dd>{step.providerId}</dd>
            </>
          )}
          {step.modelId && (
            <>
              <dt>模型</dt>
              <dd>{step.modelId}</dd>
            </>
          )}
          {step.pricingKey && (
            <>
              <dt>定价标识</dt>
              <dd>{step.pricingKey}</dd>
            </>
          )}
          {step.kind === "model" && (
            <>
              <dt>用量</dt>
              <dd>
                输入 {tokens(step.inputTokens)} / 输出 {tokens(step.outputTokens)} Token
              </dd>
              <dt>费用</dt>
              <dd>
                {step.costStatus === "included" ? "费用已包含" : money(step.costCNY)}
                {step.costStatus === "estimated"
                  ? "（估算）"
                  : step.costStatus === "unknown" && step.costCNY !== undefined
                    ? "（已知部分）"
                    : ""}
              </dd>
            </>
          )}
          {step.firstTokenLatencyMs !== undefined && (
            <>
              <dt>首 Token 耗时</dt>
              <dd>{duration(step.firstTokenLatencyMs)}</dd>
            </>
          )}
          {step.cachedInputTokens !== undefined && (
            <>
              <dt>缓存读取</dt>
              <dd>{tokens(step.cachedInputTokens)} Token</dd>
            </>
          )}
          {step.reasoningTokens !== undefined && (
            <>
              <dt>推理</dt>
              <dd>{tokens(step.reasoningTokens)} Token（包含在输出中）</dd>
            </>
          )}
          {step.retries !== undefined && (
            <>
              <dt>重试</dt>
              <dd>{step.retries} 次</dd>
            </>
          )}
          <dt>轮次统计</dt>
          <dd>
            {turnSteps.length} 个步骤 · 已知费用 {money(turnCost(turnSteps))} · 步骤累计{" "}
            {duration(turnDuration(turnSteps))}
          </dd>
          <dt>步骤</dt>
          <dd>{step.id}</dd>
          <dt>事件</dt>
          <dd>{step.eventId}</dd>
          <dt>轮次</dt>
          <dd>{step.turnId}</dd>
        </dl>
        {step.costStatus === "unknown" &&
          (step.providerId && step.modelId ? (
            <PricingKey
              reason={step.costUnknownReason}
              value={JSON.stringify({ providerId: step.providerId, modelId: step.modelId })}
            />
          ) : (
            <p>{step.costUnknownReason ?? "费用未知：请求记录未保存可用定价或完整用量"}</p>
          ))}
        {step.attempts && step.attempts.length > 0 && (
          <div className="inspector-timeline__attempts">
            <h5>底层调用尝试</h5>
            <ol>
              {step.attempts.map((attempt) => (
                <li key={attempt.attemptId}>
                  <p>
                    第 {attempt.attempt + 1} 次 · {attempt.provider} / {attempt.model} ·{" "}
                    {status(attempt.status)} · {duration(attempt.latencyMs)}
                    {attempt.httpStatus !== undefined ? ` · HTTP ${attempt.httpStatus}` : ""}
                    {attempt.timeToFirstTokenMs !== undefined
                      ? ` · 首 Token ${duration(attempt.timeToFirstTokenMs)}`
                      : ""}
                  </p>
                  <p>
                    {timestamp(attempt.startedAt)}
                    {attempt.completedAt ? ` → ${timestamp(attempt.completedAt)}` : ""}
                    {attempt.finishReason ? ` · ${attempt.finishReason}` : ""}
                  </p>
                  <p>
                    输入 {tokens(attempt.inputTokens)} / 输出 {tokens(attempt.outputTokens)} Token ·{" "}
                    {attempt.costStatus === "included" ? "费用已包含" : money(attempt.costCNY)}
                    {attempt.costStatus === "estimated" ? "（估算）" : ""} · 用量依据：
                    {usageBasis(attempt.usageBasis)}
                  </p>
                  {attempt.cachedInputTokens !== undefined && (
                    <p>缓存读取 {tokens(attempt.cachedInputTokens)} Token</p>
                  )}
                  {attempt.reasoningTokens !== undefined && (
                    <p>推理 {tokens(attempt.reasoningTokens)} Token（包含在输出中）</p>
                  )}
                  {attempt.costUnknownReason && <p>{attempt.costUnknownReason}</p>}
                  {(attempt.errorClass || attempt.errorCategory || attempt.transportCode) && (
                    <p>
                      失败诊断：
                      {[attempt.errorClass, attempt.errorCategory, attempt.transportCode]
                        .filter(Boolean)
                        .join(" · ")}
                      {attempt.retryable !== undefined
                        ? ` · ${attempt.retryable ? "可重试" : "不可重试"}`
                        : ""}
                    </p>
                  )}
                  {attempt.diagnosticId && <p>诊断 ID：{attempt.diagnosticId}</p>}
                  {attempt.error && (
                    <p className="inspector-timeline__warning">
                      {displayExecutionError(attempt.error, true)}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </details>
      {step.input === undefined && step.output === undefined && !step.error && !step.detail && (
        <p className="inspector-timeline__coverage">没有记录更多输入输出。</p>
      )}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  let formatted = value;
  try {
    formatted = JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    /* Plain text stays unchanged. */
  }
  return (
    <div className="inspector-timeline__code-block">
      <div className="inspector-timeline__code-heading">
        <strong>{label}</strong>
        <CopyButton label={`复制${label}`} value={value} />
      </div>
      <pre>{formatted}</pre>
    </div>
  );
}
function CopyButton({ label, value }: { label: string; value: string }) {
  const [message, setMessage] = useState("");
  return (
    <span className="inspector-timeline__copy">
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => {
          void copyText(value).then(
            () => setMessage("已复制"),
            () => setMessage("复制失败，请手动选择"),
          );
        }}
      >
        {message === "已复制" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
      <span role="status">{message}</span>
    </span>
  );
}
async function copyText(value: string): Promise<void> {
  // User-activated selection copy works without granting general clipboard access.
  const focused = document.activeElement;
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  try {
    input.select();
    if (document.execCommand("copy")) return;
  } finally {
    input.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
  await navigator.clipboard.writeText(value);
}
function PricingKey({ value, reason }: { value: string; reason: string | undefined }) {
  return (
    <div className="inspector-timeline__pricing">
      <strong>费用未知</strong>
      <p>{reason ?? "请求记录未保存可用定价或完整用量，未按当前价格回填"}</p>
      <code>{value}</code>
      <CopyButton label="复制模型标识" value={value} />
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
      ? `${Math.round(value)}ms`
      : value < 60000
        ? `${(value / 1000).toFixed(1)}s`
        : `${Math.floor(value / 60000)}m${Math.round((value % 60000) / 1000)}s`;
}
function timestamp(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value;
}
function time(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString("zh-CN", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : value;
}
function day(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })
    : value;
}
function status(value: string) {
  return (
    (
      {
        prepared: "准备请求",
        observed: "已观察响应",
        running: "进行中",
        completed: "已完成",
        succeeded: "成功",
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
function permission(value: RuntimeExecutionStep["permissionDecision"]) {
  return value === "approved" ? "已批准" : value === "rejected" ? "已拒绝" : "等待批准";
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
function usageBasis(value: string) {
  return (
    ({ reported: "已报告", partial: "部分记录", missing: "缺失" } as Record<string, string>)[
      value
    ] ?? value
  );
}
function runCounts(run: RuntimeExecutionRun) {
  const models = run.steps.filter((step) => step.kind === "model").length;
  const tools = run.steps.filter((step) => step.kind === "tool").length;
  return `${models} 次模型调用 · ${tools} 次工具调用`;
}
function turnCost(steps: readonly RuntimeExecutionStep[]): number | undefined {
  const costs = steps.filter((step) => step.kind === "model" && step.costCNY !== undefined);
  return costs.length ? costs.reduce((total, step) => total + step.costCNY!, 0) : undefined;
}
function turnDuration(steps: readonly RuntimeExecutionStep[]): number | undefined {
  const durations = steps.flatMap((step) =>
    step.durationMs === undefined ? [] : [step.durationMs],
  );
  return durations.length ? durations.reduce((sum, value) => sum + value, 0) : undefined;
}

function runReason(run: RuntimeExecutionRun, includeDiagnostic = false) {
  if (run.status === "completed" || run.status === "running") return undefined;
  const raw = run.reason ?? run.steps.find((step) => step.status === "failed" && step.error)?.error;
  return raw ? displayExecutionError(raw, includeDiagnostic) : undefined;
}
