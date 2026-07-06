import { createHash } from "node:crypto";
import { copyFile, mkdir, stat, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const DEFAULT_BASE_DIR = join(homedir(), ".pico", "file-history");

export interface FileHistoryBackup {
  backupFileName: string | null;
  version: number;
  backupTime: Date;
}

export interface FileHistorySnapshot {
  messageId: string;
  trackedFileBackups: Map<string, FileHistoryBackup>;
  timestamp: Date;
}

export interface FileHistoryState {
  snapshots: FileHistorySnapshot[];
  trackedFiles: Set<string>;
  snapshotSequence: number;
  pendingTrackEdits: Map<string, FileHistoryBackup>;
  currentMessageId?: string;
  fileVersions: Map<string, number>;
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

export function resolveBackupPath(
  sessionId: string,
  backupFileName: string,
  baseDir: string = DEFAULT_BASE_DIR,
): string {
  return join(baseDir, sessionId, backupFileName);
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
    await mkdir(join(baseDir, sessionId), { recursive: true });
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
    const backupFileName = await createBackup(filePath, version, sessionId, baseDir);
    backup = { backupFileName, version, backupTime: new Date() };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    backup = { backupFileName: null, version, backupTime: new Date() };
  }

  state.fileVersions.set(filePath, version);
  state.trackedFiles.add(filePath);
  state.pendingTrackEdits.set(filePath, backup);
}
