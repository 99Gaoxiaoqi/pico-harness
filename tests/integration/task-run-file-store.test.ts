import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { canonicalizeWorkspacePath } from "../../src/paths/pico-paths.js";
import {
  commitFileTransactionSync,
  withFileLockSync,
} from "../../src/storage/local-file-storage.js";
import {
  WORKSPACE_STORAGE_COMMIT_FILE,
  WORKSPACE_STORAGE_LOCK_DIRECTORY,
} from "../../src/storage/workspace-storage-layout.js";
import {
  TASK_RUN_EVENT_SCHEMA_VERSION,
  type RecoverableTaskLaunchReceipt,
  type TaskRunEvent,
} from "../../src/tasks/task-run-contract.js";
import { deriveRecoverableTaskRuntimeLaunchIdentity } from "../../src/tasks/recoverable-task.js";
import {
  hashTaskRunInput,
  TASK_RUN_TRANSACTION_OPTIONS,
  TaskRunStore,
  TaskRunStoreIntegrityError,
  taskRunDigest,
} from "../../src/tasks/task-run-store.js";

const AT = "2026-07-27T00:00:00.000Z";
const EXPIRES_AT = "2026-07-27T00:01:00.000Z";

test("TaskRunStore persists a hashed fact ledger and rebuilds its projection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-task-run-files-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));

  const input = { goal: "finish the task", nested: { order: 1 } };
  const store = new TaskRunStore({
    storageRoot: root,
    now: () => new Date(AT),
  });
  const initialized = await store.initializeTaskRun({
    taskRunId: "task/run:with-path",
    workDir: workspace,
    adapter: {
      id: "test.adapter",
      version: 1,
      input,
      inputHash: hashTaskRunInput(input),
    },
    maxAttempts: 3,
  });
  assert.equal(initialized.status, "queued");
  assert.equal(initialized.revision, 0);
  assert.equal(initialized.header.storageRootId, store.storageRootId);
  await assert.rejects(
    store.initializeTaskRun({
      taskRunId: "another-task",
      workDir: workspace,
      storageRootId: "unverified-root",
      adapter: {
        id: "test.adapter",
        version: 1,
        input,
        inputHash: hashTaskRunInput(input),
      },
      maxAttempts: 3,
    }),
    /does not match the verified workspace root/u,
  );

  const firstBatch = [
    attemptStarted("task/run:with-path", "start-1", "attempt-1", 1, "owner-1", 1),
    executionClaimed("task/run:with-path", "execution-1", "attempt-1", "owner-1", 1),
    checkpointed("task/run:with-path", "checkpoint-1", "attempt-1", "owner-1", 1, workspace),
    attemptFinished("task/run:with-path", "finish-1", "attempt-1", "owner-1", 1, "interrupted"),
  ] satisfies TaskRunEvent[];
  const first = await store.appendBatch("task/run:with-path", firstBatch, {
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
      { inserted: true, sequence: 3, revision: 1, transactionId: "task-transaction-1" },
      { inserted: true, sequence: 4, revision: 1, transactionId: "task-transaction-1" },
    ],
  );
  assert.deepEqual(
    (
      await store.appendBatch("task/run:with-path", structuredClone(firstBatch), {
        transactionId: "task-transaction-1",
      })
    ).map(({ inserted, entry }) => [inserted, entry.sequence]),
    [
      [false, 1],
      [false, 2],
      [false, 3],
      [false, 4],
    ],
  );

  await store.appendBatch(
    "task/run:with-path",
    [
      resumeClaimed(
        "task/run:with-path",
        "claim-event-1",
        "claim-1",
        "attempt-1",
        "attempt-2",
        "owner-2",
        2,
      ),
      attemptStarted("task/run:with-path", "start-2", "attempt-2", 2, "owner-2", 2, "attempt-1"),
      executionClaimed("task/run:with-path", "execution-2", "attempt-2", "owner-2", 2),
      launchClaimed("task/run:with-path", "launch-claim-2", "attempt-2", "launch-2", "owner-2", 3),
      launchSucceeded(
        "task/run:with-path",
        "launch-succeeded-2",
        "attempt-2",
        "launch-2",
        "owner-2",
        3,
      ),
    ],
    { transactionId: "task-transaction-2" },
  );
  await store.appendBatch(
    "task/run:with-path",
    [
      attemptFinished("task/run:with-path", "finish-2", "attempt-2", "owner-2", 2, "succeeded"),
      taskFinished("task/run:with-path", "task-finished", "attempt-2"),
    ],
    { transactionId: "task-transaction-3" },
  );

  const projection = await store.readTaskRunProjection("task/run:with-path");
  assert.equal(projection?.status, "succeeded");
  assert.equal(projection?.revision, 3);
  assert.deepEqual(
    projection?.attempts.map(({ attemptId, attemptNumber, status, sourceAttemptId }) => ({
      attemptId,
      attemptNumber,
      status,
      sourceAttemptId,
    })),
    [
      {
        attemptId: "attempt-1",
        attemptNumber: 1,
        status: "interrupted",
        sourceAttemptId: undefined,
      },
      {
        attemptId: "attempt-2",
        attemptNumber: 2,
        status: "succeeded",
        sourceAttemptId: "attempt-1",
      },
    ],
  );
  assert.deepEqual(
    (await store.readTaskRunEvents("task/run:with-path")).map(({ sequence }) => sequence),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  store.close();
  const reopened = new TaskRunStore({ storageRoot: root });
  const snapshot = await reopened.readTaskRun("task/run:with-path");
  assert.equal(snapshot?.projection.status, "succeeded");
  assert.equal(snapshot?.events.length, 11);

  const digest = taskRunDigest("task/run:with-path");
  const taskDirectory = join(root, "task-runs", digest);
  const ledgerPath = join(taskDirectory, "task.jsonl");
  const manifestPath = join(taskDirectory, "manifest.json");
  const lines = (await readFile(ledgerPath, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 4);
  assert.equal(JSON.parse(lines[0]!).taskRunId, "task/run:with-path");
  assert.equal(JSON.parse(lines[1]!).entries.length, 4);
  assert.equal(JSON.parse(lines[2]!).entries.length, 5);
  assert.equal(JSON.parse(lines[3]!).entries.length, 2);
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).ledger.lastSequence, 11);
  if (process.platform !== "win32") {
    assert.equal((await stat(taskDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
    assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
  }

  await writeFile(manifestPath, '{"forged":true}\n', { mode: 0o600 });
  assert.equal((await reopened.listTaskRunProjections())[0]?.revision, 3);
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).ledger.lastSequence, 11);

  await assert.rejects(
    reopened.appendBatch("task/run:with-path", [
      attemptStarted(
        "task/run:with-path",
        "start-1",
        "attempt-1",
        1,
        "owner-1",
        1,
        undefined,
        "2026-07-27T00:00:01.000Z",
      ),
      executionClaimed("task/run:with-path", "execution-1", "attempt-1", "owner-1", 1),
    ]),
    (error: unknown) =>
      error instanceof TaskRunStoreIntegrityError &&
      /already bound to another payload/u.test(error.message),
  );
  await assert.rejects(
    reopened.appendBatch("task/run:with-path", [taskParked("task/run:with-path", "different")], {
      transactionId: "task-transaction-1",
    }),
    (error: unknown) =>
      error instanceof TaskRunStoreIntegrityError &&
      /transaction task-transaction-1 is already bound/u.test(error.message),
  );
});

test("TaskRunStore rejects stale Attempt owner and lease-epoch mutations atomically", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-task-run-fence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await initializedStore(root, "fenced-task");
  await store.appendBatch(
    "fenced-task",
    [
      attemptStarted("fenced-task", "start", "attempt-1", 1, "owner-current", 2),
      executionClaimed("fenced-task", "execution", "attempt-1", "owner-current", 2),
    ],
    { transactionId: "start" },
  );
  const before = await readFile(ledgerPath(root, "fenced-task"), "utf8");

  await assert.rejects(
    store.append(
      "fenced-task",
      checkpointed(
        "fenced-task",
        "stale-owner-checkpoint",
        "attempt-1",
        "owner-stale",
        2,
        join(root, "workspace"),
      ),
      { transactionId: "stale-owner-checkpoint" },
    ),
    /execution lease fence rejected/u,
  );
  await assert.rejects(
    store.append(
      "fenced-task",
      attemptFinished(
        "fenced-task",
        "stale-epoch-finish",
        "attempt-1",
        "owner-current",
        1,
        "interrupted",
      ),
      { transactionId: "stale-epoch-finish" },
    ),
    /execution lease fence rejected/u,
  );

  assert.equal(await readFile(ledgerPath(root, "fenced-task"), "utf8"), before);
  await store.append(
    "fenced-task",
    executionClaimed(
      "fenced-task",
      "execution-transfer",
      "attempt-1",
      "owner-replacement",
      3,
      "2026-07-27T00:01:00.001Z",
      "2026-07-27T00:02:00.000Z",
    ),
    {
      transactionId: "execution-transfer",
      now: () => new Date("2026-07-27T00:01:00.001Z"),
    },
  );
  const afterTransfer = await readFile(ledgerPath(root, "fenced-task"), "utf8");

  for (const staleEvent of [
    checkpointed(
      "fenced-task",
      "backdated-old-owner-checkpoint",
      "attempt-1",
      "owner-current",
      2,
      join(root, "workspace"),
    ),
    attemptFinished(
      "fenced-task",
      "backdated-old-owner-finish",
      "attempt-1",
      "owner-current",
      2,
      "interrupted",
    ),
  ]) {
    await assert.rejects(
      store.append("fenced-task", staleEvent, {
        transactionId: staleEvent.eventId,
        now: () => new Date("2026-07-27T00:01:00.002Z"),
      }),
      /execution lease fence rejected/u,
    );
    assert.equal(await readFile(ledgerPath(root, "fenced-task"), "utf8"), afterTransfer);
  }
  await assert.rejects(
    store.append(
      "fenced-task",
      checkpointed(
        "fenced-task",
        "expired-current-owner-checkpoint",
        "attempt-1",
        "owner-replacement",
        3,
        join(root, "workspace"),
      ),
      {
        transactionId: "expired-current-owner-checkpoint",
        now: () => new Date("2026-07-27T00:02:00.001Z"),
      },
    ),
    /execution lease fence rejected/u,
  );
  assert.equal(await readFile(ledgerPath(root, "fenced-task"), "utf8"), afterTransfer);
  const projection = await store.readTaskRunProjection("fenced-task");
  assert.equal(projection?.revision, 2);
  assert.equal(projection?.attempts[0]?.status, "running");
  assert.deepEqual(projection?.attempts[0]?.execution, {
    ownerId: "owner-replacement",
    leaseEpoch: 3,
    claimedAt: "2026-07-27T00:01:00.001Z",
    expiresAt: "2026-07-27T00:02:00.000Z",
  });
});

test("TaskRunStore fences launch claims, receipts, and settlement with the execution lease", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-task-run-launch-fence-"));
  const taskRunId = "launch-fenced-task";
  const workspace = join(root, "workspace");
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await initializedStore(root, taskRunId);
  await store.appendBatch(
    taskRunId,
    [
      attemptStarted(taskRunId, "source-start", "attempt-1", 1, "owner-a", 1),
      executionClaimed(taskRunId, "source-execution", "attempt-1", "owner-a", 1),
      checkpointed(taskRunId, "source-checkpoint", "attempt-1", "owner-a", 1, workspace),
      attemptFinished(taskRunId, "source-interrupted", "attempt-1", "owner-a", 1, "interrupted"),
    ],
    { transactionId: "source-attempt" },
  );
  const beforeMismatchedClaim = await readFile(ledgerPath(root, taskRunId), "utf8");

  await assert.rejects(
    store.appendBatch(
      taskRunId,
      [
        resumeClaimed(
          taskRunId,
          "resume-owner-b",
          "resume-owner-b",
          "attempt-1",
          "attempt-2",
          "owner-b",
          2,
        ),
        attemptStarted(
          taskRunId,
          "successor-start-owner-b",
          "attempt-2",
          2,
          "owner-b",
          2,
          "attempt-1",
        ),
        executionClaimed(taskRunId, "successor-execution-owner-b", "attempt-2", "owner-b", 2),
        launchClaimed(taskRunId, "launch-owner-c", "attempt-2", "launch-fenced", "owner-c", 1),
      ],
      { transactionId: "mismatched-launch-owner" },
    ),
    /invalid launch lease claim/u,
  );
  assert.equal(await readFile(ledgerPath(root, taskRunId), "utf8"), beforeMismatchedClaim);
  assert.equal((await store.readTaskRunProjection(taskRunId))?.revision, 1);

  await store.appendBatch(
    taskRunId,
    [
      resumeClaimed(
        taskRunId,
        "resume-valid",
        "resume-valid",
        "attempt-1",
        "attempt-2",
        "owner-b",
        2,
      ),
      attemptStarted(taskRunId, "successor-start-valid", "attempt-2", 2, "owner-b", 2, "attempt-1"),
      executionClaimed(
        taskRunId,
        "successor-execution-valid",
        "attempt-2",
        "owner-b",
        2,
        AT,
        "2026-07-27T00:00:10.000Z",
      ),
      launchClaimed(taskRunId, "launch-valid", "attempt-2", "launch-fenced", "owner-b", 1),
    ],
    { transactionId: "valid-launch-claim" },
  );
  const afterValidClaim = await readFile(ledgerPath(root, taskRunId), "utf8");
  const validSettlement = launchSucceeded(
    taskRunId,
    "launch-valid-settlement",
    "attempt-2",
    "launch-fenced",
    "owner-b",
    1,
  );
  const invalidReceipts: RecoverableTaskLaunchReceipt[] = [
    { ...validSettlement.data.receipt, sessionId: "another-session" },
    { ...validSettlement.data.receipt, runId: "another-run" },
    { ...validSettlement.data.receipt, runStartedEventId: "another-start-event" },
    { ...validSettlement.data.receipt, runStartedSequence: 6 },
  ];
  for (const [index, receipt] of invalidReceipts.entries()) {
    await assert.rejects(
      store.append(
        taskRunId,
        {
          ...validSettlement,
          eventId: `invalid-receipt-${index}`,
          data: { ...validSettlement.data, receipt },
        },
        {
          transactionId: `invalid-receipt-${index}`,
          now: () => new Date("2026-07-27T00:00:05.000Z"),
        },
      ),
      /launch receipt does not match its source Runtime boundary/u,
    );
    assert.equal(await readFile(ledgerPath(root, taskRunId), "utf8"), afterValidClaim);
  }

  await store.append(
    taskRunId,
    executionClaimed(
      taskRunId,
      "successor-execution-transfer",
      "attempt-2",
      "owner-c",
      3,
      "2026-07-27T00:00:10.001Z",
      "2026-07-27T00:02:00.000Z",
    ),
    {
      transactionId: "successor-execution-transfer",
      now: () => new Date("2026-07-27T00:00:10.001Z"),
    },
  );
  const afterExecutionTransfer = await readFile(ledgerPath(root, taskRunId), "utf8");
  for (const settlement of [
    {
      ...validSettlement,
      eventId: "stale-owner-launch-succeeded",
      at: "2026-07-27T00:00:10.002Z",
    },
    launchFailed(
      taskRunId,
      "stale-owner-launch-failed",
      "attempt-2",
      "launch-fenced",
      "owner-b",
      1,
      "2026-07-27T00:00:10.002Z",
    ),
  ]) {
    await assert.rejects(
      store.append(taskRunId, settlement, {
        transactionId: settlement.eventId,
        now: () => new Date("2026-07-27T00:00:10.002Z"),
      }),
      /launch settlement lost its lease/u,
    );
    assert.equal(await readFile(ledgerPath(root, taskRunId), "utf8"), afterExecutionTransfer);
  }
  const projection = await store.readTaskRunProjection(taskRunId);
  assert.equal(projection?.attempts[1]?.execution.ownerId, "owner-c");
  assert.equal(projection?.attempts[1]?.execution.leaseEpoch, 3);
  assert.equal(projection?.attempts[1]?.launch?.status, "claimed");
});

test("TaskRunStore rejects a post-construction task-runs symlink before read, repair or write", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-task-run-symlink-"));
  const storageRoot = join(root, "state");
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await initializedStore(storageRoot, "symlink-task");
  const taskRunsRoot = join(storageRoot, "task-runs");
  const outsideTaskRuns = join(root, "outside-task-runs");
  await rename(taskRunsRoot, outsideTaskRuns);
  await symlink(outsideTaskRuns, taskRunsRoot, "dir");
  const outsideLedger = join(outsideTaskRuns, taskRunDigest("symlink-task"), "task.jsonl");
  await appendFile(outsideLedger, '{"incomplete":');
  const before = await readFile(outsideLedger, "utf8");

  await assert.rejects(
    store.readTaskRunProjection("symlink-task"),
    /TaskRun storage must be a real directory/u,
  );
  await assert.rejects(
    store.appendBatch(
      "symlink-task",
      [
        attemptStarted("symlink-task", "outside-start", "attempt-1", 1, "owner", 1),
        executionClaimed("symlink-task", "outside-execution", "attempt-1", "owner", 1),
      ],
      { transactionId: "outside-write" },
    ),
    /TaskRun storage must be a real directory/u,
  );

  assert.equal(await readFile(outsideLedger, "utf8"), before);
});

test("TaskRunStore recovers a published commit and only repairs an incomplete tail", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-task-run-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await initializedStore(root, "recover-task");
  const event = attemptStarted(
    "recover-task",
    "recover-start",
    "recover-attempt",
    1,
    "recover-owner",
    1,
  );
  const execution = executionClaimed(
    "recover-task",
    "recover-execution",
    "recover-attempt",
    "recover-owner",
    1,
  );
  const batch = {
    type: "task-event-batch",
    schemaVersion: 1,
    txId: "recover-transaction",
    entries: [
      { sequence: 1, committedAt: AT, event },
      { sequence: 2, committedAt: AT, event: execution },
    ],
  };

  assert.throws(
    () =>
      withFileLockSync(
        join(root, WORKSPACE_STORAGE_LOCK_DIRECTORY),
        "task-run-recovery-fixture",
        () =>
          commitFileTransactionSync(
            root,
            {
              appends: [
                {
                  relativePath: join("task-runs", taskRunDigest("recover-task"), "task.jsonl"),
                  content: `${JSON.stringify(batch)}\n`,
                },
              ],
            },
            {
              ...TASK_RUN_TRANSACTION_OPTIONS,
              transactionId: "recover-transaction",
              onStage(stage) {
                if (stage === "commit-published") throw new Error("injected TaskRun crash");
              },
            },
          ),
      ),
    /injected TaskRun crash/u,
  );
  assert.match(
    await readFile(join(root, WORKSPACE_STORAGE_COMMIT_FILE), "utf8"),
    /recover-transaction/u,
  );
  assert.equal((await store.readTaskRunEvents("recover-task"))[0]?.event.eventId, "recover-start");
  await assert.rejects(stat(join(root, WORKSPACE_STORAGE_COMMIT_FILE)), { code: "ENOENT" });

  const incompleteRoot = join(root, "incomplete");
  const incomplete = await initializedStore(incompleteRoot, "incomplete-task");
  const incompleteLedger = ledgerPath(incompleteRoot, "incomplete-task");
  await appendFile(incompleteLedger, '{"type":"task-event-batch"');
  assert.deepEqual(await incomplete.readTaskRunEvents("incomplete-task"), []);
  assert.equal((await readFile(incompleteLedger, "utf8")).trimEnd().split("\n").length, 1);

  const malformedRoot = join(root, "malformed");
  const malformed = await initializedStore(malformedRoot, "malformed-task");
  await appendFile(ledgerPath(malformedRoot, "malformed-task"), "{not-json}\n");
  await assert.rejects(
    malformed.readTaskRunProjection("malformed-task"),
    (error: unknown) =>
      error instanceof TaskRunStoreIntegrityError && /record 2 is invalid/u.test(error.message),
  );
});

test("TaskRunStore rejects invalid state transitions without publishing a batch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-task-run-invalid-transition-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await initializedStore(root, "invalid-task");
  await store.appendBatch("invalid-task", [
    attemptStarted("invalid-task", "start", "attempt-1", 1, "owner-1", 1),
    executionClaimed("invalid-task", "execution", "attempt-1", "owner-1", 1),
  ]);
  const before = await readFile(ledgerPath(root, "invalid-task"), "utf8");

  await assert.rejects(
    store.append(
      "invalid-task",
      resumeClaimed(
        "invalid-task",
        "unpaired-claim-event",
        "unpaired-claim",
        "attempt-1",
        "attempt-2",
        "owner-2",
        2,
      ),
    ),
    /must atomically pair every resume claim/u,
  );
  await assert.rejects(
    store.appendBatch("invalid-task", [
      resumeClaimed("invalid-task", "claim-event", "claim", "attempt-1", "attempt-2", "owner-2", 2),
      attemptStarted("invalid-task", "successor-start", "attempt-2", 2, "owner-2", 2, "attempt-1"),
      executionClaimed("invalid-task", "successor-execution", "attempt-2", "owner-2", 2),
    ]),
    (error: unknown) =>
      error instanceof TaskRunStoreIntegrityError &&
      /source is not interrupted/u.test(error.message),
  );
  assert.equal(await readFile(ledgerPath(root, "invalid-task"), "utf8"), before);
});

test("TaskRunStore serializes independent process writers without losing sequence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-task-run-processes-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await initializedStore(root, "shared-task");
  const modulePath = new URL("../../src/tasks/task-run-store.ts", import.meta.url).href;
  const source = `
    import { TaskRunStore } from ${JSON.stringify(modulePath)};
    const store = new TaskRunStore({ storageRoot: process.env.TEST_STORAGE_ROOT });
    const prefix = process.env.TEST_EVENT_PREFIX;
    await store.appendBatch("shared-task", Array.from({ length: 8 }, (_, index) => ({
      schemaVersion: 1,
      eventId: prefix + ":" + index,
      taskRunId: "shared-task",
      at: "2026-07-27T00:00:00.000Z",
      kind: "task.parked",
      data: { reasons: ["adapter_missing"], diagnostics: [prefix] },
    })), { transactionId: "tx:" + prefix });
  `;
  const runChild = async (prefix: string) => {
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEST_STORAGE_ROOT: root,
          TEST_EVENT_PREFIX: prefix,
        },
      },
    );
  };
  await Promise.all([runChild("left"), runChild("right")]);

  const events = await store.readTaskRunEvents("shared-task");
  assert.deepEqual(
    events.map(({ sequence }) => sequence),
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
  assert.deepEqual([...new Set(events.map(({ event }) => event.eventId.split(":")[0]))].sort(), [
    "left",
    "right",
  ]);
  assert.equal((await store.readTaskRunProjection("shared-task"))?.revision, 2);
});

async function initializedStore(root: string, taskRunId: string): Promise<TaskRunStore> {
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const input = { taskRunId };
  const store = new TaskRunStore({
    storageRoot: root,
    now: () => new Date(AT),
  });
  await store.initializeTaskRun({
    taskRunId,
    workDir: workspace,
    adapter: {
      id: "test.adapter",
      version: 1,
      input,
      inputHash: hashTaskRunInput(input),
    },
    maxAttempts: 4,
  });
  return store;
}

function ledgerPath(root: string, taskRunId: string): string {
  return join(root, "task-runs", taskRunDigest(taskRunId), "task.jsonl");
}

function attemptStarted(
  taskRunId: string,
  eventId: string,
  attemptId: string,
  attemptNumber: number,
  _ownerId: string,
  _leaseEpoch: number,
  sourceAttemptId?: string,
  at = AT,
): Extract<TaskRunEvent, { kind: "attempt.started" }> {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at,
    kind: "attempt.started",
    data: {
      attemptId,
      attemptNumber,
      ...(sourceAttemptId ? { sourceAttemptId } : {}),
    },
  };
}

function executionClaimed(
  taskRunId: string,
  eventId: string,
  attemptId: string,
  ownerId: string,
  leaseEpoch: number,
  at = AT,
  expiresAt = EXPIRES_AT,
): Extract<TaskRunEvent, { kind: "attempt.execution.claimed" }> {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at,
    kind: "attempt.execution.claimed",
    data: { attemptId, ownerId, leaseEpoch, expiresAt },
  };
}

function checkpointed(
  taskRunId: string,
  eventId: string,
  attemptId: string,
  ownerId: string,
  leaseEpoch: number,
  workspacePath: string,
): TaskRunEvent {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at: AT,
    kind: "attempt.checkpointed",
    data: {
      attemptId,
      ownerId,
      leaseEpoch,
      boundary: {
        storageRootId: "storage-root-1",
        workspacePath: canonicalizeWorkspacePath(workspacePath),
        backgroundOperationsSettled: true,
        runtime: {
          sessionId: "session-1",
          runId: "run-1",
          eventHighWater: 4,
          terminalEventId: "runtime-terminal-1",
        },
        toolCatalogHash: "tool-catalog-1",
        checkpointRef: "checkpoint-1",
      },
    },
  };
}

function attemptFinished(
  taskRunId: string,
  eventId: string,
  attemptId: string,
  ownerId: string,
  leaseEpoch: number,
  status: "interrupted" | "succeeded",
): TaskRunEvent {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at: AT,
    kind: "attempt.finished",
    data: { attemptId, ownerId, leaseEpoch, status },
  };
}

function launchClaimed(
  taskRunId: string,
  eventId: string,
  attemptId: string,
  launchId: string,
  ownerId: string,
  leaseEpoch: number,
  at = AT,
  expiresAt = EXPIRES_AT,
): Extract<TaskRunEvent, { kind: "attempt.launch.claimed" }> {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at,
    kind: "attempt.launch.claimed",
    data: {
      attemptId,
      launchId,
      ownerId,
      leaseEpoch,
      expiresAt,
    },
  };
}

function launchSucceeded(
  taskRunId: string,
  eventId: string,
  attemptId: string,
  launchId: string,
  ownerId: string,
  leaseEpoch: number,
  at = AT,
): Extract<TaskRunEvent, { kind: "attempt.launch.succeeded" }> {
  const identity = deriveRecoverableTaskRuntimeLaunchIdentity(launchId);
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at,
    kind: "attempt.launch.succeeded",
    data: {
      attemptId,
      launchId,
      ownerId,
      leaseEpoch,
      receipt: {
        schemaVersion: 1,
        launchId,
        sessionId: "session-1",
        runId: identity.runId,
        runStartedEventId: identity.runStartedEventId,
        runStartedSequence: 5,
      },
    },
  };
}

function launchFailed(
  taskRunId: string,
  eventId: string,
  attemptId: string,
  launchId: string,
  ownerId: string,
  leaseEpoch: number,
  at = AT,
): Extract<TaskRunEvent, { kind: "attempt.launch.failed" }> {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at,
    kind: "attempt.launch.failed",
    data: {
      attemptId,
      launchId,
      ownerId,
      leaseEpoch,
      error: "launch failed",
    },
  };
}

function resumeClaimed(
  taskRunId: string,
  eventId: string,
  claimId: string,
  sourceAttemptId: string,
  successorAttemptId: string,
  ownerId: string,
  leaseEpoch: number,
): TaskRunEvent {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at: AT,
    kind: "task.resume.claimed",
    data: {
      claimId,
      sourceAttemptId,
      successorAttemptId,
      ownerId,
      leaseEpoch,
    },
  };
}

function taskFinished(taskRunId: string, eventId: string, attemptId: string): TaskRunEvent {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at: AT,
    kind: "task.finished",
    data: {
      status: "succeeded",
      attemptId,
    },
  };
}

function taskParked(taskRunId: string, eventId: string): TaskRunEvent {
  return {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    taskRunId,
    at: AT,
    kind: "task.parked",
    data: {
      reasons: ["adapter_missing"],
    },
  };
}
