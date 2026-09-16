import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationComposer } from "../../../apps/desktop/src/renderer/conversation/ConversationComposer.js";
import { ConversationSurface } from "../../../apps/desktop/src/renderer/conversation/ConversationSurface.js";
import { ConversationTranscript } from "../../../apps/desktop/src/renderer/conversation/ConversationTranscript.js";
import type { ComposerStatus } from "../../../apps/desktop/src/renderer/conversation/types.js";

Object.assign(globalThis, { React });

test("conversation waits for the safe pause boundary before offering resume and retains queued messages", async () => {
  const page = await readFile(
    new URL("../../../apps/desktop/src/renderer/pages/ConversationPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    page,
    /activeRun\.status === "paused" \|\| activeRun\.status === "pause_requested"\s*\? activeRun\.status/u,
    "the page must preserve the requested pause state when passing it to the composer",
  );
  assert.match(page, /status=\{composerStatus\}/u);
  const renderComposer = (status: ComposerStatus, queuedCount = 0) =>
    renderToStaticMarkup(
      React.createElement(ConversationSurface, {
        children: null,
        composer: React.createElement(ConversationComposer, {
          value: "",
          status,
          statusText: queuedCount ? `${queuedCount} 条消息正在排队` : undefined,
          onValueChange: () => undefined,
          onSubmit: () => undefined,
          onPause: () => undefined,
          onResume: () => undefined,
          onStop: () => undefined,
        }),
      }),
    );

  assert.match(renderComposer("running"), /aria-label="暂停运行"/u);
  for (const queuedCount of [0, 2]) {
    const waiting = renderComposer("pause_requested", queuedCount);
    assert.match(waiting, /data-status="pause_requested"/u);
    assert.match(waiting, /等待暂停，将在安全边界暂停/u);
    assert.match(waiting, /aria-label="停止运行"/u);
    assert.doesNotMatch(waiting, /已暂停|aria-label="(?:继续|暂停)运行"/u);
    if (queuedCount) assert.match(waiting, /2 条消息正在排队/u);
  }
  const paused = renderComposer("paused");
  assert.match(paused, /已暂停/u);
  assert.match(paused, /aria-label="继续运行"/u);
  assert.match(paused, /aria-label="停止运行"/u);
  assert.doesNotMatch(paused, /等待暂停|aria-label="暂停运行"/u);
  const resumed = renderComposer("running");
  assert.match(resumed, /Pico 正在工作/u);
  assert.match(resumed, /aria-label="暂停运行"/u);
  assert.doesNotMatch(resumed, /已暂停|等待暂停|aria-label="继续运行"/u);
});

test("conversation keeps tool output behind a disclosure while retaining failures, replies and the composer", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ConversationSurface, {
      composer: React.createElement(ConversationComposer, {
        value: "第一行\n第二行",
        status: "idle",
        onValueChange: () => undefined,
        onSubmit: () => undefined,
      }),
      children: React.createElement(ConversationTranscript, {
        items: [
          { id: "user", kind: "userMessage", text: "检查项目" },
          {
            id: "read",
            kind: "tool",
            toolName: "read_file",
            title: "读取 README.md",
            state: "done",
            output: "已读取项目说明",
          },
          {
            id: "check",
            kind: "tool",
            toolName: "shell",
            title: "运行检查",
            state: "failed",
            output: "缺少配置文件",
          },
          { id: "reply", kind: "assistantMessage", text: "请补充 **配置文件**。" },
        ],
        onOpenItem: () => undefined,
      }),
    }),
  );

  const tools = [...markup.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/gu)];
  assert.equal(tools.length, 2);
  assert.doesNotMatch(tools[0]![1]!, /\bopen=/u);
  assert.match(tools[0]![2]!, /<summary\b[\s\S]*读取 README.md[\s\S]*<\/summary>/u);
  assert.match(tools[0]![2]!, /已读取项目说明/u);
  assert.match(tools[0]![2]!, /查看工具详情/u);
  assert.match(tools[1]![1]!, /\bopen=""/u);
  assert.match(tools[1]![2]!, /缺少配置文件/u);
  assert.match(markup, /<strong>(?:<span>)?配置文件(?:<\/span>)?<\/strong>/u);
  assert.match(markup, /aria-label="会话内容"/u);
  assert.match(markup, /<textarea\b[^>]*>第一行\n第二行<\/textarea>/u);
  assert.match(markup, /aria-label="发送消息"/u);
});
