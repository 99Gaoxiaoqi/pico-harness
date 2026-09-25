import { contextSnapshot } from "./context-maka-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeExecutionPage, RuntimeExecutionSummary } from "@pico/protocol";
import { InspectorWorkbarPanel } from "../../../apps/desktop/src/renderer/workbar-panels/InspectorWorkbarPanel.js";
import { mergeExecutionPages } from "../../../apps/desktop/src/renderer/workbar-panels/execution-trace-window.js";
Object.assign(globalThis, { React });

const summary: RuntimeExecutionSummary = {
  scope: "session",
  modelCalls: 2,
  failedCalls: 0,
  meteredCalls: 2,
  unpricedCalls: 1,
  inputTokens: 28100,
  outputTokens: 939,
  cachedInputTokens: 18489,
  reasoningTokens: 418,
  cacheCoverage: "complete",
  physicalAttempts: 3,
  retries: 1,
  toolCalls: 2,
  toolDurationMs: 400,
};
const page: RuntimeExecutionPage = {
  schemaVersion: 1,
  sessionId: "s",
  summary,
  coverage: {
    modelAttempts: "physical",
    oversizedRunIds: [],
    missingModelCallRunIds: [],
    incompleteRunIds: [],
  },
  runs: [
    {
      runId: "r",
      invocationId: "i",
      at: "2026-09-22T01:00:00Z",
      status: "completed",
      steps: [
        {
          id: "step",
          eventId: "event",
          turnId: "turn",
          kind: "model",
          title: "模型甲",
          at: "2026-09-22T01:00:00Z",
          status: "completed",
          providerId: "provider",
          modelId: "model",
          pricingKey: "provider/model",
          costStatus: "unknown",
          costUnknownReason: "未匹配该 endpoint 与模型的定价",
          retries: 1,
          firstTokenLatencyMs: 150,
          cachedInputTokens: 40,
          reasoningTokens: 8,
          attempts: [
            {
              attemptId: "a",
              attempt: 0,
              provider: "provider",
              model: "model",
              startedAt: "now",
              completedAt: "now",
              status: "failed",
              latencyMs: 40,
              usageBasis: "missing",
              httpStatus: 429,
              error: "限流",
            },
          ],
        },
      ],
    },
  ],
};
function render(props: Partial<React.ComponentProps<typeof InspectorWorkbarPanel>>) {
  return renderToStaticMarkup(
    React.createElement(InspectorWorkbarPanel, {
      trace: [],
      loading: false,
      onRefresh() {},
      onSelectTrace() {},
      ...props,
    }),
  );
}
test("trace inspector integrates physical attempts, independent usage and earlier-window controls", () => {
  const execution = mergeExecutionPages([
    page,
    { ...page, runs: [], coverage: { ...page.coverage, modelAttempts: "missing" } },
  ])!;
  assert.equal(execution.coverage.modelAttempts, "partial");
  const html = render({
    execution,
    summary,
    selectedTraceId: "step",
    hasMore: true,
    onLoadMore() {},
    canHideEarlier: true,
    onHideEarlier() {},
    context: contextSnapshot(),
  });
  for (const label of [
    "隐藏较早记录",
    "加载较早记录",
    "输入 Token 缓存复用率",
    "65.8%",
    "工具耗时",
    "执行时间线",
    "重试 1 次",
    "HTTP 429",
    "第 1 次",
    "首 Token 耗时",
    "复制模型标识",
    "费用未知",
    "未匹配该 endpoint 与模型的定价",
    "当前模型历史",
    "估算 Token",
    "不包含完整请求",
    "当时模型窗口",
    "实际输入 Token",
    "部分底层调用尝试记录不完整",
  ])
    assert.ok(html.includes(label), label);
  const unavailable = render({
    execution,
    summary: { ...summary, cacheCoverage: "partial" },
    summaryError: "计量暂不可用",
  });
  assert.match(unavailable, /会话用量读取失败：计量暂不可用/u);
  assert.match(unavailable, /data-step-id="step"/u);
  assert.doesNotMatch(unavailable, /输入 Token 缓存复用率/u);
  const traceFailed = render({ summary, error: "轨迹暂不可用" });
  assert.match(traceFailed, /65.8%/u);
  assert.match(traceFailed, /轨迹暂不可用/u);
});
