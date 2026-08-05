import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createRuntimeRequest,
  DesktopRuntimeService,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";

test("discovery.cancel cancels the Run launched for that Discovery", async (context) => {
  const fixture = await createFixture("matching-run");
  const started = deferred();
  const runtime = new WorkspaceRuntimeService({
    env: fixture.env,
    execute: async ({ context: runContext }) => {
      started.resolve();
      await rejectWhenAborted(runContext.signal);
    },
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore: fixture.trustStore,
    env: fixture.env,
  });
  const sessionId = await createSession(desktop, fixture.workspace);
  context.after(async () => {
    await desktop.close();
    await closeSession(fixture, sessionId);
    await rm(fixture.root, { recursive: true, force: true });
  });

  const initialDiscovery = await getDiscovery(desktop, fixture.workspace, sessionId);
  await desktop.handle(
    createRuntimeRequest("discovery.start", {
      workspacePath: fixture.workspace,
      sessionId,
      objective: "定位目标实现",
      depth: "quick",
      operationId: "matching-start",
      expectedSessionSequence: requiredNumber(initialDiscovery["sessionSequence"]),
    }),
  );
  await started.promise;
  const run = await activeRun(runtime, fixture.workspace, sessionId);
  const currentDiscovery = await getDiscovery(desktop, fixture.workspace, sessionId);

  await desktop.handle(
    createRuntimeRequest("discovery.cancel", {
      workspacePath: fixture.workspace,
      sessionId,
      discoveryId: requiredString(asRecord(currentDiscovery["active"])["discoveryId"]),
      operationId: "matching-cancel",
      expectedSessionSequence: requiredNumber(currentDiscovery["sessionSequence"]),
    }),
  );

  assert.equal(
    (await runById(runtime, fixture.workspace, requiredString(run["runId"])))?.["status"],
    "cancelled",
  );
});

test("cancelling an old Discovery does not cancel a later ordinary Run", async (context) => {
  const fixture = await createFixture("later-run");
  const firstStarted = deferred();
  const secondStarted = deferred();
  let executions = 0;
  const runtime = new WorkspaceRuntimeService({
    env: fixture.env,
    execute: async ({ context: runContext }) => {
      executions++;
      (executions === 1 ? firstStarted : secondStarted).resolve();
      await rejectWhenAborted(runContext.signal);
    },
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore: fixture.trustStore,
    env: fixture.env,
  });
  const sessionId = await createSession(desktop, fixture.workspace);
  context.after(async () => {
    await desktop.close();
    await closeSession(fixture, sessionId);
    await rm(fixture.root, { recursive: true, force: true });
  });

  const initialDiscovery = await getDiscovery(desktop, fixture.workspace, sessionId);
  await desktop.handle(
    createRuntimeRequest("discovery.start", {
      workspacePath: fixture.workspace,
      sessionId,
      objective: "定位旧任务",
      depth: "quick",
      operationId: "old-start",
      expectedSessionSequence: requiredNumber(initialDiscovery["sessionSequence"]),
    }),
  );
  await firstStarted.promise;
  const discoveryRun = await activeRun(runtime, fixture.workspace, sessionId);
  await runtime.handle(
    createRuntimeRequest("run.cancel", {
      workspacePath: fixture.workspace,
      runId: requiredString(discoveryRun["runId"]),
      reason: "simulate an interrupted Discovery Run",
    }),
  );

  const sent = asRecord(
    await desktop.handle(
      createRuntimeRequest("session.send", {
        workspacePath: fixture.workspace,
        sessionId,
        input: { kind: "text", text: "普通后续任务" },
        idempotencyKey: "ordinary-follow-up",
      }),
    ),
  );
  const ordinaryRun = asRecord(sent["run"]);
  await secondStarted.promise;
  const currentDiscovery = await getDiscovery(desktop, fixture.workspace, sessionId);

  await desktop.handle(
    createRuntimeRequest("discovery.cancel", {
      workspacePath: fixture.workspace,
      sessionId,
      discoveryId: requiredString(asRecord(currentDiscovery["active"])["discoveryId"]),
      operationId: "old-cancel",
      expectedSessionSequence: requiredNumber(currentDiscovery["sessionSequence"]),
    }),
  );

  assert.equal(
    (await runById(runtime, fixture.workspace, requiredString(ordinaryRun["runId"])))?.["status"],
    "running",
  );
});

async function createFixture(name: string): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly canonicalWorkspace: string;
  readonly picoHome: string;
  readonly env: Readonly<Record<string, string>>;
  readonly trustStore: WorkspaceTrustStore;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-desktop-discovery-${name}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([
    mkdir(join(workspace, ".pico"), { recursive: true }),
    mkdir(picoHome, { recursive: true }),
  ]);
  await writeFile(
    join(workspace, ".pico", "config.json"),
    JSON.stringify({
      version: 1,
      model: "test/coder",
      providers: {
        test: {
          protocol: "openai",
          baseURL: "https://provider.invalid/v1",
          apiKeyEnv: "PICO_TEST_TOKEN",
          discoverModels: false,
          models: ["coder"],
        },
      },
    }),
    "utf8",
  );
  const canonicalWorkspace = await realpath(workspace);
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonicalWorkspace);
  return {
    root,
    workspace,
    canonicalWorkspace,
    picoHome,
    env: { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" },
    trustStore,
  };
}

async function createSession(
  desktop: DesktopRuntimeService,
  workspacePath: string,
): Promise<string> {
  const created = asRecord(
    await desktop.handle(
      createRuntimeRequest("session.create", { workspacePath, title: "Discovery" }),
    ),
  );
  return requiredString(asRecord(created["session"])["sessionId"]);
}

async function activeRun(
  runtime: WorkspaceRuntimeService,
  workspacePath: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const result = asRecord(
    await runtime.handle(createRuntimeRequest("runs.list", { workspacePath, sessionId })),
  );
  const run = asArray(result["runs"])
    .map(asRecord)
    .find((candidate) => candidate["status"] === "running");
  assert.ok(run);
  return run;
}

async function runById(
  runtime: WorkspaceRuntimeService,
  workspacePath: string,
  runId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = asRecord(
    await runtime.handle(createRuntimeRequest("runs.list", { workspacePath })),
  );
  return asArray(result["runs"])
    .map(asRecord)
    .find((run) => run["runId"] === runId);
}

function discoveryProjection(value: unknown): Record<string, unknown> {
  return asRecord(asRecord(value)["projection"]);
}

async function getDiscovery(
  desktop: DesktopRuntimeService,
  workspacePath: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  return discoveryProjection(
    await desktop.handle(createRuntimeRequest("discovery.get", { workspacePath, sessionId })),
  );
}

async function closeSession(
  fixture: {
    readonly canonicalWorkspace: string;
    readonly picoHome: string;
  },
  sessionId: string,
): Promise<void> {
  const session = globalSessionManager.delete(sessionId, fixture.canonicalWorkspace, {
    picoHome: fixture.picoHome,
  });
  await session?.close();
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
    const fail = () => reject(signal.reason ?? new Error("runtime cancelled"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function requiredString(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

function requiredNumber(value: unknown): number {
  assert.equal(typeof value, "number");
  return value as number;
}
