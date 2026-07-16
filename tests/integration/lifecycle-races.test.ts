import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitForImmediate, setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  createDesktopDaemonShutdownFence,
  type DesktopDaemonShutdownFenceOptions,
} from "../../apps/desktop/src/main/daemon-controller.js";
import {
  installLocalDaemonShutdownHandlers,
  LocalDaemonAlreadyRunningError,
  LocalDaemonHost,
  WorkspaceRegistrationStore,
  WorkspaceRuntimeRegistry,
  WorkspaceRuntimeService,
  type DisposableLocalRuntimeService,
  type LocalDaemonEndpoint,
} from "../../src/daemon/index.js";
import { loadHookSnapshot } from "../../src/hooks/config.js";
import { HookConfigReloader } from "../../src/hooks/config/reloader.js";
import { WorkspaceTaskRuntime } from "../../src/runtime/workspace-runtime.js";
import { JobService } from "../../src/tasks/job-service.js";

test("Workspace registry fences a get still canonicalizing when close begins", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-registry-close-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let createCount = 0;
  const registry = new WorkspaceRuntimeRegistry({
    create: async (workspacePath) => {
      createCount++;
      return { workspacePath };
    },
  });

  const getting = registry.get(root);
  const rejectedGet = assert.rejects(getting, /registry 正在关闭/u);
  const closing = registry.close();
  assert.strictEqual(registry.close(), closing);
  await closing;
  await rejectedGet;
  assert.equal(createCount, 0);
});

test("Workspace registry captures a runtime whose factory synchronously closes it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-registry-reentrant-close-"));
  const releaseOwnership = deferred();
  context.after(async () => {
    releaseOwnership.resolve();
    await rm(root, { recursive: true, force: true });
  });
  let closeCount = 0;
  let closing: Promise<void> | undefined;
  const registry: WorkspaceRuntimeRegistry<{
    workspacePath: string;
    close(): Promise<void>;
    hasPendingOwnership(): boolean;
    waitForOwnershipRelease(): Promise<void>;
  }> = new WorkspaceRuntimeRegistry({
    create: async (workspacePath) => {
      closing = registry.close();
      return {
        workspacePath,
        close: async () => {
          closeCount++;
        },
        hasPendingOwnership: () => true,
        waitForOwnershipRelease: () => releaseOwnership.promise,
      };
    },
  });

  await assert.rejects(registry.get(root), /registry 正在关闭/u);
  assert.ok(closing);
  await closing;
  assert.equal(closeCount, 1);
  assert.equal(registry.hasPendingOwnership(), true);

  releaseOwnership.resolve();
  await registry.waitForOwnershipRelease();
  assert.equal(registry.hasPendingOwnership(), false);
});

test("Workspace runtime close has a bounded drain and freezes a late executor", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-close-deadline-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const runtime = await WorkspaceTaskRuntime.create({
    workDir: workspace,
    closeDrainTimeoutMs: 5,
    generateRunId: () => "run-close-deadline",
  });
  const entered = deferred();
  const release = deferred();
  const executorReturned = deferred();
  const services: WorkspaceRuntimeService[] = [];
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    createWorkspaceRuntime: async () => runtime,
    execute: async ({ context: runContext }) => {
      entered.resolve();
      await release.promise;
      try {
        runContext.bindSession("late-session");
        return { late: true };
      } finally {
        executorReturned.resolve();
      }
    },
  });
  services.push(service);
  context.after(async () => {
    release.resolve();
    await Promise.allSettled(services.map((candidate) => candidate.close()));
    await runtime.close();
  });
  const liveTopics: string[] = [];
  service.subscribe((event) => liveTopics.push(event.topic));
  const run = asRecord(
    await service.startForegroundRun({ workspacePath: workspace, prompt: "ignore abort" }),
  );
  const runId = requiredString(run["runId"], "runId");
  await entered.promise;

  const firstClose = runtime.close();
  const repeatedClose = runtime.close();
  assert.strictEqual(repeatedClose, firstClose);
  const serviceClose = service.close();
  await Promise.all([firstClose, serviceClose]);
  assert.strictEqual(runtime.close(), firstClose);

  const closedRun = runtime.getRun(runId);
  assert.equal(closedRun?.status, "cancelled");
  assert.equal(closedRun?.error, "workspace runtime close drain deadline exceeded");
  assert.equal(closedRun?.version, 3);
  assert.equal(liveTopics.filter((event) => event === "run.finished").length, 1);

  const restarted = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => undefined,
  });
  services.push(restarted);
  const beforeLateReturn = await restarted.replayEvents({ workspacePath: workspace });
  const durableFinished = beforeLateReturn.events.filter((event) => event.topic === "run.finished");
  assert.equal(durableFinished.length, 1);
  const durableRun = asRecord(asRecord(durableFinished[0]?.payload)["run"]);
  assert.equal(durableRun["status"], "cancelled");
  assert.equal(durableRun["error"], "workspace runtime close drain deadline exceeded");

  release.resolve();
  await executorReturned.promise;
  await waitForImmediate();
  assert.equal(runtime.getRun(runId)?.status, "cancelled");
  assert.equal(runtime.getRun(runId)?.sessionId, undefined);
  assert.equal(runtime.getRun(runId)?.version, 3);
  const afterLateReturn = await restarted.replayEvents({ workspacePath: workspace });
  assert.equal(afterLateReturn.events.filter((event) => event.topic === "run.finished").length, 1);
});

test("Workspace close fences an executor admitted during run.started publication", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-close-admission-"));
  await mkdir(root, { recursive: true });
  const release = deferred();
  const entered = deferred();
  const runtime = await WorkspaceTaskRuntime.create({
    workDir: root,
    closeDrainTimeoutMs: 5,
    generateRunId: () => "run-close-admission",
  });
  context.after(async () => {
    release.resolve();
    await runtime.waitForOwnershipRelease();
    await rm(root, { recursive: true, force: true });
  });

  let closing: Promise<void> | undefined;
  runtime.subscribe((event) => {
    if (event.type === "run.started") closing = runtime.close();
  });
  runtime.startRun({ description: "close while publishing" }, async () => {
    entered.resolve();
    await release.promise;
  });

  await entered.promise;
  assert.ok(closing);
  await completesWithin(closing, 500, "workspace close missed an admitted executor");
  assert.equal(runtime.getRun("run-close-admission")?.status, "cancelled");
  assert.equal(runtime.hasPendingOwnership(), true);

  release.resolve();
  await runtime.waitForOwnershipRelease();
  assert.equal(runtime.hasPendingOwnership(), false);
});

test("Workspace close is stable when abort listeners synchronously close again", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-close-reentrant-"));
  const entered = deferred();
  const release = deferred();
  const runtime = await WorkspaceTaskRuntime.create({
    workDir: root,
    closeDrainTimeoutMs: 5,
    generateRunId: () => "run-close-reentrant",
  });
  context.after(async () => {
    release.resolve();
    await runtime.waitForOwnershipRelease();
    await rm(root, { recursive: true, force: true });
  });
  let reentrantClose: Promise<void> | undefined;
  runtime.startRun({ description: "reentrant close" }, async ({ signal }) => {
    signal.addEventListener(
      "abort",
      () => {
        reentrantClose = runtime.close();
      },
      { once: true },
    );
    entered.resolve();
    await release.promise;
  });
  await entered.promise;

  const firstClose = runtime.close();
  assert.strictEqual(reentrantClose, firstClose);
  await completesWithin(firstClose, 500, "reentrant workspace close exceeded its deadline");
  release.resolve();
  await runtime.waitForOwnershipRelease();
});

test("Daemon keeps singleton ownership until a timed-out executor actually settles", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-close-ownership-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const endpoint: LocalDaemonEndpoint = {
    transport: "unix",
    address: join(root, "runtime.sock"),
    authTokenPath: join(root, "runtime.auth"),
  };
  const lockPath = join(root, "runtime.lock");
  const registrationStore = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });

  const entered = deferred();
  const release = deferred();
  const executorReturned = deferred();
  let lateServiceAccessible = false;
  const runtime = await WorkspaceTaskRuntime.create({
    workDir: workspace,
    closeDrainTimeoutMs: 5,
    generateRunId: () => "run-daemon-close-ownership",
  });
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    registrationStore,
    createWorkspaceRuntime: async () => runtime,
    execute: async () => {
      entered.resolve();
      await release.promise;
      await service.replayEvents({ workspacePath: workspace });
      lateServiceAccessible = true;
      executorReturned.resolve();
      return { late: true };
    },
  });
  const host = createLifecycleTestHost({
    endpoint,
    lockPath,
    registrationStore,
    service,
  });
  const candidates: LocalDaemonHost[] = [host];
  context.after(async () => {
    release.resolve();
    await Promise.allSettled(candidates.map((candidate) => candidate.stop()));
    await rm(root, { recursive: true, force: true });
  });

  await host.start();
  const run = asRecord(
    await service.startForegroundRun({ workspacePath: workspace, prompt: "ignore abort" }),
  );
  const runId = requiredString(run["runId"], "runId");
  await entered.promise;

  await completesWithin(host.stop(), 500, "daemon stop exceeded its bounded drain");
  assert.equal(await pathExists(lockPath), true);
  const beforeSettle = await service.replayEvents({ workspacePath: workspace });
  assert.equal(beforeSettle.events.filter((event) => event.topic === "run.finished").length, 1);

  const earlyService = new WorkspaceRuntimeService({
    env: { PICO_HOME: join(root, "early-pico-home") },
    registrationStore,
    execute: async () => undefined,
  });
  const earlyHost = createLifecycleTestHost({
    endpoint,
    lockPath,
    registrationStore,
    service: earlyService,
  });
  candidates.push(earlyHost);
  await assert.rejects(
    earlyHost.start(),
    (error: unknown) => error instanceof LocalDaemonAlreadyRunningError,
  );

  release.resolve();
  await executorReturned.promise;
  await service.shutdownOwnershipFence().released;
  assert.equal(lateServiceAccessible, true);
  assert.equal(runtime.getRun(runId)?.status, "cancelled");
  assert.equal(runtime.getRun(runId)?.result, undefined);
  await assert.rejects(service.replayEvents({ workspacePath: workspace }), /已关闭/u);
  await waitUntilAsync(async () => !(await pathExists(lockPath)));

  const restartedService = new WorkspaceRuntimeService({
    env: { PICO_HOME: join(root, "restarted-pico-home") },
    registrationStore,
    execute: async () => undefined,
  });
  const restartedHost = createLifecycleTestHost({
    endpoint,
    lockPath,
    registrationStore,
    service: restartedService,
  });
  candidates.push(restartedHost);
  await restartedHost.start();
  assert.equal(restartedHost.status, "running");
  await restartedHost.stop();
});

test("Daemon keeps TaskHost ownership until an abort-ignoring worktree runner settles", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-task-runner-ownership-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const endpoint: LocalDaemonEndpoint = {
    transport: "unix",
    address: join(root, "runtime.sock"),
    authTokenPath: join(root, "runtime.auth"),
  };
  const lockPath = join(root, "runtime.lock");
  const registrationStore = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await initializeGitRepository(workspace);

  const entered = deferred();
  const release = deferred();
  const runnerReturned = deferred();
  const runtime = await WorkspaceTaskRuntime.create({
    workDir: workspace,
    closeDrainTimeoutMs: 5,
    taskHostRuntimeOptions: { picoHome, runnerStopTimeoutMs: 5 },
  });
  const taskHost = runtime.taskHostRuntime;
  assert.ok(taskHost);
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    registrationStore,
    createWorkspaceRuntime: async () => runtime,
    execute: async () => undefined,
  });
  const host = createLifecycleTestHost({
    endpoint,
    lockPath,
    registrationStore,
    service,
  });
  const candidates: LocalDaemonHost[] = [host];
  const taskIds: string[] = [];
  context.after(async () => {
    release.resolve();
    await Promise.allSettled(taskIds.map((taskId) => taskHost.supervisor.wait(taskId)));
    await Promise.allSettled([
      runtime.waitForOwnershipRelease(),
      ...candidates.map((candidate) => candidate.stop()),
    ]);
    await rm(root, { recursive: true, force: true });
  });

  await host.start();
  assert.strictEqual(await service.getWorkspaceRuntime(workspace), runtime);
  const task = runtime.startTask({ description: "ignore shutdown abort" }, async ({ signal }) => {
    entered.resolve();
    await release.promise;
    assert.equal(signal.aborted, true);
    runnerReturned.resolve();
    return { summary: "late success must remain cancelled" };
  });
  taskIds.push(task.taskId);
  await entered.promise;

  await completesWithin(host.stop(), 500, "daemon stop waited forever for a worktree runner");
  assert.equal(await pathExists(lockPath), true);
  assert.equal(runtime.hasPendingOwnership(), true);
  assert.equal(taskHost.jobService.get(task.taskId)?.job.status, "running");

  const earlyService = new WorkspaceRuntimeService({
    env: { PICO_HOME: join(root, "early-pico-home") },
    registrationStore,
    execute: async () => undefined,
  });
  const earlyHost = createLifecycleTestHost({
    endpoint,
    lockPath,
    registrationStore,
    service: earlyService,
  });
  candidates.push(earlyHost);
  await assert.rejects(
    earlyHost.start(),
    (error: unknown) => error instanceof LocalDaemonAlreadyRunningError,
  );

  release.resolve();
  await runnerReturned.promise;
  await service.shutdownOwnershipFence().released;
  await runtime.waitForOwnershipRelease();
  const settled = await taskHost.supervisor.wait(task.taskId);
  assert.equal(settled.status, "stopped");
  assert.equal(settled.registry.status, "killed");

  const { service: probe } = await JobService.create({ workDir: workspace, picoHome });
  try {
    assert.equal(probe.get(task.taskId)?.job.status, "cancelled");
  } finally {
    probe.close();
  }
  await waitUntilAsync(async () => !(await pathExists(lockPath)));

  const restartedService = new WorkspaceRuntimeService({
    env: { PICO_HOME: join(root, "restarted-pico-home") },
    registrationStore,
    execute: async () => undefined,
  });
  const restartedHost = createLifecycleTestHost({
    endpoint,
    lockPath,
    registrationStore,
    service: restartedService,
  });
  candidates.push(restartedHost);
  await restartedHost.start();
  assert.equal(restartedHost.status, "running");
  await restartedHost.stop();
});

test("TaskHost fences a task admission whose pending subscriber synchronously closes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-task-admission-close-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await initializeGitRepository(workspace);

  const runtime = await WorkspaceTaskRuntime.create({
    workDir: workspace,
    taskHostRuntimeOptions: { picoHome, runnerStopTimeoutMs: 5 },
  });
  const taskHost = runtime.taskHostRuntime;
  assert.ok(taskHost);
  const observed: { closing?: Promise<void>; taskId?: string } = {};
  let runnerStarted = false;
  const unsubscribe = taskHost.taskRegistry.subscribe((snapshot) => {
    if (snapshot.status !== "pending" || snapshot.data?.["supervisor"] !== "worktree") return;
    observed.taskId = snapshot.taskId;
    observed.closing = taskHost.close();
  });
  context.after(async () => {
    unsubscribe();
    await Promise.allSettled([runtime.close(), runtime.waitForOwnershipRelease()]);
    await rm(root, { recursive: true, force: true });
  });

  assert.throws(
    () =>
      runtime.startTask({ description: "close during admission" }, async () => {
        runnerStarted = true;
      }),
    /WorktreeSupervisor 正在关闭/u,
  );
  assert.ok(observed.closing);
  assert.ok(observed.taskId);
  await observed.closing;
  await taskHost.waitForOwnershipRelease();
  assert.equal(runnerStarted, false);
  assert.equal(taskHost.taskRegistry.get(observed.taskId)?.status, "killed");

  const { service: probe } = await JobService.create({ workDir: workspace, picoHome });
  try {
    assert.equal(probe.get(observed.taskId)?.job.status, "cancelled");
  } finally {
    probe.close();
  }
});

test("Daemon retains its singleton lock when the shutdown ownership fence rejects", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-close-fence-reject-"));
  const picoHome = join(root, "pico-home");
  const endpoint: LocalDaemonEndpoint = {
    transport: "unix",
    address: join(root, "runtime.sock"),
    authTokenPath: join(root, "runtime.auth"),
  };
  const lockPath = join(root, "runtime.lock");
  const registrationStore = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
  const rejectedFence = deferred();
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  context.after(async () => {
    process.off("unhandledRejection", onUnhandledRejection);
    await rm(root, { recursive: true, force: true });
  });

  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    registrationStore,
    execute: async () => undefined,
  });
  service.shutdownOwnershipFence = () => ({
    pending: true,
    released: rejectedFence.promise,
  });
  const host = createLifecycleTestHost({
    endpoint,
    lockPath,
    registrationStore,
    service,
  });
  await host.start();
  await completesWithin(host.stop(), 500, "daemon stop waited for a rejecting ownership fence");

  rejectedFence.reject(new Error("ownership release failed"));
  await waitForImmediate();
  assert.deepEqual(unhandledRejections, []);
  assert.equal(await pathExists(lockPath), true);

  const candidateService = new WorkspaceRuntimeService({
    env: { PICO_HOME: join(root, "candidate-pico-home") },
    registrationStore,
    execute: async () => undefined,
  });
  const candidate = createLifecycleTestHost({
    endpoint,
    lockPath,
    registrationStore,
    service: candidateService,
  });
  await assert.rejects(
    candidate.start(),
    (error: unknown) => error instanceof LocalDaemonAlreadyRunningError,
  );
});

test("Daemon stop waits for an in-flight start before closing ownership", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-start-stop-"));
  const endpoint: LocalDaemonEndpoint = {
    transport: "unix",
    address: join(root, "runtime.sock"),
    authTokenPath: join(root, "runtime.auth"),
  };
  const lockPath = join(root, "runtime.lock");
  const registrationStore = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
  const listEntered = deferred();
  const releaseList = deferred();
  const originalList = registrationStore.list.bind(registrationStore);
  let blockFirstList = true;
  registrationStore.list = async () => {
    if (blockFirstList) {
      blockFirstList = false;
      listEntered.resolve();
      await releaseList.promise;
    }
    return originalList();
  };
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: join(root, "pico-home") },
    registrationStore,
    execute: async () => undefined,
  });
  const originalClose = service.close.bind(service);
  let serviceCloseCount = 0;
  service.close = () => {
    serviceCloseCount++;
    return originalClose();
  };
  const host = createLifecycleTestHost({
    endpoint,
    lockPath,
    registrationStore,
    service,
  });
  context.after(async () => {
    releaseList.resolve();
    await host.stop();
    await rm(root, { recursive: true, force: true });
  });

  const starting = host.start();
  await listEntered.promise;
  const stopping = host.stop();
  assert.strictEqual(host.stop(), stopping);
  await waitForImmediate();
  assert.equal(serviceCloseCount, 0);
  assert.equal(await pathExists(lockPath), true);

  releaseList.resolve();
  await starting;
  await stopping;
  assert.equal(host.status, "stopped");
  assert.equal(serviceCloseCount, 1);
  assert.equal(await pathExists(lockPath), false);
});

test("Daemon permanently consumes a service whose close rejects", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-close-service-reject-"));
  const endpoint: LocalDaemonEndpoint = {
    transport: "unix",
    address: join(root, "runtime.sock"),
    authTokenPath: join(root, "runtime.auth"),
  };
  const lockPath = join(root, "runtime.lock");
  const registrationStore = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: join(root, "pico-home") },
    registrationStore,
    execute: async () => undefined,
  });
  service.close = async () => {
    throw new Error("service close failed");
  };
  service.shutdownOwnershipFence = () => ({ pending: false, released: Promise.resolve() });
  const host = createLifecycleTestHost({
    endpoint,
    lockPath,
    registrationStore,
    service,
  });
  const candidates: LocalDaemonHost[] = [host];
  context.after(async () => {
    await Promise.allSettled(candidates.map((candidate) => candidate.stop()));
    await rm(root, { recursive: true, force: true });
  });

  await host.start();
  await assert.rejects(host.stop(), /service close failed/u);
  assert.equal(host.status, "stopped");
  await assert.rejects(host.start(), /host 已关闭/u);
  assert.equal(await pathExists(lockPath), false);

  const restartedService = new WorkspaceRuntimeService({
    env: { PICO_HOME: join(root, "restarted-pico-home") },
    registrationStore,
    execute: async () => undefined,
  });
  const restartedHost = createLifecycleTestHost({
    endpoint,
    lockPath,
    registrationStore,
    service: restartedService,
  });
  candidates.push(restartedHost);
  await restartedHost.start();
  await restartedHost.stop();
});

test("Daemon retains its lock when service close fails without an ownership fence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-close-no-fence-"));
  const endpoint: LocalDaemonEndpoint = {
    transport: "unix",
    address: join(root, "runtime.sock"),
    authTokenPath: join(root, "runtime.auth"),
  };
  const lockPath = join(root, "runtime.lock");
  const registrationStore = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
  const service: DisposableLocalRuntimeService = {
    handle: async () => ({}),
    replayEvents: async () => ({ events: [], hasMore: false }),
    subscribe: () => () => undefined,
    close: async () => {
      throw new Error("unfenced service close failed");
    },
  };
  const host = createLifecycleTestHost({
    endpoint,
    lockPath,
    registrationStore,
    service,
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  await host.start();
  await assert.rejects(host.stop(), /unfenced service close failed/u);
  assert.equal(await pathExists(lockPath), true);

  const candidateService = new WorkspaceRuntimeService({
    env: { PICO_HOME: join(root, "candidate-pico-home") },
    registrationStore,
    execute: async () => undefined,
  });
  const candidate = createLifecycleTestHost({
    endpoint,
    lockPath,
    registrationStore,
    service: candidateService,
  });
  await assert.rejects(
    candidate.start(),
    (error: unknown) => error instanceof LocalDaemonAlreadyRunningError,
  );
});

test("Daemon retains its lock when a Cron runtime cannot close", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-close-cron-failure-"));
  const workspace = join(root, "workspace");
  const endpoint: LocalDaemonEndpoint = {
    transport: "unix",
    address: join(root, "runtime.sock"),
    authTokenPath: join(root, "runtime.auth"),
  };
  const lockPath = join(root, "runtime.lock");
  const registrationStore = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
  await mkdir(workspace, { recursive: true });
  await registrationStore.register(workspace);
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: join(root, "pico-home") },
    registrationStore,
    execute: async () => undefined,
  });
  const host = new LocalDaemonHost({
    endpoint,
    registrationStore,
    service,
    cronRuntimeFactory: {
      create: async () => ({
        recoverInterruptedRuns: () => [],
        start: () => undefined,
        close: async () => {
          throw new Error("cron runtime close failed");
        },
      }),
    },
    lockOptions: lifecycleLockOptions(lockPath),
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  await host.start();
  assert.equal(host.registeredWorkspaces.length, 1);
  await assert.rejects(host.stop(), /cron runtime close failed/u);
  assert.equal(await pathExists(lockPath), true);

  const candidateService = new WorkspaceRuntimeService({
    env: { PICO_HOME: join(root, "candidate-pico-home") },
    registrationStore,
    execute: async () => undefined,
  });
  const candidate = createLifecycleTestHost({
    endpoint,
    lockPath,
    registrationStore,
    service: candidateService,
  });
  await assert.rejects(
    candidate.start(),
    (error: unknown) => error instanceof LocalDaemonAlreadyRunningError,
  );
});

test("Daemon signal handlers consume a rejecting stop promise", async (context) => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };
  const previousHandlers = new Set(process.listeners("SIGTERM"));
  let stopCount = 0;
  const host = {
    stop: async () => {
      stopCount++;
      throw new Error("signal shutdown failed");
    },
  } as unknown as LocalDaemonHost;
  process.on("unhandledRejection", onUnhandledRejection);
  const dispose = installLocalDaemonShutdownHandlers(host);
  context.after(() => {
    dispose();
    process.off("unhandledRejection", onUnhandledRejection);
  });
  const installed = process
    .listeners("SIGTERM")
    .find((listener) => !previousHandlers.has(listener));
  assert.ok(installed);

  installed("SIGTERM");
  installed("SIGTERM");
  await waitForImmediate();
  await waitForImmediate();

  assert.equal(stopCount, 1);
  assert.deepEqual(unhandledRejections, []);
  assert.equal(process.listeners("SIGTERM").includes(installed), false);
});

test("Desktop daemon shutdown fence times out once and clears a completed timer", async () => {
  const timedOutStop = deferred();
  const timeoutTimers = manualTimers();
  let timeoutQuitCount = 0;
  const timeoutErrors: unknown[] = [];
  const timedOutFence = createDesktopDaemonShutdownFence(
    { ownsProcess: true, stop: () => timedOutStop.promise },
    () => timeoutQuitCount++,
    (error) => timeoutErrors.push(error),
    timeoutTimers.options,
  );
  let timeoutPrevented = 0;
  timedOutFence({ preventDefault: () => timeoutPrevented++ });
  timedOutFence({ preventDefault: () => timeoutPrevented++ });
  await waitForImmediate();
  assert.equal(timeoutPrevented, 2);
  assert.equal(timeoutTimers.delay, 7);

  timeoutTimers.fire();
  assert.equal(timeoutQuitCount, 1);
  assert.equal(timeoutErrors.length, 1);
  assert.match(String(timeoutErrors[0]), /7ms/u);

  timedOutStop.resolve();
  await waitForImmediate();
  assert.equal(timeoutQuitCount, 1);
  assert.equal(timeoutErrors.length, 1);

  const completedStop = deferred();
  const completedTimers = manualTimers();
  let completedQuitCount = 0;
  const completedErrors: unknown[] = [];
  const completedFence = createDesktopDaemonShutdownFence(
    { ownsProcess: true, stop: () => completedStop.promise },
    () => completedQuitCount++,
    (error) => completedErrors.push(error),
    completedTimers.options,
  );
  completedFence({ preventDefault: () => undefined });
  await waitForImmediate();
  completedStop.resolve();
  await waitForImmediate();

  assert.equal(completedQuitCount, 1);
  assert.deepEqual(completedErrors, []);
  assert.equal(completedTimers.cleared, true);
  completedTimers.fire();
  assert.equal(completedQuitCount, 1);
  assert.deepEqual(completedErrors, []);
});

test("Hook reloader stop fences an in-flight reload and supports a fresh generation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-reloader-stop-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const initial = await loadHookSnapshot({ workDir: workspace, picoHome });
  const guardEntered = deferred();
  const guardRelease = deferred<boolean>();
  let swaps = 0;
  let externalSnapshot = initial.snapshot;
  const reloader = new HookConfigReloader({
    workDir: workspace,
    picoHome,
    initial,
    beforeSwap: async () => {
      guardEntered.resolve();
      return await guardRelease.promise;
    },
    onSwap: (result) => {
      swaps++;
      externalSnapshot = result.snapshot;
    },
  });
  context.after(async () => {
    guardRelease.resolve(true);
    await reloader.stop();
  });
  await reloader.start();

  const reloading = reloader.reload([join(workspace, ".pico", "hooks.json")]);
  await guardEntered.promise;
  let stopCompleted = false;
  const stopping = reloader.stop().then(() => {
    stopCompleted = true;
  });
  await waitForImmediate();
  assert.equal(stopCompleted, false);

  guardRelease.resolve(true);
  assert.equal(await reloading, false);
  await stopping;
  assert.equal(swaps, 0);
  assert.strictEqual(reloader.currentResult()?.snapshot, initial.snapshot);
  assert.strictEqual(externalSnapshot, initial.snapshot);
  assert.equal(await reloader.reload(), false);

  await reloader.start();
  assert.strictEqual(reloader.currentResult()?.snapshot, initial.snapshot);
  assert.strictEqual(externalSnapshot, initial.snapshot);
  assert.equal(await reloader.reload(), true);
  assert.equal(swaps, 1);
  assert.strictEqual(reloader.currentResult()?.snapshot, externalSnapshot);
  await reloader.stop();
});

test("Hook reloader absorbs an obsolete guard rejection after restart", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-reloader-stuck-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const initial = await loadHookSnapshot({ workDir: workspace, picoHome });
  const firstGuardEntered = deferred();
  const firstGuardRelease = deferred<boolean>();
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  let guardCalls = 0;
  let swaps = 0;
  const reloader = new HookConfigReloader({
    workDir: workspace,
    picoHome,
    initial,
    stopDrainTimeoutMs: 5,
    beforeSwap: async () => {
      guardCalls++;
      if (guardCalls !== 1) return true;
      firstGuardEntered.resolve();
      return await firstGuardRelease.promise;
    },
    onSwap: () => {
      swaps++;
    },
  });
  context.after(async () => {
    process.off("unhandledRejection", onUnhandledRejection);
    firstGuardRelease.resolve(true);
    await reloader.stop();
  });
  await reloader.start();

  const staleReload = reloader.reload();
  await firstGuardEntered.promise;
  await completesWithin(reloader.stop(), 500, "Hook reloader stop exceeded its bounded drain");
  assert.equal(swaps, 0);

  await reloader.start();
  assert.equal(await reloader.reload(), true);
  assert.equal(swaps, 1);

  firstGuardRelease.reject(new Error("late stale guard failure"));
  await waitForImmediate();
  assert.deepEqual(unhandledRejections, []);
  assert.equal(await staleReload, false);
  assert.equal(swaps, 1, "旧 generation 的 guard 晚拒绝不能影响新代");
  await reloader.stop();
});

test("Hook reloader keeps staged candidates paired across detached generations", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-reloader-staging-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const initial = await loadHookSnapshot({ workDir: workspace, picoHome });
  const guardEntered = [deferred(), deferred()];
  const guardRelease = [deferred<boolean>(), deferred<boolean>()];
  const staged = new WeakMap<object, number>();
  const applied: number[] = [];
  let guardCalls = 0;
  const reloader = new HookConfigReloader({
    workDir: workspace,
    picoHome,
    initial,
    stopDrainTimeoutMs: 5,
    beforeSwap: async ({ candidate }) => {
      const index = guardCalls++;
      guardEntered[index]?.resolve();
      const accepted = await guardRelease[index]?.promise;
      if (accepted) staged.set(candidate, index + 1);
      return accepted ?? false;
    },
    onSwap: (candidate) => {
      applied.push(staged.get(candidate) ?? -1);
      staged.delete(candidate);
    },
  });
  context.after(async () => {
    for (const guard of guardRelease) guard.resolve(false);
    await reloader.stop();
  });
  await reloader.start();

  const staleReload = reloader.reload();
  await guardEntered[0]?.promise;
  await completesWithin(reloader.stop(), 500, "Hook reloader stop exceeded its bounded drain");
  await reloader.start();
  const currentReload = reloader.reload();
  await guardEntered[1]?.promise;

  guardRelease[1]?.resolve(true);
  guardRelease[0]?.resolve(true);

  assert.equal(await currentReload, true);
  assert.equal(await staleReload, false);
  assert.deepEqual(applied, [2]);
  await reloader.stop();
});

test("Hook reloader stop returns when an obsolete guard never settles", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-reloader-never-guard-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const initial = await loadHookSnapshot({ workDir: workspace, picoHome });
  const guardEntered = deferred();
  const neverSettles = new Promise<boolean>(() => undefined);
  let guardCalls = 0;
  let swaps = 0;
  const reloader = new HookConfigReloader({
    workDir: workspace,
    picoHome,
    initial,
    stopDrainTimeoutMs: 5,
    beforeSwap: async () => {
      guardCalls++;
      if (guardCalls !== 1) return true;
      guardEntered.resolve();
      return await neverSettles;
    },
    onSwap: () => {
      swaps++;
    },
  });
  context.after(async () => await reloader.stop());
  await reloader.start();

  void reloader.reload();
  await guardEntered.promise;
  await completesWithin(reloader.stop(), 500, "Hook reloader stop waited forever for beforeSwap");

  await reloader.start();
  assert.equal(await reloader.reload(), true);
  assert.equal(swaps, 1);
  await reloader.stop();
});

test("Hook reloader treats synchronous swap as the commit point", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-reloader-commit-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const configPath = join(workspace, ".pico", "hooks.json");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await writeFile(configPath, "{}\n");
  context.after(() => rm(root, { recursive: true, force: true }));

  const initial = await loadHookSnapshot({ workDir: workspace, picoHome });
  let externalSnapshot = initial.snapshot;
  let swaps = 0;
  let stopping: Promise<void> | undefined;
  const reloader = new HookConfigReloader({
    workDir: workspace,
    picoHome,
    initial,
    debounceMs: 5,
    onSwap: (result) => {
      swaps++;
      externalSnapshot = result.snapshot;
      stopping = reloader.stop();
    },
  });
  context.after(async () => await reloader.stop());
  await reloader.start();

  assert.equal(await reloader.reload(), true);
  await stopping;
  assert.equal(swaps, 1);
  assert.strictEqual(reloader.currentResult()?.snapshot, externalSnapshot);
  assert.notStrictEqual(externalSnapshot, initial.snapshot);

  await writeFile(configPath, '{"SessionStart":[]}\n');
  await delay(30);
  assert.equal(swaps, 1, "await stop 后不能残留可触发的 watcher");

  await reloader.start();
  assert.strictEqual(reloader.currentResult()?.snapshot, externalSnapshot);
  await writeFile(configPath, "{}\n");
  await waitUntil(() => swaps === 2);
  await stopping;
});

test("Hook reloader keeps the previous snapshot when synchronous swap throws", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-reloader-swap-error-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const initial = await loadHookSnapshot({ workDir: workspace, picoHome });
  const reloader = new HookConfigReloader({
    workDir: workspace,
    picoHome,
    initial,
    onSwap: () => {
      throw new Error("swap failed");
    },
  });
  context.after(async () => await reloader.stop());
  await reloader.start();

  await assert.rejects(reloader.reload(), /swap failed/u);
  assert.strictEqual(reloader.currentResult()?.snapshot, initial.snapshot);
});

test("Hook reloader replaces watcher path sets after a same-directory script change", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-reloader-watch-paths-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const configPath = join(workspace, ".pico", "hooks.json");
  const safeScript = join(workspace, "safe.js");
  const changedScript = join(workspace, "changed.js");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await writeFile(safeScript, "export const value = 'safe';\n");
  await writeFile(changedScript, "export const value = 'initial';\n");
  await writeCommandHook(configPath, "node safe.js");
  context.after(() => rm(root, { recursive: true, force: true }));

  const initial = await loadHookSnapshot({ workDir: workspace, picoHome });
  let swaps = 0;
  const reloader = new HookConfigReloader({
    workDir: workspace,
    picoHome,
    initial,
    debounceMs: 5,
    onSwap: () => {
      swaps++;
    },
  });
  context.after(async () => await reloader.stop());
  await reloader.start();

  await writeCommandHook(configPath, "node changed.js");
  assert.equal(await reloader.reload([configPath]), true);
  assert.equal(swaps, 1);

  await writeFile(changedScript, "export const value = 'changed';\n");
  await waitUntil(() => swaps >= 2);
  assert.equal(swaps, 2);
});

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve = (_value: T): void => undefined;
  let reject = (_reason?: unknown): void => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createLifecycleTestHost(options: {
  endpoint: LocalDaemonEndpoint;
  lockPath: string;
  registrationStore: WorkspaceRegistrationStore;
  service: DisposableLocalRuntimeService;
}): LocalDaemonHost {
  return new LocalDaemonHost({
    ...options,
    cronRuntimeFactory: {
      create: async () => {
        throw new Error("lifecycle test must not create a Cron runtime");
      },
    },
    lockOptions: lifecycleLockOptions(options.lockPath),
  });
}

function lifecycleLockOptions(lockPath: string) {
  return {
    lockPath,
    ping: async () => false,
    isProcessAlive: () => true,
  };
}

async function writeCommandHook(path: string, command: string): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({ PreToolUse: [{ hooks: [{ type: "command", command }] }] }, null, 2)}\n`,
  );
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.equal(predicate(), true, `condition was not met within ${timeoutMs}ms`);
}

async function waitUntilAsync(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) await delay(10);
  assert.equal(await predicate(), true, `condition was not met within ${timeoutMs}ms`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

function manualTimers(): {
  readonly options: DesktopDaemonShutdownFenceOptions;
  readonly delay: number | undefined;
  readonly cleared: boolean;
  fire(): void;
} {
  const handle = {};
  let callback: (() => void) | undefined;
  let delay: number | undefined;
  let cleared = false;
  return {
    options: {
      timeoutMs: 7,
      setTimeout: (nextCallback, nextDelay) => {
        callback = nextCallback;
        delay = nextDelay;
        return handle;
      },
      clearTimeout: (candidate) => {
        assert.strictEqual(candidate, handle);
        cleared = true;
      },
    },
    get delay() {
      return delay;
    },
    get cleared() {
      return cleared;
    },
    fire: () => callback?.(),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

async function initializeGitRepository(cwd: string): Promise<void> {
  await runGit(["init", "--quiet", "--initial-branch=main"], cwd);
  await runGit(
    [
      "-c",
      "user.name=Pico Test",
      "-c",
      "user.email=pico@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "baseline",
    ],
    cwd,
  );
}

function runGit(args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolveRun();
    });
  });
}
