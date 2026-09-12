import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DesktopAtomicMemoryService } from "../../../src/daemon/desktop-atomic-memory-service.js";
import {
  createRuntimeRequest,
  parseStrictRuntimeParams,
} from "../../../packages/protocol/src/index.js";
import { SqliteMemoryItemStore } from "../../../src/storage/sqlite/sqlite-memory-item-store.js";
import { AtomicMemoryContextBuilder } from "../../../src/memory/atomic/context-builder.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import { DesktopRuntimeService, WorkspaceRuntimeService } from "../../../src/daemon/index.js";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";

test("用户级策略不继承旧项目开关、保存时清理旧配置并保持记忆内容隔离", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pico-user-memory-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dbPath = join(home, "memory.sqlite");
  new SqliteMemoryItemStore(dbPath).close();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec("INSERT INTO memory_settings VALUES ('old-a', 3, 1, 0, 1), ('old-b', 4, 0, 1, 0)");
  legacy.close();
  const service = new DesktopAtomicMemoryService({
    picoHome: home,
    publish: () => {},
    now: () => 1000,
  });
  t.after(() => service.close());
  const a = join(home, "project-a"),
    b = join(home, "project-b");
  const first = (await service.getSettings(home)).settings;
  assert.equal(first.version, 1);
  assert.equal(first.enabled, true);
  assert.equal(first.autoExtract, true);
  assert.equal(first.recallEnabled, true);
  assert.deepEqual(
    (await service.getSettings(a)).settings,
    (await service.getSettings(b)).settings,
  );
  assert.deepEqual(parseStrictRuntimeParams("memory.settings.get", {}), {});
  const params = parseStrictRuntimeParams("memory.settings.update", {
    expectedVersion: first.version,
    idempotencyKey: "enable",
    enabled: true,
    recallEnabled: true,
  });
  const env = { PICO_HOME: home };
  const desktop = new DesktopRuntimeService({
    runtimeService: new WorkspaceRuntimeService({ env, execute: async () => undefined }),
    trustStore: new WorkspaceTrustStore({ userStateDirectory: home }),
    memoryService: service,
    env,
  });
  t.after(() => desktop.close());
  const snapshot = await desktop.handle(createRuntimeRequest("memory.settings.get", {}));
  assert.ok(snapshot && typeof snapshot === "object" && "settings" in snapshot);
  await desktop.handle(createRuntimeRequest("memory.settings.update", params));
  assert.equal((await service.getSettings(b)).settings.enabled, true);
  await assert.rejects(service.updateSettings(a, params), /版本已改变/);
  await service.create(a, "Private project A note");
  assert.equal((await service.list(b, { workspacePath: b })).items.length, 0);
  const store = new SqliteMemoryItemStore(dbPath);
  try {
    const key = resolvePicoPaths(a, { picoHome: home }).workspace.id;
    assert.ok(
      (
        await new AtomicMemoryContextBuilder(store, key).build("Private project A note")
      ).block.includes("Private project A note"),
    );
    const current = (await service.getSettings(b)).settings;
    await service.updateSettings(b, {
      expectedVersion: current.version,
      idempotencyKey: "disable",
      enabled: false,
    });
    assert.equal(
      (await new AtomicMemoryContextBuilder(store, key).build("Private project A note")).block,
      "",
    );
  } finally {
    store.close();
  }
  const check = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(
    check
      .prepare(
        "SELECT COUNT(*) AS count FROM memory_settings WHERE workspace_key IN ('old-a', 'old-b')",
      )
      .get()!.count,
    0,
  );
  check.close();
});
