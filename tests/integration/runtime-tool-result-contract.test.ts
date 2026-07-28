import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  projectRuntimeModelMessage,
  projectRuntimeToolResultMessage,
  runtimeEventHasModelHistoryEntry,
} from "../../src/engine/runtime-model-message.js";
import { materializeRuntimeHistory } from "../../src/engine/session-runtime-read-model.js";
import { projectRuntimeSessionToolResultEntries } from "../../src/engine/session-runtime-projection.js";
import { Session } from "../../src/engine/session.js";
import type {
  RuntimeEvent,
  RuntimeToolResultRecordedEvent,
} from "../../src/engine/session-runtime-event.js";
import { RuntimeEventBoundaryInspector } from "../../src/runtime/runtime-event-boundary-inspector.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import { RuntimeEventDecodeError, decodeRuntimeEvent } from "../../src/storage/runtime-event.js";

test("tool.result.recorded codec enforces inline integrity and evidence refs", () => {
  const inline = toolResultEvent({
    body: inlineBody("你好, tool"),
    projection: {
      version: 1,
      mode: "full",
      text: "你好, tool",
      strategy: "full",
      truncated: false,
    },
  });
  assert.deepEqual(decodeRuntimeEvent(inline), inline);

  for (const invalid of [
    {
      ...inline,
      data: { ...inline.data, body: { ...inline.data.body, sizeBytes: 1 } },
    },
    {
      ...inline,
      refs: {
        ...inline.refs,
        evidence: evidenceRef(),
      },
    },
  ]) {
    assert.throws(
      () => decodeRuntimeEvent(invalid),
      (error: unknown) =>
        error instanceof RuntimeEventDecodeError && error.code === "invalid_payload",
    );
  }

  const evidence = toolResultEvent({
    refs: { toolCallId: "call:evidence", evidence: evidenceRef() },
    body: {
      storage: "evidence",
      sha256: sha256("complete raw output"),
      sizeBytes: Buffer.byteLength("complete raw output"),
    },
    projection: {
      version: 1,
      mode: "preview",
      text: "bounded preview",
      strategy: "head-tail",
      truncated: true,
    },
  });
  assert.deepEqual(decodeRuntimeEvent(evidence), evidence);
  const projected = projectRuntimeModelMessage(evidence);
  assert.match(projected?.content ?? "", /bounded preview/u);
  assert.match(projected?.content ?? "", /pico:\/\/evidence\/source-session\/[a-f0-9]{64}/u);
  assert.equal(projected?.providerData?.["picoToolResultSizeBytes"], 19);
  assert.equal("content" in (projected?.providerData ?? {}), false);

  assert.throws(
    () =>
      decodeRuntimeEvent({
        ...evidence,
        refs: { toolCallId: evidence.refs.toolCallId },
      }),
    (error: unknown) =>
      error instanceof RuntimeEventDecodeError && error.code === "invalid_payload",
  );
});

test("legacy Message ToolResults are rejected instead of replayed beside structured facts", () => {
  const assistant = messageEvent("assistant", {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call:legacy", name: "legacy", arguments: "{}" }],
  });
  const legacy = messageEvent("legacy-result", {
    role: "user",
    content: "legacy output",
    toolCallId: "call:legacy",
  });
  assert.throws(
    () => decodeRuntimeEvent(legacy),
    (error: unknown) =>
      error instanceof RuntimeEventDecodeError && error.code === "invalid_payload",
  );
  assert.throws(
    () => materializeRuntimeHistory([assistant, legacy]),
    /cannot contain a ToolResult/u,
  );

  const canonicalAssistant = messageEvent("canonical-assistant", {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call:new", name: "new", arguments: "{}" }],
  });
  const structured = toolResultEvent({
    eventId: "structured-result",
    refs: { toolCallId: "call:new" },
    body: inlineBody("new output"),
    projection: {
      version: 1,
      mode: "full",
      text: "new output",
      strategy: "full",
      truncated: false,
    },
  });

  const history = materializeRuntimeHistory([canonicalAssistant, structured]);
  assert.deepEqual(
    history.map((message) => [message.toolCallId, message.content]),
    [
      [undefined, ""],
      ["call:new", "new output"],
    ],
  );
  assert.equal(runtimeEventHasModelHistoryEntry(structured), true);

  const checkpoint: RuntimeEvent = {
    ...baseEvent("checkpoint", "internal"),
    kind: "context.checkpoint.recorded",
    data: {
      checkpointId: "checkpoint",
      coveredEventCount: 2,
      sourceDigest: sha256("canonical-assistant\nstructured-result"),
      throughEventId: structured.eventId,
      summary: { role: "system", content: "compacted tool exchange" },
    },
  };
  assert.deepEqual(materializeRuntimeHistory([canonicalAssistant, structured, checkpoint]), [
    { role: "system", content: "compacted tool exchange" },
  ]);

  const rewound: RuntimeEvent = {
    ...baseEvent("rewind", "internal"),
    kind: "history.rewound",
    data: { branchId: "rewind", throughEventId: canonicalAssistant.eventId },
  };
  assert.throws(
    () => materializeRuntimeHistory([canonicalAssistant, structured, rewound]),
    /missing/u,
  );
});

test("RuntimeRun registers one structured fact and commits its projected Message in order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-result-contract-"));
  const session = new Session("tool-result-contract", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const result = run.registerToolResult({
    toolCallId: "call:registered",
    toolName: "read_file",
    status: "failed",
    body: inlineBody("permission denied"),
    projection: {
      version: 1,
      mode: "full",
      text: "permission denied",
      strategy: "full",
      truncated: false,
    },
  });
  await run.commitMessages(session, [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call:registered", name: "read_file", arguments: "{}" }],
    },
    result,
  ]);

  const events = await session.runtimeEventStore!.readRun(session.id, run.runId);
  assert.deepEqual(
    events.filter(runtimeEventHasModelHistoryEntry).map((event) => event.kind),
    ["message.committed", "tool.result.recorded"],
  );
  assert.deepEqual(session.getHistory().slice(-2), [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call:registered", name: "read_file", arguments: "{}" }],
    },
    result,
  ]);
  const hydration = await session.readHydrationSnapshot();
  assert.equal(hydration.toolResults.length, 1);
  assert.equal(hydration.toolResults[0]?.eventId, events.at(-1)?.eventId);
  assert.equal(hydration.toolResults[0]?.envelope.toolCallId, "call:registered");
  assert.equal(hydration.toolResults[0]?.envelope.toolName, "read_file");
  assert.equal(hydration.toolResults[0]?.envelope.status, "failed");
  assert.equal(
    hydration.toolResults[0]?.envelope.rawSizeBytes,
    Buffer.byteLength("permission denied"),
  );
  assert.equal(hydration.toolResults[0]?.envelope.sha256, sha256("permission denied"));
  assert.equal(hydration.toolResults[0]?.envelope.projection.text, "permission denied");
  assert.equal("body" in (hydration.toolResults[0]?.envelope ?? {}), false);
});

test("RuntimeRun rejects an unregistered Message ToolResult before appending the batch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-result-hard-cutover-"));
  const session = new Session("tool-result-hard-cutover", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });

  await assert.rejects(
    run.commitMessages(session, [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call:legacy", name: "read_file", arguments: "{}" }],
      },
      { role: "user", content: "legacy result", toolCallId: "call:legacy" },
    ]),
    /must be registered as tool\.result\.recorded/u,
  );
  assert.deepEqual(
    (await session.runtimeEventStore!.readRun(session.id, run.runId)).map((event) => event.kind),
    ["run.started"],
  );
  await run.finish("failed", "expected test rejection");
});

test("ToolResult hydration envelopes exclude facts removed from the active branch", () => {
  const removed = toolResultEvent({ eventId: "removed-result" });
  const rewind: RuntimeEvent = {
    ...baseEvent("clear-branch", "internal"),
    kind: "history.rewound",
    data: { branchId: "clear-branch" },
  };
  const active = toolResultEvent({
    eventId: "active-result",
    refs: { toolCallId: "call:active" },
  });

  const projected = projectRuntimeSessionToolResultEntries([
    { sequence: 10, event: removed },
    { sequence: 11, event: rewind },
    { sequence: 12, event: active },
  ]);
  assert.deepEqual(
    projected.map(({ sequence, eventId, envelope }) => [sequence, eventId, envelope.toolCallId]),
    [[12, "active-result", "call:active"]],
  );
});

test("durable Session disables Message-based truncate and compaction rewrites", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-history-hard-cutover-"));
  const session = new Session("runtime-history-hard-cutover", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  await session.commitMessages({ role: "user", content: "keep canonical history" });
  const before = await session.runtimeEventStore!.readSession(session.id);

  await assert.rejects(session.truncateTo(0), /does not support Session\.truncateTo/u);
  await assert.rejects(
    session.applyCompaction("summary", 1),
    /does not support Session\.applyCompaction/u,
  );
  assert.deepEqual(await session.runtimeEventStore!.readSession(session.id), before);
});

test("RuntimeRun durably records transcript ToolResult without polluting model history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-transcript-tool-result-"));
  const session = new Session("transcript-tool-result", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await run.recordToolStarted("call:subagent", "grep", '{"pattern":"needle"}');
  const result = await run.recordTranscriptToolResult({
    toolCallId: "call:subagent",
    toolName: "grep",
    status: "succeeded",
    body: inlineBody("one match"),
    projection: {
      version: 1,
      mode: "full",
      text: "one match",
      strategy: "original",
      truncated: false,
    },
  });
  await run.finish("completed");

  const events = await session.runtimeEventStore!.readRun(session.id, run.runId);
  const recorded = events.find(
    (event): event is RuntimeToolResultRecordedEvent =>
      event.kind === "tool.result.recorded" && event.refs.toolCallId === "call:subagent",
  );
  assert.ok(recorded);
  assert.equal(recorded.visibility, "transcript");
  assert.deepEqual(projectRuntimeToolResultMessage(recorded), result);
  assert.equal(projectRuntimeModelMessage(recorded), undefined);
  assert.equal(runtimeEventHasModelHistoryEntry(recorded), false);
  assert.deepEqual(materializeRuntimeHistory(events), []);
  assert.deepEqual(session.getHistory(), []);

  const boundary = await new RuntimeEventBoundaryInspector({
    store: session.runtimeEventStore!,
    backgroundOperationsSettled: () => true,
  }).inspect({
    sessionId: session.id,
    runId: run.runId,
    eventHighWater: events.length,
  });
  assert.equal(boundary.status, "available");
  if (boundary.status !== "available") assert.fail("Runtime boundary should be available");
  assert.deepEqual(boundary.pendingToolCallIds, []);
});

function toolResultEvent(
  overrides: Partial<RuntimeToolResultRecordedEvent> & {
    readonly body?: RuntimeToolResultRecordedEvent["data"]["body"];
    readonly projection?: RuntimeToolResultRecordedEvent["data"]["projection"];
  } = {},
): RuntimeToolResultRecordedEvent {
  const body = overrides.body ?? inlineBody("output");
  const projection =
    overrides.projection ??
    ({
      version: 1,
      mode: "full",
      text: body.storage === "inline" ? body.content : "preview",
      strategy: "full",
      truncated: false,
    } as const);
  return {
    ...baseEvent(overrides.eventId ?? "tool-result"),
    refs: overrides.refs ?? { toolCallId: "call:tool" },
    kind: "tool.result.recorded",
    data: {
      toolName: "tool",
      status: "succeeded",
      body,
      projection,
    },
  };
}

function messageEvent(
  eventId: string,
  message: Extract<RuntimeEvent, { kind: "message.committed" }>["data"]["message"],
): Extract<RuntimeEvent, { kind: "message.committed" }> {
  return {
    ...baseEvent(eventId),
    kind: "message.committed",
    data: { message },
  };
}

function baseEvent(
  eventId: string,
  visibility: RuntimeEvent["visibility"] = "model",
): Omit<RuntimeEvent, "kind" | "data"> {
  return {
    schemaVersion: 1,
    eventId,
    sessionId: "session",
    invocationId: "invocation",
    runId: "run",
    turnId: "turn",
    at: "2026-01-01T00:00:00.000Z",
    partial: false,
    visibility,
  };
}

function inlineBody(
  content: string,
): Extract<RuntimeToolResultRecordedEvent["data"]["body"], { storage: "inline" }> {
  return {
    storage: "inline",
    content,
    sha256: sha256(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

function evidenceRef() {
  return {
    schemaVersion: 1 as const,
    contentHash: sha256("manifest"),
    sessionId: "source-session",
    kind: "tool-exchange" as const,
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
