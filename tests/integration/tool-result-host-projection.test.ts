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
import type { TranscriptEvent } from "../../src/presentation/transcript-event-store.js";
import {
  createEvidenceInspectorContext,
  createEvidenceInspectorSource,
  createToolInspectorSource,
  readInspectorPage,
} from "../../src/tui/inspector.js";
import { hydrateTuiReporter } from "../../src/tui/session-hydration.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";

test("TUI completion persists the canonical envelope and derives availability without parsing text", async () => {
  const events: TranscriptEvent[] = [];
  const reporter = new TuiReporter(() => undefined, [], {
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
  const completion = events.find(
    (event): event is Extract<TranscriptEvent, { type: "tool.completed" }> =>
      event.type === "tool.completed",
  );
  assert.ok(completion);
  assert.deepEqual(completion.result, envelope);

  reporter.onToolCall("read_file", "{}", "call-bounded");
  const bounded = inlineEnvelope("call-bounded", "read_file", "x".repeat(20 * 1024));
  assert.equal(bounded.deliveryTruncated, true);
  reporter.onToolResult(bounded);
  const boundedTool = Object.values(reporter.getProjection().toolCalls).find(
    (candidate) => candidate.providerCallId === "call-bounded",
  );
  assert.equal(boundedTool?.resultAvailability, "unavailable");
});

test("TUI Inspector pages Evidence only inside the current Session boundary", async (context) => {
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
  const reporter = new TuiReporter(() => undefined);
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

  assert.equal(
    createEvidenceInspectorSource({
      title: "cross-session",
      uri: envelope.evidence!.uri,
      ref: envelope.evidence!.ref,
      context: createEvidenceInspectorContext({
        workDir: "/unused",
        sessionId: "session-b",
        evidenceBaseDir: root,
      }),
    }),
    undefined,
  );
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
  const source = new TuiReporter(() => undefined);
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
    runtime: { stateVersion: 1, usage: {} },
  } as unknown as SessionHydrationSnapshot;
  const hydrated = new TuiReporter(() => undefined);
  hydrateTuiReporter(hydrated, snapshot);

  const tool = Object.values(hydrated.getProjection().toolCalls)[0];
  assert.equal(tool?.status, "success");
  assert.equal(tool?.resultAvailability, "inline");
  assert.deepEqual(tool?.resultEnvelope, envelope);
});

function inlineEnvelope(toolCallId: string, toolName: string, content: string): ToolResultEnvelope {
  return createToolResultEnvelope({
    toolCallId,
    toolName,
    status: "succeeded",
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
