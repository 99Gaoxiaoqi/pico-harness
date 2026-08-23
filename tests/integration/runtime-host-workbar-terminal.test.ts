import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
