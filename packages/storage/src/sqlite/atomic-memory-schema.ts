/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { DatabaseSync } from "node:sqlite";
import { EXECUTION_LEARNING_SCHEMA_SQL } from "./execution-learning-store.js";
import { migrateExperienceFeedback } from "./experience-feedback-schema.js";
import { TASK_EXPERIENCE_SCHEMA_SQL } from "./task-experience-schema.js";
import {
  checkpointRetiredExecutionLessons,
  retireExecutionLessons,
} from "./retire-execution-lessons.js";

export const SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION = 15;

const MEMORY_CONSOLIDATION_SCHEMA_SQL = `
CREATE TABLE memory_consolidation_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_committed_at INTEGER NOT NULL DEFAULT 0 CHECK (last_committed_at >= 0),
  lease_id TEXT,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0 CHECK (lease_until >= 0),
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_items_json TEXT NOT NULL DEFAULT '[]',
  CHECK (
    (lease_id IS NULL AND lease_owner IS NULL AND lease_until = 0 AND lease_items_json = '[]')
    OR
    (lease_id IS NOT NULL AND length(lease_id) > 0 AND lease_owner IS NOT NULL
      AND length(lease_owner) > 0 AND lease_until > 0)
  )
) WITHOUT ROWID;
INSERT INTO memory_consolidation_state(singleton) VALUES (1);

CREATE TABLE memory_consolidation_receipts (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  claim_id TEXT NOT NULL UNIQUE,
  committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
  undo_expires_at INTEGER NOT NULL CHECK (undo_expires_at >= committed_at),
  undone_at INTEGER CHECK (undone_at IS NULL OR undone_at >= committed_at),
  result_json TEXT NOT NULL
);
CREATE INDEX memory_consolidation_receipts_recent
  ON memory_consolidation_receipts(committed_at DESC, operation_id ASC);
`;

const EXECUTION_LESSON_SCHEMA_SQL = `
CREATE TABLE execution_lesson_candidates (
  candidate_id TEXT PRIMARY KEY CHECK(length(candidate_id) > 0),
  workspace_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('candidate','confirmed','rejected','deleted','invalidated')),
  item_id TEXT UNIQUE,
  record_json TEXT NOT NULL,
  FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE SET NULL
);
CREATE INDEX execution_lessons_by_scope ON execution_lesson_candidates(workspace_key,session_id,state);
`;

const SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_INITIALIZATION_RETRY_DELAY_MS = 10;
const initializationRetryGate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

// Historical baseline used only inside the upgrade transaction; v14 retires its old lesson table.
const CURRENT_SCHEMA_SQL =
  `
CREATE TABLE memory_compaction_policy_denials (
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      compaction_checkpoint_id TEXT NOT NULL CHECK (length(compaction_checkpoint_id) > 0),
      denied_at INTEGER NOT NULL CHECK (denied_at >= 0),
      PRIMARY KEY(session_id, compaction_checkpoint_id)
    ) WITHOUT ROWID;

CREATE TABLE memory_extraction_cursors (
      session_id TEXT PRIMARY KEY CHECK (length(session_id) > 0),
      processed_ordinal INTEGER NOT NULL CHECK (processed_ordinal > 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    );

CREATE TABLE memory_extraction_failures (
      session_id TEXT PRIMARY KEY CHECK (length(session_id) > 0),
      from_ordinal INTEGER NOT NULL CHECK (from_ordinal > 0),
      through_ordinal INTEGER NOT NULL CHECK (through_ordinal >= from_ordinal),
      coverage_hash TEXT NOT NULL CHECK (length(coverage_hash) = 64),
      first_operation_id TEXT NOT NULL UNIQUE CHECK (length(first_operation_id) > 0),
      first_trigger TEXT NOT NULL CHECK (
        first_trigger IN ('remember', 'extract', 'compaction')
      ),
      compaction_checkpoint_id TEXT CHECK (
        compaction_checkpoint_id IS NULL OR length(compaction_checkpoint_id) > 0
      ),
      first_failure_class TEXT NOT NULL CHECK (
        first_failure_class IN (
          'provider', 'schema', 'evidence', 'localization', 'requested_admission'
        )
      ),
      failed_at INTEGER NOT NULL CHECK (failed_at >= 0),
      deletion_revision INTEGER NOT NULL CHECK (deletion_revision >= 0),
      CHECK (
        (first_trigger = 'compaction' AND compaction_checkpoint_id IS NOT NULL)
        OR (first_trigger != 'compaction' AND compaction_checkpoint_id IS NULL)
      )
    );

CREATE TABLE memory_extraction_receipts (
      operation_id TEXT PRIMARY KEY CHECK (length(operation_id) > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
      result_json TEXT NOT NULL,
      committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
      FOREIGN KEY (operation_id) REFERENCES memory_write_operations(operation_id) ON DELETE CASCADE
    );

CREATE TABLE memory_item_keys (
      item_id TEXT NOT NULL,
      key_text TEXT NOT NULL CHECK (length(key_text) > 0),
      normalized_key TEXT NOT NULL CHECK (length(normalized_key) > 0),
      key_type TEXT NOT NULL CHECK (key_type IN ('exact', 'entity', 'concept', 'alias', 'code')),
      key_origin TEXT NOT NULL CHECK (key_origin IN ('deterministic', 'llm', 'user')),
      PRIMARY KEY(item_id, normalized_key),
      FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE
    ) WITHOUT ROWID;

CREATE TABLE memory_item_sources (
      item_id TEXT NOT NULL,
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      run_id TEXT NOT NULL CHECK (length(run_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      event_id TEXT NOT NULL CHECK (length(event_id) > 0),
      PRIMARY KEY(item_id, event_id),
      FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE
    ) WITHOUT ROWID;

CREATE TABLE memory_items (
      item_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version >= 1),
      content TEXT NOT NULL CHECK (length(content) > 0),
      kind TEXT NOT NULL CHECK (
        kind IN ('preference', 'identity', 'context', 'knowledge', 'failure', 'note')
      ),
      statement_type TEXT NOT NULL CHECK (statement_type IN ('fact', 'plan', 'prediction')),
      temporal_type TEXT NOT NULL CHECK (
        temporal_type IN ('undated', 'point', 'interval', 'open_ended')
      ),
      scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'workspace')),
      scope_key TEXT,
      event_started_at INTEGER,
      event_ended_at INTEGER,
      observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
      lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'archived')),
      origin TEXT NOT NULL CHECK (origin IN ('agent_extracted', 'user_requested')),
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK (
        (scope_type = 'global' AND scope_key IS NULL)
        OR
        (scope_type = 'workspace' AND scope_key IS NOT NULL AND length(scope_key) > 0)
      ),
      CHECK (
        (temporal_type = 'undated'
          AND event_started_at IS NULL
          AND event_ended_at IS NULL)
        OR
        (temporal_type = 'point'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND (event_ended_at IS NULL OR event_ended_at > event_started_at))
        OR
        (temporal_type = 'interval'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND event_ended_at IS NOT NULL
          AND event_ended_at > event_started_at)
        OR
        (temporal_type = 'open_ended'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND event_ended_at IS NULL)
      ),
      CHECK (created_at <= updated_at),
      CHECK (observed_at <= updated_at)
    );

CREATE TABLE memory_settings (
    workspace_key TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK(version >= 1),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    auto_extract INTEGER NOT NULL CHECK(auto_extract IN (0, 1)),
    recall_enabled INTEGER NOT NULL CHECK(recall_enabled IN (0, 1))
  );

CREATE TABLE memory_write_operations (
      operation_id TEXT PRIMARY KEY,
      operation_type TEXT NOT NULL CHECK (
        operation_type IN ('create', 'update', 'archive', 'restore', 'batch', 'delete')
      ),
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
      result_json TEXT NOT NULL,
      committed_at INTEGER NOT NULL CHECK (committed_at >= 0)
    );

CREATE INDEX memory_write_operations_by_type ON memory_write_operations(operation_type);

CREATE INDEX memory_item_keys_by_normalized_key
      ON memory_item_keys(normalized_key, item_id);

CREATE INDEX memory_item_sources_by_event
      ON memory_item_sources(event_id, item_id);

CREATE INDEX memory_item_sources_by_turn
      ON memory_item_sources(session_id, turn_id, item_id);

CREATE INDEX memory_items_by_scope_and_lifecycle
      ON memory_items(scope_type, scope_key, lifecycle_state, updated_at DESC, item_id);
` +
  EXECUTION_LESSON_SCHEMA_SQL +
  EXECUTION_LEARNING_SCHEMA_SQL +
  TASK_EXPERIENCE_SCHEMA_SQL +
  MEMORY_CONSOLIDATION_SCHEMA_SQL;

const CURRENT_SCHEMA_SHAPE = {
  tables: [
    {
      name: "execution_lesson_candidates",
      requiredColumns: [
        "candidate_id",
        "workspace_key",
        "session_id",
        "state",
        "item_id",
        "record_json",
      ],
    },
    {
      name: "memory_compaction_policy_denials",
      requiredColumns: ["session_id", "compaction_checkpoint_id", "denied_at"],
    },
    {
      name: "memory_extraction_cursors",
      requiredColumns: ["session_id", "processed_ordinal", "updated_at"],
    },
    {
      name: "memory_extraction_failures",
      requiredColumns: [
        "session_id",
        "from_ordinal",
        "through_ordinal",
        "coverage_hash",
        "first_operation_id",
        "first_trigger",
        "compaction_checkpoint_id",
        "first_failure_class",
        "failed_at",
        "deletion_revision",
      ],
    },
    {
      name: "memory_extraction_receipts",
      requiredColumns: [
        "operation_id",
        "session_id",
        "request_hash",
        "result_json",
        "committed_at",
      ],
    },
    {
      name: "memory_item_keys",
      requiredColumns: ["item_id", "key_text", "normalized_key", "key_type", "key_origin"],
    },
    {
      name: "memory_item_sources",
      requiredColumns: ["item_id", "session_id", "run_id", "turn_id", "event_id"],
    },
    {
      name: "memory_items",
      requiredColumns: [
        "item_id",
        "version",
        "content",
        "kind",
        "statement_type",
        "temporal_type",
        "scope_type",
        "scope_key",
        "event_started_at",
        "event_ended_at",
        "observed_at",
        "lifecycle_state",
        "origin",
        "content_hash",
        "created_at",
        "updated_at",
      ],
    },
    {
      name: "memory_settings",
      requiredColumns: ["workspace_key", "version", "enabled", "auto_extract", "recall_enabled"],
    },
    {
      name: "memory_write_operations",
      requiredColumns: [
        "operation_id",
        "operation_type",
        "request_hash",
        "result_json",
        "committed_at",
      ],
    },
    {
      name: "memory_consolidation_state",
      requiredColumns: [
        "singleton",
        "last_committed_at",
        "lease_id",
        "lease_owner",
        "lease_until",
        "fencing_token",
        "lease_items_json",
      ],
    },
    {
      name: "memory_consolidation_receipts",
      requiredColumns: [
        "operation_id",
        "request_hash",
        "claim_id",
        "committed_at",
        "undo_expires_at",
        "undone_at",
        "result_json",
      ],
    },
  ],
  indexes: [
    {
      name: "memory_item_keys_by_normalized_key",
      tableName: "memory_item_keys",
      requiredColumnPrefix: ["normalized_key", "item_id"],
    },
    {
      name: "memory_consolidation_receipts_recent",
      tableName: "memory_consolidation_receipts",
      requiredColumnPrefix: ["committed_at", "operation_id"],
    },
  ],
};

export function configureSqliteLongTermMemoryDatabase(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS}`);
  ensureWalJournalMode(db);
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA secure_delete = ON");
}

export function initializeSqliteLongTermMemoryDatabase(db: DatabaseSync): void {
  assertSupportedSqliteLongTermMemorySchemaVersion(db);
  if (readSqliteLongTermMemorySchemaVersion(db) === SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) {
    validateMinimumSchemaShape(db);
    checkpointRetiredExecutionLessons(db);
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    // Another connection may have initialized while this writer waited.
    assertSupportedSqliteLongTermMemorySchemaVersion(db);
    const version = readSqliteLongTermMemorySchemaVersion(db);
    if (version < SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) {
      if (version === 0) {
        db.exec(CURRENT_SCHEMA_SQL);
        migrateExperienceFeedback(db);
      } else {
        validateMinimumSchemaShape(db, version !== 9);
        if (version === 9) db.exec(EXECUTION_LESSON_SCHEMA_SQL);
        if (version <= 10) db.exec(EXECUTION_LEARNING_SCHEMA_SQL);
        if (version <= 11) db.exec(TASK_EXPERIENCE_SCHEMA_SQL);
        if (version <= 12) migrateExperienceFeedback(db);
        if (version <= 14) db.exec(MEMORY_CONSOLIDATION_SCHEMA_SQL);
      }
      retireExecutionLessons(db);
      db.exec(`PRAGMA user_version = ${SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION}`);
    }
    validateMinimumSchemaShape(db);
    db.exec("COMMIT");
  } catch (error) {
    rollback(db);
    throw error;
  }
  checkpointRetiredExecutionLessons(db);
}

export function assertSupportedSqliteLongTermMemorySchemaVersion(db: DatabaseSync): void {
  const version = readSqliteLongTermMemorySchemaVersion(db);
  if (
    version !== 0 &&
    version !== 9 &&
    version !== 10 &&
    version !== 11 &&
    version !== 12 &&
    version !== 13 &&
    version !== 14 &&
    version !== SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION
  ) {
    throw new Error(
      `Long-term memory SQLite schema ${version} is unsupported; expected ${SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION}. Only schemas 9, 10, 11, 12, 13 and 14 can be upgraded automatically.`,
    );
  }
  if (
    version === 0 &&
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get() &&
    // A concurrent initializer may have committed since the first version read.
    readSqliteLongTermMemorySchemaVersion(db) === 0
  ) {
    throw new Error("Cannot initialize a non-empty unversioned memory database");
  }
}

export function readSqliteLongTermMemorySchemaVersion(db: DatabaseSync): number {
  return retryWhileSqliteBusy(() => {
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
    const value = row?.user_version;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error("Invalid long-term memory SQLite schema version");
    }
    return value;
  });
}

function readJournalMode(db: DatabaseSync): string {
  return retryWhileSqliteBusy(() => {
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
    if (typeof row?.journal_mode !== "string") {
      throw new Error("Invalid long-term memory SQLite journal mode");
    }
    return row.journal_mode.toLowerCase();
  });
}

function ensureWalJournalMode(db: DatabaseSync): void {
  const deadline = Date.now() + SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS;
  while (true) {
    const journalMode = readJournalMode(db);
    if (journalMode === "wal" || journalMode === "memory") return;
    try {
      db.exec("PRAGMA journal_mode = WAL");
      const configuredMode = readJournalMode(db);
      if (configuredMode !== "wal") {
        throw new Error(
          `Long-term memory SQLite requires WAL journal mode, received ${configuredMode}`,
        );
      }
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(
        initializationRetryGate,
        0,
        0,
        Math.min(SQLITE_INITIALIZATION_RETRY_DELAY_MS, Math.max(1, deadline - Date.now())),
      );
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "SQLITE_BUSY" || /database is locked/i.test(error.message);
}

function retryWhileSqliteBusy<T>(operation: () => T): T {
  const deadline = Date.now() + SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(
        initializationRetryGate,
        0,
        0,
        Math.min(SQLITE_INITIALIZATION_RETRY_DELAY_MS, Math.max(1, deadline - Date.now())),
      );
    }
  }
}

function validateMinimumSchemaShape(
  db: DatabaseSync,
  includeExecutionLessons = readSqliteLongTermMemorySchemaVersion(db) < 14,
): void {
  if (
    readSqliteLongTermMemorySchemaVersion(db) >= 14 &&
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name='execution_lesson_candidates'").get()
  )
    throw incompleteSchemaError("retired execution lesson table is still present");
  if (readSqliteLongTermMemorySchemaVersion(db) >= 11) {
    const learningTables: Record<string, readonly string[]> = {
      execution_learning_control: [
        "scope",
        "input_epoch",
        "management_revision",
        "resource_revision",
      ],
      execution_learning_admissions: [
        "admission_id",
        "workspace_key",
        "session_id",
        "run_id",
        "record_json",
      ],
      execution_learning_native_facts: [
        "admission_id",
        "tool_call_id",
        "prepared_event_id",
        "kind",
        "record_json",
      ],
      execution_learning_candidates: [
        "candidate_id",
        "workspace_key",
        "session_id",
        "run_id",
        "failure_key",
        "state",
        "revision",
        "item_id",
        "updated_at",
        "record_json",
      ],
      execution_learning_tickets: ["ticket_id", "candidate_id", "record_json", "result_json"],
      execution_learning_jobs: [
        "job_id",
        "workspace_key",
        "candidate_id",
        "state",
        "lease_until",
        "fencing_token",
        "updated_at",
        "record_json",
      ],
      execution_learning_tombstones: ["failure_key", "created_at"],
      execution_learning_attempts: ["failure_key", "workspace_key", "created_at"],
      execution_learning_items: [
        "item_id",
        "candidate_id",
        "item_content_hash",
        "source_type",
        "metadata_json",
      ],
    };
    for (const [name, required] of Object.entries(learningTables)) {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name))
        throw incompleteSchemaError(`missing required table ${name}`);
      const columns = new Set(
        db
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((row) => String(row.name)),
      );
      for (const column of required)
        if (!columns.has(column))
          throw incompleteSchemaError(`missing required column ${name}.${column}`);
    }
  }
  if (readSqliteLongTermMemorySchemaVersion(db) >= 12) {
    const experienceTables: Record<string, readonly string[]> = {
      task_experience_tasks: [
        "task_id",
        "workspace_key",
        "session_id",
        "task_version",
        "through_sequence",
        "updated_at",
        "record_json",
      ],
      task_experience_observations: ["observation_id", "task_id", "task_version", "record_json"],
      ...(readSqliteLongTermMemorySchemaVersion(db) === 12 ? { task_experience_reuse: ["reuse_id", "workspace_key", "session_id", "candidate_id", "content_version", "record_json"] } : {
        experience_uses: ["use_id", "workspace_key", "session_id", "item_id", "source_kind", "candidate_id", "record_json"],
        experience_effects: ["effect_id", "use_id", "outcome_event_id", "record_json"],
        experience_diagnostics: ["diagnostic_id", "workspace_key", "session_id", "created_at", "record_json"],
        experience_feedback: ["operation_id", "workspace_key", "use_id", "request_hash", "result_json", "created_at"],
      }),
      task_experience_actions: [
        "operation_id",
        "workspace_key",
        "candidate_id",
        "request_hash",
        "result_json",
        "created_at",
      ],
    };
    for (const [name, required] of Object.entries(experienceTables)) {
      const columns = new Set(
        db
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((row) => String(row.name)),
      );
      for (const column of required)
        if (!columns.has(column))
          throw incompleteSchemaError(`missing required column ${name}.${column}`);
    }
  }
  const shape = CURRENT_SCHEMA_SHAPE;
  const schemaVersion = readSqliteLongTermMemorySchemaVersion(db);
  const readSchemaObject = db.prepare("SELECT type, tbl_name FROM sqlite_schema WHERE name = ?");
  for (const table of shape.tables) {
    if (!includeExecutionLessons && table.name === "execution_lesson_candidates") continue;
    if (schemaVersion < 15 && table.name.startsWith("memory_consolidation_")) continue;
    const object = readSchemaObject.get(table.name) as
      | { type?: unknown; tbl_name?: unknown }
      | undefined;
    if (object?.type !== "table" || object.tbl_name !== table.name) {
      throw incompleteSchemaError(`missing required table ${table.name}`);
    }

    const columns = new Set(
      (
        db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(table.name)})`).all() as Array<{
          name?: unknown;
        }>
      )
        .map((row) => row.name)
        .filter((name): name is string => typeof name === "string"),
    );
    for (const column of table.requiredColumns) {
      if (!columns.has(column)) {
        throw incompleteSchemaError(`table ${table.name} is missing required column ${column}`);
      }
    }
  }

  for (const index of shape.indexes) {
    if (schemaVersion < 15 && index.tableName.startsWith("memory_consolidation_")) continue;
    const object = readSchemaObject.get(index.name) as
      | { type?: unknown; tbl_name?: unknown }
      | undefined;
    if (object?.type !== "index" || object.tbl_name !== index.tableName) {
      throw incompleteSchemaError(`missing required index ${index.name}`);
    }

    const columns = (
      db.prepare(`PRAGMA index_info(${quoteSqliteIdentifier(index.name)})`).all() as Array<{
        seqno?: unknown;
        name?: unknown;
      }>
    )
      .filter(
        (row): row is { seqno: number; name: string } =>
          typeof row.seqno === "number" && typeof row.name === "string",
      )
      .sort((left, right) => left.seqno - right.seqno)
      .map((row) => row.name);
    if (index.requiredColumnPrefix.some((column, position) => columns[position] !== column)) {
      throw incompleteSchemaError(`required index ${index.name} has incompatible columns`);
    }
  }
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function incompleteSchemaError(detail: string): Error {
  return new Error(`Incomplete long-term memory SQLite schema: ${detail}`);
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the initialization failure that triggered rollback.
  }
}
