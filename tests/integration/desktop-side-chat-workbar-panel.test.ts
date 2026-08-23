import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SideChatWorkbarPanel,
  shouldActivateSideChatData,
  sideChatCanSend,
} from "../../apps/desktop/src/renderer/workbar-panels/index.js";

Object.assign(globalThis, { React });

const noop = () => undefined;

test("Side Chat helpers gate data activity without coupling it to rendered state", () => {
  assert.equal(shouldActivateSideChatData(true, "creating"), true);
  assert.equal(shouldActivateSideChatData(true, "live"), true);
  assert.equal(shouldActivateSideChatData(false, "live"), false);
  assert.equal(shouldActivateSideChatData(true, "failed"), false);

  assert.equal(sideChatCanSend("live", false, " 继续分析 "), true);
  assert.equal(sideChatCanSend("live", true, "继续分析"), false);
  assert.equal(sideChatCanSend("creating", false, "继续分析"), false);
  assert.equal(sideChatCanSend("live", false, "   "), false);
});

test("inactive Side Chat keeps its transcript and controlled draft rendered", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SideChatWorkbarPanel, {
      child: {
        panelId: "side-chat-1",
        sourceSessionId: "parent-session",
        targetSessionId: "child-session",
        state: "live",
        throughEventId: "event-12",
      },
      items: [
        { id: "user-1", kind: "userMessage", text: "只分析这个失败原因" },
        { id: "assistant-1", kind: "assistantMessage", text: "先检查重连水位。" },
      ],
      draft: "保留中的草稿",
      active: false,
      running: false,
      loading: false,
      onSend: noop,
      onStop: noop,
      onDraftChange: noop,
      onRetryCreate: noop,
      onClose: noop,
    }),
  );

  assert.match(markup, /data-child-state="live"/u);
  assert.doesNotMatch(markup, /data-active=/u);
  assert.match(markup, /临时分支/u);
  assert.match(markup, /不会回写父会话/u);
  assert.match(markup, /aria-label="临时分支会话记录"/u);
  assert.match(markup, /只分析这个失败原因/u);
  assert.match(markup, /先检查重连水位/u);
  assert.match(markup, /保留中的草稿/u);
  assert.match(markup, /aria-label="发送消息"/u);
});

test("Side Chat explains a rejected fork when the parent has no completed turn", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SideChatWorkbarPanel, {
      child: {
        panelId: "side-chat-2",
        sourceSessionId: "parent-session",
        state: "failed",
      },
      items: [],
      draft: "",
      active: true,
      running: false,
      loading: false,
      error: {
        code: "no_settled_turn",
        message: "父会话还没有成功完成的回合。",
      },
      onSend: noop,
      onStop: noop,
      onDraftChange: noop,
      onRetryCreate: noop,
      onClose: noop,
    }),
  );

  assert.match(markup, /role="alert"/u);
  assert.match(markup, /需要一个已完成的回合/u);
  assert.match(markup, /父会话还没有成功完成的回合/u);
  assert.match(markup, />重试</u);
  assert.match(markup, /disabled=""/u);
  assert.match(markup, /临时分支就绪后可发送消息/u);
});

test("Side Chat exposes pending interactions and running controls", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SideChatWorkbarPanel, {
      child: {
        panelId: "side-chat-3",
        sourceSessionId: "parent-session",
        targetSessionId: "child-session",
        state: "live",
      },
      items: [],
      draft: "下一步",
      active: true,
      running: true,
      loading: false,
      pendingApproval: React.createElement("button", { type: "button" }, "允许修改文件"),
      onSend: noop,
      onStop: noop,
      onDraftChange: noop,
      onRetryCreate: noop,
      onClose: noop,
    }),
  );

  assert.match(markup, /data-active="true"/u);
  assert.match(markup, /aria-label="侧边对话待处理交互"/u);
  assert.match(markup, /允许修改文件/u);
  assert.match(markup, /Agent 正在运行/u);
  assert.match(markup, />停止</u);
  assert.match(markup, /下一步/u);
});
