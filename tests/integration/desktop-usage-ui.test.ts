import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageDashboardDetails } from "@pico/protocol";
import {
  UsageSettingsPage,
  type UsageSettingsPageProps,
} from "../../apps/desktop/src/renderer/usage/UsageSettingsPage.js";

Object.assign(globalThis, { React });
const details: UsageDashboardDetails = {
  activities: Array.from({ length: 26 }, (_, index) => ({
    id: `activity-${index}`,
    kind: "model",
    name: `model-${index}`,
    provider: "provider",
    workspacePath: "/project",
    sessionId: `session-${index}`,
    sessionTitle: `会话 ${index}`,
    at: 1_700_000_000_000 + index,
    status: "success",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 200,
    cacheWriteTokens: 30,
    totalTokens: 380,
    costStatus: index === 0 ? "unknown" : "partial",
    costCNY: 0.012,
  })),
  activityCount: 26,
  activitiesTruncated: false,
  providers: [],
  models: [],
  tools: [],
  pricing: [],
  unavailableWorkspaces: [{ workspacePath: "/inaccessible", error: "EACCES: permission denied" }],
  knownCacheReadTokens: 200,
  knownCacheWriteTokens: 30,
  cacheReadReportedCallCount: 1,
  cacheWriteReportedCallCount: 1,
  warnings: ["部分用量未上报"],
};
function render(overrides: Partial<UsageSettingsPageProps> = {}) {
  return renderToStaticMarkup(
    React.createElement(UsageSettingsPage, {
      usage: {
        totalTokens: 380,
        inputTokens: 100,
        outputTokens: 50,
        costCNY: 0.012,
        costStatus: "partial",
        providerCallCount: 2,
        usageReportCount: 1,
        details,
      },
      workspaces: [
        { path: "/project", name: "示例项目", mode: "folder", registered: true, trusted: true },
      ],
      loading: false,
      onQuery: async () => {},
      onOpenSession: () => {},
      ...overrides,
    }),
  );
}

test("usage page presents canonical totals, provenance, request navigation and bounded pagination", () => {
  const html = render();
  assert.match(html, /输入 330 · 输出 50/);
  assert.match(html, /读取 200 · 写入 30/);
  assert.match(html, /未缓存输入 100/);
  assert.match(html, /¥0\.012 · 已知部分/);
  assert.match(html, /<td>未知<\/td>/);
  assert.match(html, /缓存上报覆盖：读取 1 \/ 2 次/);
  assert.match(html, /<details class="usage-diagnostics"><summary>/);
  assert.match(html, /EACCES: permission denied/);
  assert.match(html, /部分用量未上报/);
  assert.match(html, /role="tab" aria-selected="true"/);
  assert.match(html, /aria-label="请求状态"/);
  assert.match(html, /title="打开任务：会话 0"/);
  assert.match(html, /scope="col"/);
  assert.match(html, /共 26 条 · 第 1 \/ 2 页/);
  assert.match(html, /model-24/);
  assert.doesNotMatch(html, /model-25/);
  for (const label of ["请求日志", "厂商", "模型", "工具", "定价", "全部项目", "示例项目"])
    assert.ok(html.includes(label), label);
});

test("usage page separates loading, query failure and unavailable data from zero usage", () => {
  const loading = render({ loading: true });
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /正在加载所选范围的用量/);
  assert.doesNotMatch(loading, /model-0/);
  const empty = render({ usage: {}, error: "请求失败" });
  assert.match(empty, /role="alert">请求失败/);
  assert.match(empty, /重试/);
  assert.match(empty, /暂无记录/);
  assert.match(empty, /暂无分类明细/);
  assert.match(empty, /总 Token<\/span><strong>未知/);
  assert.doesNotMatch(empty, /¥0/);
});
