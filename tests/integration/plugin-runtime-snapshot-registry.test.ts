import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { PluginRuntimeSnapshotRegistry } from "../../src/plugins/plugin-runtime-snapshot-registry.js";
import type { PluginRuntimeSnapshot } from "../../src/plugins/plugin-runtime-snapshot.js";

test("invalidate 轮换 workspace generation 并将释放推迟到 owner close", async () => {
  let loadCount = 0;
  const disposeCounts = new Map<string, number>();
  const registry = new PluginRuntimeSnapshotRegistry({
    loadSnapshot: async () => {
      const id = `generation-${++loadCount}`;
      return snapshot(id, () => disposeCounts.set(id, (disposeCounts.get(id) ?? 0) + 1));
    },
  });

  const firstLoading = registry.get("/workspace/project");
  assert.equal(registry.get("/workspace/project"), firstLoading, "active get 必须合并并发加载");
  const first = await firstLoading;
  assert.equal(registry.invalidate("/workspace/project"), true);
  assert.equal(registry.invalidate("/workspace/project"), false, "重复 invalidate 不得重复退休");
  assert.equal(disposeCounts.get(first.pluginIds[0]!), undefined, "invalidate 不得提前释放");

  const second = await registry.get("/workspace/project");
  assert.notEqual(second, first);
  assert.equal(loadCount, 2, "invalidate 后 get 必须加载新 generation");

  const closing = registry.dispose();
  assert.equal(registry.dispose(), closing, "并发 close 必须共享同一释放过程");
  await closing;
  assert.deepEqual([...disposeCounts.entries()].sort(), [
    ["generation-1", 1],
    ["generation-2", 1],
  ]);
  assert.throws(() => registry.get("/workspace/project"), /disposed/u);
  assert.throws(() => registry.invalidate("/workspace/project"), /disposed/u);
});

test("close 等待 active 与 retired 的并发加载完成后各释放一次", async () => {
  const loads: Array<Deferred<PluginRuntimeSnapshot>> = [];
  const disposed: string[] = [];
  const registry = new PluginRuntimeSnapshotRegistry({
    loadSnapshot: async () => {
      const pending = deferred<PluginRuntimeSnapshot>();
      loads.push(pending);
      return pending.promise;
    },
  });

  const firstLoading = registry.get("/workspace/project");
  await waitForImmediate();
  assert.equal(loads.length, 1);
  assert.equal(registry.invalidate("/workspace/project"), true);
  const secondLoading = registry.get("/workspace/project");
  assert.equal(registry.get("/workspace/project"), secondLoading);
  await waitForImmediate();
  assert.equal(loads.length, 2);

  let closeSettled = false;
  const closing = registry.dispose().finally(() => {
    closeSettled = true;
  });
  await waitForImmediate();
  assert.equal(closeSettled, false);

  loads[1]!.resolve(snapshot("active", () => disposed.push("active")));
  await secondLoading;
  await waitForImmediate();
  assert.equal(closeSettled, false, "retired generation 未完成时 close 必须继续等待");

  loads[0]!.resolve(snapshot("retired", () => disposed.push("retired")));
  await firstLoading;
  await closing;
  assert.deepEqual(disposed.sort(), ["active", "retired"]);
});

test("加载失败会清理 active/retired generation 并允许重试", async () => {
  const attempts = new Map<string, number>();
  const disposed: string[] = [];
  const registry = new PluginRuntimeSnapshotRegistry({
    loadSnapshot: async (workDir) => {
      const attempt = (attempts.get(workDir) ?? 0) + 1;
      attempts.set(workDir, attempt);
      if (attempt === 1) throw new Error(`load failed: ${workDir}`);
      return snapshot(`${workDir}:${attempt}`, () => disposed.push(workDir));
    },
  });

  await assert.rejects(registry.get("/workspace/active-failure"), /load failed/u);
  assert.equal(registry.invalidate("/workspace/active-failure"), false);
  await registry.get("/workspace/active-failure");

  const retiredFailure = registry.get("/workspace/retired-failure");
  assert.equal(registry.invalidate("/workspace/retired-failure"), true);
  await assert.rejects(retiredFailure, /load failed/u);
  assert.equal(registry.invalidate("/workspace/retired-failure"), false);
  await registry.get("/workspace/retired-failure");

  await registry.dispose();
  assert.deepEqual(disposed.sort(), ["/workspace/active-failure", "/workspace/retired-failure"]);
  assert.deepEqual([...attempts.values()], [2, 2]);
});

test("close 聚合 active 与 retired 的释放错误且仍尝试全部 snapshot", async () => {
  const disposed: string[] = [];
  let generation = 0;
  const registry = new PluginRuntimeSnapshotRegistry({
    loadSnapshot: async () => {
      const id = `snapshot-${++generation}`;
      return snapshot(id, () => {
        disposed.push(id);
        if (id !== "snapshot-2") throw new Error(`dispose failed: ${id}`);
      });
    },
  });

  await registry.get("/workspace/project");
  registry.invalidate("/workspace/project");
  await registry.get("/workspace/project");
  await registry.get("/workspace/other");

  await assert.rejects(
    registry.dispose(),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors.every((failure) => String(failure).includes("dispose failed")),
  );
  assert.deepEqual(disposed.sort(), ["snapshot-1", "snapshot-2", "snapshot-3"]);
});

function snapshot(id: string, onDispose: () => void): PluginRuntimeSnapshot {
  return {
    pluginIds: [id],
    skillSources: [],
    commandSources: [],
    agentSources: [],
    hookSources: [],
    mcpSources: [],
    lspServers: [],
    capabilities: [],
    diagnostics: [],
    dispose: async () => onDispose(),
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
