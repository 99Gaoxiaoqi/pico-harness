import assert from "node:assert/strict";
import test from "node:test";
import { TuiEventStore } from "../../src/tui/tui-event-store.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";
import { hydrateTuiEntries, hydrateTuiReporter } from "../../src/tui/session-hydration.js";
import type { SessionHydrationSnapshot } from "../../src/engine/session-runtime.js";
import type { TranscriptEvent } from "../../src/presentation/transcript-event-store.js";

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

  assert.deepEqual(hydrateTuiEntries(snapshot), [
    { kind: "thinking", content: "分析中" },
    { kind: "assistant", content: "答案" },
  ]);
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

function summarizeEntry(entry: { kind: string; uiEntryId?: string; content?: string }) {
  return { kind: entry.kind, content: entry.content, uiEntryId: entry.uiEntryId };
}
