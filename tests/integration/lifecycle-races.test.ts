import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { test } from "node:test";
import {
  createDesktopDaemonShutdownFence,
  type DesktopDaemonShutdownFenceOptions,
} from "../../apps/desktop/src/main/daemon-controller.js";
import { WorkspaceRuntimeService } from "../../src/daemon/index.js";
import { loadHookSnapshot } from "../../src/hooks/config.js";
import { HookConfigReloader } from "../../src/hooks/config/reloader.js";
import { WorkspaceTaskRuntime } from "../../src/runtime/workspace-runtime.js";

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
  const reloader = new HookConfigReloader({
    workDir: workspace,
    picoHome,
    initial,
    beforeSwap: async () => {
      guardEntered.resolve();
      return await guardRelease.promise;
    },
    onSwap: () => {
      swaps++;
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
  assert.equal(await reloader.reload(), false);

  await reloader.start();
  assert.equal(await reloader.reload(), true);
  assert.equal(swaps, 1);
  await reloader.stop();
});

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
