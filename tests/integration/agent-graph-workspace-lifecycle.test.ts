import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";

import type { AgentGraphApplicationService } from "../../src/agent-graph/service.js";
import { createRuntimeRequest, WorkspaceRuntimeService } from "../../src/daemon/index.js";
import type { WorkspaceTaskRuntime } from "../../src/runtime/workspace-runtime.js";

test("workspace owns one Graph application and closes it after Runtime drain but before stores", async (context) => {
  const fixture = await createFixture(context, "close-order");
  const order: string[] = [];
  const ownership = deferred();
  const runtimeClosed = deferred();
  const runtime = fakeWorkspaceRuntime(fixture.workspace, {
    close: () => {
      order.push("runtime-close");
      runtimeClosed.resolve();
    },
    waitForOwnershipRelease: async () => {
      await ownership.promise;
      order.push("runtime-drained");
    },
  });
  let factoryCalls = 0;
  const graphApplication = fakeGraphApplication(order);
  const service = new WorkspaceRuntimeService({
    env: fixture.env,
    createWorkspaceRuntime: async () => runtime,
    createAgentGraphApplicationService: ({ workspacePath, workspaceRuntime, runtimeStore }) => {
      factoryCalls += 1;
      assert.equal(workspacePath, fixture.workspace);
      assert.strictEqual(workspaceRuntime, runtime);
      const closeStore = runtimeStore.close.bind(runtimeStore);
      runtimeStore.close = () => {
        order.push("store-close");
        closeStore();
      };
      return graphApplication;
    },
    execute: async () => undefined,
    runBlobGc: noBlobGc,
  });

  assert.equal(
    await service.getWorkspaceAgentGraphApplicationService(fixture.workspace),
    undefined,
  );
  assert.strictEqual(await service.getWorkspaceRuntime(fixture.workspace), runtime);
  assert.strictEqual(await service.getWorkspaceRuntime(fixture.workspace), runtime);
  assert.strictEqual(
    await service.getWorkspaceAgentGraphApplicationService(fixture.workspace),
    graphApplication,
  );
  assert.equal(factoryCalls, 1);
  assert.deepEqual(order, ["graph-start"]);

  const closing = service.close();
  await runtimeClosed.promise;
  await waitForImmediate();
  assert.equal(order.includes("graph-close"), false);
  assert.equal(order.includes("store-close"), false);
  await closing;
  assert.equal(service.shutdownOwnershipFence().pending, true);

  ownership.resolve();
  await service.shutdownOwnershipFence().released;
  assert.deepEqual(order, [
    "graph-start",
    "runtime-close",
    "runtime-drained",
    "graph-close",
    "store-close",
  ]);
  assert.equal(
    await service.getWorkspaceAgentGraphApplicationService(fixture.workspace),
    undefined,
  );
});

test("workspace unregister closes its Graph application and a later get constructs a new one", async (context) => {
  const fixture = await createFixture(context, "unregister");
  const order: string[] = [];
  let runtimeSequence = 0;
  let graphSequence = 0;
  const service = new WorkspaceRuntimeService({
    env: fixture.env,
    createWorkspaceRuntime: async () => {
      const sequence = ++runtimeSequence;
      return fakeWorkspaceRuntime(fixture.workspace, {
        close: () => order.push(`runtime-close-${sequence}`),
        waitForOwnershipRelease: async () => {
          order.push(`runtime-drained-${sequence}`);
        },
      });
    },
    createAgentGraphApplicationService: ({ runtimeStore }) => {
      const sequence = ++graphSequence;
      const closeStore = runtimeStore.close.bind(runtimeStore);
      runtimeStore.close = () => {
        order.push(`store-close-${sequence}`);
        closeStore();
      };
      return fakeGraphApplication(order, sequence);
    },
    execute: async () => undefined,
    runBlobGc: noBlobGc,
  });
  context.after(() => service.close());

  await service.handle(
    createRuntimeRequest("workspace.register", { workspacePath: fixture.workspace }),
  );
  await service.handle(
    createRuntimeRequest("workspace.unregister", { workspacePath: fixture.workspace }),
  );

  assert.deepEqual(order, [
    "graph-start-1",
    "runtime-close-1",
    "runtime-drained-1",
    "graph-close-1",
    "store-close-1",
  ]);
  assert.equal(
    await service.getWorkspaceAgentGraphApplicationService(fixture.workspace),
    undefined,
  );

  await service.getWorkspaceRuntime(fixture.workspace);
  assert.equal(runtimeSequence, 2);
  assert.equal(graphSequence, 2);
  assert.ok(await service.getWorkspaceAgentGraphApplicationService(fixture.workspace));
});

function fakeWorkspaceRuntime(
  workspace: string,
  lifecycle: {
    readonly close: () => void;
    readonly waitForOwnershipRelease: () => Promise<void>;
  },
): WorkspaceTaskRuntime {
  return {
    workspace,
    workspacePath: workspace,
    mode: "folder",
    capabilities: {
      foregroundRuns: true,
      fileHistory: true,
      isolatedWorktrees: false,
      branchMerge: false,
    },
    subscribe: () => () => undefined,
    close: async () => lifecycle.close(),
    waitForOwnershipRelease: lifecycle.waitForOwnershipRelease,
    hasPendingOwnership: () => true,
  } as unknown as WorkspaceTaskRuntime;
}

function fakeGraphApplication(order: string[], sequence?: number): AgentGraphApplicationService {
  const suffix = sequence === undefined ? "" : `-${sequence}`;
  return {
    start: async () => {
      order.push(`graph-start${suffix}`);
    },
    close: async () => {
      order.push(`graph-close${suffix}`);
    },
  } as AgentGraphApplicationService;
}

async function createFixture(context: TestContext, name: string) {
  const root = await mkdtemp(join(tmpdir(), `pico-graph-workspace-${name}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  const canonicalWorkspace = await realpath(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  return {
    workspace: canonicalWorkspace,
    env: { PICO_HOME: picoHome },
  };
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function noBlobGc() {
  return {
    status: "completed" as const,
    processed: 0,
    completed: 0,
    retryable: 0,
    hasMore: false,
  };
}
