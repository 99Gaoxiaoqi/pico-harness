#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

// Run after building core, storage and runtime. No models or user databases are used.
const ITEM_COUNT = 10_000;
const QUERY_COUNT = 100;
const WARMUP_COUNT = 10;
const P95_LIMIT_MS = 200;
const workspaceKey = "/benchmark/atomic-memory-recall";
const directory = await mkdtemp(join(tmpdir(), "pico-memory-recall-benchmark-"));
const store = new SqliteMemoryItemStore(join(directory, "memory.sqlite"));
const paragraph =
  "This is a local architecture background note about bounded context, durable records and project handoff. 这是普通背景说明，包含存储和项目开发的日常记录。 ";
try {
  for (let offset = 0; offset < ITEM_COUNT; offset += 32) {
    await store.applyMutations({
      operationId: `seed-${offset}`,
      mutations: Array.from({ length: Math.min(32, ITEM_COUNT - offset) }, (_, position) => {
        const index = offset + position;
        const marker = `savedmarker-${index}`;
        const background = Array.from(paragraph.repeat(20))
          .slice(0, 1_999 - marker.length)
          .join("");
        return {
          type: "create",
          item: {
            content: `${background} ${marker}`,
            kind: "knowledge",
            statementType: "fact",
            temporalType: "undated",
            scopeType: "workspace",
            scopeKey: workspaceKey,
            observedAt: 1,
            origin: "agent_extracted",
            keys: [{ key: "background", keyType: "concept", keyOrigin: "llm" }],
            sources: [
              {
                sessionId: "seed-session",
                runId: "seed-run",
                turnId: "seed-turn",
                eventId: `source-${index}`,
              },
            ],
          },
        };
      }),
    });
  }
  const builder = new AtomicMemoryContextBuilder(store, workspaceKey);
  const query = async (index) => {
    const marker = `savedmarker-${index}`;
    const result = await builder.build(marker, { mode: "search" });
    assert.equal(result.items.length, 1);
    assert.ok(result.references[0].content.includes(marker));
    assert.ok(result.tokenCount <= 1_600);
  };
  for (let index = 0; index < WARMUP_COUNT; index++) await query(index);
  const timings = [];
  for (let index = 0; index < QUERY_COUNT; index++) {
    const start = performance.now();
    await query(Math.floor((index * ITEM_COUNT) / QUERY_COUNT));
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  const percentile = (fraction) => timings[Math.ceil(timings.length * fraction) - 1];
  const p95Ms = percentile(0.95);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        itemCount: ITEM_COUNT,
        itemCodePoints: 2_000,
        warmupQueries: WARMUP_COUNT,
        measuredQueries: QUERY_COUNT,
        mode: "search",
        includes:
          "SQLite candidate discovery, ranking, excerpts, tokenizer and final context formatting",
        p50Ms: Number(percentile(0.5).toFixed(2)),
        p95Ms: Number(p95Ms.toFixed(2)),
        maxMs: Number(timings.at(-1).toFixed(2)),
        p95LimitMs: P95_LIMIT_MS,
        passed: p95Ms <= P95_LIMIT_MS,
      },
      null,
      2,
    ),
  );
  if (p95Ms > P95_LIMIT_MS) process.exitCode = 1;
} finally {
  store.close();
  await rm(directory, { recursive: true, force: true });
}
