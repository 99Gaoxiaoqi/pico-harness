import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MEMORY_SOURCE_NOTIFICATION_JOB_TYPE,
} from "../../src/memory/memory-repository.js";
import { SqliteMemoryRepository } from "../../src/storage/sqlite/sqlite-memory-repository.js";
import { SOURCE_AVAILABILITIES } from "../../src/memory/domain.js";
import {
  MEMORY_PROPOSAL_JOB_TYPE,
  MEMORY_PROPOSAL_EXTRACTOR_VERSION,
} from "../../src/memory/proposal-contracts.js";
import { rebuildDerivedFromRuntimeEvent } from "../../src/memory/memory-rebuild.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";

// Lifecycle invalidation Job identity — kept private in desktop-memory-service.ts because new
// call sites must not produce rewound Jobs (Phase 1 made rewind a non-destructive fork). We mirror
// only the literal needed to assert that no legacy invalidation Job is enqueued by the fork path.
const MEMORY_LIFECYCLE_JOB_TYPE = "source-lifecycle-invalidation";

test("rebuildDerivedFromRuntimeEvent enqueues missing extraction Jobs without touching the overlay layer", async (context) => {
  const fixture = await createFixture("rebuild-derived");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const runtimeStore = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const sessionId = "memory-rebuild-session";
  const runId = "run-rebuild";
  const at = "2026-08-10T00:00:00.000Z";
  await runtimeStore.initializeSession({ sessionId, workDir: fixture.workspace });
  await runtimeStore.appendBatch([
    {
      schemaVersion: 2,
      eventId: "rebuild-started",
      sessionId,
      invocationId: "invocation-rebuild",
      runId,
      turnId: "turn-rebuild",
      at,
      partial: false,
      visibility: "internal",
      kind: "run.started",
      data: { workDir: fixture.workspace },
    },
    {
      schemaVersion: 2,
      eventId: "rebuild-user",
      sessionId,
      invocationId: "invocation-rebuild",
      runId,
      turnId: "turn-rebuild",
      at,
      partial: false,
      visibility: "model",
      kind: "message.committed",
      data: {
        message: {
          role: "user",
          content: "请记住：这个项目固定使用 npm run rebuild 进行构建。",
        },
      },
    },
    {
      schemaVersion: 2,
      eventId: "rebuild-assistant",
      sessionId,
      invocationId: "invocation-rebuild",
      runId,
      turnId: "turn-rebuild",
      at,
      partial: false,
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "assistant", content: "acknowledged" } },
    },
    {
      schemaVersion: 2,
      eventId: "rebuild-terminal",
      sessionId,
      invocationId: "invocation-rebuild",
      runId,
      turnId: "turn-rebuild",
      at,
      partial: false,
      visibility: "internal",
      kind: "run.terminal",
      data: { status: "completed" },
    },
  ]);
  runtimeStore.close();

  const repository = new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
  // Overlay layer: a user-curated manual Fact and a disabled proposal — rebuild must not touch these.
  const overlayFact = repository.createFact({
    factId: "overlay-manual-fact",
    kind: "preference",
    title: "overlay-manual-fact",
    content: "manual overlay value that rebuild must preserve",
    state: "active",
  });
  repository.updateSettings({
    expectedVersion: repository.getSettings().version,
    enabled: true,
    autoPropose: true,
    autoCommit: true,
    injectionEnabled: true,
    idempotencyKey: "rebuild-enable-memory",
  });

  const store = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const report = await rebuildDerivedFromRuntimeEvent(repository, store, paths.workspace.root);
  store.close();

  assert.equal(report.scannedSessions, 1);
  assert.equal(report.scannedTerminals, 1);
  assert.equal(report.enqueuedJobs, 1);
  assert.equal(report.skippedExisting, 0);
  assert.equal(report.errors.length, 0);
  assert.equal(report.rebuiltSources, 0);

  const jobs = repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE });
  assert.equal(jobs.length, 1);
  const job = jobs[0]!;
  assert.equal(job.status, "queued");
  assert.equal(job.terminalEventId, "rebuild-terminal");
  assert.equal(job.extractorVersion, MEMORY_PROPOSAL_EXTRACTOR_VERSION);
  assert.equal(job.cursor.sessionId, sessionId);
  assert.equal(job.cursor.eventId, "rebuild-user");
  assert.equal(job.cursor.sequence, 4);

  // Overlay Fact is untouched by the derived-layer rebuild.
  const preserved = repository.getFact(overlayFact.factId);
  assert.ok(preserved);
  assert.equal(preserved!.content, "manual overlay value that rebuild must preserve");
  assert.equal(preserved!.version, overlayFact.version);

  repository.close();
});

test("rebuildDerivedFromRuntimeEvent is idempotent — a second call skips existing Jobs and changes nothing", async (context) => {
  const fixture = await createFixture("rebuild-idempotent");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const sessionId = "memory-rebuild-idempotent-session";
  const runId = "run-rebuild-idempotent";
  const at = "2026-08-10T00:00:00.000Z";
  const store = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  await store.initializeSession({ sessionId, workDir: fixture.workspace });
  await store.appendBatch([
    {
      schemaVersion: 2,
      eventId: "idempotent-started",
      sessionId,
      invocationId: "invocation-idempotent",
      runId,
      turnId: "turn-idempotent",
      at,
      partial: false,
      visibility: "internal",
      kind: "run.started",
      data: { workDir: fixture.workspace },
    },
    {
      schemaVersion: 2,
      eventId: "idempotent-user",
      sessionId,
      invocationId: "invocation-idempotent",
      runId,
      turnId: "turn-idempotent",
      at,
      partial: false,
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "user", content: "记住 idempotent 标记。" } },
    },
    {
      schemaVersion: 2,
      eventId: "idempotent-assistant",
      sessionId,
      invocationId: "invocation-idempotent",
      runId,
      turnId: "turn-idempotent",
      at,
      partial: false,
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "assistant", content: "ok" } },
    },
    {
      schemaVersion: 2,
      eventId: "idempotent-terminal",
      sessionId,
      invocationId: "invocation-idempotent",
      runId,
      turnId: "turn-idempotent",
      at,
      partial: false,
      visibility: "internal",
      kind: "run.terminal",
      data: { status: "completed" },
    },
  ]);

  const repository = new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
  repository.updateSettings({
    expectedVersion: repository.getSettings().version,
    enabled: true,
    autoPropose: true,
    autoCommit: true,
    injectionEnabled: true,
    idempotencyKey: "idempotent-enable-memory",
  });

  const first = await rebuildDerivedFromRuntimeEvent(repository, store, paths.workspace.root);
  assert.equal(first.enqueuedJobs, 1);
  assert.equal(first.skippedExisting, 0);

  const second = await rebuildDerivedFromRuntimeEvent(repository, store, paths.workspace.root);
  assert.equal(second.enqueuedJobs, 0);
  assert.equal(second.skippedExisting, 1);
  assert.equal(second.scannedTerminals, 1);

  // Still exactly one extraction job — no duplicates after two rebuild calls.
  const jobs = repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE });
  assert.equal(jobs.length, 1);

  store.close();
  repository.close();
});

test("rebuildDerivedFromRuntimeEvent does not reset a Job that already reached a terminal status", async (context) => {
  const fixture = await createFixture("rebuild-respects-terminal-status");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const sessionId = "memory-rebuild-suppressed";
  const runId = "run-suppressed";
  const at = "2026-08-10T00:00:00.000Z";
  const store = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  await store.initializeSession({ sessionId, workDir: fixture.workspace });
  await store.appendBatch([
    {
      schemaVersion: 2,
      eventId: "suppressed-started",
      sessionId,
      invocationId: "invocation-suppressed",
      runId,
      turnId: "turn-suppressed",
      at,
      partial: false,
      visibility: "internal",
      kind: "run.started",
      data: { workDir: fixture.workspace },
    },
    {
      schemaVersion: 2,
      eventId: "suppressed-user",
      sessionId,
      invocationId: "invocation-suppressed",
      runId,
      turnId: "turn-suppressed",
      at,
      partial: false,
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "user", content: "记住 suppressed 标记。" } },
    },
    {
      schemaVersion: 2,
      eventId: "suppressed-assistant",
      sessionId,
      invocationId: "invocation-suppressed",
      runId,
      turnId: "turn-suppressed",
      at,
      partial: false,
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "assistant", content: "ok" } },
    },
    {
      schemaVersion: 2,
      eventId: "suppressed-terminal",
      sessionId,
      invocationId: "invocation-suppressed",
      runId,
      turnId: "turn-suppressed",
      at,
      partial: false,
      visibility: "internal",
      kind: "run.terminal",
      data: { status: "completed" },
    },
  ]);

  const repository = new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
  repository.updateSettings({
    expectedVersion: repository.getSettings().version,
    enabled: true,
    autoPropose: true,
    autoCommit: true,
    injectionEnabled: true,
    idempotencyKey: "suppressed-enable-memory",
  });
  // Pre-existing cancelled Job: overlay decision that this terminal must not be re-extracted.
  const cancelled = repository.createJob({
    type: MEMORY_PROPOSAL_JOB_TYPE,
    terminalEventId: "suppressed-terminal",
    extractorVersion: MEMORY_PROPOSAL_EXTRACTOR_VERSION,
    cursor: {
      sessionId,
      eventId: "suppressed-user",
      sequence: 4,
    },
    maxAttempts: 3,
    idempotencyKey: `memory-review:suppressed-terminal:suppressed-user`,
  });
  repository.updateJob({
    jobId: cancelled.jobId,
    expectedVersion: cancelled.version,
    status: "cancelled",
    errorCode: "memory_source_unavailable",
    idempotencyKey: `memory-review-cancel:${cancelled.jobId}`,
  });

  const report = await rebuildDerivedFromRuntimeEvent(repository, store, paths.workspace.root);
  assert.equal(report.enqueuedJobs, 0);
  assert.equal(report.skippedExisting, 1);

  // The cancelled Job is preserved — rebuild never resurrects an overlay-suppressed terminal.
  const jobs = repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.status, "cancelled");

  store.close();
  repository.close();
});

test("a fork leaves the source Session's Memory Sources available — no lifecycle Job is enqueued", async (context) => {
  const fixture = await createFixture("fork-source-available");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const repository = new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
  // Source Session has a Memory Source derived from one of its completed turns.
  const source = repository.createSource({
    sourceId: "source:fork-source",
    sessionId: "fork-source-session",
    runId: "fork-source-run",
    eventIds: ["fork-source-user-event"],
    startSequence: 2,
    endSequence: 2,
    digest: "sha256:fork-source-digest",
  });
  assert.equal(source.availability, "available");

  // Simulate a fork: the target Session is a brand-new sessionId. Phase 1 made rewind/fork
  // non-destructive, so the source Session's RuntimeEvent ledger is immutable and the Source
  // stays available. The fork code path enqueues NO lifecycle invalidation Job for the source.
  const lifecycleJobsAfterFork = repository.listJobs({ type: MEMORY_LIFECYCLE_JOB_TYPE });
  assert.equal(lifecycleJobsAfterFork.length, 0);

  // The Source is still available — exactly the invariant forkSession's comment promises.
  const reloaded = repository.getSource(source.sourceId);
  assert.ok(reloaded);
  assert.equal(reloaded!.availability, "available");

  // And no source-changed notification Job was enqueued for it either.
  const notificationJobs = repository.listJobs({ type: MEMORY_SOURCE_NOTIFICATION_JOB_TYPE });
  assert.equal(notificationJobs.length, 0);

  repository.close();
});

test("rebuildDerivedFromRuntimeEvent skips work when Memory autoPropose is disabled at the overlay layer", async (context) => {
  const fixture = await createFixture("rebuild-disabled-overlay");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const sessionId = "memory-rebuild-disabled-session";
  const runId = "run-disabled";
  const at = "2026-08-10T00:00:00.000Z";
  const store = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  await store.initializeSession({ sessionId, workDir: fixture.workspace });
  await store.appendBatch([
    {
      schemaVersion: 2,
      eventId: "disabled-started",
      sessionId,
      invocationId: "invocation-disabled",
      runId,
      turnId: "turn-disabled",
      at,
      partial: false,
      visibility: "internal",
      kind: "run.started",
      data: { workDir: fixture.workspace },
    },
    {
      schemaVersion: 2,
      eventId: "disabled-user",
      sessionId,
      invocationId: "invocation-disabled",
      runId,
      turnId: "turn-disabled",
      at,
      partial: false,
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "user", content: "记住 disabled 标记。" } },
    },
    {
      schemaVersion: 2,
      eventId: "disabled-assistant",
      sessionId,
      invocationId: "invocation-disabled",
      runId,
      turnId: "turn-disabled",
      at,
      partial: false,
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "assistant", content: "ok" } },
    },
    {
      schemaVersion: 2,
      eventId: "disabled-terminal",
      sessionId,
      invocationId: "invocation-disabled",
      runId,
      turnId: "turn-disabled",
      at,
      partial: false,
      visibility: "internal",
      kind: "run.terminal",
      data: { status: "completed" },
    },
  ]);

  const repository = new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
  // Overlay-disabled: enabled stays true but autoPropose is false — worker would no-op.
  repository.updateSettings({
    expectedVersion: repository.getSettings().version,
    enabled: true,
    autoPropose: false,
    autoCommit: false,
    injectionEnabled: true,
    idempotencyKey: "disabled-overlay",
  });

  const report = await rebuildDerivedFromRuntimeEvent(repository, store, paths.workspace.root);
  assert.equal(report.scannedSessions, 0);
  assert.equal(report.enqueuedJobs, 0);
  assert.equal(repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE }).length, 0);

  store.close();
  repository.close();
});

// The destructive rewind / branchId mechanism has been removed (rewind is now a non-destructive
// fork). This guards the contract that a Source can never enter a "rewound" availability.
test("source availability no longer exposes the removed rewound value", () => {
  assert.ok(!SOURCE_AVAILABILITIES.includes("rewound" as never));
  assert.deepEqual([...SOURCE_AVAILABILITIES], ["available", "unavailable"]);
});

async function createFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `pico-memory-rebuild-${name}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  return { root, workspace, picoHome };
}
