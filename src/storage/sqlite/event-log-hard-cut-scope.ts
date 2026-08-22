import type { SqliteSchemaScope } from "./sqlite-schema.js";

export const EVENT_LOG_HARD_CUT_SCOPE_NAME = "event_log_hard_cut";
export const CURRENT_EVENT_LOG_EPOCH = 1;
export const CURRENT_EVENT_LOG_PROTOCOL_MARKER = "runtime-event-v2-maka-v1";

/**
 * Workspace-level singleton cutover marker plus durable file-GC outbox.
 * The marker row is deliberately not seeded by migration: an absent row means
 * the pre-cut epoch and must never make legacy Session rows look current.
 */
export const EVENT_LOG_HARD_CUT_SCOPE: SqliteSchemaScope = {
  name: EVENT_LOG_HARD_CUT_SCOPE_NAME,
  migrations: new Map<number, string>([
    [
      1,
      `
      CREATE TABLE event_log_epoch (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        epoch INTEGER NOT NULL CHECK (epoch >= 0),
        protocol_marker TEXT NOT NULL CHECK (length(protocol_marker) > 0),
        cutover_id TEXT NOT NULL CHECK (length(cutover_id) > 0),
        committed_at TEXT NOT NULL
      );

      CREATE TABLE event_log_blob_gc_intents (
        intent_id TEXT PRIMARY KEY,
        cutover_id TEXT NOT NULL,
        asset_scope TEXT NOT NULL CHECK (
          asset_scope IN ('runtime_asset','evidence_blob','file_history_blob')
        ),
        storage_uri TEXT,
        content_digest TEXT NOT NULL CHECK (length(content_digest) > 0),
        byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
        requires_reference_check INTEGER NOT NULL
          CHECK (requires_reference_check IN (0,1)),
        state TEXT NOT NULL CHECK (state IN ('pending','retryable','completed')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX event_log_blob_gc_retryable
        ON event_log_blob_gc_intents(state, next_attempt_at, created_at, intent_id)
        WHERE state IN ('pending','retryable');
      `,
    ],
  ]),
};
