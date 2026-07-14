import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  constants,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolvePicoPaths, type PicoPaths, type ResolvePicoPathsOptions } from "./pico-paths.js";

const MIGRATION_VERSION = 1 as const;
const MIGRATION_ID = "claw-v1";

export type ClawMigrationItemKind =
  | "project-skill"
  | "project-agent"
  | "project-mcp"
  | "workspace-skill-state"
  | "workspace-state";

export interface ClawMigrationItem {
  readonly kind: ClawMigrationItemKind;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ClawMigrationResult {
  readonly status: "migrated" | "already-migrated";
  readonly markerPath: string;
  readonly migrated: readonly ClawMigrationItem[];
  readonly ignoredLegacyEntries: readonly string[];
}

export interface MigrateLegacyClawOptions extends ResolvePicoPathsOptions {
  readonly now?: () => Date;
}

export interface ClawMigrationConflict {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly reason: string;
}

export class ClawMigrationConflictError extends Error {
  constructor(readonly conflicts: readonly ClawMigrationConflict[]) {
    super(
      `Legacy .claw migration has ${conflicts.length} conflict(s): ${conflicts
        .map((conflict) => `${conflict.targetPath} (${conflict.reason})`)
        .join(", ")}`,
    );
    this.name = "ClawMigrationConflictError";
  }
}

export class ClawMigrationLockedError extends Error {
  constructor(readonly lockPath: string) {
    super(`Legacy .claw migration is already running: ${lockPath}`);
    this.name = "ClawMigrationLockedError";
  }
}

interface PlannedMigrationItem extends ClawMigrationItem {
  readonly mode: number;
  readonly targetRoot: string;
}

interface MigrationJournal {
  readonly version: typeof MIGRATION_VERSION;
  readonly migrationId: typeof MIGRATION_ID;
  readonly canonicalWorkDir: string;
  readonly legacyRoot: string;
  readonly items: readonly PlannedMigrationItem[];
  readonly completedTargets: readonly string[];
}

interface MigrationMarker {
  readonly version: typeof MIGRATION_VERSION;
  readonly migrationId: typeof MIGRATION_ID;
  readonly canonicalWorkDir: string;
  readonly legacyRoot: string;
  readonly completedAt: string;
  readonly items: readonly ClawMigrationItem[];
  readonly ignoredLegacyEntries: readonly string[];
}

interface MigrationLocations {
  readonly legacyRoot: string;
  readonly markerPath: string;
  readonly journalPath: string;
  readonly lockPath: string;
}

/**
 * Copies the legacy workspace layout into Pico's split project/state layout.
 *
 * The migration is deliberately non-destructive: legacy files are never removed,
 * trust records are never imported, and existing destinations are never replaced.
 * A marker is the only authority that switches subsequent calls to the new layout.
 */
export async function migrateLegacyClawWorkspace(
  workDir: string,
  options: MigrateLegacyClawOptions = {},
): Promise<ClawMigrationResult> {
  const paths = resolvePicoPaths(workDir, options);
  const locations = migrationLocations(paths);
  await mkdir(paths.workspace.migrations, { recursive: true, mode: 0o700 });

  // The atomic marker is authoritative even if a process died before removing
  // its lock. This keeps completed migrations idempotent without breaking a
  // possibly live pre-marker lock.
  const completedMarker = await readMarkerIfPresent(locations.markerPath, paths);
  if (completedMarker) return alreadyMigratedResult(locations.markerPath, completedMarker);

  const lock = await acquireMigrationLock(locations.lockPath);
  try {
    const existingMarker = await readMarkerIfPresent(locations.markerPath, paths);
    if (existingMarker) {
      await rm(locations.journalPath, { force: true });
      return alreadyMigratedResult(locations.markerPath, existingMarker);
    }

    const plan = await buildMigrationPlan(paths, locations.legacyRoot);
    const ignoredLegacyEntries = await findIgnoredLegacyEntries(locations.legacyRoot, plan.items);
    const resumedJournal = await readJournalIfPresent(locations.journalPath, paths);
    let journal: MigrationJournal;

    if (resumedJournal) {
      assertJournalMatchesPlan(resumedJournal, plan.items, paths, locations.legacyRoot);
      await assertResumeTargetsSafe(plan.items);
      journal = resumedJournal;
    } else {
      await assertFreshTargetsAvailable(plan.items);
      journal = {
        version: MIGRATION_VERSION,
        migrationId: MIGRATION_ID,
        canonicalWorkDir: paths.canonicalWorkDir,
        legacyRoot: locations.legacyRoot,
        items: plan.items,
        completedTargets: [],
      };
      await writeJsonAtomic(locations.journalPath, journal);
    }

    const completed = new Set(journal.completedTargets);
    for (const item of plan.items) {
      if (await targetMatches(item)) {
        completed.add(item.targetPath);
      } else {
        await copyVerifiedWithoutReplace(item);
        completed.add(item.targetPath);
      }
      journal = { ...journal, completedTargets: [...completed].sort() };
      await writeJsonAtomic(locations.journalPath, journal);
    }

    await verifyAllTargets(plan.items);
    const migrated = plan.items.map(toPublicItem);
    const marker: MigrationMarker = {
      version: MIGRATION_VERSION,
      migrationId: MIGRATION_ID,
      canonicalWorkDir: paths.canonicalWorkDir,
      legacyRoot: locations.legacyRoot,
      completedAt: (options.now ?? (() => new Date()))().toISOString(),
      items: migrated,
      ignoredLegacyEntries,
    };
    await writeJsonAtomic(locations.markerPath, marker);
    await rm(locations.journalPath, { force: true });

    return {
      status: "migrated",
      markerPath: locations.markerPath,
      migrated,
      ignoredLegacyEntries,
    };
  } finally {
    await lock.close().catch(() => undefined);
    await rm(locations.lockPath, { force: true });
  }
}

function alreadyMigratedResult(markerPath: string, marker: MigrationMarker): ClawMigrationResult {
  return {
    status: "already-migrated",
    markerPath,
    migrated: marker.items,
    ignoredLegacyEntries: marker.ignoredLegacyEntries,
  };
}

function migrationLocations(paths: PicoPaths): MigrationLocations {
  return {
    legacyRoot: join(paths.canonicalWorkDir, ".claw"),
    markerPath: join(paths.workspace.migrations, `${MIGRATION_ID}.marker.json`),
    journalPath: join(paths.workspace.migrations, `${MIGRATION_ID}.journal.json`),
    lockPath: join(paths.workspace.migrations, `${MIGRATION_ID}.lock`),
  };
}

async function acquireMigrationLock(lockPath: string) {
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    await handle.sync();
    return handle;
  } catch (error) {
    if (isErrnoCode(error, "EEXIST")) throw new ClawMigrationLockedError(lockPath);
    throw error;
  }
}

async function buildMigrationPlan(
  paths: PicoPaths,
  legacyRoot: string,
): Promise<{ items: PlannedMigrationItem[] }> {
  const rootInfo = await lstat(legacyRoot).catch((error: unknown) => {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!rootInfo) return { items: [] };
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new ClawMigrationConflictError([
      {
        sourcePath: legacyRoot,
        targetPath: paths.project.root,
        reason: "legacy root must be a real directory, not a symlink",
      },
    ]);
  }

  const items: PlannedMigrationItem[] = [];
  await addSkills(paths, legacyRoot, items);
  await addSingleFile(
    join(legacyRoot, "agents.yaml"),
    paths.project.agents,
    paths.project.root,
    "project-agent",
    items,
  );
  await addSingleFile(
    join(legacyRoot, "agents.yml"),
    paths.project.agents,
    paths.project.root,
    "project-agent",
    items,
  );
  await addSingleFile(
    join(legacyRoot, "mcp.json"),
    paths.project.mcp,
    paths.project.root,
    "project-mcp",
    items,
  );

  const directoryMappings: ReadonlyArray<readonly [string, string]> = [
    ["sessions", paths.workspace.sessions],
    ["memory", paths.workspace.memory],
    ["artifacts", paths.workspace.artifacts],
    ["traces", paths.workspace.traces],
    ["tasks", paths.workspace.tasks],
    ["fork-staging", paths.workspace.forkStaging],
    ["storage-operations", paths.workspace.storageOperations],
  ];
  for (const [legacyName, target] of directoryMappings) {
    await addDirectoryFiles(
      join(legacyRoot, legacyName),
      target,
      paths.workspace.root,
      "workspace-state",
      items,
    );
  }

  const fileMappings: ReadonlyArray<readonly [string, string]> = [
    ["runtime.sqlite", paths.workspace.runtimeDatabase],
    ["runtime.sqlite-wal", `${paths.workspace.runtimeDatabase}-wal`],
    ["runtime.sqlite-shm", `${paths.workspace.runtimeDatabase}-shm`],
    ["sessions.db", join(paths.workspace.root, "sessions.db")],
    ["sessions.db-wal", join(paths.workspace.root, "sessions.db-wal")],
    ["sessions.db-shm", join(paths.workspace.root, "sessions.db-shm")],
    ["todo.json", paths.workspace.todo],
    ["hooks-state.local.json", paths.workspace.hookState],
    ["tui-debug.log", paths.workspace.debugLog],
    ["session-catalog-health.json", join(paths.workspace.root, "session-catalog-health.json")],
  ];
  for (const [legacyName, target] of fileMappings) {
    await addSingleFile(
      join(legacyRoot, legacyName),
      target,
      paths.workspace.root,
      "workspace-state",
      items,
    );
  }

  assertUniqueTargets(items);
  return { items: items.sort((left, right) => left.targetPath.localeCompare(right.targetPath)) };
}

async function addSkills(
  paths: PicoPaths,
  legacyRoot: string,
  items: PlannedMigrationItem[],
): Promise<void> {
  const sourceRoot = join(legacyRoot, "skills");
  const files = await listRegularFiles(sourceRoot);
  for (const sourcePath of files) {
    const relativePath = relative(sourceRoot, sourcePath);
    const isState = extname(sourcePath).toLowerCase() === ".json";
    await addKnownFile(
      sourcePath,
      isState
        ? join(paths.workspace.memory, "skills", relativePath)
        : join(paths.project.skills, relativePath),
      isState ? paths.workspace.root : paths.project.root,
      isState ? "workspace-skill-state" : "project-skill",
      items,
    );
  }
}

async function addDirectoryFiles(
  sourceRoot: string,
  targetRoot: string,
  confinementRoot: string,
  kind: ClawMigrationItemKind,
  items: PlannedMigrationItem[],
): Promise<void> {
  for (const sourcePath of await listRegularFiles(sourceRoot)) {
    await addKnownFile(
      sourcePath,
      join(targetRoot, relative(sourceRoot, sourcePath)),
      confinementRoot,
      kind,
      items,
    );
  }
}

async function addSingleFile(
  sourcePath: string,
  targetPath: string,
  targetRoot: string,
  kind: ClawMigrationItemKind,
  items: PlannedMigrationItem[],
): Promise<void> {
  const info = await lstat(sourcePath).catch((error: unknown) => {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!info) return;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ClawMigrationConflictError([
      { sourcePath, targetPath, reason: "migration sources must be regular non-symlink files" },
    ]);
  }
  await addKnownFile(sourcePath, targetPath, targetRoot, kind, items, info);
}

async function addKnownFile(
  sourcePath: string,
  targetPath: string,
  targetRoot: string,
  kind: ClawMigrationItemKind,
  items: PlannedMigrationItem[],
  sourceInfo?: Stats,
): Promise<void> {
  const infoBefore = sourceInfo ?? (await stat(sourcePath));
  const sha256 = await hashFile(sourcePath);
  const info = await stat(sourcePath);
  if (infoBefore.size !== info.size || infoBefore.mtimeMs !== info.mtimeMs) {
    throw new ClawMigrationConflictError([
      { sourcePath, targetPath, reason: "source changed while the migration plan was created" },
    ]);
  }
  assertWithin(targetRoot, targetPath);
  items.push({
    kind,
    sourcePath,
    targetPath,
    targetRoot,
    size: info.size,
    mode: info.mode & 0o777,
    sha256,
  });
}

async function listRegularFiles(root: string): Promise<string[]> {
  const info = await lstat(root).catch((error: unknown) => {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!info) return [];
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ClawMigrationConflictError([
      { sourcePath: root, targetPath: root, reason: "migration directory must not be a symlink" },
    ]);
  }

  const files: string[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const entryPath = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ClawMigrationConflictError([
        {
          sourcePath: entryPath,
          targetPath: entryPath,
          reason: "symlink sources are not migrated",
        },
      ]);
    }
    if (entry.isDirectory()) files.push(...(await listRegularFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
    else {
      throw new ClawMigrationConflictError([
        { sourcePath: entryPath, targetPath: entryPath, reason: "special files are not migrated" },
      ]);
    }
  }
  return files;
}

function assertUniqueTargets(items: readonly PlannedMigrationItem[]): void {
  const byTarget = new Map<string, PlannedMigrationItem>();
  const conflicts: ClawMigrationConflict[] = [];
  for (const item of items) {
    const existing = byTarget.get(item.targetPath);
    if (existing) {
      conflicts.push({
        sourcePath: item.sourcePath,
        targetPath: item.targetPath,
        reason: `multiple legacy sources also include ${existing.sourcePath}`,
      });
    } else {
      byTarget.set(item.targetPath, item);
    }
  }
  if (conflicts.length > 0) throw new ClawMigrationConflictError(conflicts);
}

async function assertFreshTargetsAvailable(items: readonly PlannedMigrationItem[]): Promise<void> {
  const conflicts: ClawMigrationConflict[] = [];
  for (const item of items) {
    await assertSafeTargetAncestors(item);
    const targetInfo = await lstat(item.targetPath).catch((error: unknown) => {
      if (isErrnoCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (targetInfo) {
      conflicts.push({
        sourcePath: item.sourcePath,
        targetPath: item.targetPath,
        reason: "destination already exists",
      });
    }
  }
  if (conflicts.length > 0) throw new ClawMigrationConflictError(conflicts);
}

async function assertResumeTargetsSafe(items: readonly PlannedMigrationItem[]): Promise<void> {
  const conflicts: ClawMigrationConflict[] = [];
  for (const item of items) {
    await assertSafeTargetAncestors(item);
    const targetInfo = await lstat(item.targetPath).catch((error: unknown) => {
      if (isErrnoCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (!targetInfo) continue;
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || !(await targetMatches(item))) {
      conflicts.push({
        sourcePath: item.sourcePath,
        targetPath: item.targetPath,
        reason: "resumed destination does not match the migration journal",
      });
    }
  }
  if (conflicts.length > 0) throw new ClawMigrationConflictError(conflicts);
}

async function assertSafeTargetAncestors(item: PlannedMigrationItem): Promise<void> {
  assertWithin(item.targetRoot, item.targetPath);
  const relativeParent = relative(item.targetRoot, dirname(item.targetPath));
  const segments = relativeParent ? relativeParent.split(sep) : [];
  let current = item.targetRoot;
  for (const segment of ["", ...segments]) {
    if (segment) current = join(current, segment);
    const info = await lstat(current).catch((error: unknown) => {
      if (isErrnoCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ClawMigrationConflictError([
        {
          sourcePath: item.sourcePath,
          targetPath: item.targetPath,
          reason: `unsafe destination ancestor: ${current}`,
        },
      ]);
    }
  }
}

async function copyVerifiedWithoutReplace(item: PlannedMigrationItem): Promise<void> {
  await assertSafeTargetAncestors(item);
  await mkdir(dirname(item.targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(item.targetPath),
    `.${basename(item.targetPath)}.pico-migrate-${process.pid}-${randomUUID()}`,
  );
  try {
    await copyFile(item.sourcePath, temporaryPath, constants.COPYFILE_EXCL);
    if ((await hashFile(temporaryPath)) !== item.sha256) {
      throw new Error(`Source changed while copying: ${item.sourcePath}`);
    }
    await installTemporaryWithoutReplace(temporaryPath, item.targetPath);
    await chmod(item.targetPath, item.mode);
    if (!(await targetMatches(item))) {
      throw new Error(`Destination verification failed: ${item.targetPath}`);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function installTemporaryWithoutReplace(
  temporaryPath: string,
  targetPath: string,
): Promise<void> {
  try {
    await link(temporaryPath, targetPath);
    await unlink(temporaryPath);
    return;
  } catch (error) {
    if (isErrnoCode(error, "EEXIST")) {
      throw new ClawMigrationConflictError([
        { sourcePath: temporaryPath, targetPath, reason: "destination appeared during migration" },
      ]);
    }
    if (!isErrnoCode(error, "EPERM") && !isErrnoCode(error, "ENOTSUP")) throw error;
  }

  try {
    await copyFile(temporaryPath, targetPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (isErrnoCode(error, "EEXIST")) {
      throw new ClawMigrationConflictError([
        { sourcePath: temporaryPath, targetPath, reason: "destination appeared during migration" },
      ]);
    }
    throw error;
  }
}

async function verifyAllTargets(items: readonly PlannedMigrationItem[]): Promise<void> {
  const conflicts: ClawMigrationConflict[] = [];
  for (const item of items) {
    if (!(await targetMatches(item))) {
      conflicts.push({
        sourcePath: item.sourcePath,
        targetPath: item.targetPath,
        reason: "destination hash or size does not match source snapshot",
      });
    }
  }
  if (conflicts.length > 0) throw new ClawMigrationConflictError(conflicts);
}

async function targetMatches(item: Pick<PlannedMigrationItem, "targetPath" | "size" | "sha256">) {
  const info = await lstat(item.targetPath).catch((error: unknown) => {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  });
  return (
    info?.isFile() === true &&
    !info.isSymbolicLink() &&
    info.size === item.size &&
    (await hashFile(item.targetPath)) === item.sha256
  );
}

async function readMarkerIfPresent(
  markerPath: string,
  paths: PicoPaths,
): Promise<MigrationMarker | undefined> {
  const value = await readJsonIfPresent(markerPath);
  if (value === undefined) return undefined;
  if (!isMigrationMarker(value) || value.canonicalWorkDir !== paths.canonicalWorkDir) {
    throw new Error(`Invalid legacy migration marker: ${markerPath}`);
  }
  return value;
}

async function readJournalIfPresent(
  journalPath: string,
  paths: PicoPaths,
): Promise<MigrationJournal | undefined> {
  const value = await readJsonIfPresent(journalPath);
  if (value === undefined) return undefined;
  if (!isMigrationJournal(value) || value.canonicalWorkDir !== paths.canonicalWorkDir) {
    throw new Error(`Invalid legacy migration journal: ${journalPath}`);
  }
  return value;
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  const info = await lstat(path).catch((error: unknown) => {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Migration metadata must be a regular non-symlink file: ${path}`);
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function assertJournalMatchesPlan(
  journal: MigrationJournal,
  items: readonly PlannedMigrationItem[],
  paths: PicoPaths,
  legacyRoot: string,
): void {
  const plannedTargets = new Set(items.map((item) => item.targetPath));
  if (
    journal.legacyRoot !== legacyRoot ||
    journal.canonicalWorkDir !== paths.canonicalWorkDir ||
    !samePlannedItems(journal.items, items) ||
    journal.completedTargets.some((target) => !plannedTargets.has(target))
  ) {
    throw new ClawMigrationConflictError([
      {
        sourcePath: legacyRoot,
        targetPath: paths.workspace.root,
        reason: "legacy sources changed after the migration journal was created",
      },
    ]);
  }
}

function samePlannedItems(
  left: readonly PlannedMigrationItem[],
  right: readonly PlannedMigrationItem[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        item.kind === candidate.kind &&
        item.sourcePath === candidate.sourcePath &&
        item.targetPath === candidate.targetPath &&
        item.targetRoot === candidate.targetRoot &&
        item.size === candidate.size &&
        item.mode === candidate.mode &&
        item.sha256 === candidate.sha256
      );
    })
  );
}

async function findIgnoredLegacyEntries(
  legacyRoot: string,
  items: readonly PlannedMigrationItem[],
): Promise<string[]> {
  const migratedSources = new Set(items.map((item) => item.sourcePath));
  const allFiles = await listRegularFiles(legacyRoot).catch((error: unknown) => {
    if (error instanceof ClawMigrationConflictError) throw error;
    if (isErrnoCode(error, "ENOENT")) return [];
    throw error;
  });
  return allFiles
    .filter((path) => !migratedSources.has(path))
    .map((path) => relative(legacyRoot, path))
    .sort();
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // Temporary and destination files share a directory, so this never relies on
    // a cross-device rename even when legacy .claw and PICO_HOME are on different volumes.
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function toPublicItem(item: PlannedMigrationItem): ClawMigrationItem {
  return {
    kind: item.kind,
    sourcePath: item.sourcePath,
    targetPath: item.targetPath,
    size: item.size,
    sha256: item.sha256,
  };
}

function assertWithin(root: string, path: string): void {
  if (!isAbsolute(root) || !isAbsolute(path)) throw new Error("Migration paths must be absolute");
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Migration target escapes its root: ${path}`);
  }
}

function isMigrationMarker(value: unknown): value is MigrationMarker {
  if (!isRecord(value)) return false;
  return (
    value["version"] === MIGRATION_VERSION &&
    value["migrationId"] === MIGRATION_ID &&
    typeof value["canonicalWorkDir"] === "string" &&
    typeof value["legacyRoot"] === "string" &&
    typeof value["completedAt"] === "string" &&
    Array.isArray(value["items"]) &&
    value["items"].every(isPublicItem) &&
    Array.isArray(value["ignoredLegacyEntries"]) &&
    value["ignoredLegacyEntries"].every((entry) => typeof entry === "string")
  );
}

function isMigrationJournal(value: unknown): value is MigrationJournal {
  if (!isRecord(value)) return false;
  return (
    value["version"] === MIGRATION_VERSION &&
    value["migrationId"] === MIGRATION_ID &&
    typeof value["canonicalWorkDir"] === "string" &&
    typeof value["legacyRoot"] === "string" &&
    Array.isArray(value["items"]) &&
    value["items"].every(isPlannedItem) &&
    Array.isArray(value["completedTargets"]) &&
    value["completedTargets"].every((entry) => typeof entry === "string")
  );
}

function isPublicItem(value: unknown): value is ClawMigrationItem {
  if (!isRecord(value)) return false;
  return (
    isItemKind(value["kind"]) &&
    typeof value["sourcePath"] === "string" &&
    typeof value["targetPath"] === "string" &&
    typeof value["size"] === "number" &&
    typeof value["sha256"] === "string"
  );
}

function isPlannedItem(value: unknown): value is PlannedMigrationItem {
  return (
    isPublicItem(value) &&
    isRecord(value) &&
    typeof value["mode"] === "number" &&
    typeof value["targetRoot"] === "string"
  );
}

function isItemKind(value: unknown): value is ClawMigrationItemKind {
  return (
    value === "project-skill" ||
    value === "project-agent" ||
    value === "project-mcp" ||
    value === "workspace-skill-state" ||
    value === "workspace-state"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
