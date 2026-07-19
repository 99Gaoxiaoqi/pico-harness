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
