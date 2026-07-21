import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import {
  MEMORY_PROPOSAL_EXTRACTOR_VERSION,
  MEMORY_PROPOSAL_JOB_TYPE,
} from "../../src/memory/proposal-contracts.js";
import {
  MEMORY_REVIEW_DEBOUNCE_MS,
  MEMORY_REVIEW_PENDING_LIMIT,
  MemoryReviewScheduler,
} from "../../src/memory/runtime-scheduler.js";
import { resolvePicoPaths, type WorkspaceId } from "../../src/paths/pico-paths.js";

test("memory review enqueue applies the durable workspace debounce", async (context) => {
  const fixture = await createFixture("enqueue-debounce");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  let now = new Date("2026-07-22T00:00:00.000Z");
  const repository = new MemoryRepository({
    databasePath: fixture.databasePath,
    workspaceId: fixture.workspaceId,
    now: () => now,
  });
  context.after(() => repository.close());
  const scheduler = new MemoryReviewScheduler(repository, { now: () => now });
  scheduler.enqueue({
    sessionId: "debounce-session",
    runId: "debounce-run",
    terminalEventId: "debounce-terminal",
    userMessageEventId: "debounce-user",
  });
  assert.deepEqual(scheduler.pending(), []);
  now = new Date(now.getTime() + MEMORY_REVIEW_DEBOUNCE_MS - 1);
  assert.deepEqual(scheduler.pending(), []);
  now = new Date(now.getTime() + 1);
  assert.equal(scheduler.pending()[0]?.terminalEventId, "debounce-terminal");
});

test("memory review scheduling is due-aware, oldest-first and type isolated", async (context) => {
  const fixture = await createFixture("due-order");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  let now = new Date("2026-07-22T00:00:00.000Z");
  const repository = new MemoryRepository({
    databasePath: fixture.databasePath,
    workspaceId: fixture.workspaceId,
    now: () => now,
  });
  context.after(() => repository.close());

  const oldest = createExtractionJob(repository, "oldest");
  now = new Date("2026-07-22T00:00:01.000Z");
  const failed = createExtractionJob(repository, "failed");
  repository.updateJob({
    jobId: failed.jobId,
    expectedVersion: failed.version,
    status: "failed",
    attemptCount: 1,
  });
  now = new Date("2026-07-22T00:00:02.000Z");
  const future = createExtractionJob(repository, "future", {
    nextAttemptAt: "2026-07-22T00:10:00.000Z",
  });
  const exhausted = createExtractionJob(repository, "exhausted");
  repository.updateJob({
    jobId: exhausted.jobId,
    expectedVersion: exhausted.version,
    status: "failed",
    attemptCount: exhausted.maxAttempts,
  });
  repository.createJob({
    jobId: "notification-job",
    type: "proposal-notification",
    terminalEventId: "notification-terminal",
    extractorVersion: MEMORY_PROPOSAL_EXTRACTOR_VERSION,
    cursor: { sessionId: "notification-session", eventId: "notification-event" },
  });
  repository.createJob({
    jobId: "lifecycle-job",
    type: "source-lifecycle-invalidation",
    terminalEventId: "lifecycle-terminal",
    extractorVersion: MEMORY_PROPOSAL_EXTRACTOR_VERSION,
    cursor: { sessionId: "lifecycle-session", eventId: "lifecycle-event" },
  });

  const scheduler = new MemoryReviewScheduler(repository, { now: () => now });
  assert.deepEqual(
    scheduler.pending().map((job) => job.jobId),
    [oldest.jobId, failed.jobId],
    "failed jobs remain retryable, while future, exhausted and non-extraction jobs stay out",
  );

  now = new Date("2026-07-22T00:10:00.000Z");
  assert.deepEqual(
    scheduler.pending().map((job) => job.jobId),
    [oldest.jobId, failed.jobId, future.jobId],
    "a deferred job becomes eligible exactly at nextAttemptAt",
  );
});

test("memory review scheduling fairly pages an oldest-first backlog of more than 500 jobs", async (context) => {
  const fixture = await createFixture("backlog");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  let tick = 0;
  const epoch = Date.parse("2026-07-22T01:00:00.000Z");
  const repository = new MemoryRepository({
    databasePath: fixture.databasePath,
    workspaceId: fixture.workspaceId,
    now: () => new Date(epoch + tick++),
  });
  context.after(() => repository.close());

  for (let index = 0; index < MEMORY_REVIEW_PENDING_LIMIT + 2; index++) {
    createExtractionJob(repository, String(index).padStart(3, "0"));
  }
  const scheduler = new MemoryReviewScheduler(repository, {
    now: () => new Date(epoch + 10_000),
  });
  const firstPage = scheduler.pending();
  assert.equal(firstPage.length, MEMORY_REVIEW_PENDING_LIMIT);
  assert.equal(firstPage[0]?.jobId, "extraction-000");
  assert.equal(firstPage.at(-1)?.jobId, "extraction-499");

  for (const job of firstPage) {
    repository.updateJob({
      jobId: job.jobId,
      expectedVersion: job.version,
      status: "succeeded",
    });
  }
  assert.deepEqual(
    scheduler.pending().map((job) => job.jobId),
    ["extraction-500", "extraction-501"],
    "newer jobs make progress after the oldest page completes",
  );
});

function createExtractionJob(
  repository: MemoryRepository,
  suffix: string,
  options: { readonly nextAttemptAt?: string } = {},
) {
  return repository.createJob({
    jobId: `extraction-${suffix}`,
    type: MEMORY_PROPOSAL_JOB_TYPE,
    terminalEventId: `terminal-${suffix}`,
    extractorVersion: MEMORY_PROPOSAL_EXTRACTOR_VERSION,
    cursor: { sessionId: `session-${suffix}`, eventId: `event-${suffix}` },
    ...(options.nextAttemptAt ? { nextAttemptAt: options.nextAttemptAt } : {}),
  });
}

async function createFixture(name: string): Promise<{
  readonly root: string;
  readonly databasePath: string;
  readonly workspaceId: WorkspaceId;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-memory-scheduler-${name}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  const paths = resolvePicoPaths(workspace, { picoHome });
  return {
    root,
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  };
}
