import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { canonicalizeWorkspacePath } from "../paths/pico-paths.js";
import {
  SESSION_RUNTIME_STATE_VERSION,
  type SessionRuntimeStatePatch,
} from "../engine/session-runtime.js";
import type { SessionCursor } from "../engine/session-persistence.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  RuntimeEventIntegrityError,
  assertRuntimeEvent,
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

export interface RuntimeEventStoreAppendResult {
  readonly inserted: boolean;
  readonly cursor: SessionCursor;
  readonly committedAt: string;
}

export interface RuntimeEventStoreEntry {
  readonly sequence: number;
  readonly event: RuntimeEvent;
}

export interface AppendRuntimeSessionStateOptions {
  readonly eventId?: string;
  readonly now?: () => Date;
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
    const db = this.openDatabase();
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
      assertRuntimeEvent(event);
      return canonicalizeRuntimeEvent(event);
    });
    if (canonicalEvents.length === 0) return [];

    const db = this.openDatabase();
    try {
      return db
        .transaction(() =>
          canonicalEvents.map(({ event: canonicalEvent, encoded }) =>
            this.appendCanonicalEvent(db, canonicalEvent, encoded),
          ),
        )
        .immediate();
    } finally {
      db.close();
    }
  }

  async appendSessionState(
    sessionId: string,
    patch: SessionRuntimeStatePatch,
    options: AppendRuntimeSessionStateOptions = {},
  ): Promise<RuntimeEventStoreAppendResult> {
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
        patch: structuredClone(patch),
      },
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
    const entries = await this.readSessionEntries(sessionId);
    const head = entries.at(-1);
    if (!head) return undefined;
    return cursorForEntries(sessionId, entries, head.sequence, head.event.eventId);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const db = this.openDatabase();
    try {
      return (
        db.prepare("DELETE FROM agent_sessions WHERE session_id = ?").run(sessionId).changes > 0
      );
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
      inserted,
      cursor: {
        logId: event.sessionId,
        seq: sequence,
        epoch,
        eventId: event.eventId,
      },
      committedAt: event.at,
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

  private openDatabase(): Database.Database {
    const db = new Database(this.databasePath);
    try {
      chmodSync(this.databasePath, 0o600);
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 5000");
      db.pragma("synchronous = FULL");
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
           ON agent_runtime_events(session_id, run_id, sequence);`,
      );
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
}

export function createRuntimeEventId(prefix = "runtime-event"): string {
  return `${prefix}:${randomUUID()}`;
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
  let value: unknown;
  try {
    value = JSON.parse(row.event_json);
  } catch {
    throw new RuntimeEventStoreIntegrityError(
      `Runtime event ${row.event_id} contains invalid JSON`,
    );
  }
  try {
    assertRuntimeEvent(value);
  } catch (error) {
    if (error instanceof RuntimeEventIntegrityError) throw error;
    throw new RuntimeEventStoreIntegrityError(
      `Runtime event ${row.event_id} has an invalid payload`,
    );
  }
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
  assertRuntimeEvent(canonical);
  return { event: canonical, encoded };
}
