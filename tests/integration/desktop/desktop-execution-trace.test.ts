import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeExecutionPage } from "@pico/protocol";
import { InspectorWorkbarPanel } from "../../../apps/desktop/src/renderer/workbar-panels/InspectorWorkbarPanel.js";
import {
  readExecutionWindow,
  mergeExecutionPages,
} from "../../../apps/desktop/src/renderer/workbar-panels/execution-trace-window.js";

Object.assign(globalThis, { React });

function page(runId: string, nextCursor?: string): RuntimeExecutionPage {
  return {
    schemaVersion: 1,
    sessionId: "session",
    ...(nextCursor ? { nextCursor } : {}),
    summary: {
      scope: "session",
      modelCalls: 8,
      failedCalls: 1,
      meteredCalls: 7,
      unpricedCalls: 1,
      inputTokens: 900,
      outputTokens: 40,
      costCNY: 0.2,
    },
    coverage: {
      modelAttempts: "logical_only",
      oversizedRunIds: [],
      missingModelCallRunIds: [],
      incompleteRunIds: [],
    },
    runs: [
      {
        runId,
        invocationId: "invocation",
        at: "2026-09-22T01:00:00Z",
        status: "failed",
        reason: "工具执行失败",
        steps: [
          {
            id: `${runId}:model`,
            eventId: "event1",
            turnId: "turn1",
            kind: "model",
            title: "模型甲",
            at: "2026-09-22T01:00:00Z",
            status: "completed",
            purpose: "main",
            costStatus: "unknown",
          },
          {
            id: `${runId}:tool`,
            eventId: "event2",
            turnId: "turn2",
            kind: "tool",
            title: "读取文件",
            at: "2026-09-22T01:00:01Z",
            status: "failed",
            input: "safe-input",
            error: "文件不存在",
            truncated: true,
          },
        ],
      },
    ],
  };
}

test("execution window refresh keeps page depth and renders causal steps with session-wide totals", async () => {
  const cursors: (string | undefined)[] = [];
  let round = 0;
  const query = async (cursor?: string) => {
    cursors.push(cursor);
    return cursor ? page(`older-${round}`) : page(`latest-${round}`, `cursor-${round}`);
  };
  const first = await readExecutionWindow(query, 2, () => true);
  assert.ok(first);
  round = 1;
  const refreshed = await readExecutionWindow(query, first.length, () => true);
  assert.ok(refreshed);
  assert.deepEqual(cursors, [undefined, "cursor-0", undefined, "cursor-1"]);
  const execution = mergeExecutionPages(refreshed)!;
  assert.equal(execution.summary.modelCalls, 8);
  assert.deepEqual(
    execution.runs.map((run) => run.runId),
    ["latest-1", "older-1"],
  );
  const html = renderToStaticMarkup(
    React.createElement(InspectorWorkbarPanel, {
      context: { version: 2 },
      contextError: "暂时不可用",
      trace: [],
      execution,
      selectedTraceId: "latest-1:tool",
      loading: false,
      onRefresh() {},
      onSelectTrace() {},
    }),
  );
  assert.match(html, /统计范围：整个会话/u);
  assert.match(html, /仅记录逻辑调用/u);
  assert.match(html, /已知费用不代表完整总额/u);
  assert.match(html, /轮次 1/u);
  assert.match(html, /轮次 2/u);
  assert.match(html, /费用未知/u);
  assert.match(html, /输入 未知 \/ 输出 未知 Token/u);
  assert.match(html, /工具执行失败/u);
  assert.match(html, /safe-input/u);
  assert.match(html, /文件不存在/u);
  assert.match(html, /内容已截断/u);
  assert.match(html, /上下文读取失败：暂时不可用/u);
  assert.match(html, /<dt>压缩<\/dt><dd>未知<\/dd>/u);
});

test("obsolete execution response is discarded and coverage remains visible without runs", async () => {
  let current = true;
  let resolve!: (value: RuntimeExecutionPage) => void;
  const pending = readExecutionWindow(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    2,
    () => current,
  );
  current = false;
  resolve(page("obsolete", "older"));
  assert.equal(await pending, undefined);
  const execution = {
    ...page("unused"),
    runs: [],
    coverage: {
      modelAttempts: "logical_only" as const,
      oversizedRunIds: ["large"],
      missingModelCallRunIds: ["missing"],
      incompleteRunIds: ["incomplete"],
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(InspectorWorkbarPanel, {
      trace: [],
      execution,
      loading: false,
      onRefresh() {},
      onSelectTrace() {},
    }),
  );
  assert.match(html, /追踪覆盖不足/u);
  assert.match(html, /步骤未完整展示/u);
  assert.match(html, /缺少模型调用记录/u);
  assert.match(html, /记录不完整/u);
});
