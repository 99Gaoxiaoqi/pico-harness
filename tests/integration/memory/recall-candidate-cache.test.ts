import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { MemoryItemWrite } from "@pico/core";
import { SqliteMemoryItemStore } from "../../../packages/storage/src/sqlite/sqlite-memory-item-store.js";
import { AtomicMemoryContextBuilder } from "../../../packages/runtime/src/atomic-memory/context-builder.js";

const workspaceKey = "cache-fixture";
const memory = (content: string): MemoryItemWrite => ({
  content,
  kind: "knowledge",
  statementType: "fact",
  temporalType: "undated",
  scopeType: "workspace",
  scopeKey: workspaceKey,
  observedAt: 1,
  origin: "user_requested",
  keys: [{ key: content, keyType: "concept", keyOrigin: "user" }],
  sources: [],
});
async function fixture(t: test.TestContext, capability = true) {
  const root = await mkdtemp(join(tmpdir(), "pico-candidate-cache-"));
  const path = join(root, "memory.sqlite");
  let store = new SqliteMemoryItemStore(path);
  const external = new SqliteMemoryItemStore(path);
  const observer = new DatabaseSync(path);
  let generation = 1;
  let scans = 0;
  let reads = 0;
  let afterRead: (() => Promise<void>) | undefined;
  // Real SQLite connection data_version observes writes from either Store connection.
  // This wrapper supplies the optional capability until the production Store owns it.
  const proxy = new Proxy(store, {
    get(_target, property) {
      if (property === "readRecallRevision")
        return capability
          ? async () =>
              `${generation}:${observer.prepare("PRAGMA data_version").get()!.data_version}`
          : undefined;
      if (property === "searchByContent")
        return async (...args: Parameters<typeof store.searchByContent>) => {
          scans++;
          return store.searchByContent(...args);
        };
      if (property === "readItem")
        return async (id: string) => {
          reads++;
          const result = await store.readItem(id);
          await afterRead?.();
          return result;
        };
      const value = Reflect.get(store, property);
      return typeof value === "function" ? value.bind(store) : value;
    },
  });
  const builder = new AtomicMemoryContextBuilder(proxy, workspaceKey);
  let operation = 0;
  const create = async (content: string) => {
    const result = await external.applyMutations({
      operationId: `create-${operation++}`,
      mutations: [{ type: "create", item: memory(content) }],
    });
    return result.results[0]!;
  };
  t.after(async () => {
    store.close();
    external.close();
    observer.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    builder,
    external,
    create,
    scans: () => scans,
    reads: () => reads,
    onRead: (callback?: () => Promise<void>) => {
      afterRead = callback;
    },
    reopen: () => {
      store.close();
      store = new SqliteMemoryItemStore(path);
      generation++;
    },
  };
}

test("candidate cache rereads identities, emits each trace and observes external update/archive/restore/delete and reopen", async (t) => {
  const f = await fixture(t);
  const item = await f.create("cachemarker original");
  const build = () => f.builder.build("cachemarker", { mode: "search", trace: {} });
  const first = await build();
  assert.ok(first.block.includes("original"));
  const scans = f.scans();
  const second = await build();
  assert.equal(f.scans(), scans);
  assert.ok(f.reads() > 0);
  assert.ok(first.trace && second.trace);
  assert.notEqual(first.trace, second.trace);
  await f.external.applyMutations({
    operationId: "edit",
    mutations: [
      {
        type: "update",
        itemId: item.itemId,
        expectedVersion: 1,
        item: memory("cachemarker revised"),
      },
    ],
  });
  assert.ok((await build()).block.includes("revised"));
  assert.ok(f.scans() > scans);
  await f.external.applyMutations({
    operationId: "archive",
    mutations: [{ type: "archive", itemId: item.itemId, expectedVersion: 2 }],
  });
  assert.equal((await build()).items.length, 0);
  await f.external.applyMutations({
    operationId: "restore",
    mutations: [{ type: "restore", itemId: item.itemId, expectedVersion: 3 }],
  });
  assert.ok((await build()).block.includes("revised"));
  const beforeReopen = f.scans();
  f.reopen();
  await build();
  assert.ok(f.scans() > beforeReopen);
  await f.external.deleteItem({ itemId: item.itemId, expectedVersion: 4, operationId: "delete" });
  assert.equal((await build()).items.length, 0);
});

test("optional capability missing disables reuse; cached empty queries and settings are invalidated by writes", async (t) => {
  const f = await fixture(t, false);
  await f.create("uncachedmarker");
  await f.builder.build("uncachedmarker", { mode: "search" });
  const scans = f.scans();
  await f.builder.build("uncachedmarker", { mode: "search" });
  assert.ok(f.scans() > scans);
  const cached = await fixture(t);
  assert.equal((await cached.builder.build("newmarker", { mode: "search" })).items.length, 0);
  await cached.create("newmarker");
  assert.equal((await cached.builder.build("newmarker", { mode: "search" })).items.length, 1);
  const settings = await cached.external.readSettings(workspaceKey);
  await cached.external.updateSettings({
    workspaceKey,
    expectedVersion: settings.version,
    enabled: false,
  });
  assert.equal((await cached.builder.build("newmarker", { mode: "search" })).items.length, 0);
});

test("revision fence retries a write during cached hydration and never revives deleted content", async (t) => {
  const f = await fixture(t);
  const item = await f.create("racemarker original");
  await f.builder.build("racemarker", { mode: "search" });
  f.onRead(async () => {
    f.onRead();
    await f.external.deleteItem({
      itemId: item.itemId,
      expectedVersion: 1,
      operationId: "racing-delete",
    });
  });
  const result = await f.builder.build("racemarker", { mode: "search", trace: {} });
  assert.equal(result.items.length, 0);
  assert.ok(!result.block.includes("original"));
});

test("candidate cache expires without writes, is bounded by LRU, and remains isolated per builder", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const f = await fixture(t);
  await f.create("ttlmarker");
  await f.builder.build("ttlmarker", { mode: "search" });
  const scans = f.scans();
  await f.builder.build("ttlmarker", { mode: "search" });
  assert.equal(f.scans(), scans);
  t.mock.timers.tick(60_001);
  await f.builder.build("ttlmarker", { mode: "search" });
  assert.ok(f.scans() > scans);
  for (let index = 0; index < 65; index++)
    await f.builder.build(`missing${index}`, { mode: "search" });
  const before = f.scans();
  await f.builder.build("ttlmarker", { mode: "search" });
  assert.ok(f.scans() > before);
  const separate = await fixture(t);
  assert.equal((await separate.builder.build("ttlmarker", { mode: "search" })).items.length, 0);
});

test("cache hits recheck current Host permission/native conditions and method identities on every delivery", async (t) => {
  const f = await fixture(t);
  const store = f.external;
  const source = { sessionId: "fixture", runId: "run", turnId: "turn", eventId: "event" };
  const settings = await store.readSettings(workspaceKey);
  const epoch = await store.executionLearning.advanceExecutionLearningInput(workspaceKey);
  await store.taskExperiences.appendTaskExperienceObservations(
    {
      taskId: "task",
      taskVersion: 1,
      workspaceKey,
      workDir: "/synthetic",
      sessionId: "fixture",
      runId: "run",
      goal: "methodmarker",
      goalSource: source,
      coverage: "complete",
      throughSequence: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    [
      {
        observationId: "observation",
        taskId: "task",
        taskVersion: 1,
        kind: "tool-result",
        source,
        sequence: 1,
        summary: "Checked current conditions",
        coverage: "complete",
        status: "succeeded",
        toolName: "bash",
        createdAt: 1,
      },
    ],
  );
  const applicability = { taskFamily: "general" as const, toolNames: [], conditions: [] };
  await store.taskExperiences.createTaskExperienceCandidate({
    candidateId: "method",
    kind: "task-lesson",
    taskId: "task",
    taskVersion: 1,
    workspaceKey,
    workDir: "/synthetic",
    sessionId: "fixture",
    runId: "run",
    failureKey: "method-key",
    inputEpoch: epoch.inputEpoch,
    settingsVersion: settings.version,
    deletionRevision: await store.readDeletionRevision(),
    state: "waiting",
    lifecycleState: "active",
    goal: "methodmarker",
    content: "",
    contentVersion: 1,
    recordRevision: 1,
    review: "unneeded",
    validation: "unknown",
    enabled: false,
    applicability,
    sources: [source],
    observationIds: ["observation"],
    createdAt: 1,
    updatedAt: 1,
  });
  await store.executionLearning.enqueueExecutionLearningJob({
    jobId: "reflect",
    workspaceKey,
    candidateId: "method",
    sessionId: "fixture",
    runId: "run",
    kind: "reflect",
    state: "ready",
    inputEpoch: epoch.inputEpoch,
    createdAt: 1,
    updatedAt: 1,
    leaseUntil: 0,
    fencingToken: 0,
  });
  const job = await store.executionLearning.claimExecutionLearningJob("worker", 200, 90_000);
  assert.ok(job);
  const pending = await store.taskExperiences.completeTaskExperienceJob({
    job,
    expectedRecordRevision: 1,
    content: "methodmarker: check current path conditions before using this suggestion.",
    representation: "method",
    applicability,
    sources: [source],
    now: 300,
  });
  assert.ok(pending);
  const approved = await store.taskExperiences.reviewTaskExperience({
    workspaceKey,
    candidateId: "method",
    expectedRecordRevision: pending.recordRevision,
    expectedContentVersion: 1,
    operationId: "accept",
    action: "accept",
    now: 400,
  });
  const reviewedExperiences = [
    {
      candidateId: approved.candidateId,
      contentVersion: approved.contentVersion,
      recordRevision: approved.recordRevision,
      itemId: approved.itemId!,
      itemVersion: 1,
      relevanceScore: 1,
    },
  ];
  let allowed = true;
  let conditionStillCurrent = true;
  let checks = 0;
  const experienceAllowed = async () => {
    checks++;
    return allowed && conditionStillCurrent;
  };
  const build = () =>
    f.builder.build("methodmarker", {
      mode: "search",
      reviewedExperiences,
      experienceAllowed,
      trace: {},
    });
  assert.equal((await build()).items.length, 1);
  const scans = f.scans();
  allowed = false;
  assert.equal((await build()).items.length, 0);
  assert.equal(f.scans(), scans);
  allowed = true;
  conditionStillCurrent = false;
  assert.equal((await build()).items.length, 0);
  assert.ok(checks >= 3);
  conditionStillCurrent = true;
  assert.equal((await build()).items.length, 1);
  await store.taskExperiences.reviewTaskExperience({
    workspaceKey,
    candidateId: "method",
    expectedRecordRevision: approved.recordRevision,
    expectedContentVersion: approved.contentVersion,
    operationId: "disable",
    action: "disable",
    now: 500,
  });
  assert.equal((await build()).items.length, 0);
});
