import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FullCompactor } from "../../src/context/full-compactor.js";
import { recordRuntimeCompactionCheckpoint } from "../../src/context/runtime-compaction-checkpoint.js";
import {
  projectRuntimeModelMessage,
  projectRuntimeToolResultMessage,
  runtimeEventHasModelHistoryEntry,
} from "../../src/engine/runtime-model-message.js";
import { materializeRuntimeHistory } from "../../src/engine/session-runtime-read-model.js";
import { Session } from "../../src/engine/session.js";
import { createToolResultEnvelope } from "../../src/engine/tool-result-contract.js";
import type {
  RuntimeEvent,
  RuntimeToolResultRecordedEvent,
} from "../../src/engine/session-runtime-event.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { RuntimeEventBoundaryInspector } from "../../src/runtime/runtime-event-boundary-inspector.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import type { Message } from "../../src/schema/message.js";
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
  assert.throws(
    () => decodeRuntimeEvent({ ...inline, schemaVersion: 1 }),
    (error: unknown) =>
      error instanceof RuntimeEventDecodeError && error.code === "unsupported_legacy_version",
  );

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
  assert.throws(
    () =>
      decodeRuntimeEvent({
        ...evidence,
        refs: {
          ...evidence.refs,
          evidence: { ...evidence.refs.evidence!, schemaVersion: 1 },
        },
      }),
    (error: unknown) =>
      error instanceof RuntimeEventDecodeError && error.code === "invalid_payload",
  );
  const projected = projectRuntimeModelMessage(evidence);
  assert.match(projected?.content ?? "", /bounded preview/u);
  assert.match(projected?.content ?? "", /pico:\/\/evidence\/source-session\/[a-f0-9]{64}/u);
  assert.equal(projected?.providerData, undefined);

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

test("Runtime transcript rejects presentation-only tool completion facts", () => {
  const content = "completed";
  const result = createToolResultEnvelope({
    toolCallId: "call:presentation-only",
    toolName: "read_file",
    status: "succeeded",
    body: inlineBody(content),
    projection: {
      version: 1,
      mode: "full",
      text: content,
      strategy: "test",
      truncated: false,
    },
  });
  assert.throws(
    () =>
      decodeRuntimeEvent({
        ...baseEvent("legacy-transcript-completion", "transcript"),
        kind: "transcript.event.recorded",
        data: {
          event: {
            eventId: "legacy-completion",
            sequence: 1,
            createdAt: 1,
            type: "tool.completed",
            toolCallId: "tool:internal",
            summary: "done",
            result,
          },
        },
      }),
    (error: unknown) =>
      error instanceof RuntimeEventDecodeError && error.code === "invalid_payload",
  );
});

test("legacy Runtime checkpoints without a summary boundary are rejected", () => {
  assert.throws(
    () =>
      decodeRuntimeEvent({
        ...baseEvent("legacy-checkpoint", "internal"),
        kind: "context.checkpoint.recorded",
        data: {
          checkpointId: "legacy-checkpoint",
          coveredEventCount: 1,
          sourceDigest: sha256("legacy"),
        },
      }),
    (error: unknown) =>
      error instanceof RuntimeEventDecodeError && error.code === "invalid_payload",
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

test("RuntimeRun retries one canonical message batch without duplicating non-tool facts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-result-idempotent-retry-"));
  const session = new Session("tool-result-idempotent-retry", join(root, "workspace"), {
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
    toolCallId: "call:retry",
    toolName: "read_file",
    status: "succeeded",
    body: inlineBody("retry output"),
    projection: {
      version: 1,
      mode: "full",
      text: "retry output",
      strategy: "full",
      truncated: false,
    },
  });
  const batch: Message[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call:retry", name: "read_file", arguments: "{}" }],
    },
    result,
  ];
  const commitProjection = session.commitRuntimeProjectionBatch.bind(session);
  let injectProjectionFailure = true;
  session.commitRuntimeProjectionBatch = async (commits) => {
    await commitProjection(commits);
    if (!injectProjectionFailure) return;
    injectProjectionFailure = false;
    throw new Error("fixture projection failure after durable append");
  };

  await assert.rejects(
    run.commitMessages(session, batch),
    /fixture projection failure after durable append/u,
  );
  await run.commitMessages(session, batch);

  const events = await session.runtimeEventStore!.readRun(session.id, run.runId);
  const modelFacts = events.filter(runtimeEventHasModelHistoryEntry);
  assert.deepEqual(
    modelFacts.map((event) => event.kind),
    ["message.committed", "tool.result.recorded"],
  );
  assert.equal(modelFacts.filter((event) => event.kind === "message.committed").length, 1);
  assert.equal(modelFacts.filter((event) => event.kind === "tool.result.recorded").length, 1);
  assert.deepEqual(session.getHistory(), batch);
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

test("durable Session disables Message-based truncate and compaction rewrites", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-history-hard-cutover-"));
  const session = new Session("runtime-history-hard-cutover", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort: createEngineRuntimePort(),
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
    session.applyInMemoryCompaction("summary", 1),
    /does not support Session\.applyInMemoryCompaction/u,
  );
  assert.deepEqual(await session.runtimeEventStore!.readSession(session.id), before);
});

test("Runtime compaction records a checkpoint and preserves the immutable Session transcript", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-checkpoint-compaction-"));
  const session = new Session("runtime-checkpoint-compaction", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();

  const originalHistory = [
    { role: "user" as const, content: `old user one ${"context ".repeat(40)}` },
    { role: "assistant" as const, content: `old assistant one ${"context ".repeat(40)}` },
    { role: "user" as const, content: `old user two ${"context ".repeat(40)}` },
    { role: "assistant" as const, content: `old assistant two ${"context ".repeat(40)}` },
    { role: "user" as const, content: "latest request" },
    { role: "assistant" as const, content: "latest response" },
  ];
  const seedRun = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await seedRun.run(async () => {
    await seedRun.commitMessages(session, originalHistory);
  });

  const provider: LLMProvider = {
    async generate() {
      return { role: "assistant", content: "canonical checkpoint summary" };
    },
  };
  const compactionRun = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const result = await compactionRun.run(() =>
    recordRuntimeCompactionCheckpoint({
      session,
      runtimeRun: compactionRun,
      compactor: new FullCompactor({ provider, maxAttempts: 1 }),
      request: {
        inputBudgetTokens: 4_000,
        targetRetainedTokens: 1,
        trigger: "manual",
      },
    }),
  );

  assert.ok(result);
  assert.equal(result.preview.compactedCount, 4);
  assert.equal(result.beforeMessageCount, 6);
  assert.equal(result.afterMessageCount, 3);
  assert.deepEqual(session.getHistory(), originalHistory);

  const events = await session.runtimeEventStore!.readSession(session.id);
  assert.equal(events.filter((event) => event.kind === "context.checkpoint.recorded").length, 1);
  const modelHistory = materializeRuntimeHistory(events);
  assert.equal(modelHistory.length, 3);
  assert.equal(modelHistory[0]?.providerData?.["picoKind"], "runtime_checkpoint");
  assert.match(modelHistory[0]?.content ?? "", /canonical checkpoint summary/u);
  assert.deepEqual(modelHistory.slice(1), originalHistory.slice(4));
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
  const [result] = await run.recordTranscriptToolResults([
    {
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
    },
  ]);
  assert.ok(result);
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

function baseEvent(
  eventId: string,
  visibility: RuntimeEvent["visibility"] = "model",
): Omit<RuntimeEvent, "kind" | "data"> {
  return {
    schemaVersion: 2,
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
    schemaVersion: 2 as const,
    contentHash: sha256("manifest"),
    sessionId: "source-session",
    kind: "tool-exchange" as const,
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
