import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../../src/engine/session.js";
import { createCanonicalTranscriptToolStart } from "../../src/engine/transcript-tool-start.js";
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

test("reconciliation fails closed when transcript T2 cannot close the active model tool call", async (context) => {
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
  await run.recordToolStarted(toolCall.id, toolCall.name, toolCall.arguments);
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

  await assert.rejects(
    RuntimeRun.reconcileIncompleteRuns({ capability: session.runtimeEventCapability! }),
    /has no active model outcome/u,
  );

  const hydration = await session.readHydrationSnapshot();
  const starts = hydration.transcriptEvents.filter(
    (event) => event.type === "tool.started" && event.providerCallId === toolCall.id,
  );
  assert.equal(starts.length, 1);
  assert.equal(hydration.toolResults.length, 0);
  const outcomes = (await session.runtimeEventStore!.readRun(session.id, run.runId)).filter(
    (event) => event.kind === "tool.result.recorded" && event.refs.toolCallId === toolCall.id,
  );
  assert.equal(outcomes.length, 1, "one prepared operation owns exactly one immutable outcome");
  assert.equal(
    (await session.runtimeEventStore!.readToolOperation(session.id, run.runId, toolCall.id))?.state,
    "settled",
  );
  assert.equal(
    (await session.runtimeEventStore!.readRun(session.id, run.runId)).some(
      (event) => event.kind === "run.terminal",
    ),
    false,
    "an inconsistent projection must remain unsealed for explicit repair",
  );
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
