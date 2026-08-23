import type { SqliteSchemaScope } from "./sqlite-schema.js";

/** Session-scoped Workbar facts. Trace remains a projection of runtime_events. */
export const WORKBAR_SCOPE_NAME = "workbar";

export const WORKBAR_SCOPE: SqliteSchemaScope = {
  name: WORKBAR_SCOPE_NAME,
  migrations: new Map<number, string>([
    [
      1,
      `
      CREATE TABLE session_task_ledgers (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_tasks (
        task_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        detail TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','in_progress','blocked','completed','failed','cancelled')),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (session_id, ordinal)
      );
      CREATE INDEX session_tasks_by_session_status
        ON session_tasks(session_id, status, ordinal, task_id);
      CREATE TABLE session_task_commands (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, idempotency_key)
      );

      CREATE TABLE session_artifact_ledgers (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE artifact_blobs (
        digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        content BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE session_artifacts (
        artifact_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        digest TEXT NOT NULL REFERENCES artifact_blobs(digest),
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX session_artifacts_by_session
        ON session_artifacts(session_id, created_at, artifact_id);
      CREATE TABLE session_artifact_ingests (
        ingest_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        content BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX session_artifact_ingests_by_session
        ON session_artifact_ingests(session_id, created_at);
      CREATE TABLE session_artifact_commands (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, idempotency_key)
      );
      `,
    ],
  ]),
};
