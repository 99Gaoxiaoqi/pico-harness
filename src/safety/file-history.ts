import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  stat,
  chmod,
  unlink,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const DEFAULT_BASE_DIR = join(homedir(), ".pico", "file-history");
const MAX_SNAPSHOTS = 100;

export interface FileHistoryBackup {
  backupFileName: string | null;
  version: number;
  backupTime: Date;
  originMtimeMs?: number;
  originSize?: number;
}

export interface FileHistorySnapshot {
  messageId: string;
  trackedFileBackups: Map<string, FileHistoryBackup>;
  timestamp: Date;
  messageIndex?: number;
}

export interface FileHistoryState {
  snapshots: FileHistorySnapshot[];
  trackedFiles: Set<string>;
  snapshotSequence: number;
  pendingTrackEdits: Map<string, FileHistoryBackup>;
  currentMessageId?: string;
  fileVersions: Map<string, number>;
}

export type FileHistoryDiffFileStatus = "modified" | "created" | "deleted";

export interface FileHistoryDiffFileStat {
  filePath: string;
  status: FileHistoryDiffFileStatus;
  addedLines: number;
  removedLines: number;
}

export interface FileHistoryDiffStat {
  messageId: string;
  changedFileCount: number;
  addedLines: number;
  removedLines: number;
  files: FileHistoryDiffFileStat[];
}

export function createFileHistoryState(): FileHistoryState {
  return {
    snapshots: [],
    trackedFiles: new Set(),
    snapshotSequence: 0,
    pendingTrackEdits: new Map(),
    currentMessageId: undefined,
    fileVersions: new Map(),
  };
}

export function getBackupFileName(filePath: string, version: number): string {
  const hash = createHash("sha256").update(filePath).digest("hex").slice(0, 16);
  return `${hash}@v${version}`;
}

/**
 * 把 sessionId 转为跨平台安全的目录名。
 * 用 sha256 hash 避免 Windows 冒号/特殊字符问题,定长,与 getBackupFileName 风格一致。
 */
function getSessionDirName(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

export function resolveBackupPath(
  sessionId: string,
  backupFileName: string,
  baseDir: string = DEFAULT_BASE_DIR,
): string {
  return join(baseDir, getSessionDirName(sessionId), backupFileName);
}

function resolveManifestPath(sessionId: string, baseDir: string = DEFAULT_BASE_DIR): string {
  return join(baseDir, getSessionDirName(sessionId), "manifest.json");
}

export async function createBackup(
  filePath: string,
  version: number,
  sessionId: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<string> {
  const backupFileName = getBackupFileName(filePath, version);
  const backupPath = resolveBackupPath(sessionId, backupFileName, baseDir);
  const srcStat = await stat(filePath);

  try {
    await copyFile(filePath, backupPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    await mkdir(join(baseDir, getSessionDirName(sessionId)), { recursive: true });
    await copyFile(filePath, backupPath);
  }

  await chmod(backupPath, srcStat.mode & 0o777);
  return backupFileName;
}

export async function restoreBackup(
  filePath: string,
  backupFileName: string,
  sessionId: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<void> {
  const backupPath = resolveBackupPath(sessionId, backupFileName, baseDir);
  const backupStat = await stat(backupPath);

  try {
    await copyFile(backupPath, filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    await mkdir(dirname(filePath), { recursive: true });
    await copyFile(backupPath, filePath);
  }

  await chmod(filePath, backupStat.mode & 0o777);
}

export async function fileHistoryTrackEdit(
  state: FileHistoryState,
  filePath: string,
  messageId: string,
  sessionId: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<void> {
  if (state.currentMessageId !== messageId) {
    state.pendingTrackEdits = new Map();
    state.currentMessageId = messageId;
  }

  if (state.pendingTrackEdits.has(filePath)) {
    return;
  }

  const version = (state.fileVersions.get(filePath) ?? 0) + 1;

  let backup: FileHistoryBackup;
  try {
    const srcStat = await stat(filePath);
    const backupFileName = await createBackup(filePath, version, sessionId, baseDir);
    backup = {
      backupFileName,
      version,
      backupTime: new Date(),
      originMtimeMs: srcStat.mtimeMs,
      originSize: srcStat.size,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    backup = { backupFileName: null, version, backupTime: new Date() };
  }

  state.fileVersions.set(filePath, version);
  state.trackedFiles.add(filePath);
  state.pendingTrackEdits.set(filePath, backup);
}

function findLastBackup(state: FileHistoryState, filePath: string): FileHistoryBackup | undefined {
  for (let i = state.snapshots.length - 1; i >= 0; i--) {
    const b = state.snapshots[i]!.trackedFileBackups.get(filePath);
    if (b) return b;
  }
  return undefined;
}

function findFirstBackup(state: FileHistoryState, filePath: string): FileHistoryBackup | undefined {
  for (const snapshot of state.snapshots) {
    const backup = snapshot.trackedFileBackups.get(filePath);
    if (backup) return backup;
  }
  return undefined;
}

async function cleanupExclusiveBackups(
  state: FileHistoryState,
  removed: FileHistorySnapshot,
  sessionId: string,
  baseDir: string,
): Promise<void> {
  for (const backup of removed.trackedFileBackups.values()) {
    if (!backup.backupFileName) continue;
    let shared = false;
    for (const snap of state.snapshots) {
      for (const b of snap.trackedFileBackups.values()) {
        if (b.backupFileName === backup.backupFileName) {
          shared = true;
          break;
        }
      }
      if (shared) break;
    }
    if (!shared) {
      const p = resolveBackupPath(sessionId, backup.backupFileName, baseDir);
      try {
        await unlink(p);
      } catch {
        // Best-effort cleanup:backup 可能已被其他清理路径删除。
      }
    }
  }
}

export async function fileHistoryMakeSnapshot(
  state: FileHistoryState,
  messageId: string,
  sessionId: string,
  baseDir: string = DEFAULT_BASE_DIR,
  messageIndex?: number,
): Promise<void> {
  const snapshot: FileHistorySnapshot = {
    messageId,
    trackedFileBackups: new Map(),
    timestamp: new Date(),
    ...(messageIndex !== undefined ? { messageIndex } : {}),
  };

  for (const filePath of state.trackedFiles) {
    const pending = state.pendingTrackEdits.get(filePath);
    if (pending) {
      snapshot.trackedFileBackups.set(filePath, pending);
      continue;
    }

    const lastBackup = findLastBackup(state, filePath);
    let currentStat;
    try {
      currentStat = await stat(filePath);
    } catch {
      const version = (state.fileVersions.get(filePath) ?? 0) + 1;
      state.fileVersions.set(filePath, version);
      snapshot.trackedFileBackups.set(filePath, {
        backupFileName: null,
        version,
        backupTime: new Date(),
      });
      continue;
    }

    if (
      lastBackup &&
      lastBackup.originMtimeMs === currentStat.mtimeMs &&
      lastBackup.originSize === currentStat.size
    ) {
      snapshot.trackedFileBackups.set(filePath, lastBackup);
    } else {
      const version = (state.fileVersions.get(filePath) ?? 0) + 1;
      const backupFileName = await createBackup(filePath, version, sessionId, baseDir);
      state.fileVersions.set(filePath, version);
      snapshot.trackedFileBackups.set(filePath, {
        backupFileName,
        version,
        backupTime: new Date(),
        originMtimeMs: currentStat.mtimeMs,
        originSize: currentStat.size,
      });
    }
  }

  state.snapshots.push(snapshot);
  state.snapshotSequence++;
  state.pendingTrackEdits = new Map();
  state.currentMessageId = undefined;

  if (state.snapshots.length > MAX_SNAPSHOTS) {
    const removed = state.snapshots.shift();
    if (removed) {
      await cleanupExclusiveBackups(state, removed, sessionId, baseDir);
    }
  }

  await saveFileHistoryState(state, sessionId, baseDir);
}

export async function fileHistoryRewind(
  state: FileHistoryState,
  messageId: string,
  sessionId: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<void> {
  const target = state.snapshots.find((s) => s.messageId === messageId);
  if (!target) {
    throw new Error(`FileHistory: 找不到 messageId=${messageId} 的快照`);
  }

  for (const filePath of state.trackedFiles) {
    const backup = target.trackedFileBackups.get(filePath) ?? findFirstBackup(state, filePath);
    if (!backup) continue;
    if (backup.backupFileName === null) {
      await unlink(filePath).catch(() => {});
    } else {
      await restoreBackup(filePath, backup.backupFileName, sessionId, baseDir);
    }
  }
}

export async function fileHistoryDiffStat(
  state: FileHistoryState,
  messageId: string,
  sessionId: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<FileHistoryDiffStat> {
  const target = state.snapshots.find((s) => s.messageId === messageId);
  if (!target) {
    throw new Error(`FileHistory: 找不到 messageId=${messageId} 的快照`);
  }

  const filePaths = Array.from(
    new Set([...state.trackedFiles, ...target.trackedFileBackups.keys()]),
  ).sort();
  const files: FileHistoryDiffFileStat[] = [];

  for (const filePath of filePaths) {
    const backup = target.trackedFileBackups.get(filePath) ?? findFirstBackup(state, filePath);
    const before = await readSnapshotFileContent(backup, sessionId, baseDir);
    const after = await readCurrentFileContent(filePath);
    if (before === after) continue;

    const changes = countLineChanges(before ?? "", after ?? "");
    files.push({
      filePath,
      status: classifyDiffFile(before, after),
      addedLines: changes.addedLines,
      removedLines: changes.removedLines,
    });
  }

  return {
    messageId,
    changedFileCount: files.length,
    addedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
    removedLines: files.reduce((sum, file) => sum + file.removedLines, 0),
    files,
  };
}

async function readSnapshotFileContent(
  backup: FileHistoryBackup | undefined,
  sessionId: string,
  baseDir: string,
): Promise<string | undefined> {
  if (!backup || backup.backupFileName === null) return undefined;
  return readFile(resolveBackupPath(sessionId, backup.backupFileName, baseDir), "utf8");
}

async function readCurrentFileContent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw err;
  }
}

function classifyDiffFile(
  before: string | undefined,
  after: string | undefined,
): FileHistoryDiffFileStatus {
  if (before === undefined) return "created";
  if (after === undefined) return "deleted";
  return "modified";
}

function countLineChanges(
  before: string,
  after: string,
): { addedLines: number; removedLines: number } {
  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }

  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;
  while (
    beforeEnd >= prefix &&
    afterEnd >= prefix &&
    beforeLines[beforeEnd] === afterLines[afterEnd]
  ) {
    beforeEnd--;
    afterEnd--;
  }

  const beforeMiddle = beforeLines.slice(prefix, beforeEnd + 1);
  const afterMiddle = afterLines.slice(prefix, afterEnd + 1);
  const common = longestCommonSubsequenceLength(beforeMiddle, afterMiddle);
  return {
    addedLines: afterMiddle.length - common,
    removedLines: beforeMiddle.length - common,
  };
}

function splitDiffLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function longestCommonSubsequenceLength(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;

  let previous = new Array<number>(right.length + 1).fill(0);
  for (const leftLine of left) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let i = 0; i < right.length; i++) {
      current[i + 1] =
        leftLine === right[i] ? previous[i]! + 1 : Math.max(previous[i + 1]!, current[i]!);
    }
    previous = current;
  }
  return previous[right.length]!;
}

interface PersistedFileHistoryBackup {
  backupFileName: string | null;
  version: number;
  backupTime: string;
  originMtimeMs?: number;
  originSize?: number;
}

interface PersistedFileHistorySnapshot {
  messageId: string;
  trackedFileBackups: Array<[string, PersistedFileHistoryBackup]>;
  timestamp: string;
  messageIndex?: number;
}

interface PersistedFileHistoryState {
  snapshots: PersistedFileHistorySnapshot[];
  trackedFiles: string[];
  snapshotSequence: number;
  fileVersions: Array<[string, number]>;
}

async function saveFileHistoryState(
  state: FileHistoryState,
  sessionId: string,
  baseDir: string,
): Promise<void> {
  const manifest: PersistedFileHistoryState = {
    snapshots: state.snapshots.map((snapshot) => ({
      messageId: snapshot.messageId,
      trackedFileBackups: Array.from(snapshot.trackedFileBackups.entries()).map(
        ([filePath, backup]) => [
          filePath,
          {
            backupFileName: backup.backupFileName,
            version: backup.version,
            backupTime: backup.backupTime.toISOString(),
            ...(backup.originMtimeMs !== undefined ? { originMtimeMs: backup.originMtimeMs } : {}),
            ...(backup.originSize !== undefined ? { originSize: backup.originSize } : {}),
          },
        ],
      ),
      timestamp: snapshot.timestamp.toISOString(),
      ...(snapshot.messageIndex !== undefined ? { messageIndex: snapshot.messageIndex } : {}),
    })),
    trackedFiles: Array.from(state.trackedFiles),
    snapshotSequence: state.snapshotSequence,
    fileVersions: Array.from(state.fileVersions.entries()),
  };

  const manifestPath = resolveManifestPath(sessionId, baseDir);
  const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(tempPath, manifestPath);
}

export async function fileHistoryLoadState(
  state: FileHistoryState,
  sessionId: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(resolveManifestPath(sessionId, baseDir), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw err;
  }

  const manifest = JSON.parse(raw) as PersistedFileHistoryState;
  state.snapshots = manifest.snapshots.map((snapshot) => ({
    messageId: snapshot.messageId,
    trackedFileBackups: new Map(
      snapshot.trackedFileBackups.map(([filePath, backup]) => [
        filePath,
        {
          backupFileName: backup.backupFileName,
          version: backup.version,
          backupTime: new Date(backup.backupTime),
          ...(backup.originMtimeMs !== undefined ? { originMtimeMs: backup.originMtimeMs } : {}),
          ...(backup.originSize !== undefined ? { originSize: backup.originSize } : {}),
        },
      ]),
    ),
    timestamp: new Date(snapshot.timestamp),
    ...(snapshot.messageIndex !== undefined ? { messageIndex: snapshot.messageIndex } : {}),
  }));
  state.trackedFiles = new Set(manifest.trackedFiles);
  state.snapshotSequence = manifest.snapshotSequence;
  state.fileVersions = new Map(manifest.fileVersions);
  state.pendingTrackEdits = new Map();
  state.currentMessageId = undefined;
  return true;
}
