import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionWorkbar } from "../../apps/desktop/src/renderer/workbar/SessionWorkbar.js";

test("desktop Workbar renders one accessible right dock with persistent tab panels", () => {
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(
    React.createElement(SessionWorkbar, {
      tabs: [
        { id: "overview", kind: "overview", label: "概览", closable: true },
        { id: "review", kind: "review", label: "变更", closable: true, badge: 2 },
      ],
      activeTabId: "overview",
      collapsed: false,
      width: 480,
      renderPanel: (tab) => React.createElement("p", null, `${tab.label}内容`),
      onSelect: () => undefined,
      onClose: () => undefined,
      onReorder: () => undefined,
      onToggleCollapsed: () => undefined,
      onResize: () => undefined,
      onOpenLauncher: () => undefined,
    }),
  );

  assert.match(html, /aria-label="任务工作栏"/u);
  assert.match(html, /role="tablist"/u);
  assert.match(html, /role="tab"[^>]+aria-selected="true"/u);
  assert.match(html, /role="tabpanel"/u);
  assert.match(html, /hidden=""[^>]+tabindex="-1"/u);
  assert.match(html, /aria-valuemin="320"/u);
  assert.match(html, /aria-valuemax="600"/u);
  assert.match(html, /--session-workbar-width:480px/u);
  assert.match(html, /aria-label="关闭“变更”"/u);
});

test("desktop Workbar exposes only panels backed by existing authorities", async () => {
  const source = await rendererSource("App.tsx");
  const launcher = source.slice(
    source.indexOf("const WORKBAR_LAUNCHER_TABS"),
    source.indexOf("function useRuntime"),
  );

  assert.match(launcher, /kind: "overview"/u);
  assert.match(launcher, /kind: "review"/u);
  assert.match(launcher, /kind: "context"/u);
  assert.doesNotMatch(launcher, /tasks|files|terminal|browser|side-chat/u);
  assert.match(source, /<SessionWorkbar/u);
  assert.match(source, /inspectorMode="workbar"/u);
  assert.match(source, /tab: \{ id: "inspector", kind: "inspector", label: inspector\.title \}/u);
  assert.doesNotMatch(source, /inspector \? \(\s*<ConversationInspector/u);
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

test("desktop hydrates the existing session context report into the Workbar", async () => {
  const runtimeSource = await rendererSource("runtime.ts");
  const appSource = await rendererSource("App.tsx");

  assert.match(runtimeSource, /optionalInvoke\(bridge, "session\.context\.get"/u);
  assert.match(runtimeSource, /context: parseSessionContext\(contextResult\.value\)/u);
  assert.match(appSource, /context\.remainingTokens/u);
  assert.match(appSource, /context\.contextWindowTokens/u);
});

async function rendererSource(fileName: string): Promise<string> {
  return readFile(new URL(`../../apps/desktop/src/renderer/${fileName}`, import.meta.url), "utf8");
}
