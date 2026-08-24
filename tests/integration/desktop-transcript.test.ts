import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MarkdownText } from "../../apps/desktop/src/renderer/conversation/MarkdownText.js";
import { ConversationTranscript } from "../../apps/desktop/src/renderer/conversation/ConversationTranscript.js";
import { assembleConversationFragments } from "../../apps/desktop/src/renderer/runtime.js";
import { projectRuntimeTranscript } from "../../src/daemon/desktop-transcript.js";
import { createEmptyUsageSnapshot } from "../../src/engine/session-runtime.js";
import { advanceRuntimeTranscriptPagingState } from "../../src/tui/client-session-runtime.js";
import {
  createToolResultEnvelope,
  type ToolResultEnvelope,
} from "../../src/engine/tool-result-contract.js";
import type { DurableTranscriptEvent } from "../../src/presentation/transcript-event-store.js";
import type { Message } from "../../src/schema/message.js";

Object.assign(globalThis, { React });

function snapshot(
  messages: readonly Message[],
  transcriptEvents: readonly DurableTranscriptEvent[] = [],
  identities: readonly { readonly runId: string; readonly turnId: string }[] = [],
  toolResults: readonly {
    readonly sequence: number;
    readonly eventId: string;
    readonly envelope: ToolResultEnvelope;
  }[] = [],
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
    toolResults,
    runtime: { stateVersion: 2 as const, usage: createEmptyUsageSnapshot() },
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
  const events: DurableTranscriptEvent[] = [
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

test("Desktop transcript pages matched structured thinking with integer ordinals before its answer", () => {
  const events: DurableTranscriptEvent[] = [
    {
      eventId: "thinking-start",
      sequence: 1,
      createdAt: 1,
      type: "assistant.stream.started",
      entryId: "thinking-entry",
      streamId: "thinking-stream",
      entryKind: "thinking",
      delta: "先检查配置。",
    },
    {
      eventId: "thinking-complete",
      sequence: 2,
      createdAt: 2,
      type: "assistant.stream.completed",
      entryId: "thinking-entry",
      streamId: "thinking-stream",
      content: "先检查配置。",
    },
  ];
  const source = snapshot(
    [{ role: "assistant", content: "完成。", reasoning: "先检查配置。" }],
    events,
  );

  const answerPage = projectRuntimeTranscript(source, { limit: 1 });
  assert.deepEqual(
    answerPage.items.map((item) => item.kind),
    ["assistantMessage"],
  );
  assert.deepEqual(answerPage.nextCursor, {
    revision: "3",
    throughTranscriptSequence: 3,
    position: 3,
    ordinal: 1,
    byteOffset: 0,
    direction: "older",
  });
  assert.equal(Number.isSafeInteger(answerPage.nextCursor?.ordinal), true);

  const thinkingPage = projectRuntimeTranscript(source, {
    cursor: answerPage.nextCursor,
    limit: 1,
  });
  assert.deepEqual(
    thinkingPage.items.map((item) => item.kind),
    ["thinking"],
  );
  assert.equal(thinkingPage.items[0]?.id, "thinking-entry");
  assert.equal(thinkingPage.nextCursor, undefined);
});

test("Desktop transcript places repeated identical reasoning before its matching answer", () => {
  const events: DurableTranscriptEvent[] = [
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
  const events: DurableTranscriptEvent[] = [
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
        completionPolicy: "required",
      },
    },
  ];
  const page = projectRuntimeTranscript(snapshot([], events), {});
  const item = page.items[0];

  assert.equal(item?.kind, "subagent");
  assert.equal(item?.kind === "subagent" ? item.name : undefined, "Explore");
  assert.equal(item?.kind === "subagent" ? item.title : undefined, "Explore: 检查架构边界");
});

test("Desktop keeps legacy Discovery cards readable without retired controls", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationTranscript, {
      items: [
        {
          id: "discovery:legacy-1",
          kind: "discovery",
          discoveryId: "legacy-1",
          objective: "定位历史入口",
          depth: "balanced",
          phase: "verify",
          status: "interrupted",
          inspectedFiles: 4,
          evidenceCount: 2,
          openQuestions: 1,
          reason: "daemon 重启",
        },
      ],
      onOpenItem: () => undefined,
    }),
  );

  assert.match(html, /定位历史入口/u);
  assert.match(html, /查看探索详情/u);
  assert.doesNotMatch(html, /取消探索|恢复探索|探索控制/u);
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

test("Desktop transcript preserves repeated structured tool calls without signature fallback", () => {
  const events: DurableTranscriptEvent[] = [
    {
      eventId: "tool-start-1",
      sequence: 1,
      createdAt: 1,
      type: "tool.started",
      entryId: "tool-entry-1",
      toolCallId: "tool-call-1",
      providerCallId: "model-call-1",
      name: "read_file",
      args: '{"path":"README.md"}',
    },
    {
      eventId: "tool-start-2",
      sequence: 2,
      createdAt: 3,
      type: "tool.started",
      entryId: "tool-entry-2",
      toolCallId: "tool-call-2",
      providerCallId: "tool-call-2",
      name: "read_file",
      args: '{"path":"README.md"}',
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
      [],
      [
        {
          sequence: 3,
          eventId: "tool-result-1",
          envelope: toolResultEnvelope("model-call-1", "read_file", "1"),
        },
        {
          sequence: 4,
          eventId: "tool-result-2",
          envelope: toolResultEnvelope("tool-call-2", "read_file", "22"),
        },
      ],
    ),
    {},
  );

  const tools = page.items.filter((item) => item.kind === "tool");
  assert.equal(tools.length, 2);
  assert.deepEqual(
    tools.map((tool) => tool.id),
    ["tool-entry-1", "tool-entry-2"],
  );
  assert.deepEqual(
    tools.map((tool) => (tool.kind === "tool" ? tool.status : undefined)),
    ["success", "success"],
  );
  assert.deepEqual(
    tools.map((tool) => (tool.kind === "tool" ? tool.result?.projection.text : undefined)),
    ["1", "22"],
  );
});

test("Desktop transcript matches structured tools by providerCallId only", () => {
  const args = '{"path":"README.md"}';
  const events: DurableTranscriptEvent[] = [
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

test("Desktop transcript rejects Message fallback for an unmatched canonical ToolResult", () => {
  const args = '{"path":"README.md"}';
  assert.throws(
    () =>
      projectRuntimeTranscript(
        snapshot(
          [
            {
              role: "assistant",
              content: "legacy fallback must not render",
              toolCalls: [{ id: "unmatched-call", name: "read_file", arguments: args }],
            },
          ],
          [],
          [],
          [
            {
              sequence: 2,
              eventId: "unmatched-result",
              envelope: toolResultEnvelope("unmatched-call", "read_file", "result"),
            },
          ],
        ),
        {},
      ),
    /canonical ToolResult unmatched-call has no structured tool start/u,
  );
});

test("Desktop transcript binds duplicate reasoning text to the nearest structured turn", () => {
  const messages: Message[] = [
    { role: "assistant", content: "old answer", reasoning: "same" },
    { role: "user", content: "next" },
    { role: "assistant", content: "new answer", reasoning: "same" },
  ];
  const events: DurableTranscriptEvent[] = [
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

test("Desktop transcript ids stay stable when the budget window shifts（第 1 轮审查问题 2）", () => {
  const late: Message = { role: "assistant", content: "稳定回答" };
  // 窄窗口:只含尾部消息;宽窗口:多含一条更早消息。同一全账本水位(5)下,
  // 同一消息的 item id 与 revision 都不得随窗口起点漂移。
  const narrowPage = projectRuntimeTranscript(
    { ...snapshot([late]), messageSequences: [4], persistenceSequence: 5 },
    {},
  );
  const widePage = projectRuntimeTranscript(
    {
      ...snapshot([{ role: "user", content: "早期输入" }, late]),
      messageSequences: [1, 4],
      persistenceSequence: 5,
    },
    {},
  );
  const narrowItem = narrowPage.items.find((item) => item.kind === "assistantMessage");
  const wideItem = widePage.items.find((item) => item.kind === "assistantMessage");
  assert.equal(narrowItem?.id, wideItem?.id);
  assert.match(narrowItem?.id ?? "", /^item_[0-9a-f]{20}$/u);
  assert.equal(narrowPage.revision, widePage.revision);
  assert.equal(narrowPage.revision, "5");
});

test("Desktop transcript pages older and newer through one fixed watermark cursor", () => {
  const messages: Message[] = Array.from({ length: 5 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index + 1}`,
  }));
  const first = projectRuntimeTranscript(snapshot(messages), { limit: 2 });
  assert.deepEqual(
    first.items.map((item) => ("content" in item ? item.content : item.kind)),
    ["message-4", "message-5"],
  );
  assert.deepEqual(first.nextCursor, {
    revision: "5",
    throughTranscriptSequence: 5,
    position: 4,
    ordinal: 7,
    byteOffset: 0,
    direction: "older",
  });
  assert.ok(first.nextBefore, "legacy service response 必须仍可以只返回 nextBefore");

  const advancedHead = projectRuntimeTranscript(
    {
      ...snapshot([...messages, { role: "assistant", content: "message-6" }]),
      persistenceSequence: 6,
    },
    { cursor: first.nextCursor, limit: 2 },
  );
  assert.equal(advancedHead.revision, "5", "翻页期间新事件不得推进已捕获水位");
  assert.deepEqual(
    advancedHead.items.map((item) => ("content" in item ? item.content : item.kind)),
    ["message-2", "message-3"],
  );
  const legacyPage = projectRuntimeTranscript(snapshot(messages), {
    before: first.nextBefore,
    expectedRevision: "5",
    limit: 2,
  });
  assert.deepEqual(
    legacyPage.items.map((item) => ("content" in item ? item.content : item.kind)),
    ["message-2", "message-3"],
  );

  const newer = projectRuntimeTranscript(snapshot(messages), {
    cursor: {
      revision: "5",
      throughTranscriptSequence: 5,
      position: 2,
      ordinal: 3,
      byteOffset: 0,
      direction: "newer",
    },
    limit: 2,
  });
  assert.deepEqual(
    newer.items.map((item) => ("content" in item ? item.content : item.kind)),
    ["message-3", "message-4"],
  );
  assert.equal(newer.nextCursor?.direction, "newer");
  assert.equal(newer.nextCursor?.position, 4);
  assert.throws(
    () =>
      projectRuntimeTranscript(snapshot(messages), {
        cursor: {
          revision: "6",
          throughTranscriptSequence: 6,
          position: 6,
          ordinal: 0,
          byteOffset: 0,
          direction: "older",
        },
      }),
    /revision changed/u,
  );
});

test("oversized transcript item crosses UTF-8 pages and reassembles before id de-duplication", () => {
  const content = `prefix-${"😀".repeat(2_000)}-suffix`;
  const source = snapshot([{ role: "assistant", content }]);
  let page = projectRuntimeTranscript(source, { maxBytes: 1_024 });
  let state = { items: [] } as ReturnType<typeof advanceRuntimeTranscriptPagingState>;
  let pageCount = 0;
  for (;;) {
    pageCount += 1;
    state = advanceRuntimeTranscriptPagingState(state, {
      session: {} as never,
      queuedInputs: [],
      ...page,
    });
    if (!page.nextCursor) break;
    page = projectRuntimeTranscript(source, { cursor: page.nextCursor, maxBytes: 1_024 });
  }
  assert.ok(pageCount > 2);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0]?.kind, "assistantMessage");
  assert.equal(
    state.items[0]?.kind === "assistantMessage" ? state.items[0].content : undefined,
    content,
  );
});

test("newer cursor resumes an oversized item then advances to its following item", () => {
  const huge = `huge-${"😀".repeat(2_000)}`;
  const source = snapshot([
    { role: "user", content: "first" },
    { role: "assistant", content: huge },
    { role: "assistant", content: "last" },
  ]);
  let page = projectRuntimeTranscript(source, {
    cursor: {
      revision: "3",
      throughTranscriptSequence: 3,
      position: 1,
      ordinal: 1,
      byteOffset: 0,
      direction: "newer",
    },
    maxBytes: 1_024,
  });
  const parts: Array<{ readonly byteOffset: number; readonly json: string }> = [];
  for (;;) {
    parts.push(...(page.fragments ?? []));
    if (page.items.some((item) => item.kind === "assistantMessage" && item.content === "last")) {
      break;
    }
    assert.ok(page.nextCursor, "newer traversal must not stop after the large item");
    page = projectRuntimeTranscript(source, { cursor: page.nextCursor, maxBytes: 1_024 });
  }
  const reconstructed = JSON.parse(
    parts
      .toSorted((left, right) => left.byteOffset - right.byteOffset)
      .map((part) => part.json)
      .join(""),
  ) as { content?: unknown };
  assert.equal(reconstructed.content, huge);
});

test("Desktop fragment reducer rejects conflicting ranges and total byte counts", () => {
  const item = { id: "desktop-fragment", kind: "assistantMessage", content: "large answer" };
  const json = JSON.stringify(item);
  const splitAt = Math.floor(json.length / 2);
  const head = json.slice(0, splitAt);
  const tail = json.slice(splitAt);
  const headBytes = Buffer.byteLength(head, "utf8");
  const tailBytes = Buffer.byteLength(tail, "utf8");
  const totalBytes = headBytes + tailBytes;
  const parts = new Map();

  assert.deepEqual(
    assembleConversationFragments(
      [
        {
          itemId: item.id,
          byteOffset: 0,
          byteLength: headBytes,
          totalBytes,
          json: head,
        },
      ],
      parts,
    ),
    [],
  );
  assert.throws(
    () =>
      assembleConversationFragments(
        [
          {
            itemId: item.id,
            byteOffset: 0,
            byteLength: headBytes,
            totalBytes,
            json: `${head.slice(0, -1)}x`,
          },
        ],
        parts,
      ),
    /range content/u,
  );
  assert.throws(
    () =>
      assembleConversationFragments(
        [
          {
            itemId: item.id,
            byteOffset: headBytes,
            byteLength: tailBytes,
            totalBytes: totalBytes + 1,
            json: tail,
          },
        ],
        parts,
      ),
    /total bytes/u,
  );
  assert.deepEqual(
    assembleConversationFragments(
      [
        {
          itemId: item.id,
          byteOffset: headBytes,
          byteLength: tailBytes,
          totalBytes,
          json: tail,
        },
      ],
      parts,
    ),
    [item],
  );
});

function toolResultEnvelope(
  toolCallId: string,
  toolName: string,
  content: string,
): ToolResultEnvelope {
  return createToolResultEnvelope({
    toolCallId,
    toolName,
    status: "succeeded",
    body: {
      storage: "inline",
      content,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      sizeBytes: Buffer.byteLength(content, "utf8"),
    },
    projection: {
      version: 1,
      mode: "full",
      text: content,
      strategy: "desktop-transcript-test",
      truncated: false,
    },
  });
}
