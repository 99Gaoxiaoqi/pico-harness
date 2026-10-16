import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { MemoryItemWrite, MemorySearchSignals } from "@pico/core/atomic-memory-contracts";
import { collectMemorySearchSignals } from "@pico/core/atomic-memory-search";
import { SqliteMemoryItemStore } from "../../../packages/storage/src/sqlite/sqlite-memory-item-store.js";
import {
  MEMORY_CONTENT_INDEX_SCHEMA_SQL,
  flushMemoryContentIndex,
  rebuildMemoryContentIndex,
  queryMemoryContentIndex,
} from "../../../packages/storage/src/sqlite/memory-content-index.js";

const workspaceKey = "index-fixture";
const memory = (content: string, scopeKey = workspaceKey): MemoryItemWrite => ({
  content,
  kind: "knowledge",
  statementType: "fact",
  temporalType: "undated",
  scopeType: "workspace",
  scopeKey,
  observedAt: 1,
  origin: "user_requested",
  keys: [{ key: "background", keyType: "concept", keyOrigin: "user" }],
  sources: [],
});
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-memory-content-index-"));
  const path = join(root, "memory.sqlite");
  const store = new SqliteMemoryItemStore(path, { now: () => 1000 });
  const other = new SqliteMemoryItemStore(path, { now: () => 1000 });
  const db = new DatabaseSync(path);
  let operation = 0;
  const create = async (content: string, scopeKey?: string) =>
    (
      await store.applyMutations({
        operationId: `seed-${operation++}`,
        mutations: [{ type: "create", item: memory(content, scopeKey) }],
      })
    ).results[0]!;
  const oracle = async (signals: MemorySearchSignals, limit = 100) => {
    const expected = await store.searchByContent({ workspaceKey, ...signals, limit });
    const actual = queryMemoryContentIndex(db, { workspaceKey, signals, limit });
    assert.ok(actual, "supported index query must not silently fall back");
    assert.deepEqual(
      actual.map((hit) => hit.itemId),
      expected.map((record) => record.item.itemId),
    );
    return actual;
  };
  t.after(async () => {
    store.close();
    other.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, other, db, create, oracle };
}

test("typed content index exactly matches production scan for Unicode, paths, CJK, negation and repeated terms", async (t) => {
  const f = await fixture(t);
  const contents = [
    "BUILD works for ＡＰＩ tokens and ＣＡＦÉ; café is normalized.",
    "build must NOT run before permission. API api api.",
    "Inspect ./src/Agent.ts and /Users/Example/config.json; ../other/file.ts.",
    "星河计划需要先检查当前权限，不能自动执行。星河计划边界明确。",
    "日本語の設定を確認します。ひらがなカタカナ設定。",
    "Mixed English Ελληνικά русский 한국어 العربية test-case @owner value_name.",
    "用户要求保留的助手笔记（未经独立核实） [1/2]：hiddenbody marker",
    "用户要求保留的助手笔记（未经独立核实） [2/2]：secondbody marker",
    "a/b/c cachemarker prefixcachemarker and cachemarker-suffix differ.",
  ];
  for (const content of contents) await f.create(content);
  await f.create("API build 星河计划", "other-workspace");
  await f.store.applyMutations({
    operationId: "global",
    mutations: [
      {
        type: "create",
        item: { ...memory("global API 星河计划"), scopeType: "global", scopeKey: undefined },
      },
    ],
  });
  f.db.exec(MEMORY_CONTENT_INDEX_SCHEMA_SQL);
  assert.equal(flushMemoryContentIndex(f.db), contents.length + 2);
  assert.equal(flushMemoryContentIndex(f.db), 0);
  for (const query of [
    "build",
    "ＡＰＩ",
    "café",
    "./src/Agent.ts",
    "/Users/Example/config.json",
    "../other/file.ts",
    "星河计划",
    "日本語設定",
    "ひらがな",
    "カタカナ",
    "Ελληνικά русский",
    "한국어 العربية",
    "test-case @owner value_name",
    "hiddenbody",
    "用户要求保留的助手笔记",
    "cachemarker",
    "prefixcachemarker",
    "missing",
    "not permission",
    "a/b/c",
  ])
    await f.oracle(collectMemorySearchSignals(query));
  await f.oracle({
    paths: ["./src/agent.ts", "./src/agent.ts"],
    tokens: ["api", "api"],
    cjkBigrams: ["星河", "星河", "河计", "计划"],
  });
  await f.oracle({ paths: [], tokens: [], cjkBigrams: ["星河"] });
  const many = Array.from({ length: 12 }, (_, i) => `中文长句索引匹配测试第${i}部分`).join("");
  await f.create(many);
  await f.oracle(collectMemorySearchSignals("中文长句索引匹配测试部分"));
  // The existing scorer allows arbitrary substring requests; unsupported lexemes must scan.
  assert.equal(
    queryMemoryContentIndex(f.db, {
      workspaceKey,
      signals: { paths: [], tokens: [], cjkBigrams: ["abc", "bcd"] },
      limit: 100,
    }),
    undefined,
  );
});

test("index triggers transactionally remove old terms across connections, archive/restore/delete and rollback", async (t) => {
  const f = await fixture(t);
  const item = await f.create("oldmarker 星河计划");
  f.db.exec(MEMORY_CONTENT_INDEX_SCHEMA_SQL);
  await f.oracle(collectMemorySearchSignals("oldmarker"));
  await f.other.applyMutations({
    operationId: "edit",
    mutations: [
      {
        type: "update",
        itemId: item.itemId,
        expectedVersion: 1,
        item: memory("newmarker 晨星计划"),
      },
    ],
  });
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM memory_content_postings WHERE term='oldmarker'").get()!.n,
    0,
  );
  await f.oracle(collectMemorySearchSignals("oldmarker"));
  assert.equal((await f.oracle(collectMemorySearchSignals("newmarker"))).length, 1);
  await f.other.applyMutations({
    operationId: "archive",
    mutations: [{ type: "archive", itemId: item.itemId, expectedVersion: 2 }],
  });
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM memory_content_postings WHERE item_id=?").get(item.itemId)!
      .n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM memory_content_dirty WHERE item_id=?").get(item.itemId)!.n,
    0,
  );
  await f.oracle(collectMemorySearchSignals("newmarker"));
  await f.other.applyMutations({
    operationId: "restore",
    mutations: [{ type: "restore", itemId: item.itemId, expectedVersion: 3 }],
  });
  assert.equal((await f.oracle(collectMemorySearchSignals("newmarker"))).length, 1);
  f.db.exec("BEGIN");
  f.db
    .prepare("UPDATE memory_items SET content='rolledbackmarker' WHERE item_id=?")
    .run(item.itemId);
  assert.equal(
    queryMemoryContentIndex(f.db, {
      workspaceKey,
      signals: collectMemorySearchSignals("rolledbackmarker"),
      limit: 100,
    })!.length,
    1,
  );
  f.db.exec("ROLLBACK");
  await f.oracle(collectMemorySearchSignals("newmarker"));
  await f.oracle(collectMemorySearchSignals("rolledbackmarker"));
  await f.other.deleteItem({ itemId: item.itemId, expectedVersion: 4, operationId: "forget" });
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM memory_content_postings WHERE item_id=?").get(item.itemId)!
      .n,
    0,
  );
  assert.equal(rebuildMemoryContentIndex(f.db), 0);
  assert.equal((await f.oracle(collectMemorySearchSignals("newmarker"))).length, 0);
});

test("missing or failed index is explicit fallback; flush failure retains dirty work atomically", async (t) => {
  const f = await fixture(t);
  await f.create("safemarker");
  const input = { workspaceKey, signals: collectMemorySearchSignals("safemarker"), limit: 100 };
  assert.equal(queryMemoryContentIndex(f.db, input), undefined);
  f.db.exec(MEMORY_CONTENT_INDEX_SCHEMA_SQL);
  f.db.exec(
    "CREATE TRIGGER fail_posting BEFORE INSERT ON memory_content_postings BEGIN SELECT RAISE(ABORT,'synthetic index failure'); END",
  );
  assert.equal(queryMemoryContentIndex(f.db, input), undefined);
  assert.equal(f.db.prepare("SELECT count(*) n FROM memory_content_dirty").get()!.n, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM memory_content_postings").get()!.n, 0);
  f.db.exec("DROP TRIGGER fail_posting");
  assert.equal((await f.oracle(input.signals)).length, 1);
  f.db
    .prepare("UPDATE memory_content_postings SET term='wrongmarker' WHERE term='safemarker'")
    .run();
  const corrupt = { ...input, signals: collectMemorySearchSignals("wrongmarker") };
  assert.equal(queryMemoryContentIndex(f.db, corrupt), undefined);
  assert.equal(rebuildMemoryContentIndex(f.db), 1);
  assert.equal((await f.oracle(input.signals)).length, 1);
});

test("TopK tie boundary matches reference JS ordering and index survives reopening without rebuild", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 140; i++) await f.create(`boundarymarker row${i}`);
  f.db.exec(MEMORY_CONTENT_INDEX_SCHEMA_SQL);
  await f.oracle(collectMemorySearchSignals("boundarymarker"), 10);
  assert.equal(flushMemoryContentIndex(f.db), 0);
  const path = f.db.location()!;
  const reopened = new DatabaseSync(path);
  try {
    assert.equal(flushMemoryContentIndex(reopened), 0);
    const expected = await f.store.searchByContent({
      workspaceKey,
      ...collectMemorySearchSignals("boundarymarker"),
      limit: 10,
    });
    assert.deepEqual(
      queryMemoryContentIndex(reopened, {
        workspaceKey,
        signals: collectMemorySearchSignals("boundarymarker"),
        limit: 10,
      })!.map((hit) => hit.itemId),
      expected.map((record) => record.item.itemId),
    );
  } finally {
    reopened.close();
  }
});
