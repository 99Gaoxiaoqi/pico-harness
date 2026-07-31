import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalizeWorkspacePath } from "../../src/paths/pico-paths.js";
import {
  FinishProductionTaskRunInput,
  ProductionTaskRunCompletionError,
  ProductionTaskRunConflictError,
  ProductionTaskRunLifecycle,
  productionAgentExecutionClass,
  type ProductionAgentTaskRecovery,
  type ProductionTaskRunClaim,
} from "../../src/tasks/production-task-run-lifecycle.js";
import { JobService } from "../../src/tasks/job-service.js";
import { RuntimeStore } from "../../src/tasks/runtime-store.js";
import {
  TASK_RUN_EVENT_SCHEMA_VERSION,
  type TaskRunEvent,
} from "../../src/tasks/task-run-contract.js";
import {
  hashTaskRunInput,
  TaskRunStore,
  taskRunDigest,
  type AppendTaskRunBatchOptions,
  type TaskRunAppendResult,
} from "../../src/tasks/task-run-store.js";

const START = Date.parse("2026-07-28T00:00:00.000Z");

test("production Agent TaskRun is host_bound by default and explicit recovery starts once", async (t) => {
  const fixture = await createFixture(t, "start");
  const lifecycle = fixture.lifecycle("host:a");

  assert.equal(productionAgentExecutionClass(), "host_bound");
  const hostBound = await lifecycle.start({
    taskRunId: "host-bound-job",
    attemptId: "host-bound-attempt",
    workDir: fixture.workspace,
  });
  assert.deepEqual(hostBound, {
    status: "host_bound",
    executionClass: "host_bound",
    taskRunId: "host-bound-job",
  });
  assert.deepEqual(await fixture.store.listTaskRunProjections(), []);

  const input = { prompt: "resume this production Agent", nested: { version: 1 } };
  const recovery = productionRecovery(input);
  assert.equal(productionAgentExecutionClass(recovery), "recoverable");
  const started = await lifecycle.start({
    taskRunId: "recoverable-job",
    attemptId: "attempt-1",
    workDir: fixture.workspace,
    recovery,
  });
  assert.equal(started.status, "started");
  if (started.status !== "started") assert.fail("expected a started TaskRun");
  assert.equal(started.projection.header.adapter.inputHash, hashTaskRunInput(input));
  assert.deepEqual(started.projection.header.adapter.input, input);
  assert.equal(started.projection.attempts[0]?.status, "running");
  assert.deepEqual(started.projection.attempts[0]?.execution, {
    ownerId: "host:a",
    leaseEpoch: 1,
    claimedAt: "2026-07-28T00:00:00.000Z",
    expiresAt: "2026-07-28T00:00:30.000Z",
  });
  assert.deepEqual(
    (await fixture.store.readTaskRunEvents("recoverable-job")).map(({ event }) => event.kind),
    ["attempt.started", "attempt.execution.claimed"],
  );

  fixture.advance(1_000);
  const replayed = await lifecycle.start({
    taskRunId: "recoverable-job",
    attemptId: "attempt-1",
    workDir: fixture.workspace,
    recovery,
  });
  assert.equal(replayed.status, "replayed");
  if (replayed.status !== "replayed") assert.fail("expected an idempotent replay");
  assert.deepEqual(replayed.claim, started.claim);
  assert.equal((await fixture.store.readTaskRunEvents("recoverable-job")).length, 2);

  await assert.rejects(
    lifecycle.start({
      taskRunId: "recoverable-job",
      attemptId: "attempt-1",
      workDir: fixture.workspace,
      recovery: productionRecovery({ ...input, prompt: "different immutable input" }),
    }),
    /different immutable metadata/u,
  );
});

test("heartbeat and safe-boundary checkpoints are idempotent and revision-CAS fenced", async (t) => {
  const fixture = await createFixture(t, "checkpoint", ConflictInjectingTaskRunStore);
  const store = fixture.store as ConflictInjectingTaskRunStore;
  const lifecycle = fixture.lifecycle("host:a");
  const started = await startRecoverable(lifecycle, fixture.workspace, "checkpoint-job");

  fixture.advance(10_000);
  const heartbeat = await lifecycle.heartbeat({
    claim: started.claim,
    idempotencyKey: "heartbeat-1",
  });
  assert.equal(heartbeat.inserted, true);
  assert.equal(heartbeat.claim.expiresAt, "2026-07-28T00:00:40.000Z");
  fixture.advance(1_000);
  const heartbeatReplay = await lifecycle.heartbeat({
    claim: heartbeat.claim,
    idempotencyKey: "heartbeat-1",
  });
  assert.equal(heartbeatReplay.inserted, false);
  assert.equal(heartbeatReplay.claim.expiresAt, heartbeat.claim.expiresAt);

  const checkpointInput = {
    claim: heartbeat.claim,
    idempotencyKey: "checkpoint-1",
    workspacePath: fixture.workspace,
    runtime: {
      sessionId: "session-1",
      runId: "run-1",
      eventHighWater: 8,
      terminalEventId: "runtime-terminal-1",
    },
    checkpointRef: "runtime-checkpoint-1",
    toolCatalogHash: "tools:v1",
    backgroundOperationsSettled: true,
  } as const;
  const checkpoint = await lifecycle.checkpoint(checkpointInput);
  assert.equal(checkpoint.inserted, true);
  assert.deepEqual(checkpoint.projection.attempts[0]?.boundary, {
    storageRootId: fixture.store.storageRootId,
    workspacePath: fixture.workspace,
    backgroundOperationsSettled: true,
    runtime: {
      sessionId: "session-1",
      runId: "run-1",
      eventHighWater: 8,
      terminalEventId: "runtime-terminal-1",
    },
    toolCatalogHash: "tools:v1",
    checkpointRef: "runtime-checkpoint-1",
  });
  assert.equal((await lifecycle.checkpoint(checkpointInput)).inserted, false);
  await assert.rejects(
    lifecycle.checkpoint({
      ...checkpointInput,
      runtime: { ...checkpointInput.runtime, eventHighWater: 9 },
    }),
    /already bound to another lifecycle operation/u,
  );
  await assert.rejects(
    lifecycle.checkpoint({
      ...checkpointInput,
      claim: started.claim,
      idempotencyKey: "checkpoint-with-stale-claim",
    }),
    ProductionTaskRunConflictError,
  );

  const competitor = new TaskRunStore({
    storageRoot: fixture.root,
    now: () => new Date(fixture.now()),
  });
  store.beforeNextAppend = async () => {
    const projection = await competitor.readTaskRunProjection("checkpoint-job");
    assert.ok(projection);
    const active = projection.attempts[0]!;
    const at = new Date(fixture.now()).toISOString();
    await competitor.append(
      "checkpoint-job",
      {
        schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
        eventId: "competing-heartbeat",
        taskRunId: "checkpoint-job",
        at,
        kind: "attempt.execution.renewed",
        data: {
          attemptId: active.attemptId,
          ownerId: active.execution.ownerId,
          leaseEpoch: active.execution.leaseEpoch,
          expiresAt: "2026-07-28T00:02:00.000Z",
        },
      },
      {
        transactionId: "competing-heartbeat",
        expectedRevision: projection.revision,
        now: () => new Date(fixture.now()),
      },
    );
  };
  await assert.rejects(
    lifecycle.checkpoint({
      ...checkpointInput,
      claim: checkpointClaim(checkpoint.projection),
      idempotencyKey: "checkpoint-loses-cas",
      checkpointRef: "runtime-checkpoint-cas",
    }),
    ProductionTaskRunConflictError,
  );
  const afterConflict = await fixture.store.readTaskRunProjection("checkpoint-job");
  assert.equal(afterConflict?.attempts[0]?.boundary?.checkpointRef, "runtime-checkpoint-1");
  assert.equal(
    (await fixture.store.readTaskRunEvents("checkpoint-job")).some(
      ({ event }) =>
        event.kind === "attempt.checkpointed" &&
        event.data.boundary.checkpointRef === "runtime-checkpoint-cas",
    ),
    false,
  );
});

test("expired takeover atomically refreshes Runtime high-water before interrupting the Attempt", async (t) => {
  const fixture = await createFixture(t, "expired", TaskRunStore, 1_000);
  const initial = fixture.lifecycle("host:old");
  const started = await startRecoverable(initial, fixture.workspace, "expired-job");
  await initial.checkpoint({
    claim: started.claim,
    idempotencyKey: "old-boundary",
    workspacePath: fixture.workspace,
    runtime: {
      sessionId: "session-1",
      runId: "run-1",
      eventHighWater: 4,
    },
    checkpointRef: "checkpoint-old",
    toolCatalogHash: "tools:v1",
    backgroundOperationsSettled: true,
  });

  fixture.advance(2_000);
  const takeover = fixture.lifecycle("host:new");
  const reconciled = await takeover.reconcileExpiredAttempt({
    taskRunId: "expired-job",
    attemptId: "attempt-1",
    idempotencyKey: "runtime-reconcile-6",
    runtimeStatus: "interrupted",
    workspacePath: fixture.workspace,
    runtime: {
      sessionId: "session-1",
      runId: "run-1",
      eventHighWater: 6,
      terminalEventId: "runtime-interrupted-6",
    },
    checkpointRef: "checkpoint-reconciled-6",
    toolCatalogHash: "tools:v1",
    backgroundOperationsSettled: true,
    error: "execution lease expired",
  });
  assert.equal(reconciled.inserted, true);
  assert.equal(reconciled.leaseEpoch, 2);
  assert.equal(reconciled.projection.status, "queued");
  assert.deepEqual(reconciled.projection.attempts[0], {
    attemptId: "attempt-1",
    attemptNumber: 1,
    execution: {
      ownerId: "host:new",
      leaseEpoch: 2,
      claimedAt: "2026-07-28T00:00:02.000Z",
      expiresAt: "2026-07-28T00:00:03.000Z",
    },
    status: "interrupted",
    startedAt: "2026-07-28T00:00:00.000Z",
    finishedAt: "2026-07-28T00:00:02.000Z",
    boundary: {
      storageRootId: fixture.store.storageRootId,
      workspacePath: fixture.workspace,
      backgroundOperationsSettled: true,
      runtime: {
        sessionId: "session-1",
        runId: "run-1",
        eventHighWater: 6,
        terminalEventId: "runtime-interrupted-6",
      },
      toolCatalogHash: "tools:v1",
      checkpointRef: "checkpoint-reconciled-6",
    },
    error: "execution lease expired",
  });

  const ledgerPath = join(fixture.root, "task-runs", taskRunDigest("expired-job"), "task.jsonl");
  const lastBatch = JSON.parse((await readFile(ledgerPath, "utf8")).trimEnd().split("\n").at(-1)!);
  assert.deepEqual(
    lastBatch.entries.map((entry: { event: TaskRunEvent }) => entry.event.kind),
    ["attempt.execution.claimed", "attempt.checkpointed", "attempt.finished"],
  );
  assert.equal(
    lastBatch.entries[1].event.data.boundary.runtime.eventHighWater,
    lastBatch.entries[2].event.data.status === "interrupted" ? 6 : -1,
  );

  const replayed = await takeover.reconcileExpiredAttempt({
    taskRunId: "expired-job",
    attemptId: "attempt-1",
    idempotencyKey: "runtime-reconcile-6",
    runtimeStatus: "interrupted",
    workspacePath: fixture.workspace,
    runtime: {
      sessionId: "session-1",
      runId: "run-1",
      eventHighWater: 6,
      terminalEventId: "runtime-interrupted-6",
    },
    checkpointRef: "checkpoint-reconciled-6",
    toolCatalogHash: "tools:v1",
    backgroundOperationsSettled: true,
    error: "execution lease expired",
  });
  assert.equal(replayed.inserted, false);
  assert.equal((await fixture.store.readTaskRunEvents("expired-job")).length, 6);
});

test("expired canonical Runtime terminals close TaskRun instead of creating a successor", async (t) => {
  const fixture = await createFixture(t, "expired-terminal", TaskRunStore, 1_000);
  const mappings = [
    ["completed", "succeeded"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ] as const;
  const completions: string[] = [];

  for (const [runtimeStatus, taskStatus] of mappings) {
    const taskRunId = `runtime-${runtimeStatus}`;
    const initial = fixture.lifecycle(`host:old:${runtimeStatus}`);
    await startRecoverable(initial, fixture.workspace, taskRunId);
    fixture.advance(2_000);
    const takeover = fixture.lifecycle(`host:new:${runtimeStatus}`, {
      settle(completion) {
        completions.push(completion.completionId);
      },
    });
    const result = await takeover.reconcileExpiredTerminalAttempt({
      taskRunId,
      attemptId: "attempt-1",
      idempotencyKey: `runtime-terminal-${runtimeStatus}`,
      completionId: `completion:${taskRunId}`,
      runtimeStatus,
      workspacePath: fixture.workspace,
      runtime: {
        sessionId: `session-${runtimeStatus}`,
        runId: `run-${runtimeStatus}`,
        eventHighWater: 5,
        terminalEventId: `runtime-terminal-event-${runtimeStatus}`,
      },
      checkpointRef: `checkpoint-${runtimeStatus}`,
      toolCatalogHash: "tools:v1",
      backgroundOperationsSettled: true,
      ...(runtimeStatus === "completed" ? { result: { answer: 42 } } : {}),
      ...(runtimeStatus === "failed" ? { error: "canonical Runtime failed" } : {}),
    });
    assert.equal(result.inserted, true);
    assert.equal(result.projection.status, taskStatus);
    assert.equal(result.projection.attempts.length, 1);
    assert.equal(result.projection.attempts[0]?.status, taskStatus);
    assert.equal(result.projection.terminal?.completionId, `completion:${taskRunId}`);
    assert.equal(result.completion, "settled");
    assert.deepEqual(
      (await fixture.store.readTaskRunEvents(taskRunId)).slice(-4).map(({ event }) => event.kind),
      ["attempt.execution.claimed", "attempt.checkpointed", "attempt.finished", "task.finished"],
    );
  }
  assert.deepEqual(completions, [
    "completion:runtime-completed",
    "completion:runtime-failed",
    "completion:runtime-cancelled",
  ]);
});

test("task terminal facts precede an idempotent completion callback and failures remain retryable", async (t) => {
  const fixture = await createFixture(t, "terminal");
  const completions: string[] = [];
  let failFirstSettlement = true;
  const lifecycle = fixture.lifecycle("host:a", {
    settle(completion) {
      completions.push(completion.completionId);
      if (failFirstSettlement) {
        failFirstSettlement = false;
        throw new Error("injected outbox failure");
      }
    },
  });
  const started = await startRecoverable(lifecycle, fixture.workspace, "terminal-job");
  const finish: FinishProductionTaskRunInput = {
    claim: started.claim,
    completionId: "completion:terminal-job",
    status: "succeeded",
    result: { answer: 42 },
  };
  await assert.rejects(
    lifecycle.finishTask(finish),
    (error: unknown) =>
      error instanceof ProductionTaskRunCompletionError && error.projection.status === "succeeded",
  );
  const terminalProjection = await fixture.store.readTaskRunProjection("terminal-job");
  assert.equal(terminalProjection?.status, "succeeded");
  assert.equal(terminalProjection?.terminal?.completionId, "completion:terminal-job");

  const restarted = fixture.lifecycle("host:after-crash", {
    settle(completion) {
      completions.push(completion.completionId);
    },
  });
  const replayed = await restarted.settleTerminalCompletion({
    taskRunId: "terminal-job",
    completionId: "completion:terminal-job",
  });
  assert.equal(replayed.inserted, false);
  assert.equal(replayed.completion, "settled");
  assert.deepEqual(completions, ["completion:terminal-job", "completion:terminal-job"]);
  await assert.rejects(
    restarted.settleTerminalCompletion({
      taskRunId: "terminal-job",
      completionId: "completion:wrong",
    }),
    ProductionTaskRunConflictError,
  );

  const failedLifecycle = fixture.lifecycle("host:a");
  const failed = await startRecoverable(failedLifecycle, fixture.workspace, "failed-terminal-job");
  const failure = await failedLifecycle.finishTask({
    claim: failed.claim,
    completionId: "completion:failed-terminal-job",
    status: "failed",
    error: "model failed",
  });
  assert.equal(failure.projection.status, "failed");
  assert.equal(failure.projection.attempts[0]?.status, "failed");
  assert.equal(failure.projection.terminal?.error, "model failed");

  const interruptedLifecycle = fixture.lifecycle("host:a");
  const interrupted = await startRecoverable(
    interruptedLifecycle,
    fixture.workspace,
    "interrupted-job",
  );
  const interruptedResult = await interruptedLifecycle.interruptAttempt({
    claim: interrupted.claim,
    idempotencyKey: "interrupt-1",
    error: "manual recovery boundary",
  });
  assert.equal(interruptedResult.projection.status, "queued");
  assert.equal(interruptedResult.projection.attempts[0]?.status, "interrupted");
  assert.equal(
    (
      await interruptedLifecycle.interruptAttempt({
        claim: interrupted.claim,
        idempotencyKey: "interrupt-1",
        error: "manual recovery boundary",
      })
    ).inserted,
    false,
  );
});

test("expired recoverable Jobs replace their Attempt without a premature interrupted outbox", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-production-job-successor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const store = new RuntimeStore({ workDir: root, storageRoot: root, now: () => now });

  const recoverableJob = store.createJob({
    jobId: "recoverable-job",
    type: "production_agent",
    executionClass: "recoverable",
    completionPolicy: "required",
    description: "recover after host loss",
  });
  const recoverableLease = store.acquireLease("job:recoverable-job", "host:old", 10);
  const recoverableStarted = store.startJob({
    jobId: "recoverable-job",
    attemptId: "attempt-1",
    ownerId: "host:old",
    leaseEpoch: recoverableLease.leaseEpoch,
    expectedVersion: recoverableJob.version,
  });
  const hostBoundJob = store.createJob({
    jobId: "host-bound-job",
    type: "local_agent",
    executionClass: "host_bound",
    completionPolicy: "required",
    description: "cannot recover process closure",
  });
  const hostBoundLease = store.acquireLease("job:host-bound-job", "host:old", 10);
  store.startJob({
    jobId: "host-bound-job",
    attemptId: "host-bound-attempt-1",
    ownerId: "host:old",
    leaseEpoch: hostBoundLease.leaseEpoch,
    expectedVersion: hostBoundJob.version,
  });

  now += 20;
  assert.deepEqual(
    store.interruptExpiredJobs().map(({ jobId }) => jobId),
    ["host-bound-job"],
  );
  assert.equal(store.getJob("recoverable-job")?.status, "running");
  assert.equal(store.getAttempt("attempt-1")?.status, "running");
  assert.deepEqual(
    store.listPendingCompletions().map(({ jobId }) => jobId),
    ["host-bound-job"],
  );

  const successorLease = store.acquireLease("job:recoverable-job", "host:new", 100);
  const successor = store.startRecoverableJobSuccessor({
    jobId: "recoverable-job",
    sourceAttemptId: "attempt-1",
    successorAttemptId: "attempt-2",
    ownerId: "host:new",
    leaseEpoch: successorLease.leaseEpoch,
    expectedJobVersion: recoverableStarted.job.version,
    expectedSourceAttemptVersion: recoverableStarted.attempt.version,
  });
  assert.equal(successor.inserted, true);
  assert.equal(successor.job.status, "running");
  assert.equal(successor.sourceAttempt.status, "interrupted");
  assert.equal(successor.successorAttempt.status, "running");
  assert.equal(successor.successorAttempt.attemptNumber, 2);
  assert.equal(
    store
      .listPendingCompletions()
      .some(({ attemptId }) => attemptId === successor.sourceAttempt.attemptId),
    false,
  );
  assert.equal(
    store.startRecoverableJobSuccessor({
      jobId: "recoverable-job",
      sourceAttemptId: "attempt-1",
      successorAttemptId: "attempt-2",
      ownerId: "host:new",
      leaseEpoch: successorLease.leaseEpoch,
      expectedJobVersion: recoverableStarted.job.version,
      expectedSourceAttemptVersion: recoverableStarted.attempt.version,
    }).inserted,
    false,
  );

  store.finishJob({
    jobId: "recoverable-job",
    attemptId: "attempt-2",
    ownerId: "host:new",
    status: "succeeded",
    expectedJobVersion: successor.job.version,
    expectedAttemptVersion: successor.successorAttempt.version,
    leaseEpoch: successorLease.leaseEpoch,
    completionId: "completion:recoverable-job",
  });
  assert.deepEqual(
    store
      .listPendingCompletions()
      .filter(({ jobId }) => jobId === "recoverable-job")
      .map(({ completionId, attemptId, status }) => ({ completionId, attemptId, status })),
    [
      {
        completionId: "completion:recoverable-job",
        attemptId: "attempt-2",
        status: "succeeded",
      },
    ],
  );

  const terminalGapJob = store.createJob({
    jobId: "terminal-gap-job",
    type: "production_agent",
    executionClass: "recoverable",
    completionPolicy: "required",
    description: "TaskRun terminal committed before Job terminal",
  });
  const terminalGapLease = store.acquireLease("job:terminal-gap-job", "host:old", 10);
  store.startJob({
    jobId: "terminal-gap-job",
    attemptId: "terminal-gap-attempt",
    ownerId: "host:old",
    leaseEpoch: terminalGapLease.leaseEpoch,
    expectedVersion: terminalGapJob.version,
  });
  now += 20;
  store.interruptExpiredJobs();
  assert.equal(store.getJob("terminal-gap-job")?.status, "running");
  assert.equal(
    store.listPendingCompletions().some(({ jobId }) => jobId === "terminal-gap-job"),
    false,
  );

  const settlingHost = new JobService({
    workDir: root,
    storageRoot: root,
    ownerId: "host:terminal-settler",
    now: () => now,
  });
  const terminalGap = settlingHost.settleRecoverableJobAfterTaskTerminal({
    jobId: "terminal-gap-job",
    attemptId: "terminal-gap-attempt",
    completionId: "completion:terminal-gap-job",
    status: "succeeded",
    result: { answer: 7 },
    completionPayload: { source: "task-run-terminal" },
  });
  assert.equal(terminalGap.inserted, true);
  assert.equal(terminalGap.job.status, "succeeded");
  assert.equal(terminalGap.attempt.ownerId, "host:terminal-settler");
  assert.equal(terminalGap.completion.completionId, "completion:terminal-gap-job");
  assert.equal(
    settlingHost.settleRecoverableJobAfterTaskTerminal({
      jobId: "terminal-gap-job",
      attemptId: "terminal-gap-attempt",
      completionId: "completion:terminal-gap-job",
      status: "succeeded",
      result: { answer: 7 },
      completionPayload: { source: "task-run-terminal" },
    }).inserted,
    false,
  );
  assert.throws(
    () =>
      settlingHost.settleRecoverableJobAfterTaskTerminal({
        jobId: "terminal-gap-job",
        attemptId: "terminal-gap-attempt",
        completionId: "completion:terminal-gap-job",
        status: "succeeded",
        result: { answer: 8 },
        completionPayload: { source: "task-run-terminal" },
      }),
    /conflicts with Job/u,
  );
  assert.deepEqual(
    settlingHost
      .pendingCompletions()
      .filter(({ jobId }) => jobId === "terminal-gap-job")
      .map(({ completionId }) => completionId),
    ["completion:terminal-gap-job"],
  );
  settlingHost.close();
});

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly store: TaskRunStore;
  readonly now: () => number;
  readonly advance: (milliseconds: number) => void;
  readonly lifecycle: (
    ownerId: string,
    completionPort?: ConstructorParameters<typeof ProductionTaskRunLifecycle>[0]["completionPort"],
  ) => ProductionTaskRunLifecycle;
}

async function createFixture(
  t: test.TestContext,
  name: string,
  Store: typeof TaskRunStore = TaskRunStore,
  leaseTtlMs = 30_000,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `pico-production-task-${name}-`));
  const requestedWorkspace = join(root, "workspace");
  await mkdir(requestedWorkspace);
  const workspace = canonicalizeWorkspacePath(requestedWorkspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = START;
  const store = new Store({ storageRoot: root, now: () => new Date(now) });
  return {
    root,
    workspace,
    store,
    now: () => now,
    advance(milliseconds) {
      now += milliseconds;
    },
    lifecycle(ownerId, completionPort) {
      return new ProductionTaskRunLifecycle({
        store,
        ownerId,
        leaseTtlMs,
        now: () => new Date(now),
        ...(completionPort ? { completionPort } : {}),
      });
    },
  };
}

function productionRecovery(input: Readonly<Record<string, unknown>>): ProductionAgentTaskRecovery {
  return {
    executionClass: "recoverable",
    adapter: {
      id: "production.agent",
      version: 1,
      input,
    },
    maxAttempts: 3,
  };
}

async function startRecoverable(
  lifecycle: ProductionTaskRunLifecycle,
  workspace: string,
  taskRunId: string,
): Promise<{
  readonly claim: ProductionTaskRunClaim;
}> {
  const result = await lifecycle.start({
    taskRunId,
    attemptId: "attempt-1",
    workDir: workspace,
    recovery: productionRecovery({ taskRunId, prompt: "continue safely" }),
  });
  assert.equal(result.status, "started");
  if (result.status !== "started") assert.fail(`expected ${taskRunId} to start`);
  return { claim: result.claim };
}

function checkpointClaim(
  projection: Awaited<ReturnType<ProductionTaskRunLifecycle["checkpoint"]>>["projection"],
): ProductionTaskRunClaim {
  const attempt = projection.attempts[0]!;
  return {
    taskRunId: projection.header.taskRunId,
    attemptId: attempt.attemptId,
    ownerId: attempt.execution.ownerId,
    leaseEpoch: attempt.execution.leaseEpoch,
    expiresAt: attempt.execution.expiresAt,
  };
}

class ConflictInjectingTaskRunStore extends TaskRunStore {
  beforeNextAppend?: () => Promise<void>;

  override async appendBatch(
    taskRunId: string,
    events: readonly TaskRunEvent[],
    options: AppendTaskRunBatchOptions = {},
  ): Promise<readonly TaskRunAppendResult[]> {
    const before = this.beforeNextAppend;
    this.beforeNextAppend = undefined;
    if (before) await before();
    return super.appendBatch(taskRunId, events, options);
  }
}
