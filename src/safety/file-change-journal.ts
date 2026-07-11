import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_WARNINGS = 20;
const IGNORED_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".claw",
  ".svn",
  ".hg",
  ".cache",
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  "dist",
  "build",
  ".worktrees",
]);

export interface FileChangeMetadata {
  size: number;
  mtimeMs: number;
  mode: number;
}

export interface FileChangePreimage extends FileChangeMetadata {
  stagedPath: string;
  hash: string;
}

export interface FileChangeScan {
  files: Map<string, FileChangeMetadata>;
  excludedPaths: Set<string>;
  complete: boolean;
}

export interface FileChangeJournal {
  readonly stagingDir: string;
  readonly roots: readonly string[];
  readonly baseline: FileChangeScan;
  readonly preimages: Map<string, FileChangePreimage>;
  readonly warnings: string[];
  readonly ignoredNames: Set<string>;
  warningOverflow: number;
  capturedBytes: number;
  nextEntryId: number;
}

/** 在工具执行前将工作区普通文件复制到工作区外的临时事务目录。 */
export async function beginFileChangeJournal(
  roots: readonly string[],
  stagingDir: string,
  signal?: AbortSignal,
): Promise<FileChangeJournal> {
  const journal: FileChangeJournal = {
    stagingDir,
    roots: [...new Set(roots)],
    baseline: emptyScan(),
    preimages: new Map(),
    warnings: [],
    ignoredNames: new Set(),
    warningOverflow: 0,
    capturedBytes: 0,
    nextEntryId: 0,
  };

  try {
    await mkdir(stagingDir, { recursive: true });
  } catch (error) {
    journal.baseline.complete = false;
    addFileChangeJournalWarning(journal, `无法创建写前事务目录: ${message(error)}`);
    return journal;
  }

  try {
    await scanWorkspace(journal, journal.baseline, signal);
    for (const [filePath, metadata] of journal.baseline.files) {
      signal?.throwIfAborted();
      await capturePreimage(journal, filePath, metadata, signal);
    }
    appendIgnoredWarning(journal);
    return journal;
  } catch (error) {
    await discardFileChangeJournal(journal);
    throw error;
  }
}

/** 工具批次结束后扫描同一范围，供调用方与 baseline/preimage 比较。 */
export async function inspectFileChangeJournal(
  journal: FileChangeJournal,
): Promise<FileChangeScan> {
  const current = emptyScan();
  await scanWorkspace(journal, current);
  appendIgnoredWarning(journal);
  return current;
}

export function addFileChangeJournalWarning(journal: FileChangeJournal, warning: string): void {
  if (journal.warnings.includes(warning)) return;
  if (journal.warnings.length < MAX_WARNINGS) {
    journal.warnings.push(warning);
  } else {
    journal.warningOverflow++;
  }
}

export function fileChangeJournalWarnings(journal: FileChangeJournal): string[] {
  const warnings = [...journal.warnings];
  if (journal.warningOverflow > 0) {
    warnings.push(`另有 ${journal.warningOverflow} 条文件 journal 覆盖警告`);
  }
  return warnings;
}

export async function discardFileChangeJournal(journal: FileChangeJournal): Promise<void> {
  await rm(journal.stagingDir, { recursive: true, force: true }).catch(() => {});
}

export async function fileMatchesPreimage(
  filePath: string,
  preimage: FileChangePreimage,
): Promise<boolean> {
  return (await hashFile(filePath)) === preimage.hash;
}

export async function copyFileWithCloneFallback(source: string, target: string): Promise<void> {
  try {
    await copyFile(source, target, constants.COPYFILE_FICLONE);
  } catch (cloneError) {
    try {
      await copyFile(source, target);
    } catch (copyError) {
      throw new Error(`clone 失败: ${message(cloneError)}; copy 失败: ${message(copyError)}`, {
        cause: copyError,
      });
    }
  }
}

function emptyScan(): FileChangeScan {
  return { files: new Map(), excludedPaths: new Set(), complete: true };
}

async function scanWorkspace(
  journal: FileChangeJournal,
  result: FileChangeScan,
  signal?: AbortSignal,
): Promise<void> {
  for (const root of journal.roots) {
    signal?.throwIfAborted();
    await scanDirectory(journal, result, root, signal);
  }
}

async function scanDirectory(
  journal: FileChangeJournal,
  result: FileChangeScan,
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    result.complete = false;
    addFileChangeJournalWarning(journal, `无法扫描目录 ${directory}: ${message(error)}`);
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    signal?.throwIfAborted();
    const filePath = join(directory, entry.name);
    if (IGNORED_NAMES.has(entry.name)) {
      journal.ignoredNames.add(entry.name);
    } else if (entry.isDirectory()) {
      await scanDirectory(journal, result, filePath, signal);
    } else if (!entry.isFile()) {
      result.excludedPaths.add(filePath);
      addFileChangeJournalWarning(journal, `未捕获非普通文件: ${filePath}`);
    } else if (!result.files.has(filePath)) {
      try {
        const info = await stat(filePath);
        result.files.set(filePath, {
          size: info.size,
          mtimeMs: info.mtimeMs,
          mode: info.mode & 0o777,
        });
      } catch (error) {
        result.complete = false;
        result.excludedPaths.add(filePath);
        addFileChangeJournalWarning(journal, `无法读取文件元数据 ${filePath}: ${message(error)}`);
      }
    }
  }
}

async function capturePreimage(
  journal: FileChangeJournal,
  filePath: string,
  metadata: FileChangeMetadata,
  signal?: AbortSignal,
): Promise<void> {
  if (journal.preimages.size >= MAX_FILES) {
    addFileChangeJournalWarning(journal, `写前镜像超过 ${MAX_FILES} 个文件上限: ${filePath}`);
    return;
  }
  if (metadata.size > MAX_FILE_BYTES) {
    addFileChangeJournalWarning(journal, `文件超过 ${MAX_FILE_BYTES} bytes 上限: ${filePath}`);
    return;
  }
  if (journal.capturedBytes + metadata.size > MAX_TOTAL_BYTES) {
    addFileChangeJournalWarning(journal, `写前镜像超过 ${MAX_TOTAL_BYTES} bytes 上限: ${filePath}`);
    return;
  }

  const stagedPath = join(journal.stagingDir, `${journal.nextEntryId++}.preimage`);
  try {
    await copyFileWithCloneFallback(filePath, stagedPath);
    signal?.throwIfAborted();
    const hash = await hashFile(stagedPath, signal);
    const after = await stat(filePath);
    if (
      metadata.size !== after.size ||
      metadata.mtimeMs !== after.mtimeMs ||
      metadata.mode !== (after.mode & 0o777)
    ) {
      addFileChangeJournalWarning(journal, `文件在写前镜像期间发生并发变化: ${filePath}`);
    }
    journal.preimages.set(filePath, { ...metadata, stagedPath, hash });
    journal.capturedBytes += metadata.size;
  } catch (error) {
    await unlink(stagedPath).catch(() => {});
    if (signal?.aborted) throw error;
    addFileChangeJournalWarning(journal, `无法捕获写前内容 ${filePath}: ${message(error)}`);
  }
}

async function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath, signal ? { signal } : undefined);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function appendIgnoredWarning(journal: FileChangeJournal): void {
  if (journal.ignoredNames.size === 0) return;
  addFileChangeJournalWarning(
    journal,
    `rewind 按策略不覆盖: ${[...journal.ignoredNames].sort().join(", ")}`,
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
