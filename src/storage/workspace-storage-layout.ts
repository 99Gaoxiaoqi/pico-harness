import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertLocalFileStorageCapabilitiesSync,
  assertPrivateDataFileSync,
  commitFileTransactionSync,
  FileStorageIntegrityError,
  hasPermanentFileLockFenceSync,
  mkdirPrivateSync,
  readJsonFileSync,
  recoverFileTransactionSync,
  withFileLockSync,
  withPermanentFileLockFenceSync,
  type FileTransactionOptions,
  type FileTransactionReplacement,
} from "./local-file-storage.js";

const WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION = 2 as const;
const LEGACY_WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION = 1 as const;
const SESSION_DIRECTORY_PATTERN = /^[a-f0-9]{64}$/u;
const LEGACY_LOCK_TOMBSTONE_PATTERN = /^\.lock\.tombstone-[a-f0-9]{64}$/u;
const LEGACY_LOCK_CANDIDATE_PATTERN =
  /^\.lock\.candidate-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const LEGACY_RUNTIME_FENCE_REASON = "workspace-session-centric-layout-v1";
const LEGACY_CONTROL_FILES = ["state.json", "daemon-events.jsonl", "usage-ledger.jsonl"] as const;
const LEGACY_SESSION_FILES = ["session.jsonl", "manifest.json"] as const;

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
  readonly migratedFrom?: "runtime-directory-v1";
  readonly adoptedAt?: string;
}

export interface LegacyWorkspaceStorageLayout {
  readonly schemaVersion: typeof LEGACY_WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION;
  readonly layout: "session-centric-v1";
  readonly createdAt: string;
  readonly migratedFrom?: "runtime-directory-v1";
}

export interface WorkspaceStorageLayoutPreparation {
  readonly migratedLegacyRuntime: boolean;
  readonly rootIdentity: WorkspaceStorageRootIdentity;
}

export function ensurePrivateWorkspaceStorageDirectorySync(path: string): void {
  assertOrCreatePrivateDirectory(resolve(path));
}

/**
 * Prepares the workspace-wide Session/TaskRun/control transaction namespace.
 *
 * Existing JSON data under runtime/ is copied once, under both the new and legacy locks, and is
 * deliberately left untouched as a rollback artifact. SQLite and legacy task data are never read.
 */
export function prepareWorkspaceStorageLayoutSync(
  workspaceRoot: string,
): WorkspaceStorageLayoutPreparation {
  const root = resolve(workspaceRoot);
  assertLocalFileStorageCapabilitiesSync(root);
  const coordinator = join(root, WORKSPACE_STORAGE_DIRECTORY);
  assertOrCreatePrivateDirectory(coordinator);

  return withFileLockSync(
    join(root, WORKSPACE_STORAGE_LOCK_DIRECTORY),
    `workspace-storage-layout:${process.pid}:${randomUUID()}`,
    () => {
      recoverFileTransactionSync(root, WORKSPACE_LAYOUT_TRANSACTION_OPTIONS);
      const layoutPath = join(root, WORKSPACE_STORAGE_LAYOUT_FILE);
      const existingLayout = existsSync(layoutPath)
        ? decodeWorkspaceStorageLayoutMarker(readJsonFileSync(layoutPath), layoutPath)
        : undefined;
      const physicalIdentity = currentPhysicalIdentity(root);
      if (existingLayout?.schemaVersion === WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION) {
        assertLayoutMatchesPhysicalIdentity(existingLayout, physicalIdentity, layoutPath);
      }
      const legacyRoot = join(root, "runtime");
      assertOrCreatePrivateDirectory(legacyRoot);
      const legacyLock = join(legacyRoot, "lock");
      if (
        existingLayout &&
        hasPermanentFileLockFenceSync(legacyLock, LEGACY_RUNTIME_FENCE_REASON)
      ) {
        const layout =
          existingLayout.schemaVersion === WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION
            ? existingLayout
            : publishLayout(
                root,
                existingLayout,
                physicalIdentity,
                [],
                existingLayout.migratedFrom !== undefined,
              );
        return {
          migratedLegacyRuntime: false,
          rootIdentity: rootIdentityFromLayout(layout),
        };
      }

      return withPermanentFileLockFenceSync(
        legacyLock,
        `workspace-storage-layout-legacy:${process.pid}:${randomUUID()}`,
        LEGACY_RUNTIME_FENCE_REASON,
        () => {
          recoverFileTransactionSync(legacyRoot);
          const legacyLayoutFound = readDirectoryEntries(legacyRoot).some(isLegacyDataEntry);
          const replacements = collectLegacyRuntimeReplacements(root, legacyRoot);
          let layout = existingLayout;
          if (
            !existingLayout ||
            existingLayout.schemaVersion !== WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION ||
            replacements.length > 0 ||
            (legacyLayoutFound && existingLayout.migratedFrom === undefined)
          ) {
            layout = publishLayout(
              root,
              existingLayout,
              physicalIdentity,
              replacements,
              legacyLayoutFound || existingLayout?.migratedFrom !== undefined,
            );
          }
          if (!layout || layout.schemaVersion !== WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION) {
            throw new FileStorageIntegrityError(
              `Workspace storage layout was not upgraded: ${layoutPath}`,
            );
          }
          return {
            migratedLegacyRuntime: existingLayout === undefined && legacyLayoutFound,
            rootIdentity: rootIdentityFromLayout(layout),
          };
        },
      );
    },
  );
}

export function decodeWorkspaceStorageLayout(
  value: unknown,
  path = WORKSPACE_STORAGE_LAYOUT_FILE,
): WorkspaceStorageLayout {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION ||
    value["layout"] !== "session-centric-v1" ||
    typeof value["storageRootId"] !== "string" ||
    !value["storageRootId"] ||
    !isPhysicalIdentity(value["physicalIdentity"]) ||
    typeof value["createdAt"] !== "string" ||
    (value["migratedFrom"] !== undefined && value["migratedFrom"] !== "runtime-directory-v1") ||
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
    ...(value["migratedFrom"] === "runtime-directory-v1"
      ? { migratedFrom: "runtime-directory-v1" as const }
      : {}),
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
  assertLocalFileStorageCapabilitiesSync(root);
  const coordinator = join(root, WORKSPACE_STORAGE_DIRECTORY);
  assertOrCreatePrivateDirectory(coordinator);
  return withFileLockSync(
    join(root, WORKSPACE_STORAGE_LOCK_DIRECTORY),
    `workspace-storage-adopt:${process.pid}:${randomUUID()}`,
    () => {
      recoverFileTransactionSync(root, WORKSPACE_LAYOUT_TRANSACTION_OPTIONS);
      const layoutPath = join(root, WORKSPACE_STORAGE_LAYOUT_FILE);
      if (!existsSync(layoutPath)) {
        throw new FileStorageIntegrityError(
          `Workspace storage layout marker is missing: ${layoutPath}`,
        );
      }
      const layout = decodeWorkspaceStorageLayout(readJsonFileSync(layoutPath), layoutPath);
      if (layout.storageRootId !== expectedStorageRootId) {
        throw new FileStorageIntegrityError(
          `Workspace storage root ID does not match explicit adoption request: ${layoutPath}`,
        );
      }
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
  existing: WorkspaceStorageLayout | LegacyWorkspaceStorageLayout | undefined,
  physicalIdentity: WorkspaceStorageLayout["physicalIdentity"],
  replacements: FileTransactionReplacement[],
  migrated: boolean,
): WorkspaceStorageLayout {
  const layout: WorkspaceStorageLayout = {
    schemaVersion: WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION,
    layout: "session-centric-v1",
    storageRootId:
      existing?.schemaVersion === WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION
        ? existing.storageRootId
        : randomUUID(),
    physicalIdentity,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    ...(migrated ? { migratedFrom: "runtime-directory-v1" } : {}),
    ...(existing?.schemaVersion === WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION &&
    existing.adoptedAt !== undefined
      ? { adoptedAt: existing.adoptedAt }
      : {}),
  };
  commitFileTransactionSync(
    root,
    {
      replacements: [
        ...replacements,
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

export function decodeWorkspaceStorageLayoutMarker(
  value: unknown,
  path = WORKSPACE_STORAGE_LAYOUT_FILE,
): WorkspaceStorageLayout | LegacyWorkspaceStorageLayout {
  if (isRecord(value) && value["schemaVersion"] === WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION) {
    return decodeWorkspaceStorageLayout(value, path);
  }
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== LEGACY_WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION ||
    value["layout"] !== "session-centric-v1" ||
    typeof value["createdAt"] !== "string" ||
    (value["migratedFrom"] !== undefined && value["migratedFrom"] !== "runtime-directory-v1")
  ) {
    throw new FileStorageIntegrityError(`Invalid workspace storage layout marker: ${path}`);
  }
  return {
    schemaVersion: LEGACY_WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION,
    layout: "session-centric-v1",
    createdAt: value["createdAt"],
    ...(value["migratedFrom"] === "runtime-directory-v1"
      ? { migratedFrom: "runtime-directory-v1" as const }
      : {}),
  };
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

function collectLegacyRuntimeReplacements(
  workspaceRoot: string,
  legacyRoot: string,
): FileTransactionReplacement[] {
  const rootEntries = readDirectoryEntries(legacyRoot);
  assertKnownEntries(
    rootEntries,
    new Set(["sessions", "control", "lock"]),
    legacyRoot,
    (entry) =>
      entry.isDirectory() &&
      (LEGACY_LOCK_TOMBSTONE_PATTERN.test(entry.name) ||
        LEGACY_LOCK_CANDIDATE_PATTERN.test(entry.name)),
  );
  const replacements: FileTransactionReplacement[] = [];

  const controlRoot = join(legacyRoot, "control");
  if (existsSync(controlRoot)) {
    assertRealDirectory(controlRoot, "Legacy Runtime control directory");
    const entries = readDirectoryEntries(controlRoot);
    assertKnownEntries(entries, new Set(LEGACY_CONTROL_FILES), controlRoot);
    for (const fileName of LEGACY_CONTROL_FILES) {
      copyLegacyFileIfPresent(
        workspaceRoot,
        join(controlRoot, fileName),
        join("control", fileName),
        replacements,
      );
    }
  }

  const sessionsRoot = join(legacyRoot, "sessions");
  if (existsSync(sessionsRoot)) {
    assertRealDirectory(sessionsRoot, "Legacy Runtime sessions directory");
    for (const entry of readDirectoryEntries(sessionsRoot)) {
      if (!entry.isDirectory() || !SESSION_DIRECTORY_PATTERN.test(entry.name)) {
        throw new FileStorageIntegrityError(
          `Unexpected entry in legacy Runtime sessions: ${join(sessionsRoot, entry.name)}`,
        );
      }
      const sessionRoot = join(sessionsRoot, entry.name);
      assertRealDirectory(sessionRoot, "Legacy Runtime session directory");
      const sessionEntries = readDirectoryEntries(sessionRoot);
      assertKnownEntries(sessionEntries, new Set(LEGACY_SESSION_FILES), sessionRoot);
      for (const fileName of LEGACY_SESSION_FILES) {
        copyLegacyFileIfPresent(
          workspaceRoot,
          join(sessionRoot, fileName),
          join("sessions", entry.name, fileName),
          replacements,
        );
      }
    }
  }
  return replacements;
}

function copyLegacyFileIfPresent(
  workspaceRoot: string,
  sourcePath: string,
  targetRelativePath: string,
  replacements: FileTransactionReplacement[],
): void {
  if (!existsSync(sourcePath)) return;
  assertPrivateDataFileSync(sourcePath);
  const content = readFileSync(sourcePath);
  const targetPath = join(workspaceRoot, targetRelativePath);
  assertSafeTargetParentChain(workspaceRoot, targetPath);
  if (existsSync(targetPath)) {
    assertPrivateDataFileSync(targetPath);
    if (!readFileSync(targetPath).equals(content)) {
      throw new FileStorageIntegrityError(
        `Legacy Runtime migration conflicts with existing target: ${targetPath}`,
      );
    }
    return;
  }
  replacements.push({
    relativePath: targetRelativePath,
    content,
  });
}

function assertSafeTargetParentChain(workspaceRoot: string, targetPath: string): void {
  const parentRelative = relative(workspaceRoot, dirname(targetPath));
  if (parentRelative.startsWith("..") || isAbsolute(parentRelative)) {
    throw new FileStorageIntegrityError(`Migration target escapes workspace: ${targetPath}`);
  }
  let current = workspaceRoot;
  for (const segment of parentRelative.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) return;
    assertRealDirectory(current, "Workspace storage target parent");
  }
}

function assertKnownEntries(
  entries: readonly Dirent[],
  allowed: ReadonlySet<string>,
  directory: string,
  ignored: (entry: Dirent) => boolean = () => false,
): void {
  for (const entry of entries) {
    if (!allowed.has(entry.name) && !ignored(entry)) {
      throw new FileStorageIntegrityError(
        `Unexpected entry in legacy Runtime storage: ${join(directory, entry.name)}`,
      );
    }
  }
}

function isLegacyDataEntry(entry: Dirent): boolean {
  return (
    entry.name !== "lock" &&
    !LEGACY_LOCK_TOMBSTONE_PATTERN.test(entry.name) &&
    !LEGACY_LOCK_CANDIDATE_PATTERN.test(entry.name)
  );
}

function assertOrCreatePrivateDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirPrivateSync(path);
    return;
  }
  assertRealDirectory(path, "Workspace storage coordinator");
  if (process.platform !== "win32" && (lstatSync(path).mode & 0o777) !== 0o700) {
    throw new FileStorageIntegrityError(
      `Workspace storage coordinator must use mode 0700: ${path}`,
    );
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
