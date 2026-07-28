import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../../src/engine/session.js";
import { createCanonicalTranscriptToolStart } from "../../src/engine/transcript-tool-start.js";
import { hydrateCanonicalTranscriptEvents } from "../../src/presentation/transcript-tool-result-hydration.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { currentRuntimeRun, RuntimeRun } from "../../src/runtime/runtime-run.js";

test("late async work cannot reuse a terminal RuntimeRun context", async (context) => {
  const fixture = await createFixture(context, "late-context");
  const { session } = fixture;
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolveLate!: (value: ReturnType<typeof currentRuntimeRun>) => void;
  let rejectLate!: (reason: unknown) => void;
  const lateCommit = new Promise<ReturnType<typeof currentRuntimeRun>>((resolve, reject) => {
    resolveLate = resolve;
    rejectLate = reject;
  });
  await run.run(async () => {
    setImmediate(async () => {
      await gate;
      try {
        await session.commitMessages({ role: "user", content: "late but external" });
        resolveLate(currentRuntimeRun());
      } catch (error) {
        rejectLate(error);
      }
    });
  });
  release();
  assert.equal(await lateCommit, undefined);
  assert.deepEqual(session.getHistory(), [{ role: "user", content: "late but external" }]);
  await session.flushPersistence();
});

test("reconciliation does not resurrect tool results whose source message was rewound", async (context) => {
  const fixture = await createFixture(context, "rewound-tool");
  const { session } = fixture;
  await session.commitMessages({ role: "user", content: "kept" });
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await run.commitMessages(session, [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call:orphan", name: "read_file", arguments: "{}" }],
    },
  ]);
  await session.rewindOnce("remove-tool-source", 1);

  await RuntimeRun.reconcileIncompleteRuns({ capability: session.runtimeEventCapability! });
  const events = await session.runtimeEventStore!.readRun(session.id, run.runId);
  assert.equal(
    events.some(
      (event) =>
        event.kind === "message.committed" && event.data.message.toolCallId === "call:orphan",
    ),
    false,
  );
  assert.equal(events.at(-1)?.kind, "run.terminal");
  assert.deepEqual(session.getHistory(), [{ role: "user", content: "kept" }]);
});

test("reconciliation replaces a tool result that was rewound after its active call", async (context) => {
  const { session } = await createFixture(context, "rewound-result");
  await session.commitMessages({ role: "user", content: "kept" });
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const result = registerInlineToolResult(run, "call:kept", "old result");
  await run.commitMessages(session, [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call:kept", name: "read_file", arguments: "{}" }],
    },
    result,
  ]);
  await session.rewindOnce("remove-only-result", 2);

  await RuntimeRun.reconcileIncompleteRuns({ capability: session.runtimeEventCapability! });
  const events = await session.runtimeEventStore!.readRun(session.id, run.runId);
  const activeMessages = session.getHistory();
  assert.deepEqual(
    activeMessages.map((message) => [message.role, message.toolCallId]),
    [
      ["user", undefined],
      ["assistant", undefined],
    ],
  );
  assert.equal(
    events.filter(
      (event) => event.kind === "tool.result.recorded" && event.refs.toolCallId === "call:kept",
    ).length,
    2,
  );
  await RuntimeRun.repairSessionProjection(session, {
    capability: session.runtimeEventCapability!,
  });
  assert.equal(session.getHistory().at(-1)?.toolCallId, "call:kept");
  assert.match(session.getHistory().at(-1)?.content ?? "", /中断/u);
  const hydration = await session.readHydrationSnapshot();
  const hydrated = hydrateCanonicalTranscriptEvents({
    sessionId: hydration.sessionId,
    updatedAt: hydration.updatedAt,
    transcriptEvents: hydration.transcriptEvents,
    transcriptEventSequences: hydration.transcriptEventSequences,
    toolResults: hydration.toolResults,
    rejectUnmatchedResults: true,
  });
  assert.deepEqual(
    hydrated
      .filter((event) => event.type === "tool.completed")
      .map((event) => (event.type === "tool.completed" ? event.result.toolCallId : undefined)),
    ["call:kept"],
  );
});

test("reconciliation reuses a rewritten active model start despite a transcript-only result", async (context) => {
  const { session } = await createFixture(context, "rewritten-active-start");
  await session.commitMessages({ role: "user", content: "kept" });
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await run.recordTurnStarted(1);
  const toolCall = {
    id: "call:rewritten-start",
    name: "read_file",
    arguments: '{"path":"README.md"}',
  } as const;
  await run.commitMessages(session, [
    {
      role: "assistant",
      content: "",
      toolCalls: [toolCall],
    },
  ]);
  await session.recordTranscriptEvent(
    createCanonicalTranscriptToolStart({
      sessionId: session.id,
      runId: run.runId,
      turnId: `turn:${run.runId}:1`,
      callIndex: 0,
      scope: "runtime-recovery:previous-branch",
      toolCall,
      sequence: 1,
      createdAt: 1,
    }),
    { eventId: "fork-rewritten:active-tool-start" },
  );
  const transcriptOnlyContent = "subagent result with a reused provider call ID";
  await run.recordTranscriptToolResults([
    {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      status: "succeeded",
      body: {
        storage: "inline",
        content: transcriptOnlyContent,
        sha256: createHash("sha256").update(transcriptOnlyContent, "utf8").digest("hex"),
        sizeBytes: Buffer.byteLength(transcriptOnlyContent, "utf8"),
      },
      projection: {
        version: 1,
        mode: "full",
        text: transcriptOnlyContent,
        strategy: "full",
        truncated: false,
      },
    },
  ]);

  await RuntimeRun.reconcileIncompleteRuns({ capability: session.runtimeEventCapability! });

  const hydration = await session.readHydrationSnapshot();
  const starts = hydration.transcriptEvents.filter(
    (event) => event.type === "tool.started" && event.providerCallId === toolCall.id,
  );
  assert.equal(starts.length, 1);
  assert.equal(hydration.toolResults.length, 1);
  const hydrated = hydrateCanonicalTranscriptEvents({
    sessionId: hydration.sessionId,
    updatedAt: hydration.updatedAt,
    transcriptEvents: hydration.transcriptEvents,
    transcriptEventSequences: hydration.transcriptEventSequences,
    toolResults: hydration.toolResults,
    rejectUnmatchedResults: true,
  });
  assert.deepEqual(
    hydrated
      .filter((event) => event.type === "tool.completed")
      .map((event) => (event.type === "tool.completed" ? event.result.toolCallId : undefined)),
    [toolCall.id],
  );
});

test("reconciliation repairs a completed run in a separate terminal recovery run", async (context) => {
  const { session } = await createFixture(context, "completed-rewound-result");
  await session.commitMessages({ role: "user", content: "kept" });
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const result = registerInlineToolResult(run, "call:completed", "old result");
  await run.commitMessages(session, [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call:completed", name: "read_file", arguments: "{}" }],
    },
    result,
  ]);
  await run.finish("completed");
  await session.rewindOnce("remove-completed-result", 2);

  await RuntimeRun.reconcileIncompleteRuns({ capability: session.runtimeEventCapability! });
  const originalEvents = await session.runtimeEventStore!.readRun(session.id, run.runId);
  assert.equal(originalEvents.at(-1)?.kind, "run.terminal");
  assert.equal(
    originalEvents.filter(
      (event) =>
        event.kind === "tool.result.recorded" && event.refs.toolCallId === "call:completed",
    ).length,
    1,
  );

  const recoveryRunId = (await session.runtimeEventStore!.listRunIds(session.id)).find((runId) =>
    runId.startsWith("runtime-recovery:run:"),
  );
  assert.ok(recoveryRunId);
  const recoveryEvents = await session.runtimeEventStore!.readRun(session.id, recoveryRunId);
  assert.deepEqual(
    recoveryEvents.map((event) => event.kind),
    ["run.started", "transcript.event.recorded", "tool.result.recorded", "run.terminal"],
  );
  const recoveryTerminal = recoveryEvents.at(-1);
  assert.equal(recoveryTerminal?.kind, "run.terminal");
  assert.equal(
    recoveryTerminal?.kind === "run.terminal" ? recoveryTerminal.data.status : undefined,
    "completed",
  );

  await RuntimeRun.repairSessionProjection(session, {
    capability: session.runtimeEventCapability!,
  });
  assert.equal(session.getHistory().at(-1)?.toolCallId, "call:completed");
  assert.match(session.getHistory().at(-1)?.content ?? "", /中断/u);

  await session.rewindOnce("remove-first-recovered-result", 2);
  assert.deepEqual(
    await RuntimeRun.reconcileIncompleteRuns({
      capability: session.runtimeEventCapability!,
    }),
    [run.runId],
  );
  await RuntimeRun.repairSessionProjection(session, {
    capability: session.runtimeEventCapability!,
  });
  assert.equal(session.getHistory().at(-1)?.toolCallId, "call:completed");
  assert.match(session.getHistory().at(-1)?.content ?? "", /中断/u);

  const recoveryRunIds = (await session.runtimeEventStore!.listRunIds(session.id)).filter((runId) =>
    runId.startsWith("runtime-recovery:run:"),
  );
  assert.equal(recoveryRunIds.length, 2);
  assert.equal(
    new Set(recoveryRunIds).size,
    2,
    "each rewind branch must receive a distinct recovery closure",
  );
  assert.deepEqual(
    await RuntimeRun.reconcileIncompleteRuns({
      capability: session.runtimeEventCapability!,
    }),
    [],
    "reconciliation must remain idempotent within one rewind branch",
  );

  const probe = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const recoveredHistory = await probe.readModelHistory();
  await probe.finish("completed");
  assert.equal(recoveredHistory.at(-1)?.toolCallId, "call:completed");
  assert.match(recoveredHistory.at(-1)?.content ?? "", /中断/u);
});

async function createFixture(context: test.TestContext, suffix: string) {
  const root = await mkdtemp(join(tmpdir(), `pico-runtime-run-${suffix}-`));
  const session = new Session(`runtime-run-${suffix}`, join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort: createEngineRuntimePort(),
  });
  context.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  return { root, session };
}

function registerInlineToolResult(run: RuntimeRun, toolCallId: string, content: string) {
  return run.registerToolResult({
    toolCallId,
    toolName: "read_file",
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
      strategy: "full",
      truncated: false,
    },
  });
}
