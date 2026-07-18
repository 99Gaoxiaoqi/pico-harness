import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MarkdownText } from "../../apps/desktop/src/renderer/conversation/MarkdownText.js";
import { projectRuntimeTranscript } from "../../src/daemon/desktop-transcript.js";
import { createEmptyUsageSnapshot } from "../../src/engine/session-runtime.js";
import type { TranscriptEvent } from "../../src/presentation/transcript-event-store.js";
import type { Message } from "../../src/schema/message.js";

function snapshot(messages: readonly Message[], transcriptEvents: readonly TranscriptEvent[] = []) {
  return {
    persistenceSequence: messages.length + transcriptEvents.length,
    sessionId: "desktop-session",
    messages: [...messages],
    messageSequences: messages.map((_, index) => transcriptEvents.length + index + 1),
    transcriptEvents,
    transcriptEventSequences: transcriptEvents.map((event) => event.sequence),
    runtime: { stateVersion: 1 as const, usage: createEmptyUsageSnapshot() },
  };
}

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
