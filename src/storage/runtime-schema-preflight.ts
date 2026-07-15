import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import {
  RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME,
  RUNTIME_SCHEMA_VERSION,
} from "../tasks/runtime-types.js";

export { RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME, RUNTIME_SCHEMA_VERSION };

export const RUNTIME_SCHEMA_PREFLIGHT_STATUSES = [
  "database_missing",
  "schema_migrations_missing",
  "outdated",
  "current",
  "current_migration_name_mismatch",
  "future",
  "invalid",
] as const;

export type RuntimeSchemaPreflightStatus = (typeof RUNTIME_SCHEMA_PREFLIGHT_STATUSES)[number];

export interface RuntimeSchemaTablePresence {
  readonly schemaMigrations: boolean;
  readonly agentSessions: boolean;
  readonly agentRuntimeEvents: boolean;
}

interface RuntimeSchemaPreflightBase {
  readonly databasePath: string;
  readonly status: RuntimeSchemaPreflightStatus;
}

interface RuntimeSchemaInspectedBase extends RuntimeSchemaPreflightBase {
  readonly tables: RuntimeSchemaTablePresence;
}

export type RuntimeSchemaPreflightResult =
  | (RuntimeSchemaPreflightBase & {
      readonly status: "database_missing";
    })
  | (RuntimeSchemaPreflightBase & {
      readonly status: "invalid";
      readonly reason: string;
    })
  | (RuntimeSchemaInspectedBase & {
      readonly status: "schema_migrations_missing";
    })
  | (RuntimeSchemaInspectedBase & {
      readonly status: "outdated";
      readonly schemaVersion: number;
      readonly migrationName: string | null;
    })
  | (RuntimeSchemaInspectedBase & {
      readonly status: "current";
      readonly schemaVersion: number;
      readonly migrationName: typeof RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME;
    })
  | (RuntimeSchemaInspectedBase & {
      readonly status: "current_migration_name_mismatch";
      readonly schemaVersion: number;
      readonly migrationName: string;
      readonly expectedMigrationName: typeof RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME;
    })
  | (RuntimeSchemaInspectedBase & {
      readonly status: "future";
      readonly schemaVersion: number;
      readonly migrationName: string;
    });

interface MigrationRow {
  readonly version: unknown;
  readonly name: unknown;
}

/**
 * Inspects runtime.sqlite through a file-must-exist, read-only connection. This function
 * intentionally performs no PRAGMA mutation, DDL, migration, directory creation, or WAL setup.
 */
export function preflightRuntimeSchema(databasePath: string): RuntimeSchemaPreflightResult {
  const canonicalDatabasePath = resolve(databasePath);
  if (!existsSync(canonicalDatabasePath)) {
    return { databasePath: canonicalDatabasePath, status: "database_missing" };
  }

  let database: Database.Database | undefined;
  try {
    database = new Database(canonicalDatabasePath, { readonly: true, fileMustExist: true });
    database.pragma("busy_timeout = 5000");
    return preflightOpenedRuntimeSchema(database, canonicalDatabasePath);
  } catch (error) {
    return invalidSchemaResult(canonicalDatabasePath, error);
  } finally {
    database?.close();
  }
}

/** Inspects an already-open connection before its caller enables WAL, runs DDL, or writes. */
export function preflightOpenedRuntimeSchema(
  database: Database.Database,
  databasePath: string,
): RuntimeSchemaPreflightResult {
  const canonicalDatabasePath = resolve(databasePath);
  try {
    const tableNames = new Set(
      (
        database
          .prepare(
            `SELECT name
             FROM sqlite_master
             WHERE type = 'table'
               AND name IN ('schema_migrations', 'agent_sessions', 'agent_runtime_events')`,
          )
          .all() as Array<{ readonly name: string }>
      ).map(({ name }) => name),
    );
    const tables: RuntimeSchemaTablePresence = {
      schemaMigrations: tableNames.has("schema_migrations"),
      agentSessions: tableNames.has("agent_sessions"),
      agentRuntimeEvents: tableNames.has("agent_runtime_events"),
    };

    if (!tables.schemaMigrations) {
      return {
        databasePath: canonicalDatabasePath,
        status: "schema_migrations_missing",
        tables,
      };
    }

    const migration = database
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1")
      .get() as MigrationRow | undefined;
    if (!migration) {
      return {
        databasePath: canonicalDatabasePath,
        status: "outdated",
        tables,
        schemaVersion: 0,
        migrationName: null,
      };
    }
    if (
      !Number.isSafeInteger(migration.version) ||
      (migration.version as number) < 0 ||
      typeof migration.name !== "string" ||
      migration.name.length === 0
    ) {
      return {
        databasePath: canonicalDatabasePath,
        status: "invalid",
        reason: `Invalid latest runtime schema migration: version=${String(migration.version)} name=${String(migration.name)}`,
      };
    }

    const schemaVersion = migration.version as number;
    if (schemaVersion < RUNTIME_SCHEMA_VERSION) {
      return {
        databasePath: canonicalDatabasePath,
        status: "outdated",
        tables,
        schemaVersion,
        migrationName: migration.name,
      };
    }
    if (schemaVersion > RUNTIME_SCHEMA_VERSION) {
      return {
        databasePath: canonicalDatabasePath,
        status: "future",
        tables,
        schemaVersion,
        migrationName: migration.name,
      };
    }
    if (migration.name !== RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME) {
      return {
        databasePath: canonicalDatabasePath,
        status: "current_migration_name_mismatch",
        tables,
        schemaVersion,
        migrationName: migration.name,
        expectedMigrationName: RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME,
      };
    }
    return {
      databasePath: canonicalDatabasePath,
      status: "current",
      tables,
      schemaVersion,
      migrationName: RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME,
    };
  } catch (error) {
    return invalidSchemaResult(canonicalDatabasePath, error);
  }
}

function invalidSchemaResult(databasePath: string, error: unknown): RuntimeSchemaPreflightResult {
  return {
    databasePath,
    status: "invalid",
    reason: error instanceof Error ? error.message : String(error),
  };
}
