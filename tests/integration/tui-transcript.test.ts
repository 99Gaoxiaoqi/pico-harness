import assert from "node:assert/strict";
import test from "node:test";
import {
  TranscriptEventStore as TuiEventStore,
  assertTranscriptEvent,
} from "../../src/presentation/transcript-event-store.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";
import { hydrateTuiEntries, hydrateTuiReporter } from "../../src/tui/session-hydration.js";
import type { SessionHydrationSnapshot } from "../../src/engine/session-runtime.js";
import type { TranscriptEvent } from "../../src/presentation/transcript-event-store.js";
import type { Session } from "../../src/engine/session.js";
import { applyTuiRewind } from "../../src/tui/rewind-runtime.js";

test("Transcript hard cut rejects legacy event shapes", () => {
  const base = { eventId: "legacy", sequence: 1, createdAt: 0 };
  const legacyEvents: unknown[] = [
    {
      ...base,
      type: "assistant.stream.started",
      entryId: "entry",
      streamId: "stream",
      delta: "text",
    },
    {
      ...base,
      type: "tool.output",
      toolCallId: "tool",
      stream: "stdout",
      chunk: "text",
    },
    {
      ...base,
      type: "entry.appended",
      entryId: "entry",
      entry: { kind: "tool", name: "read_file", args: "{}", status: "done" },
    },
    {
      ...base,
      type: "transcript.truncated",
      entryCount: 0,
    },
    {
      ...base,
      type: "entry.appended",
      entryId: "entry",
      entry: { kind: "legacy-message", content: "old" },
    },
    {
      ...base,
      type: "entry.appended",
      entryId: "entry",
      entry: { kind: "assistant", content: 42 },
    },
    {
      ...base,
      type: "subagent.activity.updated",
      entryId: "entry",
      activityId: "activity",
      activity: {
        task: "audit",
        status: "completed",
        mode: "explore",
        completionPolicy: "required",
        legacy: true,
      },
    },
  ];

  for (const event of legacyEvents) {
    assert.throws(() => assertTranscriptEvent(event));
  }
});

test("TUI durable transcript drops deltas but restores final reasoning and answer", async () => {
  const persisted: TranscriptEvent[] = [];
  const reporter = new TuiReporter({
    durableTranscriptSink: {
      append: async (event) => {
        persisted.push(event);
      },
    },
  });

  reporter.pushUserMessage("你好");
  reporter.onThinking();
  reporter.onReasoningDelta("分析中");
  reporter.onReasoningDelta("…");
  reporter.onTextDelta("答");
  reporter.onTextDelta("案");
  reporter.onMessage("答案");
  reporter.onFinish();
  await reporter.flushDurableTranscript();

  assert.equal(
    persisted.some((event) => event.type === "assistant.stream.delta"),
    false,
  );
  assert.deepEqual(
    persisted
      .filter((event) => event.type === "assistant.stream.completed")
      .map((event) => event.content),
    ["分析中…", "答案"],
  );
  assert.deepEqual(
    new TuiEventStore({ initialEvents: persisted })
      .getProjection()
      .entries.map(({ entry }) => entry),
    [
      { kind: "user", content: "你好" },
      { kind: "thinking", content: "分析中…" },
      { kind: "assistant", content: "答案" },
    ],
  );
});

test("interrupted durable streams restore the complete live assistant and reasoning text", async () => {
  const persisted: TranscriptEvent[] = [];
  const reasoningReporter = new TuiReporter({
    durableTranscriptSink: { append: async (event) => void persisted.push(event) },
  });

  reasoningReporter.onReasoningDelta("分析");
  reasoningReporter.onReasoningDelta("完成");
  reasoningReporter.onInterrupted();
  await reasoningReporter.flushDurableTranscript();

  const assistantReporter = new TuiReporter({
    durableTranscriptSink: { append: async (event) => void persisted.push(event) },
    durableTranscriptSequence: persisted.at(-1)?.sequence ?? 0,
  });
  assistantReporter.onTextDelta("答");
  assistantReporter.onTextDelta("案");
  assistantReporter.onInterrupted();
  await assistantReporter.flushDurableTranscript();

  assert.deepEqual(
    new TuiEventStore({ initialEvents: persisted })
      .getProjection()
      .entries.map(({ entry }) => entry),
    [
      { kind: "thinking", content: "分析完成" },
      { kind: "assistant", content: "答案" },
    ],
  );
  assert.deepEqual(
    persisted
      .filter((event) => event.type === "assistant.stream.interrupted")
      .map((event) => event.content),
    ["分析完成", "答案"],
  );
});

test("TUI rejects snapshots without canonical ToolResult hydration data", () => {
  const snapshot = {
    schemaVersion: 1,
    persistenceSequence: null,
    sessionId: "s",
    conversationId: "s",
    workDir: "/tmp",
    identity: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messages: [{ role: "assistant", content: "答案", reasoning: "分析中" }],
    messageSequences: [1],
    transcriptEvents: [],
    transcriptEventSequences: [],
    runtime: { stateVersion: 2, usage: {} },
  } as unknown as SessionHydrationSnapshot;

  assert.throws(
    () => hydrateTuiEntries(snapshot),
    /does not contain canonical ToolResult hydration data/u,
  );
});

test("TUI rejects a canonical ToolResult without a structured tool start", () => {
  const snapshot = {
    schemaVersion: 1,
    persistenceSequence: 1,
    sessionId: "orphan-tool-result",
    conversationId: "orphan-tool-result",
    workDir: "/tmp",
    identity: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messages: [],
    messageSequences: [],
    transcriptEvents: [],
    transcriptEventSequences: [],
    toolResults: [
      {
        sequence: 1,
        eventId: "orphan-result",
        envelope: {
          version: 1,
          toolCallId: "call:orphan",
          toolName: "read_file",
          status: "succeeded",
          rawSizeBytes: 2,
          sha256: "a".repeat(64),
          projection: {
            version: 1,
            mode: "full",
            text: "ok",
            strategy: "test",
            truncated: false,
          },
          deliveryTruncated: false,
        },
      },
    ],
    runtime: { stateVersion: 2, usage: {} },
  } as unknown as SessionHydrationSnapshot;

  assert.throws(
    () => hydrateTuiEntries(snapshot),
    /canonical ToolResult call:orphan has no structured tool start/u,
  );
});

test("reused provider call IDs keep FIFO result pairing when transcript persistence lags", () => {
  const transcriptEvents = [
    {
      eventId: "start:first",
      sequence: 1,
      createdAt: 10,
      type: "tool.started",
      entryId: "entry:first",
      toolCallId: "ui-tool:first",
      providerCallId: "provider-call:reused",
      name: "read_file",
      args: '{"path":"first"}',
    },
    {
      eventId: "start:second",
      sequence: 2,
      createdAt: 11,
      type: "tool.started",
      entryId: "entry:second",
      toolCallId: "ui-tool:second",
      providerCallId: "provider-call:reused",
      name: "read_file",
      args: '{"path":"second"}',
    },
  ] as const;
  const snapshot = {
    schemaVersion: 1,
    persistenceSequence: 11,
    sessionId: "reused-provider-call",
    conversationId: "reused-provider-call",
    workDir: "/tmp",
    identity: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messages: [],
    messageSequences: [],
    transcriptEvents,
    transcriptEventSequences: [10, 30],
    toolResults: ["first result", "second result"].map((text, index) => ({
      sequence: index === 0 ? 5 : 20,
      eventId: `result:${index + 1}`,
      envelope: {
        version: 1 as const,
        toolCallId: "provider-call:reused",
        toolName: "read_file",
        status: "succeeded" as const,
        rawSizeBytes: text.length,
        sha256: String(index + 1).repeat(64),
        projection: {
          version: 1 as const,
          mode: "full" as const,
          text,
          strategy: "test",
          truncated: false,
        },
        deliveryTruncated: false,
      },
    })),
    runtime: { stateVersion: 2, usage: {} },
  } as unknown as SessionHydrationSnapshot;

  assert.deepEqual(
    hydrateTuiEntries(snapshot)
      .filter((entry) => entry.kind === "tool")
      .map((entry) => entry.summary),
    ["12 字节 · first result", "13 字节 · second result"],
  );
});

test("rewind removes obsolete tool starts before reused provider call IDs are paired", () => {
  const snapshot = {
    schemaVersion: 1,
    persistenceSequence: 4,
    sessionId: "rewound-provider-call",
    conversationId: "rewound-provider-call",
    workDir: "/tmp",
    identity: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messages: [],
    messageSequences: [],
    transcriptEvents: [
      {
        eventId: "start:old",
        sequence: 1,
        createdAt: 1,
        type: "tool.started",
        entryId: "entry:old",
        toolCallId: "ui-tool:old",
        providerCallId: "provider-call:reused",
        name: "read_file",
        args: '{"path":"old"}',
      },
      {
        eventId: "truncate:old",
        sequence: 2,
        createdAt: 2,
        type: "transcript.truncated",
        entryCount: 0,
        operationId: "rewind:old",
      },
      {
        eventId: "start:new",
        sequence: 3,
        createdAt: 3,
        type: "tool.started",
        entryId: "entry:new",
        toolCallId: "ui-tool:new",
        providerCallId: "provider-call:reused",
        name: "read_file",
        args: '{"path":"new"}',
      },
    ],
    transcriptEventSequences: [1, 2, 3],
    toolResults: [
      {
        sequence: 4,
        eventId: "result:new",
        envelope: {
          version: 1,
          toolCallId: "provider-call:reused",
          toolName: "read_file",
          status: "succeeded",
          rawSizeBytes: 10,
          sha256: "a".repeat(64),
          projection: {
            version: 1,
            mode: "full",
            text: "new result",
            strategy: "test",
            truncated: false,
          },
          deliveryTruncated: false,
        },
      },
    ],
    runtime: { stateVersion: 2, usage: {} },
  } as unknown as SessionHydrationSnapshot;

  const tools = hydrateTuiEntries(snapshot).filter((entry) => entry.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.uiToolCallId, "ui-tool:new");
  assert.equal(tools[0]?.status, "success");
  assert.match(tools[0]?.summary ?? "", /new result/u);
});

test("incompatible hydration does not migrate display-only messages", async () => {
  const persisted: TranscriptEvent[] = [];
  const reporter = new TuiReporter({
    durableTranscriptSink: { append: async (event) => void persisted.push(event) },
  });
  const snapshot = {
    schemaVersion: 1,
    persistenceSequence: null,
    sessionId: "s",
    conversationId: "s",
    workDir: "/tmp",
    identity: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messages: [{ role: "assistant", content: "legacy" }],
    messageSequences: [1],
    transcriptEvents: [],
    transcriptEventSequences: [],
    runtime: { stateVersion: 2, usage: {} },
  } as unknown as SessionHydrationSnapshot;

  assert.throws(
    () => hydrateTuiReporter(reporter, snapshot),
    /does not contain canonical ToolResult hydration data/u,
  );
  await reporter.flushDurableTranscript();
  assert.deepEqual(persisted, []);
});

test("structured transcript hydration keeps stable IDs and ignores message fallback", () => {
  const source = new TuiReporter();
  source.pushUserMessage("durable user");
  source.onThinking();
  source.onReasoningDelta("durable reasoning");
  source.onMessage("durable answer");
  source.onFinish();

  const sourceEntries = source.getProjection().entries;
  const snapshot = {
    schemaVersion: 1,
    persistenceSequence: source.getEvents().at(-1)?.sequence ?? null,
    sessionId: "s",
    conversationId: "s",
    workDir: "/tmp",
    identity: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messages: [{ role: "assistant", content: "message fallback must be ignored" }],
    messageSequences: [1],
    transcriptEvents: source.getEvents(),
    transcriptEventSequences: source.getEvents().map((event) => event.sequence),
    toolResults: [],
    runtime: { stateVersion: 2, usage: {} },
  } as unknown as SessionHydrationSnapshot;

  const hydrated = hydrateTuiEntries(snapshot);
  assert.deepEqual(
    hydrated.map(summarizeEntry),
    sourceEntries.map(({ entry, id }) => summarizeEntry({ ...entry, uiEntryId: id })),
  );
  assert.equal(
    hydrated.some((entry) => summarizeEntry(entry).content?.includes("fallback") === true),
    false,
  );
});

test("structured hydration never synthesizes a legacy Message prefix", () => {
  const source = new TuiReporter();
  source.pushUserMessage("new user");
  source.onReasoningDelta("new reasoning");
  source.onMessage("new answer");
  source.onFinish();
  const structured = source.getEvents();
  const snapshot = {
    schemaVersion: 1,
    persistenceSequence: 30,
    sessionId: "mixed",
    conversationId: "mixed",
    workDir: "/tmp",
    identity: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messages: [
      { role: "assistant", content: "legacy answer", reasoning: "legacy reasoning" },
      { role: "user", content: "new user" },
      { role: "assistant", content: "new answer", reasoning: "new reasoning" },
    ],
    messageSequences: [1, 20, 30],
    transcriptEvents: structured,
    transcriptEventSequences: structured.map((_, index) => 10 + index),
    toolResults: [],
    runtime: { stateVersion: 2, usage: {} },
  } as unknown as SessionHydrationSnapshot;

  const first = hydrateTuiEntries(snapshot);
  const second = hydrateTuiEntries(snapshot);
  assert.deepEqual(
    first.map(summarizeEntry),
    source
      .getProjection()
      .entries.map(({ entry, id }) => summarizeEntry({ ...entry, uiEntryId: id })),
  );
  assert.deepEqual(second, first);
});

test("UI-only transcript clear is not persisted as a durable session fact", async () => {
  const persisted: TranscriptEvent[] = [];
  const reporter = new TuiReporter({
    durableTranscriptSink: {
      append: async (event) => {
        persisted.push(event);
      },
    },
  });

  reporter.pushUserMessage("kept in Session history");
  reporter.clear();
  await reporter.flushDurableTranscript();

  assert.equal(
    persisted.some((event) => event.type === "transcript.cleared"),
    false,
  );
});

test("rewind after a local clear rehydrates the durable transcript branch", async () => {
  const durable = new TuiReporter();
  durable.pushUserMessage("durable old user");
  const hydration = {
    schemaVersion: 1,
    persistenceSequence: 1,
    sessionId: "rewind-after-clear",
    conversationId: "rewind-after-clear",
    workDir: "/tmp",
    identity: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messages: [{ role: "user", content: "durable old user" }],
    messageSequences: [1],
    transcriptEvents: durable.getEvents(),
    transcriptEventSequences: durable.getEvents().map((event) => event.sequence),
    toolResults: [],
    runtime: { stateVersion: 2, usage: {} },
  } as unknown as SessionHydrationSnapshot;
  const reporter = new TuiReporter();
  hydrateTuiReporter(reporter, hydration);
  reporter.clear();
  reporter.pushUserMessage("local post-clear user");
  const fakeSession = {
    rewindConversation: async () => undefined,
    readHydrationSnapshot: async () => hydration,
  } as unknown as Session;

  await applyTuiRewind({
    session: fakeSession,
    reporter,
    snapshot: {
      messageId: "rewind-point",
      userPrompt: "original prompt",
      messageIndex: 1,
      transcriptIndex: 1,
      timestamp: new Date(0).toISOString(),
      trackedFileCount: 0,
      backedUpFileCount: 0,
      deletedFileCount: 0,
    },
    mode: "conversation",
  });

  assert.deepEqual(
    reporter
      .getProjection()
      .entries.map(({ entry }) => entry)
      .slice(0, 1),
    [{ kind: "user", content: "durable old user" }],
  );
  assert.equal(
    reporter
      .getProjection()
      .entries.some(
        ({ entry }) => entry.kind === "user" && entry.content === "local post-clear user",
      ),
    false,
  );
});

function summarizeEntry(entry: { kind: string; uiEntryId?: string; content?: string }) {
  return { kind: entry.kind, content: entry.content, uiEntryId: entry.uiEntryId };
}
