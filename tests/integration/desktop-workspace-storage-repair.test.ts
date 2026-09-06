import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDesktopWorkspaceStorageRecovery } from "../../apps/desktop/src/main/workspace-storage-recovery.js";
import type { RuntimeClientAdapter } from "../../apps/desktop/src/main/runtime-client-adapter.js";
import { WorkspaceStorageRepairService } from "../../src/daemon/workspace-storage-repair.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { prepareCurrentWorkspaceSqliteStorageSync } from "../../src/storage/sqlite/workspace-scopes.js";
import { acquireOperationalDatabase } from "../../src/storage/sqlite/sqlite-database.js";
import {
  DESKTOP_RUNTIME_METHODS,
  parseStrictRuntimeParams,
  parseRuntimeResult,
  RuntimeProtocolError,
  RUNTIME_ERROR_CODES,
  type RuntimeMethod,
} from "../../packages/protocol/src/runtime.js";

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pico-desktop-storage-repair-")));
  const home = join(base, "home");
  const workspace = join(base, "project");
  mkdirSync(workspace);
  const source = join(base, "source");
  const prepared = prepareCurrentWorkspaceSqliteStorageSync(source);
  prepared.lease.database
    .prepare("INSERT INTO workspace_kv (key, value_json) VALUES (?, ?)")
    .run("todo.json", '{"tasks":["保留我的任务"]}');
  const storageRootId = prepared.rootIdentity.storageRootId;
  prepared.lease.release();
  writeFileSync(join(source, "evidence.txt"), "keep original evidence");
  const root = resolvePicoPaths(workspace, { picoHome: home }).workspace.root;
  cpSync(source, root, { recursive: true });
  const service = new WorkspaceStorageRepairService(home);
  const runtime: Pick<RuntimeClientAdapter, "request"> = {
    async request(method, params) {
      if (method === "workspace.storageRepair.prepare") {
        return parseRuntimeResult(
          method,
          service.prepare(
            parseStrictRuntimeParams("workspace.storageRepair.prepare", params).workspacePath,
          ),
        );
      }
      if (method === "workspace.storageRepair.respond") {
        return parseRuntimeResult(
          method,
          service.respond(parseStrictRuntimeParams("workspace.storageRepair.respond", params)),
        );
      }
      throw new Error(`Unexpected request ${method}`);
    },
  };
  return {
    base,
    root,
    source,
    workspace,
    storageRootId,
    runtime,
    service,
    dbPath: join(root, "pico.sqlite"),
  };
}

function businessRecords(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name != 'workspace_storage_binding' ORDER BY name",
      )
      .all();
    return tables.map(({ name }) => [
      name,
      db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all(),
    ]);
  } finally {
    db.close();
  }
}

test("Desktop storage repair: cancellation is read-only, confirmation preserves data and identity, duplicate opens share one dialog", async () => {
  const f = fixture();
  try {
    const bytes = readFileSync(f.dbPath);
    const records = businessRecords(f.dbPath);
    let dialogs = 0;
    const cancel = createDesktopWorkspaceStorageRecovery({
      runtime: f.runtime,
      confirmRepair: async () => {
        dialogs++;
        return false;
      },
    });
    const cancelled = await Promise.allSettled([cancel(f.workspace), cancel(f.workspace)]);
    assert.equal(dialogs, 1);
    assert.ok(cancelled.every((result) => result.status === "rejected"));
    assert.deepEqual(readFileSync(f.dbPath), bytes);
    assert.deepEqual(businessRecords(f.dbPath), records);

    const confirm = createDesktopWorkspaceStorageRecovery({
      runtime: f.runtime,
      confirmRepair: async (workspace, storagePath) => {
        dialogs++;
        assert.equal(workspace, f.workspace);
        assert.equal(storagePath, f.root);
        return true;
      },
    });
    await Promise.all([confirm(f.workspace), confirm(f.workspace)]);
    assert.equal(dialogs, 2);
    assert.deepEqual(businessRecords(f.dbPath), records);
    assert.equal(readFileSync(join(f.root, "evidence.txt"), "utf8"), "keep original evidence");
    const reopened = prepareCurrentWorkspaceSqliteStorageSync(f.root);
    assert.equal(reopened.rootIdentity.storageRootId, f.storageRootId);
    assert.equal(reopened.rootIdentity.canonicalPath, f.root);
    reopened.lease.release();
    await confirm(f.workspace);
    assert.equal(dialogs, 2, "healthy storage never asks again");
    for (const method of ["workspace.storageRepair.prepare", "workspace.storageRepair.respond"]) {
      assert.ok(
        !(DESKTOP_RUNTIME_METHODS as readonly RuntimeMethod[]).includes(method as RuntimeMethod),
        "renderer cannot obtain or submit repair tokens",
      );
    }
    const oldDaemon = createDesktopWorkspaceStorageRecovery({
      runtime: {
        request: async () => {
          throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.METHOD_NOT_FOUND, "older daemon");
        },
      },
      confirmRepair: async () => {
        throw new Error("legacy daemon must not show a repair dialog");
      },
    });
    assert.equal(
      await oldDaemon(f.workspace),
      false,
      "legacy daemon leaves ordinary workspace loading available",
    );
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("Desktop storage repair refuses stale confirmation and active connections without adopting another database", async () => {
  for (const change of [
    "directory",
    "database",
    "binding",
    "schema",
    "schema-version",
    "active",
  ] as const) {
    const f = fixture();
    let changedBytes: Buffer | undefined;
    let lease: ReturnType<typeof acquireOperationalDatabase> | undefined;
    try {
      const recover = createDesktopWorkspaceStorageRecovery({
        runtime: f.runtime,
        confirmRepair: async () => {
          if (change === "directory") {
            renameSync(f.root, `${f.root}.before`);
            cpSync(f.source, f.root, { recursive: true });
          } else if (change === "database") {
            renameSync(f.dbPath, `${f.dbPath}.before`);
            cpSync(join(f.source, "pico.sqlite"), f.dbPath);
          } else if (change === "active") {
            lease = acquireOperationalDatabase(f.root);
          } else {
            const db = new DatabaseSync(f.dbPath);
            db.exec(
              change === "binding"
                ? "UPDATE workspace_storage_binding SET device = '777'"
                : change === "schema-version"
                  ? "UPDATE operational_schema_migrations SET version = version + 1 WHERE scope = 'sessions'"
                  : "CREATE TABLE unexpected_repair_table (id TEXT)",
            );
            db.close();
          }
          changedBytes = readFileSync(f.dbPath);
          return true;
        },
      });
      await assert.rejects(recover(f.workspace), /变化|后台使用|schema|unexpected/u, change);
      assert.deepEqual(
        readFileSync(f.dbPath),
        changedBytes,
        `${change}: rejected repair did not alter the database`,
      );
    } finally {
      lease?.release();
      rmSync(f.base, { recursive: true, force: true });
    }
  }
});
