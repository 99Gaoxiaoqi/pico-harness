/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type {} from "../../apps/desktop/src/preload/global.js";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryPage, nextMemoryTabIndex } from "../../apps/desktop/src/renderer/MemoryPage.js";
import { previewData } from "../../apps/desktop/src/renderer/fixture.js";
import {
  isMemoryConflict,
  isMemoryNotificationTopic,
  RuntimeInvocationError,
  type RuntimeStore,
} from "../../apps/desktop/src/renderer/runtime.js";

Object.assign(globalThis, { React });

function previewRuntime(): RuntimeStore {
  return {
    preview: true,
    connection: { kind: "ready" },
    data: previewData,
    busy: undefined,
    message: undefined,
    actions: {} as RuntimeStore["actions"],
  };
}

test("desktop navigation exposes the workspace memory route", async () => {
  const source = await readFile(
    new URL("../../apps/desktop/src/renderer/App.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /path="memory"/);
  assert.match(source, /to: "\/memory", label: "记忆"/);
  assert.match(source, /"\/memory": "记忆"/);
});

test("memory page renders three desktop columns and management actions", () => {
  const html = renderToStaticMarkup(
    React.createElement(MemoryPage, { runtime: previewRuntime(), forceNarrow: false }),
  );
  assert.match(html, /工作区记忆/);
  assert.match(html, /待审核/);
  assert.match(html, /已启用/);
  assert.match(html, /未启用与归档/);
  assert.match(html, /编辑后批准/);
  assert.match(html, /批准/);
  assert.match(html, /拒绝/);
  assert.match(html, /aria-label="停用/);
  assert.match(html, /aria-label="归档/);
  assert.match(html, /aria-label="永久删除/);
  assert.match(html, /来源 ID：memory-source-1（详情未提供）/);
  assert.match(html, /来源已回退/);
});

test("narrow memory layout exposes keyboard-operated ARIA tabs", () => {
  const html = renderToStaticMarkup(
    React.createElement(MemoryPage, { runtime: previewRuntime(), forceNarrow: true }),
  );
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /tabindex="-1"/);
  assert.match(html, /role="tabpanel"/);
  assert.equal(nextMemoryTabIndex(0, "ArrowRight"), 1);
  assert.equal(nextMemoryTabIndex(0, "ArrowLeft"), 2);
  assert.equal(nextMemoryTabIndex(1, "Home"), 0);
  assert.equal(nextMemoryTabIndex(1, "End"), 2);
});

test("memory settings explain off behavior and keep auto approval locked", () => {
  const runtime = previewRuntime();
  const html = renderToStaticMarkup(
    React.createElement(MemoryPage, { runtime, forceNarrow: false }),
  );
  assert.match(html, /关闭后不会产生额外模型调用，也不会向会话注入记忆/);
  assert.match(html, /固定关闭，普通用户无法启用/);
  assert.match(html, /节能/);
  assert.match(html, /仅生成规则提案，不调用模型审核模糊表达/);
  assert.match(html, /均衡（推荐）/);
  assert.match(html, /质量优先/);
  assert.match(html, /提高模糊表达的召回/);
  assert.match(html, /当前用量/);
  assert.match(html, /滚动 24 小时模型审核预算已耗尽/);
  assert.match(html, /调用 8\/8/);
  assert.match(html, /12,640\/16,000 tokens/);
  assert.match(html, /\$0\.0840\/\$0\.1000/);
  assert.match(html, /type="checkbox" disabled=""/);

  const ecoRuntime: RuntimeStore = {
    ...runtime,
    data: {
      ...runtime.data,
      memory: {
        ...runtime.data.memory,
        settings: { ...runtime.data.memory.settings!, reviewMode: "eco" },
        reviewBudget: {
          ...runtime.data.memory.reviewBudget!,
          mode: "eco",
          allowed: false,
          reason: "eco-mode",
          maxCalls: 0,
          maxInputTokens: 0,
          maxOutputTokens: 0,
          maxCostUsd: 0,
        },
      },
    },
  };
  assert.match(
    renderToStaticMarkup(
      React.createElement(MemoryPage, { runtime: ecoRuntime, forceNarrow: false }),
    ),
    /节能模式保证后台模型审核调用为 0/,
  );

  const unexpectedAutoCommit: RuntimeStore = {
    ...runtime,
    data: {
      ...runtime.data,
      memory: {
        ...runtime.data.memory,
        settings: { ...runtime.data.memory.settings!, autoCommit: true },
      },
    },
  };
  const warningHtml = renderToStaticMarkup(
    React.createElement(MemoryPage, { runtime: unexpectedAutoCommit, forceNarrow: false }),
  );
  assert.match(warningHtml, /class="is-locked"><input type="checkbox" disabled="" checked=""/);
  assert.match(warningHtml, /立即关闭自动批准/);

  const proposalsOff: RuntimeStore = {
    ...runtime,
    data: {
      ...runtime.data,
      memory: {
        ...runtime.data.memory,
        settings: { ...runtime.data.memory.settings!, autoPropose: false },
      },
    },
  };
  assert.match(
    renderToStaticMarkup(
      React.createElement(MemoryPage, { runtime: proposalsOff, forceNarrow: false }),
    ),
    /自动提出建议已关闭；当前模式暂不生效/,
  );
});

test("memory notifications use the dedicated refetch path and conflicts are detectable", async () => {
  assert.equal(isMemoryNotificationTopic("memory.proposed"), true);
  assert.equal(isMemoryNotificationTopic("memory.changed"), true);
  assert.equal(isMemoryNotificationTopic("memory.forgotten"), true);
  assert.equal(isMemoryNotificationTopic("session.updated"), false);
  assert.equal(isMemoryConflict(new RuntimeInvocationError("CONFLICT", "stale", true)), true);
  assert.equal(
    isMemoryConflict(new RuntimeInvocationError("CONFIG_REVISION_CONFLICT", "stale", true)),
    false,
  );
  const source = await readFile(
    new URL("../../apps/desktop/src/renderer/runtime.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(isMemoryNotificationTopic\(topic\)\) \{\s*scheduleMemoryRefresh\(\);/);
});

test("edited proposal approval is a single atomic renderer action", async () => {
  const source = await readFile(
    new URL("../../apps/desktop/src/renderer/MemoryPage.tsx", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const resolveProposal = async");
  const end = source.indexOf("const updateSetting = async", start);
  assert.ok(start >= 0 && end > start);
  const implementation = source.slice(start, end);
  assert.equal(implementation.match(/actions\.resolveMemoryProposal\(/gu)?.length, 1);
  assert.equal(
    implementation.match(/actions\.updateMemoryFact\(/gu)?.length,
    1,
    "the only follow-up write is the explicit undo action",
  );
  assert.doesNotMatch(implementation, /updateMemoryFact[\s\S]*title:\s*editor\.title/u);
  assert.match(implementation, /patch,/u);
});

test("memory page renders degraded, source-unavailable, and conflict alert states", () => {
  const runtime = previewRuntime();
  const {
    sourceId: _sourceId,
    source: _source,
    ...sourceUnavailableFact
  } = runtime.data.memory.facts[0]!;
  const degraded: RuntimeStore = {
    ...runtime,
    message: "记忆已在另一处更新，已重新加载最新内容。请检查后重试本次操作。",
    data: {
      ...runtime.data,
      memory: {
        workspacePath: runtime.data.workspacePath,
        facts: [
          {
            ...sourceUnavailableFact,
            factId: "source-unavailable",
          },
        ],
        proposals: [],
        status: "degraded",
        error: "当前 Runtime 未提供工作区记忆能力。",
      },
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(MemoryPage, { runtime: degraded, forceNarrow: false }),
  );
  assert.match(html, /当前 Runtime 未提供工作区记忆能力/);
  assert.match(html, /来源不可用/);
  assert.match(html, /role="alert"/);
  assert.match(html, /已重新加载最新内容/);
});
