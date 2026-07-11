import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  stat,
  lstat,
  chmod,
  unlink,
  readFile,
  readlink,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  addFileChangeJournalWarning,
  beginFileChangeJournal,
  copyFileWithCloneFallback,
  discardFileChangeJournal,
  fileChangeJournalWarnings,
  fileChangeJournalCoversPath,
  fileMatchesPreimage,
  inspectFileChangeJournal,
  type FileChangeJournal,
  type FileChangePreimage,
} from "./file-change-journal.js";

const DEFAULT_BASE_DIR = join(homedir(), ".pico", "file-history");
const MAX_SNAPSHOTS = 100;

export interface FileHistoryBackup {
  backupFileName: string | null;
  version: number;
  backupTime: Date;
  originMtimeMs?: number;
  originSize?: number;
  originMode?: number;
}

export interface FileHistorySnapshot {
  messageId: string;
  trackedFileBackups: Map<string, FileHistoryBackup>;
  timestamp: Date;
  messageIndex?: number;
  /** 顶层用户消息的原始可见文本；旧 manifest 不包含该字段。 */
  userPrompt?: string;
  /** 该用户消息进入 TUI transcript 前的条目下标。 */
  transcriptIndex?: number;
  /** 预留给宿主恢复 default/plan/yolo 等交互模式。 */
  interactionMode?: string;
  /** 本条用户消息执行期间实际触碰过的文件。 */
  editedFilePaths?: Set<string>;
  /** 本条消息的文件事务未完整覆盖工作区时的可见警告。 */
  journalWarnings?: string[];
}

export interface FileHistoryState {
  snapshots: FileHistorySnapshot[];
  trackedFiles: Set<string>;
  snapshotSequence: number;
  pendingTrackEdits: Map<string, FileHistoryBackup>;
  pendingJournalWarnings: Set<string>;
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
  /** true 表示本轮存在无法完整捕获的文件范围。 */
  incomplete?: boolean;
  warnings?: string[];
}

export interface FileHistoryFilePatch extends FileHistoryDiffFileStat {
  patch: string;
  /** 预览时当前文件状态的指纹，单文件恢复前必须重新校验。 */
  currentFingerprint: string;
}

export interface FileHistoryChanges extends Omit<FileHistoryDiffStat, "files"> {
  files: FileHistoryFilePatch[];
  /** 所有文件 patch 按路径排序后的完整文本。 */
  patch: string;
}

export interface FileHistoryRestoreFileResult {
  messageId: string;
  filePath: string;
  status: FileHistoryDiffFileStatus;
  restored: true;
}

/** Engine 层只持有不透明句柄，捕获/扫描细节留在 file-change-journal。 */
export type FileHistoryJournal = FileChangeJournal;

export interface FileHistoryJournalCommitResult {
  incomplete: boolean;
  warnings: string[];
}

export function createFileHistoryState(): FileHistoryState {
  return {
    snapshots: [],
    trackedFiles: new Set(),
    snapshotSequence: 0,
    pendingTrackEdits: new Map(),
    pendingJournalWarnings: new Set(),
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

/**
 * 在工具批次开始前创建写前镜像。COPYFILE_FICLONE 在支持的文件系统上使用
 * copy-on-write，其他文件系统自动回退为普通 copy。镜像位于工作区外，
 * 不会被后续 formatter/script 一起改写。
 */
export async function fileHistoryBeginJournal(
  roots: readonly string[],
  sessionId: string,
  signal?: AbortSignal,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<FileHistoryJournal> {
  const stagingDir = join(baseDir, getSessionDirName(sessionId), ".transactions", randomUUID());
  return beginFileChangeJournal(roots, stagingDir, signal);
}

/** 显式标记事务无法覆盖的副作用（如 background bash）。 */
export function fileHistoryAddJournalWarning(journal: FileHistoryJournal, warning: string): void {
  addFileChangeJournalWarning(journal, warning);
}

/** 当前活动事务已覆盖的精确路径无需再以中途状态创建备份。 */
export function fileHistoryJournalCoversPath(
  journal: FileHistoryJournal,
  filePath: string,
): boolean {
  return fileChangeJournalCoversPath(journal, filePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  beforeCommit?: () => Promise<void>,
): Promise<void> {
  const backupPath = resolveBackupPath(sessionId, backupFileName, baseDir);
  const backupStat = await stat(backupPath);
  const temporaryPath = join(dirname(filePath), `.pico-restore-${randomUUID()}.tmp`);
  await mkdir(dirname(filePath), { recursive: true });
  let committed = false;
  try {
    await copyFile(backupPath, temporaryPath);
    await chmod(temporaryPath, backupStat.mode & 0o777);
    await beforeCommit?.();
    // 同目录临时文件 + rename 替换目录项，不会截断目标 hard link 的共享 inode，
    // 也不会跟随 symlink 写到授权根之外。
    await rename(temporaryPath, filePath);
    committed = true;
  } finally {
    if (!committed) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function fileHistoryTrackEdit(
  state: FileHistoryState,
  filePath: string,
  messageId: string,
  sessionId: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<void> {
  const rewindPoint = state.snapshots.findLast(
    (snapshot) => snapshot.messageId === messageId && snapshot.userPrompt !== undefined,
  );
  if (rewindPoint) {
    const editedFilePaths = rewindPoint.editedFilePaths ?? new Set<string>();
    rewindPoint.editedFilePaths = editedFilePaths;
    if (editedFilePaths.has(filePath)) return;

    // 用户级 rewind point 在 prompt 进入模型前已捕获所有已跟踪文件。
    // 首次出现的新路径仍需在写前补一份备份，然后把它追加入该点。
    if (!rewindPoint.trackedFileBackups.has(filePath)) {
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
          originMode: srcStat.mode & 0o777,
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
        backup = { backupFileName: null, version, backupTime: new Date() };
      }
      state.fileVersions.set(filePath, version);
      rewindPoint.trackedFileBackups.set(filePath, backup);
    }

    state.trackedFiles.add(filePath);
    editedFilePaths.add(filePath);
    await saveFileHistoryState(state, sessionId, baseDir);
    return;
  }

  if (state.currentMessageId !== messageId) {
    state.pendingTrackEdits = new Map();
    state.pendingJournalWarnings = new Set();
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
      originMode: srcStat.mode & 0o777,
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

/**
 * 工具批次结束后提交事务：只将真正发生变化的路径写入 rewind point。
 * 被覆盖/删除的文件使用事务开始时的 staged preimage，新建文件则记为 null。
 */
export async function fileHistoryCommitJournal(
  state: FileHistoryState,
  journal: FileHistoryJournal,
  messageId: string,
  sessionId: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<FileHistoryJournalCommitResult> {
  let changed = false;
  try {
    const current = await inspectFileChangeJournal(journal);
    const changedPreimages: Array<[string, FileChangePreimage]> = [];

    for (const [filePath, preimage] of journal.preimages) {
      const currentMetadata = current.files.get(filePath);
      if (!currentMetadata || current.excludedPaths.has(filePath)) {
        changedPreimages.push([filePath, preimage]);
        continue;
      }
      if (preimage.size !== currentMetadata.size || preimage.mode !== currentMetadata.mode) {
        changedPreimages.push([filePath, preimage]);
        continue;
      }
      try {
        if (!(await fileMatchesPreimage(filePath, preimage))) {
          changedPreimages.push([filePath, preimage]);
        }
      } catch (error) {
        addFileChangeJournalWarning(
          journal,
          `无法核对工具执行后内容 ${filePath}: ${errorMessage(error)}`,
        );
      }
    }

    for (const [filePath, baseline] of journal.baseline.files) {
      if (journal.preimages.has(filePath)) continue;
      const after = current.files.get(filePath);
      if (
        !after ||
        current.excludedPaths.has(filePath) ||
        baseline.size !== after.size ||
        baseline.mode !== after.mode ||
        baseline.mtimeMs !== after.mtimeMs
      ) {
        addFileChangeJournalWarning(
          journal,
          `未捕获写前内容的文件已变化，无法安全 rewind: ${filePath}`,
        );
      }
    }

    for (const [filePath] of current.files) {
      if (
        journal.baseline.files.has(filePath) ||
        journal.baseline.excludedPaths.has(filePath) ||
        !journal.baseline.complete ||
        !current.complete
      ) {
        continue;
      }
      try {
        if (await recordJournalChange(state, filePath, undefined, messageId, sessionId, baseDir)) {
          changed = true;
        }
      } catch (error) {
        addFileChangeJournalWarning(
          journal,
          `无法记录新建文件 ${filePath}: ${errorMessage(error)}`,
        );
      }
    }

    for (const [filePath, preimage] of changedPreimages) {
      try {
        if (await recordJournalChange(state, filePath, preimage, messageId, sessionId, baseDir)) {
          changed = true;
        }
      } catch (error) {
        addFileChangeJournalWarning(
          journal,
          `无法提交写前备份 ${filePath}: ${errorMessage(error)}`,
        );
      }
    }

    const warnings = fileChangeJournalWarnings(journal);
    attachJournalWarnings(state, messageId, warnings);
    if (changed || warnings.length > 0) {
      await saveFileHistoryState(state, sessionId, baseDir);
    }
    return {
      incomplete: warnings.length > 0,
      warnings,
    };
  } finally {
    await discardFileChangeJournal(journal);
  }
}

async function recordJournalChange(
  state: FileHistoryState,
  filePath: string,
  preimage: FileChangePreimage | undefined,
  messageId: string,
  sessionId: string,
  baseDir: string,
): Promise<boolean> {
  const rewindPoint = state.snapshots.findLast(
    (snapshot) => snapshot.messageId === messageId && snapshot.userPrompt !== undefined,
  );
  if (rewindPoint) {
    const editedFilePaths = rewindPoint.editedFilePaths ?? new Set<string>();
    rewindPoint.editedFilePaths = editedFilePaths;
    if (editedFilePaths.has(filePath)) return false;
    const existing = rewindPoint.trackedFileBackups.get(filePath);
    if (!(await backupMatchesPreimage(existing, preimage, sessionId, baseDir))) {
      const backup = await journalBackup(filePath, preimage, state, sessionId, baseDir);
      rewindPoint.trackedFileBackups.set(filePath, backup);
    }
    state.trackedFiles.add(filePath);
    editedFilePaths.add(filePath);
    return true;
  }

  if (state.currentMessageId !== messageId) {
    state.pendingTrackEdits = new Map();
    state.pendingJournalWarnings = new Set();
    state.currentMessageId = messageId;
  }
  if (state.pendingTrackEdits.has(filePath)) return false;
  const backup = await journalBackup(filePath, preimage, state, sessionId, baseDir);
  state.pendingTrackEdits.set(filePath, backup);
  state.trackedFiles.add(filePath);
  return true;
}

async function backupMatchesPreimage(
  backup: FileHistoryBackup | undefined,
  preimage: FileChangePreimage | undefined,
  sessionId: string,
  baseDir: string,
): Promise<boolean> {
  if (!backup) return false;
  if (!preimage) return backup.backupFileName === null;
  if (backup.backupFileName === null || backup.originMode !== preimage.mode) return false;
  try {
    return await fileMatchesPreimage(
      resolveBackupPath(sessionId, backup.backupFileName, baseDir),
      preimage,
    );
  } catch {
    return false;
  }
}

async function journalBackup(
  filePath: string,
  preimage: FileChangePreimage | undefined,
  state: FileHistoryState,
  sessionId: string,
  baseDir: string,
): Promise<FileHistoryBackup> {
  const version = (state.fileVersions.get(filePath) ?? 0) + 1;
  state.fileVersions.set(filePath, version);
  if (!preimage) {
    return { backupFileName: null, version, backupTime: new Date() };
  }

  const backupFileName = getBackupFileName(filePath, version);
  const backupPath = resolveBackupPath(sessionId, backupFileName, baseDir);
  await mkdir(dirname(backupPath), { recursive: true });
  await copyFileWithCloneFallback(preimage.stagedPath, backupPath);
  await chmod(backupPath, preimage.mode);
  return {
    backupFileName,
    version,
    backupTime: new Date(),
    originMtimeMs: preimage.mtimeMs,
    originSize: preimage.size,
    originMode: preimage.mode,
  };
}

function attachJournalWarnings(
  state: FileHistoryState,
  messageId: string,
  warnings: readonly string[],
): void {
  if (warnings.length === 0) return;
  const rewindPoint = state.snapshots.findLast(
    (snapshot) => snapshot.messageId === messageId && snapshot.userPrompt !== undefined,
  );
  if (rewindPoint) {
    rewindPoint.journalWarnings = [
      ...new Set([...(rewindPoint.journalWarnings ?? []), ...warnings]),
    ];
    return;
  }
  if (state.currentMessageId !== messageId) {
    state.pendingTrackEdits = new Map();
    state.pendingJournalWarnings = new Set();
    state.currentMessageId = messageId;
  }
  for (const warning of warnings) state.pendingJournalWarnings.add(warning);
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
  metadata?: { userPrompt: string; transcriptIndex?: number; interactionMode?: string },
): Promise<void> {
  const snapshot: FileHistorySnapshot = {
    messageId,
    trackedFileBackups: new Map(),
    timestamp: new Date(),
    editedFilePaths: new Set(),
    ...(state.pendingJournalWarnings.size > 0
      ? { journalWarnings: [...state.pendingJournalWarnings] }
      : {}),
    ...(messageIndex !== undefined ? { messageIndex } : {}),
    ...(metadata !== undefined ? { userPrompt: metadata.userPrompt } : {}),
    ...(metadata?.transcriptIndex !== undefined
      ? { transcriptIndex: metadata.transcriptIndex }
      : {}),
    ...(metadata?.interactionMode !== undefined
      ? { interactionMode: metadata.interactionMode }
      : {}),
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
      lastBackup.originSize === currentStat.size &&
      lastBackup.originMode === (currentStat.mode & 0o777)
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
        originMode: currentStat.mode & 0o777,
      });
    }
  }

  state.snapshots.push(snapshot);
  state.snapshotSequence++;
  state.pendingTrackEdits = new Map();
  state.pendingJournalWarnings = new Set();
  state.currentMessageId = metadata === undefined ? undefined : messageId;

  if (state.snapshots.length > MAX_SNAPSHOTS) {
    const removed = state.snapshots.shift();
    if (removed) {
      await cleanupExclusiveBackups(state, removed, sessionId, baseDir);
    }
  }

  await saveFileHistoryState(state, sessionId, baseDir);
}

/**
 * 在顶层用户消息进入模型前建立 Claude Code 风格的 rewind 边界。
 * 后续写操作会把首次写前备份追加入这个点，而不是为内部 ReAct turn 建点。
 */
export async function fileHistoryBeginRewindPoint(
  state: FileHistoryState,
  input: {
    messageId: string;
    userPrompt: string;
    messageIndex: number;
    transcriptIndex?: number;
    interactionMode?: string;
  },
  sessionId: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<void> {
  await fileHistoryMakeSnapshot(state, input.messageId, sessionId, baseDir, input.messageIndex, {
    userPrompt: input.userPrompt,
    ...(input.transcriptIndex !== undefined ? { transcriptIndex: input.transcriptIndex } : {}),
    ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
  });
}

/** 对话 fork 后只保留目标消息之前的活动 rewind points。 */
export async function fileHistoryDiscardFrom(
  state: FileHistoryState,
  messageId: string,
  sessionId: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<void> {
  const targetIndex = state.snapshots.findIndex((snapshot) => snapshot.messageId === messageId);
  if (targetIndex === -1) return;
  state.snapshots = state.snapshots.slice(0, targetIndex);
  state.pendingTrackEdits = new Map();
  state.pendingJournalWarnings = new Set();
  state.currentMessageId = undefined;
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
      await removeCreatedFileForRewind(filePath);
    } else {
      await restoreBackup(filePath, backup.backupFileName, sessionId, baseDir);
    }
  }
}

async function removeCreatedFileForRewind(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() && !info.isSymbolicLink()) {
      throw new Error(`FileHistory: ${filePath} 当前不是普通文件，拒绝递归删除`);
    }
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    const afterMode = await readCurrentFileMode(filePath);
    const modeChanged =
      backup?.originMode !== undefined &&
      afterMode !== undefined &&
      backup.originMode !== afterMode;
    if (before === after && !modeChanged) continue;

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
    ...(target.journalWarnings?.length
      ? { incomplete: true, warnings: [...target.journalWarnings] }
      : {}),
  };
}

/**
 * 读取某个 rewind point 到当前磁盘的完整 patch，供 TUI Changes 面板使用。
 * 此函数只读，不创建临时文件，也不改变 file-history state。
 */
export async function fileHistoryChanges(
  state: FileHistoryState,
  messageId: string,
  sessionId: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<FileHistoryChanges> {
  const target = state.snapshots.find((snapshot) => snapshot.messageId === messageId);
  if (!target) {
    throw new Error(`FileHistory: 找不到 messageId=${messageId} 的快照`);
  }
  const stat = await fileHistoryDiffStat(state, messageId, sessionId, baseDir);
  const files: FileHistoryFilePatch[] = [];
  for (const file of stat.files) {
    const backup =
      target.trackedFileBackups.get(file.filePath) ?? findFirstBackup(state, file.filePath);
    const before = await readSnapshotFileContent(backup, sessionId, baseDir);
    const current = await readCurrentFileState(file.filePath);
    const after = current.content;
    const afterMode = current.mode;
    files.push({
      ...file,
      currentFingerprint: current.fingerprint,
      patch: createUnifiedFilePatch({
        filePath: file.filePath,
        before,
        after,
        beforeMode: backup?.originMode,
        afterMode,
      }),
    });
  }
  return {
    ...stat,
    files,
    patch: files
      .map((file) => file.patch)
      .filter(Boolean)
      .join("\n\n"),
  };
}

/**
 * 只恢复 Changes 面板中已确认属于该 rewind point 的单个变化文件。
 * 任意未出现在当前 diff 的路径都会被拒绝，避免把 UI 字符串变成任意写入口。
 */
export async function fileHistoryRestoreFile(
  state: FileHistoryState,
  messageId: string,
  filePath: string,
  expectedCurrentFingerprint: string,
  sessionId: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<FileHistoryRestoreFileResult> {
  const target = state.snapshots.find((snapshot) => snapshot.messageId === messageId);
  if (!target) {
    throw new Error(`FileHistory: 找不到 messageId=${messageId} 的快照`);
  }
  const stat = await fileHistoryDiffStat(state, messageId, sessionId, baseDir);
  const changedFile = stat.files.find((file) => file.filePath === filePath);
  if (!changedFile) {
    throw new Error(`FileHistory: ${filePath} 不属于快照 ${messageId} 的当前变化`);
  }
  const backup = target.trackedFileBackups.get(filePath) ?? findFirstBackup(state, filePath);
  if (!backup) {
    throw new Error(`FileHistory: ${filePath} 缺少可恢复的写前状态`);
  }
  const verifyCurrentState = async (): Promise<CurrentFileState> => {
    const latest = await readCurrentFileState(filePath);
    if (latest.fingerprint !== expectedCurrentFingerprint) {
      throw new Error(`FileHistory: ${filePath} 在预览后又发生变化，请刷新 Changes 后重试`);
    }
    if (latest.kind !== "file" && latest.kind !== "missing") {
      throw new Error(`FileHistory: ${filePath} 当前不是普通文件，拒绝执行单文件恢复`);
    }
    return latest;
  };
  await verifyCurrentState();
  if (backup.backupFileName === null) {
    const latest = await verifyCurrentState();
    if (latest.kind === "file") await unlink(filePath);
  } else {
    await restoreBackup(filePath, backup.backupFileName, sessionId, baseDir, async () => {
      await verifyCurrentState();
    });
  }
  return { messageId, filePath, status: changedFile.status, restored: true };
}

interface CurrentFileState {
  kind: "file" | "missing" | "directory" | "symlink" | "special";
  content: string | undefined;
  mode: number | undefined;
  fingerprint: string;
}

/**
 * 单次读取生成 Changes 的比较状态。非普通文件也有独立指纹，避免把 missing、
 * 目录和 symlink 混为一谈后在恢复时递归删除后来出现的目录。
 */
async function readCurrentFileState(filePath: string): Promise<CurrentFileState> {
  try {
    const info = await lstat(filePath);
    if (info.isFile()) {
      const content = await readFile(filePath);
      const mode = info.mode & 0o777;
      return {
        kind: "file",
        content: content.toString("utf8"),
        mode,
        fingerprint: fileStateFingerprint("file", mode, content),
      };
    }
    if (info.isSymbolicLink()) {
      const target = await readlink(filePath);
      return {
        kind: "symlink",
        content: undefined,
        mode: undefined,
        fingerprint: fileStateFingerprint("symlink", info.mode & 0o777, target),
      };
    }
    const kind = info.isDirectory() ? "directory" : "special";
    return {
      kind,
      content: undefined,
      mode: undefined,
      fingerprint: fileStateFingerprint(
        kind,
        info.mode & 0o777,
        `${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        kind: "missing",
        content: undefined,
        mode: undefined,
        fingerprint: fileStateFingerprint("missing", undefined, ""),
      };
    }
    throw error;
  }
}

function fileStateFingerprint(
  kind: "file" | "missing" | "directory" | "symlink" | "special",
  mode: number | undefined,
  content: string | Buffer,
): string {
  const hash = createHash("sha256");
  hash.update(kind);
  hash.update("\0");
  hash.update(mode === undefined ? "" : String(mode));
  hash.update("\0");
  hash.update(content);
  return hash.digest("hex");
}

/**
 * 统计某条用户消息自身造成的文件变化：before 是该消息的 rewind point，
 * after 是下一条用户消息进入模型前的 point；末条消息则与当前磁盘比较。
 */
export async function fileHistoryMessageDiffStat(
  state: FileHistoryState,
  messageId: string,
  sessionId: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<FileHistoryDiffStat> {
  const targetIndex = state.snapshots.findIndex((snapshot) => snapshot.messageId === messageId);
  const target = state.snapshots[targetIndex];
  if (!target) {
    throw new Error(`FileHistory: 找不到 messageId=${messageId} 的快照`);
  }
  const next = state.snapshots
    .slice(targetIndex + 1)
    .find((snapshot) => snapshot.userPrompt !== undefined);
  const candidatePaths =
    target.editedFilePaths !== undefined
      ? Array.from(target.editedFilePaths)
      : Array.from(target.trackedFileBackups.keys());
  const files: FileHistoryDiffFileStat[] = [];

  for (const filePath of candidatePaths.sort()) {
    const beforeBackup =
      target.trackedFileBackups.get(filePath) ?? findFirstBackup(state, filePath);
    const before = await readSnapshotFileContent(beforeBackup, sessionId, baseDir);
    const afterBackup = next?.trackedFileBackups.get(filePath);
    const after = next
      ? await readSnapshotFileContent(afterBackup, sessionId, baseDir)
      : await readCurrentFileContent(filePath);
    const afterMode = next ? afterBackup?.originMode : await readCurrentFileMode(filePath);
    const modeChanged =
      beforeBackup?.originMode !== undefined &&
      afterMode !== undefined &&
      beforeBackup.originMode !== afterMode;
    if (before === after && !modeChanged) continue;
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
    ...(target.journalWarnings?.length
      ? { incomplete: true, warnings: [...target.journalWarnings] }
      : {}),
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
    const info = await lstat(filePath);
    if (!info.isFile()) return undefined;
    return await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw err;
  }
}

async function readCurrentFileMode(filePath: string): Promise<number | undefined> {
  try {
    const info = await lstat(filePath);
    return info.isFile() ? info.mode & 0o777 : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
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

export function createUnifiedFilePatch(input: {
  filePath: string;
  before: string | undefined;
  after: string | undefined;
  beforeMode?: number;
  afterMode?: number;
}): string {
  const beforeLabel = input.before === undefined ? "/dev/null" : input.filePath;
  const afterLabel = input.after === undefined ? "/dev/null" : input.filePath;
  const lines: string[] = [`--- ${beforeLabel}`, `+++ ${afterLabel}`];
  if (input.before === undefined && input.afterMode !== undefined) {
    lines.unshift(`new file mode ${formatFileMode(input.afterMode)}`);
  } else if (input.after === undefined && input.beforeMode !== undefined) {
    lines.unshift(`deleted file mode ${formatFileMode(input.beforeMode)}`);
  } else if (
    input.beforeMode !== undefined &&
    input.afterMode !== undefined &&
    input.beforeMode !== input.afterMode
  ) {
    lines.unshift(
      `old mode ${formatFileMode(input.beforeMode)}`,
      `new mode ${formatFileMode(input.afterMode)}`,
    );
  }

  const beforeLines = splitDiffLines(input.before ?? "");
  const afterLines = splitDiffLines(input.after ?? "");
  if (input.before === input.after) return lines.join("\n");
  const prefixLength = commonPrefixLength(beforeLines, afterLines);
  const suffixLength = commonSuffixLength(beforeLines, afterLines, prefixLength);
  const beforeMiddle = beforeLines.slice(prefixLength, beforeLines.length - suffixLength);
  const afterMiddle = afterLines.slice(prefixLength, afterLines.length - suffixLength);
  lines.push(
    `@@ -${beforeLines.length === 0 ? 0 : 1},${beforeLines.length} +${
      afterLines.length === 0 ? 0 : 1
    },${afterLines.length} @@`,
    ...beforeLines.slice(0, prefixLength).flatMap((line) => renderDiffLine(" ", line)),
    ...buildLinePatch(beforeMiddle, afterMiddle),
    ...beforeLines
      .slice(beforeLines.length - suffixLength)
      .flatMap((line) => renderDiffLine(" ", line)),
  );
  return lines.join("\n");
}

interface DiffTextLine {
  text: string;
  /** false 表示该行到 EOF 时没有换行符。 */
  terminated: boolean;
}

/** Hirschberg LCS：保持完整、准确的上下文行，同时避免为大文件分配 O(n*m) 矩阵。 */
function buildLinePatch(before: readonly DiffTextLine[], after: readonly DiffTextLine[]): string[] {
  if (before.length === 0) return after.flatMap((line) => renderDiffLine("+", line));
  if (after.length === 0) return before.flatMap((line) => renderDiffLine("-", line));

  if (before.length === 1) {
    const commonIndex = after.findIndex((line) => sameDiffLine(line, before[0]!));
    if (commonIndex === -1) {
      return [
        ...renderDiffLine("-", before[0]!),
        ...after.flatMap((line) => renderDiffLine("+", line)),
      ];
    }
    return [
      ...after.slice(0, commonIndex).flatMap((line) => renderDiffLine("+", line)),
      ...renderDiffLine(" ", before[0]!),
      ...after.slice(commonIndex + 1).flatMap((line) => renderDiffLine("+", line)),
    ];
  }
  if (after.length === 1) {
    const commonIndex = before.findIndex((line) => sameDiffLine(line, after[0]!));
    if (commonIndex === -1) {
      return [
        ...before.flatMap((line) => renderDiffLine("-", line)),
        ...renderDiffLine("+", after[0]!),
      ];
    }
    return [
      ...before.slice(0, commonIndex).flatMap((line) => renderDiffLine("-", line)),
      ...renderDiffLine(" ", after[0]!),
      ...before.slice(commonIndex + 1).flatMap((line) => renderDiffLine("-", line)),
    ];
  }

  const beforeMiddle = Math.floor(before.length / 2);
  const leftScores = lcsLengthRow(before.slice(0, beforeMiddle), after);
  const rightScores = lcsLengthRow(before.slice(beforeMiddle).toReversed(), after.toReversed());
  let afterMiddle = 0;
  let bestScore = -1;
  for (let index = 0; index <= after.length; index++) {
    const score = leftScores[index]! + rightScores[after.length - index]!;
    if (score > bestScore) {
      bestScore = score;
      afterMiddle = index;
    }
  }
  return [
    ...buildLinePatch(before.slice(0, beforeMiddle), after.slice(0, afterMiddle)),
    ...buildLinePatch(before.slice(beforeMiddle), after.slice(afterMiddle)),
  ];
}

function lcsLengthRow(left: readonly DiffTextLine[], right: readonly DiffTextLine[]): number[] {
  let previous = new Array<number>(right.length + 1).fill(0);
  for (const leftLine of left) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let index = 0; index < right.length; index++) {
      current[index + 1] = sameDiffLine(leftLine, right[index]!)
        ? previous[index]! + 1
        : Math.max(previous[index + 1]!, current[index]!);
    }
    previous = current;
  }
  return previous;
}

function commonPrefixLength(left: readonly DiffTextLine[], right: readonly DiffTextLine[]): number {
  let length = 0;
  while (
    length < left.length &&
    length < right.length &&
    sameDiffLine(left[length]!, right[length]!)
  ) {
    length++;
  }
  return length;
}

function commonSuffixLength(
  left: readonly DiffTextLine[],
  right: readonly DiffTextLine[],
  prefixLength: number,
): number {
  let length = 0;
  while (
    length < left.length - prefixLength &&
    length < right.length - prefixLength &&
    sameDiffLine(left[left.length - length - 1]!, right[right.length - length - 1]!)
  ) {
    length++;
  }
  return length;
}

function formatFileMode(mode: number): string {
  return `100${(mode & 0o777).toString(8).padStart(3, "0")}`;
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
    sameDiffLine(beforeLines[prefix]!, afterLines[prefix]!)
  ) {
    prefix++;
  }

  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;
  while (
    beforeEnd >= prefix &&
    afterEnd >= prefix &&
    sameDiffLine(beforeLines[beforeEnd]!, afterLines[afterEnd]!)
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

function splitDiffLines(value: string): DiffTextLine[] {
  if (value.length === 0) return [];
  const terminatedAtEof = value.endsWith("\n");
  const lines = value.split("\n");
  if (terminatedAtEof) lines.pop();
  return lines.map((text, index) => ({
    text,
    terminated: index < lines.length - 1 || terminatedAtEof,
  }));
}

function longestCommonSubsequenceLength(
  left: readonly DiffTextLine[],
  right: readonly DiffTextLine[],
): number {
  if (left.length === 0 || right.length === 0) return 0;
  return lcsLengthRow(left, right)[right.length]!;
}

function sameDiffLine(left: DiffTextLine, right: DiffTextLine): boolean {
  return left.text === right.text && left.terminated === right.terminated;
}

function renderDiffLine(prefix: " " | "+" | "-", line: DiffTextLine): string[] {
  return line.terminated
    ? [`${prefix}${line.text}`]
    : [`${prefix}${line.text}`, "\\ No newline at end of file"];
}

interface PersistedFileHistoryBackup {
  backupFileName: string | null;
  version: number;
  backupTime: string;
  originMtimeMs?: number;
  originSize?: number;
  originMode?: number;
}

interface PersistedFileHistorySnapshot {
  messageId: string;
  trackedFileBackups: Array<[string, PersistedFileHistoryBackup]>;
  timestamp: string;
  messageIndex?: number;
  userPrompt?: string;
  transcriptIndex?: number;
  interactionMode?: string;
  editedFilePaths?: string[];
  journalWarnings?: string[];
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
            ...(backup.originMode !== undefined ? { originMode: backup.originMode } : {}),
          },
        ],
      ),
      timestamp: snapshot.timestamp.toISOString(),
      ...(snapshot.messageIndex !== undefined ? { messageIndex: snapshot.messageIndex } : {}),
      ...(snapshot.userPrompt !== undefined ? { userPrompt: snapshot.userPrompt } : {}),
      ...(snapshot.transcriptIndex !== undefined
        ? { transcriptIndex: snapshot.transcriptIndex }
        : {}),
      ...(snapshot.interactionMode !== undefined
        ? { interactionMode: snapshot.interactionMode }
        : {}),
      ...(snapshot.editedFilePaths !== undefined
        ? { editedFilePaths: Array.from(snapshot.editedFilePaths) }
        : {}),
      ...(snapshot.journalWarnings !== undefined
        ? { journalWarnings: [...snapshot.journalWarnings] }
        : {}),
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
          ...(backup.originMode !== undefined ? { originMode: backup.originMode } : {}),
        },
      ]),
    ),
    timestamp: new Date(snapshot.timestamp),
    ...(snapshot.editedFilePaths !== undefined
      ? { editedFilePaths: new Set(snapshot.editedFilePaths) }
      : {}),
    ...(snapshot.journalWarnings !== undefined
      ? { journalWarnings: [...snapshot.journalWarnings] }
      : {}),
    ...(snapshot.messageIndex !== undefined ? { messageIndex: snapshot.messageIndex } : {}),
    ...(snapshot.userPrompt !== undefined ? { userPrompt: snapshot.userPrompt } : {}),
    ...(snapshot.transcriptIndex !== undefined
      ? { transcriptIndex: snapshot.transcriptIndex }
      : {}),
    ...(snapshot.interactionMode !== undefined
      ? { interactionMode: snapshot.interactionMode }
      : {}),
  }));
  state.trackedFiles = new Set(manifest.trackedFiles);
  state.snapshotSequence = manifest.snapshotSequence;
  state.fileVersions = new Map(manifest.fileVersions);
  state.pendingTrackEdits = new Map();
  state.pendingJournalWarnings = new Set();
  state.currentMessageId = undefined;
  return true;
}
