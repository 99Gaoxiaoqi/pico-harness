#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

// Build this checkout's core/storage/runtime first. Only fresh temporary synthetic databases.
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sizeIndex = process.argv.indexOf("--size");
if (sizeIndex === -1) {
  const sizes = (process.env.MEMORY_BENCHMARK_SIZES ?? "1000,10000,50000").split(",").map(Number);
  const results = sizes.map((size) => {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--size", String(size)],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (child.status !== 0) throw new Error(child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  });
  console.log(JSON.stringify({ schemaVersion: 1, results }, null, 2));
  process.exit(0);
}
const size = Number(process.argv[sizeIndex + 1]);
assert.ok(Number.isSafeInteger(size) && size >= 100);
const workspaceKey = "/synthetic/recall/primary";
const directory = await mkdtemp(join(tmpdir(), "pico-memory-recall-benchmark-"));
const path = join(directory, "memory.sqlite");
const store = new SqliteMemoryItemStore(path, { now: () => 1000 });
const fixtureHash = createHash("sha256");
const source = (id) => ({
  sessionId: "synthetic-session",
  runId: "synthetic-run",
  turnId: "synthetic-turn",
  eventId: id,
});
let counters;
// Count actual SQLite rows yielded to JS for body-scoring scans, not the truncated top-100.
// Wrapping iterate changes neither SQL nor ordering. The original method is always restored.
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = originalPrepare.call(this, sql);
  if (/SELECT\s+item_id,\s*content,\s*updated_at\s+FROM\s+memory_items/iu.test(sql)) {
    const originalIterate = statement.iterate;
    statement.iterate = function* (...args) {
      if (counters) counters.bodyScanCalls++;
      for (const row of originalIterate.apply(this, args)) {
        if (counters) counters.bodyRowsScored++;
        yield row;
      }
    };
  }
  return statement;
};
const contentSearch = store.searchByContent.bind(store);
store.searchByContent = async (...args) => {
  if (counters) counters.contentSearchCalls++;
  const start = performance.now();
  try {
    return await contentSearch(...args);
  } finally {
    if (counters) counters.contentSearchMs += performance.now() - start;
  }
};
const originalKeys = store.searchByKeys.bind(store);
store.searchByKeys = async (...args) => {
  const rows = await originalKeys(...args);
  if (counters) counters.keyRowsReturned += rows.length;
  return rows;
};
const originalList = store.listItems.bind(store);
store.listItems = async (...args) => {
  const rows = await originalList(...args);
  if (counters) counters.residentRowsReturned += rows.length;
  return rows;
};
try {
  const seedStart = performance.now();
  const paragraph =
    "Project architecture background: bounded context, durable records and handoff. 普通背景记录，关于存储和项目开发。 ";
  for (let offset = 0; offset < size; offset += 32) {
    const mutations = Array.from({ length: Math.min(32, size - offset) }, (_, position) => {
      const index = offset + position;
      const marker = `savedmarker${index}`;
      const content = `${paragraph.repeat(30).slice(0, 1900)} ${marker} 星河编号${index}终点`;
      const item = {
        content,
        kind: "knowledge",
        statementType: "fact",
        temporalType: "undated",
        scopeType: index % 10 === 9 ? "global" : "workspace",
        scopeKey:
          index % 10 === 9
            ? undefined
            : index % 10 === 8
              ? "/synthetic/recall/other"
              : workspaceKey,
        observedAt: 1,
        origin: "agent_extracted",
        keys: [{ key: index % 2 ? marker : "background", keyType: "concept", keyOrigin: "llm" }],
        sources: [source(`source-${index}`)],
      };
      fixtureHash.update(JSON.stringify(item));
      return { type: "create", item };
    });
    await store.applyMutations({ operationId: `seed-${offset}`, mutations });
  }
  const reviewedExperiences = [];
  // Small real method/case mix through production APIs; no SQL insertion shortcuts.
  for (let index = 0; index < 40; index++) {
    const id = `experience-${index}`;
    const settings = await store.readSettings(workspaceKey);
    const epoch = await store.executionLearning.advanceExecutionLearningInput(workspaceKey);
    const sources = [source(id)];
    const candidate = {
      candidateId: id,
      kind: "task-lesson",
      taskId: id,
      taskVersion: 1,
      workspaceKey,
      workDir: "/synthetic",
      sessionId: "synthetic-session",
      runId: "synthetic-run",
      failureKey: id,
      inputEpoch: epoch.inputEpoch,
      settingsVersion: settings.version,
      deletionRevision: await store.readDeletionRevision(),
      state: "waiting",
      lifecycleState: "active",
      goal: `Synthetic project handoff ${index}`,
      content: "",
      contentVersion: 1,
      recordRevision: 1,
      review: "unneeded",
      validation: "unknown",
      enabled: false,
      applicability: { taskFamily: "general", toolNames: [], conditions: [] },
      sources,
      observationIds: [id],
      createdAt: 100,
      updatedAt: 100,
    };
    await store.taskExperiences.appendTaskExperienceObservations(
      {
        taskId: id,
        taskVersion: 1,
        workspaceKey,
        workDir: "/synthetic",
        sessionId: "synthetic-session",
        runId: "synthetic-run",
        goal: candidate.goal,
        goalSource: sources[0],
        coverage: "complete",
        throughSequence: 1,
        createdAt: 100,
        updatedAt: 100,
      },
      [
        {
          observationId: id,
          taskId: id,
          taskVersion: 1,
          kind: "tool-result",
          source: sources[0],
          sequence: 1,
          summary: "Synthetic check succeeded",
          coverage: "complete",
          status: "succeeded",
          toolName: "bash",
          createdAt: 100,
        },
      ],
    );
    await store.taskExperiences.createTaskExperienceCandidate(candidate);
    await store.executionLearning.enqueueExecutionLearningJob({
      jobId: id,
      workspaceKey,
      candidateId: id,
      sessionId: "synthetic-session",
      runId: "synthetic-run",
      kind: "reflect",
      state: "ready",
      inputEpoch: epoch.inputEpoch,
      createdAt: 100,
      updatedAt: 100,
      leaseUntil: 0,
      fencingToken: 0,
    });
    const job = await store.executionLearning.claimExecutionLearningJob("benchmark", 200, 90000);
    assert.ok(job);
    const representation = index % 2 ? "case" : "method";
    const content = `Synthetic handoff ${representation} savedmarker${index * 10 + 1}: check current scope before proceeding.`;
    fixtureHash.update(JSON.stringify({ candidate, representation, content }));
    const pending = await store.taskExperiences.completeTaskExperienceJob({
      job,
      expectedRecordRevision: 1,
      content,
      representation,
      applicability: candidate.applicability,
      sources,
      now: 300,
    });
    assert.ok(pending);
    if (representation === "method") {
      const approved = await store.taskExperiences.reviewTaskExperience({
        workspaceKey,
        candidateId: id,
        expectedRecordRevision: pending.recordRevision,
        expectedContentVersion: 1,
        operationId: `approve-${id}`,
        action: "accept",
        now: 400,
      });
      reviewedExperiences.push({
        candidateId: id,
        contentVersion: approved.contentVersion,
        recordRevision: approved.recordRevision,
        maturity: "active",
        relevanceScore: 1,
        requiredPrefixLength: 0,
      });
    }
  }
  const seedMs = performance.now() - seedStart;
  const queries = Array.from({ length: 40 }, (_, index) => {
    const target = Math.floor((index * size) / 40 / 10) * 10 + (index % 2 ? 1 : 2);
    return {
      query:
        index >= 30
          ? `absentmarker${index}`
          : index >= 20
            ? `星河编号${target}终点`
            : `savedmarker${target}`,
      target: index >= 30 ? null : target,
    };
  });
  fixtureHash.update(JSON.stringify(queries));
  const builder = new AtomicMemoryContextBuilder(store, workspaceKey);
  const run = async (entry, phase, repetition, queryIndex) => {
    counters = {
      contentSearchCalls: 0,
      bodyScanCalls: 0,
      bodyRowsScored: 0,
      contentSearchMs: 0,
      keyRowsReturned: 0,
      residentRowsReturned: 0,
    };
    const start = performance.now();
    const result = await builder.build(entry.query, { mode: "search", reviewedExperiences });
    const elapsedMs = performance.now() - start;
    assert.ok(result.tokenCount <= 5120);
    if (entry.target !== null)
      assert.ok(
        result.references.some((ref) => ref.content.includes(entry.query)),
        `missing ${entry.query}`,
      );
    const sample = {
      phase,
      repetition,
      queryIndex,
      query: entry.query,
      elapsedMs,
      ...counters,
      selectedItems: result.items.length,
      rssBytes: process.memoryUsage().rss,
    };
    counters = undefined;
    return sample;
  };
  const cold = await run(queries[0], "cold-process-first-build", 0, 0);
  const samples = [];
  for (let repetition = 0; repetition < 5; repetition++)
    for (let index = 0; index < queries.length; index++)
      samples.push(await run(queries[index], "warm", repetition, index));
  const percentile = (values, p) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  const total = samples.map((s) => s.elapsedMs),
    pure = samples.map((s) => s.contentSearchMs);
  const mutationQuery = { query: "freshmutationmarker", target: null };
  const writeStart = performance.now();
  const created = await store.applyMutations({
    operationId: "benchmark-write",
    mutations: [
      {
        type: "create",
        item: {
          content: mutationQuery.query,
          kind: "knowledge",
          statementType: "fact",
          temporalType: "undated",
          scopeType: "workspace",
          scopeKey: workspaceKey,
          observedAt: 1,
          origin: "user_requested",
          keys: [{ key: mutationQuery.query, keyType: "concept", keyOrigin: "deterministic" }],
          sources: [],
        },
      },
    ],
  });
  const writeMs = performance.now() - writeStart;
  const afterWrite = await run(mutationQuery, "after-write", 0, 0);
  const inserted = await builder.build(mutationQuery.query, { mode: "search" });
  assert.ok(inserted.items.some((record) => record.item.itemId === created.results[0].itemId));
  const deleteStart = performance.now();
  await store.deleteItem({
    itemId: created.results[0].itemId,
    expectedVersion: 1,
    operationId: "benchmark-delete",
  });
  const deleteMs = performance.now() - deleteStart;
  const afterDelete = await run(mutationQuery, "after-delete", 0, 0);
  const deleted = await builder.build(mutationQuery.query, { mode: "search" });
  assert.ok(!deleted.items.some((record) => record.item.itemId === created.results[0].itemId));
  const summarize = (values) => ({
    count: values.length,
    p50Ms: percentile(
      values.map((sample) => sample.elapsedMs),
      0.5,
    ),
    p95Ms: percentile(
      values.map((sample) => sample.elapsedMs),
      0.95,
    ),
    contentSearchP50Ms: percentile(
      values.map((sample) => sample.contentSearchMs),
      0.5,
    ),
    contentSearchP95Ms: percentile(
      values.map((sample) => sample.contentSearchMs),
      0.95,
    ),
    contentSearchCalls: values.reduce((sum, sample) => sum + sample.contentSearchCalls, 0),
    bodyRowsScored: values.reduce((sum, sample) => sum + sample.bodyRowsScored, 0),
  });
  const firstQueries = summarize([
    cold,
    ...samples.filter((sample) => sample.repetition === 0 && sample.queryIndex !== 0),
  ]);
  const repeatedQueries = summarize(samples.filter((sample) => sample.repetition > 0));
  const sizing = new DatabaseSync(path);
  let logicalDatabaseBytes;
  try {
    logicalDatabaseBytes =
      sizing.prepare("PRAGMA page_count").get().page_count *
      sizing.prepare("PRAGMA page_size").get().page_size;
  } finally {
    sizing.close();
  }
  let walBytes = 0;
  try {
    walBytes = (await stat(`${path}-wal`)).size;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  console.log(
    JSON.stringify(
      {
        firstQueries,
        repeatedQueries,
        logicalDatabaseBytes,
        walBytes,
        mutations: { writeMs, deleteMs, afterWrite, afterDelete },
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        factCount: size,
        methodCount: 20,
        caseCount: 20,
        workspaceDistribution: "80% primary,10% other,10% global facts; all experiences primary",
        fixtureHash: fixtureHash.digest("hex"),
        queryHash: hash(JSON.stringify(queries)),
        includes:
          "production SQLite discovery/ranking, excerpts, tokenizer and final builder output; case records stored but never injected as methods",
        scanCounterDefinition:
          "actual JS rows yielded by production full-content-scoring SELECT iterate; returned key/resident rows separately; no SQLite VM-step estimate",
        cold,
        seedMs,
        databaseBytes: (await stat(path)).size,
        p50Ms: percentile(total, 0.5),
        p95Ms: percentile(total, 0.95),
        contentSearchP50Ms: percentile(pure, 0.5),
        contentSearchP95Ms: percentile(pure, 0.95),
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
        totalBodyRowsScored: samples.reduce((n, s) => n + s.bodyRowsScored, 0),
        samples,
      },
      null,
      2,
    ),
  );
} finally {
  DatabaseSync.prototype.prepare = originalPrepare;
  store.close();
  await rm(directory, { recursive: true, force: true });
}
