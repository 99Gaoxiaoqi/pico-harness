import assert from "node:assert/strict";
import test from "node:test";
import { TuiEventStore } from "../../src/tui/tui-event-store.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";
import { hydrateTuiEntries, hydrateTuiReporter } from "../../src/tui/session-hydration.js";
import type { SessionHydrationSnapshot } from "../../src/engine/session-runtime.js";
import type { TranscriptEvent } from "../../src/presentation/transcript-event-store.js";
import type { Session } from "../../src/engine/session.js";
import { applyTuiRewind } from "../../src/tui/rewind-runtime.js";

test("TUI durable transcript drops deltas but restores final reasoning and answer", async () => {
  const persisted: TranscriptEvent[] = [];
  const reporter = new TuiReporter(() => undefined, [], {
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
  const reasoningReporter = new TuiReporter(() => undefined, [], {
    durableTranscriptSink: { append: async (event) => void persisted.push(event) },
  });

  reasoningReporter.onReasoningDelta("分析");
  reasoningReporter.onReasoningDelta("完成");
  reasoningReporter.onInterrupted();
  await reasoningReporter.flushDurableTranscript();

  const assistantReporter = new TuiReporter(() => undefined, [], {
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

test("legacy messages hydration preserves provider reasoning when structured events are absent", () => {
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
    runtime: { stateVersion: 1, usage: {} },
  } as unknown as SessionHydrationSnapshot;

  assert.deepEqual(
    hydrateTuiEntries(snapshot).map((entry) => ({
      kind: entry.kind,
      content: "content" in entry ? entry.content : undefined,
    })),
    [
      { kind: "thinking", content: "分析中" },
      { kind: "assistant", content: "答案" },
    ],
  );
});

test("legacy hydration does not migrate display-only messages into durable transcript", async () => {
  const persisted: TranscriptEvent[] = [];
  const reporter = new TuiReporter(() => undefined, [], {
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
    runtime: { stateVersion: 1, usage: {} },
  } as unknown as SessionHydrationSnapshot;

  hydrateTuiReporter(reporter, snapshot);
  await reporter.flushDurableTranscript();
  assert.deepEqual(persisted, []);
});

test("structured transcript hydration keeps stable IDs and ignores message fallback", () => {
  const source = new TuiReporter(() => undefined);
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
    runtime: { stateVersion: 1, usage: {} },
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

test("mixed legacy and structured hydration keeps the legacy prefix after new durable turns", () => {
  const source = new TuiReporter(() => undefined);
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
    runtime: { stateVersion: 1, usage: {} },
  } as unknown as SessionHydrationSnapshot;

  const first = hydrateTuiEntries(snapshot);
  const second = hydrateTuiEntries(snapshot);
  assert.deepEqual(first.map(summarizeEntry), [
    {
      kind: "thinking",
      content: "legacy reasoning",
      uiEntryId: "legacy:mixed:message:1:thinking:0",
    },
    {
      kind: "assistant",
      content: "legacy answer",
      uiEntryId: "legacy:mixed:message:1:assistant:0",
    },
    ...source
      .getProjection()
      .entries.map(({ entry, id }) => summarizeEntry({ ...entry, uiEntryId: id })),
  ]);
  assert.deepEqual(second, first);
});

test("UI-only transcript clear is not persisted as a durable session fact", async () => {
  const persisted: TranscriptEvent[] = [];
  const reporter = new TuiReporter(() => undefined, [], {
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
  const durable = new TuiReporter(() => undefined);
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
    runtime: { stateVersion: 1, usage: {} },
  } as unknown as SessionHydrationSnapshot;
  const reporter = new TuiReporter(() => undefined);
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
