import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import type { SessionRuntime } from "../../src/runtime/session-runtime.js";
import {
  AGENT_RECOVERY_WORKER_RECEIPT_SCHEMA_VERSION,
  createAgentRecoverableTaskAdapter,
  createAgentRecoverableTaskInput,
  FileAgentRecoveryLaunchIntentPort,
  runtimeRunAdmissionFromAgentRecoveryIntent,
  type AgentRecoveryLaunchIntent,
  type AgentRecoveryWorkerInstaller,
  type AgentRecoveryWorkerReceipt,
} from "../../src/runtime/agent-recoverable-task-adapter.js";
import { RuntimeEventBoundaryInspector } from "../../src/runtime/runtime-event-boundary-inspector.js";
import { RuntimeRunExecutor } from "../../src/runtime/runtime-run-executor.js";
import { currentRuntimeRun, RuntimeRun } from "../../src/runtime/runtime-run.js";
import {
  deriveRecoverableTaskRuntimeLaunchIdentity,
  type RecoverableTaskResumeContext,
} from "../../src/tasks/recoverable-task.js";
import { readWorkspaceSqliteStorageRootIdentitySync } from "../../src/storage/sqlite/sqlite-workspace-storage.js";
import { ALL_WORKSPACE_SQLITE_SCOPES } from "../../src/storage/sqlite/workspace-scopes.js";

test("core Agent adapter reuses one deterministic admission and never synthesizes a user prompt", async (context) => {
  const fixture = await createFixture(context, "cold-continuation");
  const installed = new Map<string, string>();
  let installCalls = 0;
  let actualInstallations = 0;
  const installer: AgentRecoveryWorkerInstaller = {
    async installOrConfirmWorker(intent) {
      installCalls++;
      let workerId = installed.get(intent.launchId);
      if (!workerId) {
        workerId = `worker:${intent.launchId}`;
        installed.set(intent.launchId, workerId);
        actualInstallations++;
        await executePrestartedWorker(fixture, intent);
      }
      return workerReceipt(intent.launchId, workerId);
    },
  };
  const port = fixture.createIntentPort(installer);
  const adapter = fixture.createAdapter(port);

  const first = await adapter.resume(fixture.input, fixture.resumeContext);
  const successorEvents = await fixture.store.readRun(fixture.session.id, first.runId);
  assert.deepEqual(
    successorEvents.map((event) => event.kind),
    ["run.started", "message.committed", "run.terminal"],
  );
  assert.equal(successorEvents[0]?.eventId, first.runStartedEventId);
  assert.equal(first.runStartedSequence, fixture.sourceHighWater + 1);
  assert.equal(successorEvents.filter((event) => event.kind === "run.started").length, 1);
  const reconciliation = await new RuntimeEventBoundaryInspector({
    store: fixture.store,
  }).reconcileLaunch(fixture.resumeContext.boundary.runtime!, {
    launchId: first.launchId,
    runId: first.runId,
    runStartedEventId: first.runStartedEventId,
  });
  assert.equal(reconciliation.status, "verified");
  assert.deepEqual(
    reconciliation.status === "verified" ? reconciliation.receipt : undefined,
    first,
  );
  const sessionEvents = await fixture.store.readSession(fixture.session.id);
  const userMessages = sessionEvents.filter(
    (event) => event.kind === "message.committed" && event.data.message.role === "user",
  );
  assert.deepEqual(
    userMessages.map((event) =>
      event.kind === "message.committed" ? event.data.message.content : "",
    ),
    ["original durable prompt"],
  );

  const terminal = successorEvents.find((event) => event.kind === "run.terminal");
  assert.ok(terminal);
  const workerId = installed.get(first.launchId);
  assert.ok(workerId);
  await port.markTerminal({
    launchId: first.launchId,
    workerId,
    status: "completed",
    terminalEventId: terminal.eventId,
    at: terminal.at,
  });
  const projection = await port.inspect(first.launchId);
  assert.equal(projection?.state, "terminal");
  assert.equal(projection?.intent.resumeExistingSession, true);
  assert.equal("prompt" in (projection?.intent ?? {}), false);

  const repeated = await adapter.resume(fixture.input, fixture.resumeContext);
  assert.deepEqual(repeated, first);
  assert.equal(installCalls, 1);
  assert.equal(actualInstallations, 1);
  assert.equal(
    (await fixture.store.readRun(fixture.session.id, first.runId)).filter(
      (event) => event.kind === "run.started",
    ).length,
    1,
  );
});

test("two file-backed ports atomically claim one launchId and install one worker", async (context) => {
  const fixture = await createFixture(context, "concurrent-claim");
  let installCalls = 0;
  const installer: AgentRecoveryWorkerInstaller = {
    async installOrConfirmWorker(intent) {
      installCalls++;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
      return workerReceipt(intent.launchId, `worker:${intent.launchId}`);
    },
  };
  const firstPort = fixture.createIntentPort(installer, "host:first");
  const secondPort = fixture.createIntentPort(installer, "host:second");
  const [first, second] = await Promise.all([
    fixture.createAdapter(firstPort).resume(fixture.input, fixture.resumeContext),
    fixture.createAdapter(secondPort).resume(fixture.input, fixture.resumeContext),
  ]);

  assert.deepEqual(second, first);
  assert.equal(installCalls, 1);
  assert.equal((await firstPort.inspect(first.launchId))?.state, "installed");
  assert.equal(
    (await fixture.store.readRun(fixture.session.id, first.runId)).filter(
      (event) => event.kind === "run.started",
    ).length,
    1,
  );
});

test("an expired installing claim is taken over without duplicating the durable worker", async (context) => {
  const fixture = await createFixture(context, "expired-claim");
  const installed = new Map<string, string>();
  let installCalls = 0;
  let actualInstallations = 0;
  const installer: AgentRecoveryWorkerInstaller = {
    async installOrConfirmWorker(intent) {
      installCalls++;
      let workerId = installed.get(intent.launchId);
      if (!workerId) {
        workerId = `worker:${intent.launchId}`;
        installed.set(intent.launchId, workerId);
        actualInstallations++;
      }
      if (installCalls === 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
      }
      return workerReceipt(intent.launchId, workerId);
    },
  };
  const createPort = (ownerId: string) =>
    new FileAgentRecoveryLaunchIntentPort({
      storageRoot: fixture.store.storageRoot,
      storageRootId: fixture.storageRootId,
      installer,
      ownerId,
      claimTtlMs: 25,
      contentionTimeoutMs: 500,
      contentionPollMs: 5,
    });
  const firstPort = createPort("host:expired:first");
  const secondPort = createPort("host:expired:second");
  const firstResume = fixture.createAdapter(firstPort).resume(fixture.input, fixture.resumeContext);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
  const secondResume = fixture
    .createAdapter(secondPort)
    .resume(fixture.input, fixture.resumeContext);
  const [first, second] = await Promise.all([firstResume, secondResume]);

  assert.deepEqual(second, first);
  assert.equal(installCalls, 2);
  assert.equal(actualInstallations, 1);
  const projection = await firstPort.inspect(first.launchId);
  assert.equal(projection?.state, "installed");
  assert.equal(projection?.claimEpoch, 2);
});

test("immutable Agent input rejects extra prompt data and a launchId cannot be rebound", async (context) => {
  const fixture = await createFixture(context, "input-conflict");
  let installCalls = 0;
  const port = fixture.createIntentPort({
    installOrConfirmWorker(intent) {
      installCalls++;
      return workerReceipt(intent.launchId, `worker:${intent.launchId}`);
    },
  });
  const adapter = fixture.createAdapter(port);

  assert.throws(
    () =>
      adapter.validateInput?.({
        ...fixture.input,
        prompt: "do not persist me",
      }),
    /unsupported shape/u,
  );
  const first = await adapter.resume(fixture.input, fixture.resumeContext);
  await assert.rejects(
    async () =>
      adapter.resume(
        {
          ...fixture.input,
          executionId: "execution:conflicting",
        },
        fixture.resumeContext,
      ),
    /conflicting immutable input/u,
  );
  assert.equal(installCalls, 1);
  assert.equal((await port.inspect(first.launchId))?.state, "installed");
});

test("a host failure after durable installation remains safely retryable", async (context) => {
  const fixture = await createFixture(context, "install-retry");
  const installed = new Map<string, string>();
  let installCalls = 0;
  let actualInstallations = 0;
  const portHolder: { current?: FileAgentRecoveryLaunchIntentPort } = {};
  const installer: AgentRecoveryWorkerInstaller = {
    async installOrConfirmWorker(intent) {
      installCalls++;
      const projectionBeforeEffect = await portHolder.current!.inspect(intent.launchId);
      assert.equal(projectionBeforeEffect?.state, "installing");
      assert.ok(
        await fixture.store.readSessionEvent(fixture.session.id, intent.runStartedEventId),
        "run.started must be durable before the installer can run",
      );
      let workerId = installed.get(intent.launchId);
      if (!workerId) {
        workerId = `worker:${intent.launchId}`;
        installed.set(intent.launchId, workerId);
        actualInstallations++;
      }
      if (installCalls === 1) {
        throw new Error("host lost its acknowledgement after durable install");
      }
      return workerReceipt(intent.launchId, workerId);
    },
  };
  const port = fixture.createIntentPort(installer);
  portHolder.current = port;
  const adapter = fixture.createAdapter(port);

  await assert.rejects(
    async () => adapter.resume(fixture.input, fixture.resumeContext),
    /lost its acknowledgement/u,
  );
  const prepared = await port.inspect(fixture.resumeContext.launchId);
  assert.equal(prepared?.state, "prepared");
  assert.equal(prepared?.claimEpoch, 1);

  const receipt = await adapter.resume(fixture.input, fixture.resumeContext);
  assert.equal(receipt.runStartedSequence, fixture.sourceHighWater + 1);
  assert.equal(installCalls, 2);
  assert.equal(actualInstallations, 1);
  const installedProjection = await port.inspect(receipt.launchId);
  assert.equal(installedProjection?.state, "installed");
  assert.equal(installedProjection?.claimEpoch, 2);
});

test("a worker may publish terminal while its install claim is still settling", async (context) => {
  const fixture = await createFixture(context, "fast-terminal");
  const portHolder: { current?: FileAgentRecoveryLaunchIntentPort } = {};
  const installer: AgentRecoveryWorkerInstaller = {
    async installOrConfirmWorker(intent) {
      const worker = workerReceipt(intent.launchId, `worker:${intent.launchId}`);
      await portHolder.current!.markTerminal({
        launchId: intent.launchId,
        workerId: worker.workerId,
        status: "failed",
        at: intent.runStartedAt,
      });
      return worker;
    },
  };
  const port = fixture.createIntentPort(installer);
  portHolder.current = port;

  const receipt = await fixture.createAdapter(port).resume(fixture.input, fixture.resumeContext);
  const projection = await port.inspect(receipt.launchId);
  assert.equal(projection?.state, "terminal");
  assert.equal(projection?.state === "terminal" ? projection.terminal.status : undefined, "failed");
  assert.equal(
    projection?.state === "terminal" ? projection.worker.workerId : undefined,
    `worker:${receipt.launchId}`,
  );
});

interface Fixture {
  readonly root: string;
  readonly workDir: string;
  readonly picoHome: string;
  readonly session: Session;
  readonly store: NonNullable<Session["runtimeEventStore"]>;
  readonly storageRootId: string;
  readonly sourceRunId: string;
  readonly sourceHighWater: number;
  readonly input: ReturnType<typeof createAgentRecoverableTaskInput>;
  readonly resumeContext: RecoverableTaskResumeContext;
  createIntentPort(
    installer: AgentRecoveryWorkerInstaller,
    ownerId?: string,
  ): FileAgentRecoveryLaunchIntentPort;
  createAdapter(
    port: FileAgentRecoveryLaunchIntentPort,
  ): ReturnType<typeof createAgentRecoverableTaskAdapter>;
}

async function createFixture(context: test.TestContext, suffix: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `pico-agent-recovery-${suffix}-`));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir);
  const session = new Session(`session:${suffix}`, workDir, {
    persistence: true,
    picoHome,
  });
  context.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const store = session.runtimeEventStore;
  const capability = session.runtimeEventCapability;
  assert.ok(store);
  assert.ok(capability);
  const sourceRun = await RuntimeRun.start({ capability });
  await sourceRun.commitMessages(session, [{ role: "user", content: "original durable prompt" }]);
  await sourceRun.finish("interrupted", "source process exited");
  const sourceEntries = await store.readSessionEntries(session.id);
  const sourceTerminal = sourceEntries.at(-1);
  assert.equal(sourceTerminal?.event.kind, "run.terminal");
  assert.equal(
    sourceTerminal?.event.kind === "run.terminal" ? sourceTerminal.event.data.status : undefined,
    "interrupted",
  );
  const rootIdentity = readWorkspaceSqliteStorageRootIdentitySync(
    store.storageRoot,
    ALL_WORKSPACE_SQLITE_SCOPES,
  );
  assert.ok(rootIdentity);

  const taskRunId = `task-run:${suffix}`;
  const launchId = `launch:${suffix}`;
  const runtimeIdentity = deriveRecoverableTaskRuntimeLaunchIdentity(launchId);
  const input = createAgentRecoverableTaskInput({
    taskRunId,
    executionId: `execution:${suffix}`,
    workspacePath: workDir,
    storageRootId: rootIdentity.storageRootId,
    sessionId: session.id,
  });
  const sourceHighWater = sourceTerminal!.sequence;
  const resumeContext: RecoverableTaskResumeContext = {
    taskRunId,
    sourceAttemptId: `attempt:source:${suffix}`,
    attemptId: `attempt:successor:${suffix}`,
    attemptNumber: 2,
    launchId,
    ownerId: `owner:${suffix}`,
    leaseEpoch: 2,
    executionLeaseExpiresAt: "2099-01-01T00:00:00.000Z",
    runtimeSessionId: session.id,
    expectedRuntimeRunId: runtimeIdentity.runId,
    expectedRunStartedEventId: runtimeIdentity.runStartedEventId,
    expectedSessionHighWater: sourceHighWater,
    boundary: {
      storageRootId: rootIdentity.storageRootId,
      workspacePath: input.workspacePath,
      backgroundOperationsSettled: true,
      runtime: {
        sessionId: session.id,
        runId: sourceRun.runId,
        eventHighWater: sourceHighWater,
        terminalEventId: sourceTerminal!.event.eventId,
      },
      toolCatalogHash: "tool-catalog:test",
      checkpointRef: `checkpoint:${suffix}`,
    },
    checkpointRef: `checkpoint:${suffix}`,
  };

  const fixture: Fixture = {
    root,
    workDir: input.workspacePath,
    picoHome,
    session,
    store,
    storageRootId: rootIdentity.storageRootId,
    sourceRunId: sourceRun.runId,
    sourceHighWater,
    input,
    resumeContext,
    createIntentPort(installer, ownerId) {
      return new FileAgentRecoveryLaunchIntentPort({
        storageRoot: store.storageRoot,
        storageRootId: rootIdentity.storageRootId,
        installer,
        ...(ownerId ? { ownerId } : {}),
        claimTtlMs: 500,
        contentionTimeoutMs: 2_000,
        contentionPollMs: 5,
      });
    },
    createAdapter(port) {
      return createAgentRecoverableTaskAdapter({
        workspacePath: input.workspacePath,
        storageRootId: rootIdentity.storageRootId,
        runtimeEventStore: store,
        runtimeWriteGuard: session,
        launchIntents: port,
      });
    },
  };
  return fixture;
}

async function executePrestartedWorker(
  fixture: Fixture,
  intent: AgentRecoveryLaunchIntent,
): Promise<void> {
  const engine = {
    run: async (target: Session) => {
      await currentRuntimeRun()!.commitMessages(target, [
        {
          role: "assistant",
          content: "continued from canonical history",
        },
      ]);
      return target.getHistory();
    },
  } as unknown as AgentEngine;
  await new RuntimeRunExecutor({
    session: fixture.session,
    runtimeState: {} as SessionRuntime,
    engine,
    sessionSelection: { mode: "resume", sessionId: fixture.session.id },
    workDir: fixture.workDir,
    picoHome: fixture.picoHome,
    prompt: "",
    resumeExistingSession: true,
    prestartedRun: runtimeRunAdmissionFromAgentRecoveryIntent(intent),
    traceEnabled: false,
    options: {},
  }).execute();
}

function workerReceipt(launchId: string, workerId: string): AgentRecoveryWorkerReceipt {
  return {
    schemaVersion: AGENT_RECOVERY_WORKER_RECEIPT_SCHEMA_VERSION,
    launchId,
    workerId,
  };
}
