import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  CronWorkspaceRuntime,
  LocalDaemonAlreadyRunningError,
  LocalDaemonHost,
  WorkspaceRegistrationStore,
  type DisposableLocalRuntimeService,
  type LocalDaemonEndpoint,
  type ManagedCronWorkspaceRuntime,
} from "../../src/daemon/index.js";
import { WorkspaceTaskRuntime } from "../../src/runtime/workspace-runtime.js";

test("Cron unregister close failure remains owned while later refreshes stay usable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-cron-unregister-failure-"));
  const firstWorkspace = join(root, "first-workspace");
  const secondWorkspace = join(root, "second-workspace");
  const endpoint = testEndpoint(root);
  const lockPath = join(root, "runtime.lock");
  const registrationStore = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
  await Promise.all([
    mkdir(firstWorkspace, { recursive: true }),
    mkdir(secondWorkspace, { recursive: true }),
  ]);
  const firstCanonical = await registrationStore.register(firstWorkspace);

  let firstCloseCount = 0;
  const startedWorkspaces: string[] = [];
  const host = new LocalDaemonHost({
    endpoint,
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
    lockOptions: testLockOptions(lockPath),
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
  assert.equal(await pathExists(lockPath), true);

  const secondCanonical = await registrationStore.register(secondWorkspace);
  await assert.rejects(host.refreshRegisteredWorkspaces(), /unregister Cron close failed/u);
  assert.deepEqual(host.registeredWorkspaces, [secondCanonical]);
  assert.equal(startedWorkspaces.includes(secondCanonical), true);

  await assert.rejects(host.stop(), /unregister Cron close failed/u);
  assert.equal(firstCloseCount, 2);
  assert.equal(await pathExists(lockPath), true);

  const candidate = new LocalDaemonHost({
    endpoint,
    registrationStore,
    service: testService(),
    cronRuntimeFactory: {
      create: async () => testCronRuntime(),
    },
    lockOptions: testLockOptions(lockPath),
  });
  await assert.rejects(
    candidate.start(),
    (error: unknown) => error instanceof LocalDaemonAlreadyRunningError,
  );
});

test("Cron runtime with pending ownership but no release fence retains the daemon lock", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-cron-incomplete-fence-"));
  const workspace = join(root, "workspace");
  const endpoint = testEndpoint(root);
  const lockPath = join(root, "runtime.lock");
  const registrationStore = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
  await mkdir(workspace, { recursive: true });
  await registrationStore.register(workspace);

  const host = new LocalDaemonHost({
    endpoint,
    registrationStore,
    service: testService(),
    cronRuntimeFactory: {
      create: async () =>
        testCronRuntime({
          hasPendingOwnership: () => true,
        }),
    },
    lockOptions: testLockOptions(lockPath),
  });
  context.after(async () => {
    await Promise.allSettled([host.stop()]);
    await rm(root, { recursive: true, force: true });
  });

  await host.start();
  await registrationStore.unregister(workspace);
  await assert.rejects(host.refreshRegisteredWorkspaces(), /ownership fence 不完整/u);
  await assert.rejects(host.stop(), /ownership fence 不完整/u);
  assert.equal(await pathExists(lockPath), true);
});

test("Daemon stop is bounded during an active Cron tick and releases its lock after drain", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-cron-active-tick-"));
  const workspace = join(root, "workspace");
  const endpoint = testEndpoint(root);
  const lockPath = join(root, "runtime.lock");
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
    endpoint,
    registrationStore,
    service: testService(),
    cronRuntimeFactory: {
      create: async ({ workspacePath, ownerId }) => {
        cronRuntime = new CronWorkspaceRuntime({
          workspacePath,
          ownerId,
          databasePath: join(root, "cron-runtime.sqlite"),
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
    lockOptions: testLockOptions(lockPath),
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
  assert.equal(await pathExists(lockPath), true);

  releaseExecutor.resolve();
  await cronRuntime.waitForOwnershipRelease();
  await waitUntilAsync(async () => !(await pathExists(lockPath)));
  assert.equal(cronRuntime.hasPendingOwnership(), false);

  await registrationStore.unregister(workspace);
  const candidate = new LocalDaemonHost({
    endpoint,
    registrationStore,
    service: testService(),
    cronRuntimeFactory: {
      create: async () => {
        throw new Error("candidate must not create a Cron runtime");
      },
    },
    lockOptions: testLockOptions(lockPath),
  });
  await candidate.start();
  await candidate.stop();
});

function testEndpoint(root: string): LocalDaemonEndpoint {
  return {
    transport: "unix",
    address: join(root, "runtime.sock"),
    authTokenPath: join(root, "runtime.auth"),
  };
}

function testLockOptions(lockPath: string) {
  return {
    lockPath,
    ping: async () => false,
    isProcessAlive: () => true,
  };
}

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
    recoverInterruptedRuns: () => [],
    start: () => undefined,
    close: async () => undefined,
    ...overrides,
  };
}

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilAsync(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) await delay(10);
  assert.equal(await predicate(), true, `condition was not met within ${timeoutMs}ms`);
}

async function completesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
