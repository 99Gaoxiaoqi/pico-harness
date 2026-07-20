import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  MemoryConflictError,
  MemoryIdempotencyConflictError,
  MemoryAsyncTransactionError,
  MemoryRepository,
  MemorySecureDeletePendingError,
} from "../../src/memory/memory-repository.js";
import {
  MEMORY_SCHEMA_CURRENT_MIGRATION_NAME,
  MEMORY_SCHEMA_VERSION,
  MemorySchemaVersionError,
  MemoryWorkspaceMismatchError,
} from "../../src/memory/memory-schema.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";

test("memory foundation persists workspace facts, reviews and jobs across restart", async (context) => {
  const fixture = await createFixture("restart");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  assert.equal(paths.workspace.memoryDatabase, join(paths.workspace.memory, "memory.sqlite"));
  const now = () => new Date("2026-07-20T12:00:00.000Z");
  const repository = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
    now,
  });

  assert.deepEqual(repository.getSettings(), {
    workspaceId: paths.workspace.id,
    enabled: true,
    autoPropose: true,
    autoCommit: false,
    injectionEnabled: true,
    version: 1,
    updatedAt: now().toISOString(),
  });
  const settings = repository.updateSettings({
    expectedVersion: 1,
    autoCommit: true,
  });
  assert.equal(settings.version, 2);

  const source = repository.createSource({
    sourceId: "source-1",
    sessionId: "session-1",
    runId: "run-1",
    branchId: "main",
    eventIds: ["event-1", "event-2"],
    startSequence: 10,
    endSequence: 11,
    digest: "sha256:source",
  });
  assert.equal(source.availability, "available");

  const proposal = repository.createProposal({
    proposalId: "proposal-1",
    kind: "project_fact",
    title: "Build command",
    content: "Use npm run build",
    reason: "The user stated the canonical build command",
    confidence: 0.9,
    sourceId: source.sourceId,
    conflictStatus: "none",
  });
  const resolved = repository.resolveProposal({
    proposalId: proposal.proposalId,
    expectedVersion: proposal.version,
    resolution: "accepted",
    factId: "fact-from-review",
  });
  assert.equal(resolved.proposal.status, "accepted");
  assert.equal(resolved.fact?.content, "Use npm run build");

  const job = repository.createJob({
    type: "terminal-extraction",
    terminalEventId: "terminal-1",
    extractorVersion: "extractor-v1",
    cursor: { sessionId: "session-1", sequence: 11, eventId: "event-2" },
    sourceId: source.sourceId,
    maxAttempts: 4,
  });
  const duplicateJob = repository.createJob({
    type: "terminal-extraction",
    terminalEventId: "terminal-1",
    extractorVersion: "extractor-v1",
    cursor: { sessionId: "session-1", sequence: 11, eventId: "event-2" },
    sourceId: source.sourceId,
    maxAttempts: 4,
  });
  assert.equal(duplicateJob.jobId, job.jobId, "terminal event + extractor is idempotent");
  const mutationsBeforeJobUpdate = repository.listMutations().length;
  const updatedJob = repository.updateJob({
    jobId: job.jobId,
    expectedVersion: job.version,
    sourceId: null,
    maxAttempts: 8,
    nextAttemptAt: "2026-07-21T00:00:00.000Z",
  });
  const replayAfterMutableUpdate = repository.createJob({
    type: "terminal-extraction",
    terminalEventId: "terminal-1",
    extractorVersion: "extractor-v1",
    cursor: { sessionId: "session-1", sequence: 11, eventId: "event-2" },
    sourceId: source.sourceId,
    maxAttempts: 4,
  });
  assert.equal(replayAfterMutableUpdate.jobId, job.jobId);
  assert.equal(replayAfterMutableUpdate.version, updatedJob.version);
  assert.equal(replayAfterMutableUpdate.sourceId, undefined);
  assert.equal(replayAfterMutableUpdate.maxAttempts, 8);
  assert.equal(repository.listMutations().length, mutationsBeforeJobUpdate + 1);
  repository.close();

  const reopened = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
    now,
  });
  context.after(() => reopened.close());
  assert.equal(reopened.getSettings().enabled, true);
  assert.equal(reopened.getSettings().autoCommit, true);
  assert.equal(reopened.getFact("fact-from-review")?.sourceId, source.sourceId);
  assert.equal(reopened.getProposal("proposal-1")?.resolvedFactId, "fact-from-review");
  assert.equal(reopened.getJob(job.jobId)?.extractorVersion, "extractor-v1");
  assert.equal(reopened.listMutations().length, 7);

  const database = new Database(paths.workspace.memoryDatabase, {
    readonly: true,
    fileMustExist: true,
  });
  context.after(() => database.close());
  const migration = database
    .prepare("SELECT version, name FROM memory_schema_migrations ORDER BY version DESC LIMIT 1")
    .get() as { readonly version: number; readonly name: string };
  assert.deepEqual(migration, {
    version: MEMORY_SCHEMA_VERSION,
    name: MEMORY_SCHEMA_CURRENT_MIGRATION_NAME,
  });
});

test("memory writes are idempotent, CAS guarded and transactionally rolled back", async (context) => {
  const fixture = await createFixture("transactions");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const repository = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
  context.after(() => repository.close());

  const create = {
    kind: "preference" as const,
    title: "Language",
    content: "Reply in Chinese",
    idempotencyKey: "fact-create-1",
  };
  const first = repository.createFact(create);
  const replay = repository.createFact(create);
  assert.equal(replay.factId, first.factId);
  assert.equal(repository.listFacts().length, 1);
  assert.deepEqual(
    repository.listMutations({ entityType: "fact", entityId: first.factId }).length,
    1,
  );
  assert.throws(
    () => repository.createFact({ ...create, content: "Reply in English" }),
    MemoryIdempotencyConflictError,
  );

  const updated = repository.updateFact({
    factId: first.factId,
    expectedVersion: first.version,
    pinned: true,
  });
  assert.equal(updated.version, 2);
  assert.throws(
    () =>
      repository.updateFact({
        factId: first.factId,
        expectedVersion: first.version,
        pinned: false,
      }),
    MemoryConflictError,
  );
  assert.equal(repository.getFact(first.factId)?.pinned, true);

  const mutationCount = repository.listMutations().length;
  assert.throws(
    () =>
      repository.transaction((transaction) => {
        transaction.createFact({
          factId: "rolled-back-fact",
          kind: "reference",
          title: "Rollback",
          content: "This must not commit",
          idempotencyKey: "rolled-back-create",
        });
        throw new Error("force rollback");
      }),
    /force rollback/,
  );
  assert.equal(repository.getFact("rolled-back-fact"), undefined);
  assert.equal(repository.listMutations().length, mutationCount);
  const retried = repository.createFact({
    factId: "rolled-back-fact",
    kind: "reference",
    title: "Rollback",
    content: "This must not commit",
    idempotencyKey: "rolled-back-create",
  });
  assert.equal(retried.factId, "rolled-back-fact", "idempotency claim rolled back too");

  const mutationsBeforeAsync = repository.listMutations().length;
  const runAsyncTransaction = () => {
    // @ts-expect-error MemoryRepository transactions deliberately reject Promise-like results.
    return repository.transaction(async (transaction) => {
      transaction.createFact({
        factId: "async-rolled-back-fact",
        kind: "reference",
        title: "Async rollback",
        content: "Promise callbacks must not commit",
        idempotencyKey: "async-rolled-back-create",
      });
      return "not synchronous";
    });
  };
  assert.throws(runAsyncTransaction, MemoryAsyncTransactionError);
  assert.equal(repository.getFact("async-rolled-back-fact"), undefined);
  assert.equal(repository.listMutations().length, mutationsBeforeAsync);
});

test("memory authority is isolated by workspace and rejects a mismatched database", async (context) => {
  const fixture = await createFixture("isolation");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const workspaceB = join(fixture.root, "workspace-b");
  await mkdir(workspaceB);
  const pathsA = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const pathsB = resolvePicoPaths(workspaceB, { picoHome: fixture.picoHome });
  assert.notEqual(pathsA.workspace.id, pathsB.workspace.id);
  assert.notEqual(pathsA.workspace.memoryDatabase, pathsB.workspace.memoryDatabase);

  const repositoryA = new MemoryRepository({
    databasePath: pathsA.workspace.memoryDatabase,
    workspaceId: pathsA.workspace.id,
  });
  const repositoryB = new MemoryRepository({
    databasePath: pathsB.workspace.memoryDatabase,
    workspaceId: pathsB.workspace.id,
  });
  context.after(() => repositoryA.close());
  context.after(() => repositoryB.close());
  repositoryA.createFact({
    factId: "workspace-a-only",
    kind: "project_fact",
    title: "Workspace A",
    content: "Private to A",
  });
  assert.equal(repositoryA.listFacts().length, 1);
  assert.equal(repositoryB.listFacts().length, 0);
  assert.throws(
    () =>
      new MemoryRepository({
        databasePath: pathsA.workspace.memoryDatabase,
        workspaceId: pathsB.workspace.id,
      }),
    MemoryWorkspaceMismatchError,
  );

  const existingParent = join(fixture.root, "existing-database-parent");
  await mkdir(existingParent);
  await chmod(existingParent, 0o755);
  const modeBefore = (await stat(existingParent)).mode & 0o777;
  const arbitraryParentRepository = new MemoryRepository({
    databasePath: join(existingParent, "memory.sqlite"),
    workspaceId: pathsA.workspace.id,
  });
  arbitraryParentRepository.close();
  assert.equal((await stat(existingParent)).mode & 0o777, modeBefore);
});

test("memory migration rejects future schemas and rolls back failed initialization", async (context) => {
  const fixture = await createFixture("migration");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const futurePath = join(fixture.root, "future.sqlite");
  const future = new Database(futurePath);
  future.exec(
    `CREATE TABLE memory_schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     );
     INSERT INTO memory_schema_migrations VALUES (3, 'future_memory', '2026-07-20T00:00:00.000Z');`,
  );
  future.close();
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  assert.throws(
    () =>
      new MemoryRepository({
        databasePath: futurePath,
        workspaceId: paths.workspace.id,
      }),
    MemorySchemaVersionError,
  );
  const futureInspection = new Database(futurePath, { readonly: true, fileMustExist: true });
  assert.deepEqual(
    futureInspection.prepare("SELECT version, name FROM memory_schema_migrations").all(),
    [{ version: 3, name: "future_memory" }],
  );
  assert.deepEqual(
    futureInspection
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'")
      .get(),
    { count: 1 },
  );
  futureInspection.close();

  const rollbackPath = join(fixture.root, "rollback.sqlite");
  const rollback = new Database(rollbackPath);
  rollback.exec(
    `CREATE TABLE memory_schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     );
     CREATE TABLE memory_settings (sentinel TEXT NOT NULL);`,
  );
  rollback.close();
  assert.throws(() =>
    new MemoryRepository({
      databasePath: rollbackPath,
      workspaceId: paths.workspace.id,
    }).close(),
  );
  const rollbackInspection = new Database(rollbackPath, { readonly: true, fileMustExist: true });
  assert.deepEqual(
    rollbackInspection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all(),
    [{ name: "memory_schema_migrations" }, { name: "memory_settings" }],
  );
  assert.deepEqual(rollbackInspection.prepare("SELECT * FROM memory_schema_migrations").all(), []);
  rollbackInspection.close();

  const upgradePath = join(fixture.root, "upgrade-v1.sqlite");
  new MemoryRepository({
    databasePath: upgradePath,
    workspaceId: paths.workspace.id,
  }).close();
  const downgradeFixture = new Database(upgradePath);
  downgradeFixture.exec(
    `DROP TABLE memory_maintenance;
     DELETE FROM memory_schema_migrations WHERE version = 2;`,
  );
  downgradeFixture.close();
  const upgraded = new MemoryRepository({
    databasePath: upgradePath,
    workspaceId: paths.workspace.id,
  });
  assert.equal(readSecureDeletePending(upgradePath), 0);
  upgraded.close();
  const upgradeInspection = new Database(upgradePath, { readonly: true, fileMustExist: true });
  assert.deepEqual(
    upgradeInspection
      .prepare("SELECT version, name FROM memory_schema_migrations ORDER BY version")
      .all(),
    [
      { version: 1, name: "workspace_memory_foundation" },
      { version: 2, name: MEMORY_SCHEMA_CURRENT_MIGRATION_NAME },
    ],
  );
  upgradeInspection.close();
});

test("busy secure-delete checkpoints stay durable and retry without duplicate effects", async (context) => {
  const fixture = await createFixture("secure-delete-retry");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const repository = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
    busyTimeoutMs: 1,
  });
  context.after(() => {
    if (repositoryIsOpen(repository)) repository.close();
  });

  const retrySecret = "secure-delete-retry-secret-f83882";
  const retryFact = repository.createFact({
    factId: "secure-delete-retry-fact",
    kind: "reference",
    title: retrySecret,
    content: retrySecret,
  });
  const retryReader = holdFactReadSnapshot(
    paths.workspace.memoryDatabase,
    retryFact.factId,
    retrySecret,
  );
  assert.throws(
    () =>
      repository.forgetFact({
        factId: retryFact.factId,
        expectedVersion: retryFact.version,
        idempotencyKey: "secure-delete-retry",
      }),
    MemorySecureDeletePendingError,
  );
  assert.equal(readSecureDeletePending(paths.workspace.memoryDatabase), 1);
  assert.equal(repository.getFact(retryFact.factId)?.version, 2);
  assert.equal(repository.listMutations({ entityId: retryFact.factId }).length, 2);
  releaseReadSnapshot(retryReader);

  const replayedForget = repository.forgetFact({
    factId: retryFact.factId,
    expectedVersion: retryFact.version,
    idempotencyKey: "secure-delete-retry",
  });
  assert.equal(replayedForget.version, 2);
  assert.equal(replayedForget.state, "forgotten");
  assert.equal(repository.listMutations({ entityId: retryFact.factId }).length, 2);
  assert.equal(readSecureDeletePending(paths.workspace.memoryDatabase), 0);

  const nextWriteSecret = "secure-delete-next-write-secret-a615f4";
  const nextWriteFact = repository.createFact({
    factId: "secure-delete-next-write-fact",
    kind: "reference",
    title: nextWriteSecret,
    content: nextWriteSecret,
  });
  const nextWriteReader = holdFactReadSnapshot(
    paths.workspace.memoryDatabase,
    nextWriteFact.factId,
    nextWriteSecret,
  );
  assert.throws(
    () =>
      repository.forgetFact({
        factId: nextWriteFact.factId,
        expectedVersion: nextWriteFact.version,
        idempotencyKey: "secure-delete-next-write",
      }),
    MemorySecureDeletePendingError,
  );
  releaseReadSnapshot(nextWriteReader);
  const followingFact = repository.createFact({
    factId: "write-after-pending-checkpoint",
    kind: "project_fact",
    title: "Checkpoint completed",
    content: "A later write may proceed",
  });
  assert.equal(followingFact.version, 1);
  const nextWriteReplay = repository.forgetFact({
    factId: nextWriteFact.factId,
    expectedVersion: nextWriteFact.version,
    idempotencyKey: "secure-delete-next-write",
  });
  assert.equal(nextWriteReplay.version, 2);
  assert.equal(repository.listMutations({ entityId: nextWriteFact.factId }).length, 2);
  repository.close();

  for (const secret of [retrySecret, nextWriteSecret]) {
    for (const path of [
      paths.workspace.memoryDatabase,
      `${paths.workspace.memoryDatabase}-wal`,
      `${paths.workspace.memoryDatabase}-shm`,
    ]) {
      if (!existsSync(path)) continue;
      assert.equal((await readFile(path)).includes(Buffer.from(secret)), false);
    }
  }
});

test("close reports durable secure-delete pending state and restart completes it", async (context) => {
  const fixture = await createFixture("secure-delete-restart");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const repository = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
    busyTimeoutMs: 1,
  });
  const secret = "secure-delete-restart-secret-c31df7";
  const fact = repository.createFact({
    factId: "secure-delete-restart-fact",
    kind: "correction",
    title: secret,
    content: secret,
  });
  const reader = holdFactReadSnapshot(paths.workspace.memoryDatabase, fact.factId, secret);
  assert.throws(
    () =>
      repository.forgetFact({
        factId: fact.factId,
        expectedVersion: fact.version,
        idempotencyKey: "secure-delete-restart",
      }),
    MemorySecureDeletePendingError,
  );
  assert.throws(() => repository.close(), MemorySecureDeletePendingError);
  assert.equal(readSecureDeletePending(paths.workspace.memoryDatabase), 1);
  releaseReadSnapshot(reader);

  const reopened = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
    busyTimeoutMs: 1,
  });
  assert.equal(readSecureDeletePending(paths.workspace.memoryDatabase), 0);
  assert.equal(reopened.getFact(fact.factId)?.state, "forgotten");
  assert.equal(reopened.getFact(fact.factId)?.version, 2);
  assert.equal(reopened.listMutations({ entityId: fact.factId }).length, 2);
  reopened.close();
  assert.equal(
    (await readFile(paths.workspace.memoryDatabase)).includes(Buffer.from(secret)),
    false,
  );
});

test("forget clears fact and linked proposal bodies while retaining a body-free tombstone", async (context) => {
  const fixture = await createFixture("forget");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const repository = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
  const secret = "sensitive-memory-body-4e7011f3";
  const proposal = repository.createProposal({
    proposalId: "forget-proposal",
    kind: "correction",
    title: `Title ${secret}`,
    content: `Content ${secret}`,
    reason: `Reason ${secret}`,
  });
  const accepted = repository.resolveProposal({
    proposalId: proposal.proposalId,
    expectedVersion: proposal.version,
    resolution: "accepted",
    factId: "forget-fact",
  });
  const forgotten = repository.forgetFact({
    factId: "forget-fact",
    expectedVersion: accepted.fact!.version,
    idempotencyKey: "forget-1",
  });
  assert.equal(forgotten.state, "forgotten");
  assert.equal(forgotten.title, null);
  assert.equal(forgotten.content, null);
  assert.equal(forgotten.pinned, false);
  const linkedProposal = repository.getProposal(proposal.proposalId);
  assert.equal(linkedProposal?.status, "deleted");
  assert.equal(linkedProposal?.title, null);
  assert.equal(linkedProposal?.content, null);
  assert.equal(linkedProposal?.reason, null);
  assert.equal(
    repository.listMutations({ entityId: "forget-fact" }).at(-1)?.action,
    "fact.forgotten",
  );
  repository.close();

  for (const path of [
    paths.workspace.memoryDatabase,
    `${paths.workspace.memoryDatabase}-wal`,
    `${paths.workspace.memoryDatabase}-shm`,
  ]) {
    if (!existsSync(path)) continue;
    const bytes = await readFile(path);
    assert.equal(bytes.includes(Buffer.from(secret)), false, `${path} retained forgotten body`);
  }

  const inspection = new Database(paths.workspace.memoryDatabase, {
    readonly: true,
    fileMustExist: true,
  });
  context.after(() => inspection.close());
  assert.deepEqual(
    inspection
      .prepare("SELECT title, content, state FROM memory_facts WHERE fact_id = 'forget-fact'")
      .get(),
    { title: null, content: null, state: "forgotten" },
  );
  assert.deepEqual(
    inspection
      .prepare("SELECT COUNT(*) AS count FROM memory_mutations WHERE action = 'fact.forgotten'")
      .get(),
    { count: 1 },
  );
});

async function createFixture(name: string): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly picoHome: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-memory-${name}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([mkdir(workspace), mkdir(picoHome)]);
  return { root, workspace, picoHome };
}

function holdFactReadSnapshot(
  databasePath: string,
  factId: string,
  expectedContent: string,
): Database.Database {
  const reader = new Database(databasePath, { readonly: true, fileMustExist: true });
  reader.pragma("busy_timeout = 0");
  reader.exec("BEGIN");
  const row = reader.prepare("SELECT content FROM memory_facts WHERE fact_id = ?").get(factId) as {
    readonly content: string;
  };
  assert.equal(row.content, expectedContent);
  return reader;
}

function releaseReadSnapshot(reader: Database.Database): void {
  if (!reader.open) return;
  reader.exec("ROLLBACK");
  reader.close();
}

function readSecureDeletePending(databasePath: string): number {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const row = database.prepare("SELECT secure_delete_pending FROM memory_maintenance").get() as {
      readonly secure_delete_pending: number;
    };
    return row.secure_delete_pending;
  } finally {
    database.close();
  }
}

function repositoryIsOpen(repository: MemoryRepository): boolean {
  try {
    repository.getSettings();
    return true;
  } catch {
    return false;
  }
}
