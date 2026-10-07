import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DesktopAtomicMemoryService } from "@pico/pico-host/desktop-atomic-memory-service";
import {
  createRuntimeRequest,
  isJsonObject,
  parseStrictRuntimeParams,
  parseRuntimeResult,
  type RuntimeNotification,
} from "../../../packages/protocol/src/index.js";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import { resolvePicoPaths } from "@pico/pico-host";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { WorkspaceRegistrationStore } from "@pico/pico-host/workspace-registration";

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

test("全局记忆设置通知各项目，项目条目隔离且通知失败不回滚设置", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-memory-settings-notify-"));
  const picoHome = join(root, "home");
  const registrations = new WorkspaceRegistrationStore(join(picoHome, "workspaces.json"));
  const aPath = join(root, "project-a"),
    bPath = join(root, "project-b");
  await Promise.all([mkdir(aPath), mkdir(bPath)]);
  const a = await registrations.register(aPath);
  const b = await registrations.register(bPath);
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(a);
  await trustStore.trust(b);
  const env = { PICO_HOME: picoHome };
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => undefined });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    registrationStore: registrations,
    trustStore,
    env,
  });
  t.after(async () => {
    await desktop.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const notices: RuntimeNotification[] = [];
  let settingsReady = Promise.withResolvers<void>();
  const unsubscribe = desktop.subscribe((event) => {
    if (event.topic !== "memory.changed") return;
    notices.push(event);
    if (
      notices.filter(
        (notice) => isJsonObject(notice.payload) && notice.payload["entityType"] === "settings",
      ).length === 2
    )
      settingsReady.resolve();
  });
  t.after(unsubscribe);
  let settings = parseRuntimeResult(
    "memory.settings.get",
    await desktop.handle(createRuntimeRequest("memory.settings.get", {})),
  ).settings;
  settings = parseRuntimeResult(
    "memory.settings.update",
    await desktop.handle(
      createRuntimeRequest("memory.settings.update", {
        expectedVersion: settings.version,
        idempotencyKey: "global-disable",
        autoExtract: false,
      }),
    ),
  ).settings;
  await settingsReady.promise;
  assert.deepEqual(notices.map((notice) => notice.scope.workspacePath).sort(), [a, b].sort());
  assert.equal(settings.autoExtract, false);
  for (const workspacePath of [a, b]) {
    const replay = await desktop.replayEvents({ workspacePath, limit: 10 });
    assert.ok(
      replay.events.some(
        (event) =>
          event.topic === "memory.changed" &&
          isJsonObject(event.payload) &&
          event.payload["entityType"] === "settings" &&
          event.payload["version"] === settings.version,
      ),
    );
  }

  notices.length = 0;
  await desktop.handle(
    createRuntimeRequest("memory.create", { workspacePath: a, text: "Project A only" }),
  );
  assert.deepEqual(
    notices.map((notice) => notice.scope.workspacePath),
    [a],
  );
  assert.equal(
    parseRuntimeResult(
      "memory.list",
      await desktop.handle(createRuntimeRequest("memory.list", { workspacePath: b })),
    ).items.length,
    0,
  );

  notices.length = 0;
  settingsReady = Promise.withResolvers<void>();
  const publish = runtime.publishDesktopNotification.bind(runtime);
  t.mock.method(runtime, "publishDesktopNotification", (event: RuntimeNotification) => {
    if (
      event.scope.workspacePath === a &&
      event.topic === "memory.changed" &&
      isJsonObject(event.payload) &&
      event.payload["entityType"] === "settings"
    )
      throw new Error("fixture refused ledger");
    publish(event);
    if (
      event.topic === "memory.changed" &&
      isJsonObject(event.payload) &&
      event.payload["entityType"] === "settings"
    )
      settingsReady.resolve();
  });
  settings = parseRuntimeResult(
    "memory.settings.update",
    await desktop.handle(
      createRuntimeRequest("memory.settings.update", {
        workspacePath: b,
        expectedVersion: settings.version,
        idempotencyKey: "project-update",
        recallEnabled: false,
      }),
    ),
  ).settings;
  await settingsReady.promise;
  assert.equal(settings.recallEnabled, false);
  assert.deepEqual(
    notices.map((notice) => notice.scope.workspacePath),
    [b],
  );
  assert.deepEqual(
    parseRuntimeResult(
      "memory.settings.get",
      await desktop.handle(createRuntimeRequest("memory.settings.get", {})),
    ).settings,
    settings,
  );
});
