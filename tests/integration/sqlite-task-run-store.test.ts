import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalizeWorkspacePath } from "../../src/paths/pico-paths.js";
import { SqliteTaskRunStore } from "../../src/storage/sqlite/sqlite-task-run-store.js";
import {
  TASK_RUN_EVENT_SCHEMA_VERSION,
  type TaskRunEvent,
  type TaskSafeBoundary,
} from "../../src/tasks/task-run-contract.js";
import {
  hashTaskRunInput,
  TaskRunStoreRevisionConflictError,
  type TaskRunSnapshot,
} from "../../src/tasks/task-run-store-contracts.js";

const AT = "2026-08-18T00:00:00.000Z";
const EXPIRES_AT = "2026-08-18T00:01:00.000Z";

test("sqlite TaskRunStore persists a full lifecycle and rebuilds it identically after reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-sqlite-task-run-"));
  const workspace = join(root, "workspace");
  const taskRunId = "task/run:with-path";
  const input = { goal: "finish the task", nested: { order: 1 } };
  const adapter = {
    id: "test.adapter",
    version: 1,
    input,
    inputHash: hashTaskRunInput(input),
  };
  const store = new SqliteTaskRunStore({ storageRoot: root, now: () => new Date(AT) });
  let beforeSnapshot: TaskRunSnapshot | undefined;
  try {
    await mkdirWorkspace(workspace);
    const initialized = await store.initializeTaskRun({
      taskRunId,
      workDir: workspace,
      adapter,
      maxAttempts: 3,
    });
    assert.equal(initialized.status, "queued");
    assert.equal(initialized.revision, 0);
    assert.equal(initialized.header.storageRootId, store.storageRootId);
    assert.equal(initialized.header.createdAt, AT);

    const reinitialized = await store.initializeTaskRun({
      taskRunId,
      workDir: workspace,
      adapter,
      maxAttempts: 3,
    });
    assert.equal(reinitialized.revision, 0);
    await assert.rejects(
      store.initializeTaskRun({
        taskRunId,
        workDir: join(root, "another-workspace"),
        adapter,
        maxAttempts: 3,
      }),
      /already bound to different immutable metadata/u,
    );

    const batch1 = [
      attemptStarted(taskRunId, "start-1", "attempt-1", 1),
      executionClaimed(taskRunId, "execution-1", "attempt-1", "owner-1", 1),
    ] satisfies TaskRunEvent[];
    const first = await store.appendBatch(taskRunId, batch1, {
      transactionId: "task-transaction-1",
    });
    assert.deepEqual(
      first.map(({ inserted, entry, revision, transactionId }) => ({
        inserted,
        sequence: entry.sequence,
        revision,
        transactionId,
      })),
      [
        { inserted: true, sequence: 1, revision: 1, transactionId: "task-transaction-1" },
        { inserted: true, sequence: 2, revision: 1, transactionId: "task-transaction-1" },
      ],
    );
    const boundary = checkpointBoundary(workspace);
    await store.append(taskRunId, checkpointed(taskRunId, "checkpoint-1", "attempt-1", "owner-1", 1, boundary), {
      transactionId: "task-transaction-2",
    });
    const running = await store.readTaskRunProjection(taskRunId);
    assert.equal(running?.status, "running");
    assert.equal(running?.revision, 2);
    assert.deepEqual(running?.attempts[0]?.boundary, boundary);
    assert.deepEqual(running?.attempts[0]?.execution, {
      ownerId: "owner-1",
      leaseEpoch: 1,
      claimedAt: AT,
      expiresAt: EXPIRES_AT,
    });

    await store.appendBatch(
      taskRunId,
      [
        attemptFinished(taskRunId, "finish-1", "attempt-1", "owner-1", 1, "succeeded"),
        taskFinished(taskRunId, "task-finished", "attempt-1"),
      ],
      { transactionId: "task-transaction-3" },
    );
    const finished = await store.readTaskRunProjection(taskRunId);
    assert.equal(finished?.status, "succeeded");
    assert.equal(finished?.revision, 3);
    assert.equal(finished?.lastTransactionId, "task-transaction-3");
    assert.deepEqual(finished?.terminal, { status: "succeeded", attemptId: "attempt-1" });
    beforeSnapshot = await store.readTaskRun(taskRunId);
    assert.equal(beforeSnapshot?.events.length, 5);
  } finally {
    store.close();
  }

  const reopened = new SqliteTaskRunStore({ storageRoot: root });
  try {
    const snapshot = await reopened.readTaskRun(taskRunId);
    assert.ok(snapshot);
    assert.deepEqual(snapshot, beforeSnapshot);
    assert.deepEqual(
      snapshot.events.map(({ sequence }) => sequence),
      [1, 2, 3, 4, 5],
    );
    assert.equal(snapshot.projection.status, "succeeded");
    assert.equal(snapshot.projection.revision, 3);
    assert.equal(snapshot.projection.attempts[0]?.status, "succeeded");
    assert.equal(snapshot.projection.attempts[0]?.finishedAt, AT);
    assert.deepEqual(snapshot.projection.attempts[0]?.boundary, checkpointBoundary(workspace));
    assert.deepEqual(snapshot.projection.terminal, { status: "succeeded", attemptId: "attempt-1" });

    const replayed = await reopened.appendBatch(taskRunId, structuredClone(firstBatch(taskRunId)), {
      transactionId: "task-transaction-1",
    });
    assert.deepEqual(
      replayed.map(({ inserted, entry, revision, transactionId }) => ({
        inserted,
        sequence: entry.sequence,
        revision,
        transactionId,
      })),
      [
        { inserted: false, sequence: 1, revision: 1, transactionId: "task-transaction-1" },
        { inserted: false, sequence: 2, revision: 1, transactionId: "task-transaction-1" },
      ],
    );
    assert.equal((await reopened.readTaskRunEvents(taskRunId)).length, 5);
    assert.equal((await reopened.readTaskRunProjection(taskRunId))?.revision, 3);

    const deduplicated = await reopened.append(
      taskRunId,
      checkpointed(taskRunId, "checkpoint-1", "attempt-1", "owner-1", 1, checkpointBoundary(workspace)),
    );
    assert.equal(deduplicated.inserted, false);
    assert.equal(deduplicated.entry.sequence, 3);
    assert.equal(deduplicated.revision, 2);
    assert.equal(deduplicated.transactionId, "task-transaction-2");
    assert.equal((await reopened.readTaskRunProjection(taskRunId))?.revision, 3);

    const list = await reopened.listTaskRunProjections();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.status, "succeeded");
    const inspection = await reopened.inspectTaskRuns();
    assert.deepEqual(inspection.staleManifestPaths, []);
    assert.deepEqual(inspection.storageRootMismatches, []);
    assert.equal(inspection.projections.length, 1);
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("sqlite TaskRunStore enforces expectedRevision CAS and transaction payload binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-sqlite-task-run-cas-"));
  const workspace = join(root, "workspace");
  const taskRunId = "cas-task";
  const input = { taskRunId };
  const store = new SqliteTaskRunStore({ storageRoot: root, now: () => new Date(AT) });
  try {
    await mkdirWorkspace(workspace);
    await store.initializeTaskRun({
      taskRunId,
      workDir: workspace,
      adapter: { id: "test.adapter", version: 1, input, inputHash: hashTaskRunInput(input) },
      maxAttempts: 2,
    });
    await store.appendBatch(
      taskRunId,
      [
        attemptStarted(taskRunId, "start", "attempt-1", 1),
        executionClaimed(taskRunId, "execution", "attempt-1", "owner-1", 1),
      ],
      { transactionId: "tx-1" },
    );

    await assert.rejects(
      store.appendBatch(taskRunId, [taskParked(taskRunId, "stale-cas")], {
        transactionId: "tx-stale",
        expectedRevision: 0,
      }),
      (error: unknown) =>
        error instanceof TaskRunStoreRevisionConflictError && error.projection.revision === 1,
    );
    assert.equal((await store.readTaskRunProjection(taskRunId))?.revision, 1);
    assert.equal((await store.readTaskRunEvents(taskRunId)).length, 2);

    await assert.rejects(
      store.appendBatch(taskRunId, [taskParked(taskRunId, "conflicting-payload")], {
        transactionId: "tx-1",
      }),
      /transaction tx-1 is already bound to another payload/u,
    );

    const checkpoint = checkpointed(
      taskRunId,
      "checkpoint",
      "attempt-1",
      "owner-1",
      1,
      checkpointBoundary(workspace),
    );
    const committed = await store.append(taskRunId, checkpoint, {
      transactionId: "tx-2",
      expectedRevision: 1,
    });
    assert.equal(committed.inserted, true);
    assert.equal(committed.revision, 2);
    assert.equal(committed.entry.sequence, 3);

    await assert.rejects(
      store.append(
        taskRunId,
        checkpointed(taskRunId, "stale-owner-checkpoint", "attempt-1", "owner-stale", 1, checkpointBoundary(workspace)),
        { transactionId: "tx-stale-owner" },
      ),
      /execution lease fence rejected/u,
    );
    assert.equal((await store.readTaskRunEvents(taskRunId)).length, 3);
    assert.equal((await store.readTaskRunProjection(taskRunId))?.revision, 2);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("sqlite TaskRunStore keeps every fact inside pico.sqlite without task-runs directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-sqlite-task-run-layout-"));
  const workspace = join(root, "workspace");
  const taskRunId = "layout-task";
  const input = { taskRunId };
  const store = new SqliteTaskRunStore({ storageRoot: root, now: () => new Date(AT) });
  try {
    await mkdirWorkspace(workspace);
    await store.initializeTaskRun({
      taskRunId,
      workDir: workspace,
      adapter: { id: "test.adapter", version: 1, input, inputHash: hashTaskRunInput(input) },
      maxAttempts: 2,
    });
    await store.appendBatch(
      taskRunId,
      [
        attemptStarted(taskRunId, "start", "attempt-1", 1),
        executionClaimed(taskRunId, "execution", "attempt-1", "owner-1", 1),
        checkpointed(taskRunId, "checkpoint", "attempt-1", "owner-1", 1, checkpointBoundary(workspace)),
      ],
      { transactionId: "tx-1" },
    );
  } finally {
    store.close();
  }
  try {
    const entries = await readdir(root);
    assert.ok(entries.includes("pico.sqlite"));
    assert.ok(!entries.includes("task-runs"), "task-runs/ directory must not exist");
    assert.ok(!existsSync(join(root, "task-runs")));
    for (const entry of entries.filter((name) => name !== "workspace")) {
      assert.match(entry, /^pico\.sqlite(-wal|-shm)?$/u, `unexpected storage entry: ${entry}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function mkdirWorkspace(workspace: string): Promise<void> {
  await mkdir(workspace);
}

function firstBatch(taskRunId: string): TaskRunEvent[] {
  return [
    attemptStarted(taskRunId, "start-1", "attempt-1", 1),
    executionClaimed(taskRunId, "execution-1", "attempt-1", "owner-1", 1),
  ];
}

function checkpointBoundary(workspace: string): TaskSafeBoundary {
  return {
    storageRootId: "storage-root-1",
    workspacePath: canonicalizeWorkspacePath(workspace),
    backgroundOperationsSettled: true,
    runtime: {
      sessionId: "session-1",
      runId: "run-1",
      eventHighWater: 4,
      terminalEventId: "runtime-terminal-1",
    },
    toolCatalogHash: "tool-catalog-1",
    checkpointRef: "checkpoint-1",
  };
}

function attemptStarted(
  taskRunId: string,
  eventId: string,
  attemptId: string,
  attemptNumber: number,
): Extract<TaskRunEvent, { kind: "attempt.started" }> {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at: AT,
    kind: "attempt.started",
    data: { attemptId, attemptNumber },
  };
}

function executionClaimed(
  taskRunId: string,
  eventId: string,
  attemptId: string,
  ownerId: string,
  leaseEpoch: number,
): Extract<TaskRunEvent, { kind: "attempt.execution.claimed" }> {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at: AT,
    kind: "attempt.execution.claimed",
    data: { attemptId, ownerId, leaseEpoch, expiresAt: EXPIRES_AT },
  };
}

function checkpointed(
  taskRunId: string,
  eventId: string,
  attemptId: string,
  ownerId: string,
  leaseEpoch: number,
  boundary: TaskSafeBoundary,
): Extract<TaskRunEvent, { kind: "attempt.checkpointed" }> {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at: AT,
    kind: "attempt.checkpointed",
    data: { attemptId, ownerId, leaseEpoch, boundary },
  };
}

function attemptFinished(
  taskRunId: string,
  eventId: string,
  attemptId: string,
  ownerId: string,
  leaseEpoch: number,
  status: "succeeded",
): Extract<TaskRunEvent, { kind: "attempt.finished" }> {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at: AT,
    kind: "attempt.finished",
    data: { attemptId, ownerId, leaseEpoch, status },
  };
}

function taskFinished(
  taskRunId: string,
  eventId: string,
  attemptId: string,
): Extract<TaskRunEvent, { kind: "task.finished" }> {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at: AT,
    kind: "task.finished",
    data: { status: "succeeded", attemptId },
  };
}

function taskParked(taskRunId: string, eventId: string): TaskRunEvent {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at: AT,
    kind: "task.parked",
    data: { reasons: ["adapter_missing"] },
  };
}
