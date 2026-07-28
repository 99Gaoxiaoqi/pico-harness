import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertLocalFileStorageCapabilitiesSync,
  commitFileTransactionSync,
  FileStorageIntegrityError,
  inspectFileTransactionReplacementSync,
  mkdirPrivateSync,
  readJsonFileSync,
  recoverFileTransactionSync,
  withFileLockSync,
  type FileTransactionOptions,
} from "./local-file-storage.js";

const WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION = 2 as const;
const CANONICAL_STORAGE_DIRECTORIES = ["sessions", "task-runs", "control"] as const;

export const WORKSPACE_STORAGE_DIRECTORY = ".storage";
export const WORKSPACE_STORAGE_COMMIT_FILE = ".storage/commit.json";
export const WORKSPACE_STORAGE_LAYOUT_FILE = ".storage/layout.json";
export const WORKSPACE_STORAGE_LOCK_DIRECTORY = ".storage/lock";
export const WORKSPACE_RUNTIME_TRANSACTION_OPTIONS = Object.freeze({
  commitFileName: WORKSPACE_STORAGE_COMMIT_FILE,
  allowedTargetPrefixes: Object.freeze(["sessions", "task-runs", "control"]),
}) satisfies Pick<FileTransactionOptions, "allowedTargetPrefixes" | "commitFileName">;
export const WORKSPACE_LAYOUT_TRANSACTION_OPTIONS = Object.freeze({
  commitFileName: WORKSPACE_STORAGE_COMMIT_FILE,
  allowedTargetPrefixes: Object.freeze([
    ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS.allowedTargetPrefixes,
    WORKSPACE_STORAGE_LAYOUT_FILE,
  ]),
}) satisfies Pick<FileTransactionOptions, "allowedTargetPrefixes" | "commitFileName">;

export interface WorkspaceStorageRootIdentity {
  readonly storageRootId: string;
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
}

export interface WorkspaceStorageLayout {
  readonly schemaVersion: typeof WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION;
  readonly layout: "session-centric-v1";
  readonly storageRootId: string;
  readonly physicalIdentity: {
    readonly canonicalPath: string;
    readonly device: string;
    readonly inode: string;
  };
  readonly createdAt: string;
  readonly adoptedAt?: string;
}

export interface WorkspaceStorageLayoutPreparation {
  readonly rootIdentity: WorkspaceStorageRootIdentity;
}

export function ensurePrivateWorkspaceStorageDirectorySync(path: string): void {
  assertOrCreatePrivateDirectory(resolve(path));
}

/**
 * Prepares the workspace-wide Session/TaskRun/control transaction namespace.
 *
 * Pre-v2 runtime/ data and schema-version-1 layout markers are deliberately not
 * migrated: Runtime v2 is a development hard cut.
 */
export function prepareWorkspaceStorageLayoutSync(
  workspaceRoot: string,
): WorkspaceStorageLayoutPreparation {
  const root = resolve(workspaceRoot);
  assertWorkspaceLayoutAllowsMutationSync(root);
  assertLocalFileStorageCapabilitiesSync(root);
  const coordinator = join(root, WORKSPACE_STORAGE_DIRECTORY);
  assertOrCreatePrivateDirectory(coordinator);

  return withFileLockSync(
    join(root, WORKSPACE_STORAGE_LOCK_DIRECTORY),
    `workspace-storage-layout:${process.pid}:${randomUUID()}`,
    () => {
      const layoutPath = join(root, WORKSPACE_STORAGE_LAYOUT_FILE);
      const physicalIdentity = currentPhysicalIdentity(root);
      let existingLayout = readWorkspaceStorageLayoutMarkerSync(root);
      assertLayoutAllowsRecovery(root, existingLayout, physicalIdentity, layoutPath);
      recoverFileTransactionSync(root, WORKSPACE_LAYOUT_TRANSACTION_OPTIONS);
      existingLayout = readWorkspaceStorageLayoutMarkerSync(root);
      assertLayoutAllowsRecovery(root, existingLayout, physicalIdentity, layoutPath);
      const layout = existingLayout ?? publishLayout(root, physicalIdentity);
      return { rootIdentity: rootIdentityFromLayout(layout) };
    },
  );
}

export function decodeWorkspaceStorageLayout(
  value: unknown,
  path = WORKSPACE_STORAGE_LAYOUT_FILE,
): WorkspaceStorageLayout {
  if (isRecord(value) && value["schemaVersion"] === 1) {
    throw new FileStorageIntegrityError(
      `Unsupported workspace storage layout schema version 1: ${path}`,
    );
  }
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION ||
    value["layout"] !== "session-centric-v1" ||
    typeof value["storageRootId"] !== "string" ||
    !value["storageRootId"] ||
    !isPhysicalIdentity(value["physicalIdentity"]) ||
    typeof value["createdAt"] !== "string" ||
    (value["adoptedAt"] !== undefined && typeof value["adoptedAt"] !== "string")
  ) {
    throw new FileStorageIntegrityError(`Invalid workspace storage layout marker: ${path}`);
  }
  return {
    schemaVersion: WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION,
    layout: "session-centric-v1",
    storageRootId: value["storageRootId"],
    physicalIdentity: {
      canonicalPath: value["physicalIdentity"]["canonicalPath"],
      device: value["physicalIdentity"]["device"],
      inode: value["physicalIdentity"]["inode"],
    },
    createdAt: value["createdAt"],
    ...(typeof value["adoptedAt"] === "string" ? { adoptedAt: value["adoptedAt"] } : {}),
  };
}

export function assertWorkspaceStorageRootIdentitySync(
  workspaceRoot: string,
  expected: WorkspaceStorageRootIdentity,
): void {
  const root = resolve(workspaceRoot);
  const actual = currentPhysicalIdentity(root);
  if (
    actual.canonicalPath !== expected.canonicalPath ||
    actual.device !== expected.device ||
    actual.inode !== expected.inode
  ) {
    throw new FileStorageIntegrityError(
      `Workspace storage root identity changed: ${root}; expected ${formatIdentity(
        expected,
      )}, received ${formatIdentity(actual)}`,
    );
  }
  const layoutPath = join(root, WORKSPACE_STORAGE_LAYOUT_FILE);
  if (!existsSync(layoutPath)) {
    throw new FileStorageIntegrityError(
      `Workspace storage layout marker is missing: ${layoutPath}`,
    );
  }
  const layout = decodeWorkspaceStorageLayout(readJsonFileSync(layoutPath), layoutPath);
  assertLayoutMatchesPhysicalIdentity(layout, actual, layoutPath);
  if (layout.storageRootId !== expected.storageRootId) {
    throw new FileStorageIntegrityError(
      `Workspace storage root ID changed: ${layoutPath}; expected ${expected.storageRootId}, received ${layout.storageRootId}`,
    );
  }
}

export function readWorkspaceStorageRootIdentitySync(
  workspaceRoot: string,
): WorkspaceStorageRootIdentity | undefined {
  const root = resolve(workspaceRoot);
  const layoutPath = join(root, WORKSPACE_STORAGE_LAYOUT_FILE);
  if (!existsSync(root) || !existsSync(layoutPath)) return undefined;
  const actual = currentPhysicalIdentity(root);
  const layout = decodeWorkspaceStorageLayout(readJsonFileSync(layoutPath), layoutPath);
  assertLayoutMatchesPhysicalIdentity(layout, actual, layoutPath);
  return rootIdentityFromLayout(layout);
}

/**
 * Explicitly adopts a copied workspace root on its new physical directory while preserving its
 * stable storageRootId. Normal Store construction never performs this mutation implicitly.
 */
export function adoptWorkspaceStorageRootIdentitySync(
  workspaceRoot: string,
  expectedStorageRootId: string,
): WorkspaceStorageRootIdentity {
  if (!expectedStorageRootId.trim()) {
    throw new Error("expectedStorageRootId must not be empty");
  }
  const root = resolve(workspaceRoot);
  requireAdoptableWorkspaceStorageLayoutSync(root, expectedStorageRootId);
  assertLocalFileStorageCapabilitiesSync(root);
  const coordinator = join(root, WORKSPACE_STORAGE_DIRECTORY);
  assertOrCreatePrivateDirectory(coordinator);
  return withFileLockSync(
    join(root, WORKSPACE_STORAGE_LOCK_DIRECTORY),
    `workspace-storage-adopt:${process.pid}:${randomUUID()}`,
    () => {
      requireAdoptableWorkspaceStorageLayoutSync(root, expectedStorageRootId);
      recoverFileTransactionSync(root, WORKSPACE_LAYOUT_TRANSACTION_OPTIONS);
      const layout = requireAdoptableWorkspaceStorageLayoutSync(root, expectedStorageRootId);
      const physicalIdentity = currentPhysicalIdentity(root);
      const adopted: WorkspaceStorageLayout = {
        ...layout,
        physicalIdentity,
        adoptedAt: new Date().toISOString(),
      };
      commitFileTransactionSync(
        root,
        {
          replacements: [
            {
              relativePath: WORKSPACE_STORAGE_LAYOUT_FILE,
              content: `${JSON.stringify(adopted, null, 2)}\n`,
            },
          ],
        },
        { ...WORKSPACE_LAYOUT_TRANSACTION_OPTIONS, transactionId: randomUUID() },
      );
      return rootIdentityFromLayout(adopted);
    },
  );
}

function publishLayout(
  root: string,
  physicalIdentity: WorkspaceStorageLayout["physicalIdentity"],
): WorkspaceStorageLayout {
  const layout: WorkspaceStorageLayout = {
    schemaVersion: WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION,
    layout: "session-centric-v1",
    storageRootId: randomUUID(),
    physicalIdentity,
    createdAt: new Date().toISOString(),
  };
  commitFileTransactionSync(
    root,
    {
      replacements: [
        {
          relativePath: WORKSPACE_STORAGE_LAYOUT_FILE,
          content: `${JSON.stringify(layout, null, 2)}\n`,
        },
      ],
    },
    WORKSPACE_LAYOUT_TRANSACTION_OPTIONS,
  );
  return layout;
}

function currentPhysicalIdentity(root: string): WorkspaceStorageLayout["physicalIdentity"] {
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

function assertLayoutMatchesPhysicalIdentity(
  layout: WorkspaceStorageLayout,
  actual: WorkspaceStorageLayout["physicalIdentity"],
  layoutPath: string,
): void {
  if (
    layout.physicalIdentity.canonicalPath !== actual.canonicalPath ||
    layout.physicalIdentity.device !== actual.device ||
    layout.physicalIdentity.inode !== actual.inode
  ) {
    throw new FileStorageIntegrityError(
      `Workspace storage root requires explicit adoption: ${layoutPath}; recorded ${formatIdentity(
        layout.physicalIdentity,
      )}, received ${formatIdentity(actual)}`,
    );
  }
}

function assertWorkspaceLayoutAllowsMutationSync(root: string): void {
  if (!existsSync(root)) return;
  const physicalIdentity = currentPhysicalIdentity(root);
  assertNoUnsupportedLegacyRuntimeData(root);
  const layoutPath = join(root, WORKSPACE_STORAGE_LAYOUT_FILE);
  const layout = readWorkspaceStorageLayoutMarkerSync(root);
  assertLayoutAllowsRecovery(root, layout, physicalIdentity, layoutPath);
}

function assertLayoutAllowsRecovery(
  root: string,
  layout: WorkspaceStorageLayout | undefined,
  physicalIdentity: WorkspaceStorageLayout["physicalIdentity"],
  layoutPath: string,
): void {
  if (layout) {
    assertLayoutMatchesPhysicalIdentity(layout, physicalIdentity, layoutPath);
    return;
  }
  if (existsSync(join(root, WORKSPACE_STORAGE_COMMIT_FILE))) {
    // A missing marker cannot bind a transaction to one physical root. Automatic recovery is safe
    // only when that same strict transaction publishes a verifiable v2 identity.
    const pendingLayout = readPendingWorkspaceLayoutReplacementSync(root);
    if (!pendingLayout) {
      throw new FileStorageIntegrityError(
        `Workspace storage has a pending transaction without a verifiable version 2 layout replacement: ${join(
          root,
          WORKSPACE_STORAGE_COMMIT_FILE,
        )}; ordinary recovery is refused and requires verified manual recovery`,
      );
    }
    assertLayoutMatchesPhysicalIdentity(pendingLayout, physicalIdentity, layoutPath);
    return;
  }
  if (layout === undefined && hasCanonicalWorkspaceData(root)) {
    throw new FileStorageIntegrityError(
      `Workspace storage has canonical data without a workspace storage layout marker: ${root}; ordinary initialization is refused and requires verified manual import`,
    );
  }
}

function hasCanonicalWorkspaceData(root: string): boolean {
  for (const directoryName of CANONICAL_STORAGE_DIRECTORIES) {
    const directory = join(root, directoryName);
    if (!existsSync(directory)) continue;
    assertRealDirectory(directory, `Canonical workspace ${directoryName} directory`);
    if (readDirectoryEntries(directory).length > 0) return true;
  }
  return false;
}

function readWorkspaceStorageLayoutMarkerSync(root: string): WorkspaceStorageLayout | undefined {
  const coordinator = join(root, WORKSPACE_STORAGE_DIRECTORY);
  if (!existsSync(coordinator)) return undefined;
  assertPrivateDirectory(coordinator, "Workspace storage coordinator");
  const layoutPath = join(root, WORKSPACE_STORAGE_LAYOUT_FILE);
  return existsSync(layoutPath)
    ? decodeWorkspaceStorageLayout(readJsonFileSync(layoutPath), layoutPath)
    : undefined;
}

function requireAdoptableWorkspaceStorageLayoutSync(
  root: string,
  expectedStorageRootId: string,
): WorkspaceStorageLayout {
  if (!existsSync(root)) {
    throw new FileStorageIntegrityError(`Workspace storage root is missing: ${root}`);
  }
  currentPhysicalIdentity(root);
  const layoutPath = join(root, WORKSPACE_STORAGE_LAYOUT_FILE);
  const layout = readWorkspaceStorageLayoutMarkerSync(root);
  const adoptableLayout = layout ?? readPendingWorkspaceLayoutReplacementSync(root);
  if (!adoptableLayout) {
    throw new FileStorageIntegrityError(
      `Workspace storage layout marker is missing or cannot be explicitly adopted: ${layoutPath}`,
    );
  }
  if (adoptableLayout.storageRootId !== expectedStorageRootId) {
    throw new FileStorageIntegrityError(
      `Workspace storage root ID does not match explicit adoption request: ${layoutPath}`,
    );
  }
  return adoptableLayout;
}

function readPendingWorkspaceLayoutReplacementSync(
  root: string,
): WorkspaceStorageLayout | undefined {
  const commitPath = join(root, WORKSPACE_STORAGE_COMMIT_FILE);
  if (!existsSync(commitPath)) return undefined;
  const inspection = inspectFileTransactionReplacementSync(
    root,
    WORKSPACE_STORAGE_LAYOUT_FILE,
    WORKSPACE_LAYOUT_TRANSACTION_OPTIONS,
  );
  if (!inspection.replacement) return undefined;
  let value: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(inspection.replacement.content);
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new FileStorageIntegrityError(
      `Pending workspace layout replacement is not valid UTF-8 JSON: ${commitPath}; ${errorMessage(
        error,
      )}`,
    );
  }
  return decodeWorkspaceStorageLayout(
    value,
    `${commitPath} replacement ${inspection.replacement.relativePath}`,
  );
}

function rootIdentityFromLayout(layout: WorkspaceStorageLayout): WorkspaceStorageRootIdentity {
  return {
    storageRootId: layout.storageRootId,
    ...layout.physicalIdentity,
  };
}

function isPhysicalIdentity(value: unknown): value is WorkspaceStorageLayout["physicalIdentity"] {
  return (
    isRecord(value) &&
    typeof value["canonicalPath"] === "string" &&
    Boolean(value["canonicalPath"]) &&
    typeof value["device"] === "string" &&
    Boolean(value["device"]) &&
    typeof value["inode"] === "string" &&
    Boolean(value["inode"])
  );
}

function formatIdentity(identity: {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
}): string {
  return `${identity.canonicalPath} (${identity.device}:${identity.inode})`;
}

function assertNoUnsupportedLegacyRuntimeData(root: string): void {
  const legacyRoot = join(root, "runtime");
  if (!existsSync(legacyRoot)) return;
  assertRealDirectory(legacyRoot, "Legacy Runtime directory");
  if (readDirectoryEntries(legacyRoot).length === 0) return;
  throw new FileStorageIntegrityError(
    `Unsupported pre-v2 Runtime storage exists: ${legacyRoot}; automatic migration is disabled; delete the obsolete Runtime state before initializing version 2 storage`,
  );
}

function assertOrCreatePrivateDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirPrivateSync(path);
    return;
  }
  assertPrivateDirectory(path, "Workspace storage coordinator");
}

function assertPrivateDirectory(path: string, label: string): void {
  assertRealDirectory(path, label);
  if (process.platform !== "win32" && (lstatSync(path).mode & 0o777) !== 0o700) {
    throw new FileStorageIntegrityError(`${label} must use mode 0700: ${path}`);
  }
}

function assertRealDirectory(path: string, label: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new FileStorageIntegrityError(`${label} must be a real directory: ${path}`);
  }
}

function readDirectoryEntries(path: string): Dirent[] {
  return readdirSync(path, { withFileTypes: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
