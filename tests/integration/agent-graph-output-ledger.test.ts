import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";
import {
  AgentGraphOutputReplayConflictError,
  SqliteAgentGraphOutputLedger,
  agentOutputRuntimeEventId,
  type AgentGraphOutputOwnerFencePort,
} from "../../src/runtime/agent-graph-output-ledger.js";
import { RuntimeEventStoreOwnerFenceError } from "../../src/storage/runtime-event-store-contracts.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { RuntimeEventDecodeError, decodeRuntimeEvent } from "../../src/storage/runtime-event.js";
import {
  agentOutputFingerprint,
  agentOutputIdempotencyKey,
  type GraphOperatorActivationContext,
} from "../../src/tools/agent-output-tool.js";

const ACTIVATION: GraphOperatorActivationContext = {
  kind: "graph_operator_activation",
  graphId: "graph-1",
  operatorId: "researcher",
  operatorGeneration: 1,
  activationId: "claim-1",
  sessionId: "child-session-1",
  turnId: "child-turn-1",
  runId: "child-run-1",
};
const INVOCATION_ID = "child-invocation-1";

test("agent.output commits one canonical fact and replays the same key atomically", async (t) => {
  const fixture = await createFixture(t);
  const firstLedger = fixture.ledger(() => new Date("2026-08-26T00:00:01.000Z"));
  const racingLedger = fixture.ledger(() => new Date("2026-08-26T00:00:02.000Z"));
  const input = outputInput("canonical result");

  const [first, replay] = await Promise.all([
    firstLedger.commitAgentOutputEvent(input),
    racingLedger.commitAgentOutputEvent({ ...input, toolCallId: "tool-call-replay" }),
  ]);

  assert.equal(Number(first.inserted) + Number(replay.inserted), 1);
  assert.equal(first.eventId, replay.eventId);
  assert.equal(first.invocationId, INVOCATION_ID);
  assert.deepEqual(first.payload, input.payload);
  assert.equal(
    (await firstLedger.listAgentOutputEvents(ACTIVATION.sessionId, ACTIVATION.runId)).length,
    1,
  );
  assert.deepEqual(await firstLedger.readAgentOutputEvent(first.eventId), {
    ...(first.inserted ? first : replay),
    inserted: false,
  });

  const stored = (await fixture.store.readRun(ACTIVATION.sessionId, ACTIVATION.runId)).filter(
    (event) => event.kind === "agent.output",
  );
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.partial, false);
  assert.equal(stored[0]?.visibility, "internal");
  assert.equal(stored[0]?.data.idempotencyKey, input.payload.idempotencyKey);
  assert.equal(stored[0]?.data.fingerprint, input.payload.fingerprint);
  assert.ok(
    stored[0]?.data.toolCallId === "tool-call-1" ||
      stored[0]?.data.toolCallId === "tool-call-replay",
  );
});

test("agent.output rejects fingerprint conflicts, wrong activation identity and stale owners", async (t) => {
  const fixture = await createFixture(t);
  const ledger = fixture.ledger();
  const first = outputInput("first result");
  await ledger.commitAgentOutputEvent(first);

  const conflicting = outputInput("different result");
  await assert.rejects(
    ledger.commitAgentOutputEvent(conflicting),
    (error: unknown) => error instanceof AgentGraphOutputReplayConflictError,
  );
  await assert.rejects(
    ledger.commitAgentOutputEvent({
      ...first,
      eventId: "agent-output-event:not-derived",
      activation: { ...ACTIVATION, turnId: "another-turn" },
    }),
    /eventId must be derived/u,
  );

  const staleFence = fixture.fence;
  fixture.fence = await fixture.store.advanceOwnerFence(ACTIVATION.sessionId, fixture.fence.epoch);
  const staleLedger = new SqliteAgentGraphOutputLedger({
    store: fixture.store,
    ownerFencePort: {
      async assertAgentOutputWriteAllowed() {
        return staleFence;
      },
    },
  });
  await assert.rejects(
    staleLedger.commitAgentOutputEvent(first),
    (error: unknown) => error instanceof RuntimeEventStoreOwnerFenceError,
  );
});

test("agent.output codec fails closed and partial output never becomes a fact", async (t) => {
  const fixture = await createFixture(t);
  const input = outputInput("valid output");
  const canonical = runtimeOutputEvent(input);
  assert.deepEqual(decodeRuntimeEvent(canonical), canonical);

  for (const invalid of [
    { ...canonical, partial: true },
    {
      ...canonical,
      data: { ...canonical.data, toolCallId: "another-tool-call" },
    },
    {
      ...canonical,
      data: {
        ...canonical.data,
        payload: { ...canonical.data.payload, outputBytes: 1 },
      },
    },
    {
      ...canonical,
      data: {
        ...canonical.data,
        payload: { ...canonical.data.payload, output: "tampered" },
      },
    },
  ]) {
    assert.throws(
      () => decodeRuntimeEvent(invalid),
      (error: unknown) =>
        error instanceof RuntimeEventDecodeError && error.code === "invalid_payload",
    );
  }

  await assert.rejects(
    fixture.store.append({ ...canonical, partial: true } as unknown as RuntimeEvent, {
      ownerFence: fixture.fence,
    }),
    /is invalid/u,
  );
  assert.equal(
    (await fixture.store.readRun(ACTIVATION.sessionId, ACTIVATION.runId)).some(
      (event) => event.kind === "agent.output",
    ),
    false,
  );
});

async function createFixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "pico-agent-graph-output-ledger-"));
  const workspace = join(root, "workspace");
  const storage = join(root, "storage");
  mkdirSync(workspace, { recursive: true });
  const store = new SqliteRuntimeEventStore({ storageRoot: storage });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.initializeSession({ sessionId: ACTIVATION.sessionId, workDir: workspace });
  let fence = await store.advanceOwnerFence(ACTIVATION.sessionId, 0);
  await store.append(
    {
      schemaVersion: 2,
      eventId: "child-run-started-1",
      sessionId: ACTIVATION.sessionId,
      invocationId: INVOCATION_ID,
      runId: ACTIVATION.runId,
      turnId: ACTIVATION.turnId,
      at: "2026-08-26T00:00:00.000Z",
      partial: false,
      visibility: "internal",
      kind: "run.started",
      data: { workDir: workspace },
    },
    { ownerFence: fence },
  );
  const ownerFencePort: AgentGraphOutputOwnerFencePort = {
    async assertAgentOutputWriteAllowed(sessionId) {
      assert.equal(sessionId, ACTIVATION.sessionId);
      return fence;
    },
  };
  return {
    store,
    get fence() {
      return fence;
    },
    set fence(value) {
      fence = value;
    },
    ledger: (now?: () => Date) => new SqliteAgentGraphOutputLedger({ store, ownerFencePort, now }),
  };
}

function outputInput(
  output: string,
): Parameters<SqliteAgentGraphOutputLedger["commitAgentOutputEvent"]>[0] {
  const evidenceRefs = ["pico://evidence/source"];
  const artifactRefs = ["artifact://report"];
  const idempotencyKey = agentOutputIdempotencyKey(ACTIVATION);
  const fingerprint = agentOutputFingerprint({
    status: "success",
    output,
    evidenceRefs,
    artifactRefs,
  });
  return {
    eventId: agentOutputRuntimeEventId(idempotencyKey),
    toolCallId: "tool-call-1",
    activation: ACTIVATION,
    payload: {
      schemaVersion: "pico.agent_output.v1",
      graphId: ACTIVATION.graphId,
      operatorId: ACTIVATION.operatorId,
      operatorGeneration: ACTIVATION.operatorGeneration,
      activationId: ACTIVATION.activationId,
      status: "success",
      output,
      outputBytes: Buffer.byteLength(output, "utf8"),
      evidenceRefs,
      artifactRefs,
      idempotencyKey,
      fingerprint,
    },
  };
}

function runtimeOutputEvent(
  input: ReturnType<typeof outputInput>,
): Extract<RuntimeEvent, { kind: "agent.output" }> {
  return {
    schemaVersion: 2,
    eventId: input.eventId,
    sessionId: input.activation.sessionId,
    invocationId: INVOCATION_ID,
    runId: input.activation.runId,
    turnId: input.activation.turnId,
    at: "2026-08-26T00:00:01.000Z",
    partial: false,
    visibility: "internal",
    refs: { toolCallId: input.toolCallId },
    kind: "agent.output",
    data: {
      toolCallId: input.toolCallId,
      idempotencyKey: input.payload.idempotencyKey,
      fingerprint: input.payload.fingerprint,
      payload: input.payload,
    },
  };
}
