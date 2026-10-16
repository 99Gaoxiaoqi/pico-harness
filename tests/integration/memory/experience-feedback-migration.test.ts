import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LEGACY_LESSON_SCHEMA_SQL } from "../helpers/legacy-memory-schema.js";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

async function v12(path: string, corrupt = false) {
  const store = new SqliteMemoryItemStore(path);
  const result = await store.applyMutations({
    operationId: "seed",
    mutations: [
      {
        type: "create",
        item: {
          content: "已有经验方法",
          kind: "failure",
          statementType: "fact",
          temporalType: "undated",
          scopeType: "workspace",
          scopeKey: "workspace",
          observedAt: 100,
          origin: "user_requested",
          keys: [{ key: "经验", keyType: "concept", keyOrigin: "deterministic" }],
          sources: [],
        },
      },
    ],
  });
  const itemId = result.results[0]!.itemId;
  const settings = await store.readSettings("workspace");
  await store.updateSettings({
    workspaceKey: "workspace",
    expectedVersion: settings.version,
    autoExtract: false,
  });
  store.close();
  const db = new DatabaseSync(path);
  db.exec(LEGACY_LESSON_SCHEMA_SQL);
  db.exec(
    "DROP TABLE experience_diagnostics; DROP TABLE experience_effects; DROP TABLE experience_feedback; DROP TABLE experience_uses; CREATE TABLE task_experience_reuse(reuse_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,session_id TEXT NOT NULL,candidate_id TEXT NOT NULL,content_version INTEGER NOT NULL,record_json TEXT NOT NULL); CREATE INDEX task_experience_reuse_scope ON task_experience_reuse(workspace_key,session_id); PRAGMA user_version=12",
  );
  const old = {
    reuseId: "old-use",
    workspaceKey: "workspace",
    candidateId: "old-candidate",
    contentVersion: 2,
    itemId,
    itemVersion: 1,
    taskId: "task",
    taskVersion: 1,
    sessionId: "session",
    runId: "run",
    referenceHash: "a".repeat(64),
    referenceContent: "历史实际引用",
    adoption: "observed",
    validation: "pass",
    excluded: false,
    sources: [],
    createdAt: 100,
    updatedAt: 200,
  };
  db.prepare("INSERT INTO task_experience_reuse VALUES(?,?,?,?,?,?)").run(
    old.reuseId,
    old.workspaceKey,
    old.sessionId,
    old.candidateId,
    old.contentVersion,
    corrupt ? "broken-json" : JSON.stringify(old),
  );
  db.close();
  return itemId;
}
test("v12 receipts migrate once without inventing delivery; existing items and switches survive", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pico-feedback-upgrade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "memory.sqlite");
  const itemId = await v12(path);
  for (let i = 0; i < 2; i++) {
    const store = new SqliteMemoryItemStore(path);
    assert.equal(store.schemaVersion(), 19);
    assert.equal((await store.readItem(itemId))?.item.content, "已有经验方法");
    assert.equal((await store.readSettings("workspace")).autoExtract, false);
    store.close();
    const db = new DatabaseSync(path);
    const rows = db.prepare("SELECT record_json FROM experience_uses").all();
    assert.equal(rows.length, 1);
    const use = JSON.parse(String(rows[0]!.record_json));
    assert.equal(use.useId, "old-use");
    assert.equal(use.historical, true);
    assert.equal(use.delivery, "unknown");
    assert.equal(use.validation, "pass");
    assert.equal(use.recallEventId, undefined);
    assert.equal(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name='task_experience_reuse'").get(),
      undefined,
    );
    db.close();
  }
});
test("failed migration leaves v12 receipts and version intact", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pico-feedback-upgrade-fail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "memory.sqlite");
  await v12(path, true);
  assert.throws(() => new SqliteMemoryItemStore(path));
  const db = new DatabaseSync(path);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 12);
  assert.equal(db.prepare("SELECT count(*) AS n FROM task_experience_reuse").get()?.n, 1);
  assert.equal(
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name='experience_uses'").get(),
    undefined,
  );
  db.close();
});
