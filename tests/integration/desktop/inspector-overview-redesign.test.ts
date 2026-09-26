import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeExecutionSummary, RuntimeSessionContextSnapshot } from "@pico/protocol";
import { ExecutionUsageSummary } from "../../../apps/desktop/src/renderer/workbar-panels/ExecutionUsageSummary.js";
import { ContextComposition } from "../../../apps/desktop/src/renderer/workbar-panels/ContextComposition.js";
import { CurrentModelHistory } from "../../../apps/desktop/src/renderer/workbar-panels/CurrentModelHistory.js";
import { contextSnapshot } from "./context-fixture.js";
Object.assign(globalThis, { React });

const summary: RuntimeExecutionSummary = {
  scope: "session",
  modelCalls: 4,
  failedCalls: 1,
  meteredCalls: 4,
  unpricedCalls: 1,
  inputTokens: 24000,
  cachedInputTokens: 18000,
  outputTokens: 6000,
  reasoningTokens: 1000,
  cacheCoverage: "complete",
  latencyMs: 19400,
  toolDurationMs: 2000,
  toolCalls: 2,
  physicalAttempts: 5,
  retries: 1,
};
const renderUsage = (overrides: Partial<RuntimeExecutionSummary> = {}) =>
  renderToStaticMarkup(
    React.createElement(ExecutionUsageSummary, { summary: { ...summary, ...overrides } }),
  );

function chart(html: string, label: string) {
  return html.split(`aria-label="${label}"`)[1]!.split("</svg>")[0]!;
}

test("overview renders actual token and recorded-duration rings with textual facts and persistent coverage notices", () => {
  const html = renderUsage();
  const tokenChart = chart(html, "会话 Token 组成");
  assert.match(tokenChart, /data-segment="缓存输入"[^>]+stroke-dasharray="60 40"/);
  assert.match(tokenChart, /data-segment="非缓存输入"[^>]+stroke-dasharray="20 80"/);
  assert.match(tokenChart, /data-segment="输出（含推理）"[^>]+stroke-dasharray="20 80"/);
  assert.match(html, /<strong>30,000<\/strong>/);
  assert.match(html, /<strong>21.4 秒<\/strong>/);
  assert.match(html, /非会话实际时长/);
  assert.match(html, /推理 Token（包含在输出中）<\/dt><dd>1,000/);
  assert.match(html, /75.0%/);
  assert.ok(html.indexOf("1 次调用费用未知") < html.indexOf("<details>"));
  const partial = renderUsage({ cacheCoverage: "partial", meteredCalls: 3 });
  assert.doesNotMatch(chart(partial, "会话 Token 组成"), /data-segment="缓存输入"/);
  assert.match(
    chart(partial, "会话 Token 组成"),
    /data-segment="输入"[^>]+stroke-dasharray="80 20"/,
  );
  assert.match(partial, /已知缓存读取 18,000 Token/);
  assert.doesNotMatch(partial, /输入 Token 缓存复用率/);
  assert.ok(partial.indexOf("已计量 3 / 4 次") < partial.indexOf("<details>"));
});

test("unknown, invalid and zero totals never invent chart shares or cache reuse", () => {
  const missing = renderUsage({ outputTokens: undefined, toolDurationMs: undefined });
  assert.doesNotMatch(chart(missing, "会话 Token 组成"), /data-segment=/);
  assert.doesNotMatch(chart(missing, "累计记录耗时组成"), /data-segment=/);
  assert.match(missing, /<strong>未知<\/strong>/);
  const zero = renderUsage({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    toolDurationMs: 0,
  });
  assert.doesNotMatch(zero, /data-segment=/);
  assert.match(zero, /<strong>0<\/strong>/);
  assert.doesNotMatch(zero, /NaN|Infinity|输入 Token 缓存复用率/);
  const invalid = renderUsage({ cachedInputTokens: 30000 });
  assert.doesNotMatch(invalid, /data-segment="缓存输入"|输入 Token 缓存复用率/);
  assert.match(invalid, /缓存记录不完整或不可用/);
});

test("frozen request byte composition keeps every tool byte while current history stays independent", () => {
  const base = contextSnapshot();
  const snapshot: RuntimeSessionContextSnapshot = {
    ...base,
    latestRequest: {
      ...base.latestRequest,
      compositionStatus: "available",
      compaction: {
        checkpointId: "request-checkpoint",
        throughEventId: "request-boundary",
        coveredEventCount: 2,
      },
      composition: {
        basis: "semantic_utf8_bytes",
        totalBytes: 1000,
        segments: [
          { kind: "system", bytes: 99 },
          { kind: "tools", bytes: 650 },
          { kind: "messages", bytes: 241 },
          { kind: "other", bytes: 10 },
        ],
        tools: Array.from({ length: 8 }, (_, i) => ({ label: `tool-${i}`, bytes: 10 * (i + 1) })),
        remainingTools: { count: 2, bytes: 250 },
        unlabelledToolBytes: 40,
      },
    },
  };
  const renderRequest = () =>
    renderToStaticMarkup(
      React.createElement(ContextComposition, { request: snapshot.latestRequest }),
    );
  const request = renderRequest();
  assert.match(request, /实际输入 2,500 \/ 当时模型窗口 10,000 Token/);
  assert.match(request, /aria-valuenow="25"/);
  assert.match(request, /≈25 Token · 9.9%/);
  assert.match(request, /其余 5 项工具定义/);
  assert.match(request, /title="310 B">≈78 Token/);
  assert.equal((request.match(/<code>tool-/g) ?? []).length, 5);
  assert.match(request, /未命名工具/);
  assert.match(request, /request-checkpoint/);
  const changedHistory = {
    ...snapshot,
    modelHistory: { ...snapshot.modelHistory, estimatedTokens: 55, messageCount: 2 },
  };
  const history = renderToStaticMarkup(
    React.createElement(CurrentModelHistory, { context: changedHistory }),
  );
  assert.match(history, /≈55/);
  assert.match(history, /cp-current/);
  assert.match(history, /Context v3/);
  assert.match(history, /与最近请求快照独立/);
  assert.doesNotMatch(history, /request-checkpoint/);
  assert.equal(renderRequest(), request);
  const missing = renderToStaticMarkup(
    React.createElement(ContextComposition, {
      request: {
        ...snapshot.latestRequest,
        usageStatus: "missing",
        compositionStatus: "unrecorded",
      },
    }),
  );
  assert.match(missing, /实际输入 未知/);
  assert.match(missing, /请求组成未知（未记录）/);
  assert.doesNotMatch(missing, /role="progressbar"/);
});
