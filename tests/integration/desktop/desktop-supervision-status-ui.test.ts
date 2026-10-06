import assert from "node:assert/strict";
import * as React from "react";
const { createElement } = React;
Object.assign(globalThis, { React });
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { RemoteSupervisionStatus } from "../../../apps/desktop/src/renderer/RemoteSupervisionStatus.js";

test("后台状态面板区分系统注册与认证运行，展示版本和退出原因", () => {
  const updating = renderToStaticMarkup(
    createElement(RemoteSupervisionStatus, {
      running: false,
      supervision: {
        backend: "launchd",
        desiredRunning: true,
        registration: "registered",
        phase: "updating",
        scope: "user-session",
        registeredBuildId: "2.0.0",
        runningBuildId: "1.0.0",
        lastExit: { at: 1, signal: "SIGTERM", buildId: "1.0.0" },
      },
    }),
  );
  for (const text of [
    "后台运行",
    "系统注册",
    "已登记",
    "正在更新",
    "本机连接未就绪",
    "预期版本",
    "实际版本",
    "2.0.0",
    "1.0.0",
    "SIGTERM",
    "注销后手机连接停止",
  ])
    assert.ok(updating.includes(text), text);
  const blocked = renderToStaticMarkup(
    createElement(RemoteSupervisionStatus, {
      running: false,
      supervision: {
        backend: "task-scheduler",
        desiredRunning: true,
        registration: "missing",
        phase: "blocked",
        scope: "user-session",
        issueCode: "installation_missing",
      },
    }),
  );
  for (const text of ["Windows 登录会话", "未登记", "需要处理", "服务未运行", "应用文件不存在"])
    assert.ok(blocked.includes(text), text);
  assert.equal(
    renderToStaticMarkup(createElement(RemoteSupervisionStatus, { running: false })),
    "",
  );
});
