import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDesktopTerminalCleanupFence,
  DesktopTerminalGenerationController,
} from "../../apps/desktop/src/main/daemon-controller.js";
import {
  createChildProcessWorkbarTerminalFallback,
  createPreferredWorkbarTerminalProcessFactory,
  WorkbarTerminalAuthority,
  WorkbarTerminalError,
  type WorkbarTerminalProcess,
  type WorkbarTerminalProcessExit,
  type WorkbarTerminalProcessFactory,
  type WorkbarTerminalRecord,
  type WorkbarTerminalStateStore,
} from "../../packages/runtime-host/src/server/workbar-terminal-authority.js";

test("Desktop 生产依赖提供可 resize 的真实 PTY", async (context) => {
  if (process.platform === "win32") return;
  const workspacePath = await createWorkspace(context, "real-pty");
  const processFactory = createPreferredWorkbarTerminalProcessFactory();
  assert.equal(processFactory.capability, "pty");
  const authority = new WorkbarTerminalAuthority({
    store: new MemoryStateStore(),
    processFactory,
    shell: "/bin/sh",
    shellArgs: [],
  });
  context.after(() => authority.close());

  const created = await authority.create({
    workspacePath,
    sessionId: "session-real-pty",
    cols: 80,
    rows: 24,
  });
  assert.equal(created.capability, "pty");
  assert.equal(created.resizeSupported, true);
  await authority.resize({
    resourceId: created.resourceId,
    resourceEpoch: created.resourceEpoch,
    cols: 100,
    rows: 30,
  });
  authority.input({
    resourceId: created.resourceId,
    resourceEpoch: created.resourceEpoch,
    data: "printf 'real-pty-ready\\n'\n",
  });
  await waitFor(() =>
    Promise.resolve(
      authority
        .attach({
          resourceId: created.resourceId,
          resourceEpoch: created.resourceEpoch,
          attachmentId: "real-pty-view",
        })
        .events.some((event) => event.kind === "output" && event.data.includes("real-pty-ready")),
    ),
  );
  await authority.stop({
    resourceId: created.resourceId,
    resourceEpoch: created.resourceEpoch,
  });
});

class MemoryStateStore implements WorkbarTerminalStateStore {
  records: WorkbarTerminalRecord[] = [];

  async load(): Promise<readonly WorkbarTerminalRecord[]> {
    return structuredClone(this.records);
  }

  async save(records: readonly WorkbarTerminalRecord[]): Promise<void> {
    this.records = [...structuredClone(records)];
  }
}

class FakeProcessFactory implements WorkbarTerminalProcessFactory {
  readonly capability = "pty" as const;
  readonly processes: FakeProcess[] = [];

  async spawn(
    _input: Parameters<WorkbarTerminalProcessFactory["spawn"]>[0],
    handlers: Parameters<WorkbarTerminalProcessFactory["spawn"]>[1],
  ): Promise<WorkbarTerminalProcess> {
    const process = new FakeProcess(10_000 + this.processes.length, handlers);
    this.processes.push(process);
    return process;
  }
}

class FakeProcess implements WorkbarTerminalProcess {
  readonly capability = "pty" as const;
  readonly resizeSupported = true;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  readonly signals: Array<"SIGTERM" | "SIGKILL"> = [];

  constructor(
    readonly pid: number,
    private readonly handlers: {
      readonly onData: (data: string) => void;
      readonly onExit: (exit: WorkbarTerminalProcessExit) => void;
    },
  ) {}

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  terminate(signal: "SIGTERM" | "SIGKILL"): void {
    this.signals.push(signal);
  }

  output(data: string): void {
    this.handlers.onData(data);
  }

  exit(exit: WorkbarTerminalProcessExit): void {
    this.handlers.onExit(exit);
  }
}

class ControlledProcessFactory implements WorkbarTerminalProcessFactory {
  readonly capability = "pty" as const;
  readonly processes: FakeProcess[] = [];
  readonly #pending: Array<{
    readonly handlers: Parameters<WorkbarTerminalProcessFactory["spawn"]>[1];
    readonly resolve: (process: WorkbarTerminalProcess) => void;
  }> = [];
  spawnCount = 0;

  spawn(
    _input: Parameters<WorkbarTerminalProcessFactory["spawn"]>[0],
    handlers: Parameters<WorkbarTerminalProcessFactory["spawn"]>[1],
  ): Promise<WorkbarTerminalProcess> {
    this.spawnCount++;
    return new Promise((resolve) => this.#pending.push({ handlers, resolve }));
  }

  resolveNext(exitOnTerminate: boolean): FakeProcess {
    const pending = this.#pending.shift();
    assert.ok(pending, "expected a controlled terminal spawn");
    const process = exitOnTerminate
      ? new AutoExitFakeProcess(20_000 + this.processes.length, pending.handlers)
      : new FakeProcess(20_000 + this.processes.length, pending.handlers);
    this.processes.push(process);
    pending.resolve(process);
    return process;
  }
}

class AutoExitFakeProcess extends FakeProcess {
  override terminate(signal: "SIGTERM" | "SIGKILL"): void {
    super.terminate(signal);
    this.exit({ signal });
  }
}

test("Host terminal 支持多实例、attach/detach、有界回放和单调 sequence", async (context) => {
  const workspacePath = await createWorkspace(context, "lifecycle");
  const store = new MemoryStateStore();
  const factory = new FakeProcessFactory();
  const routed: Array<{ sequence: number; attachmentIds: readonly string[] }> = [];
  const authority = new WorkbarTerminalAuthority({
    store,
    processFactory: factory,
    maxRingBytes: 6,
    maxRingEvents: 10,
    onEvent: (event, attachmentIds) => routed.push({ sequence: event.sequence, attachmentIds }),
  });

  const first = await authority.create({ workspacePath, sessionId: "session-1" });
  const second = await authority.create({ workspacePath, sessionId: "session-1" });
  assert.notEqual(first.resourceId, second.resourceId);
  assert.notEqual(first.resourceEpoch, second.resourceEpoch);
  assert.equal((await authority.list({ workspacePath, sessionId: "session-1" })).length, 2);

  authority.attach({
    resourceId: first.resourceId,
    resourceEpoch: first.resourceEpoch,
    attachmentId: "view-1",
  });
  const process = factory.processes[0];
  assert.ok(process);
  process.output("abc");
  process.output("def");
  process.output("ghi");
  const replay = authority.attach({
    resourceId: first.resourceId,
    resourceEpoch: first.resourceEpoch,
    attachmentId: "view-2",
    afterSequence: 0,
  });
  assert.equal(replay.truncated, true);
  assert.equal(replay.firstAvailableSequence, 2);
  assert.deepEqual(
    replay.events.map((event) => event.sequence),
    [2, 3],
  );
  assert.deepEqual(
    replay.events.map((event) => (event.kind === "output" ? event.data : event.kind)),
    ["def", "ghi"],
  );

  authority.input({
    resourceId: first.resourceId,
    resourceEpoch: first.resourceEpoch,
    data: "pwd\n",
  });
  await authority.resize({
    resourceId: first.resourceId,
    resourceEpoch: first.resourceEpoch,
    cols: 120,
    rows: 40,
  });
  assert.deepEqual(process.writes, ["pwd\n"]);
  assert.deepEqual(process.resizes, [{ cols: 120, rows: 40 }]);

  authority.detach({ resourceId: first.resourceId, attachmentId: "view-1" });
  authority.detach({ resourceId: first.resourceId, attachmentId: "view-2" });
  process.output("jkl");
  assert.deepEqual(process.signals, [], "detach 不应终止 Host 进程");
  assert.deepEqual(routed.at(-1)?.attachmentIds, []);

  await assert.rejects(
    Promise.resolve().then(() =>
      authority.input({
        resourceId: first.resourceId,
        resourceEpoch: "stale-epoch",
        data: "x",
      }),
    ),
    (error: unknown) =>
      error instanceof WorkbarTerminalError && error.code === "resource_epoch_mismatch",
  );

  process.exit({ exitCode: 0 });
  await authority.idle();
  assert.equal(
    (await authority.list({ workspacePath, sessionId: "session-1" }))[0]?.status,
    "exited",
  );
  await authority.close();
});

test("Host terminal stop 终止进程组，且重启把旧 running 记录标为 interrupted", async (context) => {
  const workspacePath = await createWorkspace(context, "recovery");
  const store = new MemoryStateStore();
  const factory = new FakeProcessFactory();
  const authority = new WorkbarTerminalAuthority({
    store,
    processFactory: factory,
    stopGraceMs: 5,
  });
  const terminal = await authority.create({ workspacePath, sessionId: "session-1" });
  const stopped = await authority.stop({
    resourceId: terminal.resourceId,
    resourceEpoch: terminal.resourceEpoch,
  });
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(factory.processes[0]?.signals, ["SIGTERM", "SIGKILL"]);

  store.records = [
    {
      ...terminal,
      status: "running",
      sequence: 7,
      pid: 12345,
    },
  ];
  const recovered = new WorkbarTerminalAuthority({ store, processFactory: factory });
  await recovered.recover();
  const [record] = await recovered.list({ workspacePath, sessionId: "session-1" });
  assert.equal(record?.status, "interrupted");
  assert.notEqual(record?.resourceEpoch, terminal.resourceEpoch);
  assert.equal(record?.sequence, 1);
  assert.equal(record?.pid, undefined);
  await assert.rejects(
    Promise.resolve().then(() =>
      recovered.attach({
        resourceId: terminal.resourceId,
        resourceEpoch: terminal.resourceEpoch,
        attachmentId: "stale-view",
      }),
    ),
    (error: unknown) =>
      error instanceof WorkbarTerminalError && error.code === "resource_epoch_mismatch",
  );
  assert.ok(record);
  const replay = recovered.attach({
    resourceId: terminal.resourceId,
    resourceEpoch: record.resourceEpoch,
    attachmentId: "recovered-view",
  });
  assert.equal(replay.events[0]?.kind, "status");
  assert.equal(replay.events[0]?.sequence, 1);
});

test("Host terminal stopAll 等待已接纳但仍在 spawn 的 create 后再完成", async (context) => {
  const workspacePath = await createWorkspace(context, "create-cleanup-fence");
  const store = new MemoryStateStore();
  const factory = new ControlledProcessFactory();
  const authority = new WorkbarTerminalAuthority({
    store,
    processFactory: factory,
    stopGraceMs: 5,
  });
  context.after(() => authority.close());

  const creating = authority.create({ workspacePath, sessionId: "session-1" });
  await waitFor(async () => factory.spawnCount === 1);
  let cleanupFinished = false;
  const cleanup = authority.stopAll().then((stopped) => {
    cleanupFinished = true;
    return stopped;
  });
  await Promise.resolve();
  assert.equal(cleanupFinished, false);

  const process = factory.resolveNext(true);
  const created = await creating;
  assert.equal(await cleanup, 1);
  assert.deepEqual(process.signals, ["SIGTERM"]);
  const persisted = store.records.find((record) => record.resourceId === created.resourceId);
  assert.equal(persisted?.status, "stopped");
  assert.equal(persisted?.pid, undefined);
});

test("Desktop 慢 spawn 超过退出 fence 时已向真实 Authority 提交 stopAll", async (context) => {
  const workspacePath = await createWorkspace(context, "desktop-slow-create-fence");
  const factory = new ControlledProcessFactory();
  const authority = new WorkbarTerminalAuthority({
    store: new MemoryStateStore(),
    processFactory: factory,
    stopGraceMs: 5,
  });
  context.after(() => authority.close());
  const generation = new DesktopTerminalGenerationController();
  await generation.open(async () => undefined);
  const creating = generation.submitCreate(() =>
    authority.create({ workspacePath, sessionId: "session-1" }),
  );
  assert.ok(creating);
  await waitFor(async () => factory.spawnCount === 1);

  let timeoutCallback: (() => void) | undefined;
  let scheduledDelay: number | undefined;
  let quitCount = 0;
  let stopAllSubmitted = false;
  const errors: unknown[] = [];
  const fence = createDesktopTerminalCleanupFence(
    {
      stopAll: () =>
        generation.cleanup(async () => {
          const stopping = authority.stopAll();
          stopAllSubmitted = true;
          await stopping;
        }),
    },
    () => quitCount++,
    (error) => errors.push(error),
    {
      timeoutMs: 5_000,
      setTimeout: (callback, delayMs) => {
        timeoutCallback = callback;
        scheduledDelay = delayMs;
        return callback;
      },
      clearTimeout: () => undefined,
    },
  );
  fence({ preventDefault: () => undefined });
  await waitFor(async () => stopAllSubmitted);

  await assert.rejects(
    authority.create({ workspacePath, sessionId: "late-session" }),
    (error: unknown) => error instanceof WorkbarTerminalError && error.code === "admission_closed",
  );
  assert.equal(scheduledDelay, 5_000);
  timeoutCallback?.();
  assert.equal(quitCount, 1);
  assert.match(String(errors[0]), /cleanup exceeded/u);

  const process = factory.resolveNext(true);
  const created = await creating;
  await waitFor(async () => {
    const records = await authority.list({ workspacePath, sessionId: "session-1" });
    return records[0]?.status === "stopped";
  });
  assert.deepEqual(process.signals, ["SIGTERM"]);
  assert.equal(created.resourceId.length > 0, true);
});

test("Desktop 旧 create handler 未完成前 activate 不得 resume 真实 Authority", async (context) => {
  const workspacePath = await createWorkspace(context, "desktop-delayed-handler-generation");
  const authority = new WorkbarTerminalAuthority({
    store: new MemoryStateStore(),
    processFactory: new FakeProcessFactory(),
  });
  context.after(() => authority.close());
  const generation = new DesktopTerminalGenerationController();
  await generation.open(async () => undefined);
  const handlerGate = Promise.withResolvers<void>();
  const oldCreate = generation.submitCreate(async () => {
    await handlerGate.promise;
    return authority.create({ workspacePath, sessionId: "old-session" });
  });
  assert.ok(oldCreate);
  let stopAllFinished = false;
  const cleanup = generation.cleanup(async () => {
    await authority.stopAll();
    stopAllFinished = true;
  });
  let resumeCount = 0;
  const opening = generation.open(async () => {
    resumeCount++;
    authority.resumeCreates();
  });

  await waitFor(async () => stopAllFinished);
  assert.equal(resumeCount, 0, "stopAll 已完成但旧 handler 未响应时仍不得 resume");
  handlerGate.resolve();
  await assert.rejects(
    oldCreate,
    (error: unknown) => error instanceof WorkbarTerminalError && error.code === "admission_closed",
  );
  await cleanup;
  await opening;
  assert.equal(resumeCount, 1);
  assert.deepEqual(await authority.list({ workspacePath, sessionId: "old-session" }), []);
});

test("Host terminal 退出清理锁住 admission，显式 resume 后才开启下一代", async (context) => {
  const workspacePath = await createWorkspace(context, "cleanup-reopen-generation");
  const factory = new ControlledProcessFactory();
  const authority = new WorkbarTerminalAuthority({
    store: new MemoryStateStore(),
    processFactory: factory,
    stopGraceMs: 100,
  });
  context.after(() => authority.close());

  const firstCreating = authority.create({ workspacePath, sessionId: "session-1" });
  await waitFor(async () => factory.spawnCount === 1);
  const firstProcess = factory.resolveNext(false);
  const first = await firstCreating;

  const cleanup = authority.stopAll();
  await waitFor(async () => firstProcess.signals[0] === "SIGTERM");
  await assert.rejects(
    authority.create({ workspacePath, sessionId: "session-1" }),
    (error: unknown) => error instanceof WorkbarTerminalError && error.code === "admission_closed",
  );
  assert.throws(
    () => authority.resumeCreates(),
    (error: unknown) => error instanceof WorkbarTerminalError && error.code === "admission_closed",
  );
  assert.equal(factory.spawnCount, 1, "cleanup 未完成前不得接纳下一代 spawn");

  firstProcess.exit({ signal: "SIGTERM" });
  assert.equal(await cleanup, 1);
  await assert.rejects(
    authority.create({ workspacePath, sessionId: "session-1" }),
    (error: unknown) => error instanceof WorkbarTerminalError && error.code === "admission_closed",
  );
  authority.resumeCreates();
  const reopenedCreating = authority.create({ workspacePath, sessionId: "session-1" });
  await waitFor(async () => factory.spawnCount === 2);
  const reopenedProcess = factory.resolveNext(false);
  const reopened = await reopenedCreating;
  assert.notEqual(reopened.resourceId, first.resourceId);
  assert.equal(reopened.status, "running");
  assert.deepEqual(reopenedProcess.signals, [], "旧代 stopAll 不得终止新 App 代际的终端");
});

test("Host terminal stopAll 只终止 Authority 持有的进程组并持久化终态", async (context) => {
  if (process.platform === "win32") return;
  const workspacePath = await createWorkspace(context, "stop-all-process-group");
  const childPidFile = join(workspacePath, "terminal-child.pid");
  const store = new MemoryStateStore();
  const authority = new WorkbarTerminalAuthority({
    store,
    processFactory: createChildProcessWorkbarTerminalFallback("forced by test"),
    shell: "/bin/sh",
    shellArgs: ["-c", 'sleep 30 & echo "$!" > "$PICO_TERMINAL_CHILD_PID_FILE"; wait'],
    env: { PICO_TERMINAL_CHILD_PID_FILE: childPidFile },
    stopGraceMs: 100,
  });
  context.after(() => authority.close());

  const sentinel = spawnChild("/bin/sh", ["-c", "sleep 30"], {
    detached: true,
    stdio: "ignore",
  });
  assert.ok(sentinel.pid);
  context.after(() => terminateTestProcessGroup(sentinel.pid));

  const created = await authority.create({ workspacePath, sessionId: "session-1" });
  const running = store.records.find((record) => record.resourceId === created.resourceId);
  assert.ok(running?.pid);
  const terminalPid = running.pid;
  context.after(() => terminateTestProcessGroup(terminalPid));
  await waitFor(async () => {
    try {
      return Number.isSafeInteger(Number((await readFile(childPidFile, "utf8")).trim()));
    } catch {
      return false;
    }
  });
  const childPid = Number((await readFile(childPidFile, "utf8")).trim());
  assert.equal(isProcessPresent(terminalPid), true);
  assert.equal(isProcessPresent(childPid), true);
  assert.equal(isProcessPresent(sentinel.pid), true);

  assert.equal(await authority.stopAll(), 1);
  await waitFor(async () => !isProcessPresent(terminalPid) && !isProcessPresent(childPid), 5_000);
  assert.equal(isProcessPresent(sentinel.pid), true, "不得误杀 Authority 外的进程组");
  const persisted = store.records.find((record) => record.resourceId === created.resourceId);
  assert.equal(persisted?.status, "stopped");
  assert.equal(persisted?.pid, undefined);
  assert.equal(
    (await authority.list({ workspacePath, sessionId: "session-1" }))[0]?.status,
    "stopped",
  );
});

test("child process fallback 真实执行但明确声明 pipe，不伪称 PTY", async (context) => {
  if (process.platform === "win32") return;
  const workspacePath = await createWorkspace(context, "fallback");
  const store = new MemoryStateStore();
  const authority = new WorkbarTerminalAuthority({
    store,
    processFactory: createChildProcessWorkbarTerminalFallback("forced by test"),
    shell: "/bin/sh",
    shellArgs: ["-c", "printf fallback-ready"],
  });
  const created = await authority.create({ workspacePath, sessionId: "session-1" });
  assert.equal(created.capability, "pipe");
  assert.equal(created.resizeSupported, false);
  await waitFor(async () => {
    const [record] = await authority.list({ workspacePath, sessionId: "session-1" });
    return record?.status === "exited";
  });
  const attached = authority.attach({
    resourceId: created.resourceId,
    resourceEpoch: created.resourceEpoch,
    attachmentId: "view",
  });
  assert.match(
    attached.events
      .filter((event) => event.kind === "output")
      .map((event) => event.data)
      .join(""),
    /fallback-ready/u,
  );
});

async function createWorkspace(
  context: { after(callback: () => Promise<void> | void): void },
  name: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pico-workbar-terminal-${name}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for terminal state");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

function isProcessPresent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function terminateTestProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
