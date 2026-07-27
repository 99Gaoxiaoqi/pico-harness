import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  type RuntimeBoundaryInspection,
  type RuntimeBoundaryInspector,
  SafeBoundaryResumeCoordinator,
  SafeBoundaryResumePlanner,
  type TaskResumeLedger,
  type TaskResumeLedgerAppendInput,
  type TaskResumeLedgerAppendResult,
} from "../../src/runtime/safe-boundary-resume.js";
import {
  hashRecoverableTaskInput,
  RecoverableTaskRegistry,
  type RecoverableTaskResumeContext,
} from "../../src/tasks/recoverable-task.js";
import {
  TASK_RUN_FILE_SCHEMA_VERSION,
  type TaskAttemptProjection,
  type TaskRunEvent,
  type TaskRunFileHeader,
  type TaskRunProjection,
  type TaskSafeBoundary,
} from "../../src/tasks/task-run-contract.js";

const WORKSPACE_PATH = resolve("/tmp/pico-safe-boundary-workspace");
const INPUT = {
  prompt: "finish the durable task",
  nested: { priority: 2 },
} as const;

test("safe-boundary recovery starts a fresh Attempt and a restart cannot claim a second successor", async () => {
  const ledger = new InMemoryTaskResumeLedger(taskRunProjection());
  const registry = new RecoverableTaskRegistry();
  const resumeCalls: Array<{
    input: Readonly<Record<string, unknown>>;
    context: RecoverableTaskResumeContext;
  }> = [];
  registry.register({
    adapterId: "agent.task",
    version: 1,
    validateInput(input) {
      assert.equal(input["prompt"], INPUT.prompt);
    },
    resume(input, context) {
      assert.ok(Object.isFrozen(input));
      assert.ok(Object.isFrozen(input["nested"]));
      resumeCalls.push({ input, context });
    },
  });

  const firstHost = coordinator({
    ledger,
    registry,
    ownerId: "host:after-restart",
  });
  const first = await firstHost.recover({
    taskRunId: "task-run-1",
    executionClass: "recoverable",
  });

  assert.equal(first.status, "resumed");
  if (first.status !== "resumed") assert.fail("expected a resumed task");
  assert.notEqual(first.attemptId, "attempt-1");
  assert.equal(first.sourceAttemptId, "attempt-1");
  assert.equal(first.attemptNumber, 2);
  assert.equal(first.leaseEpoch, 8);
  assert.equal(first.ownerId, "host:after-restart");
  assert.equal(resumeCalls.length, 1);
  assert.equal(resumeCalls[0]?.context.attemptId, first.attemptId);
  assert.equal(resumeCalls[0]?.context.checkpointRef, "checkpoint-1");

  const restartedHost = coordinator({
    ledger,
    registry,
    ownerId: "host:second-restart",
  });
  const replay = await restartedHost.recover({
    taskRunId: "task-run-1",
    executionClass: "recoverable",
  });

  assert.equal(replay.status, "already_claimed");
  if (replay.status !== "already_claimed") assert.fail("expected the prior claim to be reused");
  assert.equal(replay.successorAttemptId, first.attemptId);
  assert.equal(replay.leaseEpoch, first.leaseEpoch);
  assert.equal(resumeCalls.length, 1);
  assert.equal(ledger.projection?.attempts.length, 2);
  assert.equal(ledger.events.filter((event) => event.kind === "task.resume.claimed").length, 1);
  assert.equal(ledger.events.filter((event) => event.kind === "attempt.started").length, 1);
  const claim = ledger.events.find((event) => event.kind === "task.resume.claimed");
  const started = ledger.events.find((event) => event.kind === "attempt.started");
  assert.equal(claim?.data.leaseEpoch, started?.data.leaseEpoch);
  assert.equal(claim?.data.successorAttemptId, started?.data.attemptId);
});

test("concurrent recovery claims are revision-checked so only one owner launches the successor", async () => {
  const ledger = new InMemoryTaskResumeLedger(taskRunProjection());
  const registry = new RecoverableTaskRegistry();
  let launches = 0;
  registry.register({
    adapterId: "agent.task",
    version: 1,
    resume() {
      launches += 1;
    },
  });
  const input = { taskRunId: "task-run-1", executionClass: "recoverable" as const };

  const results = await Promise.all([
    coordinator({ ledger, registry, ownerId: "host:a" }).recover(input),
    coordinator({ ledger, registry, ownerId: "host:b" }).recover(input),
  ]);

  assert.deepEqual(results.map(({ status }) => status).sort(), ["already_claimed", "resumed"]);
  assert.equal(launches, 1);
  assert.equal(ledger.projection?.attempts.length, 2);
  const successor = ledger.projection?.attempts.at(-1);
  assert.equal(successor?.sourceAttemptId, "attempt-1");
  assert.equal(successor?.leaseEpoch, 8);
  assert.equal(ledger.events.filter((event) => event.kind === "task.resume.claimed").length, 1);
});

test("planner parks every uncertain boundary instead of guessing a continuation", async () => {
  const registry = new RecoverableTaskRegistry();
  registry.register({
    adapterId: "agent.task",
    version: 2,
    resume() {},
  });
  const unsafeBoundary: TaskSafeBoundary = {
    ...safeBoundary(),
    storageRootId: "root:previous",
    workspacePath: resolve("/tmp/other-workspace"),
    backgroundOperationsSettled: false,
  };
  const unsafeProjection = taskRunProjection({
    attempt: {
      ...interruptedAttempt(),
      status: "failed",
      boundary: unsafeBoundary,
    },
  });
  const planner = new SafeBoundaryResumePlanner(
    registry,
    new StaticRuntimeInspector({
      ...availableRuntimeInspection(),
      eventHighWater: 9,
      terminal: {
        eventId: "another-terminal",
        status: "completed",
      },
      pendingApprovalIds: ["approval-1"],
      pendingToolCallIds: ["tool-call-1"],
      backgroundOperationsSettled: false,
      toolCatalogHash: "tools:new",
      availableCheckpointRefs: [],
    }),
    {
      storageRootId: "root:1",
      workspacePath: WORKSPACE_PATH,
    },
  );

  const plan = await planner.plan(unsafeProjection);
  assert.equal(plan.disposition, "park");
  if (plan.disposition !== "park") assert.fail("expected unsafe recovery to park");
  assert.deepEqual(
    new Set(plan.reasons),
    new Set([
      "adapter_version_mismatch",
      "source_attempt_not_interrupted",
      "storage_root_mismatch",
      "workspace_path_mismatch",
      "runtime_high_water_mismatch",
      "runtime_terminal_missing",
      "pending_tool_effect",
      "pending_approval",
      "background_operation_pending",
      "tool_catalog_mismatch",
      "checkpoint_unavailable",
    ]),
  );
});

test("missing adapters, Runtime identities and invalid input hashes produce stable park reasons", async () => {
  const missingAdapterPlan = await new SafeBoundaryResumePlanner(
    new RecoverableTaskRegistry(),
    new StaticRuntimeInspector(availableRuntimeInspection()),
    environment(),
  ).plan(taskRunProjection());
  assert.equal(missingAdapterPlan.disposition, "park");
  if (missingAdapterPlan.disposition !== "park") assert.fail("expected missing adapter to park");
  assert.ok(missingAdapterPlan.reasons.includes("adapter_missing"));

  const registry = registryWithoutResumeSideEffects();
  const sessionMissing = await new SafeBoundaryResumePlanner(
    registry,
    new StaticRuntimeInspector({ status: "session_missing", sessionId: "session-1" }),
    environment(),
  ).plan(taskRunProjection());
  assert.equal(sessionMissing.disposition, "park");
  if (sessionMissing.disposition !== "park") assert.fail("expected missing session to park");
  assert.ok(sessionMissing.reasons.includes("runtime_session_missing"));

  const runMissing = await new SafeBoundaryResumePlanner(
    registry,
    new StaticRuntimeInspector({
      status: "run_missing",
      sessionId: "session-1",
      runId: "run-1",
    }),
    environment(),
  ).plan(taskRunProjection());
  assert.equal(runMissing.disposition, "park");
  if (runMissing.disposition !== "park") assert.fail("expected missing run to park");
  assert.ok(runMissing.reasons.includes("runtime_run_missing"));

  const corruptInput = taskRunProjection({
    header: {
      ...taskRunHeader(),
      adapter: {
        ...taskRunHeader().adapter,
        inputHash: "not-the-persisted-input-hash",
      },
    },
  });
  const corruptPlan = await new SafeBoundaryResumePlanner(
    registry,
    new StaticRuntimeInspector(availableRuntimeInspection()),
    environment(),
  ).plan(corruptInput);
  assert.equal(corruptPlan.disposition, "park");
  if (corruptPlan.disposition !== "park") assert.fail("expected invalid input hash to park");
  assert.ok(corruptPlan.reasons.includes("ledger_corrupt"));
});

test("host-bound tasks never touch the recovery ledger or invoke an adapter", async () => {
  const ledger = new InMemoryTaskResumeLedger(taskRunProjection());
  const registry = new RecoverableTaskRegistry();
  let launches = 0;
  registry.register({
    adapterId: "agent.task",
    version: 1,
    resume() {
      launches += 1;
    },
  });

  const result = await coordinator({
    ledger,
    registry,
    ownerId: "host:ignored",
  }).recover({
    taskRunId: "task-run-1",
    executionClass: "host_bound",
  });

  assert.deepEqual(result, {
    status: "ignored",
    taskRunId: "task-run-1",
    reason: "host_bound",
  });
  assert.equal(ledger.readCount, 0);
  assert.equal(ledger.appendCount, 0);
  assert.equal(launches, 0);
});

function coordinator(options: {
  readonly ledger: TaskResumeLedger;
  readonly registry: RecoverableTaskRegistry;
  readonly ownerId: string;
}): SafeBoundaryResumeCoordinator {
  return new SafeBoundaryResumeCoordinator({
    ...options,
    runtime: new StaticRuntimeInspector(availableRuntimeInspection()),
    environment: environment(),
    now: () => new Date("2026-07-27T00:00:00.000Z"),
  });
}

function registryWithoutResumeSideEffects(): RecoverableTaskRegistry {
  const registry = new RecoverableTaskRegistry();
  registry.register({
    adapterId: "agent.task",
    version: 1,
    resume() {},
  });
  return registry;
}

function environment(): { readonly storageRootId: string; readonly workspacePath: string } {
  return {
    storageRootId: "root:1",
    workspacePath: WORKSPACE_PATH,
  };
}

function safeBoundary(): TaskSafeBoundary {
  return {
    storageRootId: "root:1",
    workspacePath: WORKSPACE_PATH,
    backgroundOperationsSettled: true,
    runtime: {
      sessionId: "session-1",
      runId: "run-1",
      eventHighWater: 8,
      terminalEventId: "terminal-1",
    },
    toolCatalogHash: "tools:stable",
    checkpointRef: "checkpoint-1",
  };
}

function availableRuntimeInspection(): Extract<RuntimeBoundaryInspection, { status: "available" }> {
  return {
    status: "available",
    sessionId: "session-1",
    runId: "run-1",
    eventHighWater: 8,
    terminal: {
      eventId: "terminal-1",
      status: "interrupted",
    },
    pendingApprovalIds: [],
    pendingToolCallIds: [],
    backgroundOperationsSettled: true,
    toolCatalogHash: "tools:stable",
    availableCheckpointRefs: ["checkpoint-1"],
  };
}

function taskRunHeader(): TaskRunFileHeader {
  return {
    type: "task-run",
    schemaVersion: TASK_RUN_FILE_SCHEMA_VERSION,
    taskRunId: "task-run-1",
    workDir: WORKSPACE_PATH,
    storageRootId: "root:1",
    adapter: {
      id: "agent.task",
      version: 1,
      input: INPUT,
      inputHash: hashRecoverableTaskInput(INPUT),
    },
    maxAttempts: 3,
    createdAt: "2026-07-26T00:00:00.000Z",
  };
}

function interruptedAttempt(): TaskAttemptProjection {
  return {
    attemptId: "attempt-1",
    attemptNumber: 1,
    ownerId: "host:before-crash",
    leaseEpoch: 7,
    status: "interrupted",
    startedAt: "2026-07-26T00:00:00.000Z",
    finishedAt: "2026-07-26T00:01:00.000Z",
    boundary: safeBoundary(),
    error: "host process exited",
  };
}

function taskRunProjection(
  overrides: {
    readonly header?: TaskRunFileHeader;
    readonly attempt?: TaskAttemptProjection;
  } = {},
): TaskRunProjection {
  return {
    header: overrides.header ?? taskRunHeader(),
    revision: 3,
    lastTransactionId: "tx:attempt-interrupted",
    status: "running",
    attempts: [overrides.attempt ?? interruptedAttempt()],
    parkReasons: [],
    parkDiagnostics: [],
  };
}

class StaticRuntimeInspector implements RuntimeBoundaryInspector {
  constructor(private readonly inspection: RuntimeBoundaryInspection) {}

  async inspect(): Promise<RuntimeBoundaryInspection> {
    return this.inspection;
  }
}

class InMemoryTaskResumeLedger implements TaskResumeLedger {
  projection: TaskRunProjection | undefined;
  readonly events: TaskRunEvent[] = [];
  readCount = 0;
  appendCount = 0;

  constructor(initial: TaskRunProjection) {
    this.projection = initial;
  }

  async readProjection(): Promise<TaskRunProjection | undefined> {
    this.readCount += 1;
    return this.projection;
  }

  async appendBatch(input: TaskResumeLedgerAppendInput): Promise<TaskResumeLedgerAppendResult> {
    this.appendCount += 1;
    await Promise.resolve();
    const current = this.projection;
    if (!current) throw new Error("missing TaskRun");
    if (current.revision !== input.expectedRevision) {
      return { status: "conflict", projection: current };
    }
    let attempts = [...current.attempts];
    let status = current.status;
    let parkReasons = current.parkReasons;
    let parkDiagnostics = current.parkDiagnostics;
    for (const event of input.events) {
      this.events.push(event);
      if (event.kind === "attempt.started") {
        attempts = [
          ...attempts,
          {
            attemptId: event.data.attemptId,
            attemptNumber: event.data.attemptNumber,
            ownerId: event.data.ownerId,
            leaseEpoch: event.data.leaseEpoch,
            ...(event.data.sourceAttemptId ? { sourceAttemptId: event.data.sourceAttemptId } : {}),
            status: "running",
            startedAt: event.at,
          },
        ];
        status = "running";
      } else if (event.kind === "task.parked") {
        status = "parked";
        parkReasons = event.data.reasons;
        parkDiagnostics = event.data.diagnostics ?? [];
      }
    }
    this.projection = {
      ...current,
      revision: current.revision + input.events.length,
      lastTransactionId: input.transactionId,
      status,
      attempts,
      parkReasons,
      parkDiagnostics,
    };
    return { status: "committed", projection: this.projection };
  }
}
