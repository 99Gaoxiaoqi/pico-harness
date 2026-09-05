import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationComposer } from "../../apps/desktop/src/renderer/conversation/ConversationComposer.js";
import { ConversationSurface } from "../../apps/desktop/src/renderer/conversation/ConversationSurface.js";
import { ConversationTranscript } from "../../apps/desktop/src/renderer/conversation/ConversationTranscript.js";

Object.assign(globalThis, { React });

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
