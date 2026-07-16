import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { canonicalizeWorkspacePath } from "../paths/pico-paths.js";
import {
  preflightOpenedRuntimeSchema,
  RUNTIME_SCHEMA_VERSION,
  type RuntimeSchemaPreflightResult,
} from "../storage/runtime-schema-preflight.js";
import {
  SESSION_RUNTIME_STATE_VERSION,
  normalizeSessionRuntimeStateWritePatch,
  type SessionRuntimeStateWritePatch,
} from "../engine/session-runtime.js";
import type { SessionCursor } from "../engine/session-persistence.js";
import type { TranscriptEvent } from "../presentation/transcript-event-store.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  decodeRuntimeEvent,
  decodeRuntimeEventJson,
  type RuntimeEvent,
} from "./runtime-event.js";

const RUNTIME_SESSION_MANIFEST_VERSION = 1 as const;

export interface RuntimeSessionManifest {
  readonly schemaVersion: typeof RUNTIME_SESSION_MANIFEST_VERSION;
  readonly sessionId: string;
  readonly workDir: string;
  readonly historySource: "runtime-event-v1";
  readonly createdAt: string;
  readonly activeBranchId: string;
}

export interface InitializeRuntimeSessionOptions {
  readonly sessionId: string;
  readonly workDir: string;
  readonly now?: () => Date;
}

export interface RuntimeEventStoreOptions {
  readonly databasePath: string;
}

export interface ReadRuntimeSessionProjectionOptions extends RuntimeEventStoreOptions {
  readonly sessionId: string;
}

export interface RuntimeEventStoreAppendResult {
  readonly inserted: boolean;
  readonly cursor: SessionCursor;
  readonly committedAt: string;
}

export interface RuntimeEventStoreEntry {
  readonly sequence: number;
  readonly event: RuntimeEvent;
}

export interface RuntimeSessionProjectionSnapshot {
  readonly manifest: RuntimeSessionManifest;
  readonly activeBranchId: string;
  readonly entries: readonly RuntimeEventStoreEntry[];
  readonly cursor?: SessionCursor;
}

export interface RuntimeSessionProjectionDelta {
  readonly activeBranchId: string;
  readonly entries: readonly RuntimeEventStoreEntry[];
  readonly cursor: SessionCursor;
}

export interface AppendRuntimeSessionStateOptions {
  readonly eventId?: string;
  readonly now?: () => Date;
}

export interface AppendRuntimeTranscriptEventOptions {
  readonly eventId?: string;
}

interface SessionRow {
  readonly session_id: string;
  readonly work_dir: string;
  readonly history_source: string;
  readonly created_at: string;
  readonly active_branch_id: string;
}

interface EventRow {
  readonly sequence: number;
  readonly session_id: string;
  readonly run_id: string;
  readonly event_id: string;
  readonly kind: string;
  readonly at: string;
  readonly event_json: string;
}

export class RuntimeEventStoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeEventStoreIntegrityError";
  }
}

/**
 * Canonical Session and Agent runtime fact store.
 *
 * One SQLite transaction commits each fact and its global sequence. Session memory,
 * run headers, FTS, and UI state are projections that may be rebuilt from this store.
 */
export class RuntimeEventStore {
  readonly databasePath: string;

  constructor(options: RuntimeEventStoreOptions) {
    this.databasePath = resolve(options.databasePath);
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.databasePath), 0o700);
    const db = this.openDatabase(true);
    db.close();
  }

  async initializeSession(
    options: InitializeRuntimeSessionOptions,
  ): Promise<RuntimeSessionManifest> {
    const workDir = canonicalizeWorkspacePath(options.workDir);
    const db = this.openDatabase();
    try {
      return db
        .transaction(() => {
          assertRuntimeEventStoreSchema(preflightOpenedRuntimeSchema(db, this.databasePath));
          const existing = this.selectSession(db, options.sessionId);
          if (existing) {
            if (existing.work_dir !== workDir) {
              throw new RuntimeEventStoreIntegrityError(
                `Runtime session ${options.sessionId} belongs to another workspace`,
              );
            }
            return manifestFromRow(existing);
          }
          const createdAt = (options.now ?? (() => new Date()))().toISOString();
          db.prepare(
            `INSERT INTO agent_sessions
             (session_id, work_dir, history_source, created_at, active_branch_id)
           VALUES (?, ?, 'runtime-event-v1', ?, 'main')`,
          ).run(options.sessionId, workDir, createdAt);
          return manifestFromRow(this.requireSession(db, options.sessionId));
        })
        .immediate();
    } finally {
      db.close();
    }
  }

  async readSessionManifest(sessionId: string): Promise<RuntimeSessionManifest | undefined> {
    const db = this.openDatabase();
    try {
      const row = this.selectSession(db, sessionId);
      return row ? manifestFromRow(row) : undefined;
    } finally {
      db.close();
    }
  }

  async listSessionManifests(): Promise<RuntimeSessionManifest[]> {
    const db = this.openDatabase();
    try {
      const rows = db
        .prepare("SELECT * FROM agent_sessions ORDER BY created_at DESC, session_id DESC")
        .all() as SessionRow[];
      return rows.map(manifestFromRow);
    } finally {
      db.close();
    }
  }

  async append(event: RuntimeEvent): Promise<RuntimeEventStoreAppendResult> {
    const results = await this.appendBatch([event]);
    return results[0]!;
  }

  /**
   * Atomically appends an ordered group of facts. Every exact-once comparison,
   * insert, and active-branch update shares one IMMEDIATE transaction, so a
   * conflict or storage failure cannot expose a partially committed transition.
   */
  async appendBatch(
    events: readonly RuntimeEvent[],
  ): Promise<readonly RuntimeEventStoreAppendResult[]> {
    const canonicalEvents = events.map((event) => {
      decodeRuntimeEvent(event);
      return canonicalizeRuntimeEvent(event);
    });
    if (canonicalEvents.length === 0) return [];

    const db = this.openDatabase();
    try {
      return db
        .transaction(() => {
          assertRuntimeEventStoreSchema(preflightOpenedRuntimeSchema(db, this.databasePath));
          return canonicalEvents.map(({ event: canonicalEvent, encoded }) =>
            this.appendCanonicalEvent(db, canonicalEvent, encoded),
          );
        })
        .immediate();
    } finally {
      db.close();
    }
  }

  async appendSessionState(
    sessionId: string,
    patch: SessionRuntimeStateWritePatch,
    options: AppendRuntimeSessionStateOptions = {},
  ): Promise<RuntimeEventStoreAppendResult> {
    const normalized = normalizeSessionRuntimeStateWritePatch(patch);
    if (!normalized) throw new Error("Runtime session state write patch is invalid");
    const at = (options.now ?? (() => new Date()))().toISOString();
    return this.append({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      eventId: options.eventId ?? createRuntimeEventId("session-state"),
      sessionId,
      invocationId: `session:${sessionId}:state`,
      runId: "session-state",
      turnId: "session-state",
      at,
      partial: false,
      visibility: "internal",
      kind: "session.state.committed",
      data: {
        stateVersion: SESSION_RUNTIME_STATE_VERSION,
        patch: structuredClone(normalized),
      },
    });
  }

  async appendTranscriptEvent(
    sessionId: string,
    event: TranscriptEvent,
    options: AppendRuntimeTranscriptEventOptions = {},
  ): Promise<RuntimeEventStoreAppendResult> {
    return this.append({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      eventId: options.eventId ?? `transcript:${event.eventId}`,
      sessionId,
      invocationId: `session:${sessionId}:transcript`,
      runId: "session-transcript",
      turnId: "transcript",
      at: new Date(event.createdAt).toISOString(),
      partial: false,
      visibility: "transcript",
      kind: "transcript.event.recorded",
      data: { event: structuredClone(event) },
    });
  }

  async readRun(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    const db = this.openDatabase();
    try {
      const rows = db
        .prepare(
          `SELECT sequence, session_id, run_id, event_id, kind, at, event_json
           FROM agent_runtime_events
           WHERE session_id = ? AND run_id = ?
           ORDER BY sequence`,
        )
        .all(sessionId, runId) as EventRow[];
      return rows.map((row) => decodeEventRow(row, sessionId, runId).event);
    } finally {
      db.close();
    }
  }

  async readSession(sessionId: string): Promise<RuntimeEvent[]> {
    return (await this.readSessionEntries(sessionId)).map(({ event }) => event);
  }

  async readSessionEvent(
    sessionId: string,
    eventId: string,
  ): Promise<RuntimeEventStoreEntry | undefined> {
    const db = this.openDatabase();
    try {
      const row = db
        .prepare(
          `SELECT sequence, session_id, run_id, event_id, kind, at, event_json
           FROM agent_runtime_events
           WHERE session_id = ? AND event_id = ?`,
        )
        .get(sessionId, eventId) as EventRow | undefined;
      return row ? decodeEventRow(row, sessionId) : undefined;
    } finally {
      db.close();
    }
  }

  async readSessionEntries(sessionId: string): Promise<RuntimeEventStoreEntry[]> {
    const db = this.openDatabase();
    try {
      const rows = db
        .prepare(
          `SELECT sequence, session_id, run_id, event_id, kind, at, event_json
           FROM agent_runtime_events
           WHERE session_id = ?
           ORDER BY sequence`,
        )
        .all(sessionId) as EventRow[];
      return rows.map((row) => decodeEventRow(row, sessionId));
    } finally {
      db.close();
    }
  }

  /** Reads one internally consistent canonical projection for recovery or repair. */
  async readSessionProjection(
    sessionId: string,
  ): Promise<RuntimeSessionProjectionSnapshot | undefined> {
    const db = this.openDatabase();
    try {
      return db.transaction(() => readSessionProjectionFromDatabase(db, sessionId))();
    } finally {
      db.close();
    }
  }

  /**
   * Reads only the canonical suffix needed to advance a disposable projection.
   * Undefined means the caller must replay a full snapshot instead of inferring state.
   */
  async readSessionProjectionDelta(
    sessionId: string,
    after: SessionCursor,
    through: SessionCursor,
    expectedBranchId: string,
  ): Promise<RuntimeSessionProjectionDelta | undefined> {
    if (
      after.logId !== sessionId ||
      through.logId !== sessionId ||
      through.seq <= after.seq ||
      !expectedBranchId
    ) {
      return undefined;
    }

    const db = this.openDatabase();
    try {
      return db.transaction((): RuntimeSessionProjectionDelta | undefined => {
        const session = this.selectSession(db, sessionId);
        if (!session) return undefined;
        const cursorRow = this.selectSessionEventAtSequence(db, sessionId, after.seq);
        const targetRow = this.selectSessionEventAtSequence(db, sessionId, through.seq);
        const headRow = this.selectSessionHead(db, sessionId);
        if (!cursorRow || !targetRow || !headRow) return undefined;

        const cursorEntry = decodeEventRow(cursorRow, sessionId);
        const targetEntry = decodeEventRow(targetRow, sessionId);
        const headEntry = decodeEventRow(headRow, sessionId);
        if (
          cursorEntry.event.eventId !== after.eventId ||
          targetEntry.event.eventId !== through.eventId ||
          headEntry.sequence !== through.seq ||
          headEntry.event.eventId !== through.eventId ||
          this.activeBranchAt(db, sessionId, after.seq) !== expectedBranchId
        ) {
          return undefined;
        }

        const rows = db
          .prepare(
            `SELECT sequence, session_id, run_id, event_id, kind, at, event_json
             FROM agent_runtime_events
             WHERE session_id = ? AND sequence > ? AND sequence <= ?
             ORDER BY sequence`,
          )
          .all(sessionId, after.seq, through.seq) as EventRow[];
        const entries = rows.map((row) => decodeEventRow(row, sessionId));
        if (entries.at(-1)?.event.eventId !== through.eventId) return undefined;

        let epoch = after.epoch;
        let activeBranchId = expectedBranchId;
        for (const entry of entries) {
          if (entry.event.kind !== "history.rewound") continue;
          epoch++;
          activeBranchId = entry.event.data.branchId;
        }
        if (epoch !== through.epoch || activeBranchId !== session.active_branch_id)
          return undefined;

        return { activeBranchId, entries, cursor: { ...through } };
      })();
    } finally {
      db.close();
    }
  }

  async listRunIds(sessionId: string): Promise<string[]> {
    const db = this.openDatabase();
    try {
      const rows = db
        .prepare(
          `SELECT DISTINCT run_id
           FROM agent_runtime_events
           WHERE session_id = ? AND run_id <> 'session-state'
           ORDER BY run_id`,
        )
        .all(sessionId) as Array<{ run_id: string }>;
      return rows.map((row) => row.run_id);
    } finally {
      db.close();
    }
  }

  async getHeadCursor(sessionId: string): Promise<SessionCursor | undefined> {
    const db = this.openDatabase();
    try {
      const row = this.selectSessionHead(db, sessionId);
      if (!row) return undefined;
      const head = decodeEventRow(row, sessionId);
      return this.cursorForEvent(db, head.sequence, head.event);
    } finally {
      db.close();
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const db = this.openDatabase();
    try {
      return db
        .transaction(() => {
          assertRuntimeEventStoreSchema(preflightOpenedRuntimeSchema(db, this.databasePath));
          return (
            db.prepare("DELETE FROM agent_sessions WHERE session_id = ?").run(sessionId).changes > 0
          );
        })
        .immediate();
    } finally {
      db.close();
    }
  }

  close(): void {
    // Connections are intentionally scoped to individual operations.
  }

  private appendResult(
    db: Database.Database,
    sequence: number,
    event: RuntimeEvent,
    inserted: boolean,
  ): RuntimeEventStoreAppendResult {
    return {
      inserted,
      cursor: this.cursorForEvent(db, sequence, event),
      committedAt: event.at,
    };
  }

  private cursorForEvent(
    db: Database.Database,
    sequence: number,
    event: RuntimeEvent,
  ): SessionCursor {
    const epoch = Number(
      db
        .prepare(
          `SELECT COUNT(*)
           FROM agent_runtime_events
           WHERE session_id = ? AND sequence <= ? AND kind = 'history.rewound'`,
        )
        .pluck()
        .get(event.sessionId, sequence),
    );
    return {
      logId: event.sessionId,
      seq: sequence,
      epoch,
      eventId: event.eventId,
    };
  }

  private appendCanonicalEvent(
    db: Database.Database,
    canonicalEvent: RuntimeEvent,
    encoded: string,
  ): RuntimeEventStoreAppendResult {
    const session = this.requireSession(db, canonicalEvent.sessionId);
    if (
      canonicalEvent.kind === "run.started" &&
      canonicalizeWorkspacePath(canonicalEvent.data.workDir) !== session.work_dir
    ) {
      throw new RuntimeEventStoreIntegrityError(
        `Runtime event workspace does not match session ${canonicalEvent.sessionId}`,
      );
    }

    const existing = db
      .prepare(
        `SELECT sequence, session_id, run_id, event_id, kind, at, event_json
         FROM agent_runtime_events
         WHERE session_id = ? AND event_id = ?`,
      )
      .get(canonicalEvent.sessionId, canonicalEvent.eventId) as EventRow | undefined;
    if (existing) {
      const stored = decodeEventRow(existing, canonicalEvent.sessionId);
      if (!isDeepStrictEqual(stored.event, canonicalEvent)) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime event ID ${canonicalEvent.eventId} is already bound to another payload`,
        );
      }
      return this.appendResult(db, stored.sequence, stored.event, false);
    }

    const inserted = db
      .prepare(
        `INSERT INTO agent_runtime_events
         (session_id, run_id, event_id, kind, at, event_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        canonicalEvent.sessionId,
        canonicalEvent.runId,
        canonicalEvent.eventId,
        canonicalEvent.kind,
        canonicalEvent.at,
        encoded,
      );
    const sequence = Number(inserted.lastInsertRowid);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new RuntimeEventStoreIntegrityError("Runtime event sequence is invalid");
    }
    if (canonicalEvent.kind === "history.rewound") {
      db.prepare("UPDATE agent_sessions SET active_branch_id = ? WHERE session_id = ?").run(
        canonicalEvent.data.branchId,
        canonicalEvent.sessionId,
      );
    }
    return this.appendResult(db, sequence, canonicalEvent, true);
  }

  private selectSession(db: Database.Database, sessionId: string): SessionRow | undefined {
    return db.prepare("SELECT * FROM agent_sessions WHERE session_id = ?").get(sessionId) as
      | SessionRow
      | undefined;
  }

  private requireSession(db: Database.Database, sessionId: string): SessionRow {
    const row = this.selectSession(db, sessionId);
    if (!row) {
      throw new RuntimeEventStoreIntegrityError(
        `Runtime session ${sessionId} must be initialized before appending events`,
      );
    }
    return row;
  }

  private selectSessionEventAtSequence(
    db: Database.Database,
    sessionId: string,
    sequence: number,
  ): EventRow | undefined {
    return db
      .prepare(
        `SELECT sequence, session_id, run_id, event_id, kind, at, event_json
         FROM agent_runtime_events
         WHERE session_id = ? AND sequence = ?`,
      )
      .get(sessionId, sequence) as EventRow | undefined;
  }

  private selectSessionHead(db: Database.Database, sessionId: string): EventRow | undefined {
    return db
      .prepare(
        `SELECT sequence, session_id, run_id, event_id, kind, at, event_json
         FROM agent_runtime_events
         WHERE session_id = ?
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(sessionId) as EventRow | undefined;
  }

  private activeBranchAt(db: Database.Database, sessionId: string, sequence: number): string {
    const row = db
      .prepare(
        `SELECT sequence, session_id, run_id, event_id, kind, at, event_json
         FROM agent_runtime_events
         WHERE session_id = ? AND kind = 'history.rewound' AND sequence <= ?
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(sessionId, sequence) as EventRow | undefined;
    if (!row) return "main";
    const entry = decodeEventRow(row, sessionId);
    if (entry.event.kind !== "history.rewound") {
      throw new RuntimeEventStoreIntegrityError("Runtime active branch event has an invalid kind");
    }
    return entry.event.data.branchId;
  }

  private openDatabase(initializeSchema = false): Database.Database {
    const db = new Database(this.databasePath);
    try {
      db.pragma("busy_timeout = 5000");
      assertRuntimeEventStoreSchema(preflightOpenedRuntimeSchema(db, this.databasePath));
      chmodSync(this.databasePath, 0o600);
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      db.pragma("synchronous = FULL");
      if (initializeSchema) {
        db.transaction(() => {
          assertRuntimeEventStoreSchema(preflightOpenedRuntimeSchema(db, this.databasePath));
          db.exec(
            `CREATE TABLE IF NOT EXISTS agent_sessions (
           session_id TEXT PRIMARY KEY,
           work_dir TEXT NOT NULL,
           history_source TEXT NOT NULL CHECK (history_source = 'runtime-event-v1'),
           created_at TEXT NOT NULL,
           active_branch_id TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS agent_runtime_events (
           sequence INTEGER PRIMARY KEY AUTOINCREMENT,
           session_id TEXT NOT NULL,
           run_id TEXT NOT NULL,
           event_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           at TEXT NOT NULL,
           event_json TEXT NOT NULL,
           UNIQUE (session_id, event_id),
           FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_agent_runtime_events_session_sequence
           ON agent_runtime_events(session_id, sequence);
         CREATE INDEX IF NOT EXISTS idx_agent_runtime_events_session_run_sequence
           ON agent_runtime_events(session_id, run_id, sequence);
         CREATE INDEX IF NOT EXISTS idx_agent_runtime_events_session_kind_sequence
           ON agent_runtime_events(session_id, kind, sequence);`,
          );
        }).immediate();
      }
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
}

/**
 * Reads an existing canonical Session projection without creating directories, opening a
 * writable connection, changing journal settings, or running schema DDL.
 */
export async function readExistingRuntimeSessionProjection(
  options: ReadRuntimeSessionProjectionOptions,
): Promise<RuntimeSessionProjectionSnapshot | undefined> {
  const databasePath = resolve(options.databasePath);
  if (!existsSync(databasePath)) return undefined;

  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    assertRuntimeEventStoreSchema(preflightOpenedRuntimeSchema(db, databasePath));
    return db.transaction(() => readSessionProjectionFromDatabase(db, options.sessionId))();
  } finally {
    db.close();
  }
}

export function createRuntimeEventId(prefix = "runtime-event"): string {
  return `${prefix}:${randomUUID()}`;
}

function readSessionProjectionFromDatabase(
  db: Database.Database,
  sessionId: string,
): RuntimeSessionProjectionSnapshot | undefined {
  const session = db.prepare("SELECT * FROM agent_sessions WHERE session_id = ?").get(sessionId) as
    | SessionRow
    | undefined;
  if (!session) return undefined;
  const rows = db
    .prepare(
      `SELECT sequence, session_id, run_id, event_id, kind, at, event_json
       FROM agent_runtime_events
       WHERE session_id = ?
       ORDER BY sequence`,
    )
    .all(sessionId) as EventRow[];
  const entries = rows.map((row) => decodeEventRow(row, sessionId));
  const activeBranchId = activeBranchForEntries(entries);
  if (activeBranchId !== session.active_branch_id) {
    throw new RuntimeEventStoreIntegrityError(
      `Runtime session ${sessionId} active branch does not match its canonical events`,
    );
  }
  const head = entries.at(-1);
  return {
    manifest: manifestFromRow(session),
    activeBranchId,
    entries,
    ...(head
      ? { cursor: cursorForEntries(sessionId, entries, head.sequence, head.event.eventId) }
      : {}),
  };
}

function manifestFromRow(row: SessionRow): RuntimeSessionManifest {
  if (row.history_source !== "runtime-event-v1") {
    throw new RuntimeEventStoreIntegrityError(
      `Runtime session ${row.session_id} has an unsupported history source`,
    );
  }
  return {
    schemaVersion: RUNTIME_SESSION_MANIFEST_VERSION,
    sessionId: row.session_id,
    workDir: row.work_dir,
    historySource: "runtime-event-v1",
    createdAt: row.created_at,
    activeBranchId: row.active_branch_id,
  };
}

function decodeEventRow(
  row: EventRow,
  expectedSessionId: string,
  expectedRunId?: string,
): RuntimeEventStoreEntry {
  const value = decodeRuntimeEventJson(row.event_json);
  if (
    value.sessionId !== expectedSessionId ||
    row.session_id !== expectedSessionId ||
    value.eventId !== row.event_id ||
    value.runId !== row.run_id ||
    value.kind !== row.kind ||
    value.at !== row.at ||
    (expectedRunId !== undefined && value.runId !== expectedRunId)
  ) {
    throw new RuntimeEventStoreIntegrityError("Runtime event identity does not match its row");
  }
  return { sequence: row.sequence, event: value };
}

function cursorForEntries(
  sessionId: string,
  entries: readonly RuntimeEventStoreEntry[],
  sequence: number,
  eventId: string,
): SessionCursor {
  return {
    logId: sessionId,
    seq: sequence,
    epoch: entries.filter(
      (entry) => entry.sequence <= sequence && entry.event.kind === "history.rewound",
    ).length,
    eventId,
  };
}

function activeBranchForEntries(entries: readonly RuntimeEventStoreEntry[]): string {
  let activeBranchId = "main";
  for (const entry of entries) {
    if (entry.event.kind === "history.rewound") {
      activeBranchId = entry.event.data.branchId;
    }
  }
  return activeBranchId;
}

function canonicalizeRuntimeEvent(event: RuntimeEvent): {
  readonly event: RuntimeEvent;
  readonly encoded: string;
} {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(event);
  } catch (error) {
    throw new RuntimeEventStoreIntegrityError(
      `Runtime event ${event.eventId} must be JSON-serializable: ${String(error)}`,
    );
  }
  if (encoded === undefined) {
    throw new RuntimeEventStoreIntegrityError(
      `Runtime event ${event.eventId} encoded to undefined`,
    );
  }
  const canonical: unknown = JSON.parse(encoded);
  return { event: decodeRuntimeEvent(canonical), encoded };
}

function assertRuntimeEventStoreSchema(schema: RuntimeSchemaPreflightResult): void {
  if (schema.status === "future") {
    throw new RuntimeEventStoreIntegrityError(
      `runtime.sqlite schema ${schema.schemaVersion} is newer than supported ${RUNTIME_SCHEMA_VERSION}`,
    );
  }
  if (schema.status === "current_migration_name_mismatch") {
    throw new RuntimeEventStoreIntegrityError(
      `runtime.sqlite schema ${schema.schemaVersion} migration ${schema.migrationName} does not match ${schema.expectedMigrationName}`,
    );
  }
  if (schema.status === "invalid") {
    throw new RuntimeEventStoreIntegrityError(`runtime.sqlite schema is invalid: ${schema.reason}`);
  }
  if ("tables" in schema && schema.tables.agentSessions !== schema.tables.agentRuntimeEvents) {
    throw new RuntimeEventStoreIntegrityError(
      "runtime.sqlite contains only part of the Agent runtime event schema",
    );
  }
}
