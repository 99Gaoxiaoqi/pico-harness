/// <reference lib="dom" />

import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { previewData } from "../../../apps/desktop/src/renderer/fixture.js";

import { HomePage } from "../../../apps/desktop/src/renderer/pages/HomePage.js";
import { RuntimeContext } from "../../../apps/desktop/src/renderer/runtime-context.js";
import type { RuntimeStore } from "../../../apps/desktop/src/renderer/runtime.js";
import {
  parseRuns,
  parseSessionDetail,
  parseSessions,
} from "../../../apps/desktop/src/renderer/runtime-projections/workspace.js";
import {
  subagentMetadata,
  subagentParent,
  subagentSessionHref,
} from "../../../apps/desktop/src/renderer/conversation/subagent-navigation.js";
import {
  sessionHref,
  workspaceSessionKey,
} from "../../../apps/desktop/src/renderer/workspace-session.js";

Object.assign(globalThis, { React });

test("子代理导航只接受显式 childSessionId，不再从 activityId 推断会话", () => {
  const activityId = "subagent-12345678-1234-1234-1234-123456789abc";
  assert.equal(subagentMetadata({ activityId }).childSessionId, undefined);
  assert.equal(
    subagentMetadata({ activityId, childSessionId: "child-session" }).childSessionId,
    "child-session",
  );
});

test("桌面会话与运行投影只接受当前显式身份字段", () => {
  assert.deepEqual(parseSessions({ sessions: [{ id: "old-session" }] }, "/workspace"), []);
  assert.equal(parseSessionDetail({ session: { id: "old-session" } }, "/workspace"), undefined);
  assert.deepEqual(parseRuns({ runs: [{ id: "old-run" }] }, "/workspace"), []);
});

test("隐藏子会话按详情冷启动及刷新，跨工作区返回父任务且首页列表不回添", () => {
  const parent = { workspacePath: "/project/parent", sessionId: "same-id" };
  const child = { workspacePath: "/project/child", sessionId: "same-id" };
  const sessions = parseSessions(
    { sessions: [{ sessionId: parent.sessionId, title: "父任务标题" }] },
    parent.workspacePath,
  );
  const detail = parseSessionDetail(
    {
      session: {
        sessionId: child.sessionId,
        title: "子会话持久标题",
        status: "archived",
        parentSession: { ...parent, agentName: "持久子代理名称" },
      },
    },
    child.workspacePath,
  )!;
  const runtime: RuntimeStore = {
    preview: true,
    connection: { kind: "ready" },
    busy: undefined,
    message: undefined,
    data: {
      ...previewData,
      workspacePath: child.workspacePath,
      sessions,
      runs: [],
      conversations: {
        [workspaceSessionKey(child)]: { ...child, session: detail, items: [], queuedCount: 0 },
      },
    },
    actions: new Proxy({} as RuntimeStore["actions"], {
      get: () => () => {
        throw new Error("Render must not dispatch");
      },
    }),
  };
  function renderHome() {
    return renderToStaticMarkup(
      React.createElement(
        RuntimeContext.Provider,
        { value: runtime },
        React.createElement(MemoryRouter, { initialEntries: ["/"] }, React.createElement(HomePage)),
      ),
    );
  }
  const bareHref = sessionHref(child);
  const fromParent = subagentSessionHref(
    {
      id: "agent",
      kind: "subagent",
      name: "旧名称",
      title: "任务",
      state: "done",
      childSessionId: child.sessionId,
      childWorkspacePath: child.workspacePath,
    },
    parent,
  )!;
  for (const href of [bareHref, fromParent]) {
    const back = subagentParent(href.slice(href.indexOf("?")), child, runtime.data.conversations)!;
    assert.deepEqual(back, { ...parent, name: "持久子代理名称" });
    assert.equal(sessionHref(back), sessionHref(parent));
    const loaded = runtime.data.conversations[workspaceSessionKey(child)]!.session!;
    assert.equal(loaded.title, "子会话持久标题");
    assert.equal(loaded.status, "archived");
  }
  assert.deepEqual(subagentParent(fromParent.slice(fromParent.indexOf("?")), child, {}), {
    ...parent,
    name: "旧名称",
  });
  const wrongQuery = "?parentSession=wrong&parentWorkspace=%2Fwrong&agentName=wrong";
  assert.deepEqual(subagentParent(wrongQuery, child, runtime.data.conversations), {
    ...parent,
    name: "持久子代理名称",
  });
  const home = renderHome();
  assert.match(home, /父任务标题/u);
  assert.doesNotMatch(home, /持久子代理名称|子会话持久标题/u);
  assert.deepEqual(runtime.data.sessions, sessions);
  assert.equal(runtime.data.sessions.length, 1);
});
