import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { FileStorageIntegrityError, mkdirPrivateSync } from "../local-file-storage.js";
import {
  acquireOperationalDatabase,
  operationalDatabasePath,
  openOperationalDatabaseReadOnly,
  type OperationalDatabaseLease,
} from "./sqlite-database.js";
import {
  assertCurrentOperationalTargetSchemaSync,
  assertReadOnlySchemaIsCurrentSync,
  migrateOperationalDatabaseSync,
  type SqliteSchemaScope,
} from "./sqlite-schema.js";

/**
 * Workspace storage layout v3 — sqlite-centric-v1 (ADR 24 §2/§3)。
 *
 * 事实与控制数据全部住在存储根下的单一 pico.sqlite;身份绑定(storageRootId +
 * physicalIdentity)存在库内 binding 表,语义与 v2 layout.json 相同:拷贝到新物理
 * 目录后必须显��� adopt。旧 session-centric-v1(JSONL)布局 fail-closed 拒绝——
 * SQLite 纪元不做历史迁移,存量作废。
 */

export const WORKSPACE_SQLITE_STORAGE_LAYOUT = "sqlite-centric-v1";

/** v2 布局的 canonical 目录与协调器:出现任意一个即为旧纪元残留。 */
const LEGACY_SESSION_CENTRIC_MARKERS = [".storage", "sessions", "task-runs", "control"] as const;
const LEGACY_PRE_V2_DIRECTORY = "runtime";

const WORKSPACE_BINDING_SCOPE_NAME = "workspace";
const WORKSPACE_BINDING_SCOPE: SqliteSchemaScope = {
  name: WORKSPACE_BINDING_SCOPE_NAME,
  migrations: new Map<number, string>([
    [
      1,
      `
      CREATE TABLE workspace_storage_binding (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        layout TEXT NOT NULL,
        storage_root_id TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        device TEXT NOT NULL,
        inode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        adopted_at TEXT
      ) WITHOUT ROWID;
      `,
    ],
  ]),
};

export interface WorkspaceStorageRootIdentity {
  readonly storageRootId: string;
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
}

export type WorkspacePhysicalIdentity = Pick<
  WorkspaceStorageRootIdentity,
  "canonicalPath" | "device" | "inode"
>;

export interface WorkspaceSqliteStoragePreparation {
  readonly rootIdentity: WorkspaceStorageRootIdentity;
  readonly lease: OperationalDatabaseLease;
}

interface WorkspaceStorageBindingRow {
  readonly layout: string;
  readonly storage_root_id: string;
  readonly canonical_path: string;
  readonly device: string;
  readonly inode: string;
  readonly created_at: string;
  readonly adopted_at?: string;
}

/**
 * Combines caller-owned schema scopes with the workspace binding scope so that
 * migration and shape assertions always cover the full database.
 */
export function withWorkspaceBindingScope(
  scopes: readonly SqliteSchemaScope[],
): readonly SqliteSchemaScope[] {
  return [WORKSPACE_BINDING_SCOPE, ...scopes];
}

/**
 * Prepares (creates or verifies) the SQLite-era workspace storage. Refuses to
 * open legacy JSONL-era state: the SQLite era starts empty by decision.
 */
export function prepareWorkspaceSqliteStorageSync(
  workspaceRoot: string,
  scopes: readonly SqliteSchemaScope[] = [],
): WorkspaceSqliteStoragePreparation {
  const root = resolve(workspaceRoot);
  assertNoLegacyStorageSync(root);
  if (existsSync(root)) {
    requireRealDirectory(root, "Workspace storage root");
  } else {
    mkdirPrivateSync(root);
  }
  const allScopes = withWorkspaceBindingScope(scopes);
  const lease = acquireOperationalDatabase(root, {
    migrate: (database) => {
      // 形状断言只在版本推进(建库/升级)时跑:每次连接重开都重放全套 DDL
      // 要 ~25ms,高频操作级 lease 不可承受;常规漂移检测由 doctor 承担。
      if (migrateOperationalDatabaseSync(database, allScopes)) {
        assertCurrentOperationalTargetSchemaSync(database, allScopes);
      }
    },
  });
  try {
    const rootIdentity = ensureBindingSync(lease.database, root);
    return { rootIdentity, lease };
  } catch (error) {
    lease.release();
    throw error;
  }
}

/** Verifies the bound identity of an already-initialized root without opening a write path. */
export function assertWorkspaceSqliteStorageRootIdentitySync(
  workspaceRoot: string,
  expected: WorkspaceStorageRootIdentity,
  scopes: readonly SqliteSchemaScope[] = [],
): void {
  const identity = readWorkspaceSqliteStorageRootIdentitySync(workspaceRoot, scopes);
  if (!identity) {
    throw new FileStorageIntegrityError(
      `Workspace SQLite storage is not initialized: ${operationalDatabasePath(resolve(workspaceRoot))}`,
    );
  }
  if (
    identity.canonicalPath !== expected.canonicalPath ||
    identity.device !== expected.device ||
    identity.inode !== expected.inode
  ) {
    throw new FileStorageIntegrityError(
      `Workspace storage root identity changed: ${resolve(workspaceRoot)}; expected ${formatIdentity(
        expected,
      )}, received ${formatIdentity(identity)}`,
    );
  }
  if (identity.storageRootId !== expected.storageRootId) {
    throw new FileStorageIntegrityError(
      `Workspace storage root ID changed: expected ${expected.storageRootId}, received ${identity.storageRootId}`,
    );
  }
}

export function readWorkspaceSqliteStorageRootIdentitySync(
  workspaceRoot: string,
  scopes: readonly SqliteSchemaScope[] = [],
): WorkspaceStorageRootIdentity | undefined {
  const root = resolve(workspaceRoot);
  if (!existsSync(operationalDatabasePath(root))) return undefined;
  const database = openOperationalDatabaseReadOnly(root);
  try {
    assertReadOnlySchemaIsCurrentSync(database, withWorkspaceBindingScope(scopes));
    const binding = readBindingSync(database);
    if (!binding) return undefined;
    return identityFromBinding(binding);
  } finally {
    database.close();
  }
}

/**
 * Explicitly adopts a copied workspace root on its new physical directory while
 * preserving the stable storageRootId. Normal preparation never performs this
 * mutation implicitly (same contract as the v2 layout).
 */
export function adoptWorkspaceSqliteStorageRootSync(
  workspaceRoot: string,
  expectedStorageRootId: string,
  scopes: readonly SqliteSchemaScope[] = [],
): WorkspaceStorageRootIdentity {
  if (!expectedStorageRootId.trim()) {
    throw new Error("expectedStorageRootId must not be empty");
  }
  const root = resolve(workspaceRoot);
  if (!existsSync(root)) {
    throw new FileStorageIntegrityError(`Workspace storage root is missing: ${root}`);
  }
  requireRealDirectory(root, "Workspace storage root");
  const allScopes = withWorkspaceBindingScope(scopes);
  const lease = acquireOperationalDatabase(root, {
    migrate: (database) => {
      // 形状断言只在版本推进(建库/升级)时跑:每次连接重开都重放全套 DDL
      // 要 ~25ms,高频操作级 lease 不可承受;常规漂移检测由 doctor 承担。
      if (migrateOperationalDatabaseSync(database, allScopes)) {
        assertCurrentOperationalTargetSchemaSync(database, allScopes);
      }
    },
  });
  try {
    const binding = lease.transaction("write", () => {
      const existing = requireBindingSync(lease.database, root);
      if (existing.storage_root_id !== expectedStorageRootId) {
        throw new FileStorageIntegrityError(
          `Workspace storage root ID does not match explicit adoption request: ${operationalDatabasePath(root)}`,
        );
      }
      const physicalIdentity = currentPhysicalIdentity(root);
      lease.database
        .prepare(
          `UPDATE workspace_storage_binding
           SET canonical_path = ?, device = ?, inode = ?, adopted_at = ?
           WHERE singleton = 1`,
        )
        .run(
          physicalIdentity.canonicalPath,
          physicalIdentity.device,
          physicalIdentity.inode,
          new Date().toISOString(),
        );
      return requireBindingSync(lease.database, root);
    });
    return identityFromBinding(binding);
  } finally {
    lease.release();
  }
}

/**
 * Establishes the storage binding: the read path is transaction-free (a write
 * transaction per reopen would cost an fsync for nothing on hot paths); first
 * initialization opens one write transaction and re-reads under the write lock
 * so concurrent first opens converge on the winner. Must not be called inside
 * another transaction.
 */
function ensureBindingSync(database: DatabaseSync, root: string): WorkspaceStorageRootIdentity {
  const existing = readBindingSync(database);
  if (existing) {
    return verifyBindingIdentity(existing, root);
  }
  const physical = currentPhysicalIdentity(root);
  const storageRootId = randomUUID();
  database.exec("BEGIN IMMEDIATE");
  try {
    const raced = readBindingSync(database);
    if (raced) {
      const identity = verifyBindingIdentity(raced, root);
      database.exec("COMMIT");
      return identity;
    }
    database
      .prepare(
        `INSERT INTO workspace_storage_binding
         (singleton, layout, storage_root_id, canonical_path, device, inode, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        WORKSPACE_SQLITE_STORAGE_LAYOUT,
        storageRootId,
        physical.canonicalPath,
        physical.device,
        physical.inode,
        new Date().toISOString(),
      );
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // 保留原始错误
    }
    throw error;
  }
  return { storageRootId, ...physical };
}

function verifyBindingIdentity(
  binding: WorkspaceStorageBindingRow,
  root: string,
): WorkspaceStorageRootIdentity {
  const identity = identityFromBinding(binding);
  const actual = currentPhysicalIdentity(root);
  if (
    identity.canonicalPath !== actual.canonicalPath ||
    identity.device !== actual.device ||
    identity.inode !== actual.inode
  ) {
    throw new FileStorageIntegrityError(
      `Workspace storage root requires explicit adoption: ${operationalDatabasePath(
        root,
      )}; recorded ${formatIdentity(identity)}, received ${formatIdentity(actual)}`,
    );
  }
  return identity;
}

function assertNoLegacyStorageSync(root: string): void {
  if (!existsSync(root)) return;
  requireRealDirectory(root, "Workspace storage root");
  const legacyRuntime = join(root, LEGACY_PRE_V2_DIRECTORY);
  if (existsSync(legacyRuntime) && !isEmptyDirectory(legacyRuntime)) {
    throw new FileStorageIntegrityError(
      `Unsupported pre-v2 Runtime storage exists: ${legacyRuntime}; delete the obsolete Runtime state before initializing SQLite storage`,
    );
  }
  for (const marker of LEGACY_SESSION_CENTRIC_MARKERS) {
    const path = join(root, marker);
    if (!existsSync(path)) continue;
    requireRealDirectory(path, `Legacy workspace ${marker} directory`);
    // 目录存在即拒绝——空目录同样是 v2 初始化中断过的痕迹,不猜测归属。
    throw new FileStorageIntegrityError(
      `Legacy session-centric (JSONL) workspace storage exists: ${path}; the SQLite storage era does not migrate history — move the legacy state away or start a fresh workspace`,
    );
  }
}

function currentPhysicalIdentity(root: string): WorkspacePhysicalIdentity {
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new FileStorageIntegrityError(`Storage root must be a real directory: ${root}`);
  }
  const physical = statSync(root);
  return {
    canonicalPath: realpathSync.native(root),
    device: String(physical.dev),
    inode: String(physical.ino),
  };
}

function requireBindingSync(database: DatabaseSync, root: string): WorkspaceStorageBindingRow {
  const binding = readBindingSync(database);
  if (!binding) {
    throw new FileStorageIntegrityError(
      `Workspace storage binding is missing: ${operationalDatabasePath(root)}`,
    );
  }
  return binding;
}

function readBindingSync(database: DatabaseSync): WorkspaceStorageBindingRow | undefined {
  const row = database
    .prepare(
      "SELECT layout, storage_root_id, canonical_path, device, inode, created_at, adopted_at FROM workspace_storage_binding WHERE singleton = 1",
    )
    .get() as Record<string, unknown> | undefined;
  if (!row) return undefined;
  if (
    row["layout"] !== WORKSPACE_SQLITE_STORAGE_LAYOUT ||
    typeof row["storage_root_id"] !== "string" ||
    !row["storage_root_id"] ||
    typeof row["canonical_path"] !== "string" ||
    !row["canonical_path"] ||
    typeof row["device"] !== "string" ||
    !row["device"] ||
    typeof row["inode"] !== "string" ||
    !row["inode"] ||
    typeof row["created_at"] !== "string" ||
    !isOptionalSqliteString(row["adopted_at"])
  ) {
    throw new FileStorageIntegrityError("Invalid workspace storage binding row");
  }
  return {
    layout: row["layout"],
    storage_root_id: row["storage_root_id"],
    canonical_path: row["canonical_path"],
    device: row["device"],
    inode: row["inode"],
    created_at: row["created_at"],
    ...(typeof row["adopted_at"] === "string" ? { adoptedAt: row["adopted_at"] } : {}),
  } satisfies WorkspaceStorageBindingRow;
}

/** SQLite NULL surfaces as JS null — treat null and undefined as absent. */
function isOptionalSqliteString(value: unknown): boolean {
  return value == null || typeof value === "string";
}

function identityFromBinding(binding: WorkspaceStorageBindingRow): WorkspaceStorageRootIdentity {
  return {
    storageRootId: binding.storage_root_id,
    canonicalPath: binding.canonical_path,
    device: binding.device,
    inode: binding.inode,
  };
}

function requireRealDirectory(path: string, label: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new FileStorageIntegrityError(`${label} must be a real directory: ${path}`);
  }
}

function isEmptyDirectory(path: string): boolean {
  return readdirSync(path).length === 0;
}

function formatIdentity(identity: {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
}): string {
  return `${identity.canonicalPath} (${identity.device}:${identity.inode})`;
}
