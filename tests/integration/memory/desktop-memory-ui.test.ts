/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type {} from "../../../apps/desktop/src/preload/global.js";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { MemoryPage, nextMemoryTabIndex } from "../../../apps/desktop/src/renderer/MemoryPage.js";
import { previewData } from "../../../apps/desktop/src/renderer/fixture.js";
import {
  isMemoryConflict,
  isMemoryNotificationTopic,
  RuntimeInvocationError,
  type RuntimeStore,
} from "../../../apps/desktop/src/renderer/runtime.js";
Object.assign(globalThis, { React });

function renderMemoryPage(props: React.ComponentProps<typeof MemoryPage>): string {
  return renderToStaticMarkup(
    React.createElement(MemoryRouter, null, React.createElement(MemoryPage, props)),
  );
}

function previewRuntime(): RuntimeStore {
  return {
    preview: true,
    connection: { kind: "ready" },
    busy: undefined,
    message: undefined,
    actions: {} as RuntimeStore["actions"],
    data: {
      ...previewData,
      memory: previewData.memory,
    },
  };
}

test("atomic memory page renders saved and archived items, scope, provenance and management actions", () => {
  const html = renderMemoryPage({ runtime: previewRuntime(), forceNarrow: false });
  assert.match(html, /工作区记忆/);
  assert.match(html, /添加记忆/);
  assert.match(html, /aria-controls="memory-add-form"/);
  assert.match(html, /已保存/);
  assert.match(html, /已归档/);
  assert.match(html, /全局 · 跨工作区/);
  assert.match(html, /当前工作区/);
  assert.match(html, /知识/);
  assert.match(html, /时间类型/);
  assert.match(html, /对话提取/);
  assert.match(html, /aria-label="编辑/);
  assert.match(html, /aria-label="归档/);
  assert.match(html, /aria-label="恢复/);
  assert.match(html, /aria-label="删除记忆/);
  assert.match(html, /href="\/settings\/memory"[^>]*>用户级记忆设置/);
  assert.doesNotMatch(html, /自动提取长期信息/);
  assert.doesNotMatch(html, /永久遗忘|待审核|批准|拒绝|自动审核|当前用量|质量优先|滚动 24 小时/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 0);
});

test("atomic memory narrow layout has two keyboard-operated tabs and handles empty and untrusted states", () => {
  const runtime = previewRuntime();
  const html = renderMemoryPage({ runtime, forceNarrow: true });
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /tabindex="-1"/);
  assert.equal(nextMemoryTabIndex(0, "ArrowRight"), 1);
  assert.equal(nextMemoryTabIndex(0, "ArrowLeft"), 1);
  assert.equal(nextMemoryTabIndex(1, "ArrowRight"), 0);
  assert.equal(nextMemoryTabIndex(1, "Home"), 0);
  assert.equal(nextMemoryTabIndex(0, "End"), 1);
  const empty: RuntimeStore = {
    ...runtime,
    data: { ...runtime.data, memory: { ...runtime.data.memory, items: [] } },
  };
  assert.match(renderMemoryPage({ runtime: empty, forceNarrow: false }), /还没有已保存的记忆/);
  const untrusted: RuntimeStore = { ...runtime, data: { ...runtime.data, trusted: false } };
  assert.match(
    renderMemoryPage({ runtime: untrusted, forceNarrow: false }),
    /信任当前工作区后可管理记忆/,
  );
});

test("memory route, notifications, conflict refetch and Item provenance remain usable", async () => {
  const app = await readFile(
    new URL("../../../apps/desktop/src/renderer/App.tsx", import.meta.url),
    "utf8",
  );
  assert.match(app, /path="settings\/memory"/);
  assert.match(app, /path="settings\/memory" element=\{<UserMemorySettingsPage \/>\}/);
  assert.match(app, /path="memory"[\s\S]*?<WorkspaceRoute>\s*<MemoryPageRoute \/>/);
  assert.doesNotMatch(app, /LegacySurfaceRedirect to="\/settings\/memory"/);
  assert.equal(isMemoryNotificationTopic("memory.changed"), true);
  assert.equal(isMemoryNotificationTopic("memory.deleted"), true);
  assert.equal(isMemoryNotificationTopic("memory.forgotten"), false);
  assert.equal(isMemoryConflict(new RuntimeInvocationError("CONFLICT", "stale", true)), true);
  const source = await readFile(
    new URL("../../../apps/desktop/src/renderer/runtime.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(isMemoryNotificationTopic\(topic\)\) \{\s*scheduleMemoryRefresh\(\);/);
  const runtime = previewRuntime();
  const degraded: RuntimeStore = {
    ...runtime,
    message: "记忆已在另一处更新，已重新加载最新内容。",
    data: {
      ...runtime.data,
      memory: {
        ...runtime.data.memory,
        status: "degraded",
        error: "当前记忆服务不可用。",
      },
    },
  };
  const html = renderMemoryPage({ runtime: degraded, forceNarrow: false });
  assert.match(html, /当前记忆服务不可用/);
  assert.match(html, /来源会话/);
  assert.match(html, /session-atlas/);
  assert.match(html, /已重新加载最新内容/);
});
