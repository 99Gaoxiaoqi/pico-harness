import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import { canonicalizeWorkspacePath } from "../../src/paths/pico-paths.js";
import type { Message, ToolCall } from "../../src/schema/message.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import {
  inspectRuntimeToolRecoveryStates,
  RuntimeEventBoundaryInspector,
} from "../../src/runtime/runtime-event-boundary-inspector.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import {
  canonicalRuntimeToolArgumentsHash,
  canonicalRuntimeToolResultHash,
} from "../../src/runtime/runtime-tool-protocol.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import type { RuntimeEventStoreEntry } from "../../src/storage/runtime-event-store.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

const TOOL_CALL: ToolCall = {
  id: "tool-call:effect",
  name: "effect_tool",
  arguments: '{"b":2,"a":1}',
};

test("engine persists T1 before tool code and atomically commits T2 with its result", async (t) => {
  const fixture = await createFixture(t, "engine-order");
  const { session } = fixture;
  const runtimePort = createEngineRuntimePort();
  const registry = new ToolRegistry();
  let toolInvocations = 0;
  let dispatchedRunId: string | undefined;
  registry.register({
    name: () => TOOL_CALL.name,
    definition: () => ({
      name: TOOL_CALL.name,
      description: "test effect",
      inputSchema: { type: "object" },
    }),
    async execute() {
      toolInvocations++;
      const entries = await session.runtimeEventStore!.readSessionEntries(session.id);
      const call = entries.find(
        ({ event }) =>
          event.kind === "message.committed" &&
          event.data.message.role === "assistant" &&
          event.data.message.toolCalls?.some(({ id }) => id === TOOL_CALL.id),
      );
      const dispatch = entries.find(
        ({ event }) => event.kind === "tool.started" && event.refs?.toolCallId === TOOL_CALL.id,
      );
      assert.ok(call, "canonical tool call must exist before tool code runs");
      assert.ok(dispatch, "durable T1 must exist before tool code runs");
      assert.ok(call.sequence < dispatch.sequence);
      assert.equal(
        entries.some(
          ({ event }) =>
            event.kind === "tool.outcome.recorded" && event.refs?.toolCallId === TOOL_CALL.id,
        ),
        false,
      );
      assert.equal(dispatch.event.kind, "tool.started");
      assert.equal(dispatch.event.data.protocolVersion, 1);
      assert.match(dispatch.event.data.operationId ?? "", /^tool-operation:/u);
      assert.equal(dispatch.event.data.recoveryMode, "never_auto_retry");
      assert.equal(
        dispatch.event.data.argumentsHash,
        canonicalRuntimeToolArgumentsHash('{"a":1,"b":2}'),
      );
      dispatchedRunId = dispatch.event.runId;
      return "effect complete";
    },
  });
  const responses: Message[] = [
    { role: "assistant", content: "", toolCalls: [TOOL_CALL] },
    { role: "assistant", content: "done" },
  ];
  const engine = new AgentEngine({
    workDir: fixture.workDir,
    runtimePort,
    registry,
    maxTurns: 3,
    provider: {
      async generate() {
        const response = responses.shift();
        if (!response) throw new Error("unexpected provider call");
        return response;
      },
    },
  });

  await session.commitMessages({ role: "user", content: "run the effect" });
  await engine.run(session);

  assert.equal(toolInvocations, 1);
  assert.ok(dispatchedRunId);
  const entries = await session.runtimeEventStore!.readSessionEntries(session.id);
  const runEntries = entries.filter(({ event }) => event.runId === dispatchedRunId);
  const states = inspectRuntimeToolRecoveryStates(runEntries);
  assert.deepEqual(
    states.map(({ toolCallId, disposition, recoveryMode }) => ({
      toolCallId,
      disposition,
      recoveryMode,
    })),
    [
      {
        toolCallId: TOOL_CALL.id,
        disposition: "settled",
        recoveryMode: "never_auto_retry",
      },
    ],
  );
  const outcome = runEntries.find(
    ({ event }) =>
      event.kind === "tool.outcome.recorded" && event.refs?.toolCallId === TOOL_CALL.id,
  );
  assert.ok(outcome);
  if (outcome.event.kind !== "tool.outcome.recorded") {
    assert.fail("tool outcome event must retain its schema");
  }
  const outcomeEvent = outcome.event;
  const result = runEntries.find(({ event }) => event.eventId === outcomeEvent.data.resultEventId);
  assert.ok(result);
  assert.equal(result.event.kind, "message.committed");
  assert.equal(result.sequence, outcome.sequence + 1);
  assert.equal(result.event.at, outcomeEvent.at);
  assert.equal(
    outcomeEvent.data.resultHash,
    canonicalRuntimeToolResultHash(result.event.data.message),
  );

  const batches = await readEventBatches(session);
  const outcomeBatch = batches.find((batch) =>
    batch.entries.some(({ event }) => event.eventId === outcomeEvent.eventId),
  );
  assert.ok(outcomeBatch);
  assert.deepEqual(
    outcomeBatch.entries.map(({ event }) => event.kind),
    ["tool.outcome.recorded", "message.committed"],
  );

  const inspection = await inspector(session).inspect({
    sessionId: session.id,
    runId: dispatchedRunId,
    eventHighWater: entries.at(-1)!.sequence,
  });
  assert.equal(inspection.status, "available");
  if (inspection.status !== "available") assert.fail("runtime boundary must be available");
  assert.deepEqual(inspection.pendingToolCallIds, []);
  const terminal = runEntries.find(({ event }) => event.kind === "run.terminal");
  assert.ok(terminal);
  assert.ok(inspection.availableCheckpointRefs.includes(`runtime-event:${terminal.event.eventId}`));
  const boundedInspection = await inspector(session).inspect({
    sessionId: session.id,
    runId: dispatchedRunId,
    eventHighWater: outcome.sequence,
  });
  assert.equal(boundedInspection.status, "available");
  if (boundedInspection.status !== "available") {
    assert.fail("bounded runtime inspection must be available");
  }
  assert.ok(
    boundedInspection.availableCheckpointRefs.includes(`runtime-event:${outcomeEvent.eventId}`),
  );
  assert.equal(
    boundedInspection.availableCheckpointRefs.includes(`runtime-event:${result.event.eventId}`),
    false,
  );
  assert.equal(
    boundedInspection.availableCheckpointRefs.includes(`runtime-event:${terminal.event.eventId}`),
    false,
  );
});

test("crash before T1 is definitely not dispatched and remains safe after reconciliation", async (t) => {
  const fixture = await createProtocolRun(t, "before-t1");
  let entries = await runEntries(fixture);
  assert.deepEqual(
    inspectRuntimeToolRecoveryStates(entries).map(({ disposition }) => disposition),
    ["not_dispatched"],
  );
  let inspection = await inspectFixture(fixture);
  assert.equal(inspection.status, "available");
  if (inspection.status !== "available") assert.fail("runtime boundary must be available");
  assert.deepEqual(inspection.pendingToolCallIds, []);

  await RuntimeRun.reconcileIncompleteRuns({
    capability: fixture.session.runtimeEventCapability!,
  });

  entries = await runEntries(fixture);
  const state = inspectRuntimeToolRecoveryStates(entries)[0]!;
  assert.equal(state.disposition, "not_dispatched");
  assert.ok(state.resultEventId, "reconciliation should close the provider tool pair");
  inspection = await inspectFixture(fixture);
  assert.equal(inspection.status, "available");
  if (inspection.status !== "available") assert.fail("runtime boundary must be available");
  assert.deepEqual(inspection.pendingToolCallIds, []);
});

test("crash after T1 and before T2 is indeterminate and remains parked", async (t) => {
  const fixture = await createProtocolRun(t, "after-t1");
  await fixture.run.recordToolStarted(TOOL_CALL.id, TOOL_CALL.name, TOOL_CALL.arguments);

  let states = inspectRuntimeToolRecoveryStates(await runEntries(fixture));
  assert.equal(states[0]?.disposition, "indeterminate");
  assert.equal(states[0]?.recoveryMode, "never_auto_retry");
  let inspection = await inspectFixture(fixture);
  assert.equal(inspection.status, "available");
  if (inspection.status !== "available") assert.fail("runtime boundary must be available");
  assert.deepEqual(inspection.pendingToolCallIds, [TOOL_CALL.id]);

  await RuntimeRun.reconcileIncompleteRuns({
    capability: fixture.session.runtimeEventCapability!,
  });

  states = inspectRuntimeToolRecoveryStates(await runEntries(fixture));
  assert.equal(states[0]?.disposition, "indeterminate");
  assert.ok(states[0]?.resultEventId, "synthetic result must not masquerade as T2");
  inspection = await inspectFixture(fixture);
  assert.equal(inspection.status, "available");
  if (inspection.status !== "available") assert.fail("runtime boundary must be available");
  assert.deepEqual(inspection.pendingToolCallIds, [TOOL_CALL.id]);
});

test("boundary inspection fails closed on malformed middle JSONL", async (t) => {
  const fixture = await createProtocolRun(t, "malformed-middle");
  await fixture.run.finish("interrupted");
  const path = sessionLogPath(fixture.session);
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  assert.ok(lines.length >= 3);
  lines.splice(1, 0, '{"type":"event-batch","schemaVersion":1,"entries":[');
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });

  await assert.rejects(inspectFixture(fixture), /Runtime|JSON|invalid|malformed/u);
});

interface ProtocolFixture {
  readonly session: Session;
  readonly run: RuntimeRun;
}

async function createProtocolRun(t: TestContext, suffix: string): Promise<ProtocolFixture> {
  const fixture = await createFixture(t, suffix);
  const run = await RuntimeRun.start({
    capability: fixture.session.runtimeEventCapability!,
  });
  await run.recordTurnStarted(1);
  await run.commitMessages(fixture.session, [
    { role: "assistant", content: "", toolCalls: [TOOL_CALL] },
  ]);
  return { session: fixture.session, run };
}

async function createFixture(
  t: TestContext,
  suffix: string,
): Promise<{ readonly session: Session; readonly workDir: string }> {
  const root = await mkdtemp(join(tmpdir(), `pico-runtime-tool-recovery-${suffix}-`));
  const requestedWorkDir = join(root, "workspace");
  await mkdir(requestedWorkDir);
  const workDir = canonicalizeWorkspacePath(requestedWorkDir);
  const runtimePort = createEngineRuntimePort();
  const session = new Session(`runtime-tool-recovery:${suffix}`, workDir, {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort,
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  return { session, workDir };
}

async function inspectFixture(fixture: ProtocolFixture) {
  const entries = await fixture.session.runtimeEventStore!.readSessionEntries(fixture.session.id);
  return inspector(fixture.session).inspect({
    sessionId: fixture.session.id,
    runId: fixture.run.runId,
    eventHighWater: entries.at(-1)?.sequence ?? 0,
  });
}

function inspector(session: Session): RuntimeEventBoundaryInspector {
  return new RuntimeEventBoundaryInspector({
    store: session.runtimeEventStore!,
    backgroundOperationsSettled: () => true,
    toolCatalogHash: () => "tools:test",
  });
}

async function runEntries(fixture: ProtocolFixture): Promise<RuntimeEventStoreEntry[]> {
  return (await fixture.session.runtimeEventStore!.readSessionEntries(fixture.session.id)).filter(
    ({ event }) => event.runId === fixture.run.runId,
  );
}

async function readEventBatches(
  session: Session,
): Promise<Array<{ readonly entries: Array<{ readonly event: RuntimeEvent }> }>> {
  const lines = (await readFile(sessionLogPath(session), "utf8")).trimEnd().split("\n");
  return lines.slice(1).map(
    (line) =>
      JSON.parse(line) as {
        readonly entries: Array<{ readonly event: RuntimeEvent }>;
      },
  );
}

function sessionLogPath(session: Session): string {
  const digest = createHash("sha256").update(session.id).digest("hex");
  return join(session.runtimeEventStore!.storageRoot, "sessions", digest, "session.jsonl");
}
