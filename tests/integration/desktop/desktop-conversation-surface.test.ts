import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { conversationItemsFromReplica } from "../../../apps/desktop/src/renderer/conversation/runtime-projection.js";
import type { ComposerStatus } from "../../../apps/desktop/src/renderer/conversation/types.js";
import { installRendererSsr } from "./renderer-ssr-fixture.js";

after(installRendererSsr());
const [
  { ConversationComposer },
  { ConversationSurface },
  { ConversationTranscript },
  { ConversationQueue },
] = await Promise.all([
  import("../../../apps/desktop/src/renderer/conversation/ConversationComposer.js"),
  import("../../../apps/desktop/src/renderer/conversation/ConversationSurface.js"),
  import("../../../apps/desktop/src/renderer/conversation/ConversationTranscript.js"),
  import("../../../apps/desktop/src/renderer/conversation/ConversationQueue.js"),
]);

test("queue exposes steer, delete and more; only plain text with a current run can steer", () => {
  const actions = {
    updateQueuedInput: async () => true,
    removeQueuedInput: async () => true,
    reorderQueuedInputs: async () => true,
    moveQueuedInputToNext: async () => true,
    steerQueuedInput: async () => true,
  };
  const props = {
    actions,
    disabled: false,
    sessionRef: { workspacePath: "/worktree", sessionId: "session-1" },
    items: [
      {
        queueId: "queued-1",
        sessionId: "session-1",
        input: { kind: "text" as const, text: "或者是引导？" },
        createdAt: 1,
      },
    ],
    steerSupported: true,
    runId: "run-1",
  };
  const markup = renderToStaticMarkup(React.createElement(ConversationQueue, props));
  assert.match(markup, /或者是引导？/u);
  assert.match(markup, /aria-label="引导第 1 条消息"(?![^>]*disabled)/u);
  assert.match(markup, /aria-label="删除第 1 条排队消息"/u);
  assert.match(markup, /第 1 条排队消息的更多操作/u);
  assert.doesNotMatch(markup, /当前运行完成后按此顺序执行/u);
  for (const next of [
    { ...props, runId: undefined },
    { ...props, steerSupported: false },
    {
      ...props,
      items: [{ ...props.items[0]!, input: { kind: "skill" as const, name: "review" } }],
    },
    {
      ...props,
      items: [
        {
          ...props.items[0]!,
          input: { kind: "text" as const, text: "swarm", orchestrationMode: "swarm" as const },
        },
      ],
    },
  ]) {
    assert.match(
      renderToStaticMarkup(React.createElement(ConversationQueue, next)),
      /aria-label="引导第 1 条消息"[^>]*disabled/u,
    );
  }
});

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
  assert.match(resumed, /正在处理…/u);
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

  const tools = [
    ...markup.matchAll(
      /<details\b([^>]*class="[^"]*conversation-tool-record"[^>]*)>([\s\S]*?)<\/details>/gu,
    ),
  ];
  assert.equal(tools.length, 2);
  assert.doesNotMatch(tools[0]![1]!, /\bopen=/u);
  assert.match(tools[0]![2]!, /<summary\b[\s\S]*读取 README.md[\s\S]*<\/summary>/u);
  assert.match(tools[0]![2]!, /已读取项目说明/u);
  assert.match(tools[0]![2]!, /查看工具详情/u);
  assert.doesNotMatch(tools[1]![1]!, /\bopen=/u, "failed tools also start collapsed");
  assert.match(tools[1]![2]!, /缺少配置文件/u);
  assert.match(markup, /<strong\b[^>]*>(?:<span\b[^>]*>)*配置文件(?:<\/span>)*<\/strong>/u);
  assert.match(markup, /aria-label="会话内容"/u);
  assert.match(markup, /aria-label="消息" contentEditable="true" role="textbox"/u);
  assert.match(markup, /aria-label="发送消息"/u);
});

test("user messages expose copy and edit-and-resend actions instead of an inline branch form", async () => {
  const markup = renderToStaticMarkup(
    React.createElement(ConversationTranscript, {
      items: [
        {
          id: "message:event-1:user",
          kind: "userMessage",
          text: "修改这条请求",
          at: Date.UTC(2026, 8, 9, 1, 48),
        },
      ],
      onEditUserMessage: () => undefined,
    }),
  );

  assert.match(markup, /aria-label="消息操作"/u);
  assert.match(markup, /title="复制消息" aria-label="复制消息"/u);
  assert.match(markup, /title="编辑并重发" aria-label="编辑并重发"/u);
  assert.match(markup, /dateTime="2026-09-09T01:48:00\.000Z"/u);
  assert.doesNotMatch(markup, /提交为新分支|正在创建修订/u);
  const page = await readFile(
    new URL("../../../apps/desktop/src/renderer/pages/ConversationPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /正在修改已发送消息 · 发送后创建新版本/u);
});

test("conversation collapses consecutive tools across model turns in one run and summarizes live progress", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ConversationTranscript, {
      items: [
        { id: "user", kind: "userMessage", text: "检查项目" },
        {
          id: "tool-read",
          kind: "tool",
          runId: "run-1",
          turnId: "turn-1",
          toolName: "read_file",
          title: "读取 README.md",
          state: "done",
          output: "README 已读取",
        },
        {
          id: "tool-search",
          kind: "tool",
          runId: "run-1",
          turnId: "turn-2",
          toolName: "search",
          title: "搜索源码",
          state: "active",
        },
        {
          id: "tool-waiting",
          kind: "tool",
          runId: "run-1",
          turnId: "turn-3",
          toolName: "list_files",
          title: "列出文件",
          state: "waiting",
        },
        { id: "reply", kind: "assistantMessage", text: "正在检查。" },
      ],
    }),
  );

  const group = markup.match(/<details class="[^"]*conversation-tool-group[^"]*"([^>]*)>/u);
  assert.ok(group, "consecutive calls in one run should share a disclosure across model turns");
  assert.equal([...markup.matchAll(/data-tool-group="true"/gu)].length, 1);
  assert.doesNotMatch(group[1]!, /\bopen(?:=|\s|$)/u, "tool groups start collapsed");
  assert.match(group[1]!, /data-state="active"/u);
  assert.match(markup, /工具调用 · 3 项/u);
  assert.match(markup, /1 完成 · 1 运行中 · 1 等待中/u);
  assert.match(markup, /读取 README\.md[\s\S]*搜索源码[\s\S]*列出文件/u);
});

test("desktop replica preserves model turn identities while grouping consecutive tools in one run", () => {
  const items = conversationItemsFromReplica({
    phase: "ready",
    generation: 1,
    sessionId: "tool-group-session",
    records: ["call-1", "call-2"].map((toolCallId, index) => ({
      itemId: `tool:${toolCallId}`,
      itemRevision: 1,
      positionSequence: index + 1,
      positionOrdinal: 0,
      item: {
        id: `tool:${toolCallId}`,
        kind: "tool",
        name: index === 0 ? "read" : "search",
        args: "{}",
        status: "running",
        runId: "run-canonical",
        turnId: `turn-canonical-${index + 1}`,
        data: {
          toolCallId,
          providerCallId: `provider-${toolCallId}`,
          entryId: `entry-${toolCallId}`,
        },
      },
    })),
    activeOverlay: [],
    queuedInputs: [],
  });
  const markup = renderToStaticMarkup(React.createElement(ConversationTranscript, { items }));

  assert.deepEqual(
    items.filter((item) => item.kind === "tool").map((item) => item.turnId),
    ["turn-canonical-1", "turn-canonical-2"],
  );
  assert.equal([...markup.matchAll(/data-tool-group="true"/gu)].length, 1);
  assert.match(markup, /工具调用 · 2 项/u);
  assert.match(markup, /2 运行中/u);
});

test("conversation keeps failed tool summaries visible and splits groups at run or content boundaries", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ConversationTranscript, {
      items: [
        { id: "user", kind: "userMessage", text: "检查项目" },
        {
          id: "tool-one",
          kind: "tool",
          runId: "run-1",
          turnId: "turn-1",
          toolName: "search",
          title: "搜索符号",
          state: "done",
        },
        {
          id: "tool-two",
          kind: "tool",
          runId: "run-1",
          turnId: "turn-2",
          toolName: "bash",
          title: "运行命令",
          state: "failed",
          output: "Hardline 拒绝了该命令\n更多错误详情",
        },
        {
          id: "run-boundary",
          kind: "runBoundary",
          runId: "run-1",
          status: "completed",
          label: "运行完成",
        },
        {
          id: "other-turn",
          kind: "tool",
          runId: "run-1",
          turnId: "turn-2",
          toolName: "read_file",
          title: "读取文件",
          state: "done",
        },
        { id: "thinking", kind: "thinking", text: "接下来检查源码" },
        {
          id: "before-status",
          kind: "tool",
          runId: "run-1",
          turnId: "turn-1",
          toolName: "read_file",
          title: "边界前调用",
          state: "done",
        },
        { id: "status", kind: "status", title: "运行阶段结束" },
        {
          id: "after-status",
          kind: "tool",
          runId: "run-1",
          turnId: "turn-1",
          toolName: "read_file",
          title: "边界后调用",
          state: "done",
        },
        { id: "reply", kind: "assistantMessage", text: "已找到配置。" },
        {
          id: "after-reply",
          kind: "tool",
          runId: "run-1",
          turnId: "turn-3",
          toolName: "read_file",
          title: "回复后调用",
          state: "done",
        },
        { id: "steering", kind: "userMessage", text: "继续检查其他文件" },
        {
          id: "after-user",
          kind: "tool",
          runId: "run-1",
          turnId: "turn-4",
          toolName: "read_file",
          title: "用户消息后调用",
          state: "done",
        },
        {
          id: "other-run-one",
          kind: "tool",
          runId: "run-2",
          turnId: "turn-1",
          toolName: "read_file",
          title: "新运行的第一次读取",
          state: "done",
        },
        {
          id: "other-run-two",
          kind: "tool",
          runId: "run-2",
          turnId: "turn-1",
          toolName: "search",
          title: "新运行的第二次搜索",
          state: "done",
        },
        {
          id: "legacy-one",
          kind: "tool",
          toolName: "legacy",
          title: "无轮次身份的旧记录一",
          state: "done",
        },
        {
          id: "legacy-two",
          kind: "tool",
          toolName: "legacy",
          title: "无轮次身份的旧记录二",
          state: "done",
        },
      ],
    }),
  );

  assert.equal([...markup.matchAll(/data-tool-group="true"/gu)].length, 2);
  assert.match(markup, /data-state="failed" data-tool-group="true"/u);
  assert.match(markup, /conversation-tool-row__failure[^>]*>bash：Hardline 拒绝了该命令<\/span>/u);
  assert.match(markup, /运行命令[\s\S]*Hardline 拒绝了该命令[\s\S]*更多错误详情/u);
  assert.match(markup, /边界前调用/u);
  assert.match(markup, /边界后调用/u);
  assert.match(markup, /新运行的第一次读取[\s\S]*新运行的第二次搜索/u);
  assert.match(markup, /无轮次身份的旧记录一/u);
  assert.match(markup, /无轮次身份的旧记录二/u);
});
