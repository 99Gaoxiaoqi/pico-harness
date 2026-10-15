import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopAtomicMemoryService } from "@pico/pico-host/desktop-atomic-memory-service";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { resolvePicoPaths } from "@pico/pico-host";
import {
  DESKTOP_RUNTIME_METHODS,
  parseRuntimeResult,
  parseStrictRuntimeParams,
} from "@pico/protocol";

test("整理管理RPC提供30天内超过20批历史，并如实返回撤销与版本冲突", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pico-consolidation-service-"));
  const workspacePath = join(directory, "workspace"),
    picoHome = join(directory, "home");
  await mkdir(workspacePath);
  let now = Date.now();
  const notifications: string[] = [];
  const service = new DesktopAtomicMemoryService({
    picoHome,
    now: () => now,
    publish: (_path, topic) => {
      notifications.push(topic);
    },
  });
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  t.after(async () => {
    service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const workspaceKey = resolvePicoPaths(workspacePath, { picoHome }).workspace.id;
  const written = await store.applyMutations({
    operationId: "seed",
    mutations: Array.from({ length: 21 }, (_, index) => ({
      type: "create" as const,
      item: {
        content: `A duplicate extracted note ${index}.`,
        kind: "knowledge",
        statementType: "fact",
        temporalType: "undated",
        scopeType: "workspace",
        scopeKey: workspaceKey,
        observedAt: now,
        origin: "agent_extracted",
        keys: [{ key: "note", keyType: "concept", keyOrigin: "user" }],
        sources: [{ sessionId: "session", runId: "run", turnId: "turn", eventId: "source" }],
      },
    })),
  });
  const itemId = written.results[20]!.itemId;
  for (let index = 0; index < 21; index++) {
    const claim = await store.claimMemoryConsolidation({
      ownerId: "history",
      now,
      leaseDurationMs: 10_000,
    });
    assert.ok(claim);
    await store.commitMemoryConsolidation({
      ...claim,
      batchId: `batch-${index}`,
      now,
      archive: [
        { itemId: written.results[index]!.itemId, expectedVersion: 1, reason: "duplicate" },
      ],
    });
    now += 6 * 60 * 60_000;
  }
  for (const method of ["memory.consolidation.history", "memory.consolidation.undo"] as const)
    assert.ok(DESKTOP_RUNTIME_METHODS.includes(method));
  assert.deepEqual(parseStrictRuntimeParams("memory.consolidation.history", { workspacePath }), {
    workspacePath,
  });
  assert.throws(() =>
    parseStrictRuntimeParams("memory.consolidation.undo", { workspacePath, batchId: " " }),
  );
  assert.throws(() =>
    parseStrictRuntimeParams("memory.consolidation.undo", {
      workspacePath,
      batchId: "batch-20",
      force: true,
    }),
  );
  const history = parseRuntimeResult(
    "memory.consolidation.history",
    await service.listConsolidationHistory(workspacePath),
  );
  assert.equal(
    history.receipts.length,
    21,
    "every receipt within the undo period remains reachable",
  );
  assert.equal(history.receipts.at(-1)?.batchId, "batch-0");
  const result = parseRuntimeResult(
    "memory.consolidation.undo",
    await service.undoConsolidation(workspacePath, "batch-20"),
  );
  assert.equal(result.status, "undone");
  assert.equal((await store.readItem(itemId))?.item.lifecycleState, "active");
  assert.ok(notifications.includes("memory.changed"));
  assert.equal(
    (await service.undoConsolidation(workspacePath, "batch-20")).status,
    "already_undone",
  );
  const claim = await store.claimMemoryConsolidation({
    ownerId: "history",
    now,
    leaseDurationMs: 10_000,
  });
  assert.ok(claim);
  const current = (await store.readItem(itemId))!;
  await store.commitMemoryConsolidation({
    ...claim,
    batchId: "conflicted",
    now,
    archive: [{ itemId, expectedVersion: current.item.version, reason: "superseded" }],
  });
  const archived = (await store.readItem(itemId))!;
  await service.update(workspacePath, {
    workspacePath,
    itemId,
    expectedVersion: archived.item.version,
    idempotencyKey: "manual-edit",
    content: "A manually revised note.",
  });
  const conflict = parseRuntimeResult(
    "memory.consolidation.undo",
    await service.undoConsolidation(workspacePath, "conflicted"),
  );
  assert.equal(conflict.status, "conflict");
  assert.equal((await store.readItem(itemId))?.item.lifecycleState, "archived");
  assert.equal((await store.readItem(itemId))?.item.content, "A manually revised note.");
  if (conflict.status === "conflict") assert.equal(conflict.conflicts[0]?.itemId, itemId);
  assert.equal((await service.undoConsolidation(workspacePath, "absent")).status, "not_found");
});
