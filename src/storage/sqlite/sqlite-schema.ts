import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { FileStorageIntegrityError } from "../local-file-storage.js";

/**
 * Scope 级 schema migration 框架(ADR 24 §3)。
 *
 * 每个 scope 一个 `Map<version, SQL>`;打开时自动逐级执行,单事务包住;版本注册于
 * `operational_schema_migrations`。防漂移王牌:在 :memory: 里跑全套迁移得到目标
 * schema,与实际库的 sqlite_schema 逐对象规范化 diff,任何缺/多/不一致都拒绝开库。
 */

export interface SqliteSchemaScope {
  readonly name: string;
  readonly migrations: ReadonlyMap<number, string>;
}

export function scopeCurrentVersion(scope: SqliteSchemaScope): number {
  let version = 0;
  for (const key of scope.migrations.keys()) version = Math.max(version, key);
  return version;
}

const REGISTRY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS operational_schema_migrations (
  scope TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
) WITHOUT ROWID;
`;

/**
 * Migrates every scope to its current version inside a single write
 * transaction. The version is re-read after BEGIN IMMEDIATE so concurrent
 * processes cannot double-run the same migration level.
 */
export function migrateOperationalDatabaseSync(
  database: DatabaseSync,
  scopes: readonly SqliteSchemaScope[],
): void {
  if (isCurrent(database, scopes)) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!isCurrent(database, scopes)) {
      database.exec(REGISTRY_TABLE_SQL);
      for (const scope of scopes) {
        const target = scopeCurrentVersion(scope);
        let version = readScopeVersion(database, scope.name);
        while (version < target) {
          const sql = scope.migrations.get(version + 1);
          if (sql === undefined) {
            throw new FileStorageIntegrityError(
              `SQLite schema scope ${scope.name} is missing migration to version ${version + 1}`,
            );
          }
          database.exec(sql);
          version += 1;
          database
            .prepare(
              `INSERT INTO operational_schema_migrations (scope, version, applied_at)
               VALUES (?, ?, ?)
               ON CONFLICT(scope) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`,
            )
            .run(scope.name, version, new Date().toISOString());
        }
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // 保留原始错误
    }
    throw error;
  }
}

/** Reads the applied version of every registered scope. */
export function readOperationalSchemaVersionsSync(
  database: DatabaseSync,
): ReadonlyMap<string, number> {
  const versions = new Map<string, number>();
  let registered: boolean;
  try {
    registered = !!database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'operational_schema_migrations'",
      )
      .get();
  } catch (error) {
    throw new FileStorageIntegrityError(
      `Failed to inspect operational schema registry: ${errorMessage(error)}`,
    );
  }
  if (!registered) return versions;
  const rows = database
    .prepare("SELECT scope, version FROM operational_schema_migrations")
    .all() as Array<{ scope: unknown; version: unknown }>;
  for (const row of rows) {
    if (typeof row.scope === "string" && typeof row.version === "number") {
      versions.set(row.scope, row.version);
    }
  }
  return versions;
}

/**
 * Asserts that the applied schema of every scope matches, object for object,
 * what running the full migration chain produces on a fresh database. Manual
 * tampering (dropped index, edited table) fails the open instead of silently
 * diverging.
 */
export function assertCurrentOperationalTargetSchemaSync(
  database: DatabaseSync,
  scopes: readonly SqliteSchemaScope[],
): void {
  const expected = collectSchemaObjects(freshMigratedDatabase(scopes));
  const actual = collectSchemaObjects(database);
  const problems: string[] = [];
  for (const [key, sql] of expected) {
    if (!actual.has(key)) problems.push(`missing ${key}`);
    else if (actual.get(key) !== sql) problems.push(`altered ${key}`);
  }
  for (const key of actual.keys()) {
    if (!expected.has(key)) problems.push(`unexpected ${key}`);
  }
  if (problems.length > 0) {
    throw new FileStorageIntegrityError(
      `Operational database schema drifted from the target schema: ${problems.join("; ")}`,
    );
  }
}

/**
 * Verifies a read-only connection: every scope must be registered at exactly
 * the version this binary expects. A newer database is refused rather than
 * silently read with older code.
 */
export function assertReadOnlySchemaIsCurrentSync(
  database: DatabaseSync,
  scopes: readonly SqliteSchemaScope[],
): void {
  const versions = readOperationalSchemaVersionsSync(database);
  if (versions.size === 0) {
    throw new FileStorageIntegrityError(
      "Operational database has no schema registry; it was not initialized by this storage engine",
    );
  }
  for (const scope of scopes) {
    const applied = versions.get(scope.name);
    const expected = scopeCurrentVersion(scope);
    if (applied === undefined) {
      throw new FileStorageIntegrityError(
        `SQLite schema scope ${scope.name} is not initialized in this database`,
      );
    }
    if (applied > expected) {
      throw new FileStorageIntegrityError(
        `SQLite schema scope ${scope.name} is at version ${applied}, newer than supported ${expected}; upgrade pico to read this database`,
      );
    }
    if (applied < expected) {
      throw new FileStorageIntegrityError(
        `SQLite schema scope ${scope.name} is at version ${applied}, older than required ${expected}; open it with a writable connection first to migrate`,
      );
    }
  }
}

function isCurrent(database: DatabaseSync, scopes: readonly SqliteSchemaScope[]): boolean {
  const versions = readOperationalSchemaVersionsSync(database);
  return scopes.every((scope) => versions.get(scope.name) === scopeCurrentVersion(scope));
}

function readScopeVersion(database: DatabaseSync, scope: string): number {
  let registered: boolean;
  try {
    registered = !!database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'operational_schema_migrations'",
      )
      .get();
  } catch {
    return 0;
  }
  if (!registered) return 0;
  const row = database
    .prepare("SELECT version FROM operational_schema_migrations WHERE scope = ?")
    .get(scope) as { version?: unknown } | undefined;
  return typeof row?.version === "number" ? row.version : 0;
}

function freshMigratedDatabase(scopes: readonly SqliteSchemaScope[]): DatabaseSync {
  const { DatabaseSync } = loadNodeSqliteForSchema();
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec(REGISTRY_TABLE_SQL);
    for (const scope of scopes) {
      for (const [version, sql] of sortedMigrations(scope)) {
        database.exec(sql);
        database
          .prepare(
            `INSERT INTO operational_schema_migrations (scope, version, applied_at)
             VALUES (?, ?, ?)
             ON CONFLICT(scope) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`,
          )
          .run(scope.name, version, new Date().toISOString());
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.close();
    } catch {
      // 保留原始错误
    }
    throw new FileStorageIntegrityError(
      `Target schema self-check failed to build: ${errorMessage(error)}`,
    );
  }
  return database;
}

function collectSchemaObjects(database: DatabaseSync): Map<string, string> {
  const rows = database
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Array<{ type: unknown; name: unknown; sql: unknown }>;
  const objects = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.type !== "string" || typeof row.name !== "string") continue;
    if (row.name === "operational_schema_migrations") continue;
    objects.set(`${row.type} ${row.name}`, normalizeSql(typeof row.sql === "string" ? row.sql : ""));
  }
  return objects;
}

function sortedMigrations(scope: SqliteSchemaScope): Array<[number, string]> {
  return [...scope.migrations.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Normalizes DDL for comparison: strips comments and collapses whitespace.
 * 自家生成的 DDL 统一小写关键字书写,这里不做大小写归一以保留检出力。
 */
function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let schemaNodeSqlite: typeof import("node:sqlite") | undefined;

function loadNodeSqliteForSchema(): typeof import("node:sqlite") {
  if (schemaNodeSqlite) return schemaNodeSqlite;
  const captured: unknown[] = [];
  const listener = (warning: unknown): void => {
    captured.push(warning);
  };
  process.on("warning", listener);
  try {
    const require = createRequire(import.meta.url);
    schemaNodeSqlite = require("node:sqlite") as typeof import("node:sqlite");
  } catch (error) {
    throw new FileStorageIntegrityError(
      `node:sqlite is unavailable in this Node runtime: ${errorMessage(error)}`,
    );
  } finally {
    process.off("warning", listener);
  }
  return schemaNodeSqlite;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
