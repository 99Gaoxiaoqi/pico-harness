import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { AtomicMemoryContextBuilder } from "../../../packages/runtime/src/atomic-memory/context-builder.js";

const pairs = [
  ["build", "构建"],
  ["typecheck", "类型检查"],
  ["lint", "代码规范检查"],
  ["format", "代码格式化"],
  ["dependency", "依赖"],
  ["cache", "缓存"],
  ["timeout", "超时"],
  ["pagination", "分页"],
  ["encoding", "编码"],
  ["serialization", "序列化"],
  ["migration", "数据库迁移"],
  ["deduplication", "去重"],
] as const;
for (const [english, chinese] of pairs) {
  test(`bounded aliases: ${english}/${chinese} preserve exact rank and do not expand paths or IDs`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-recall-alias-"));
    const store = new SqliteMemoryItemStore(join(root, "memory.sqlite"));
    t.after(async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const results: string[] = [];
    for (const word of [english, chinese]) {
      const saved = await store.applyMutations({
        operationId: `seed-${word}`,
        mutations: [
          {
            type: "create",
            item: {
              content: `Saved rule for ${word}.`,
              kind: "knowledge",
              statementType: "fact",
              temporalType: "undated",
              scopeType: "workspace",
              scopeKey: "w",
              observedAt: 1,
              origin: "user_requested",
              keys: [{ key: word, keyType: "concept", keyOrigin: "user" }],
              sources: [],
            },
          },
        ],
      });
      results.push(saved.results[0]!.itemId);
    }
    const builder = new AtomicMemoryContextBuilder(store, "w");
    for (const [index, query] of [english, chinese].entries()) {
      const result = await builder.build(query, { mode: "search" });
      assert.equal(result.items[0]?.item.itemId, results[index]);
      assert.ok(result.items.some(({ item }) => item.itemId === results[1 - index]));
      assert.ok(result.tokenCount <= 5120);
    }
    for (const query of [`/tmp/${english}`, `target_id=${english}`, `--${english}`]) {
      const result = await builder.build(query, { mode: "search" });
      assert.ok(!result.items.some(({ item }) => item.itemId === results[1]), query);
    }
  });
}
