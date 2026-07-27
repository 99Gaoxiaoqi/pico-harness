import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const SHA256_DIGEST_RE = /^[a-f0-9]{64}$/u;

export interface EvidenceBlobRef {
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly sizeBytes: number;
  readonly encoding: "utf8";
}

export interface EvidenceBlobWriteResult {
  readonly ref: EvidenceBlobRef;
  readonly created: boolean;
}

export class EvidenceBlobIntegrityError extends Error {
  constructor(
    readonly digest: string,
    readonly blobPath: string,
    detail: string,
  ) {
    super(`Evidence blob ${digest} failed integrity validation: ${detail}`);
    this.name = "EvidenceBlobIntegrityError";
  }
}

/**
 * Workspace-local immutable CAS for Runtime tool output.
 *
 * Blobs live below the Evidence root rather than the user workspace, and callers
 * can address them only through a validated Evidence manifest.
 */
export class EvidenceBlobStore {
  private readonly baseDir: string;

  constructor(evidenceBaseDir: string) {
    this.baseDir = resolve(evidenceBaseDir);
  }

  async putUtf8(content: string): Promise<EvidenceBlobWriteResult> {
    const bytes = Buffer.from(content, "utf8");
    const ref: EvidenceBlobRef = {
      algorithm: "sha256",
      digest: sha256(bytes),
      sizeBytes: bytes.byteLength,
      encoding: "utf8",
    };
    const path = this.pathFor(ref.digest);

    try {
      await this.read(ref);
      await chmod(path, 0o600);
      return { ref, created: false };
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = join(
      directory,
      `.${ref.digest}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporaryPath, path);
        await chmod(path, 0o600);
        await syncDirectory(directory);
        return { ref, created: true };
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await this.read(ref);
        await chmod(path, 0o600);
        return { ref, created: false };
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async read(ref: EvidenceBlobRef): Promise<Buffer> {
    assertEvidenceBlobRef(ref);
    const path = this.pathFor(ref.digest);
    let bytes: Buffer;
    try {
      bytes = await readRegularEvidenceFile(path, "Evidence blob");
    } catch (error) {
      if (error instanceof EvidenceBlobIntegrityError || isMissing(error)) throw error;
      throw new EvidenceBlobIntegrityError(
        ref.digest,
        path,
        `blob is unreadable: ${errorMessage(error)}`,
      );
    }

    if (bytes.byteLength !== ref.sizeBytes) {
      throw new EvidenceBlobIntegrityError(
        ref.digest,
        path,
        `expected ${ref.sizeBytes} bytes, found ${bytes.byteLength}`,
      );
    }
    const actualDigest = sha256(bytes);
    if (actualDigest !== ref.digest) {
      throw new EvidenceBlobIntegrityError(
        ref.digest,
        path,
        `expected ${ref.digest}, found ${actualDigest}`,
      );
    }
    return bytes;
  }

  private pathFor(digest: string): string {
    assertSha256Digest(digest);
    return join(this.baseDir, "blobs", "sha256", digest.slice(0, 2), digest);
  }
}

/**
 * Opens and reads one immutable Evidence file through the verified handle.
 *
 * POSIX uses O_NOFOLLOW. Platforms without a reliable O_NOFOLLOW additionally
 * bind pre/post path metadata to the opened handle and reject symlinks.
 */
export async function readRegularEvidenceFile(path: string, label: string): Promise<Buffer> {
  const supportsNoFollow = process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number";
  const flags = constants.O_RDONLY | (supportsNoFollow ? constants.O_NOFOLLOW : 0);
  const before = supportsNoFollow ? undefined : await lstat(path);
  if (before && (!before.isFile() || before.isSymbolicLink())) {
    throw new Error(`${label} is not a regular non-symlink file`);
  }

  let handle: FileHandle | undefined;
  try {
    try {
      handle = await open(path, flags);
    } catch (error) {
      if (isSymlinkOpenError(error)) {
        throw new Error(`${label} is not a regular non-symlink file`, { cause: error });
      }
      throw error;
    }
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error(`${label} is not a regular non-symlink file`);
    }
    if (!supportsNoFollow) {
      const after = await lstat(path);
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        !sameFileIdentity(before, opened) ||
        !sameFileIdentity(after, opened)
      ) {
        throw new Error(`${label} changed while it was being opened`);
      }
    }
    return await handle.readFile();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function assertEvidenceBlobRef(value: unknown): asserts value is EvidenceBlobRef {
  if (
    !isRecord(value) ||
    value["algorithm"] !== "sha256" ||
    typeof value["digest"] !== "string" ||
    !SHA256_DIGEST_RE.test(value["digest"]) ||
    !Number.isSafeInteger(value["sizeBytes"]) ||
    (value["sizeBytes"] as number) < 0 ||
    value["encoding"] !== "utf8"
  ) {
    throw new EvidenceBlobIntegrityError(
      typeof value === "object" &&
        value !== null &&
        "digest" in value &&
        typeof value.digest === "string"
        ? value.digest
        : "(invalid)",
      "(unresolved)",
      "blob reference is invalid",
    );
  }
}

function assertSha256Digest(digest: string): void {
  if (!SHA256_DIGEST_RE.test(digest)) {
    throw new EvidenceBlobIntegrityError(digest, "(unresolved)", "digest is invalid");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isSymlinkOpenError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ELOOP" || code === "EMLINK";
}

function sameFileIdentity(left: Stats | undefined, right: Stats): boolean {
  return left !== undefined && left.dev === right.dev && left.ino === right.ino;
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(code ?? "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
