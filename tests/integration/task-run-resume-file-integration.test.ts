import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  deriveRecoverableTaskRuntimeLaunchIdentity,
  hashRecoverableTaskInput,
  RecoverableTaskRegistry,
  type RecoverableTaskResumeContext,
} from "../../src/tasks/recoverable-task.js";
import {
  TASK_RUN_EVENT_SCHEMA_VERSION,
  type TaskRunEvent,
  type TaskSafeBoundary,
} from "../../src/tasks/task-run-contract.js";
import { TaskRunStore, taskRunDigest } from "../../src/tasks/task-run-store.js";

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
    async resume(persistedInput, context) {
      launches += 1;
      assert.deepEqual(persistedInput, input);
      assert.equal(context.sourceAttemptId, "attempt-1");
      assert.equal(context.checkpointRef, "checkpoint-1");
      return appendExpectedRunStarted(
        { runtimeEvents, workspace: canonicalizeWorkspacePath(workspace) },
        context,
      );
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

test("repeated recovery of a terminal TaskRun is read-only", async (t) => {
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    await t.test(status, async (t) => {
      const fixture = await prepareFileRecovery(t);
      await fixture.taskRuns.appendBatch(
        TASK_RUN_ID,
        [
          {
            schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
            eventId: `task-terminal:${status}`,
            taskRunId: TASK_RUN_ID,
            at: AT,
            kind: "task.finished",
            data: { status },
          },
        ],
        { transactionId: `task-terminal:${status}` },
      );
      const beforeProjection = await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID);
      const ledgerPath = taskRunLedgerPath(fixture.storageRoot, TASK_RUN_ID);
      const beforeBytes = await readFile(ledgerPath);
      const registry = new RecoverableTaskRegistry();
      let adapterCalls = 0;
      registry.register({
        adapterId: "agent.task",
        version: 1,
        launchMode: "idempotent",
        resume(_input, context) {
          adapterCalls += 1;
          return expectedLaunchReceipt(context);
        },
      });
      const coordinator = recoveryCoordinator(fixture, registry, `host:terminal:${status}`);

      const first = await coordinator.recover({
        taskRunId: TASK_RUN_ID,
        executionClass: "recoverable",
      });
      const second = await coordinator.recover({
        taskRunId: TASK_RUN_ID,
        executionClass: "recoverable",
      });

      assert.deepEqual(second, first);
      assert.equal(first.status, "parked");
      if (first.status !== "parked") assert.fail("terminal TaskRun must return without mutation");
      assert.deepEqual(first.plan.reasons, ["task_terminal"]);
      assert.equal(first.plan.diagnostics[0]?.detail?.["status"], status);
      assert.equal(adapterCalls, 0);
      assert.deepEqual(await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID), beforeProjection);
      assert.deepEqual(await readFile(ledgerPath), beforeBytes);
    });
  }
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
    async resume(_input, context) {
      launchIds.push(context.launchId);
      if (launchIds.length === 1) throw new Error("injected adapter launch failure");
      const receipt = await appendExpectedRunStarted(fixture, context);
      actualLaunches.add(context.launchId);
      return receipt;
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
  assert.equal(projection?.attempts[1]?.execution.ownerId, "host:second");
});

test("an expired launch lease is taken over after a crash between durable claim and adapter call", async (t) => {
  const fixture = await prepareFileRecovery(t);
  const registry = new RecoverableTaskRegistry();
  const launchIds = new Set<string>();
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    async resume(_input, context) {
      launchIds.add(context.launchId);
      return appendExpectedRunStarted(fixture, context);
    },
  });
  const crashingLedger = new CrashAfterResumeClaimLedger(
    new FileTaskResumeLedger(fixture.taskRuns),
  );
  const first = recoveryCoordinator(fixture, registry, "host:crashed", {
    ledger: crashingLedger,
    launchLeaseTtlMs: 1_000,
    executionLeaseTtlMs: 1_000,
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
    executionLeaseTtlMs: 1_000,
    now: () => new Date("2026-07-27T00:00:01.001Z"),
  }).recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" });

  assert.equal(recovered.status, "resumed");
  assert.equal(launchIds.size, 1);
  const projection = await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID);
  assert.equal(projection?.attempts.length, 2);
  assert.equal(projection?.attempts[1]?.launch?.status, "succeeded");
  assert.equal(projection?.attempts[1]?.execution.ownerId, "host:replacement");
});

test("an expired claimed successor re-proves every live source-boundary condition", async (t) => {
  await t.test("an adapter-specific checkpoint removed after the claim parks recovery", async (t) => {
    const fixture = await prepareFileRecovery(
      t,
      runtimeFacts,
      (storageRootId, workspace) =>
        initialAttemptFacts(storageRootId, workspace).map(
          (event): TaskRunEvent =>
            event.kind === "attempt.checkpointed"
              ? {
                  ...event,
                  data: {
                    ...event.data,
                    boundary: {
                      ...event.data.boundary,
                      checkpointRef: "checkpoint:external",
                    },
                  },
                }
              : event,
        ),
    );
    fixture.liveEvidence.additionalCheckpointRefs = ["checkpoint:external"];
    await assertClaimedSuccessorReproofParks(
      fixture,
      () => {
        fixture.liveEvidence.additionalCheckpointRefs = [];
      },
      "checkpoint_unavailable",
    );
  });

  await t.test("a changed tool catalog after the claim parks recovery", async (t) => {
    const fixture = await prepareFileRecovery(t);
    await assertClaimedSuccessorReproofParks(
      fixture,
      () => {
        fixture.liveEvidence.toolCatalogHash = "tools:changed";
      },
      "tool_catalog_mismatch",
    );
  });

  await t.test("unsettled background work after the claim parks recovery", async (t) => {
    const fixture = await prepareFileRecovery(t);
    await assertClaimedSuccessorReproofParks(
      fixture,
      () => {
        fixture.liveEvidence.backgroundOperationsSettled = false;
      },
      "background_operation_pending",
    );
  });
});

test("settlement recovery accepts the expected H+1 after the Session advances to another Run", async (t) => {
  const fixture = await prepareFileRecovery(t);
  const registry = new RecoverableTaskRegistry();
  const resumeCalls: string[] = [];
  const actualLaunches = new Set<string>();
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    async resume(_input, context) {
      resumeCalls.push(context.launchId);
      if (actualLaunches.has(context.launchId)) {
        return expectedLaunchReceipt(context);
      }
      const receipt = await appendExpectedRunStarted(fixture, context);
      actualLaunches.add(context.launchId);
      return receipt;
    },
  });
  const settlementCrash = new CrashBeforeLaunchSettlementLedger(
    new FileTaskResumeLedger(fixture.taskRuns),
  );
  const first = recoveryCoordinator(fixture, registry, "host:settlement-crash", {
    ledger: settlementCrash,
    launchLeaseTtlMs: 1_000,
    executionLeaseTtlMs: 1_000,
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
  await fixture.runtimeEvents.append({
    schemaVersion: 1,
    eventId: "runtime-later-run-started",
    sessionId: SESSION_ID,
    invocationId: "invocation:later-run",
    runId: "run:later",
    turnId: "turn:later",
    at: "2026-07-27T00:00:00.500Z",
    partial: false,
    visibility: "internal",
    kind: "run.started",
    data: { workDir: fixture.workspace },
  });

  const recovered = await recoveryCoordinator(fixture, registry, "host:settlement-recovery", {
    launchLeaseTtlMs: 1_000,
    executionLeaseTtlMs: 1_000,
    now: () => new Date("2026-07-27T00:00:01.001Z"),
  }).recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" });

  assert.equal(recovered.status, "resumed");
  assert.equal(resumeCalls.length, 2);
  assert.equal(new Set(resumeCalls).size, 1);
  assert.equal(actualLaunches.size, 1);
  const expected = deriveRecoverableTaskRuntimeLaunchIdentity(resumeCalls[0]!);
  const runtimeEntries = await fixture.runtimeEvents.readSessionEntries(SESSION_ID);
  const expectedStart = runtimeEntries.find(({ event }) => event.runId === expected.runId);
  const laterStart = runtimeEntries.find(
    ({ event }) => event.eventId === "runtime-later-run-started",
  );
  assert.equal(expectedStart?.sequence, 8);
  assert.equal(laterStart?.sequence, expectedStart!.sequence + 1);
  assert.equal(
    runtimeEntries.filter(
      ({ event }) => event.runId === expected.runId && event.kind === "run.started",
    ).length,
    1,
  );
  assert.equal(
    (await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID))?.attempts[1]?.launch?.status,
    "succeeded",
  );
});

test("verified H+1 still re-proves pending source effects before adapter ensure", async (t) => {
  const fixture = await prepareFileRecovery(t);
  const registry = new RecoverableTaskRegistry();
  const resumeCalls: string[] = [];
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    async resume(_input, context) {
      resumeCalls.push(context.launchId);
      if (resumeCalls.length > 1) return expectedLaunchReceipt(context);
      return appendExpectedRunStarted(fixture, context);
    },
  });
  const first = recoveryCoordinator(fixture, registry, "host:settlement-crash", {
    ledger: new CrashBeforeLaunchSettlementLedger(new FileTaskResumeLedger(fixture.taskRuns)),
    launchLeaseTtlMs: 1_000,
    executionLeaseTtlMs: 1_000,
    now: () => new Date(AT),
  });
  await assert.rejects(
    first.recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" }),
    /injected crash before launch settlement/u,
  );

  await fixture.runtimeEvents.append({
    schemaVersion: 1,
    eventId: "runtime-late-source-tool",
    sessionId: SESSION_ID,
    invocationId: "invocation:late-source-tool",
    runId: RUN_ID,
    turnId: "turn:late-source-tool",
    at: "2026-07-27T00:00:00.500Z",
    partial: false,
    visibility: "internal",
    refs: { toolCallId: "tool-call:late" },
    kind: "tool.started",
    data: { toolName: "write_file", argumentsHash: "args:late" },
  });

  const recovered = await recoveryCoordinator(fixture, registry, "host:reproof", {
    launchLeaseTtlMs: 1_000,
    executionLeaseTtlMs: 1_000,
    now: () => new Date("2026-07-27T00:00:01.001Z"),
  }).recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" });

  assert.equal(recovered.status, "parked");
  if (recovered.status !== "parked") assert.fail("late pending source effect must park");
  assert.ok(recovered.plan.reasons.includes("pending_tool_effect"));
  assert.equal(resumeCalls.length, 1);
  assert.equal(
    (await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID))?.status,
    "parked",
  );
});

test("source Run cannot advance after terminal H while a verified successor starts at H+1", async (t) => {
  const fixture = await prepareFileRecovery(
    t,
    minimalRuntimeFacts,
    (storageRootId, workspace) =>
      initialAttemptFacts(storageRootId, workspace).map(
        (event): TaskRunEvent =>
          event.kind === "attempt.checkpointed"
            ? {
                ...event,
                data: {
                  ...event.data,
                  boundary: {
                    ...event.data.boundary,
                    runtime: {
                      ...event.data.boundary.runtime!,
                      eventHighWater: 3,
                    },
                  },
                },
              }
            : event,
      ),
  );
  const registry = new RecoverableTaskRegistry();
  let adapterCalls = 0;
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    async resume(_input, context) {
      adapterCalls += 1;
      const receipt = await appendExpectedRunStarted(fixture, context);
      await fixture.runtimeEvents.append({
        schemaVersion: 1,
        eventId: "runtime-source-message-after-terminal",
        sessionId: SESSION_ID,
        invocationId: "invocation:late-source-message",
        runId: RUN_ID,
        turnId: "turn:late-source-message",
        at: "2026-07-27T00:00:00.500Z",
        partial: false,
        visibility: "model",
        kind: "message.committed",
        data: {
          message: {
            role: "assistant",
            content: "late source output",
          },
        },
      });
      return receipt;
    },
  });

  const result = await recoveryCoordinator(fixture, registry, "host:source-run-fence").recover({
    taskRunId: TASK_RUN_ID,
    executionClass: "recoverable",
  });

  assert.equal(result.status, "parked");
  if (result.status !== "parked") assert.fail("source Run advancement after H must park");
  assert.ok(result.plan.reasons.includes("runtime_high_water_mismatch"));
  assert.equal(adapterCalls, 1);
  const entries = await fixture.runtimeEvents.readSessionEntries(SESSION_ID);
  assert.equal(entries.find(({ event }) => event.kind === "run.terminal")?.sequence, 3);
  assert.equal(
    entries.find(({ event }) => event.eventId === "runtime-source-message-after-terminal")?.sequence,
    5,
  );
  const projection = await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID);
  assert.equal(projection?.status, "parked");
  assert.notEqual(projection?.attempts[1]?.launch?.status, "succeeded");
});

test("run.started admission is not launch success until the idempotent adapter confirms a worker", async (t) => {
  const fixture = await prepareFileRecovery(t);
  const registry = new RecoverableTaskRegistry();
  const resumeCalls: string[] = [];
  const admissions = new Set<string>();
  const durableWorkers = new Set<string>();
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    async resume(_input, context) {
      resumeCalls.push(context.launchId);
      if (!admissions.has(context.launchId)) {
        await appendExpectedRunStarted(fixture, context);
        admissions.add(context.launchId);
        throw new Error("injected crash after run.started fsync and before worker install");
      }
      durableWorkers.add(context.launchId);
      return expectedLaunchReceipt(context);
    },
  });

  const first = await recoveryCoordinator(fixture, registry, "host:admission-only").recover({
    taskRunId: TASK_RUN_ID,
    executionClass: "recoverable",
  });

  assert.equal(first.status, "launch_failed");
  assert.equal(admissions.size, 1);
  assert.equal(durableWorkers.size, 0);
  assert.equal(
    (await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID))?.attempts[1]?.launch?.status,
    "failed",
  );

  const second = await recoveryCoordinator(fixture, registry, "host:worker-retry").recover({
    taskRunId: TASK_RUN_ID,
    executionClass: "recoverable",
  });

  assert.equal(second.status, "resumed");
  assert.equal(resumeCalls.length, 2);
  assert.equal(new Set(resumeCalls).size, 1);
  assert.equal(admissions.size, 1);
  assert.equal(durableWorkers.size, 1);
  assert.equal(
    (await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID))?.attempts[1]?.launch?.status,
    "succeeded",
  );
});

test("Runtime high-water CAS prevents adapter side effects when an unknown H+1 wins", async (t) => {
  const fixture = await prepareFileRecovery(t);
  const registry = new RecoverableTaskRegistry();
  let sideEffects = 0;
  let expectedRunStartedEventId: string | undefined;
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    async resume(_input, context) {
      expectedRunStartedEventId = context.expectedRunStartedEventId;
      await fixture.runtimeEvents.append({
        schemaVersion: 1,
        eventId: "runtime-unknown-h-plus-one",
        sessionId: context.runtimeSessionId,
        invocationId: "invocation:unknown",
        runId: "run:unknown",
        turnId: "turn:unknown",
        at: AT,
        partial: false,
        visibility: "internal",
        kind: "run.started",
        data: { workDir: fixture.workspace },
      });
      const receipt = await appendExpectedRunStarted(fixture, context);
      sideEffects += 1;
      return receipt;
    },
  });

  const result = await recoveryCoordinator(fixture, registry, "host:cas-race").recover({
    taskRunId: TASK_RUN_ID,
    executionClass: "recoverable",
  });

  assert.equal(result.status, "parked");
  if (result.status !== "parked") assert.fail("unknown H+1 must park");
  assert.deepEqual(result.plan.reasons, ["runtime_high_water_mismatch"]);
  assert.equal(sideEffects, 0);
  assert.ok(expectedRunStartedEventId);
  assert.equal(
    (await fixture.runtimeEvents.readSessionEntries(SESSION_ID)).some(
      ({ event }) => event.eventId === expectedRunStartedEventId,
    ),
    false,
  );
  assert.equal(
    (await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID))?.attempts[1]?.status,
    "interrupted",
  );
});

test("a deterministic successor Runtime identity cannot be pre-bound before H", async (t) => {
  const launchId = expectedLaunchId();
  const expected = deriveRecoverableTaskRuntimeLaunchIdentity(launchId);
  const fixture = await prepareFileRecovery(t, (workspace) =>
    runtimeFacts(workspace).map((event, index): RuntimeEvent => {
      if (index !== 1) return event;
      return {
        ...event,
        eventId: expected.runStartedEventId,
        runId: expected.runId,
      };
    }),
  );
  const registry = new RecoverableTaskRegistry();
  let adapterCalls = 0;
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    resume(_input, context) {
      adapterCalls += 1;
      return appendExpectedRunStarted(fixture, context);
    },
  });

  const result = await recoveryCoordinator(fixture, registry, "host:identity-conflict").recover({
    taskRunId: TASK_RUN_ID,
    executionClass: "recoverable",
  });

  assert.equal(result.status, "parked");
  if (result.status !== "parked") assert.fail("pre-bound launch identity must park");
  assert.deepEqual(result.plan.reasons, ["ledger_corrupt"]);
  assert.equal(adapterCalls, 0);
});

test("an expired initial execution lease is fenced and recovered through a fresh Attempt", async (t) => {
  const fixture = await prepareFileRecovery(t, runtimeFacts, (storageRootId, workspace) =>
    initialAttemptFacts(storageRootId, workspace)
      .filter((event) => event.kind !== "attempt.finished")
      .map((event): TaskRunEvent => {
        if (event.kind !== "attempt.execution.claimed") return event;
        return {
          ...event,
          data: {
            ...event.data,
            expiresAt: "2026-07-27T00:00:01.000Z",
          },
        };
      }),
  );
  const registry = successfulRegistry(fixture);

  const result = await recoveryCoordinator(fixture, registry, "host:initial-replacement", {
    launchLeaseTtlMs: 1_000,
    executionLeaseTtlMs: 1_000,
    now: () => new Date("2026-07-27T00:00:01.001Z"),
  }).recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" });

  assert.equal(result.status, "resumed");
  const projection = await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID);
  assert.equal(projection?.attempts.length, 2);
  assert.equal(projection?.attempts[0]?.status, "interrupted");
  assert.equal(projection?.attempts[0]?.execution.ownerId, "host:initial-replacement");
  assert.equal(projection?.attempts[0]?.execution.leaseEpoch, 2);
  assert.equal(projection?.attempts[1]?.status, "running");
});

test("an expired launched successor is interrupted and parks without its own boundary", async (t) => {
  const fixture = await prepareFileRecovery(t);
  const registry = successfulRegistry(fixture);
  const first = await recoveryCoordinator(fixture, registry, "host:successor-owner", {
    executionLeaseTtlMs: 1_000,
    now: () => new Date(AT),
  }).recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" });
  assert.equal(first.status, "resumed");

  const recovered = await recoveryCoordinator(fixture, registry, "host:successor-replacement", {
    executionLeaseTtlMs: 1_000,
    now: () => new Date("2026-07-27T00:00:01.001Z"),
  }).recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" });

  assert.equal(recovered.status, "parked");
  if (recovered.status !== "parked") assert.fail("successor without boundary must park");
  assert.ok(recovered.plan.reasons.includes("checkpoint_unavailable"));
  const projection = await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID);
  assert.equal(projection?.attempts.length, 2);
  assert.equal(projection?.attempts[1]?.status, "interrupted");
  assert.equal(projection?.status, "parked");
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
  const registry = successfulRegistry(fixture);

  const result = await recoveryCoordinator(fixture, registry, "host:pending-tool").recover({
    taskRunId: TASK_RUN_ID,
    executionClass: "recoverable",
  });

  assert.equal(result.status, "parked");
  if (result.status !== "parked") assert.fail("synthetic interrupted result must park");
  assert.ok(result.plan.reasons.includes("pending_tool_effect"));
});

test("tool.started without a stable toolCallId fails closed", async (t) => {
  const fixture = await prepareFileRecovery(t, (workspace) =>
    runtimeFacts(workspace).map((event): RuntimeEvent => {
      if (event.kind !== "tool.started") return event;
      const { refs, ...withoutRefs } = event;
      assert.ok(refs);
      return withoutRefs;
    }),
  );
  const registry = new RecoverableTaskRegistry();
  let adapterCalls = 0;
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    resume(_input, context) {
      adapterCalls += 1;
      return expectedLaunchReceipt(context);
    },
  });

  const result = await recoveryCoordinator(fixture, registry, "host:missing-tool-call-id").recover({
    taskRunId: TASK_RUN_ID,
    executionClass: "recoverable",
  });

  assert.equal(result.status, "parked");
  if (result.status !== "parked") assert.fail("unidentifiable tool effect must park");
  assert.ok(result.plan.reasons.includes("ledger_corrupt"));
  assert.equal(adapterCalls, 0);
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
  readonly runtimeEvents: RuntimeEventStore;
  readonly storageRoot: string;
  readonly workspace: string;
  readonly inspector: RuntimeEventBoundaryInspector;
  readonly liveEvidence: {
    backgroundOperationsSettled: boolean;
    toolCatalogHash: string;
    additionalCheckpointRefs: string[];
  };
  readonly environment: {
    readonly storageRootId: string;
    readonly workspacePath: string;
  };
}

function successfulRegistry(fixture: FileRecoveryFixture): RecoverableTaskRegistry {
  const registry = new RecoverableTaskRegistry();
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    resume(_input, context) {
      return appendExpectedRunStarted(fixture, context);
    },
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
  taskFacts: (storageRootId: string, workspace: string) => TaskRunEvent[] = initialAttemptFacts,
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
  await taskRuns.appendBatch(TASK_RUN_ID, taskFacts(taskRuns.storageRootId, workspace), {
    transactionId: "task-initial-attempt",
  });
  const liveEvidence = {
    backgroundOperationsSettled: true,
    toolCatalogHash: "tools:stable",
    additionalCheckpointRefs: [] as string[],
  };
  return {
    taskRuns,
    runtimeEvents,
    storageRoot,
    workspace: canonicalizeWorkspacePath(workspace),
    inspector: new RuntimeEventBoundaryInspector({
      store: runtimeEvents,
      backgroundOperationsSettled: () => liveEvidence.backgroundOperationsSettled,
      toolCatalogHash: () => liveEvidence.toolCatalogHash,
      additionalCheckpointRefs: () => liveEvidence.additionalCheckpointRefs,
    }),
    liveEvidence,
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
    readonly executionLeaseTtlMs?: number;
    readonly now?: () => Date;
  } = {},
): SafeBoundaryResumeCoordinator {
  return new SafeBoundaryResumeCoordinator({
    ledger:
      overrides.ledger ??
      new FileTaskResumeLedger(
        overrides.now
          ? new TaskRunStore({ storageRoot: fixture.storageRoot, now: overrides.now })
          : fixture.taskRuns,
      ),
    registry,
    runtime: fixture.inspector,
    environment: fixture.environment,
    ownerId,
    launchLeaseTtlMs: overrides.launchLeaseTtlMs,
    executionLeaseTtlMs: overrides.executionLeaseTtlMs,
    now: overrides.now ?? (() => new Date(AT)),
  });
}

async function assertClaimedSuccessorReproofParks(
  fixture: FileRecoveryFixture,
  invalidateLiveEvidence: () => void,
  expectedReason:
    | "background_operation_pending"
    | "checkpoint_unavailable"
    | "tool_catalog_mismatch",
): Promise<void> {
  const registry = new RecoverableTaskRegistry();
  let adapterCalls = 0;
  registry.register({
    adapterId: "agent.task",
    version: 1,
    launchMode: "idempotent",
    resume(_input, context) {
      adapterCalls += 1;
      return expectedLaunchReceipt(context);
    },
  });
  const first = recoveryCoordinator(fixture, registry, "host:claim-crash", {
    ledger: new CrashAfterResumeClaimLedger(new FileTaskResumeLedger(fixture.taskRuns)),
    launchLeaseTtlMs: 1_000,
    executionLeaseTtlMs: 1_000,
    now: () => new Date(AT),
  });

  await assert.rejects(
    first.recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" }),
    /injected crash after durable launch claim/u,
  );
  assert.equal(adapterCalls, 0);
  invalidateLiveEvidence();

  const result = await recoveryCoordinator(fixture, registry, "host:reproof", {
    launchLeaseTtlMs: 1_000,
    executionLeaseTtlMs: 1_000,
    now: () => new Date("2026-07-27T00:00:01.001Z"),
  }).recover({ taskRunId: TASK_RUN_ID, executionClass: "recoverable" });

  assert.equal(result.status, "parked");
  if (result.status !== "parked") assert.fail("invalidated source boundary must park");
  assert.ok(result.plan.reasons.includes(expectedReason));
  assert.equal(adapterCalls, 0);
  const projection = await fixture.taskRuns.readTaskRunProjection(TASK_RUN_ID);
  assert.equal(projection?.status, "parked");
  assert.equal(projection?.attempts[1]?.status, "interrupted");
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
      },
    },
    {
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: "task-attempt-execution-claimed",
      taskRunId: TASK_RUN_ID,
      at: AT,
      kind: "attempt.execution.claimed",
      data: {
        attemptId: "attempt-1",
        ownerId: "host:crashed",
        leaseEpoch: 1,
        expiresAt: "2026-07-27T00:05:00.000Z",
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

async function appendExpectedRunStarted(
  fixture: Pick<FileRecoveryFixture, "runtimeEvents" | "workspace">,
  context: RecoverableTaskResumeContext,
) {
  const [result] = await fixture.runtimeEvents.appendBatch(
    [
      {
        schemaVersion: 1,
        eventId: context.expectedRunStartedEventId,
        sessionId: context.runtimeSessionId,
        invocationId: `invocation:${context.expectedRuntimeRunId}`,
        runId: context.expectedRuntimeRunId,
        turnId: `turn:${context.expectedRuntimeRunId}`,
        at: AT,
        partial: false,
        visibility: "internal",
        kind: "run.started",
        data: { workDir: fixture.workspace },
      },
    ],
    {
      expectedSessionHighWater: {
        [context.runtimeSessionId]: context.expectedSessionHighWater,
      },
    },
  );
  if (!result) throw new Error("expected one Runtime run.started append result");
  return {
    schemaVersion: 1 as const,
    launchId: context.launchId,
    sessionId: context.runtimeSessionId,
    runId: context.expectedRuntimeRunId,
    runStartedEventId: context.expectedRunStartedEventId,
    runStartedSequence: result.cursor.seq,
  };
}

function expectedLaunchReceipt(context: RecoverableTaskResumeContext) {
  return {
    schemaVersion: 1 as const,
    launchId: context.launchId,
    sessionId: context.runtimeSessionId,
    runId: context.expectedRuntimeRunId,
    runStartedEventId: context.expectedRunStartedEventId,
    runStartedSequence: context.expectedSessionHighWater + 1,
  };
}

function taskRunLedgerPath(storageRoot: string, taskRunId: string): string {
  return join(storageRoot, "task-runs", taskRunDigest(taskRunId), "task.jsonl");
}

function expectedLaunchId(): string {
  const identity = createHash("sha256")
    .update(JSON.stringify(["task-resume-v1", TASK_RUN_ID, "attempt-1", 2]))
    .digest("hex");
  return `launch:${identity}`;
}

function minimalRuntimeFacts(workspace: string): RuntimeEvent[] {
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
      eventId: "runtime-checkpoint",
      visibility: "internal",
      kind: "context.checkpoint.recorded",
      data: {
        checkpointId: "checkpoint-1",
        sourceDigest: "digest-1",
        coveredEventCount: 2,
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
