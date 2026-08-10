import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type JsonDecoder<T> = (value: unknown) => T;

export interface AtomicJsonWriteOptions {
  directoryMode?: number;
  fileMode?: number;
  durability?: "none" | "file" | "file-and-directory";
}

export interface QuarantinedJson {
  originalPath: string;
  quarantinePath: string;
  diagnosticPath: string;
}

export async function readVersionedJson<T>(path: string, decoder: JsonDecoder<T>): Promise<T> {
  const raw = await readFile(path, "utf8");
  return decoder(JSON.parse(raw) as unknown);
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: AtomicJsonWriteOptions = {},
): Promise<void> {
  const directory = dirname(path);
  const directoryMode = options.directoryMode ?? 0o700;
  const fileMode = options.fileMode ?? 0o600;
  const durability = options.durability ?? "file-and-directory";
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );

  await mkdir(directory, { recursive: true, mode: directoryMode });
  await chmod(directory, directoryMode);

  let handle: FileHandle | undefined;
  let published = false;
  try {
    handle = await openWithTransientRetry((mode) => open(temporaryPath, "wx", mode), fileMode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (durability !== "none") await handle.sync();
    await handle.close();
    handle = undefined;

    await renameWithTransientRetry(temporaryPath, path);
    published = true;
    await chmod(path, fileMode);
    if (durability === "file-and-directory") await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function quarantineCorruptJson(
  path: string,
  diagnostic: Record<string, unknown>,
): Promise<QuarantinedJson> {
  const suffix = `${Date.now()}.${randomUUID()}`;
  const quarantinePath = `${path}.corrupt.${suffix}`;
  const diagnosticPath = `${quarantinePath}.diagnostic.json`;
  await rename(path, quarantinePath);
  try {
    await writeJsonAtomic(diagnosticPath, {
      schemaVersion: 1,
      originalPath: path,
      quarantinePath,
      quarantinedAt: new Date().toISOString(),
      ...diagnostic,
    });
  } catch (error) {
    await rename(quarantinePath, path).catch(() => undefined);
    throw error;
  }
  return { originalPath: path, quarantinePath, diagnosticPath };
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (!isNodeError(error)) return false;
  return new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(error.code ?? "");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

/**
 * Windows NTFS 上 rename/open 偶发 EPERM/ENOENT/EACCES/EBUSY（杀毒软件、索引器
 * 或并发 GC 短暂占用）。对齐 syncDirectory 的既有 errno 降级模式，��这些操作
 * 比目录 fsync 更关键（失败会丢数据），故用短退避重试而非静默跳过。
 */
const TRANSIENT_FS_ERRORS = new Set(["EPERM", "EACCES", "EBUSY", "ENOENT"]);
const TRANSIENT_FS_RETRY_LIMIT = 5;
const TRANSIENT_FS_BASE_DELAY_MS = 50;

function isTransientFsError(error: unknown): boolean {
  if (!isNodeError(error)) return false;
  return TRANSIENT_FS_ERRORS.has(error.code ?? "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openWithTransientRetry<T>(
  openFn: (mode: number) => Promise<T>,
  mode: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TRANSIENT_FS_RETRY_LIMIT; attempt += 1) {
    try {
      return await openFn(mode);
    } catch (error) {
      lastError = error;
      if (!isTransientFsError(error) || attempt === TRANSIENT_FS_RETRY_LIMIT - 1) break;
      await sleep(TRANSIENT_FS_BASE_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
}

async function renameWithTransientRetry(src: string, dest: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TRANSIENT_FS_RETRY_LIMIT; attempt += 1) {
    try {
      await rename(src, dest);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientFsError(error) || attempt === TRANSIENT_FS_RETRY_LIMIT - 1) break;
      await sleep(TRANSIENT_FS_BASE_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
}
