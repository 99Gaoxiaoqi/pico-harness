import type { SqliteSchemaScope } from "./sqlite-schema.js";

export const ATTACHMENTS_SCOPE_NAME = "attachments";

export const ATTACHMENTS_SCOPE: SqliteSchemaScope = {
  name: ATTACHMENTS_SCOPE_NAME,
  baseline: {
    version: 2,
    sql: `      CREATE TABLE file_history (
        session_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        snapshot_sequence INTEGER NOT NULL DEFAULT 0,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE file_history_snapshots (
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        before_session_seq INTEGER NOT NULL,
        message_id TEXT NOT NULL, source_message_event_id TEXT NOT NULL,
        message_index INTEGER NOT NULL, user_prompt TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (session_id, ordinal)
      );
      CREATE INDEX file_history_snapshots_by_session_seq ON file_history_snapshots(session_id, before_session_seq);
`,
  },
  migrations: new Map<number, string>([
    [2, `DROP TABLE IF EXISTS evidence_records; DROP TABLE IF EXISTS evidence_blobs;`],
  ]),
};
