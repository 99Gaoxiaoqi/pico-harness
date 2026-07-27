import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { canonicalizeWorkspacePath } from "../../src/paths/pico-paths.js";
import { FileTaskResumeLedger } from "../../src/runtime/file-task-resume-ledger.js";
import { RuntimeEventBoundaryInspector } from "../../src/runtime/runtime-event-boundary-inspector.js";
import {
  SafeBoundaryResumeCoordinator,
  type TaskResumeLedger,
  type TaskResumeLedgerAppendInput,
  type TaskResumeLedgerAppendResult,
} from "../../src/runtime/safe-boundary-resume.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";
import {
  hashRecoverableTaskInput,
  RecoverableTaskRegistry,
} from "../../src/tasks/recoverable-task.js";
import {
  TASK_RUN_EVENT_SCHEMA_VERSION,
  type TaskRunEvent,
  type TaskSafeBoundary,
} from "../../src/tasks/task-run-contract.js";
import { TaskRunStore } from "../../src/tasks/task-run-store.js";

const AT = "2026-07-27T00:00:00.000Z";
const TASK_RUN_ID = "recoverable-task-1";
const SESSION_ID = "session-1";
const RUN_ID = "run-1";

test("file-backed recovery claims one fresh Attempt from canonical RuntimeEvent evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-task-resume-files-"));
  const workspace = join(root, "workspace");
  const storageRoot = join(root, "state");
  await mkdir(workspace, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));

  const runtimeEvents = new RuntimeEventStore({ storageRoot });
  await runtimeEvents.initializeSession({ sessionId: SESSION_ID, workDir: workspace });
  await runtimeEvents.appendBatch(runtimeFacts(workspace));

  const taskRuns = new TaskRunStore({ storageRoot, now: () => new Date(AT) });
  const input = { prompt: "continue from the safe checkpoint" };
  await taskRuns.initializeTaskRun({
    taskRunId: TASK_RUN_ID,
    workDir: workspace,
    adapter: {
      id: "agent.task",
      version: 1,
      input,
      inputHash: hashRecoverableTaskInput(input),
    },
    maxAttempts: 3,
  });
  await taskRuns.appendBatch(TASK_RUN_ID, initialAttemptFacts(taskRuns.storageRootId, workspace), {
    transactionId: "task-initial-attempt",
  });

  const registry = new RecoverableTaskRegistry();
  let launches = 0;
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    resume(persistedInput, context) {
      launches += 1;
      assert.deepEqual(persistedInput, input);
      assert.equal(context.sourceAttemptId, "attempt-1");
      assert.equal(context.checkpointRef, "checkpoint-1");
    },
  });
  const inspector = new RuntimeEventBoundaryInspector({
    store: runtimeEvents,
    backgroundOperationsSettled: () => true,
    toolCatalogHash: () => "tools:stable",
  });
  const environment = {
    storageRootId: taskRuns.storageRootId,
    workspacePath: canonicalizeWorkspacePath(workspace),
  };
  const first = new SafeBoundaryResumeCoordinator({
    ledger: new FileTaskResumeLedger(taskRuns),
    registry,
    runtime: inspector,
    environment,
    ownerId: "host:first",
    now: () => new Date(AT),
  });
  const secondStore = new TaskRunStore({ storageRoot, now: () => new Date(AT) });
  const second = new SafeBoundaryResumeCoordinator({
    ledger: new FileTaskResumeLedger(secondStore),
    registry,
    runtime: inspector,
    environment,
    ownerId: "host:second",
    now: () => new Date(AT),
  });

  const results = await Promise.all([
    first.recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" }),
    second.recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" }),
  ]);

  assert.deepEqual(results.map(({ status }) => status).sort(), ["already_claimed", "resumed"]);
  assert.equal(launches, 1);
  const projection = await taskRuns.readTaskRunProjection(TASK_RUN_ID);
  assert.equal(projection?.attempts.length, 2);
  assert.equal(projection?.attempts[0]?.status, "interrupted");
  assert.equal(projection?.attempts[1]?.status, "running");
  assert.equal(projection?.attempts[1]?.sourceAttemptId, "attempt-1");
  assert.equal(projection?.attempts[1]?.launch?.status, "succeeded");
  assert.equal(projection?.revision, 3);
});

test("adapter launch failure is durably retryable with one stable idempotency key", async (t) => {
  const fixture = await prepareFileRecovery(t);
  const registry = new RecoverableTaskRegistry();
  const launchIds: string[] = [];
  const actualLaunches = new Set<string>();
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    resume(_input, context) {
      launchIds.push(context.launchId);
      if (launchIds.length === 1) throw new Error("injected adapter launch failure");
      actualLaunches.add(context.launchId);
    },
  });

  const first = await recoveryCoordinator(fixture, registry, "host:first").recover({
    taskRunId: TASK_RUN_ID,
    executionClass: "recoverable",
  });
  assert.equal(first.status, "launch_failed");
  assert.equal(
    (await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID))?.attempts[1]?.launch?.status,
    "failed",
  );

  const second = await recoveryCoordinator(fixture, registry, "host:second").recover({
    taskRunId: TASK_RUN_ID,
    executionClass: "recoverable",
  });
  assert.equal(second.status, "resumed");
  assert.equal(launchIds.length, 2);
  assert.equal(new Set(launchIds).size, 1);
  assert.equal(actualLaunches.size, 1);
  const projection = await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID);
  assert.equal(projection?.attempts.length, 2);
  assert.equal(projection?.attempts[1]?.launch?.status, "succeeded");
  assert.equal(projection?.attempts[1]?.ownerId, "host:second");
});

test("an expired launch lease is taken over after a crash between durable claim and adapter call", async (t) => {
  const fixture = await prepareFileRecovery(t);
  const registry = new RecoverableTaskRegistry();
  const launchIds = new Set<string>();
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    resume(_input, context) {
      launchIds.add(context.launchId);
    },
  });
  const crashingLedger = new CrashAfterResumeClaimLedger(
    new FileTaskResumeLedger(fixture.taskRuns),
  );
  const first = recoveryCoordinator(fixture, registry, "host:crashed", {
    ledger: crashingLedger,
    launchLeaseTtlMs: 1_000,
    now: () => new Date(AT),
  });

  await assert.rejects(
    first.recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" }),
    /injected crash after durable launch claim/u,
  );
  assert.equal(launchIds.size, 0);
  const claimed = await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID);
  assert.equal(claimed?.attempts[1]?.launch?.status, "claimed");

  const recovered = await recoveryCoordinator(fixture, registry, "host:replacement", {
    launchLeaseTtlMs: 1_000,
    now: () => new Date("2026-07-27T00:00:01.001Z"),
  }).recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" });

  assert.equal(recovered.status, "resumed");
  assert.equal(launchIds.size, 1);
  const projection = await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID);
  assert.equal(projection?.attempts.length, 2);
  assert.equal(projection?.attempts[1]?.launch?.status, "succeeded");
  assert.equal(projection?.attempts[1]?.ownerId, "host:replacement");
});

test("a crash after actual launch but before settlement retries one idempotent launchId", async (t) => {
  const fixture = await prepareFileRecovery(t);
  const registry = new RecoverableTaskRegistry();
  const resumeCalls: string[] = [];
  const actualLaunches = new Set<string>();
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    resume(_input, context) {
      resumeCalls.push(context.launchId);
      actualLaunches.add(context.launchId);
    },
  });
  const settlementCrash = new CrashBeforeLaunchSettlementLedger(
    new FileTaskResumeLedger(fixture.taskRuns),
  );
  const first = recoveryCoordinator(fixture, registry, "host:settlement-crash", {
    ledger: settlementCrash,
    launchLeaseTtlMs: 1_000,
    now: () => new Date(AT),
  });

  await assert.rejects(
    first.recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" }),
    /injected crash before launch settlement/u,
  );
  assert.equal(resumeCalls.length, 1);
  assert.equal(actualLaunches.size, 1);
  assert.equal(
    (await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID))?.attempts[1]?.launch?.status,
    "claimed",
  );

  const recovered = await recoveryCoordinator(fixture, registry, "host:settlement-recovery", {
    launchLeaseTtlMs: 1_000,
    now: () => new Date("2026-07-27T00:00:01.001Z"),
  }).recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" });

  assert.equal(recovered.status, "resumed");
  assert.equal(resumeCalls.length, 2);
  assert.equal(new Set(resumeCalls).size, 1);
  assert.equal(actualLaunches.size, 1);
  assert.equal(
    (await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID))?.attempts[1]?.launch?.status,
    "succeeded",
  );
});

test("synthetic interrupted tool results remain pending and park file-backed recovery", async (t) => {
  const fixture = await prepareFileRecovery(t, (workspace) =>
    runtimeFacts(workspace).map((event): RuntimeEvent => {
      if (event.kind !== "message.committed" || event.eventId !== "runtime-tool-result") {
        return event;
      }
      return {
        ...event,
        data: {
          message: {
            role: "user",
            content: "tool execution was interrupted",
            toolCallId: "tool-call-1",
            providerData: {
              picoToolResultIsError: true,
              picoKind: "synthetic_tool_result",
              picoToolResultStatus: "interrupted",
            },
          },
        },
      };
    }),
  );
  const registry = successfulRegistry();

  const result = await recoveryCoordinator(fixture, registry, "host:pending-tool").recover({
    taskRunId: TASK_RUN_ID,
    executionClass: "recoverable",
  });

  assert.equal(result.status, "parked");
  if (result.status !== "parked") assert.fail("synthetic interrupted result must park");
  assert.ok(result.plan.reasons.includes("pending_tool_effect"));
});

test("planner binds Session manifest and run.started workDir to TaskRun, boundary and environment", async (t) => {
  await assert.rejects(
    prepareFileRecovery(t, (workspace) => runtimeFacts(`${workspace}-different`)),
    /Runtime event workspace does not match session/u,
  );

  const nonCanonical = await prepareFileRecovery(t, (workspace) =>
    runtimeFacts(workspace).map((event) =>
      event.kind === "run.started" ? { ...event, data: { workDir: `${workspace}/.` } } : event,
    ),
  );
  await assert.rejects(
    inspectFixtureBoundary(nonCanonical),
    /Runtime run run-1 workDir is not canonical/u,
  );

  const duplicateStarted = await prepareFileRecovery(t, (workspace) => {
    const facts = runtimeFacts(workspace);
    return [
      ...facts,
      {
        ...facts[0]!,
        eventId: "runtime-started-duplicate",
      },
    ];
  });
  await assert.rejects(inspectFixtureBoundary(duplicateStarted), /multiple run\.started facts/u);
});

interface FileRecoveryFixture {
  readonly taskRuns: TaskRunStore;
  readonly inspector: RuntimeEventBoundaryInspector;
  readonly environment: {
    readonly storageRootId: string;
    readonly workspacePath: string;
  };
}

function successfulRegistry(): RecoverableTaskRegistry {
  const registry = new RecoverableTaskRegistry();
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    resume() {},
  });
  return registry;
}

async function inspectFixtureBoundary(fixture: FileRecoveryFixture) {
  const projection = await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID);
  const boundary = projection?.attempts[0]?.boundary?.runtime;
  if (!boundary) throw new Error("fixture has no Runtime boundary");
  return fixture.inspector.inspect(boundary);
}

async function prepareFileRecovery(
  t: TestContext,
  facts: (workspace: string) => RuntimeEvent[] = runtimeFacts,
): Promise<FileRecoveryFixture> {
  const root = await mkdtemp(join(tmpdir(), "pico-task-resume-review-"));
  const workspace = join(root, "workspace");
  const storageRoot = join(root, "state");
  await mkdir(workspace, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeEvents = new RuntimeEventStore({ storageRoot });
  await runtimeEvents.initializeSession({ sessionId: SESSION_ID, workDir: workspace });
  await runtimeEvents.appendBatch(facts(workspace));
  const taskRuns = new TaskRunStore({ storageRoot, now: () => new Date(AT) });
  const input = { prompt: "continue from the safe checkpoint" };
  await taskRuns.initializeTaskRun({
    taskRunId: TASK_RUN_ID,
    workDir: workspace,
    adapter: {
      id: "agent.task",
      version: 1,
      input,
      inputHash: hashRecoverableTaskInput(input),
    },
    maxAttempts: 3,
  });
  await taskRuns.appendBatch(TASK_RUN_ID, initialAttemptFacts(taskRuns.storageRootId, workspace), {
    transactionId: "task-initial-attempt",
  });
  return {
    taskRuns,
    inspector: new RuntimeEventBoundaryInspector({
      store: runtimeEvents,
      backgroundOperationsSettled: () => true,
      toolCatalogHash: () => "tools:stable",
    }),
    environment: {
      storageRootId: taskRuns.storageRootId,
      workspacePath: canonicalizeWorkspacePath(workspace),
    },
  };
}

function recoveryCoordinator(
  fixture: FileRecoveryFixture,
  registry: RecoverableTaskRegistry,
  ownerId: string,
  overrides: {
    readonly ledger?: TaskResumeLedger;
    readonly launchLeaseTtlMs?: number;
    readonly now?: () => Date;
  } = {},
): SafeBoundaryResumeCoordinator {
  return new SafeBoundaryResumeCoordinator({
    ledger: overrides.ledger ?? new FileTaskResumeLedger(fixture.taskRuns),
    registry,
    runtime: fixture.inspector,
    environment: fixture.environment,
    ownerId,
    launchLeaseTtlMs: overrides.launchLeaseTtlMs,
    now: overrides.now ?? (() => new Date(AT)),
  });
}

class CrashAfterResumeClaimLedger implements TaskResumeLedger {
  private crashed = false;

  constructor(private readonly delegate: TaskResumeLedger) {}

  readProjection(taskRunId: string) {
    return this.delegate.readProjection(taskRunId);
  }

  async appendBatch(input: TaskResumeLedgerAppendInput): Promise<TaskResumeLedgerAppendResult> {
    const result = await this.delegate.appendBatch(input);
    if (!this.crashed && input.events.some((event) => event.kind === "task.resume.claimed")) {
      this.crashed = true;
      throw new Error("injected crash after durable launch claim");
    }
    return result;
  }
}

class CrashBeforeLaunchSettlementLedger implements TaskResumeLedger {
  private crashed = false;

  constructor(private readonly delegate: TaskResumeLedger) {}

  readProjection(taskRunId: string) {
    return this.delegate.readProjection(taskRunId);
  }

  async appendBatch(input: TaskResumeLedgerAppendInput): Promise<TaskResumeLedgerAppendResult> {
    if (!this.crashed && input.events.some((event) => event.kind === "attempt.launch.succeeded")) {
      this.crashed = true;
      throw new Error("injected crash before launch settlement");
    }
    return this.delegate.appendBatch(input);
  }
}

function initialAttemptFacts(storageRootId: string, workspace: string): TaskRunEvent[] {
  const boundary: TaskSafeBoundary = {
    storageRootId,
    workspacePath: canonicalizeWorkspacePath(workspace),
    backgroundOperationsSettled: true,
    runtime: {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      eventHighWater: 7,
      terminalEventId: "runtime-terminal",
    },
    toolCatalogHash: "tools:stable",
    checkpointRef: "checkpoint-1",
  };
  return [
    {
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: "task-attempt-started",
      taskRunId: TASK_RUN_ID,
      at: AT,
      kind: "attempt.started",
      data: {
        attemptId: "attempt-1",
        attemptNumber: 1,
        ownerId: "host:crashed",
        leaseEpoch: 1,
      },
    },
    {
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: "task-attempt-checkpointed",
      taskRunId: TASK_RUN_ID,
      at: AT,
      kind: "attempt.checkpointed",
      data: {
        attemptId: "attempt-1",
        ownerId: "host:crashed",
        leaseEpoch: 1,
        boundary,
      },
    },
    {
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: "task-attempt-interrupted",
      taskRunId: TASK_RUN_ID,
      at: AT,
      kind: "attempt.finished",
      data: {
        attemptId: "attempt-1",
        ownerId: "host:crashed",
        leaseEpoch: 1,
        status: "interrupted",
        error: "host process exited",
      },
    },
  ];
}

function runtimeFacts(workspace: string): RuntimeEvent[] {
  const base = {
    schemaVersion: 1 as const,
    sessionId: SESSION_ID,
    invocationId: "invocation-1",
    runId: RUN_ID,
    turnId: "turn-1",
    at: AT,
    partial: false,
  };
  return [
    {
      ...base,
      eventId: "runtime-started",
      visibility: "internal",
      kind: "run.started",
      data: { workDir: canonicalizeWorkspacePath(workspace) },
    },
    {
      ...base,
      eventId: "runtime-approval-requested",
      visibility: "internal",
      kind: "approval.requested",
      data: { approvalId: "approval-1", toolName: "write_file" },
    },
    {
      ...base,
      eventId: "runtime-approval-settled",
      visibility: "internal",
      kind: "approval.settled",
      data: { approvalId: "approval-1", decision: "approved" },
    },
    {
      ...base,
      eventId: "runtime-tool-started",
      visibility: "internal",
      refs: { toolCallId: "tool-call-1" },
      kind: "tool.started",
      data: { toolName: "write_file", argumentsHash: "args:1" },
    },
    {
      ...base,
      eventId: "runtime-tool-result",
      visibility: "model",
      refs: { toolCallId: "tool-call-1" },
      kind: "message.committed",
      data: {
        message: {
          role: "user",
          content: "tool completed",
          toolCallId: "tool-call-1",
        },
      },
    },
    {
      ...base,
      eventId: "runtime-checkpoint",
      visibility: "internal",
      kind: "context.checkpoint.recorded",
      data: {
        checkpointId: "checkpoint-1",
        sourceDigest: "digest-1",
        coveredEventCount: 5,
      },
    },
    {
      ...base,
      eventId: "runtime-terminal",
      visibility: "internal",
      kind: "run.terminal",
      data: {
        status: "interrupted",
        reason: "host process exited",
      },
    },
  ];
}
