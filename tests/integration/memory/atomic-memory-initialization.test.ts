import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DesktopAtomicMemoryService } from "@pico/pico-host/desktop-atomic-memory-service";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

const retiredTables = [
  "memory_workspace_migrations",
  "memory_migration_source_events",
  "memory_migration_origins",
  "memory_item_source_history",
  "memory_forgotten_sources",
  "memory_suppressed_events",
  "memory_forget_operations",
];
test("opening an incompatible memory database rejects it without upgrading or clearing it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-memory-incompatible-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const version of [0, 7, 8, 21]) {
    const path = join(root, `memory-${version}.sqlite`);
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE existing_data(content TEXT); INSERT INTO existing_data VALUES ('Keep this data');",
    );
    db.exec(`PRAGMA user_version = ${version}`);
    db.close();
    const before = await readFile(path);
    assert.throws(
      () => new SqliteMemoryItemStore(path),
      version === 0
        ? /non-empty unversioned/
        : /Only schemas 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 and 19 can be upgraded automatically/,
    );
    assert.deepEqual(await readFile(path), before);
  }
});

test("a real v16 memory schema upgrades while preserving facts, settings, and experience", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-memory-v16-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "memory.sqlite");
  const fixture = await readFile(new URL("./fixtures/memory-v16.sql", import.meta.url), "utf8");
  const before = new DatabaseSync(path);
  before.exec(fixture);
  assert.equal(before.prepare("PRAGMA user_version").get()?.user_version, 16);
  const itemBefore = before
    .prepare(
      "SELECT item_id,content,content_hash FROM memory_items WHERE content='Historical v16 fact fixture'",
    )
    .get();
  const settingsBefore = before
    .prepare("SELECT * FROM memory_settings WHERE workspace_key='fixture-workspace'")
    .get();
  const experienceBefore = before
    .prepare("SELECT * FROM execution_learning_candidates WHERE candidate_id='fixture-experience'")
    .get();
  before.close();

  const store = new SqliteMemoryItemStore(path);
  try {
    assert.equal(store.schemaVersion(), 20);
  } finally {
    store.close();
  }
  const after = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(
      after
        .prepare(
          "SELECT item_id,content,content_hash FROM memory_items WHERE content='Historical v16 fact fixture'",
        )
        .get(),
      itemBefore,
    );
    assert.deepEqual(
      after.prepare("SELECT * FROM memory_settings WHERE workspace_key='fixture-workspace'").get(),
      settingsBefore,
    );
    assert.deepEqual(
      after
        .prepare(
          "SELECT * FROM execution_learning_candidates WHERE candidate_id='fixture-experience'",
        )
        .get(),
      experienceBefore,
    );
    assert.ok(
      after
        .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_extraction_jobs'")
        .get(),
    );
    assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    after.close();
  }
});

test("fresh memory management retains workspace switches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-memory-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"),
    picoHome = join(root, "home");
  await mkdir(workspace);
  const service = new DesktopAtomicMemoryService({ picoHome, publish: () => {} });
  try {
    assert.deepEqual((await service.list(workspace, { workspacePath: workspace })).items, []);
    const created = await service.create(workspace, "Current memory only");
    assert.equal(created.item.content, "Current memory only");
    const current = await service.getSettings(workspace);
    await service.updateSettings(workspace, {
      workspacePath: workspace,
      expectedVersion: current.settings.version,
      idempotencyKey: "disable-memory",
      enabled: false,
    });
    assert.equal((await service.getSettings(workspace)).settings.enabled, false);
  } finally {
    service.close();
  }
  assertCurrentTables(join(picoHome, "memory.sqlite"));
});

function assertCurrentTables(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const names = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    assert.equal(names.length, 33);
    assert.ok(names.includes("execution_learning_native_facts"));
    assert.equal(names.includes("execution_lesson_candidates"), false);
    assert.ok(names.includes("memory_settings"));
    assert.ok(names.includes("memory_consolidation_state"));
    assert.ok(names.includes("memory_consolidation_receipts"));
    assert.ok(names.includes("experience_uses"));
    assert.equal(names.includes("task_experience_reuse"), false);
    for (const name of retiredTables) assert.equal(names.includes(name), false, name);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
}
