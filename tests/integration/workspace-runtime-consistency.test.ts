import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  canonicalizeWorkspacePath,
  createRuntimeRequest,
  WorkspaceRegistrationStore,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import { RuntimeStore } from "../../src/tasks/runtime-store.js";

test("linked Git worktree keeps its own canonical Runtime identity", async (context) => {
  const fixture = await createFixture("linked-worktree-identity");
  const linkedWorktree = join(fixture.root, "linked-worktree");
  const linkedChild = join(linkedWorktree, "packages", "app");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await runGit(["init", "--quiet", "--initial-branch=main"], fixture.workspace);
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
    fixture.workspace,
  );
  await runGit(
    ["worktree", "add", "--quiet", "-b", "linked-test", linkedWorktree],
    fixture.workspace,
  );
  await mkdir(linkedChild, { recursive: true });

  const mainIdentity = await canonicalizeWorkspacePath(fixture.workspace);
  const linkedIdentity = await canonicalizeWorkspacePath(linkedChild);
  assert.equal(mainIdentity, await realpath(fixture.workspace));
  assert.equal(linkedIdentity, await realpath(linkedWorktree));
  assert.notEqual(linkedIdentity, mainIdentity);
});

test("Git discovery ignores inherited repository-selection environment", async (context) => {
  const fixture = await createFixture("git-environment-isolation");
  const ordinaryWorkspace = join(fixture.root, "ordinary-workspace");
  await mkdir(ordinaryWorkspace, { recursive: true });
  await runGit(["init", "--quiet", "--initial-branch=main"], fixture.workspace);
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const previousGitDir = process.env.GIT_DIR;
  const previousGitWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = join(fixture.workspace, ".git");
  process.env.GIT_WORK_TREE = fixture.workspace;
  try {
    assert.equal(
      await canonicalizeWorkspacePath(ordinaryWorkspace),
      await realpath(ordinaryWorkspace),
    );
    assert.equal(
      await canonicalizeWorkspacePath(fixture.workspace),
      await realpath(fixture.workspace),
    );
  } finally {
    restoreEnvironment("GIT_DIR", previousGitDir);
    restoreEnvironment("GIT_WORK_TREE", previousGitWorkTree);
  }
});

test("legacy child registrations migrate to the Git identity and remain removable", async (context) => {
  const fixture = await createFixture("legacy-registration-migration");
  const childWorkspace = join(fixture.workspace, "packages", "app");
  const registrationPath = join(fixture.picoHome, "registrations.json");
  await mkdir(childWorkspace, { recursive: true });
  await runGit(["init", "--quiet", "--initial-branch=main"], fixture.workspace);
  const canonicalWorkspace = await realpath(fixture.workspace);
  const legacyChild = await realpath(childWorkspace);
  const registrationStore = new WorkspaceRegistrationStore(registrationPath);
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: fixture.picoHome },
    registrationStore,
    execute: async () => undefined,
  });
  context.after(async () => {
    await service.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  await writeRegistrationFixture(registrationPath, [legacyChild, canonicalWorkspace]);
  assert.deepEqual(await registrationStore.list(), [canonicalWorkspace]);

  await writeRegistrationFixture(registrationPath, [legacyChild]);
  const unregistered = asRecord(
    await service.handle(
      createRuntimeRequest("workspace.unregister", { workspacePath: childWorkspace }),
    ),
  );
  assert.equal(unregistered["workspacePath"], canonicalWorkspace);
  assert.deepEqual(await registrationStore.list(), []);

  const removedWorkspace = join(fixture.root, "removed-workspace");
  await mkdir(removedWorkspace);
  await registrationStore.register(removedWorkspace);
  await rm(removedWorkspace, { recursive: true });
  const removed = asRecord(
    await service.handle(
      createRuntimeRequest("workspace.unregister", { workspacePath: removedWorkspace }),
    ),
  );
  assert.equal(removed["workspacePath"], removedWorkspace);
  assert.deepEqual(await registrationStore.list(), []);

  const prunedWorkspace = join(fixture.root, "pruned-workspace");
  await mkdir(prunedWorkspace);
  await registrationStore.register(prunedWorkspace);
  await rm(prunedWorkspace, { recursive: true });
  assert.deepEqual(await registrationStore.list(), [], "读取登记时应清理已不存在的陈旧路径");
});

test(
  "Git root and child paths share one Runtime identity and durable event ledger",
  { timeout: 15_000 },
  async (context) => {
    const fixture = await createFixture("git-identity");
    const childWorkspace = join(fixture.workspace, "packages", "app");
    await mkdir(childWorkspace, { recursive: true });
    await runGit(["init", "--quiet", "--initial-branch=main"], fixture.workspace);
    const canonicalWorkspace = await realpath(fixture.workspace);
    const registrationStore = new WorkspaceRegistrationStore(
      join(fixture.picoHome, "registrations.json"),
    );
    const services: WorkspaceRuntimeService[] = [];
    const createService = (): WorkspaceRuntimeService => {
      const service = new WorkspaceRuntimeService({
        env: { PICO_HOME: fixture.picoHome },
        registrationStore,
        execute: async () => ({ shared: true }),
      });
      services.push(service);
      return service;
    };
    const service = createService();
    context.after(async () => {
      await Promise.allSettled(services.map((candidate) => candidate.close()));
      await rm(fixture.root, { recursive: true, force: true });
    });

    const rootRuntime = await service.getWorkspaceRuntime(fixture.workspace);
    const childRuntime = await service.getWorkspaceRuntime(childWorkspace);
    assert.strictEqual(childRuntime, rootRuntime);
    assert.equal(rootRuntime.workspace, canonicalWorkspace);

    const registered = asRecord(
      await service.handle(
        createRuntimeRequest("workspace.register", { workspacePath: childWorkspace }),
      ),
    );
    assert.equal(registered["workspacePath"], canonicalWorkspace);
    assert.deepEqual(await registrationStore.list(), [canonicalWorkspace]);

    const request = {
      workspacePath: fixture.workspace,
      prompt: "shared Git identity",
      idempotencyKey: "git-root-and-child",
    } as const;
    const started = asRun(await service.startForegroundRun(request));
    await rootRuntime.waitForRun(started.runId);
    const replayed = asRun(
      await service.startForegroundRun({ ...request, workspacePath: childWorkspace }),
    );
    assert.equal(replayed.runId, started.runId);

    const rootPage = await service.replayEvents({ workspacePath: fixture.workspace });
    const childPage = await service.replayEvents({ workspacePath: childWorkspace });
    assert.deepEqual(
      childPage.events.map((event) => event.eventId),
      rootPage.events.map((event) => event.eventId),
    );
    assert.ok(rootPage.events.some((event) => event.topic === "run.finished"));
    assert.ok(rootPage.events.every((event) => event.scope.workspacePath === canonicalWorkspace));

    const unregistered = asRecord(
      await service.handle(
        createRuntimeRequest("workspace.unregister", { workspacePath: childWorkspace }),
      ),
    );
    assert.equal(unregistered["workspacePath"], canonicalWorkspace);
    assert.deepEqual(await registrationStore.list(), []);
    const beforeRestart = await service.replayEvents({ workspacePath: childWorkspace });

    await service.close();
    const restarted = createService();
    const afterRestart = await restarted.replayEvents({ workspacePath: childWorkspace });
    assert.deepEqual(
      afterRestart.events.map((event) => event.eventId),
      beforeRestart.events.map((event) => event.eventId),
    );
  },
);

test("Run projection and Runtime event roll back together when event append fails", async (context) => {
  const fixture = await createFixture("atomic-run-event");
  const canonicalWorkspace = await realpath(fixture.workspace);
  const store = new RuntimeStore({
    workDir: canonicalWorkspace,
    picoHome: fixture.picoHome,
    now: () => 2_000,
  });
  context.after(async () => {
    store.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const running = {
    runId: "run-atomic",
    workspacePath: canonicalWorkspace,
    description: "atomic projection",
    status: "running" as const,
    startedAt: 1_000,
    updatedAt: 1_000,
    version: 1,
  };
  store.upsertDaemonRun(running);
  store.appendRuntimeEvent({
    eventId: "duplicate-event",
    topic: "test.seed",
    workspacePath: canonicalWorkspace,
    createdAt: 1_500,
  });

  assert.throws(
    () =>
      store.appendRuntimeEvent(
        {
          eventId: "duplicate-event",
          topic: "run.finished",
          workspacePath: canonicalWorkspace,
          createdAt: 2_000,
        },
        {
          daemonRun: {
            ...running,
            status: "succeeded",
            updatedAt: 2_000,
            finishedAt: 2_000,
            version: 2,
          },
        },
      ),
    /UNIQUE constraint failed/u,
  );

  assert.deepEqual(store.getDaemonRun(canonicalWorkspace, running.runId), running);
  assert.deepEqual(
    store.listRuntimeEvents({ workspacePath: canonicalWorkspace }).map((event) => event.topic),
    ["test.seed"],
  );
});

test(
  "run.start idempotency survives restart and rejects a changed request",
  { timeout: 15_000 },
  async (context) => {
    const fixture = await createFixture("idempotency");
    const services: WorkspaceRuntimeService[] = [];
    context.after(async () => {
      await Promise.allSettled(services.map((service) => service.close()));
      await rm(fixture.root, { recursive: true, force: true });
    });
    const executionStarted = deferred();
    let executions = 0;
    const execute = async ({
      context: runContext,
    }: Parameters<ConstructorParameters<typeof WorkspaceRuntimeService>[0]["execute"]>[0]) => {
      executions++;
      executionStarted.resolve();
      await rejectWhenAborted(runContext.signal);
    };
    const service = new WorkspaceRuntimeService({
      env: { PICO_HOME: fixture.picoHome },
      execute,
    });
    services.push(service);
    const request = {
      workspacePath: fixture.workspace,
      prompt: "idempotent prompt",
      sessionId: "session-idempotent",
      execution: { requestedModel: "provider/model", allowedTools: ["read_file"] },
      idempotencyKey: "same-run-start",
    } as const;

    const first = asRun(await service.startForegroundRun(request));
    await executionStarted.promise;
    const replayed = asRun(await service.startForegroundRun(request));
    assert.equal(replayed.runId, first.runId);
    assert.equal(executions, 1);
    await assert.rejects(
      service.startForegroundRun({ ...request, prompt: "changed prompt" }),
      (error: unknown) =>
        error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.CONFLICT,
    );

    await service.close();
    const restarted = new WorkspaceRuntimeService({
      env: { PICO_HOME: fixture.picoHome },
      execute,
    });
    services.push(restarted);
    const afterRestart = asRun(await restarted.startForegroundRun(request));
    assert.equal(afterRestart.runId, first.runId);
    assert.equal(afterRestart.status, "cancelled");
    assert.equal(executions, 1);
  },
);

test(
  "late Session binding is durable and replayable as run.updated",
  { timeout: 15_000 },
  async (context) => {
    const fixture = await createFixture("session-binding");
    const services: WorkspaceRuntimeService[] = [];
    context.after(async () => {
      await Promise.allSettled(services.map((service) => service.close()));
      await rm(fixture.root, { recursive: true, force: true });
    });
    const service = new WorkspaceRuntimeService({
      env: { PICO_HOME: fixture.picoHome },
      execute: async ({ context: runContext }) => {
        runContext.bindSession("session-late");
        return { bound: true };
      },
    });
    services.push(service);

    const started = asRun(
      await service.startForegroundRun({
        workspacePath: fixture.workspace,
        prompt: "bind later",
        idempotencyKey: "late-session-binding",
      }),
    );
    const runtime = await service.getWorkspaceRuntime(fixture.workspace);
    const finished = await runtime.waitForRun(started.runId);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.sessionId, "session-late");

    const listed = asRunList(
      await service.handle(
        createRuntimeRequest("runs.list", {
          workspacePath: fixture.workspace,
          sessionId: "session-late",
        }),
      ),
    );
    assert.deepEqual(
      listed.runs.map((run) => run.runId),
      [started.runId],
    );

    const page = await service.replayEvents({ workspacePath: fixture.workspace });
    const startedEvent = page.events.find((event) => event.topic === "run.started");
    const bindingEvent = page.events.find((event) => event.topic === "run.updated");
    assert.equal(startedEvent?.scope.sessionId, undefined);
    assert.equal(bindingEvent?.scope.sessionId, "session-late");
    assert.equal(asRecord(asRecord(bindingEvent?.payload)["run"])["sessionId"], "session-late");

    await service.close();
    const restarted = new WorkspaceRuntimeService({
      env: { PICO_HOME: fixture.picoHome },
      execute: async () => undefined,
    });
    services.push(restarted);
    const restored = asRunList(
      await restarted.handle(
        createRuntimeRequest("runs.list", {
          workspacePath: fixture.workspace,
          sessionId: "session-late",
        }),
      ),
    );
    assert.deepEqual(
      restored.runs.map((run) => run.runId),
      [started.runId],
    );
  },
);

test(
  "interrupted daemon Run recovery publishes one durable run.finished fact",
  { timeout: 15_000 },
  async (context) => {
    const fixture = await createFixture("recovery-event");
    const canonicalWorkspace = await realpath(fixture.workspace);
    const seed = new RuntimeStore({
      workDir: canonicalWorkspace,
      picoHome: fixture.picoHome,
      now: () => 1_000,
    });
    seed.upsertDaemonRun({
      runId: "run-interrupted",
      workspacePath: canonicalWorkspace,
      sessionId: "session-recovery",
      description: "interrupted",
      status: "running",
      startedAt: 1,
      updatedAt: 1,
      version: 1,
    });
    seed.close();

    const services: WorkspaceRuntimeService[] = [];
    const createService = (): WorkspaceRuntimeService => {
      const service = new WorkspaceRuntimeService({
        env: { PICO_HOME: fixture.picoHome },
        now: () => 1_000,
        execute: async () => undefined,
      });
      services.push(service);
      return service;
    };
    const service = createService();
    context.after(async () => {
      await Promise.allSettled(services.map((candidate) => candidate.close()));
      await rm(fixture.root, { recursive: true, force: true });
    });
    const live: unknown[] = [];
    service.subscribe((event) => live.push(event));

    const firstPage = await service.replayEvents({ workspacePath: fixture.workspace });
    const liveFinished = live.filter((event) => asRecord(event)["topic"] === "run.finished");
    const replayedFinished = firstPage.events.filter((event) => event.topic === "run.finished");
    assert.equal(liveFinished.length, 1);
    assert.equal(replayedFinished.length, 1);
    assert.deepEqual(replayedFinished[0]?.scope, {
      workspacePath: canonicalWorkspace,
      sessionId: "session-recovery",
      runId: "run-interrupted",
    });
    const recoveredRun = asRecord(asRecord(replayedFinished[0]?.payload)["run"]);
    assert.equal(recoveredRun["status"], "failed");
    assert.equal(recoveredRun["version"], 2);
    assert.match(String(recoveredRun["error"]), /重启前 Run 未进入终态/u);
    const recoveryEventId = requiredString(replayedFinished[0]?.eventId, "eventId");

    await service.close();
    const restarted = createService();
    const afterRestart = await restarted.replayEvents({ workspacePath: fixture.workspace });
    const restartedFinished = afterRestart.events.filter((event) => event.topic === "run.finished");
    assert.equal(restartedFinished.length, 1);
    assert.equal(restartedFinished[0]?.eventId, recoveryEventId);
  },
);

async function createFixture(label: string): Promise<{
  root: string;
  workspace: string;
  picoHome: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-workspace-${label}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  return { root, workspace, picoHome };
}

function asRun(value: unknown): { runId: string; status: string } {
  const record = asRecord(value);
  return {
    runId: requiredString(record["runId"], "runId"),
    status: requiredString(record["status"], "status"),
  };
}

function asRunList(value: unknown): { runs: Array<{ runId: string }> } {
  const record = asRecord(value);
  assert.ok(Array.isArray(record["runs"]));
  return {
    runs: record["runs"].map((run) => {
      const item = asRecord(run);
      return { runId: requiredString(item["runId"], "runId") };
    }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function writeRegistrationFixture(
  path: string,
  workspaces: readonly string[],
): Promise<void> {
  await writeFile(path, `${JSON.stringify({ version: 1, workspaces }, null, 2)}\n`);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = () => reject(signal.reason ?? new Error("runtime closed"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
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
