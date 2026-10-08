import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CommitMemoryExtractionRequest } from "@pico/core/atomic-memory-contracts";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { DesktopAtomicMemoryService } from "@pico/pico-host/desktop-atomic-memory-service";
import { parseRuntimeResult } from "@pico/protocol";

test("extraction metrics are user-scoped historical receipts: replay, deletion, old unknown and zero-call settlements", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-memory-metrics-"));
  let now = 1000;
  const store = new SqliteMemoryItemStore(join(root, "memory.sqlite"), { now: () => now });
  const service = new DesktopAtomicMemoryService({
    picoHome: root,
    now: () => now,
    publish: () => {},
  });
  t.after(async () => {
    service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const request = (
    id: string,
    extra: Partial<CommitMemoryExtractionRequest> = {},
  ): CommitMemoryExtractionRequest => ({
    operationId: id,
    sessionId: id,
    expectedCursorOrdinal: 0,
    expectedDeletionRevision: 0,
    nextCursorOrdinal: 1,
    coverageHash: "a".repeat(64),
    items: [],
    requestedItemIndexes: [],
    trigger: "extract",
    ...extra,
  });
  const savedRequest = request("saved", {
    summary: { modelCallCount: 2, durationMs: 30 },
    items: [
      {
        content: "Metrics include historical created records.",
        kind: "knowledge",
        statementType: "fact",
        temporalType: "undated",
        scopeType: "workspace",
        scopeKey: "private-workspace",
        observedAt: 900,
        origin: "agent_extracted",
        keys: [{ key: "historical", keyType: "concept", keyOrigin: "llm" }],
        sources: [{ sessionId: "source", runId: "run", turnId: "turn", eventId: "event" }],
      },
    ],
  });
  const saved = await store.commitExtraction(savedRequest);
  assert.equal(
    (
      await store.commitExtraction({
        ...savedRequest,
        summary: { modelCallCount: 99, durationMs: 999 },
      })
    ).replayed,
    true,
  );
  await store.commitExtraction(
    request("empty", { summary: { modelCallCount: 1, durationMs: 20 } }),
  );
  await store.commitExtraction(
    request("skipped", {
      skipReason: "policy_denied",
      summary: { modelCallCount: 0, durationMs: 0 },
    }),
  );
  await store.commitExtraction(request("legacy"));
  now = 2000;
  await store.deleteItem({
    itemId: saved.results[0]!.itemId,
    expectedVersion: 1,
    operationId: "forget",
  });
  const metrics = parseRuntimeResult(
    "memory.metrics.get",
    await service.getMetrics(root, { from: 0, to: 1500 }),
  ).metrics;
  assert.equal(metrics.scope, "user");
  assert.equal(metrics.unknownReceiptCount, 1);
  assert.deepEqual(metrics.groups, [
    {
      trigger: "extract",
      settledCount: 3,
      evaluatedCount: 2,
      createdItemCount: 1,
      modelCallCount: 3,
      emptyCount: 1,
      emptyRate: 0.5,
      durationMs: 50,
    },
  ]);
  assert.equal((await store.readExtractionReceipt("saved"))?.summary?.createdItemCount, 1);
  const excluded = await store.readExtractionMetrics({ from: 1501, to: 3000 });
  assert.deepEqual(excluded.groups, []);
  now = 3000;
  await store.commitExtraction(
    request("zero-only", {
      expectedDeletionRevision: await store.readDeletionRevision(),
      trigger: "remember",
      noOpReason: "sensitive_information",
      summary: { modelCallCount: 0, durationMs: 0 },
    }),
  );
  assert.equal(
    (await store.readExtractionMetrics({ from: 2001, to: 3000 })).groups[0]?.emptyRate,
    null,
  );
  await assert.rejects(service.getMetrics(root, { from: 2, to: 1 }), /统计时间范围无效/);
});
