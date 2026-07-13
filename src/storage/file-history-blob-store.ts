import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const SHA256_DIGEST_RE = /^[0-9a-f]{64}$/;
const COPY_BUFFER_BYTES = 64 * 1024;

export interface FileHistoryBlobRef {
  algorithm: "sha256";
  digest: string;
  sizeBytes: number;
}

export interface FileHistoryBlobWriteResult {
  ref: FileHistoryBlobRef;
  path: string;
  created: boolean;
}

export interface FileHistoryBlobStoreOptions {
  baseDir: string;
}

export class FileHistoryBlobIntegrityError extends Error {
  readonly digest: string;
  readonly blobPath: string;

  constructor(digest: string, blobPath: string, detail: string) {
    super(`File-history blob ${digest} failed integrity validation: ${detail}`);
    this.name = "FileHistoryBlobIntegrityError";
    this.digest = digest;
    this.blobPath = blobPath;
  }
}

/**
 * Content-addressed storage used by File History v2. Blobs are immutable and
 * stored at blobs/sha256/<first two digest characters>/<full digest>.
 */
export class FileHistoryBlobStore {
  private readonly baseDir: string;
  private readonly stagingDir: string;

  constructor(options: FileHistoryBlobStoreOptions) {
    this.baseDir = resolve(options.baseDir);
    this.stagingDir = join(this.baseDir, ".staging");
  }

  /** 供必须与 CAS GC 共享 mutation lease 的组装层使用。 */
  get rootDirectory(): string {
    return this.baseDir;
  }

  resolveBlobPath(digest: string): string {
    return resolveFileHistoryBlobPath(this.baseDir, digest);
  }

  async put(contents: string | Uint8Array): Promise<FileHistoryBlobWriteResult> {
    const bytes =
      typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
    const digest = sha256(bytes);
    const temporary = await this.createTemporaryBlob();
    let temporaryOpen = true;

    try {
      await temporary.handle.writeFile(bytes);
      await temporary.handle.sync();
      await temporary.handle.close();
      temporaryOpen = false;
      return await this.publishTemporaryBlob(temporary.path, digest, bytes.byteLength);
    } finally {
      if (temporaryOpen) await temporary.handle.close().catch(() => undefined);
      await unlink(temporary.path).catch(() => undefined);
    }
  }

  async putFile(sourcePath: string): Promise<FileHistoryBlobWriteResult> {
    const temporary = await this.createTemporaryBlob();
    let temporaryOpen = true;
    let source: FileHandle | undefined;

    try {
      source = await open(sourcePath, "r");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let sizeBytes = 0;

      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await writeAll(temporary.handle, chunk);
        sizeBytes += bytesRead;
      }

      await temporary.handle.sync();
      await temporary.handle.close();
      temporaryOpen = false;
      const digest = hash.digest("hex");
      return await this.publishTemporaryBlob(temporary.path, digest, sizeBytes);
    } finally {
      await source?.close().catch(() => undefined);
      if (temporaryOpen) await temporary.handle.close().catch(() => undefined);
      await unlink(temporary.path).catch(() => undefined);
    }
  }

  async read(refOrDigest: FileHistoryBlobRef | string): Promise<Buffer> {
    const digest = typeof refOrDigest === "string" ? refOrDigest : refOrDigest.digest;
    const expectedSize = typeof refOrDigest === "string" ? undefined : refOrDigest.sizeBytes;
    const path = this.resolveBlobPath(digest);
    const bytes = await readBlobFile(path, digest);
    assertBlobIntegrity(bytes, digest, path, expectedSize);
    return bytes;
  }

  private async createTemporaryBlob(): Promise<{ path: string; handle: FileHandle }> {
    await mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
    await chmod(this.stagingDir, 0o700);
    const path = join(this.stagingDir, `.blob.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    const handle = await open(path, "wx", 0o600);
    return { path, handle };
  }

  private async publishTemporaryBlob(
    temporaryPath: string,
    digest: string,
    sizeBytes: number,
  ): Promise<FileHistoryBlobWriteResult> {
    const path = this.resolveBlobPath(digest);
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await chmod(temporaryPath, 0o600);

    let created = false;
    try {
      await link(temporaryPath, path);
      created = true;
      await syncDirectory(directory);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = await readBlobFile(path, digest);
      assertBlobIntegrity(existing, digest, path, sizeBytes);
    }

    return {
      ref: { algorithm: "sha256", digest, sizeBytes },
      path,
      created,
    };
  }
}

export function resolveFileHistoryBlobPath(baseDir: string, digest: string): string {
  assertSha256Digest(digest);
  return join(resolve(baseDir), "blobs", "sha256", digest.slice(0, 2), digest);
}

function assertSha256Digest(digest: string): void {
  if (!SHA256_DIGEST_RE.test(digest)) {
    throw new TypeError("File-history blob digest must be 64 lowercase hexadecimal characters");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBlobFile(path: string, digest: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new FileHistoryBlobIntegrityError(digest, path, "blob path is not a regular file");
  }
  return readFile(path);
}

function assertBlobIntegrity(
  bytes: Uint8Array,
  digest: string,
  path: string,
  expectedSize?: number,
): void {
  if (expectedSize !== undefined && bytes.byteLength !== expectedSize) {
    throw new FileHistoryBlobIntegrityError(
      digest,
      path,
      `expected ${expectedSize} bytes, found ${bytes.byteLength}`,
    );
  }
  const actualDigest = sha256(bytes);
  if (actualDigest !== digest) {
    throw new FileHistoryBlobIntegrityError(digest, path, `found digest ${actualDigest}`);
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten === 0) throw new Error("Unable to write temporary file-history blob");
    offset += bytesWritten;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
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
