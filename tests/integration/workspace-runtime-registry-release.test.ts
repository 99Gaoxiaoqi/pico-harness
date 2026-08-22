import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceRuntimeRegistry } from "../../src/daemon/workspace-registry.js";

test("workspace replacement waits until the previous Runtime releases ownership", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-registry-release-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const ownership = deferred();
  const closeStarted = deferred();
  let creates = 0;
  const registry = new WorkspaceRuntimeRegistry({
    create: async (workspacePath) => {
      creates++;
      return {
        workspacePath,
        close: async () => {
          closeStarted.resolve();
        },
        hasPendingOwnership: () => creates === 1 && !ownership.settled,
        waitForOwnershipRelease: async () => {
          if (creates === 1) await ownership.promise;
        },
      };
    },
  });
  context.after(async () => {
    ownership.resolve();
    await registry.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const first = await registry.get(workspace);
  const releasing = registry.release(workspace);
  await closeStarted.promise;
  const replacement = registry.get(workspace);
  let replacementSettled = false;
  void replacement.finally(() => {
    replacementSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(registry.hasPendingOwnership(), true);
  assert.equal(creates, 1);
  assert.equal(replacementSettled, false);
  ownership.resolve();
  await releasing;
  const second = await replacement;
  assert.notStrictEqual(second, first);
  assert.equal(creates, 2);
  assert.equal(registry.hasPendingOwnership(), false);
});

test("get re-fetches a runtime released while its create was still pending", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-registry-race-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const firstCreateReleased = deferred();
  let creates = 0;
  const registry = new WorkspaceRuntimeRegistry<{ workspacePath: string; close(): Promise<void> }>(
    {
      create: async (workspacePath) => {
        creates++;
        if (creates === 1) await firstCreateReleased.promise;
        return { workspacePath, close: async () => undefined };
      },
    },
    async (workspacePath) => workspacePath,
  );
  context.after(async () => {
    firstCreateReleased.resolve();
    await registry.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  // get#1 启动慢 create（pending）；get#2 复用同一个 pending runtime 并 await 它。
  const firstGet = registry.get(workspace);
  await new Promise((resolve) => setImmediate(resolve));
  const secondGet = registry.get(workspace);

  // release 在 runtime 仍 pending 时删除并关闭它。先让 release 跑过 canonicalize
  // 与 runtimes.delete（之后卡在 closeRuntimes await pendingR1），再 resolve 让 get
  // 的 await 完成——此时 get 必须发现注册项已被删除并重新创建。
  const releasing = registry.release(workspace);
  await new Promise((resolve) => setImmediate(resolve));
  firstCreateReleased.resolve();
  await releasing;

  // 修复后两个 get 都发现注册项已不再是当初 await 的 runtime（被 release 删除），
  // 重新 get 触发第二次 create，绝不把正在 close 的第一个 runtime 交出去。
  const [first, second] = await Promise.all([firstGet, secondGet]);
  assert.equal(creates, 2, "应重新创建而非复用被 release 的 runtime");
  assert.equal(first, second);
  assert.ok(first.workspacePath, "重新创建的 runtime 应携带 workspacePath");
});

function deferred(): {
  readonly promise: Promise<void>;
  readonly settled: boolean;
  resolve(): void;
} {
  let resolvePromise!: () => void;
  let settled = false;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve() {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  };
}
