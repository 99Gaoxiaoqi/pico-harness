import assert from "node:assert/strict";
import * as React from "react";
const { createElement } = React;
Object.assign(globalThis, { React });
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { MobileRecoveryNotice } from "../../../apps/desktop/src/renderer/MobileRecoveryNotice.js";
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
  const failed = renderToStaticMarkup(
    createElement(RemoteSupervisionStatus, {
      running: false,
      supervision: {
        backend: "none",
        desiredRunning: true,
        registration: "unsupported",
        phase: "blocked",
        scope: "none",
        issueCode: "startup_failed",
      },
    }),
  );
  assert.ok(failed.includes("未能自动恢复"));

  // 恢复失败只在设置页提供重试入口；未失败时不渲染。
  assert.equal(
    renderToStaticMarkup(
      createElement(MobileRecoveryNotice, { visible: false, busy: false, onRetry: () => {} }),
    ),
    "",
  );
  const visible = renderToStaticMarkup(
    createElement(MobileRecoveryNotice, { visible: true, busy: false, onRetry: () => {} }),
  );
  for (const text of ["后台服务未运行", "自动恢复没有完成", "重试恢复"])
    assert.ok(visible.includes(text), text);
  const busy = renderToStaticMarkup(
    createElement(MobileRecoveryNotice, { visible: true, busy: true, onRetry: () => {} }),
  );
  assert.match(busy, /disabled|aria-disabled/u);
});
