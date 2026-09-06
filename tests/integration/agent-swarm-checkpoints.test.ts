import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deterministicFingerprint, wakeIdFor } from "../../src/agent-graph/core/ids.js";
import {
  swarmAttentionKey,
  type AgentSwarmStatusResult,
} from "../../src/agent-graph/swarm-status.js";
import { SqliteAgentGraphControlStore } from "../../src/storage/sqlite/sqlite-agent-graph-control-store.js";

test("Swarm checkpoints durably replay the enqueue gap, recover attention and distinguish new batches", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-swarm-checkpoint-"));
  let store = new SqliteAgentGraphControlStore({ storageRoot });
  const graphId = "swarm-checkpoint";
  const emptyAttentionKey = swarmAttentionKey({ items: [] });
  const observe = (
    status: AgentSwarmStatusResult["status"],
    items: AgentSwarmStatusResult["items"] = [],
  ) =>
    store.observeSwarmCheckpoint({
      graphId,
      status,
      attentionKey: swarmAttentionKey({ items }),
      emptyAttentionKey,
    });
  const register = (run: number) =>
    store.registerYieldInterest({
      permitId: `permit-${run}`,
      graphId,
      rootSessionId: "root",
      rootTurnId: `turn-${run}`,
      rootRunId: `run-${run}`,
      toolCallId: `yield-${run}`,
    });
  const enqueue = (checkpoint: NonNullable<ReturnType<typeof observe>>) => {
    const candidate = { ...checkpoint, cause: "runtime_terminal" as const };
    return store.enqueueSupervisorWakeForYield({
      ...candidate,
      graphId,
      wakeId: wakeIdFor(graphId, candidate.dedupeKey),
      wakeFingerprint: deterministicFingerprint({ graphId, ...candidate }),
    });
  };
  const failure = {
    workId: "a",
    operatorId: "operator-a",
    status: "failed" as const,
    failureReason: "first reason",
  };
  try {
    store.createGraph({ graphId, rootSessionId: "root", epoch: 1 });
    assert.equal(observe("running"), undefined);
    register(1);
    const pending = observe("needs_attention", [failure])!;
    // Crash after the durable observation but before enqueueSupervisorWakeForYield.
    store.close();
    store = new SqliteAgentGraphControlStore({ storageRoot });
    const recovered = observe("needs_attention", [
      { ...failure, failureReason: "changed diagnostic wording" },
    ])!;
    assert.deepEqual(recovered, pending, "reason text cannot create another checkpoint");
    assert.equal(enqueue(recovered).status, "enqueued");
    assert.equal(store.getYieldInterest("permit-1")?.state, "consumed");
    register(2);
    assert.equal(enqueue(recovered).status, "enqueued");
    assert.equal(
      store.getYieldInterest("permit-2")?.state,
      "registered",
      "replay does not consume a new yield",
    );

    const recovery = observe("running")!;
    assert.equal(recovery.payload.status, "running");
    assert.notEqual(recovery.dedupeKey, recovered.dedupeKey);
    enqueue(recovery);
    assert.equal(store.getYieldInterest("permit-2")?.state, "consumed");
    register(3);
    const repeatedFailure = observe("needs_attention", [failure])!;
    assert.notEqual(
      repeatedFailure.dedupeKey,
      pending.dedupeKey,
      "same attention can return after recovery",
    );
    enqueue(repeatedFailure);
    register(4);
    const settled = observe("settled")!;
    enqueue(settled);
    store.close();
    store = new SqliteAgentGraphControlStore({ storageRoot });
    assert.deepEqual(
      observe("settled"),
      settled,
      "restart preserves delivered checkpoint identity",
    );
    register(5);
    assert.equal(observe("running"), undefined, "new work clears an obsolete settled candidate");
    const nextBatch = observe("settled")!;
    assert.notEqual(nextBatch.dedupeKey, settled.dedupeKey);
    enqueue(nextBatch);
    assert.equal(store.getYieldInterest("permit-5")?.state, "consumed");
    assert.equal(store.listSupervisorWakes(graphId).length, 5);
  } finally {
    store.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});
