import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalizeWorkspacePath } from "../../src/paths/pico-paths.js";
import { FileTaskResumeLedger } from "../../src/runtime/file-task-resume-ledger.js";
import { RuntimeEventBoundaryInspector } from "../../src/runtime/runtime-event-boundary-inspector.js";
import { SafeBoundaryResumeCoordinator } from "../../src/runtime/safe-boundary-resume.js";
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
  assert.equal(projection?.revision, 2);
});

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
      data: { attemptId: "attempt-1", boundary },
    },
    {
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: "task-attempt-interrupted",
      taskRunId: TASK_RUN_ID,
      at: AT,
      kind: "attempt.finished",
      data: {
        attemptId: "attempt-1",
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
