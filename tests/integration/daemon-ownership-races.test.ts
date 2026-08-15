import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  CronWorkspaceRuntime,
  LocalDaemonHost,
  WorkspaceRegistrationStore,
  type DisposableLocalRuntimeService,
  type ManagedCronWorkspaceRuntime,
} from "../../src/daemon/index.js";
import { WorkspaceTaskRuntime } from "../../src/runtime/workspace-runtime.js";

// 注：本文件原含旧传输单例锁（instance-lock）保留语义的断言，随 3-D Phase 5
// 旧 socket 退役移除（LocalDaemonHost 不再持锁；单例由 kernel flock 承担）。
// 保留的全部断言是 cron 生命周期编排语义：关闭失败传播、fence 排空、有界
// stop、重注册对账——这些在 kernel 承载的 candidate 装配里原样生效。

test("Cron unregister close failure remains owned while later refreshes stay usable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-cron-unregister-failure-"));
  const firstWorkspace = join(root, "first-workspace");
  const secondWorkspace = join(root, "second-workspace");
  const registrationStore = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
  await Promise.all([
    mkdir(firstWorkspace, { recursive: true }),
    mkdir(secondWorkspace, { recursive: true }),
  ]);
  const firstCanonical = await registrationStore.register(firstWorkspace);

  let firstCloseCount = 0;
  const startedWorkspaces: string[] = [];
  const host = new LocalDaemonHost({
    registrationStore,
    service: testService(),
    cronRuntimeFactory: {
      create: async ({ workspacePath }) =>
        testCronRuntime({
          start: () => startedWorkspaces.push(workspacePath),
          close: async () => {
            if (workspacePath !== firstCanonical) return;
            firstCloseCount++;
            if (firstCloseCount === 1) throw new Error("unregister Cron close failed");
          },
        }),
    },
  });
  context.after(async () => {
    await Promise.allSettled([host.stop()]);
    await rm(root, { recursive: true, force: true });
  });

  await host.start();
  assert.deepEqual(host.registeredWorkspaces, [firstCanonical]);

  await registrationStore.unregister(firstWorkspace);
  await assert.rejects(host.refreshRegisteredWorkspaces(), /unregister Cron close failed/u);
  assert.deepEqual(host.registeredWorkspaces, []);

  const secondCanonical = await registrationStore.register(secondWorkspace);
  await assert.rejects(host.refreshRegisteredWorkspaces(), /unregister Cron close failed/u);
  assert.deepEqual(host.registeredWorkspaces, [secondCanonical]);
  assert.equal(startedWorkspaces.includes(secondCanonical), true);

  await assert.rejects(host.stop(), /unregister Cron close failed/u);
  assert.equal(firstCloseCount, 2, "stop 应再次尝试关闭失败的 runtime");
});

test("Cron runtime with pending ownership but no release fence fails closes loudly", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-cron-incomplete-fence-"));
  const workspace = join(root, "workspace");
  const registrationStore = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
  await mkdir(workspace, { recursive: true });
  await registrationStore.register(workspace);

  const host = new LocalDaemonHost({
    registrationStore,
    service: testService(),
    cronRuntimeFactory: {
      create: async () =>
        testCronRuntime({
          hasPendingOwnership: () => true,
          // 显式缺失释放口：pending 无 waitForOwnershipRelease = fence 不完整。
          waitForOwnershipRelease: undefined,
        }),
    },
  });
  context.after(async () => {
    await Promise.allSettled([host.stop()]);
    await rm(root, { recursive: true, force: true });
  });

  await host.start();
  await registrationStore.unregister(workspace);
  await assert.rejects(host.refreshRegisteredWorkspaces(), /ownership fence 不完整/u);
  await assert.rejects(host.stop(), /ownership fence 不完整/u);
});

test("Daemon stop is bounded during an active Cron tick and the fence releases after drain", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-cron-active-tick-"));
  const workspace = join(root, "workspace");
  const registrationStore = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
  const executorEntered = deferred();
  const releaseExecutor = deferred();
  await mkdir(workspace, { recursive: true });
  await registrationStore.register(workspace);

  const workspaceRuntime = await WorkspaceTaskRuntime.create({
    workDir: workspace,
    closeDrainTimeoutMs: 5,
  });
  let cronRuntime: CronWorkspaceRuntime | undefined;
  const workspaceErrors: unknown[] = [];
  const host = new LocalDaemonHost({
    registrationStore,
    service: testService(),
    cronRuntimeFactory: {
      create: async ({ workspacePath, ownerId }) => {
        cronRuntime = new CronWorkspaceRuntime({
          workspacePath,
          ownerId,
          storageRoot: join(root, "cron-runtime"),
          closeDrainTimeoutMs: 5,
          getWorkspaceRuntime: async () => workspaceRuntime,
          canRun: async () => ({ allowed: true }),
          execute: async () => {
            executorEntered.resolve();
            await releaseExecutor.promise;
            return { finished: true };
          },
        });
        return cronRuntime;
      },
    },
    onWorkspaceError: (_workspacePath, error) => workspaceErrors.push(error),
  });
  context.after(async () => {
    releaseExecutor.resolve();
    await cronRuntime?.waitForOwnershipRelease().catch(() => undefined);
    await Promise.allSettled([host.stop(), workspaceRuntime.close()]);
    await rm(root, { recursive: true, force: true });
  });

  await host.start();
  assert.ok(cronRuntime, `Cron runtime creation failed: ${String(workspaceErrors[0])}`);
  const job = cronRuntime.cronService.create({
    cronJobId: "cron-active-close",
    workspacePath: workspace,
    schedule: "* * * * *",
    prompt: "keep the Cron tick active",
    policySnapshot: {
      mode: "yolo",
      backgroundEnabled: true,
      trustedWorkspace: true,
      toolNetworkPolicy: "disabled",
      allowedTools: [],
      hardlineVersion: "test-hardline",
      hookVersion: "test-hooks",
      createdAt: Date.now(),
    },
  });
  cronRuntime.runNow(job.cronJobId);
  await executorEntered.promise;

  await completesWithin(host.stop(), 500, "daemon stop waited inline for the active Cron tick");
  assert.equal(cronRuntime.hasPendingOwnership(), true);

  releaseExecutor.resolve();
  await cronRuntime.waitForOwnershipRelease();
  assert.equal(cronRuntime.hasPendingOwnership(), false);

  // 排空后新 host 可正常编排（旧 runtime 的 fence 不阻塞接任者）。
  await registrationStore.unregister(workspace);
  const replacement = new LocalDaemonHost({
    registrationStore,
    service: testService(),
    cronRuntimeFactory: {
      create: async () => {
        throw new Error("replacement must not create a Cron runtime（已注销）");
      },
    },
  });
  await replacement.start();
  await replacement.stop();
});

test("Cron runtime automatically reconciles a workspace re-registered while its old fence drains", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-cron-reregister-"));
  const workspace = join(root, "workspace");
  const registrationStore = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
  const releaseOldRuntime = deferred();
  await mkdir(workspace, { recursive: true });
  const canonical = await registrationStore.register(workspace);

  let oldOwnershipPending = true;
  let createCount = 0;
  let replacementStarts = 0;
  const host = new LocalDaemonHost({
    registrationStore,
    service: testService(),
    cronRuntimeFactory: {
      create: async () => {
        createCount++;
        if (createCount === 1) {
          return testCronRuntime({
            hasPendingOwnership: () => oldOwnershipPending,
            waitForOwnershipRelease: () => releaseOldRuntime.promise,
          });
        }
        return testCronRuntime({ start: () => replacementStarts++ });
      },
    },
  });
  context.after(async () => {
    oldOwnershipPending = false;
    releaseOldRuntime.resolve();
    await Promise.allSettled([host.stop()]);
    await rm(root, { recursive: true, force: true });
  });

  await host.start();
  await registrationStore.unregister(workspace);
  await host.refreshRegisteredWorkspaces();
  assert.deepEqual(host.registeredWorkspaces, []);

  await registrationStore.register(workspace);
  await assert.rejects(host.refreshRegisteredWorkspaces(), /Cron runtime 仍在关闭/u);
  assert.deepEqual(await registrationStore.list(), [canonical]);
  assert.deepEqual(host.registeredWorkspaces, []);

  oldOwnershipPending = false;
  releaseOldRuntime.resolve();
  await waitUntilAsync(() => host.registeredWorkspaces.includes(canonical));
  assert.equal(createCount, 2);
  assert.equal(replacementStarts, 1);
});

function testService(): DisposableLocalRuntimeService {
  return {
    handle: async () => ({}),
    replayEvents: async () => ({ events: [], hasMore: false }),
    subscribe: () => () => undefined,
    close: async () => undefined,
  };
}

function testCronRuntime(
  overrides: Partial<ManagedCronWorkspaceRuntime> = {},
): ManagedCronWorkspaceRuntime {
  return {
    recoverInterruptedRuns: () => undefined,
    start: () => undefined,
    close: async () => undefined,
    hasPendingOwnership: () => false,
    waitForOwnershipRelease: async () => undefined,
    ...overrides,
  } as ManagedCronWorkspaceRuntime;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

async function completesWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const timedOut = Symbol("timeout");
  const outcome = await Promise.race([
    operation.then(() => undefined),
    delay(timeoutMs).then(() => timedOut),
  ]);
  if (outcome === timedOut) throw new Error(`Timeout: ${label}`);
}

async function waitUntilAsync(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitUntilAsync timed out");
    await delay(20);
  }
}
