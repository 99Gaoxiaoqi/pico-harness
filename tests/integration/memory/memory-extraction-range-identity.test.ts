import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  MemoryEvidenceEvent,
  MemoryExtractionSnapshot,
  MemoryModelRequest,
} from "@pico/core/atomic-memory-runtime-contracts";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import {
  AtomicMemoryExtractionEngine,
  atomicMemoryExtractionOperationId,
} from "@pico/runtime/atomic-memory/extraction-engine";

const sessionId = '["/synthetic/range-identity","session"]';
const evidence = (ordinal: number): MemoryEvidenceEvent => ({
  ordinal,
  eventId: `event-${ordinal}`,
  runId: `run-${Math.ceil(ordinal / 2)}`,
  turnId: `turn-${Math.ceil(ordinal / 2)}`,
  observedAt: 1_700_000_000_000 + ordinal * 1000,
  role: ordinal % 2 ? "user" : "other",
  text: ordinal % 2 ? `Synthetic task detail number ${ordinal}.` : "",
});
const events = Array.from({ length: 6 }, (_, index) => evidence(index + 1));
function snapshot(through: number): MemoryExtractionSnapshot {
  const boundary = events[through - 1]!;
  return {
    deletionRevision: 0,
    settingsVersion: 1,
    trigger: "extract",
    sourceKind: "terminal",
    sessionId,
    workspaceKey: "/synthetic/range-identity",
    runId: boundary.runId,
    turnId: boundary.turnId,
    boundaryOrdinal: through,
    boundaryEventId: boundary.eventId,
    events: events.slice(0, through),
    completedBoundaries: [2, 4, 6]
      .filter((ordinal) => ordinal <= through)
      .map((ordinal) => ({
        ordinal,
        disposition: "eligible",
        deletionRevision: 0,
        settingsVersion: 1,
      })),
  };
}
const emptyProposal = JSON.stringify({
  status: "complete",
  coverageStatus: "processed",
  requestedStatus: "not_applicable",
  requestedItems: [],
  incidentalItems: [],
});

test("pending range retry identity survives distinct recovery runs without overriding later completed ranges", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-range-identity-"));
  const store = new SqliteMemoryItemStore(join(root, "memory.sqlite"));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const calls: MemoryModelRequest[] = [];
  const engine = new AtomicMemoryExtractionEngine({
    store,
    gate: async () => ({ allowed: true }),
    model: {
      async call(request) {
        calls.push(request);
        assert.ok(calls.length <= 7, "synthetic provider call budget exceeded");
        if (calls.length <= 3) throw new Error("synthetic transient provider failure");
        // A configuration interruption does not consume the pending range's second
        // failure settlement. The next trusted worker can recover the same range.
        if (calls.length === 4) {
          const error = new Error("synthetic configuration interruption");
          error.name = "ConfigurationError";
          throw error;
        }
        return emptyProposal;
      },
    },
  });
  const initial = snapshot(2);
  assert.equal((await engine.execute(initial)).status, "unavailable");
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((call) => call.operationId)).size, 1);
  const pending = await store.readPendingExtractionFailure(sessionId);
  assert.ok(pending);
  assert.equal(pending.firstFailureClass, "provider");
  assert.equal(pending.firstOperationId, atomicMemoryExtractionOperationId(initial));
  assert.equal(await store.readExtractionCursor(sessionId), undefined);

  // These are distinct terminal job inputs: different run/turn/event identities.
  // Only the trusted pending identity is carried; no outer job ID is an override.
  const recoveryA = { ...snapshot(4), recoveryForOperationId: pending.firstOperationId };
  const recoveryB = { ...snapshot(6), recoveryForOperationId: pending.firstOperationId };
  assert.notEqual(recoveryA.runId, recoveryB.runId);
  assert.notEqual(
    atomicMemoryExtractionOperationId(recoveryA),
    atomicMemoryExtractionOperationId(recoveryB),
  );
  assert.equal((await engine.execute(recoveryA)).status, "unavailable");
  assert.equal(calls.length, 4);
  assert.deepEqual(await store.readPendingExtractionFailure(sessionId), pending);
  assert.equal((await engine.execute(recoveryB)).status, "extracted");
  assert.equal(calls.length, 7, "one recovered range followed by two completed boundaries");
  assert.equal(
    calls[3]!.operationId,
    calls[4]!.operationId,
    "same failed range must reuse its retry identity across outer runs",
  );
  assert.ok(calls[3]!.operationId);
  assert.equal(calls[5]!.operationId, atomicMemoryExtractionOperationId(snapshot(4)));
  assert.equal(calls[6]!.operationId, atomicMemoryExtractionOperationId(snapshot(6)));
  assert.equal(
    new Set(calls.slice(4).map((call) => call.operationId)).size,
    3,
    "recovery identity must not replace either later range ID",
  );
  assert.equal(await store.readPendingExtractionFailure(sessionId), undefined);
  assert.equal((await store.readExtractionCursor(sessionId))?.processedOrdinal, 6);
  for (const call of calls.slice(4)) {
    assert.ok(call.operationId);
    assert.equal((await store.readExtractionReceipt(call.operationId))?.status, "extracted");
  }
});
