import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MarkdownText } from "../../apps/desktop/src/renderer/conversation/MarkdownText.js";
import { projectRuntimeTranscript } from "../../src/daemon/desktop-transcript.js";
import { createEmptyUsageSnapshot } from "../../src/engine/session-runtime.js";
import type { TranscriptEvent } from "../../src/presentation/transcript-event-store.js";
import type { Message } from "../../src/schema/message.js";

function snapshot(
  messages: readonly Message[],
  transcriptEvents: readonly TranscriptEvent[] = [],
  identities: readonly { readonly runId: string; readonly turnId: string }[] = [],
) {
  return {
    persistenceSequence: messages.length + transcriptEvents.length,
    sessionId: "desktop-session",
    messages: [...messages],
    messageSequences: messages.map((_, index) => transcriptEvents.length + index + 1),
    messageRunIds: messages.map((_, index) => identities[index]?.runId),
    messageTurnIds: messages.map((_, index) => identities[index]?.turnId),
    transcriptEvents,
    transcriptEventSequences: transcriptEvents.map((event) => event.sequence),
    runtime: { stateVersion: 1 as const, usage: createEmptyUsageSnapshot() },
  };
}

test("Desktop transcript carries the Runtime turn identity for durable reasoning and answers", () => {
  const page = projectRuntimeTranscript(
    snapshot(
      [{ role: "assistant", content: "完成。", reasoning: "检查配置。" }],
      [],
      [{ runId: "run-1", turnId: "turn:run-1:2" }],
    ),
    {},
  );

  assert.deepEqual(page.items[0], {
    id: page.items[0]?.id,
    kind: "thinking",
    content: "检查配置。",
    runId: "run-1",
    turnId: "turn:run-1:2",
  });
  assert.deepEqual(page.items[1], {
    id: page.items[1]?.id,
    kind: "assistantMessage",
    content: "完成。",
    runId: "run-1",
    turnId: "turn:run-1:2",
  });
});

test("Desktop transcript projects provider reasoning before the answer", () => {
  const page = projectRuntimeTranscript(
    snapshot([
      {
        role: "assistant",
        content: "答案 **完成**",
        reasoning: "先检查配置，再回答。",
      },
    ]),
    {},
  );

  assert.deepEqual(
    page.items.map((item) => ({ kind: item.kind, content: "content" in item ? item.content : "" })),
    [
      { kind: "thinking", content: "先检查配置，再回答。" },
      { kind: "assistantMessage", content: "答案 **完成**" },
    ],
  );
});

test("Desktop transcript restores structured thinking, Skill and system entries with stable IDs", () => {
  const events: TranscriptEvent[] = [
    {
      eventId: "skill-event",
      sequence: 1,
      createdAt: 1,
      type: "entry.appended",
      entryId: "skill-entry",
      entry: { kind: "skill", name: "review", args: "--quick", trigger: "user-slash" },
    },
    {
      eventId: "system-event",
      sequence: 2,
      createdAt: 2,
      type: "entry.appended",
      entryId: "system-entry",
      entry: { kind: "system", content: "已启用快速审查。" },
    },
    {
      eventId: "thinking-start",
      sequence: 3,
      createdAt: 3,
      type: "assistant.stream.started",
      entryId: "thinking-entry",
      streamId: "thinking-stream",
      entryKind: "thinking",
      delta: "检查文件结构。",
    },
    {
      eventId: "thinking-complete",
      sequence: 4,
      createdAt: 4,
      type: "assistant.stream.completed",
      entryId: "thinking-entry",
      streamId: "thinking-stream",
      content: "检查文件结构。\n",
    },
  ];

  const page = projectRuntimeTranscript(
    snapshot([{ role: "assistant", content: "完成。", reasoning: "检查文件结构。" }], events),
    {},
  );
  assert.deepEqual(
    page.items.map((item) => item.kind),
    ["skill", "systemNotice", "thinking", "assistantMessage"],
  );
  assert.deepEqual(
    page.items.slice(0, 3).map((item) => item.id),
    ["skill-entry", "system-entry", "thinking-entry"],
  );
  assert.match(page.items[3]?.id ?? "", /^item_[0-9a-f]{20}$/);
});

test("Desktop transcript places repeated identical reasoning before its matching answer", () => {
  const events: TranscriptEvent[] = [
    {
      eventId: "thinking-start-1",
      sequence: 1,
      createdAt: 1,
      type: "assistant.stream.started",
      entryId: "thinking-entry-1",
      streamId: "thinking-stream-1",
      entryKind: "thinking",
      delta: "同样的分析",
    },
    {
      eventId: "thinking-complete-1",
      sequence: 2,
      createdAt: 2,
      type: "assistant.stream.completed",
      entryId: "thinking-entry-1",
      streamId: "thinking-stream-1",
      content: "同样的分析",
    },
    {
      eventId: "thinking-start-2",
      sequence: 3,
      createdAt: 3,
      type: "assistant.stream.started",
      entryId: "thinking-entry-2",
      streamId: "thinking-stream-2",
      entryKind: "thinking",
      delta: "同样的分析",
    },
    {
      eventId: "thinking-complete-2",
      sequence: 4,
      createdAt: 4,
      type: "assistant.stream.completed",
      entryId: "thinking-entry-2",
      streamId: "thinking-stream-2",
      content: "同样的分析",
    },
  ];
  const page = projectRuntimeTranscript(
    snapshot(
      [
        { role: "assistant", content: "第一次回答", reasoning: "同样的分析" },
        { role: "assistant", content: "第二次回答", reasoning: "同样的分析" },
      ],
      events,
    ),
    {},
  );

  assert.deepEqual(
    page.items.map((item) =>
      item.kind === "thinking" || item.kind === "assistantMessage" ? item.content : item.kind,
    ),
    ["同样的分析", "第一次回答", "同样的分析", "第二次回答"],
  );
  assert.deepEqual(
    page.items.filter((item) => item.kind === "thinking").map((item) => item.id),
    ["thinking-entry-1", "thinking-entry-2"],
  );
});

test("Desktop transcript preserves the subagent display name as structured data", () => {
  const events: TranscriptEvent[] = [
    {
      eventId: "subagent-update",
      sequence: 1,
      createdAt: 1,
      type: "subagent.activity.updated",
      entryId: "subagent-entry",
      activityId: "activity-1",
      activity: {
        task: "检查架构边界",
        status: "running",
        agentName: "Explore",
        mode: "explore",
      },
    },
  ];
  const page = projectRuntimeTranscript(snapshot([], events), {});
  const item = page.items[0];

  assert.equal(item?.kind, "subagent");
  assert.equal(item?.kind === "subagent" ? item.name : undefined, "Explore");
  assert.equal(item?.kind === "subagent" ? item.title : undefined, "Explore: 检查架构边界");
});

test("Desktop Markdown renders structure while blocking raw HTML and unsafe links", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownText, {
      text: "# 标题\n\n**重要** [危险](javascript:alert(1))\n\n| 列 | 值 |\n| --- | --- |\n| A | B |\n\n\u001b[31m<script>alert(1)</script>",
    }),
  );
  assert.match(html, /<h1>[\s\S]*标题[\s\S]*<\/h1>/);
  assert.match(html, /<strong>[\s\S]*重要[\s\S]*<\/strong>/);
  assert.match(html, /<table>[\s\S]*<th>[\s\S]*列[\s\S]*<\/th>/);
  assert.equal(html.includes(String.fromCharCode(27)), false);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<script/i);
});

test("Desktop transcript preserves repeated structured tool calls during dedupe", () => {
  const events: TranscriptEvent[] = [
    {
      eventId: "tool-start-1",
      sequence: 1,
      createdAt: 1,
      type: "tool.started",
      entryId: "tool-entry-1",
      toolCallId: "tool-call-1",
      name: "read_file",
      args: '{"path":"README.md"}',
    },
    {
      eventId: "tool-complete-1",
      sequence: 2,
      createdAt: 2,
      type: "tool.completed",
      toolCallId: "tool-call-1",
      status: "success",
      summary: "Tool completed · 1 bytes",
      size: 1,
      truncated: false,
    },
    {
      eventId: "tool-start-2",
      sequence: 3,
      createdAt: 3,
      type: "tool.started",
      entryId: "tool-entry-2",
      toolCallId: "tool-call-2",
      name: "read_file",
      args: '{"path":"README.md"}',
    },
    {
      eventId: "tool-complete-2",
      sequence: 4,
      createdAt: 4,
      type: "tool.completed",
      toolCallId: "tool-call-2",
      status: "success",
      summary: "Tool completed · 2 bytes",
      size: 2,
      truncated: false,
    },
  ];
  const page = projectRuntimeTranscript(
    snapshot(
      [
        {
          role: "assistant",
          content: "完成。",
          toolCalls: [{ id: "model-call-1", name: "read_file", arguments: '{"path":"README.md"}' }],
        },
      ],
      events,
    ),
    {},
  );

  const tools = page.items.filter((item) => item.kind === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.id, "tool-entry-2");
  assert.match(tools[1]?.id ?? "", /^item_[0-9a-f]{20}$/);
});

test("Desktop transcript matches structured tools by providerCallId before legacy signatures", () => {
  const args = '{"path":"README.md"}';
  const events: TranscriptEvent[] = [
    {
      eventId: "tool-start-b",
      sequence: 1,
      createdAt: 1,
      type: "tool.started",
      entryId: "tool-entry-b",
      toolCallId: "tool-call-b",
      providerCallId: "provider-call-b",
      name: "read_file",
      args,
    },
    {
      eventId: "tool-start-a",
      sequence: 2,
      createdAt: 2,
      type: "tool.started",
      entryId: "tool-entry-a",
      toolCallId: "tool-call-a",
      providerCallId: "provider-call-a",
      name: "read_file",
      args,
    },
  ];
  const page = projectRuntimeTranscript(
    snapshot(
      [
        {
          role: "assistant",
          content: "done",
          toolCalls: [{ id: "provider-call-a", name: "read_file", arguments: args }],
        },
      ],
      events,
    ),
    {},
  );

  assert.deepEqual(
    page.items.filter((item) => item.kind === "tool").map((item) => item.id),
    ["tool-entry-b", "tool-entry-a"],
  );
});

test("Desktop transcript matches a reused providerCallId to the nearest preceding call", () => {
  const args = '{"path":"README.md"}';
  const messages: Message[] = [
    {
      role: "assistant",
      content: "first",
      toolCalls: [{ id: "reused-call", name: "read_file", arguments: args }],
    },
    { role: "user", content: "1", toolCallId: "reused-call" },
    {
      role: "assistant",
      content: "second",
      toolCalls: [{ id: "reused-call", name: "read_file", arguments: args }],
    },
    { role: "user", content: "22", toolCallId: "reused-call" },
  ];
  const events: TranscriptEvent[] = [
    {
      eventId: "tool-start-reused",
      sequence: 1,
      createdAt: 5,
      type: "tool.started",
      entryId: "tool-entry-reused",
      toolCallId: "tool-call-reused",
      providerCallId: "reused-call",
      name: "read_file",
      args,
    },
  ];
  const page = projectRuntimeTranscript(
    {
      ...snapshot(messages, events),
      persistenceSequence: 5,
      messageSequences: [1, 2, 3, 4],
      transcriptEventSequences: [5],
    },
    {},
  );

  const tools = page.items.filter((item) => item.kind === "tool");
  assert.equal(tools.length, 2);
  assert.match(tools[0]?.id ?? "", /^item_[0-9a-f]{20}$/u);
  assert.match(tools[0]?.kind === "tool" ? (tools[0].summary ?? "") : "", /1 bytes/u);
  assert.equal(tools[1]?.id, "tool-entry-reused");
});

test("Desktop transcript binds duplicate reasoning text to the nearest structured turn", () => {
  const messages: Message[] = [
    { role: "assistant", content: "old answer", reasoning: "same" },
    { role: "user", content: "next" },
    { role: "assistant", content: "new answer", reasoning: "same" },
  ];
  const events: TranscriptEvent[] = [
    {
      eventId: "thinking-start-new",
      sequence: 1,
      createdAt: 5,
      type: "assistant.stream.started",
      entryId: "thinking-new",
      streamId: "thinking-stream-new",
      entryKind: "thinking",
      delta: "same",
    },
    {
      eventId: "thinking-complete-new",
      sequence: 2,
      createdAt: 6,
      type: "assistant.stream.completed",
      entryId: "thinking-new",
      streamId: "thinking-stream-new",
      content: "same",
    },
  ];
  const page = projectRuntimeTranscript(
    {
      ...snapshot(messages, events),
      persistenceSequence: 6,
      messageSequences: [1, 2, 4],
      messageRunIds: ["run-old", "run-user", "run-new"],
      messageTurnIds: ["turn-old", "turn-user", "turn-new"],
      transcriptEventSequences: [5, 6],
    },
    {},
  );

  const thinking = page.items.filter((item) => item.kind === "thinking");
  assert.equal(thinking.length, 2);
  assert.notEqual(thinking[0]?.id, "thinking-new");
  assert.equal(thinking[1]?.id, "thinking-new");
  assert.equal(thinking[1]?.runId, "run-new");
  assert.equal(thinking[1]?.turnId, "turn-new");
});
