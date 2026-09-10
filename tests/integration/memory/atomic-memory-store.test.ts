import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  SqliteMemoryItemStore,
  type SqliteMemoryItemStoreFailpoint,
} from "../../../src/storage/sqlite/sqlite-memory-item-store.js";
import {
  MemoryItemStoreConflictError,
  type MemoryItemWrite,
  type MemoryItemSource,
  type CommitMemoryExtractionRequest,
} from "../../../src/memory/atomic/contracts.js";

const source = (eventId = "event-1"): MemoryItemSource => ({
  sessionId: '["/workspace/a","session-1"]',
  runId: "run-1",
  turnId: "turn-1",
  eventId,
});
const write = (overrides: Partial<MemoryItemWrite> = {}): MemoryItemWrite => ({
  content: "Private preference from original evidence",
  kind: "preference",
  statementType: "fact",
  temporalType: "undated",
  scopeType: "global",
  observedAt: 900,
  origin: "agent_extracted",
  keys: [{ key: "Concise", keyType: "exact", keyOrigin: "deterministic" }],
  sources: [source()],
  ...overrides,
});
const extraction = (
  overrides: Partial<CommitMemoryExtractionRequest> = {},
): CommitMemoryExtractionRequest => ({
  operationId: "extract-1",
  sessionId: source().sessionId,
  expectedCursorOrdinal: 0,
  expectedDeletionRevision: 0,
  nextCursorOrdinal: 2,
  coverageHash: "a".repeat(64),
  items: [write()],
  requestedItemIndexes: [0],
  trigger: "remember",
  ...overrides,
});
const conflict = (reason: MemoryItemStoreConflictError["reason"]) => (error: unknown) =>
  error instanceof MemoryItemStoreConflictError && error.reason === reason;

async function fixture(
  run: (input: {
    store: SqliteMemoryItemStore;
    path: string;
    setFailpoint: (point?: SqliteMemoryItemStoreFailpoint) => void;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "pico-atomic-memory-"));
  const path = join(root, "private", "memory.sqlite");
  let failpoint: SqliteMemoryItemStoreFailpoint | undefined;
  const store = new SqliteMemoryItemStore(path, {
    now: () => 1000,
    failpoint: (point) => {
      if (point === failpoint) throw new Error(`injected ${point}`);
    },
  });
  try {
    await run({
      store,
      path,
      setFailpoint: (point) => {
        failpoint = point;
      },
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("atomic memory persists scoped assertions with transaction replay, rollback, CAS and private files", async () => {
  await fixture(async ({ store, path, setFailpoint }) => {
    assert.equal(store.schemaVersion(), 9);
    assert.equal(store.journalMode(), "wal");
    assert.equal(store.foreignKeysEnabled(), true);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(path, ".."))).mode & 0o777, 0o700);
    }
    const request = extraction();
    const first = await store.commitExtraction(request);
    const itemId = first.results[0]!.itemId;
    assert.equal(first.receipt.status, "remembered");
    assert.equal((await store.commitExtraction(request)).replayed, true);
    assert.equal((await store.listItems({ workspaceKey: "/workspace/a" })).length, 1);
    await assert.rejects(
      store.commitExtraction({ ...request, coverageHash: "b".repeat(64) }),
      conflict("operation_reused"),
    );
    await assert.rejects(
      store.commitExtraction(extraction({ operationId: "stale" })),
      conflict("cursor_conflict"),
    );
    for (const point of [
      "after_item_write",
      "after_keys_write",
      "after_sources_write",
      "after_cursor_write",
      "before_operation_write",
    ] as const) {
      setFailpoint(point);
      await assert.rejects(
        store.commitExtraction(
          extraction({
            operationId: `rollback-${point}`,
            expectedCursorOrdinal: 2,
            nextCursorOrdinal: 3,
          }),
        ),
        /injected/,
      );
      assert.equal((await store.readExtractionCursor(source().sessionId))?.processedOrdinal, 2);
      assert.equal(await store.readOperation(`rollback-${point}`), undefined);
      assert.equal(await store.readExtractionReceipt(`rollback-${point}`), undefined);
      assert.equal((await store.listItems({ workspaceKey: "/workspace/a" })).length, 1);
    }
    setFailpoint();
    await store.applyMutations({
      operationId: "scoped",
      mutations: [
        { type: "create", item: write({ scopeType: "workspace", scopeKey: "/workspace/a" }) },
        { type: "create", item: write({ scopeType: "workspace", scopeKey: "/workspace/b" }) },
        {
          type: "create",
          item: write({
            origin: "user_requested",
            sources: [],
            keys: [{ key: "manual", keyOrigin: "user", keyType: "exact" }],
          }),
        },
      ],
    });
    assert.equal((await store.searchByKeys({ terms: ["concise"], match: "exact" })).length, 1);
    assert.equal(
      (await store.searchByKeys({ terms: ["con"], match: "prefix", workspaceKey: "/workspace/a" }))
        .length,
      2,
    );
    assert.equal((await store.listItems({ workspaceKey: "/workspace/a" })).length, 3);
    const second = new SqliteMemoryItemStore(path, { now: () => 1000 });
    try {
      await store.applyMutations({
        operationId: "update",
        mutations: [
          {
            type: "update",
            itemId,
            expectedVersion: 1,
            item: write({ content: "Changed", sources: [source("event-2")] }),
          },
        ],
      });
      await assert.rejects(
        second.applyMutations({
          operationId: "stale-update",
          mutations: [{ type: "archive", itemId, expectedVersion: 1 }],
        }),
        conflict("version_conflict"),
      );
      await store.applyMutations({
        operationId: "archive",
        mutations: [{ type: "archive", itemId, expectedVersion: 2 }],
      });
      assert.equal((await store.searchByKeys({ terms: ["concise"], match: "exact" })).length, 0);
      assert.equal(
        (await store.searchByKeys({ terms: ["concise"], match: "exact", includeArchived: true }))
          .length,
        1,
      );
      await store.applyMutations({
        operationId: "restore",
        mutations: [{ type: "restore", itemId, expectedVersion: 3 }],
      });
      const defaults = await second.readSettings("/workspace/a");
      assert.deepEqual(defaults, {
        workspaceKey: "/workspace/a",
        version: 1,
        enabled: true,
        autoExtract: true,
        recallEnabled: true,
      });
      await store.updateSettings({
        workspaceKey: "/workspace/a",
        expectedVersion: 1,
        recallEnabled: false,
      });
      await assert.rejects(
        second.updateSettings({ workspaceKey: "/workspace/a", expectedVersion: 1, enabled: false }),
        conflict("version_conflict"),
      );
      assert.equal((await second.readSettings("/workspace/a")).recallEnabled, false);
      assert.equal((await second.readSettings("/workspace/b")).recallEnabled, false);
    } finally {
      second.close();
    }
  });
});

test("atomic memory retries a pending range once, discards atomically and never skips existing cursors", async () => {
  await fixture(async ({ store, setFailpoint }) => {
    await store.initializeExtractionCursor("bootstrap", 12);
    assert.equal((await store.initializeExtractionCursor("bootstrap", 30)).processedOrdinal, 12);
    const request = {
      operationId: "failure-1",
      sessionId: source().sessionId,
      expectedCursorOrdinal: 0,
      expectedDeletionRevision: 0,
      failedThroughOrdinal: 2,
      coverageHash: "a".repeat(64),
      failureClass: "provider" as const,
      trigger: "remember" as const,
    };
    assert.equal((await store.settleExtractionFailure(request)).status, "retry_later");
    assert.equal((await store.settleExtractionFailure(request)).replayed, true);
    assert.equal(await store.readExtractionCursor(request.sessionId), undefined);
    await assert.rejects(
      store.initializeExtractionCursor(request.sessionId, 2),
      conflict("cursor_conflict"),
    );
    setFailpoint("after_cursor_write");
    await assert.rejects(
      store.settleExtractionFailure({ ...request, operationId: "failure-2" }),
      /injected/,
    );
    assert.ok(await store.readPendingExtractionFailure(request.sessionId));
    assert.equal(await store.readExtractionCursor(request.sessionId), undefined);
    setFailpoint();
    const result = await store.settleExtractionFailure({ ...request, operationId: "failure-2" });
    assert.equal(result.status, "discarded");
    assert.equal((await store.readExtractionCursor(request.sessionId))?.processedOrdinal, 2);
    assert.equal(await store.readPendingExtractionFailure(request.sessionId), undefined);
    assert.equal(
      (await store.settleExtractionFailure({ ...request, operationId: "failure-2" })).replayed,
      true,
    );
  });
});

test("deletion atomically erases prose, survives retries and allows saving the same source again", async () => {
  await fixture(async ({ store, path, setFailpoint }) => {
    const request = extraction();
    const initial = await store.commitExtraction(request);
    const itemId = initial.results[0]!.itemId;
    await store.applyMutations({
      operationId: "edit",
      mutations: [
        {
          type: "update",
          itemId,
          expectedVersion: 1,
          item: write({ content: "New private assertion", sources: [source("event-2")] }),
        },
      ],
    });
    const forget = { itemId, expectedVersion: 2, operationId: "forget-1" };
    setFailpoint("before_operation_write");
    await assert.rejects(store.deleteItem(forget), /injected/);
    assert.equal((await store.readItem(itemId))?.item.content, "New private assertion");
    assert.equal(await store.readDeletionRevision(), 0);
    assert.equal(
      (await store.readExtractionReceipt(request.operationId))?.requestedItems[0]?.content,
      request.items[0]?.content,
    );
    setFailpoint();
    await store.deleteItem(forget);
    await store.deleteItem(forget);
    assert.equal(await store.readItem(itemId), undefined);
    assert.equal(
      await store.readDeletionRevision(),
      1,
      "a replay does not increment the deletion generation",
    );
    assert.equal((await store.readOperation(forget.operationId))?.operationType, "delete");
    assert.deepEqual((await store.readExtractionReceipt(request.operationId))?.requestedItems, []);
    assert.deepEqual((await store.commitExtraction(request)).receipt.requestedItems, []);
    assert.equal(await store.readItem(itemId), undefined);
    await assert.rejects(
      store.deleteItem({ ...forget, expectedVersion: 3 }),
      conflict("operation_reused"),
    );
    await assert.rejects(
      store.applyMutations({
        operationId: forget.operationId,
        mutations: [{ type: "create", item: write() }],
      }),
      conflict("operation_reused"),
    );
    const db = new DatabaseSync(path);
    try {
      assert.equal(db.prepare("SELECT count(*) n FROM memory_item_keys").get()!.n, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM memory_item_sources").get()!.n, 0);
      const serialized = JSON.stringify(
        db
          .prepare(
            "SELECT result_json FROM memory_extraction_receipts UNION ALL SELECT result_json FROM memory_write_operations",
          )
          .all(),
      );
      assert.doesNotMatch(serialized, /Private preference|New private assertion/);
    } finally {
      db.close();
    }
    store.close();
    const reopened = new SqliteMemoryItemStore(path);
    try {
      assert.equal(await reopened.readDeletionRevision(), 1);
      assert.equal((await reopened.commitExtraction(request)).replayed, true);
      assert.deepEqual(await reopened.listItems({ workspaceKey: "/workspace/a" }), []);
      const resaved = await reopened.commitExtraction(
        extraction({
          operationId: "remember-again",
          expectedCursorOrdinal: 2,
          nextCursorOrdinal: 3,
          expectedDeletionRevision: await reopened.readDeletionRevision(),
        }),
      );
      assert.equal(resaved.receipt.status, "remembered");
      assert.deepEqual((await reopened.readItem(resaved.results[0]!.itemId))?.sources, [source()]);
    } finally {
      reopened.close();
    }
  });
});

test("deletion from another connection rejects stale extraction commits and failure settlement", async () => {
  await fixture(async ({ store, path }) => {
    const initial = await store.commitExtraction(extraction());
    const revision = await store.readDeletionRevision();
    const management = new SqliteMemoryItemStore(path, { now: () => 1000 });
    try {
      await management.deleteItem({
        itemId: initial.results[0]!.itemId,
        expectedVersion: 1,
        operationId: "delete-concurrently",
      });
      const stale = extraction({
        operationId: "in-flight",
        expectedCursorOrdinal: 2,
        nextCursorOrdinal: 4,
        expectedDeletionRevision: revision,
      });
      await assert.rejects(store.commitExtraction(stale), conflict("deletion_conflict"));
      await assert.rejects(
        store.settleExtractionFailure({
          operationId: "in-flight-failure",
          sessionId: stale.sessionId,
          expectedCursorOrdinal: 2,
          failedThroughOrdinal: 4,
          expectedDeletionRevision: revision,
          coverageHash: stale.coverageHash,
          failureClass: "provider",
          trigger: "remember",
        }),
        conflict("deletion_conflict"),
      );
      assert.equal((await store.readExtractionCursor(stale.sessionId))?.processedOrdinal, 2);
      assert.equal(await store.readPendingExtractionFailure(stale.sessionId), undefined);
      assert.equal(await store.readOperation(stale.operationId), undefined);
      assert.deepEqual(await store.listItems({ workspaceKey: "/workspace/a" }), []);
      assert.equal(
        (
          await store.commitExtraction({
            ...stale,
            operationId: "new-request",
            expectedDeletionRevision: await store.readDeletionRevision(),
          })
        ).receipt.status,
        "remembered",
      );
    } finally {
      management.close();
    }
  });
});
