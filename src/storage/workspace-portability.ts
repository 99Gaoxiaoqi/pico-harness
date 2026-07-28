import { createHash, randomUUID } from "node:crypto";
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
import { recoverFileTransactionSync, withFileLockSync } from "./local-file-storage.js";
import {
  assertWorkspaceStorageRootIdentitySync,
  readWorkspaceStorageRootIdentitySync,
  type WorkspaceStorageRootIdentity,
  WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
  WORKSPACE_STORAGE_LOCK_DIRECTORY,
} from "./workspace-storage-layout.js";

export const WORKSPACE_PORTABILITY_PLAN_SCHEMA_VERSION = 1 as const;

export const WORKSPACE_PORTABILITY_CLASSIFICATIONS = [
  "portable",
  "host_bound",
  "protected",
] as const;
export type WorkspacePortabilityClassification =
  (typeof WORKSPACE_PORTABILITY_CLASSIFICATIONS)[number];

export const WORKSPACE_PORTABILITY_REASONS = [
  "canonical_runtime_history",
  "durable_task_history",
  "portable_evidence",
  "portable_trace",
  "portable_memory_summary",
  "workspace_transaction_state",
  "runtime_control_state",
  "legacy_runtime_state",
  "legacy_task_state",
  "ephemeral_fork_state",
  "storage_operation_state",
  "workspace_todo_state",
  "workspace_plugin_state",
  "workspace_hook_state",
  "memory_state_may_contain_sensitive_data",
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
  "unknown_memory_entry",
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

const PORTABLE_TOP_LEVEL_POLICIES = new Map<string, PathPolicy>([
  [
    "sessions",
    {
      classification: "portable",
      reason: "canonical_runtime_history",
    },
  ],
  [
    "task-runs",
    {
      classification: "portable",
      reason: "durable_task_history",
    },
  ],
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
const LEDGER_DIRECTORY_PATTERN = /^[a-f0-9]{64}$/u;
const SESSION_LEDGER_FILES = new Set(["session.jsonl", "manifest.json"]);
const TASK_RUN_LEDGER_FILES = new Set(["task.jsonl", "manifest.json"]);

const HOST_BOUND_TOP_LEVEL_POLICIES = new Map<string, PathPolicy>([
  [
    ".storage",
    {
      classification: "host_bound",
      reason: "workspace_transaction_state",
    },
  ],
  [
    "control",
    {
      classification: "host_bound",
      reason: "runtime_control_state",
    },
  ],
  [
    "runtime",
    {
      classification: "host_bound",
      reason: "legacy_runtime_state",
    },
  ],
  [
    "tasks",
    {
      classification: "host_bound",
      reason: "legacy_task_state",
    },
  ],
  [
    "fork-staging",
    {
      classification: "host_bound",
      reason: "ephemeral_fork_state",
    },
  ],
  [
    "storage-operations",
    {
      classification: "host_bound",
      reason: "storage_operation_state",
    },
  ],
]);

const HOST_BOUND_TOP_LEVEL_FILES = new Map<string, PathPolicy>([
  [
    "todo.json",
    {
      classification: "host_bound",
      reason: "workspace_todo_state",
    },
  ],
  [
    "plugins.json",
    {
      classification: "host_bound",
      reason: "workspace_plugin_state",
    },
  ],
  [
    "hooks-state.json",
    {
      classification: "host_bound",
      reason: "workspace_hook_state",
    },
  ],
  [
    "tui-debug.log",
    {
      classification: "protected",
      reason: "debug_log_may_contain_sensitive_data",
    },
  ],
]);

const PORTABLE_MEMORY_SUMMARY_POLICY = Object.freeze({
  classification: "portable",
  reason: "portable_memory_summary",
}) satisfies PathPolicy;
const PROTECTED_MEMORY_STATE_POLICY = Object.freeze({
  classification: "protected",
  reason: "memory_state_may_contain_sensitive_data",
}) satisfies PathPolicy;
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
 * The function never copies data and never follows symbolic links. It does recover an already
 * published workspace transaction under the shared lock before hashing a consistent snapshot.
 * Unknown top-level entries, ledger descendants, and direct children under memory/ fail closed so
 * adding a new persistence surface requires an explicit portability decision.
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
    rootIdentity = readWorkspaceStorageRootIdentitySync(root);
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
      `Workspace storage layout marker is required before export planning: ${root}`,
    );
  }
  try {
    return withFileLockSync(
      join(root, WORKSPACE_STORAGE_LOCK_DIRECTORY),
      `workspace-portability-plan:${process.pid}:${randomUUID()}`,
      () => {
        assertWorkspaceStorageRootIdentitySync(root, rootIdentity);
        recoverFileTransactionSync(root, WORKSPACE_RUNTIME_TRANSACTION_OPTIONS);
        assertWorkspaceStorageRootIdentitySync(root, rootIdentity);
        return scanWorkspacePortabilityPlan(root);
      },
    );
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

    if (name === "memory") {
      if (!metadata.isDirectory()) {
        throw planError(
          "special_file",
          relativePath,
          `Workspace memory entry must be a real directory: ${relativePath}`,
        );
      }
      scanMemoryRoot(root, absolutePath, relativePath, entries);
      continue;
    }

    if (name === "sessions" || name === "task-runs") {
      if (!metadata.isDirectory()) {
        throw planError(
          "special_file",
          relativePath,
          `Workspace ${name} entry must be a real directory: ${relativePath}`,
        );
      }
      scanPortableLedgerRoot(
        root,
        absolutePath,
        relativePath,
        PORTABLE_TOP_LEVEL_POLICIES.get(name)!,
        name === "sessions" ? SESSION_LEDGER_FILES : TASK_RUN_LEDGER_FILES,
        entries,
      );
      continue;
    }

    const directoryPolicy =
      PORTABLE_TOP_LEVEL_POLICIES.get(name) ?? HOST_BOUND_TOP_LEVEL_POLICIES.get(name);
    const filePolicy = HOST_BOUND_TOP_LEVEL_FILES.get(name);
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

function scanPortableLedgerRoot(
  root: string,
  ledgerRoot: string,
  ledgerRelativePath: string,
  policy: PathPolicy,
  allowedFileNames: ReadonlySet<string>,
  entries: WorkspacePortabilityPlanEntry[],
): void {
  assertCanonicalPathInsideRoot(root, ledgerRoot, ledgerRelativePath);
  for (const digest of readDirectoryNames(ledgerRoot)) {
    const digestRoot = join(ledgerRoot, digest);
    const digestRelativePath = toPortablePath(join(ledgerRelativePath, digest));
    const digestMetadata = lstatPath(digestRoot, digestRelativePath);
    assertSupportedNode(digestMetadata, digestRelativePath);
    if (!LEDGER_DIRECTORY_PATTERN.test(digest)) {
      throw planError(
        "invalid_ledger_entry",
        digestRelativePath,
        `Workspace ledger directory must use a full SHA-256 digest: ${digestRelativePath}`,
      );
    }
    if (!digestMetadata.isDirectory()) {
      throw planError(
        "special_file",
        digestRelativePath,
        `Workspace ledger digest entry must be a real directory: ${digestRelativePath}`,
      );
    }
    assertCanonicalPathInsideRoot(root, digestRoot, digestRelativePath);
    for (const fileName of readDirectoryNames(digestRoot)) {
      const absolutePath = join(digestRoot, fileName);
      const relativePath = toPortablePath(join(digestRelativePath, fileName));
      const metadata = lstatPath(absolutePath, relativePath);
      assertSupportedNode(metadata, relativePath);
      if (!allowedFileNames.has(fileName)) {
        throw planError(
          "invalid_ledger_entry",
          relativePath,
          `Unknown workspace ledger descendant has no portability policy: ${relativePath}`,
        );
      }
      if (!metadata.isFile()) {
        throw planError(
          "special_file",
          relativePath,
          `Workspace ledger descendant must be a regular file: ${relativePath}`,
        );
      }
      scanNode(root, absolutePath, relativePath, policy, entries);
    }
  }
}

function scanMemoryRoot(
  root: string,
  memoryRoot: string,
  memoryRelativePath: string,
  entries: WorkspacePortabilityPlanEntry[],
): void {
  assertCanonicalPathInsideRoot(root, memoryRoot, memoryRelativePath);
  for (const name of readDirectoryNames(memoryRoot)) {
    const absolutePath = join(memoryRoot, name);
    const relativePath = toPortablePath(join(memoryRelativePath, name));
    const metadata = lstatPath(absolutePath, relativePath);
    assertSupportedNode(metadata, relativePath);
    const denylisted = denylistedPolicy(relativePath);
    const policy =
      denylisted ??
      (name === "summaries"
        ? PORTABLE_MEMORY_SUMMARY_POLICY
        : name === "state.json"
          ? PROTECTED_MEMORY_STATE_POLICY
          : undefined);
    if (!policy) {
      throw planError(
        "unknown_memory_entry",
        relativePath,
        `Unknown memory storage entry has no portability policy: ${relativePath}`,
      );
    }
    if (name === "summaries" && !metadata.isDirectory()) {
      throw planError(
        "special_file",
        relativePath,
        `Memory summaries entry must be a real directory: ${relativePath}`,
      );
    }
    if (name === "state.json" && !metadata.isFile()) {
      throw planError(
        "special_file",
        relativePath,
        `Memory state entry must be a regular file: ${relativePath}`,
      );
    }
    scanNode(root, absolutePath, relativePath, policy, entries);
  }
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
  entries.push({
    relativePath,
    size: digest?.size ?? metadata.size,
    sha256: digest?.sha256 ?? null,
    classification: policy.classification,
    reason: policy.reason,
  });
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
