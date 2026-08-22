import type { DatabaseSync } from "node:sqlite";
import { FileStorageIntegrityError } from "../local-file-storage.js";

export const SQLITE_RETENTION_VACUUM_RECLAIMED_BYTES = 256 * 1024 * 1024;
export const SQLITE_RETENTION_VACUUM_FREELIST_RATIO = 0.25;

export interface SqliteRetentionMaintenanceOptions {
  readonly estimatedLogicalBytesReclaimed: number;
}

export type SqliteRetentionVacuumTrigger = "none" | "logical_bytes" | "freelist_ratio" | "both";

export interface SqliteRetentionMaintenanceResult {
  readonly vacuumed: boolean;
  readonly vacuumTrigger: SqliteRetentionVacuumTrigger;
  readonly pageCountBeforeVacuum: number;
  readonly freelistCountBeforeVacuum: number;
  readonly freelistRatioBeforeVacuum: number;
}

/**
 * Runs only after a deletion batch has committed and the connection is idle.
 * The helper checkpoints first, then performs the expensive physical rewrite
 * only when the logical or physical reclamation threshold is reached.
 */
export function runIdleSqliteRetentionMaintenance(
  database: DatabaseSync,
  options: SqliteRetentionMaintenanceOptions,
): SqliteRetentionMaintenanceResult {
  requireNonNegativeSafeInteger(
    options.estimatedLogicalBytesReclaimed,
    "estimatedLogicalBytesReclaimed",
  );
  if (database.isTransaction) {
    throw new FileStorageIntegrityError(
      "SQLite retention maintenance requires an idle connection outside a transaction",
    );
  }

  truncateWal(database);
  const pageCount = readPragmaInteger(database, "page_count");
  const freelistCount = readPragmaInteger(database, "freelist_count");
  if (freelistCount > pageCount) {
    throw new FileStorageIntegrityError(
      `SQLite freelist_count ${freelistCount} exceeds page_count ${pageCount}`,
    );
  }
  const freelistRatio = pageCount === 0 ? 0 : freelistCount / pageCount;
  const logicalThresholdReached =
    options.estimatedLogicalBytesReclaimed >= SQLITE_RETENTION_VACUUM_RECLAIMED_BYTES;
  const freelistThresholdReached = freelistRatio >= SQLITE_RETENTION_VACUUM_FREELIST_RATIO;
  const vacuumTrigger = resolveVacuumTrigger(logicalThresholdReached, freelistThresholdReached);
  if (vacuumTrigger !== "none") {
    database.exec("VACUUM");
    truncateWal(database);
  }

  return {
    vacuumed: vacuumTrigger !== "none",
    vacuumTrigger,
    pageCountBeforeVacuum: pageCount,
    freelistCountBeforeVacuum: freelistCount,
    freelistRatioBeforeVacuum: freelistRatio,
  };
}

function truncateWal(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
    | { busy?: unknown }
    | undefined;
  if (row?.busy !== 0) {
    throw new FileStorageIntegrityError(
      `SQLite WAL truncate checkpoint did not complete while idle (busy=${String(row?.busy)})`,
    );
  }
}

function readPragmaInteger(
  database: DatabaseSync,
  pragma: "page_count" | "freelist_count",
): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row?.[pragma];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new FileStorageIntegrityError(`SQLite PRAGMA ${pragma} returned an invalid value`);
  }
  return value;
}

function resolveVacuumTrigger(
  logicalThresholdReached: boolean,
  freelistThresholdReached: boolean,
): SqliteRetentionVacuumTrigger {
  if (logicalThresholdReached && freelistThresholdReached) return "both";
  if (logicalThresholdReached) return "logical_bytes";
  if (freelistThresholdReached) return "freelist_ratio";
  return "none";
}

function requireNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}
