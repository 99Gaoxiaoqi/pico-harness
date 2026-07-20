import type Database from "better-sqlite3";
import type { WorkspaceId } from "../paths/pico-paths.js";
import {
  FACT_STATES,
  MEMORY_JOB_STATUSES,
  MEMORY_KINDS,
  MUTATION_ACTIONS,
  MUTATION_ENTITY_TYPES,
  PROPOSAL_STATUSES,
  PROPOSAL_CONFLICT_STATUSES,
  SOURCE_AVAILABILITIES,
} from "./domain.js";

export const MEMORY_SCHEMA_VERSION = 2;
export const MEMORY_SCHEMA_CURRENT_MIGRATION_NAME = "secure_delete_checkpoint_state" as const;
const MEMORY_SCHEMA_V1_MIGRATION_NAME = "workspace_memory_foundation" as const;

export class MemorySchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemorySchemaVersionError";
  }
}

export class MemoryWorkspaceMismatchError extends Error {
  constructor(
    readonly expectedWorkspaceId: WorkspaceId,
    readonly actualWorkspaceId: string,
  ) {
    super(`memory.sqlite belongs to workspace ${actualWorkspaceId}, not ${expectedWorkspaceId}`);
    this.name = "MemoryWorkspaceMismatchError";
  }
}

interface MigrationRow {
  readonly version: unknown;
  readonly name: unknown;
}

/** Owns the independent memory.sqlite schema and binds it to exactly one workspace. */
export function migrateMemorySchema(
  db: Database.Database,
  workspaceId: WorkspaceId,
  now: () => string,
): void {
  db.transaction(() => {
    const migrationTableExists = hasTable(db, "memory_schema_migrations");
    const latest = migrationTableExists
      ? (db
          .prepare(
            "SELECT version, name FROM memory_schema_migrations ORDER BY version DESC LIMIT 1",
          )
          .get() as MigrationRow | undefined)
      : undefined;
    const current = parseSupportedVersion(latest);

    // Inspect and reject future or incompatible schemas before executing any DDL or data writes.
    if (current > MEMORY_SCHEMA_VERSION) {
      throw new MemorySchemaVersionError(
        `memory.sqlite schema ${current} is newer than supported version ${MEMORY_SCHEMA_VERSION}`,
      );
    }
    const expectedName = migrationNameForVersion(current);
    if (expectedName && latest?.name !== expectedName) {
      throw new MemorySchemaVersionError(
        `memory.sqlite schema ${current} migration ${String(latest?.name)} is unsupported`,
      );
    }

    if (current < 1) {
      db.exec(SCHEMA_V1);
      db.prepare(
        "INSERT INTO memory_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
      ).run(1, MEMORY_SCHEMA_V1_MIGRATION_NAME, now());
    }
    if (current < 2) {
      db.exec(SCHEMA_V2);
      db.prepare(
        "INSERT INTO memory_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
      ).run(2, MEMORY_SCHEMA_CURRENT_MIGRATION_NAME, now());
    }

    bindWorkspace(db, workspaceId, now);
  }).immediate();
}

function parseSupportedVersion(row: MigrationRow | undefined): number {
  if (!row) return 0;
  if (
    !Number.isSafeInteger(row.version) ||
    (row.version as number) < 0 ||
    typeof row.name !== "string" ||
    row.name.length === 0
  ) {
    throw new MemorySchemaVersionError("memory.sqlite has an invalid schema migration record");
  }
  return row.version as number;
}

function bindWorkspace(db: Database.Database, workspaceId: WorkspaceId, now: () => string): void {
  const existing = db.prepare("SELECT workspace_id FROM memory_workspace LIMIT 1").get() as
    | { readonly workspace_id: string }
    | undefined;
  if (existing && existing.workspace_id !== workspaceId) {
    throw new MemoryWorkspaceMismatchError(workspaceId, existing.workspace_id);
  }
  if (!existing) {
    db.prepare("INSERT INTO memory_workspace(workspace_id, created_at) VALUES (?, ?)").run(
      workspaceId,
      now(),
    );
    db.prepare(
      `INSERT INTO memory_settings(
       workspace_id, enabled, auto_propose, auto_commit, injection_enabled, version, updated_at
       ) VALUES (?, 1, 1, 0, 1, 1, ?)`,
    ).run(workspaceId, now());
  }
  db.prepare(
    `INSERT OR IGNORE INTO memory_maintenance(
       workspace_id, secure_delete_pending, requested_at, updated_at
     ) VALUES (?, 0, NULL, ?)`,
  ).run(workspaceId, now());
}

function migrationNameForVersion(version: number): string | undefined {
  if (version === 1) return MEMORY_SCHEMA_V1_MIGRATION_NAME;
  if (version === 2) return MEMORY_SCHEMA_CURRENT_MIGRATION_NAME;
  return undefined;
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function sqlValues(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
}

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS memory_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE memory_workspace (
    workspace_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  CREATE TABLE memory_settings (
    workspace_id TEXT PRIMARY KEY REFERENCES memory_workspace(workspace_id) ON DELETE RESTRICT,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    auto_propose INTEGER NOT NULL CHECK (auto_propose IN (0, 1)),
    auto_commit INTEGER NOT NULL CHECK (auto_commit IN (0, 1)),
    injection_enabled INTEGER NOT NULL CHECK (injection_enabled IN (0, 1)),
    version INTEGER NOT NULL CHECK (version > 0),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE memory_sources (
    source_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES memory_workspace(workspace_id) ON DELETE RESTRICT,
    session_id TEXT NOT NULL,
    run_id TEXT,
    branch_id TEXT,
    event_ids_json TEXT NOT NULL,
    start_sequence INTEGER CHECK (start_sequence IS NULL OR start_sequence > 0),
    end_sequence INTEGER CHECK (end_sequence IS NULL OR end_sequence > 0),
    digest TEXT NOT NULL,
    availability TEXT NOT NULL CHECK (availability IN (${sqlValues(SOURCE_AVAILABILITIES)})),
    invalidated_at TEXT,
    invalidation_code TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (start_sequence IS NULL OR end_sequence IS NULL OR start_sequence <= end_sequence),
    CHECK (
      (availability = 'available' AND invalidated_at IS NULL AND invalidation_code IS NULL)
      OR
      (availability <> 'available' AND invalidated_at IS NOT NULL AND invalidation_code IS NOT NULL)
    )
  );
  CREATE INDEX memory_sources_session_idx
    ON memory_sources(workspace_id, session_id, created_at, source_id);

  CREATE TABLE memory_facts (
    fact_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES memory_workspace(workspace_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN (${sqlValues(MEMORY_KINDS)})),
    title TEXT,
    content TEXT,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    source_id TEXT REFERENCES memory_sources(source_id) ON DELETE SET NULL,
    state TEXT NOT NULL CHECK (state IN (${sqlValues(FACT_STATES)})),
    pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
    expires_at TEXT,
    last_used_at TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    forgotten_at TEXT,
    CHECK (
      (state <> 'forgotten' AND title IS NOT NULL AND content IS NOT NULL AND forgotten_at IS NULL)
      OR
      (state = 'forgotten' AND title IS NULL AND content IS NULL AND forgotten_at IS NOT NULL)
    )
  );
  CREATE INDEX memory_facts_active_idx
    ON memory_facts(workspace_id, state, kind, updated_at, fact_id);

  CREATE TABLE memory_proposals (
    proposal_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES memory_workspace(workspace_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN (${sqlValues(MEMORY_KINDS)})),
    title TEXT,
    content TEXT,
    reason TEXT,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    source_id TEXT REFERENCES memory_sources(source_id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(PROPOSAL_STATUSES)})),
    conflict_status TEXT NOT NULL CHECK (conflict_status IN (${sqlValues(PROPOSAL_CONFLICT_STATUSES)})),
    conflict_fact_id TEXT REFERENCES memory_facts(fact_id) ON DELETE SET NULL,
    resolved_fact_id TEXT REFERENCES memory_facts(fact_id) ON DELETE SET NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reviewed_at TEXT,
    deleted_at TEXT,
    CHECK (
      (status = 'deleted' AND title IS NULL AND content IS NULL AND reason IS NULL AND deleted_at IS NOT NULL)
      OR
      (status <> 'deleted' AND title IS NOT NULL AND content IS NOT NULL AND reason IS NOT NULL AND deleted_at IS NULL)
    )
  );
  CREATE INDEX memory_proposals_status_idx
    ON memory_proposals(workspace_id, status, created_at, proposal_id);

  CREATE TABLE memory_jobs (
    job_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES memory_workspace(workspace_id) ON DELETE RESTRICT,
    type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(MEMORY_JOB_STATUSES)})),
    terminal_event_id TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    cursor_json TEXT NOT NULL,
    source_id TEXT REFERENCES memory_sources(source_id) ON DELETE SET NULL,
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
    next_attempt_at TEXT,
    error_code TEXT,
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cost_usd REAL NOT NULL CHECK (cost_usd >= 0),
    version INTEGER NOT NULL CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    terminal_at TEXT,
    UNIQUE (workspace_id, terminal_event_id, extractor_version)
  );
  CREATE INDEX memory_jobs_status_idx
    ON memory_jobs(workspace_id, status, created_at, job_id);

  CREATE TABLE memory_mutations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    mutation_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL REFERENCES memory_workspace(workspace_id) ON DELETE RESTRICT,
    entity_type TEXT NOT NULL CHECK (entity_type IN (${sqlValues(MUTATION_ENTITY_TYPES)})),
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN (${sqlValues(MUTATION_ACTIONS)})),
    from_version INTEGER,
    to_version INTEGER NOT NULL CHECK (to_version > 0),
    idempotency_key_hash TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX memory_mutations_entity_idx
    ON memory_mutations(workspace_id, entity_type, entity_id, sequence);

  CREATE TABLE memory_idempotency (
    workspace_id TEXT NOT NULL REFERENCES memory_workspace(workspace_id) ON DELETE RESTRICT,
    operation TEXT NOT NULL,
    idempotency_key_hash TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, operation, idempotency_key_hash)
  );
`;

const SCHEMA_V2 = `
  CREATE TABLE memory_maintenance (
    workspace_id TEXT PRIMARY KEY REFERENCES memory_workspace(workspace_id) ON DELETE RESTRICT,
    secure_delete_pending INTEGER NOT NULL CHECK (secure_delete_pending IN (0, 1)),
    requested_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK (
      (secure_delete_pending = 0 AND requested_at IS NULL)
      OR
      (secure_delete_pending = 1 AND requested_at IS NOT NULL)
    )
  );
`;
