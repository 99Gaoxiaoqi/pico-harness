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
    handle = await open(temporaryPath, "wx", fileMode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (durability !== "none") await handle.sync();
    await handle.close();
    handle = undefined;

    await rename(temporaryPath, path);
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
