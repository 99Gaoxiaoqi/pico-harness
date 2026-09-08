import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DesktopAtomicMemoryService } from "../../../src/daemon/desktop-atomic-memory-service.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import { SqliteMemoryItemStore } from "../../../src/storage/sqlite/sqlite-memory-item-store.js";

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
  for (const version of [0, 7, 8, 10]) {
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
      version === 0 ? /non-empty unversioned/ : /Automatic upgrades are not supported/,
    );
    assert.deepEqual(await readFile(path), before);
  }
});

test("fresh memory management ignores legacy workspace data and retains workspace switches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-memory-no-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"),
    picoHome = join(root, "home");
  await mkdir(workspace);
  const paths = resolvePicoPaths(workspace, { picoHome });
  await mkdir(paths.workspace.root, { recursive: true });
  const oldPath = join(paths.workspace.root, "pico.sqlite");
  const old = new DatabaseSync(oldPath);
  old.exec(
    "CREATE TABLE memory_facts(content TEXT); INSERT INTO memory_facts VALUES ('Do not import me');",
  );
  old.close();
  const before = await readFile(oldPath);
  const service = new DesktopAtomicMemoryService({ picoHome, publish: () => {} });
  try {
    assert.deepEqual((await service.list(workspace, { workspacePath: workspace })).facts, []);
    const created = await service.create(workspace, "Current memory only");
    assert.equal(created.fact.content, "Current memory only");
    const current = await service.getSettings(workspace);
    await service.updateSettings(workspace, {
      workspacePath: workspace,
      expectedVersion: current.settings.version,
      idempotencyKey: "disable-memory",
      enabled: false,
    });
    assert.equal((await service.getSettings(workspace)).settings.enabled, false);
    assert.deepEqual(await readFile(oldPath), before);
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
    assert.equal(names.length, 9);
    assert.ok(names.includes("memory_settings"));
    for (const name of retiredTables) assert.equal(names.includes(name), false, name);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
}
