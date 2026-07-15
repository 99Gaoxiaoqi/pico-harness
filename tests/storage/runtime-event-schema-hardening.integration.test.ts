import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeRuntimeEvent,
  decodeRuntimeEventJson,
  RUNTIME_EVENT_SCHEMA_VERSION,
  RuntimeEventDecodeError,
  type RuntimeEvent,
  type RuntimeEventDecodeErrorCode,
} from "../../src/runtime/runtime-event.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import {
  preflightRuntimeSchema,
  RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME,
  RUNTIME_SCHEMA_VERSION,
} from "../../src/storage/runtime-schema-preflight.js";
import { StorageDoctor } from "../../src/storage/storage-doctor.js";

describe("runtime event schema hardening", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it.each<{
    readonly code: RuntimeEventDecodeErrorCode;
    readonly decode: () => unknown;
  }>([
    { code: "malformed_json", decode: () => decodeRuntimeEventJson("{") },
    {
      code: "unsupported_legacy_version",
      decode: () => decodeRuntimeEvent({ ...messageEvent(), schemaVersion: 0 }),
    },
    {
      code: "unsupported_future_version",
      decode: () =>
        decodeRuntimeEvent({
          ...messageEvent(),
          schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION + 1,
        }),
    },
    {
      code: "unknown_kind",
      decode: () => decodeRuntimeEvent({ ...messageEvent(), kind: "message.replaced" }),
    },
    {
      code: "invalid_payload",
      decode: () =>
        decodeRuntimeEvent({
          ...messageEvent(),
          data: { message: { role: "tool", content: "invalid role" } },
        }),
    },
  ])("classifies $code without accepting the event", ({ code, decode }) => {
    expect(runtimeEventDecodeErrorCode(decode)).toBe(code);
  });

  it("decodes persisted legacy v1 events without rewriting the input", () => {
    const event = messageEvent();

    expect(decodeRuntimeEvent(event)).toBe(event);
    expect(decodeRuntimeEventJson(JSON.stringify(event))).toEqual(event);
  });

  it("refuses a future shared SQLite schema before changing the database", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-runtime-schema-future-store-"));
    cleanup.push(root);
    const databasePath = join(root, "runtime.sqlite");
    const database = new Database(databasePath);
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE sentinel (value TEXT NOT NULL);`);
    database
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(RUNTIME_SCHEMA_VERSION + 1, "future_schema", Date.now());
    database.prepare("INSERT INTO sentinel(value) VALUES (?)").run("untouched");
    database.close();
    const before = await readFile(databasePath);

    expect(() => new RuntimeEventStore({ databasePath })).toThrow(
      `schema ${RUNTIME_SCHEMA_VERSION + 1} is newer than supported ${RUNTIME_SCHEMA_VERSION}`,
    );
    expect(await readFile(databasePath)).toEqual(before);
  });

  it("uses the shared decoder when a persisted RuntimeEvent row is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-store-decoder-"));
    cleanup.push(root);
    const databasePath = join(root, "runtime.sqlite");
    const store = new RuntimeEventStore({ databasePath });
    await store.initializeSession({ sessionId: "session-a", workDir: root });
    await store.append(messageEvent());
    const database = new Database(databasePath);
    database
      .prepare("UPDATE agent_runtime_events SET event_json = ? WHERE event_id = ?")
      .run("{", "event-message");
    database.close();

    await expect(store.readSession("session-a")).rejects.toMatchObject({
      name: "RuntimeEventDecodeError",
      code: "malformed_json",
    });
  });

  it("preflights missing metadata, old, mismatched current, future, and current schemas read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-runtime-schema-preflight-"));
    cleanup.push(root);
    const databasePath = join(root, "runtime.sqlite");
    const database = new Database(databasePath);
    database.close();

    expect(preflightRuntimeSchema(databasePath)).toMatchObject({
      status: "schema_migrations_missing",
    });

    const migrations = new Database(databasePath);
    migrations.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`);
    migrations
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(RUNTIME_SCHEMA_VERSION - 1, "legacy_schema", Date.now());
    migrations.close();
    expect(preflightRuntimeSchema(databasePath)).toMatchObject({
      status: "outdated",
      schemaVersion: RUNTIME_SCHEMA_VERSION - 1,
    });

    const mismatched = new Database(databasePath);
    mismatched
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(RUNTIME_SCHEMA_VERSION, "unexpected_current_schema", Date.now());
    mismatched.close();
    expect(preflightRuntimeSchema(databasePath)).toMatchObject({
      status: "current_migration_name_mismatch",
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      migrationName: "unexpected_current_schema",
    });

    const future = new Database(databasePath);
    future
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(RUNTIME_SCHEMA_VERSION + 1, "future_schema", Date.now());
    future.close();
    expect(preflightRuntimeSchema(databasePath)).toMatchObject({
      status: "future",
      schemaVersion: RUNTIME_SCHEMA_VERSION + 1,
    });

    const current = new Database(databasePath);
    current.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(RUNTIME_SCHEMA_VERSION);
    current
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(RUNTIME_SCHEMA_VERSION, RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME, Date.now());
    current.close();
    expect(preflightRuntimeSchema(databasePath)).toMatchObject({
      status: "current",
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      migrationName: RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME,
    });
    expect(await readdir(root)).toEqual(["runtime.sqlite"]);
  });

  it("keeps missing and fresh databases healthy while reporting a partial Agent schema", async () => {
    const fixture = await createFixture("pico-runtime-schema-empty-");
    cleanup.push(fixture.root);
    const missingPath = join(fixture.root, "missing.sqlite");
    await expect(doctorFor(fixture, missingPath).scan()).resolves.toMatchObject({
      healthy: true,
      findings: [],
      scanned: { runtime: 0, session: 0 },
    });
    expect(preflightRuntimeSchema(missingPath)).toMatchObject({ status: "database_missing" });

    const emptyPath = join(fixture.root, "empty.sqlite");
    new Database(emptyPath).close();
    await expect(doctorFor(fixture, emptyPath).scan()).resolves.toMatchObject({
      healthy: true,
      findings: [],
      scanned: { runtime: 1, session: 0 },
    });

    const partialPath = join(fixture.root, "partial.sqlite");
    const partial = new Database(partialPath);
    partial.exec("CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY)");
    partial.close();
    const partialReport = await doctorFor(fixture, partialPath).scan();
    expect(partialReport.findings).toContainEqual(
      expect.objectContaining({
        code: "runtime_schema_missing",
        severity: "critical",
        authority: "authoritative",
      }),
    );
    expect(partialReport.scanned.session).toBe(0);
  });

  it("reports a future event schema as a critical replay failure", async () => {
    const fixture = await createFixture("pico-runtime-event-future-");
    cleanup.push(fixture.root);
    const event = messageEvent({ sessionId: fixture.sessionId });
    seedRuntimeDatabase(fixture, [
      eventRow(event, {
        eventJson: JSON.stringify({
          ...event,
          schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION + 1,
        }),
      }),
    ]);

    const report = await doctorFor(fixture).scan();
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "session_replay_failed",
        severity: "critical",
        message: expect.stringContaining("newer than supported"),
      }),
    );
  });

  it("reports a mismatched current migration name as critical", async () => {
    const fixture = await createFixture("pico-runtime-schema-name-");
    cleanup.push(fixture.root);
    seedRuntimeDatabase(fixture, [eventRow(messageEvent({ sessionId: fixture.sessionId }))]);
    const database = new Database(fixture.databasePath);
    database
      .prepare("UPDATE schema_migrations SET name = ? WHERE version = ?")
      .run("unexpected_current_schema", RUNTIME_SCHEMA_VERSION);
    database.close();

    const report = await doctorFor(fixture).scan();
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "runtime_schema_migration_mismatch",
        severity: "critical",
        authority: "authoritative",
      }),
    );
  });

  it("reports row and JSON identity mismatches as critical", async () => {
    const fixture = await createFixture("pico-runtime-event-identity-");
    cleanup.push(fixture.root);
    const event = messageEvent({ sessionId: fixture.sessionId });
    seedRuntimeDatabase(fixture, [eventRow(event, { eventId: "row-event-id" })]);

    const report = await doctorFor(fixture).scan();
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "session_replay_failed",
        severity: "critical",
        authority: "authoritative",
        message: expect.stringContaining("row identity mismatch"),
      }),
    );
  });

  it("reports Session recovery projection failures as critical", async () => {
    const fixture = await createFixture("pico-runtime-event-projection-");
    cleanup.push(fixture.root);
    const rewind = rewindEvent(fixture.sessionId, "missing-event-id");
    seedRuntimeDatabase(fixture, [eventRow(rewind)]);

    const report = await doctorFor(fixture).scan();
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "session_replay_failed",
        severity: "critical",
        message: expect.stringContaining("references unknown event missing-event-id"),
      }),
    );
  });

  it("reports invalid rolling checkpoint references from the model read-model", async () => {
    const fixture = await createFixture("pico-runtime-event-checkpoint-");
    cleanup.push(fixture.root);
    const checkpoint = checkpointEvent(fixture.sessionId, "missing-message-event");
    seedRuntimeDatabase(fixture, [eventRow(checkpoint)]);

    const report = await doctorFor(fixture).scan();
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "session_replay_failed",
        severity: "critical",
        message: expect.stringContaining("references an unknown prior event missing-message-event"),
      }),
    );
  });

  it("accepts a healthy legacy v1 event stream and projects it without findings", async () => {
    const fixture = await createFixture("pico-runtime-event-v1-");
    cleanup.push(fixture.root);
    seedRuntimeDatabase(fixture, [
      eventRow(messageEvent({ sessionId: fixture.sessionId, content: "durable v1" })),
    ]);

    await expect(doctorFor(fixture).scan()).resolves.toMatchObject({
      healthy: true,
      findings: [],
      scanned: { runtime: 1, session: 1 },
    });
  });
});

interface Fixture {
  readonly root: string;
  readonly workDir: string;
  readonly databasePath: string;
  readonly sessionId: string;
}

interface EventRowSeed {
  readonly sessionId: string;
  readonly runId: string;
  readonly eventId: string;
  readonly kind: string;
  readonly at: string;
  readonly eventJson: string;
}

async function createFixture(prefix: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workDir = join(root, "workspace");
  await mkdir(workDir, { recursive: true });
  return {
    root,
    workDir,
    databasePath: join(root, "runtime.sqlite"),
    sessionId: "session-a",
  };
}

function doctorFor(fixture: Fixture, runtimeDatabasePath = fixture.databasePath): StorageDoctor {
  return new StorageDoctor({
    workDir: fixture.workDir,
    runtimeDatabasePath,
    fileHistoryDir: join(fixture.root, "file-history"),
    summariesDir: join(fixture.root, "summaries"),
    artifactsDir: join(fixture.root, "artifacts"),
  });
}

function seedRuntimeDatabase(fixture: Fixture, rows: readonly EventRowSeed[]): void {
  const database = new Database(fixture.databasePath);
  try {
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE agent_sessions (
      session_id TEXT PRIMARY KEY,
      work_dir TEXT NOT NULL,
      history_source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      active_branch_id TEXT NOT NULL
    );
    CREATE TABLE agent_runtime_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      at TEXT NOT NULL,
      event_json TEXT NOT NULL
    )`);
    database
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(RUNTIME_SCHEMA_VERSION, RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME, Date.now());
    database
      .prepare(
        `INSERT INTO agent_sessions
         (session_id, work_dir, history_source, created_at, active_branch_id)
         VALUES (?, ?, 'runtime-event-v1', ?, 'main')`,
      )
      .run(fixture.sessionId, fixture.workDir, "2026-07-15T00:00:00.000Z");
    const insertEvent = database.prepare(
      `INSERT INTO agent_runtime_events
       (session_id, run_id, event_id, kind, at, event_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insertEvent.run(row.sessionId, row.runId, row.eventId, row.kind, row.at, row.eventJson);
    }
  } finally {
    database.close();
  }
}

function eventRow(event: RuntimeEvent, overrides: Partial<EventRowSeed> = {}): EventRowSeed {
  return {
    sessionId: event.sessionId,
    runId: event.runId,
    eventId: event.eventId,
    kind: event.kind,
    at: event.at,
    eventJson: JSON.stringify(event),
    ...overrides,
  };
}

function messageEvent(
  options: {
    readonly sessionId?: string;
    readonly content?: string;
  } = {},
): RuntimeEvent {
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: "event-message",
    sessionId: options.sessionId ?? "session-a",
    invocationId: "invocation-a",
    runId: "run-a",
    turnId: "turn-a",
    at: "2026-07-15T00:00:01.000Z",
    partial: false,
    visibility: "model",
    kind: "message.committed",
    data: { message: { role: "user", content: options.content ?? "persisted v1" } },
  };
}

function rewindEvent(sessionId: string, throughEventId: string): RuntimeEvent {
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: "event-rewind",
    sessionId,
    invocationId: "invocation-a",
    runId: "run-a",
    turnId: "turn-a",
    at: "2026-07-15T00:00:02.000Z",
    partial: false,
    visibility: "internal",
    kind: "history.rewound",
    data: { branchId: "branch-a", throughEventId },
  };
}

function checkpointEvent(sessionId: string, throughEventId: string): RuntimeEvent {
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: "event-checkpoint",
    sessionId,
    invocationId: "invocation-a",
    runId: "run-a",
    turnId: "turn-a",
    at: "2026-07-15T00:00:02.000Z",
    partial: true,
    visibility: "internal",
    kind: "context.checkpoint.recorded",
    data: {
      checkpointId: "checkpoint-a",
      coveredEventCount: 1,
      sourceDigest: "digest-a",
      throughEventId,
      summary: { role: "user", content: "summary" },
    },
  };
}

function runtimeEventDecodeErrorCode(decode: () => unknown): RuntimeEventDecodeErrorCode {
  try {
    decode();
  } catch (error) {
    if (error instanceof RuntimeEventDecodeError) return error.code;
    throw error;
  }
  throw new Error("Expected runtime event decoding to fail");
}
