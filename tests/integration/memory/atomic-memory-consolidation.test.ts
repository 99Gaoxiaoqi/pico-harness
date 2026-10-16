import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  MemoryItemStoreConflictError,
  type MemoryConsolidationClaim,
  type MemoryItemWrite,
} from "@pico/core/atomic-memory-contracts";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { consolidateAutomaticMemory } from "../../../packages/pico-host/src/atomic-memory-consolidation.js";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const memoryWrite = (overrides: Partial<MemoryItemWrite> = {}): MemoryItemWrite => ({
  content: "用户偏好简洁回答。",
  kind: "preference",
  statementType: "fact",
  temporalType: "undated",
  scopeType: "global",
  observedAt: 100,
  origin: "agent_extracted",
  keys: [{ key: "回答风格", keyType: "exact", keyOrigin: "deterministic" }],
  sources: [{ sessionId: "session", runId: "run", turnId: "turn", eventId: "event" }],
  ...overrides,
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pico-consolidation-"));
  const path = join(root, "memory.sqlite");
  let now = 1_000;
  let nextId = 0;
  const store = new SqliteMemoryItemStore(path, {
    now: () => now,
    idFactory: () => `memory-${++nextId}`,
  });
  return {
    store,
    path,
    setNow(value: number) {
      now = value;
    },
    async create(overrides: Partial<MemoryItemWrite> = {}) {
      const result = await store.applyMutations({
        operationId: `create-${nextId + 1}`,
        mutations: [{ type: "create", item: memoryWrite(overrides) }],
      });
      return result.results[0]!.itemId;
    },
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function archiveProposal(itemId: string, keepItemId: string) {
  return JSON.stringify({ archive: [{ itemId, keepItemId, reason: "superseded" }] });
}

function commitClaim(
  store: SqliteMemoryItemStore,
  claim: MemoryConsolidationClaim,
  archiveIds: readonly string[],
  now: number,
) {
  return store.commitMemoryConsolidation({
    batchId: `batch-${claim.claimId}`,
    claimId: claim.claimId,
    ownerId: claim.ownerId,
    fencingToken: claim.fencingToken,
    archive: archiveIds.map((itemId) => ({
      itemId,
      expectedVersion: claim.candidates.find(({ item }) => item.itemId === itemId)!.item.version,
      reason: "superseded",
    })),
    now,
  });
}

test("consolidation archives atomically, cools down, and undo preserves content recency", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const old = await f.create({ content: "用户偏好详细回答。" });
  f.setNow(2_000);
  const latest = await f.create();
  let clock = 3_000;
  t.mock.method(Date, "now", () => clock);
  let calls = 0;
  assert.deepEqual(
    await consolidateAutomaticMemory({
      store: f.store,
      model: { call: async () => (calls++, archiveProposal(old, latest)) },
      isAllowed: async () => true,
    }),
    { changed: true },
  );
  assert.equal(calls, 1);
  assert.equal((await f.store.readItem(old))?.item.lifecycleState, "archived");
  assert.equal((await f.store.readItem(old))?.item.updatedAt, 1_000);
  const [receipt] = await f.store.listMemoryConsolidationHistory({ now: clock });
  assert.ok(receipt);
  assert.equal(receipt.consideredCount, 2);
  assert.equal(receipt.changes, 1);
  assert.equal(receipt.expiresAt - receipt.createdAt, 30 * DAY);
  assert.equal(
    await f.store.claimMemoryConsolidation({
      ownerId: "before-cooldown",
      now: clock + 6 * HOUR - 1,
      leaseDurationMs: 1_000,
    }),
    undefined,
  );
  clock += 1;
  assert.equal(
    (await f.store.undoMemoryConsolidation({ batchId: receipt.batchId, now: clock })).status,
    "undone",
  );
  assert.equal((await f.store.readItem(old))?.item.version, 3);
  assert.equal((await f.store.readItem(old))?.item.updatedAt, 1_000);
  assert.equal((await f.store.readItem(old))?.item.lifecycleState, "active");
  assert.equal(
    (await f.store.undoMemoryConsolidation({ batchId: receipt.batchId, now: clock })).status,
    "already_undone",
  );
  clock = receipt.createdAt + 6 * HOUR;
  await consolidateAutomaticMemory({
    store: f.store,
    model: {
      call: async ({ prompt }) => {
        const groups = JSON.parse(prompt.split("\n").at(-1)!) as Array<{ newestItemId: string }>;
        assert.equal(groups[0]?.newestItemId, latest);
        return '{"archive":[]}';
      },
    },
    isAllowed: async () => true,
  });
  assert.equal((await f.store.readItem(latest))?.item.lifecycleState, "active");
});

for (const change of ["delete", "update", "archive"] as const) {
  test(`consolidation rolls back when its keeper is concurrently ${change}d`, async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    const old = await f.create({ content: "用户偏好详细回答。" });
    f.setNow(2_000);
    const latest = await f.create();
    const concurrent = new SqliteMemoryItemStore(f.path, { now: () => 3_000 });
    t.after(() => concurrent.close());
    await assert.rejects(
      consolidateAutomaticMemory({
        store: f.store,
        model: {
          call: async () => {
            if (change === "delete")
              await concurrent.deleteItem({
                itemId: latest,
                expectedVersion: 1,
                operationId: "delete-keeper",
              });
            else
              await concurrent.applyMutations({
                operationId: "change-keeper",
                mutations: [
                  change === "update"
                    ? {
                        type: "update",
                        itemId: latest,
                        expectedVersion: 1,
                        item: memoryWrite({ content: "用户偏好先给结论。" }),
                      }
                    : { type: "archive", itemId: latest, expectedVersion: 1 },
                ],
              });
            return archiveProposal(old, latest);
          },
        },
        isAllowed: async () => true,
      }),
      (error: unknown) =>
        error instanceof MemoryItemStoreConflictError &&
        error.reason === "consolidation_claim_conflict",
    );
    assert.equal((await f.store.readItem(old))?.item.lifecycleState, "active");
    assert.equal((await f.store.readItem(old))?.item.version, 1);
    assert.deepEqual(await f.store.listMemoryConsolidationHistory({ now: Date.now() }), []);
    const retry = await f.store.claimMemoryConsolidation({
      ownerId: "retry",
      now: Date.now(),
      leaseDurationMs: 1_000,
    });
    assert.equal(retry, undefined, "failed consolidation must preserve the attempt cooldown");
  });
}

test("consolidation rejects proposals that archive a keeper through an overlapping key", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const old = await f.create();
  f.setNow(2_000);
  const middle = await f.create({
    keys: [
      { key: "回答风格", keyType: "exact", keyOrigin: "deterministic" },
      { key: "回复语言", keyType: "exact", keyOrigin: "deterministic" },
    ],
  });
  f.setNow(3_000);
  const latest = await f.create({
    keys: [{ key: "回复语言", keyType: "exact", keyOrigin: "deterministic" }],
  });
  await assert.rejects(
    consolidateAutomaticMemory({
      store: f.store,
      model: {
        call: async () =>
          JSON.stringify({
            archive: [
              { itemId: old, keepItemId: middle, reason: "superseded" },
              { itemId: middle, keepItemId: latest, reason: "superseded" },
            ],
          }),
      },
      isAllowed: async () => true,
    }),
    /memory_consolidation_keeper_archived/,
  );
  for (const itemId of [old, middle, latest])
    assert.equal((await f.store.readItem(itemId))?.item.lifecycleState, "active");
});

test("consolidation claims cap recent automatic facts, isolate experience/manual memories and fence workers", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const autoIds: string[] = [];
  for (let index = 0; index < 260; index++) {
    f.setNow(1_000 + index);
    autoIds.push(await f.create());
  }
  f.setNow(2_000);
  const manual = await f.create({ origin: "user_requested", sources: [] });
  const legacy = await f.create();
  const reviewed = await f.create();
  const db = new DatabaseSync(f.path);
  try {
    for (const [itemId, sourceType] of [
      [legacy, "execution-validated"],
      [reviewed, "reviewed-reference"],
    ])
      db.prepare("INSERT INTO execution_learning_items VALUES(?,?,? ,?,NULL)").run(
        itemId!,
        `candidate-${itemId}`,
        "a".repeat(64),
        sourceType!,
      );
  } finally {
    db.close();
  }
  const claim = await f.store.claimMemoryConsolidation({
    ownerId: "first",
    now: 3_000,
    leaseDurationMs: 100,
  });
  assert.ok(claim);
  assert.equal(claim.candidates.length, 256);
  assert.deepEqual(
    claim.candidates.map(({ item }) => item.itemId),
    autoIds.slice(-256).reverse(),
  );
  assert.ok(
    claim.candidates.every(({ item }) => ![manual, legacy, reviewed].includes(item.itemId)),
  );
  const other = new SqliteMemoryItemStore(f.path);
  t.after(() => other.close());
  assert.equal(
    await other.claimMemoryConsolidation({ ownerId: "blocked", now: 3_099, leaseDurationMs: 100 }),
    undefined,
  );
  assert.equal(
    await other.claimMemoryConsolidation({
      ownerId: "expired-but-cooled",
      now: 3_100,
      leaseDurationMs: 100,
    }),
    undefined,
  );
  await assert.rejects(
    commitClaim(f.store, claim, [], 3_100),
    (error: unknown) =>
      error instanceof MemoryItemStoreConflictError &&
      error.reason === "consolidation_claim_conflict",
  );
  const replacement = await other.claimMemoryConsolidation({
    ownerId: "replacement",
    now: 3_000 + 6 * HOUR,
    leaseDurationMs: 100,
  });
  assert.ok(replacement);
  assert.ok(replacement.fencingToken > claim.fencingToken);
  await assert.rejects(
    commitClaim(f.store, claim, [], 3_001 + 6 * HOUR),
    (error: unknown) =>
      error instanceof MemoryItemStoreConflictError &&
      error.reason === "consolidation_claim_conflict",
  );
  await commitClaim(other, replacement, [], 3_001 + 6 * HOUR);
  assert.equal(
    await f.store.claimMemoryConsolidation({
      ownerId: "cooled",
      now: 3_001 + 12 * HOUR - 1,
      leaseDurationMs: 100,
    }),
    undefined,
  );
  assert.ok(
    await f.store.claimMemoryConsolidation({
      ownerId: "ready",
      now: 3_001 + 12 * HOUR,
      leaseDurationMs: 100,
    }),
  );
});

for (const change of ["update", "delete", "expire"] as const) {
  test(`consolidation undo does not partially restore after ${change}`, async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    const first = await f.create();
    const second = await f.create();
    const claim = await f.store.claimMemoryConsolidation({
      ownerId: "undo",
      now: 2_000,
      leaseDurationMs: 100,
    });
    assert.ok(claim);
    const receipt = await commitClaim(f.store, claim, [first, second], 2_001);
    f.setNow(2_002);
    if (change === "update")
      await f.store.applyMutations({
        operationId: "edit-archived",
        mutations: [
          {
            type: "update",
            itemId: second,
            expectedVersion: 2,
            item: memoryWrite({ content: "用户修正后的偏好。" }),
          },
        ],
      });
    if (change === "delete")
      await f.store.deleteItem({
        operationId: "delete-archived",
        itemId: second,
        expectedVersion: 2,
      });
    const result = await f.store.undoMemoryConsolidation({
      batchId: receipt.batchId,
      now: change === "expire" ? receipt.expiresAt : 2_003,
    });
    assert.equal(result.status, change === "expire" ? "expired" : "conflict");
    assert.equal((await f.store.readItem(first))?.item.lifecycleState, "archived");
    assert.equal((await f.store.readItem(first))?.item.version, 2);
    if (result.status === "conflict")
      assert.equal(
        result.conflicts[0]?.reason,
        change === "delete" ? "missing" : "version_changed",
      );
  });
}

test("consolidation gates model work and rejects out-of-scope model decisions", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const old = await f.create();
  f.setNow(2_000);
  const latest = await f.create();
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  let calls = 0;
  assert.equal(
    await consolidateAutomaticMemory({
      store: f.store,
      model: { call: async () => (calls++, "") },
      isAllowed: async () => false,
    }),
    undefined,
  );
  assert.equal(calls, 0);
  for (const response of [
    archiveProposal(latest, old),
    archiveProposal(old, "missing"),
    '{"archive":[],"extra":true}',
  ]) {
    await assert.rejects(
      consolidateAutomaticMemory({
        store: f.store,
        model: { call: async () => response },
        isAllowed: async () => true,
      }),
      /memory_consolidation_/,
    );
    assert.equal((await f.store.readItem(old))?.item.lifecycleState, "active");
    clock += 6 * HOUR;
  }
});

for (const failure of ["provider", "invalid_json"] as const) {
  test(`consolidation ${failure} failure survives reopen and cools down model attempts for six hours`, async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    await f.create();
    f.setNow(2_000);
    await f.create();
    let clock = 3_000;
    t.mock.method(Date, "now", () => clock);
    let calls = 0;
    const model = {
      call: async () => {
        calls++;
        if (calls === 1) {
          if (failure === "provider") throw new Error("provider unavailable");
          return "not json";
        }
        return '{"archive":[]}';
      },
    };
    await assert.rejects(
      consolidateAutomaticMemory({
        store: f.store,
        model,
        isAllowed: async () => true,
      }),
      failure === "provider" ? /provider unavailable/ : /memory_consolidation_invalid_response/,
    );
    const reopened = new SqliteMemoryItemStore(f.path);
    t.after(() => reopened.close());
    for (const retryAt of [3_001, 3_000 + 6 * HOUR - 1]) {
      clock = retryAt;
      assert.equal(
        await consolidateAutomaticMemory({
          store: reopened,
          model,
          isAllowed: async () => true,
        }),
        undefined,
      );
      assert.equal(calls, 1);
    }
    clock = 3_000 + 6 * HOUR;
    assert.deepEqual(
      await consolidateAutomaticMemory({
        store: reopened,
        model,
        isAllowed: async () => true,
      }),
      { changed: false },
    );
    assert.equal(calls, 2);
  });
}

test("schema v14 upgrades consolidation tables without rewriting existing memory", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const itemId = await f.create();
  f.store.close();
  const db = new DatabaseSync(f.path);
  db.exec(
    "DROP TABLE memory_consolidation_receipts; DROP TABLE memory_consolidation_state; PRAGMA user_version=14",
  );
  db.close();
  const upgraded = new SqliteMemoryItemStore(f.path);
  t.after(() => upgraded.close());
  assert.equal(upgraded.schemaVersion(), 16);
  const item = await upgraded.readItem(itemId);
  assert.equal(item?.item.content, memoryWrite().content);
  assert.equal(item?.item.version, 1);
  assert.equal(item?.item.updatedAt, 1_000);
  assert.deepEqual(await upgraded.listMemoryConsolidationHistory({ now: 2_000 }), []);
  assert.ok(
    await upgraded.claimMemoryConsolidation({
      ownerId: "migrated",
      now: 2_000,
      leaseDurationMs: 100,
    }),
  );
});
