import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { SystemSettingsPage } from "../../../apps/desktop/src/renderer/pages/SettingsPage.js";
import { RuntimeContext } from "../../../apps/desktop/src/renderer/runtime-context.js";
import { emptyData } from "../../../apps/desktop/src/renderer/model.js";
import type { RuntimeStore } from "../../../apps/desktop/src/renderer/runtime.js";

test("健康页区分配置与验证，高级诊断只列正式项目和当前临时任务", (t) => {
  // tsx uses the desktop's JSX-preserve config; provide the classic JSX runtime for SSR.
  const globals = globalThis as typeof globalThis & { React?: typeof React };
  const previousReact = globals.React;
  globals.React = React;
  t.after(() => {
    if (previousReact) globals.React = previousReact;
    else Reflect.deleteProperty(globals, "React");
  });
  const store = {
    connection: { kind: "ready" },
    data: {
      ...emptyData,
      workspacePath: "/tmp/current",
      workspaces: [
        { path: "/project", name: "项目", temporary: false },
        { path: "/tmp/current", temporary: true },
        { path: "/tmp/old", temporary: true },
      ],
      modelRoutes: [{ id: "test/model", label: "model" }],
      mcpScope: {
        userItems: [{ id: "user-mcp", name: "用户 MCP", state: "ready", description: "已配置" }],
        workspacePath: "/other",
      },
      mcpServers: [{ id: "project-mcp", name: "其他项目 MCP", state: "attention" }],
      runs: [{ id: "run", workspacePath: "/tmp/current", status: "failed", updatedAt: 1 }],
    },
    actions: {},
  } as unknown as RuntimeStore;
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeContext.Provider, { value: store }, createElement(SystemSettingsPage)),
    ),
  );
  assert.match(html, /已配置/);
  assert.match(html, /未验证/);
  assert.doesNotMatch(html, /最近一次任务失败|其他项目 MCP/);
  assert.match(html, /用户 MCP/);
  assert.match(html, /<details[^>]*><summary>高级诊断<\/summary>/);
  assert.match(html, /value="\/project"/);
  assert.match(html, /value="\/tmp\/current"/);
  assert.doesNotMatch(html, /value="\/tmp\/old"/);
  assert.match(html, /当前无项目任务/);
});
