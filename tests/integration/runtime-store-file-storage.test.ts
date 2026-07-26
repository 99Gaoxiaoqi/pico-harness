import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  commitFileTransactionSync,
  withFileLockSync,
} from "../../src/storage/local-file-storage.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
} from "../../src/storage/runtime-event.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";
import {
  WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
  WORKSPACE_STORAGE_COMMIT_FILE,
  WORKSPACE_STORAGE_LAYOUT_FILE,
  WORKSPACE_STORAGE_LOCK_DIRECTORY,
} from "../../src/storage/workspace-storage-layout.js";
import { inspectRuntimeStoreIndexForTesting, RuntimeStore } from "../../src/tasks/runtime-store.js";

test("RuntimeStore rejects an empty explicit storage root", () => {
  assert.throws(
    () => new RuntimeStore({ workDir: process.cwd(), storageRoot: " " }),
    /storageRoot must not be empty/u,
  );
});

test("RuntimeStore commits job state and replay ledgers without SQLite", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const store = new RuntimeStore({
    workDir: root,
    storageRoot: root,
    now: () => now,
  });

  const queued = store.createJob({
    jobId: "job-1",
    type: "local_agent",
    executionClass: "recoverable",
    completionPolicy: "required",
    description: "test",
    ownerSessionId: "owner-session",
  });
  const lease = store.acquireLease("job:job-1", "worker-1");
  now += 1;
  const started = store.startJob({
    jobId: "job-1",
    attemptId: "attempt-1",
    ownerId: "worker-1",
    leaseEpoch: lease.leaseEpoch,
    expectedVersion: queued.version,
  });
  now += 1;
  store.finishJob({
    jobId: "job-1",
    attemptId: "attempt-1",
    ownerId: "worker-1",
    status: "succeeded",
    expectedJobVersion: started.job.version,
    expectedAttemptVersion: started.attempt.version,
    leaseEpoch: lease.leaseEpoch,
    completionId: "completion-1",
  });
  store.appendRuntimeEvent({
    eventId: "event-1",
    topic: "run.started",
    workspacePath: root,
  });
  store.recordProviderCall({
    callId: "call-1",
    purpose: "main",
    provider: "test",
    model: "test",
    status: "succeeded",
    inputTokens: 2,
    outputTokens: 3,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0.1,
  });
  store.close();

  const reopened = new RuntimeStore({ workDir: root, storageRoot: root });
  assert.equal(reopened.getJob("job-1")?.status, "succeeded");
  assert.equal(reopened.listPendingCompletions()[0]?.completionId, "completion-1");
  assert.deepEqual(
    reopened.listRuntimeEvents().map((event) => event.eventId),
    ["event-1"],
  );
  assert.equal(reopened.getUsageSummary().total.inputTokens, 2);
  assert.equal(reopened.getUsageSummary().total.outputTokens, 3);

  const state = await readFile(join(root, "control/state.json"), "utf8");
  const events = await readFile(join(root, "control/daemon-events.jsonl"), "utf8");
  const usage = await readFile(join(root, "control/usage-ledger.jsonl"), "utf8");
  assert.match(state, /"schemaVersion": 1/u);
  assert.match(events, /"sequence":1/u);
  assert.match(usage, /"type":"provider-call"/u);
  assert.match(
    await readFile(join(root, WORKSPACE_STORAGE_LAYOUT_FILE), "utf8"),
    /"layout": "session-centric-v1"/u,
  );
  await assert.rejects(stat(join(root, WORKSPACE_STORAGE_COMMIT_FILE)), { code: "ENOENT" });
  assert.equal((await stat(join(root, "runtime", "lock"))).mode & 0o777, 0o700);
});

test("RuntimeStore rejects orphan merge and provider-call relationships without committing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-relationships-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storageRoot = root;
  const store = new RuntimeStore({ workDir: root, storageRoot });
  store.createJob({
    jobId: "existing-job",
    type: "test",
    executionClass: "recoverable",
    completionPolicy: "detached",
    description: "existing",
  });
  const statePath = join(storageRoot, "control/state.json");
  const before = await readFile(statePath, "utf8");

  assert.throws(
    () =>
      store.createMergeRequest({
        mergeRequestId: "orphan-merge",
        jobId: "missing-job",
        sourceBranch: "source",
        sourceWorktree: root,
        targetBranch: "main",
        targetWorktree: root,
        status: "queued",
      }),
    /未知任务/u,
  );
  assert.throws(
    () =>
      store.createMergeRequest({
        mergeRequestId: "orphan-attempt-merge",
        jobId: "existing-job",
        attemptId: "missing-attempt",
        sourceBranch: "source",
        sourceWorktree: root,
        targetBranch: "main",
        targetWorktree: root,
        status: "queued",
      }),
    /未知 attempt/u,
  );
  const usage = {
    purpose: "main" as const,
    provider: "test",
    model: "test",
    status: "succeeded" as const,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  };
  assert.throws(
    () => store.recordProviderCall({ callId: "orphan-job-call", jobId: "missing-job", ...usage }),
    /未知任务/u,
  );
  assert.throws(
    () =>
      store.recordProviderCall({
        callId: "orphan-attempt-call",
        attemptId: "missing-attempt",
        ...usage,
      }),
    /未知 attempt/u,
  );

  assert.equal(await readFile(statePath, "utf8"), before);
  assert.equal(store.listMergeRequests().length, 0);
  assert.equal(store.listProviderCalls().length, 0);
  new RuntimeStore({ workDir: root, storageRoot }).close();
});

test("RuntimeStore joins nested stores into one transaction and rolls the draft back", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-nested-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storageRoot = root;
  const store = new RuntimeStore({ workDir: root, storageRoot });

  const result = store.executeIdempotentDaemonCommand(
    { commandType: "job.create", idempotencyKey: "request-1", request: { description: "one" } },
    () => {
      const nested = new RuntimeStore({ workDir: root, storageRoot });
      nested.createJob({
        jobId: "nested-job",
        type: "test",
        executionClass: "recoverable",
        completionPolicy: "detached",
        description: "nested",
      });
      return { result: { jobId: "nested-job" }, resourceId: "nested-job" };
    },
  );
  assert.equal(result.replayed, false);
  assert.equal(store.getJob("nested-job")?.status, "queued");
  assert.equal(
    store.executeIdempotentDaemonCommand(
      { commandType: "job.create", idempotencyKey: "request-1", request: { description: "one" } },
      () => {
        throw new Error("must not replay callback");
      },
    ).replayed,
    true,
  );

  store.appendRuntimeEvent({
    eventId: "duplicate",
    topic: "run.started",
    workspacePath: root,
  });
  assert.throws(() =>
    store.appendRuntimeEvent(
      { eventId: "duplicate", topic: "run.failed", workspacePath: root },
      {
        daemonRun: {
          runId: "rolled-back-run",
          workspacePath: root,
          description: "must roll back",
          status: "failed",
          startedAt: 1,
          updatedAt: 2,
          finishedAt: 2,
          version: 1,
        },
      },
    ),
  );
  assert.equal(store.getDaemonRun(root, "rolled-back-run"), undefined);
  assert.equal(store.listRuntimeEvents().length, 1);

  store.executeIdempotentDaemonCommand(
    { commandType: "run.wrap", idempotencyKey: "request-2", request: {} },
    () => {
      const nested = new RuntimeStore({ workDir: root, storageRoot });
      assert.throws(() =>
        nested.appendRuntimeEvent(
          { eventId: "duplicate", topic: "run.failed", workspacePath: root },
          {
            daemonRun: {
              runId: "nested-rolled-back-run",
              workspacePath: root,
              description: "nested savepoint",
              status: "failed",
              startedAt: 1,
              updatedAt: 2,
              finishedAt: 2,
              version: 1,
            },
          },
        ),
      );
      return { result: { caught: true } };
    },
  );
  assert.equal(store.getDaemonRun(root, "nested-rolled-back-run"), undefined);
});

test("RuntimeStore canonicalizes case aliases before joining a nested transaction", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-alias-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = join(root, "State");
  const aliasRoot = join(root, "state");
  const store = new RuntimeStore({ workDir: root, storageRoot: canonicalRoot });
  let aliasMetadata;
  try {
    aliasMetadata = await stat(aliasRoot);
  } catch {
    context.skip("filesystem is case-sensitive");
    return;
  }
  const canonicalMetadata = await stat(canonicalRoot);
  if (aliasMetadata.dev !== canonicalMetadata.dev || aliasMetadata.ino !== canonicalMetadata.ino) {
    context.skip("paths do not identify the same physical directory");
    return;
  }

  store.executeIdempotentDaemonCommand(
    { commandType: "job.create", idempotencyKey: "alias-request", request: {} },
    () => {
      const nested = new RuntimeStore({ workDir: root, storageRoot: aliasRoot });
      nested.createJob({
        jobId: "alias-job",
        type: "test",
        executionClass: "recoverable",
        completionPolicy: "detached",
        description: "physical alias",
      });
      return { result: { jobId: "alias-job" }, resourceId: "alias-job" };
    },
  );

  assert.equal(store.getJob("alias-job")?.status, "queued");
});

test("RuntimeStore recovers an EventStore Session marker from the shared workspace coordinator", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-cross-store-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const eventStore = new RuntimeEventStore({ storageRoot: root });
  const sessionId = "cross-store-session";
  await eventStore.initializeSession({ sessionId, workDir: root });
  const event: RuntimeEvent = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: "cross-store-event",
    sessionId,
    invocationId: "cross-store-invocation",
    runId: "cross-store-run",
    turnId: "cross-store-turn",
    kind: "run.started",
    at: "2026-07-26T00:00:00.000Z",
    partial: false,
    visibility: "internal",
    data: { workDir: root },
  };
  const transactionId = "cross-store-recovery-transaction";
  const batch = {
    type: "event-batch",
    schemaVersion: 1,
    txId: transactionId,
    committedAt: event.at,
    activeBranchId: "main",
    entries: [{ sequence: 1, committedAt: event.at, event }],
  };
  const sessionDigest = createHash("sha256").update(sessionId).digest("hex");

  assert.throws(
    () =>
      withFileLockSync(
        join(root, WORKSPACE_STORAGE_LOCK_DIRECTORY),
        "cross-store-recovery-fixture",
        () =>
          commitFileTransactionSync(
            root,
            {
              appends: [
                {
                  relativePath: join("sessions", sessionDigest, "session.jsonl"),
                  content: `${JSON.stringify(batch)}\n`,
                },
              ],
            },
            {
              ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
              transactionId,
              onStage(stage) {
                if (stage === "commit-published") throw new Error("injected EventStore crash");
              },
            },
          ),
      ),
    /injected EventStore crash/u,
  );
  assert.match(
    await readFile(join(root, WORKSPACE_STORAGE_COMMIT_FILE), "utf8"),
    new RegExp(transactionId, "u"),
  );

  const runtimeStore = new RuntimeStore({ workDir: root, storageRoot: root });
  runtimeStore.close();

  await assert.rejects(stat(join(root, WORKSPACE_STORAGE_COMMIT_FILE)), { code: "ENOENT" });
  assert.deepEqual(
    (await eventStore.readSession(sessionId)).map(({ eventId }) => eventId),
    [event.eventId],
  );
});

test("RuntimeStore serializes writers from separate processes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-processes-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storageRoot = root;
  const modulePath = new URL("../../src/tasks/runtime-store.ts", import.meta.url).href;
  const source = `
    import { RuntimeStore } from ${JSON.stringify(modulePath)};
    const store = new RuntimeStore({ workDir: process.env.ROOT, storageRoot: process.env.STORAGE_ROOT });
    store.createJob({
      jobId: process.env.JOB_ID,
      type: "test",
      executionClass: "recoverable",
      completionPolicy: "detached",
      description: process.env.JOB_ID,
    });
  `;
  await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      runChild(source, {
        ROOT: root,
        STORAGE_ROOT: storageRoot,
        JOB_ID: `process-job-${index}`,
      }),
    ),
  );
  const store = new RuntimeStore({ workDir: root, storageRoot });
  assert.deepEqual(
    store
      .listJobs()
      .map((job) => job.jobId)
      .sort(),
    ["process-job-0", "process-job-1", "process-job-2", "process-job-3"],
  );
});

test("RuntimeStore incrementally refreshes and safely rebuilds its disposable index", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-index-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storageRoot = root;
  const store = new RuntimeStore({ workDir: root, storageRoot });
  store.appendRuntimeEvent({
    eventId: "event-1",
    topic: "run.started",
    workspacePath: root,
  });
  const call = {
    purpose: "main" as const,
    provider: "test",
    model: "test",
    status: "succeeded" as const,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  };
  store.recordProviderCall({ callId: "call-1", ...call });
  assert.deepEqual(
    store.listRuntimeEvents().map((event) => event.eventId),
    ["event-1"],
  );
  assert.deepEqual(
    store.listProviderCalls().map((record) => record.callId),
    ["call-1"],
  );
  const before = inspectRuntimeStoreIndexForTesting(storageRoot);
  assert.ok(before);

  const modulePath = new URL("../../src/tasks/runtime-store.ts", import.meta.url).href;
  await runChild(
    `
      import { RuntimeStore } from ${JSON.stringify(modulePath)};
      const store = new RuntimeStore({
        workDir: process.env.ROOT,
        storageRoot: process.env.STORAGE_ROOT,
      });
      store.appendRuntimeEvent({
        eventId: "event-2",
        topic: "run.finished",
        workspacePath: process.env.ROOT,
      });
      store.recordProviderCall({
        callId: "call-2",
        purpose: "main",
        provider: "test",
        model: "test",
        status: "succeeded",
        inputTokens: 2,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
      });
    `,
    { ROOT: root, STORAGE_ROOT: storageRoot },
  );

  assert.deepEqual(
    store.listRuntimeEvents().map((event) => event.eventId),
    ["event-1", "event-2"],
  );
  assert.deepEqual(
    store.listProviderCalls().map((record) => record.callId),
    ["call-1", "call-2"],
  );
  const incrementallyRefreshed = inspectRuntimeStoreIndexForTesting(storageRoot);
  assert.ok(incrementallyRefreshed);
  assert.equal(incrementallyRefreshed.fullRebuildCount, before.fullRebuildCount);
  assert.equal(incrementallyRefreshed.incrementalRefreshCount, before.incrementalRefreshCount + 1);
  assert.equal(
    store.recordProviderCall({
      callId: "call-2",
      ...call,
      inputTokens: 2,
      outputTokens: 2,
    }).inserted,
    false,
  );

  const usagePath = join(storageRoot, "control/usage-ledger.jsonl");
  const firstUsageLine = (await readFile(usagePath, "utf8")).split("\n")[0]!;
  await truncate(usagePath, Buffer.byteLength(`${firstUsageLine}\n`));
  assert.deepEqual(
    store.listProviderCalls().map((record) => record.callId),
    ["call-1"],
  );
  const rebuilt = inspectRuntimeStoreIndexForTesting(storageRoot);
  assert.ok(rebuilt);
  assert.equal(rebuilt.fullRebuildCount, incrementallyRefreshed.fullRebuildCount + 1);
  assert.equal(store.recordProviderCall({ callId: "call-1", ...call }).inserted, false);
});

function runChild(source: string, environment: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...environment },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`RuntimeStore child exited ${code}: ${stderr}`));
    });
  });
}
