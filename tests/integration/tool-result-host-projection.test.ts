import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvidenceArchive } from "../../src/context/evidence-archive.js";
import { DesktopReporter } from "../../src/daemon/desktop-reporter.js";
import type { SessionHydrationSnapshot } from "../../src/engine/session-runtime.js";
import {
  createToolResultEnvelope,
  type ToolResultEnvelope,
} from "../../src/engine/tool-result-contract.js";
import { createCanonicalTranscriptToolStart } from "../../src/engine/transcript-tool-start.js";
import { Session } from "../../src/engine/session.js";
import type { DurableTranscriptEvent } from "../../src/presentation/transcript-event-store.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import {
  createEvidenceInspectorContext,
  createToolInspectorSource,
  readInspectorPage,
} from "../../src/tui/inspector.js";
import { hydrateTuiEntries, hydrateTuiReporter } from "../../src/tui/session-hydration.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";

test("TUI derives completion from the canonical envelope without persisting a duplicate fact", async () => {
  const events: DurableTranscriptEvent[] = [];
  const reporter = new TuiReporter({
    durableTranscriptSink: { append: async (event) => void events.push(event) },
  });
  reporter.onToolCall("read_file", "{}", "call-inline");
  const envelope = inlineEnvelope("call-inline", "read_file", "hello");
  reporter.onToolResult(envelope);
  await reporter.flushDurableTranscript();

  const tool = Object.values(reporter.getProjection().toolCalls)[0];
  assert.ok(tool);
  assert.equal(tool.resultAvailability, "inline");
  assert.deepEqual(tool.resultEnvelope, envelope);
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool.started"],
  );

  reporter.onToolCall("read_file", "{}", "call-bounded");
  const bounded = inlineEnvelope("call-bounded", "read_file", "x".repeat(20 * 1024));
  assert.equal(bounded.deliveryTruncated, true);
  reporter.onToolResult(bounded);
  const boundedTool = Object.values(reporter.getProjection().toolCalls).find(
    (candidate) => candidate.providerCallId === "call-bounded",
  );
  assert.equal(boundedTool?.resultAvailability, "unavailable");

  reporter.onToolCall("bash", "{}", "call-rejected");
  reporter.onToolResult(inlineEnvelope("call-rejected", "bash", "looks successful", "rejected"));
  const rejectedTool = Object.values(reporter.getProjection().toolCalls).find(
    (candidate) => candidate.providerCallId === "call-rejected",
  );
  assert.equal(rejectedTool?.status, "denied");
});

test("TUI projects a Runtime-owned tool start without persisting it twice", async () => {
  const events: DurableTranscriptEvent[] = [];
  const reporter = new TuiReporter({
    durableTranscriptSink: { append: async (event) => void events.push(event) },
  });
  const start = createCanonicalTranscriptToolStart({
    sessionId: "session-runtime-start",
    runId: "run-runtime-start",
    turnId: "turn-runtime-start",
    callIndex: 0,
    toolCall: { id: "call-runtime-start", name: "read_file", arguments: "{}" },
    sequence: 7,
    createdAt: 1,
  });

  reporter.onToolCall("read_file", "{}", "call-runtime-start", start);
  await reporter.flushDurableTranscript();

  assert.deepEqual(events, []);
  const tool = reporter.getProjection().toolCalls[start.toolCallId];
  assert.ok(tool);
  assert.equal(tool.entryId, start.entryId);
  assert.equal(tool.providerCallId, start.providerCallId);
});

test("TUI Inspector pages canonical Evidence retained from a fork source Session", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-result-inspector-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const archive = new EvidenceArchive({ baseDir: root });
  const raw = "第一行\nsecond line\n";
  const reference = await archive.archiveRuntimeToolResult({
    sessionId: "session-a",
    toolCallId: "call-evidence",
    toolName: "bash",
    rawArguments: "{}",
    rawOutput: raw,
    isError: false,
  });
  const envelope = createToolResultEnvelope({
    toolCallId: "call-evidence",
    toolName: "bash",
    status: "succeeded",
    body: {
      storage: "evidence",
      sha256: sha256(raw),
      sizeBytes: Buffer.byteLength(raw, "utf8"),
    },
    projection: {
      version: 1,
      mode: "preview",
      text: "第一行",
      strategy: "test-preview",
      truncated: true,
    },
    evidence: reference,
  });
  const reporter = new TuiReporter();
  reporter.onToolCall("bash", "{}", "call-evidence");
  reporter.onToolResult(envelope);
  const tool = Object.values(reporter.getProjection().toolCalls)[0];
  assert.ok(tool);
  assert.equal(tool.resultAvailability, "evidence");

  const contextA = createEvidenceInspectorContext({
    workDir: "/unused",
    sessionId: "session-a",
    evidenceBaseDir: root,
  });
  const source = createToolInspectorSource(tool, contextA);
  assert.equal(source?.kind, "evidence");
  assert.equal((await readInspectorPage(source!, { limitBytes: 256 })).content, raw);

  const forkSource = createToolInspectorSource(
    tool,
    createEvidenceInspectorContext({
      workDir: "/unused",
      sessionId: "session-b",
      evidenceBaseDir: root,
    }),
  );
  assert.equal(forkSource?.kind, "evidence");
  assert.equal((await readInspectorPage(forkSource!, { limitBytes: 256 })).content, raw);
});

test("Desktop Reporter forwards raw size, hash and Evidence metadata from one envelope", () => {
  const published: Array<Readonly<Record<string, unknown>>> = [];
  const reporter = new DesktopReporter({
    runId: "run-1",
    sessionId: "session-1",
    publish: (event) => published.push(event.payload),
  });
  const envelope = inlineEnvelope("call-1", "read_file", "完整正文");
  reporter.onToolResult(envelope);

  assert.deepEqual(published, [{ result: envelope }]);
  assert.equal(
    (
      published[0]?.["result"] as
        | {
            readonly rawSizeBytes?: number;
          }
        | undefined
    )?.rawSizeBytes,
    Buffer.byteLength("完整正文", "utf8"),
  );
});

test("TUI hydration completes a pending tool from canonical Runtime ToolResult data", () => {
  const source = new TuiReporter();
  source.onToolCall("read_file", "{}", "call-hydrated");
  const events = source.getEvents();
  const envelope = inlineEnvelope("call-hydrated", "read_file", "hydrated body");
  const snapshot = {
    schemaVersion: 1,
    persistenceSequence: 20,
    sessionId: "session-hydrated",
    conversationId: "session-hydrated",
    workDir: "/tmp",
    identity: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(1).toISOString(),
    messages: [],
    messageSequences: [],
    transcriptEvents: events,
    transcriptEventSequences: events.map((_, index) => index + 10),
    toolResults: [{ sequence: 20, eventId: "runtime-result-1", envelope }],
    runtime: { stateVersion: 2, usage: {} },
  } as unknown as SessionHydrationSnapshot;
  const hydrated = new TuiReporter();
  hydrateTuiReporter(hydrated, snapshot);

  const tool = Object.values(hydrated.getProjection().toolCalls)[0];
  assert.equal(tool?.status, "success");
  assert.equal(tool?.resultAvailability, "inline");
  assert.deepEqual(tool?.resultEnvelope, envelope);
});

test("persistent host hydration restores model-visible ToolResults after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-result-host-restart-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const sessionId = "tool-result-host-restart";
  let session = new Session(sessionId, workDir, { persistence: true, picoHome });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });

  await session.recover();
  await session.recordTranscriptEvent({
    eventId: "main-tool-start",
    sequence: 1,
    createdAt: 1,
    type: "tool.started",
    entryId: "main-tool-entry",
    toolCallId: "call:main-restart",
    providerCallId: "call:main-restart",
    name: "grep",
    args: '{"pattern":"needle"}',
  });
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await run.recordToolStarted("call:main-restart", "grep", '{"pattern":"needle"}');
  const result = run.registerToolResult({
    toolCallId: "call:main-restart",
    toolName: "grep",
    status: "succeeded",
    body: {
      storage: "inline",
      content: "one match",
      sha256: sha256("one match"),
      sizeBytes: Buffer.byteLength("one match", "utf8"),
    },
    projection: {
      version: 1,
      mode: "full",
      text: "one match",
      strategy: "host-restart-test",
      truncated: false,
    },
  });
  await run.commitMessages(session, [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call:main-restart", name: "grep", arguments: '{"pattern":"needle"}' }],
    },
    result,
  ]);
  await run.finish("completed");
  await session.close();

  session = new Session(sessionId, workDir, { persistence: true, picoHome });
  await session.recover();
  const snapshot = await session.readHydrationSnapshot();
  assert.equal(snapshot.toolResults.length, 1);
  const entry = hydrateTuiEntries(snapshot).find((candidate) => candidate.kind === "tool");
  assert.equal(entry?.kind, "tool");
  assert.equal(entry?.status, "success");
  const reporter = new TuiReporter();
  hydrateTuiReporter(reporter, snapshot);
  const tool = Object.values(reporter.getProjection().toolCalls)[0];
  assert.equal(tool?.status, "success");
  assert.equal(tool?.resultEnvelope?.projection.text, "one match");
});

test("transcript-only ToolResults without durable trace do not pollute host hydration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-result-transcript-only-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const sessionId = "tool-result-transcript-only";
  let session = new Session(sessionId, workDir, { persistence: true, picoHome });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });

  await session.recover();
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await run.recordToolStarted("call:subagent", "grep", '{"pattern":"needle"}');
  await run.recordTranscriptToolResults([
    {
      toolCallId: "call:subagent",
      toolName: "grep",
      status: "succeeded",
      body: {
        storage: "inline",
        content: "internal result",
        sha256: sha256("internal result"),
        sizeBytes: Buffer.byteLength("internal result", "utf8"),
      },
      projection: {
        version: 1,
        mode: "full",
        text: "internal result",
        strategy: "transcript-only-test",
        truncated: false,
      },
    },
  ]);
  await run.finish("completed");
  await session.close();

  session = new Session(sessionId, workDir, { persistence: true, picoHome });
  await session.recover();
  const snapshot = await session.readHydrationSnapshot();
  assert.deepEqual(snapshot.toolResults, []);
  assert.deepEqual(hydrateTuiEntries(snapshot), []);
});

function inlineEnvelope(
  toolCallId: string,
  toolName: string,
  content: string,
  status: ToolResultEnvelope["status"] = "succeeded",
): ToolResultEnvelope {
  return createToolResultEnvelope({
    toolCallId,
    toolName,
    status,
    body: {
      storage: "inline",
      content,
      sha256: sha256(content),
      sizeBytes: Buffer.byteLength(content, "utf8"),
    },
    projection: {
      version: 1,
      mode: "full",
      text: content,
      strategy: "host-projection-test",
      truncated: false,
    },
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
