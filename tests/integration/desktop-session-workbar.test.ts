import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SessionWorkbarLayout,
  WORKBAR_TOOL_REGISTRY,
  createWorkbarState,
  createWorkbarToolTab,
} from "../../apps/desktop/src/renderer/workbar/index.js";

test("desktop Workbar renders accessible right and bottom Docks with persistent tab panels", () => {
  Object.assign(globalThis, { React });
  const state = createWorkbarState({
    rightWidth: 480,
    bottomHeight: 360,
    docks: {
      right: {
        collapsed: false,
        tabs: [createWorkbarToolTab("review"), createWorkbarToolTab("tasks")],
      },
      bottom: {
        collapsed: false,
        tabs: [{ id: "terminal:1", kind: "terminal", label: "Terminal 1" }],
      },
    },
  });
  const html = renderToStaticMarkup(
    React.createElement(SessionWorkbarLayout, {
      state,
      presentTab: (tab) => ({ closable: true, ...(tab.kind === "review" ? { badge: 2 } : {}) }),
      renderPanel: (tab) => React.createElement("p", null, `${tab.label}内容`),
      onAction: () => undefined,
      children: React.createElement("article", null, "主对话"),
    }),
  );

  assert.match(html, /aria-label="右侧任务工作栏"/u);
  assert.match(html, /aria-label="底部任务工作栏"/u);
  assert.equal((html.match(/role="tablist"/gu) ?? []).length, 2);
  assert.match(html, /role="tab"[^>]+aria-selected="true"/u);
  assert.match(html, /hidden=""[^>]+tabindex="-1"/u);
  assert.match(html, /aria-valuemin="320"/u);
  assert.match(html, /aria-valuemax="600"/u);
  assert.match(html, /aria-valuemin="180"/u);
  assert.match(html, /aria-valuemax="520"/u);
  assert.match(html, /--session-workbar-width:480px/u);
  assert.match(html, /--session-workbar-height:360px/u);
  assert.match(html, /aria-label="关闭“变更”"/u);
});

test("new tasks render without Workbar chrome until a session exists", () => {
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(
    React.createElement(SessionWorkbarLayout, {
      state: createWorkbarState(),
      enabled: false,
      renderPanel: () => React.createElement("p", null, "工作栏"),
      onAction: () => undefined,
      children: React.createElement("article", null, "专注的新任务"),
    }),
  );

  assert.match(html, /专注的新任务/u);
  assert.doesNotMatch(html, /任务工作栏|session-workbar/u);
});

test("desktop Workbar v2 source exposes full Registry, context menu and keyboard alternatives", async () => {
  assert.deepEqual(
    WORKBAR_TOOL_REGISTRY.map(({ kind, label }) => ({ kind, label })),
    [
      { kind: "side-chat", label: "侧边对话" },
      { kind: "review", label: "变更" },
      { kind: "terminal", label: "终端" },
      { kind: "browser", label: "浏览器" },
      { kind: "files", label: "生成文件" },
      { kind: "tasks", label: "待办" },
      { kind: "inspector", label: "追踪" },
    ],
  );

  const source = await rendererSource("workbar/SessionWorkbar.tsx");
  assert.match(source, /type: "moveDock"/u);
  assert.match(source, /type: "pinPreview"/u);
  assert.match(source, /type: "closeOthers"/u);
  assert.match(source, /type: "closeRight"/u);
  assert.match(source, /Shift\+F10/u);
  assert.match(source, /Alt\+Shift\+ArrowUp/u);
  assert.match(source, /onContextMenu/u);
  assert.match(source, /onDoubleClick/u);
});

test("desktop loads change summaries first and fetches only the selected diff", async () => {
  const source = await rendererSource("runtime.ts");
  const summaryLoad = source.slice(
    source.indexOf("if (changeRunId)"),
    source.indexOf("setData((current) => ({", source.indexOf("if (changeRunId)")),
  );
  const selectedDiffLoad = source.slice(
    source.indexOf("async loadChangeDiff"),
    source.indexOf("async reviewChanges", source.indexOf("async loadChangeDiff")),
  );

  assert.match(summaryLoad, /"changes\.list"/u);
  assert.doesNotMatch(summaryLoad, /"changes\.diff"|Promise\.all/u);
  assert.match(selectedDiffLoad, /"changes\.diff"/u);
  assert.match(selectedDiffLoad, /workspaceSessionKey\(\{ workspacePath, sessionId \}\)/u);
});

test("desktop hydrates the existing session context report for the Inspector authority", async () => {
  const runtimeSource = await rendererSource("runtime.ts");

  assert.match(runtimeSource, /optionalInvoke\(bridge, "session\.context\.get"/u);
  assert.match(runtimeSource, /context: parseSessionContext\(contextResult\.value\)/u);
});

async function rendererSource(fileName: string): Promise<string> {
  return readFile(new URL(`../../apps/desktop/src/renderer/${fileName}`, import.meta.url), "utf8");
}
