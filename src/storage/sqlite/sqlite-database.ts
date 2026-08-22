import { createRequire } from "node:module";
import { chmodSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { FileStorageIntegrityError } from "../local-file-storage.js";

/**
 * Operational SQLite database engine (ADR 24).
 *
 * 每个存储根一个 pico.sqlite;进程内单连接 Owner + 引用计数 Lease,无连接池
 * (node:sqlite 是同步 API,单写连接 + WAL 已足够)。写事务 BEGIN IMMEDIATE,
 * 读事务 BEGIN(deferred),嵌套折叠;锁等待统一交给 busy_timeout。
 */

const BUSY_TIMEOUT_MS = 5_000;
const WAL_SWITCH_RETRY_DELAY_MS = 10;

export const OPERATIONAL_DATABASE_FILENAME = "pico.sqlite";

type NodeSqliteModule = typeof import("node:sqlite");

let nodeSqliteModule: NodeSqliteModule | undefined;

/**
 * node:sqlite 在 Node 22 上仍会打 ExperimentalWarning;动态加载并在加载窗口内
 * 捕获丢弃,避免每个进程启动都向 stderr 喷一条。
 */
function loadNodeSqlite(): NodeSqliteModule {
  if (nodeSqliteModule) return nodeSqliteModule;
  const captured: unknown[] = [];
  const listener = (warning: unknown): void => {
    captured.push(warning);
  };
  process.on("warning", listener);
  try {
    const require = createRequire(import.meta.url);
    nodeSqliteModule = require("node:sqlite") as NodeSqliteModule;
  } catch (error) {
    throw new FileStorageIntegrityError(
      `node:sqlite is unavailable in this Node runtime: ${errorMessage(error)}`,
    );
  } finally {
    process.off("warning", listener);
  }
  return nodeSqliteModule;
}

export type OperationalTransactionMode = "write" | "read";

export interface OperationalDatabaseLease {
  readonly storageRoot: string;
  readonly database: DatabaseSync;
  transaction<T>(mode: OperationalTransactionMode, operation: () => T): T;
  release(): void;
}

interface OperationalDatabaseOwner {
  readonly database: DatabaseSync;
  transaction<T>(mode: OperationalTransactionMode, operation: () => T): T;
}

const owners = new Map<string, OperationalDatabaseOwnerState>();

interface OperationalDatabaseOwnerState {
  readonly owner: OperationalDatabaseOwner;
  refCount: number;
}

export function operationalDatabasePath(storageRoot: string): string {
  return resolve(storageRoot, OPERATIONAL_DATABASE_FILENAME);
}

/**
 * Test support only: force-closes every open database owner in this process.
 * 供集成测试的临时目录清理使用——文件纪元的测试可以不关句柄直接 rm,SQLite
 * 纪元必须先放掉 pico.sqlite 句柄(Windows unlink EBUSY)。之后已关闭 owner
 * 对应的 lease.release() 会静默空转,对生产路径无影响。
 */
export function closeAllOperationalDatabasesForTest(): void {
  for (const state of owners.values()) {
    try {
      state.owner.database.close();
    } catch {
      // 已经关闭的连接直接忽略
    }
  }
  owners.clear();
}

/**
 * Acquires the process-wide singleton lease for the operational database under
 * `storageRoot`. The database is created, configured, and schema-migrated on
 * first acquisition; subsequent acquisitions share the same connection.
 */
export function acquireOperationalDatabase(
  storageRoot: string,
  options: { readonly migrate?: (database: DatabaseSync) => void } = {},
): OperationalDatabaseLease {
  const root = resolve(storageRoot);
  const existing = owners.get(root);
  if (existing) {
    existing.refCount += 1;
    return leaseFromOwner(root, existing.owner);
  }
  const { DatabaseSync } = loadNodeSqlite();
  const databasePath = operationalDatabasePath(root);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath);
    // node:sqlite creates a new database using the process umask (commonly 0644).
    // Tighten the authority file before WAL is enabled so SQLite sidecars inherit
    // the same private mode and sensitive runtime/memory state is never world-readable.
    chmodSync(databasePath, 0o600);
    configureOperationalDatabase(database);
    options.migrate?.(database);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // 保留原始错误
    }
    owners.delete(root);
    throw error;
  }
  const owner = createOwner(database);
  owners.set(root, { owner, refCount: 1 });
  return leaseFromOwner(root, owner);
}

/**
 * Opens an independent read-only connection. Never migrates: every schema scope
 * must already be at the version this binary expects, otherwise the open is
 * refused — a newer database must be read by a newer binary.
 */
export function openOperationalDatabaseReadOnly(storageRoot: string): DatabaseSync {
  const root = resolve(storageRoot);
  const databasePath = operationalDatabasePath(root);
  if (!existsSync(databasePath)) {
    throw new FileStorageIntegrityError(`Operational database is missing: ${databasePath}`);
  }
  const { DatabaseSync } = loadNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA query_only = ON");
  } catch (error) {
    try {
      database.close();
    } catch {
      // 保留原始错误
    }
    throw error;
  }
  return database;
}

/**
 * Writes a self-contained snapshot of the database to `destinationPath`
 * (which must not exist). The snapshot merges the WAL so the file stands alone.
 */
export function backupOperationalDatabaseSync(
  lease: OperationalDatabaseLease,
  destinationPath: string,
): void {
  const owner = owners.get(lease.storageRoot);
  if (!owner || owner.owner.database !== lease.database) {
    throw new FileStorageIntegrityError(
      `Operational database backup requires a live lease: ${lease.storageRoot}`,
    );
  }
  if (existsSync(destinationPath)) {
    throw new FileStorageIntegrityError(
      `Operational database backup destination already exists: ${destinationPath}`,
    );
  }
  lease.database.exec(`VACUUM INTO '${escapeSqlString(destinationPath)}'`);
}

function leaseFromOwner(root: string, owner: OperationalDatabaseOwner): OperationalDatabaseLease {
  let released = false;
  return {
    storageRoot: root,
    database: owner.database,
    transaction: <T>(mode: OperationalTransactionMode, operation: () => T): T =>
      owner.transaction(mode, operation),
    release(): void {
      if (released) return;
      released = true;
      const state = owners.get(root);
      if (!state || state.owner !== owner) return;
      state.refCount -= 1;
      if (state.refCount <= 0) {
        owners.delete(root);
        try {
          owner.database.close();
        } catch (error) {
          throw new FileStorageIntegrityError(
            `Failed to close operational database ${root}: ${errorMessage(error)}`,
          );
        }
      }
    },
  };
}

function createOwner(database: DatabaseSync): OperationalDatabaseOwner {
  let depth = 0;
  let activeMode: OperationalTransactionMode | undefined;
  return {
    database,
    transaction<T>(mode: OperationalTransactionMode, operation: () => T): T {
      if (depth > 0) {
        if (mode === "write" && activeMode === "read") {
          throw new FileStorageIntegrityError(
            "Cannot open a nested write transaction inside a read transaction",
          );
        }
        return operation();
      }
      database.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
      depth = 1;
      activeMode = mode;
      try {
        const result = operation();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // 保留原始错误
        }
        throw error;
      } finally {
        depth = 0;
        activeMode = undefined;
      }
    },
  };
}

function configureOperationalDatabase(database: DatabaseSync): void {
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  ensureWalJournalMode(database);
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA foreign_keys = ON");
  ensureSecureDelete(database);
}

function ensureSecureDelete(database: DatabaseSync): void {
  database.exec("PRAGMA secure_delete = ON");
  const row = database.prepare("PRAGMA secure_delete").get() as
    | { secure_delete?: unknown }
    | undefined;
  if (row?.secure_delete !== 1) {
    throw new FileStorageIntegrityError("Failed to enable SQLite secure_delete");
  }
}

/**
 * WAL is a persistent database property: freshly created databases get it set
 * once here; reopened databases only verify. The switch itself can hit
 * SQLITE_BUSY from a concurrent reader, so retry until the deadline.
 */
function ensureWalJournalMode(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA journal_mode").get() as
    | { journal_mode?: unknown }
    | undefined;
  const current = typeof row?.journal_mode === "string" ? row.journal_mode.toLowerCase() : "";
  if (current === "wal" || current === "memory") return;
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      database.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() > deadline) {
        throw new FileStorageIntegrityError(
          `Failed to enable WAL journal mode: ${errorMessage(error)}`,
        );
      }
      const shared = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(shared, 0, 0, WAL_SWITCH_RETRY_DELAY_MS);
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("busy") || message.includes("locked");
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
