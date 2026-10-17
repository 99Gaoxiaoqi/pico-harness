import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectMemorySearchSignals } from "@pico/core/atomic-memory-search";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

test("中文紧邻项目名的问题通过真实持久键找全事实，仍限制作用域、归档和预算", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-t58-boundary-"));
  const path = join(root, "memory.sqlite");
  const workspaceKey = "/test/t58";
  let store = new SqliteMemoryItemStore(path);
  try {
    const facts = [
      "CedarDance场地是北桥庭院。",
      "CedarDance凭纸质预约单入场，不接受手机截屏。",
      "CedarDance禁止明火器具。",
      "CedarDance报到时间是08:35。",
      "CedarDance雨天改到石榴厅，不取消活动。",
    ];
    await store.applyMutations({
      operationId: "seed",
      mutations: [
        ...facts.map((content) => ({ content, scopeKey: workspaceKey, key: "CedarDance" })),
        { content: "别的工作区私有内容。", scopeKey: "/other", key: "CedarDance" },
        { content: "无关活动。", scopeKey: workspaceKey, key: "OtherTopic" },
      ].map(({ content, scopeKey, key }) => ({
        type: "create" as const,
        item: {
          content,
          kind: "knowledge" as const,
          statementType: "fact" as const,
          temporalType: "undated" as const,
          scopeType: "workspace" as const,
          scopeKey,
          observedAt: 1,
          origin: "user_requested" as const,
          keys: [{ key, keyType: "concept" as const, keyOrigin: "user" as const }],
          sources: [],
        },
      })),
    });
    store.close();
    store = new SqliteMemoryItemStore(path);
    const query = "列出CedarDance活动的场地、入场凭证、禁止物品、报到时间和雨天安排。";
    const signals = collectMemorySearchSignals(query);
    assert.ok(signals.tokens.includes("cedardance"));
    assert.ok(!signals.tokens.includes("cedar"));
    const builder = new AtomicMemoryContextBuilder(store, workspaceKey);
    const automatic = await builder.build(query, { trace: {} });
    assert.equal(automatic.trace?.stages.exact, 5);
    assert.ok(automatic.items.length <= 3);
    assert.ok(automatic.tokenCount <= 320);
    const search = await builder.build(query, { mode: "search", trace: {} });
    assert.deepEqual(new Set(search.items.map((r) => r.item.content)), new Set(facts));
    assert.ok(search.tokenCount <= 5120);
    assert.equal(search.trace?.stages.exact, 5);
    const retired = search.items.find((r) => r.item.content === facts[0])!;
    await store.applyMutations({
      operationId: "archive",
      mutations: [
        { type: "archive", itemId: retired.item.itemId, expectedVersion: retired.item.version },
      ],
    });
    const current = await builder.build(query, { mode: "search" });
    assert.equal(current.items.length, 4);
    assert.ok(!current.block.includes(facts[0]!));
    assert.ok(!current.block.includes("私有内容"));
    assert.ok(!current.block.includes("无关活动"));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
