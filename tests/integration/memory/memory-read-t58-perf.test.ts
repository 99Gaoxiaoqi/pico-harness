import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { countTokens } from "@pico/runtime";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

test("bounded saved-body fitting preserves measured wrapper budget, exact Unicode range and timer cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-t58-read-"));
  const store = new SqliteMemoryItemStore(join(root, "memory.sqlite"));
  try {
    const content = "🧭".repeat(2000);
    const created = await store.applyMutations({
      operationId: "t58-seed",
      mutations: [
        {
          type: "create",
          item: {
            content,
            kind: "knowledge",
            statementType: "fact",
            temporalType: "undated",
            scopeType: "workspace",
            scopeKey: "t58",
            observedAt: 1700000000000,
            origin: "user_requested",
            keys: [{ key: "t58", keyType: "concept", keyOrigin: "user" }],
            sources: [],
          },
        },
      ],
    });
    const id = created.results[0]!.itemId;
    const builder = new AtomicMemoryContextBuilder(store, "t58");
    const result = await builder.read(id, 1, { trace: {} });
    const reference = result.references[0]!;
    assert.ok(result.truncated);
    assert.ok(reference.range.end > 1500 && reference.range.end < 2000);
    assert.equal(
      reference.content,
      Array.from(content).slice(reference.range.start, reference.range.end).join(""),
    );
    assert.equal(result.tokenCount, countTokens(result.block));
    assert.ok(result.tokenCount <= 5120);
    assert.equal(result.trace!.selected[0]!.itemVersion, 1);
    assert.equal(
      result.trace!.selected[0]!.contentHash,
      (await store.readItem(id))!.item.contentHash,
    );
    const partial = await builder.read(id, 1, { start: 1990, end: 2000 });
    assert.equal(partial.references[0]!.content, "🧭".repeat(10));
    assert.equal(partial.truncated, true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      await assert.rejects(builder.read(id, 1, { signal: controller.signal }), /aborted/);
    } finally {
      clearTimeout(timer);
    }
    await assert.rejects(builder.read(id, 2), /version_changed/);
    await assert.rejects(
      new AtomicMemoryContextBuilder(store, "other").read(id, 1),
      /not_available/,
    );
    // A write scheduled during fitting must still be caught by the unchanged final re-read.
    let changed = false;
    const update = new Promise<void>((resolve, reject) =>
      setTimeout(() => {
        store
          .applyMutations({
            operationId: "t58-archive",
            mutations: [{ type: "archive", itemId: id, expectedVersion: 1 }],
          })
          .then(() => {
            changed = true;
            resolve();
          }, reject);
      }, 0),
    );
    await assert.rejects(builder.read(id, 1), /not_available|changed/);
    await update;
    assert.equal(changed, true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
