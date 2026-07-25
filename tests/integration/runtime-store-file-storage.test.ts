import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { RuntimeStore } from "../../src/tasks/runtime-store.js";

test("RuntimeStore commits job state and replay ledgers without SQLite", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const store = new RuntimeStore({
    workDir: root,
    storageRoot: join(root, "runtime"),
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

  const reopened = new RuntimeStore({ workDir: root, storageRoot: join(root, "runtime") });
  assert.equal(reopened.getJob("job-1")?.status, "succeeded");
  assert.equal(reopened.listPendingCompletions()[0]?.completionId, "completion-1");
  assert.deepEqual(
    reopened.listRuntimeEvents().map((event) => event.eventId),
    ["event-1"],
  );
  assert.equal(reopened.getUsageSummary().total.inputTokens, 2);
  assert.equal(reopened.getUsageSummary().total.outputTokens, 3);

  const state = await readFile(join(root, "runtime/control/state.json"), "utf8");
  const events = await readFile(join(root, "runtime/control/daemon-events.jsonl"), "utf8");
  const usage = await readFile(join(root, "runtime/control/usage-ledger.jsonl"), "utf8");
  assert.match(state, /"schemaVersion": 1/u);
  assert.match(events, /"sequence":1/u);
  assert.match(usage, /"type":"provider-call"/u);
});

test("RuntimeStore joins nested stores into one transaction and rolls the draft back", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-nested-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storageRoot = join(root, "runtime");
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

test("RuntimeStore serializes writers from separate processes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-processes-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storageRoot = join(root, "runtime");
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
