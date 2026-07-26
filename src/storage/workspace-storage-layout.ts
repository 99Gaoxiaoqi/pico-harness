import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  type Dirent,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertLocalFileStorageCapabilitiesSync,
  assertPrivateDataFileSync,
  commitFileTransactionSync,
  FileStorageIntegrityError,
  mkdirPrivateSync,
  readJsonFileSync,
  recoverFileTransactionSync,
  withFileLockSync,
  type FileTransactionOptions,
  type FileTransactionReplacement,
} from "./local-file-storage.js";

const WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION = 1 as const;
const SESSION_DIRECTORY_PATTERN = /^[a-f0-9]{64}$/u;
const LEGACY_CONTROL_FILES = [
  "state.json",
  "daemon-events.jsonl",
  "usage-ledger.jsonl",
] as const;
const LEGACY_SESSION_FILES = ["session.jsonl", "manifest.json"] as const;

export const WORKSPACE_STORAGE_DIRECTORY = ".storage";
export const WORKSPACE_STORAGE_COMMIT_FILE = ".storage/commit.json";
export const WORKSPACE_STORAGE_LAYOUT_FILE = ".storage/layout.json";
export const WORKSPACE_STORAGE_LOCK_DIRECTORY = ".storage/lock";
export const WORKSPACE_RUNTIME_TRANSACTION_OPTIONS = Object.freeze({
  commitFileName: WORKSPACE_STORAGE_COMMIT_FILE,
  allowedTargetPrefixes: Object.freeze(["sessions", "control"]),
}) satisfies Pick<FileTransactionOptions, "allowedTargetPrefixes" | "commitFileName">;
export const WORKSPACE_LAYOUT_TRANSACTION_OPTIONS = Object.freeze({
  commitFileName: WORKSPACE_STORAGE_COMMIT_FILE,
  allowedTargetPrefixes: Object.freeze([
    ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS.allowedTargetPrefixes,
    WORKSPACE_STORAGE_LAYOUT_FILE,
  ]),
}) satisfies Pick<FileTransactionOptions, "allowedTargetPrefixes" | "commitFileName">;

interface WorkspaceStorageLayout {
  readonly schemaVersion: typeof WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION;
  readonly layout: "session-centric-v1";
  readonly createdAt: string;
  readonly migratedFrom?: "runtime-directory-v1";
}

export interface WorkspaceStorageLayoutPreparation {
  readonly migratedLegacyRuntime: boolean;
}

export function ensurePrivateWorkspaceStorageDirectorySync(path: string): void {
  assertOrCreatePrivateDirectory(resolve(path));
}

/**
 * Prepares the workspace-wide Session/control transaction namespace.
 *
 * Existing JSON data under runtime/ is copied once, under both the new and legacy locks, and is
 * deliberately left untouched as a rollback artifact. SQLite and legacy task data are never read.
 */
export function prepareWorkspaceStorageLayoutSync(
  workspaceRoot: string,
): WorkspaceStorageLayoutPreparation {
  const root = resolve(workspaceRoot);
  mkdirPrivateSync(root);
  assertLocalFileStorageCapabilitiesSync(root);
  const coordinator = join(root, WORKSPACE_STORAGE_DIRECTORY);
  assertOrCreatePrivateDirectory(coordinator);

  return withFileLockSync(
    join(root, WORKSPACE_STORAGE_LOCK_DIRECTORY),
    `workspace-storage-layout:${process.pid}:${randomUUID()}`,
    () => {
      recoverFileTransactionSync(root, WORKSPACE_LAYOUT_TRANSACTION_OPTIONS);
      const layoutPath = join(root, WORKSPACE_STORAGE_LAYOUT_FILE);
      if (existsSync(layoutPath)) {
        decodeWorkspaceStorageLayout(readJsonFileSync(layoutPath), layoutPath);
        return { migratedLegacyRuntime: false };
      }

      const legacyRoot = join(root, "runtime");
      if (!existsSync(legacyRoot)) {
        publishLayout(root, false, []);
        return { migratedLegacyRuntime: false };
      }
      assertRealDirectory(legacyRoot, "Legacy Runtime storage root");

      return withFileLockSync(
        join(legacyRoot, "lock"),
        `workspace-storage-layout-legacy:${process.pid}:${randomUUID()}`,
        () => {
          recoverFileTransactionSync(legacyRoot);
          const legacyLayoutFound = readDirectoryEntries(legacyRoot).some(
            (entry) => entry.name !== "lock",
          );
          const replacements = collectLegacyRuntimeReplacements(root, legacyRoot);
          publishLayout(root, legacyLayoutFound, replacements);
          return { migratedLegacyRuntime: legacyLayoutFound };
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
    typeof value["createdAt"] !== "string" ||
    (value["migratedFrom"] !== undefined &&
      value["migratedFrom"] !== "runtime-directory-v1")
  ) {
    throw new FileStorageIntegrityError(`Invalid workspace storage layout marker: ${path}`);
  }
  return {
    schemaVersion: WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION,
    layout: "session-centric-v1",
    createdAt: value["createdAt"],
    ...(value["migratedFrom"] === "runtime-directory-v1"
      ? { migratedFrom: "runtime-directory-v1" as const }
      : {}),
  };
}

function publishLayout(
  root: string,
  migrated: boolean,
  replacements: FileTransactionReplacement[],
): void {
  const layout: WorkspaceStorageLayout = {
    schemaVersion: WORKSPACE_STORAGE_LAYOUT_SCHEMA_VERSION,
    layout: "session-centric-v1",
    createdAt: new Date().toISOString(),
    ...(migrated ? { migratedFrom: "runtime-directory-v1" } : {}),
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
}

function collectLegacyRuntimeReplacements(
  workspaceRoot: string,
  legacyRoot: string,
): FileTransactionReplacement[] {
  const rootEntries = readDirectoryEntries(legacyRoot);
  assertKnownEntries(rootEntries, new Set(["sessions", "control", "lock"]), legacyRoot);
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
): void {
  for (const entry of entries) {
    if (!allowed.has(entry.name)) {
      throw new FileStorageIntegrityError(
        `Unexpected entry in legacy Runtime storage: ${join(directory, entry.name)}`,
      );
    }
  }
}

function assertOrCreatePrivateDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirPrivateSync(path);
    return;
  }
  assertRealDirectory(path, "Workspace storage coordinator");
  if (process.platform !== "win32" && (lstatSync(path).mode & 0o777) !== 0o700) {
    throw new FileStorageIntegrityError(`Workspace storage coordinator must use mode 0700: ${path}`);
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
