import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { DesktopAtomicMemoryService } from "@pico/pico-host/desktop-atomic-memory-service";
import { resolvePicoPaths } from "@pico/pico-host";

const source = (eventId: string) => ({
  sessionId: "lesson-session",
  runId: "lesson-run",
  turnId: "lesson-turn",
  eventId,
});

test("v9 memory upgrades without rewriting existing items; pending lessons survive restart and only confirmed execution evidence is recalled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-lesson-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home");
  await mkdir(workDir);
  await mkdir(picoHome);
  const key = resolvePicoPaths(workDir, { picoHome }).workspace.id;
  const path = join(picoHome, "memory.sqlite");
  let store = new SqliteMemoryItemStore(path);
  const legacy = await store.applyMutations({
    operationId: "legacy",
    mutations: [
      {
        type: "create",
        item: {
          content: "LegacyKeep",
          kind: "note",
          statementType: "fact",
          temporalType: "undated",
          scopeType: "workspace",
          scopeKey: key,
          observedAt: 1,
          origin: "user_requested",
          keys: [{ key: "LegacyKeep", keyType: "exact", keyOrigin: "user" }],
          sources: [],
        },
      },
    ],
  });
  const before = await store.readItem(legacy.results[0]!.itemId);
  store.close();
  const v9 = new DatabaseSync(path);
  const learningTables = v9
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE 'execution_learning_%' OR name LIKE 'task_experience_%' OR name LIKE 'experience_%')",
    )
    .all();
  v9.exec("PRAGMA foreign_keys=OFF");
  for (const row of learningTables) v9.exec(`DROP TABLE ${String(row.name)}`);
  v9.exec("DROP TABLE execution_lesson_candidates; PRAGMA user_version=9");
  v9.close();
  store = new SqliteMemoryItemStore(path);
  assert.deepEqual(await store.readItem(legacy.results[0]!.itemId), before);
  const settings = await store.readSettings(key);
  const request = {
    candidateId: "pending-lesson",
    workspaceKey: key,
    sessionId: "lesson-session",
    content: "BuildCheck expects its project config in the current working directory.",
    taskFamily: "BuildCheck",
    commandHash: createHash("sha256").update("node check.cjs").digest("hex"),
    evidenceBoundary: 0,
    failure: source("failure"),
    observedAt: 1,
    deletionRevision: 0,
    settingsVersion: settings.version,
  };
  const candidate = await store.createExecutionLesson(request);
  const pending = await store.verifyExecutionLesson({
    candidateId: candidate.candidateId,
    expectedVersion: candidate.version,
    workspaceKey: key,
    sessionId: "lesson-session",
    verifications: [source("v1"), source("v2")],
    observedAt: 2,
  });
  assert.equal(pending.state, "candidate");
  assert.equal(
    (await new AtomicMemoryContextBuilder(store, key).build("BuildCheck")).items.length,
    0,
  );
  store.close();
  store = new SqliteMemoryItemStore(path);
  assert.deepEqual(await store.readExecutionLesson(candidate.candidateId), pending);
  const confirmed = await store.verifyExecutionLesson({
    candidateId: candidate.candidateId,
    expectedVersion: pending.version,
    workspaceKey: key,
    sessionId: "lesson-session",
    verifications: [source("v1"), source("v2"), source("v3")],
    observedAt: 3,
  });
  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.verifications.length, 3);
  assert.equal((await store.createExecutionLesson(request)).itemId, confirmed.itemId);
  await assert.rejects(
    store.createExecutionLesson({ ...request, content: "BuildCheck needs a different config." }),
    /Confirmed execution lessons cannot be revised/,
  );
  assert.equal((await store.readItem(confirmed.itemId!))?.item.content, request.content);
  const recall = await new AtomicMemoryContextBuilder(store, key).build("BuildCheck", {
    trace: {},
  });
  assert.equal(recall.references[0]?.source, "execution-evidence");
  assert.equal(recall.trace?.selected[0]?.source, "execution-evidence");
  assert.match(recall.block, /source="execution-evidence"/);
  assert.equal((await store.readItem(confirmed.itemId!))?.executionEvidence?.verificationCount, 3);
  const archived = await store.applyMutations({
    operationId: "archive",
    mutations: [{ type: "archive", itemId: confirmed.itemId!, expectedVersion: 1 }],
  });
  await store.applyMutations({
    operationId: "restore",
    mutations: [
      { type: "restore", itemId: confirmed.itemId!, expectedVersion: archived.results[0]!.version },
    ],
  });
  assert.ok((await store.readItem(confirmed.itemId!))?.executionEvidence);
  const management = new DesktopAtomicMemoryService({ picoHome, publish: () => {} });
  const visible = await management.get(workDir, confirmed.itemId!);
  assert.equal(visible.item.executionEvidence?.verificationCount, 3);
  await management.update(workDir, {
    workspacePath: workDir,
    itemId: confirmed.itemId!,
    expectedVersion: visible.item.version,
    idempotencyKey: "manual-edit",
    content: "BuildCheck now follows a different project config.",
  });
  assert.equal((await store.readItem(confirmed.itemId!))?.executionEvidence, undefined);
  assert.equal((await store.readExecutionLesson(candidate.candidateId))?.state, "invalidated");
  management.close();
  store.close();
});

test("execution lessons deduplicate votes and survive commit replay; deletion and policy changes cannot revive or confirm old candidates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-lesson-forget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "memory.sqlite");
  let store = new SqliteMemoryItemStore(path);
  const make = (candidateId: string) => ({
    candidateId,
    workspaceKey: "workspace",
    sessionId: "lesson-session",
    content: "ForgetCanary BuildCheck expects a local config.",
    taskFamily: "BuildCheck",
    commandHash: "a".repeat(64),
    evidenceBoundary: 0,
    failure: source("failure"),
    observedAt: 1,
    deletionRevision: 0,
    settingsVersion: 1,
  });
  const candidate = await store.createExecutionLesson(make("dedup"));
  const votes = [source("v1"), source("v1"), source("v2")];
  const pending = await store.verifyExecutionLesson({
    candidateId: candidate.candidateId,
    expectedVersion: 1,
    workspaceKey: "workspace",
    sessionId: "lesson-session",
    verifications: votes,
    observedAt: 2,
  });
  assert.equal(pending.verifications.length, 2);
  await store.createExecutionLesson(make("stale"));
  store.close();
  let crash = true;
  store = new SqliteMemoryItemStore(path, {
    failpoint: (point) => {
      if (point === "after_commit" && crash) {
        crash = false;
        throw new Error("after-commit crash");
      }
    },
  });
  const confirm = {
    candidateId: candidate.candidateId,
    expectedVersion: pending.version,
    workspaceKey: "workspace",
    sessionId: "lesson-session",
    verifications: [source("v3")],
    observedAt: 3,
  };
  await assert.rejects(store.verifyExecutionLesson(confirm), /after-commit/);
  const replay = await store.verifyExecutionLesson(confirm);
  assert.equal(replay.state, "confirmed");
  assert.equal((await store.listItems({ workspaceKey: "workspace" })).length, 1);
  const second = new SqliteMemoryItemStore(path);
  await second.deleteItem({ itemId: replay.itemId!, expectedVersion: 1, operationId: "forget" });
  assert.equal((await store.readExecutionLesson(candidate.candidateId))?.content, "");
  assert.equal((await store.readExecutionLesson(candidate.candidateId))?.state, "deleted");
  await assert.rejects(store.verifyExecutionLesson(confirm), /deleted/i);
  await assert.rejects(
    store.verifyExecutionLesson({
      ...confirm,
      candidateId: "stale",
      expectedVersion: 1,
      verifications: [source("v1"), source("v2"), source("v3")],
    }),
    /deleted/i,
  );
  const settings = await second.readSettings("workspace");
  await second.createExecutionLesson({ ...make("policy"), deletionRevision: 1 });
  await second.updateSettings({
    workspaceKey: "workspace",
    expectedVersion: settings.version,
    autoExtract: false,
  });
  await assert.rejects(
    store.verifyExecutionLesson({
      ...confirm,
      candidateId: "policy",
      expectedVersion: 1,
      verifications: [source("v1"), source("v2"), source("v3")],
    }),
    /policy changed/,
  );
  assert.equal((await store.listItems({ workspaceKey: "workspace" })).length, 0);
  second.close();
  store.close();
  const db = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    String(
      db
        .prepare("SELECT record_json FROM execution_lesson_candidates WHERE candidate_id='dedup'")
        .get()!.record_json,
    ).includes("ForgetCanary"),
    false,
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});
