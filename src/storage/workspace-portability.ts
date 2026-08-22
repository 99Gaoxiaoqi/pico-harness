import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { OPERATIONAL_DATABASE_FILENAME } from "./sqlite/sqlite-database.js";
import { readWorkspaceSqliteStorageRootIdentitySync } from "./sqlite/sqlite-workspace-storage.js";
import type { WorkspaceStorageRootIdentity } from "./sqlite/sqlite-workspace-storage.js";

/**
 * SQLite 纪元的 workspace 导出计划(票 09 重写,ADR 24 §5/M6 + 决策 5)。
 *
 * 分类策略(2026-08-19 用户裁定):
 * - pico.sqlite = **protected**——会话历史(旧 portable)与 memory 敏感数据
 *   (旧 protected)合并进了同一个文件,原 memory protected 语义落到库整体:
 *   不哈希、不进导出集。迁移工作区应使用 SQLite backup(VACUUM INTO 自包含
 *   副本),而不是文件级导出计划。
 * - portable 集 = blob 目录(evidence/blobs/sha256 CAS)与 traces;host_bound =
 *   WAL/SHM 边车、fork-staging、plugins/hooks workspace 态、恢复 intent;
 * - 旧 JSONL 纪元条目(sessions/task-runs/control/.storage/memory/
 *   storage-operations/todo.json)按 legacy 归类,不再是 canonical 载体;
 * - 未知条目仍 fail-closed:新增持久面必须显式登记分类。
 */

export const WORKSPACE_PORTABILITY_PLAN_SCHEMA_VERSION = 2 as const;

export const WORKSPACE_PORTABILITY_CLASSIFICATIONS = [
  "portable",
  "host_bound",
  "protected",
] as const;
export type WorkspacePortabilityClassification =
  (typeof WORKSPACE_PORTABILITY_CLASSIFICATIONS)[number];

export const WORKSPACE_PORTABILITY_REASONS = [
  "portable_evidence",
  "portable_trace",
  "workspace_database_with_memory",
  "legacy_runtime_history",
  "legacy_task_history",
  "legacy_control_state",
  "legacy_memory_state",
  "legacy_storage_operation_state",
  "legacy_workspace_todo_state",
  "legacy_pre_v2_state",
  "ephemeral_fork_state",
  "workspace_plugin_state",
  "workspace_hook_state",
  "agent_recovery_intent_state",
  "debug_log_may_contain_sensitive_data",
  "credential_or_secret_material",
  "database_or_journal_file",
  "lock_or_commit_state",
  "temporary_file",
] as const;
export type WorkspacePortabilityReason = (typeof WORKSPACE_PORTABILITY_REASONS)[number];

export const WORKSPACE_PORTABILITY_ERROR_CODES = [
  "invalid_storage_root",
  "path_escape",
  "symbolic_link",
  "special_file",
  "unknown_top_level_entry",
  "invalid_ledger_entry",
  "file_changed_during_scan",
  "file_too_large",
] as const;
export type WorkspacePortabilityErrorCode = (typeof WORKSPACE_PORTABILITY_ERROR_CODES)[number];

export interface WorkspacePortabilityPlanEntry {
  readonly relativePath: string;
  readonly size: number;
  /**
   * Only portable payloads are hashed. Excluded local or protected files deliberately use null so
   * the audit plan does not persist a credential-derived fingerprint.
   */
  readonly sha256: string | null;
  readonly classification: WorkspacePortabilityClassification;
  readonly reason: WorkspacePortabilityReason;
}

export interface WorkspacePortabilityPlan {
  readonly schemaVersion: typeof WORKSPACE_PORTABILITY_PLAN_SCHEMA_VERSION;
  readonly storageRoot: string;
  readonly entries: readonly WorkspacePortabilityPlanEntry[];
  readonly portableFileCount: number;
  readonly excludedFileCount: number;
  readonly portableBytes: number;
}

export class WorkspacePortabilityPlanError extends Error {
  override readonly name = "WorkspacePortabilityPlanError";

  constructor(
    readonly code: WorkspacePortabilityErrorCode,
    readonly relativePath: string,
    message: string,
  ) {
    super(message);
  }
}

interface PathPolicy {
  readonly classification: WorkspacePortabilityClassification;
  readonly reason: WorkspacePortabilityReason;
}

/**
 * pico.sqlite 携带 memory 敏感数据(旧 memory/state.json 的 protected 语义
 * 落到库整体):不哈希、不进 portable 导出集;迁移用 SQLite backup。
 */
const WORKSPACE_DATABASE_POLICY = Object.freeze({
  classification: "protected",
  reason: "workspace_database_with_memory",
}) satisfies PathPolicy;

const PORTABLE_TOP_LEVEL_POLICIES = new Map<string, PathPolicy>([
  [
    "evidence",
    {
      classification: "portable",
      reason: "portable_evidence",
    },
  ],
  [
    "traces",
    {
      classification: "portable",
      reason: "portable_trace",
    },
  ],
]);

const HOST_BOUND_TOP_LEVEL_DIRECTORIES = new Map<string, PathPolicy>([
  ["fork-staging", { classification: "host_bound", reason: "ephemeral_fork_state" }],
  [
    "agent-recovery-launch-intents",
    { classification: "host_bound", reason: "agent_recovery_intent_state" },
  ],
]);

/** 旧 session-centric(JSONL)纪元的 canonical 条目:已知 legacy,不再 fail-closed。 */
const LEGACY_TOP_LEVEL_DIRECTORIES = new Map<string, PathPolicy>([
  ["sessions", { classification: "host_bound", reason: "legacy_runtime_history" }],
  ["task-runs", { classification: "host_bound", reason: "legacy_task_history" }],
  ["control", { classification: "host_bound", reason: "legacy_control_state" }],
  ["memory", { classification: "protected", reason: "legacy_memory_state" }],
  [
    "storage-operations",
    { classification: "host_bound", reason: "legacy_storage_operation_state" },
  ],
  [".storage", { classification: "host_bound", reason: "legacy_control_state" }],
  ["runtime", { classification: "host_bound", reason: "legacy_pre_v2_state" }],
  ["tasks", { classification: "host_bound", reason: "legacy_pre_v2_state" }],
]);

const LEGACY_TOP_LEVEL_FILES = new Map<string, PathPolicy>([
  ["todo.json", { classification: "host_bound", reason: "legacy_workspace_todo_state" }],
]);

const HOST_BOUND_TOP_LEVEL_FILES = new Map<string, PathPolicy>([
  ["plugins.json", { classification: "host_bound", reason: "workspace_plugin_state" }],
  ["hooks-state.json", { classification: "host_bound", reason: "workspace_hook_state" }],
  [
    "tui-debug.log",
    {
      classification: "protected",
      reason: "debug_log_may_contain_sensitive_data",
    },
  ],
]);

const LOCK_OR_COMMIT_POLICY = Object.freeze({
  classification: "host_bound",
  reason: "lock_or_commit_state",
}) satisfies PathPolicy;
const TEMPORARY_FILE_POLICY = Object.freeze({
  classification: "host_bound",
  reason: "temporary_file",
}) satisfies PathPolicy;
const PROTECTED_SECRET_POLICY = Object.freeze({
  classification: "protected",
  reason: "credential_or_secret_material",
}) satisfies PathPolicy;
const PROTECTED_DATABASE_POLICY = Object.freeze({
  classification: "protected",
  reason: "database_or_journal_file",
}) satisfies PathPolicy;

/**
 * Builds a deterministic, read-only export plan for one Pico workspace storage root.
 *
 * The function never copies data and never follows symbolic links. It verifies the
 * pico.sqlite workspace binding before hashing a consistent snapshot. Unknown
 * top-level entries fail closed so adding a new persistence surface requires an
 * explicit portability decision.
 */
export function buildWorkspacePortabilityPlanSync(storageRoot: string): WorkspacePortabilityPlan {
  const requestedRoot = resolve(storageRoot);
  const rootMetadata = lstatRoot(requestedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw planError(
      "invalid_storage_root",
      ".",
      `Workspace storage root must be a real directory: ${requestedRoot}`,
    );
  }

  let root: string;
  try {
    root = resolvePath(requestedRoot);
  } catch (error) {
    throw planError(
      "invalid_storage_root",
      ".",
      `Workspace storage root cannot be resolved: ${requestedRoot}`,
      error,
    );
  }
  let rootIdentity: WorkspaceStorageRootIdentity | undefined;
  try {
    rootIdentity = readWorkspaceSqliteStorageRootIdentitySync(root);
  } catch (error) {
    throw planError(
      "invalid_storage_root",
      ".",
      `Workspace storage identity cannot be verified before export planning: ${root}`,
      error,
    );
  }
  if (!rootIdentity) {
    throw planError(
      "invalid_storage_root",
      ".",
      `Workspace pico.sqlite binding is required before export planning: ${root}`,
    );
  }
  try {
    return scanWorkspacePortabilityPlan(root);
  } catch (error) {
    if (error instanceof WorkspacePortabilityPlanError) throw error;
    throw planError(
      "file_changed_during_scan",
      ".",
      `Workspace storage could not provide one transactionally consistent export snapshot: ${root}`,
      error,
    );
  }
}

function scanWorkspacePortabilityPlan(root: string): WorkspacePortabilityPlan {
  const entries: WorkspacePortabilityPlanEntry[] = [];
  for (const name of readDirectoryNames(root)) {
    const absolutePath = join(root, name);
    const relativePath = toPortablePath(name);
    const metadata = lstatPath(absolutePath, relativePath);
    assertSupportedNode(metadata, relativePath);

    if (name === OPERATIONAL_DATABASE_FILENAME) {
      if (!metadata.isFile()) {
        throw planError(
          "special_file",
          relativePath,
          `Workspace database entry must be a regular file: ${relativePath}`,
        );
      }
      entries.push(planEntry(relativePath, metadata, WORKSPACE_DATABASE_POLICY, undefined));
      continue;
    }

    const directoryPolicy =
      PORTABLE_TOP_LEVEL_POLICIES.get(name) ??
      HOST_BOUND_TOP_LEVEL_DIRECTORIES.get(name) ??
      LEGACY_TOP_LEVEL_DIRECTORIES.get(name);
    const filePolicy = HOST_BOUND_TOP_LEVEL_FILES.get(name) ?? LEGACY_TOP_LEVEL_FILES.get(name);
    const policy = denylistedPolicy(relativePath) ?? directoryPolicy ?? filePolicy;
    if (!policy) {
      throw planError(
        "unknown_top_level_entry",
        relativePath,
        `Unknown workspace storage entry has no portability policy: ${relativePath}`,
      );
    }
    if (directoryPolicy && !metadata.isDirectory()) {
      throw planError(
        "special_file",
        relativePath,
        `Workspace storage root entry must be a real directory: ${relativePath}`,
      );
    }
    if (filePolicy && !metadata.isFile()) {
      throw planError(
        "special_file",
        relativePath,
        `Workspace storage root entry must be a regular file: ${relativePath}`,
      );
    }
    scanNode(root, absolutePath, relativePath, policy, entries);
  }

  entries.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
  let portableBytes = 0;
  let portableFileCount = 0;
  for (const entry of entries) {
    if (entry.classification !== "portable") continue;
    portableFileCount += 1;
    portableBytes += entry.size;
  }
  return {
    schemaVersion: WORKSPACE_PORTABILITY_PLAN_SCHEMA_VERSION,
    storageRoot: root,
    entries,
    portableFileCount,
    excludedFileCount: entries.length - portableFileCount,
    portableBytes,
  };
}

function scanNode(
  root: string,
  absolutePath: string,
  relativePath: string,
  inheritedPolicy: PathPolicy,
  entries: WorkspacePortabilityPlanEntry[],
): void {
  const metadata = lstatPath(absolutePath, relativePath);
  assertSupportedNode(metadata, relativePath);
  assertCanonicalPathInsideRoot(root, absolutePath, relativePath);
  const policy = denylistedPolicy(relativePath) ?? inheritedPolicy;
  if (metadata.isDirectory()) {
    for (const name of readDirectoryNames(absolutePath)) {
      scanNode(
        root,
        join(absolutePath, name),
        toPortablePath(join(relativePath, name)),
        policy,
        entries,
      );
    }
    return;
  }

  if (!metadata.isFile()) {
    throw planError(
      "special_file",
      relativePath,
      `Workspace export planning rejects special files: ${relativePath}`,
    );
  }
  if (!Number.isSafeInteger(metadata.size)) {
    throw planError(
      "file_too_large",
      relativePath,
      `Workspace file size cannot be represented safely: ${relativePath}`,
    );
  }
  const digest =
    policy.classification === "portable"
      ? hashStablePortableFile(absolutePath, relativePath)
      : undefined;
  entries.push(planEntry(relativePath, metadata, policy, digest));
}

function planEntry(
  relativePath: string,
  metadata: Stats,
  policy: PathPolicy,
  digest: { readonly size: number; readonly sha256: string } | undefined,
): WorkspacePortabilityPlanEntry {
  return {
    relativePath,
    size: digest?.size ?? metadata.size,
    sha256: digest?.sha256 ?? null,
    classification: policy.classification,
    reason: policy.reason,
  };
}

function hashStablePortableFile(
  absolutePath: string,
  relativePath: string,
): { readonly size: number; readonly sha256: string } {
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (!before.isFile() || !Number.isSafeInteger(before.size)) {
      throw planError(
        "special_file",
        relativePath,
        `Portable entry changed to a non-regular file during scan: ${relativePath}`,
      );
    }
    const hash = createHash("sha256");
    let size = 0;
    for (;;) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = fstatSync(descriptor);
    if (
      !Number.isSafeInteger(after.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      size !== after.size
    ) {
      throw planError(
        "file_changed_during_scan",
        relativePath,
        `Portable file changed while its export digest was calculated: ${relativePath}`,
      );
    }
    return {
      size,
      sha256: hash.digest("hex"),
    };
  } catch (error) {
    if (error instanceof WorkspacePortabilityPlanError) throw error;
    throw planError(
      "file_changed_during_scan",
      relativePath,
      `Portable file could not be read as a stable snapshot: ${relativePath}`,
      error,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function denylistedPolicy(relativePath: string): PathPolicy | undefined {
  const segments = relativePath.split("/");
  if (segments.some(isSensitiveName)) return PROTECTED_SECRET_POLICY;
  if (segments.some(isDatabaseOrJournalName)) return PROTECTED_DATABASE_POLICY;
  if (segments.some(isLockOrCommitName)) return LOCK_OR_COMMIT_POLICY;
  if (segments.some(isTemporaryName)) return TEMPORARY_FILE_POLICY;
  return undefined;
}

function isSensitiveName(name: string): boolean {
  const normalized = name.toLowerCase();
  if (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized === "credentials" ||
    normalized === "secrets" ||
    normalized === "token" ||
    normalized === "tokens" ||
    normalized === ".netrc" ||
    normalized === ".npmrc" ||
    normalized === ".pypirc" ||
    normalized === "service-account.json" ||
    normalized === "service_account.json" ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)$/u.test(normalized)
  ) {
    return true;
  }
  return (
    /(?:^|[._-])(?:credential|credentials|secret|secrets|api[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token)(?:[._-]|$)/iu.test(
      normalized,
    ) || /\.(?:key|pem|p12|pfx|jks|keystore)$/iu.test(normalized)
  );
}

function isDatabaseOrJournalName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm|journal))?$/u.test(normalized) ||
    /-(?:wal|shm|journal)$/u.test(normalized)
  );
}

function isLockOrCommitName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "lock" ||
    normalized === ".lock" ||
    normalized === "commit.json" ||
    normalized.startsWith(".lock.") ||
    normalized.includes(".lock.tombstone-") ||
    normalized.includes(".lock.candidate-")
  );
}

function isTemporaryName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "tmp" ||
    normalized === "temp" ||
    normalized.endsWith(".tmp") ||
    normalized.endsWith(".temp") ||
    normalized.endsWith(".swp") ||
    normalized.endsWith(".swo") ||
    normalized.endsWith("~") ||
    /^\..+\.tmp$/u.test(normalized)
  );
}

function lstatRoot(path: string): Stats {
  try {
    return lstatSync(path);
  } catch (error) {
    throw planError(
      "invalid_storage_root",
      ".",
      `Workspace storage root is not accessible: ${path}`,
      error,
    );
  }
}

function lstatPath(path: string, relativePath: string): Stats {
  try {
    return lstatSync(path);
  } catch (error) {
    throw planError(
      "file_changed_during_scan",
      relativePath,
      `Workspace entry disappeared or became inaccessible during scan: ${relativePath}`,
      error,
    );
  }
}

function assertSupportedNode(metadata: Stats, relativePath: string): void {
  if (metadata.isSymbolicLink()) {
    throw planError(
      "symbolic_link",
      relativePath,
      `Workspace export planning never follows symbolic links: ${relativePath}`,
    );
  }
  if (!metadata.isDirectory() && !metadata.isFile()) {
    throw planError(
      "special_file",
      relativePath,
      `Workspace export planning rejects special files: ${relativePath}`,
    );
  }
}

function assertCanonicalPathInsideRoot(root: string, path: string, relativePath: string): string {
  let canonical: string;
  try {
    canonical = resolvePath(path);
  } catch (error) {
    throw planError(
      "file_changed_during_scan",
      relativePath,
      `Workspace entry could not be resolved during scan: ${relativePath}`,
      error,
    );
  }
  const relativeToRoot = relative(root, canonical);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativeToRoot)
  ) {
    throw planError(
      "path_escape",
      relativePath,
      `Workspace entry resolves outside the storage root: ${relativePath}`,
    );
  }
  return canonical;
}

function resolvePath(path: string): string {
  return realpathSync.native(path);
}

function readDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path).sort(comparePaths);
  } catch (error) {
    throw planError(
      "file_changed_during_scan",
      ".",
      `Workspace directory could not be read while planning export: ${path}`,
      error,
    );
  }
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPortablePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function planError(
  code: WorkspacePortabilityErrorCode,
  relativePath: string,
  message: string,
  cause?: unknown,
): WorkspacePortabilityPlanError {
  const error = new WorkspacePortabilityPlanError(code, relativePath, message);
  if (cause !== undefined) error.cause = cause;
  return error;
}
