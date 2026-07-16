import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createRuntimeRequest,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import { RuntimeStore } from "../../src/tasks/runtime-store.js";

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
