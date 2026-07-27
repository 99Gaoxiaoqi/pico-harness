import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

const SHA256_DIGEST_RE = /^[a-f0-9]{64}$/u;
const READ_CHUNK_BYTES = 64 * 1024;
const VALIDATION_CACHE_LIMIT = 512;

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

export interface EvidenceBlobPage {
  readonly bytes: Buffer;
  readonly offsetBytes: number;
  readonly endOffsetBytes: number;
  readonly totalBytes: number;
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

interface DirectoryWitness {
  readonly path: string;
  readonly label: string;
  readonly identity: BigIntStats;
  readonly handle?: FileHandle;
}

/**
 * A directory chain whose components have all been opened and identity-bound.
 *
 * Node does not expose openat(2), so path operations are bracketed by identity
 * checks while every POSIX directory handle remains open. Pre-existing links or
 * non-directories are rejected before any child write or permission change.
 */
export class VerifiedEvidenceDirectory {
  readonly path: string;

  constructor(private readonly witnesses: readonly DirectoryWitness[]) {
    this.path = witnesses.at(-1)!.path;
  }

  async assertStable(): Promise<void> {
    for (const witness of this.witnesses) {
      const current = await lstat(witness.path, { bigint: true });
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        !sameFileIdentity(current, witness.identity)
      ) {
        throw new Error(`${witness.label} changed or is not a regular non-symlink directory`);
      }
      if (witness.handle) {
        const opened = await witness.handle.stat({ bigint: true });
        if (!opened.isDirectory() || !sameFileIdentity(opened, witness.identity)) {
          throw new Error(`${witness.label} changed while it was open`);
        }
      }
    }
  }

  filePath(fileName: string): string {
    assertPathPart(fileName, "Evidence file name");
    return join(this.path, fileName);
  }

  async openRegularFile(fileName: string, label: string): Promise<FileHandle> {
    const path = this.filePath(fileName);
    await this.assertStable();
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error(`${label} is not a regular non-symlink file`);
    }

    let handle: FileHandle | undefined;
    try {
      try {
        handle = await open(path, readOnlyNoFollowFlags());
      } catch (error) {
        if (isSymlinkOpenError(error)) {
          throw new Error(`${label} is not a regular non-symlink file`, { cause: error });
        }
        throw error;
      }
      const opened = await handle.stat({ bigint: true });
      const after = await lstat(path, { bigint: true });
      if (
        !opened.isFile() ||
        after.isSymbolicLink() ||
        !after.isFile() ||
        !sameFileIdentity(before, opened) ||
        !sameFileIdentity(after, opened)
      ) {
        throw new Error(`${label} changed while it was being opened`);
      }
      await this.assertStable();
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
  }

  async readRegularFile(fileName: string, label: string): Promise<Buffer> {
    const handle = await this.openRegularFile(fileName, label);
    try {
      const before = await handle.stat({ bigint: true });
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (!sameFileVersion(before, after)) {
        throw new Error(`${label} changed while it was read`);
      }
      await this.assertStable();
      return bytes;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async createExclusiveFile(fileName: string, mode: number): Promise<FileHandle> {
    const path = this.filePath(fileName);
    await this.assertStable();
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, writeExclusiveNoFollowFlags(), mode);
      const opened = await handle.stat({ bigint: true });
      const current = await lstat(path, { bigint: true });
      if (
        !opened.isFile() ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        !sameFileIdentity(opened, current)
      ) {
        throw new Error("Evidence temporary file changed while it was being created");
      }
      await this.assertStable();
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
  }

  async linkFile(existingName: string, newName: string): Promise<void> {
    const existingPath = this.filePath(existingName);
    const newPath = this.filePath(newName);
    await this.assertStable();
    await link(existingPath, newPath);
    await this.assertStable();
  }

  async unlinkFile(fileName: string): Promise<void> {
    const path = this.filePath(fileName);
    await this.assertStable();
    await unlink(path);
    await this.assertStable();
  }

  async sync(): Promise<void> {
    const handle = this.witnesses.at(-1)?.handle;
    if (!handle) return;
    try {
      await handle.sync();
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    }
  }
}

export async function withVerifiedEvidenceDirectory<T>(
  evidenceBaseDir: string,
  relativeParts: readonly string[],
  options: { readonly create: boolean },
  action: (directory: VerifiedEvidenceDirectory) => Promise<T>,
): Promise<T> {
  for (const part of relativeParts) assertPathPart(part, "Evidence directory name");
  const witnesses: DirectoryWitness[] = [];
  const baseDir = resolve(evidenceBaseDir);
  try {
    witnesses.push(
      await openDirectoryWitness(baseDir, "Evidence root", options.create, options.create),
    );
    let current = baseDir;
    for (const part of relativeParts) {
      const directory = new VerifiedEvidenceDirectory(witnesses);
      await directory.assertStable();
      current = join(current, part);
      witnesses.push(
        await openDirectoryWitness(
          current,
          `Evidence directory ${part}`,
          options.create,
          options.create,
        ),
      );
    }
    const directory = new VerifiedEvidenceDirectory(witnesses);
    try {
      const result = await action(directory);
      await directory.assertStable();
      return result;
    } catch (error) {
      await directory.assertStable();
      throw error;
    }
  } finally {
    for (const witness of [...witnesses].reverse()) {
      await witness.handle?.close().catch(() => undefined);
    }
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
  private readonly validationCache = new Map<string, string>();

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
    const relativeParts = this.directoryParts(ref.digest);
    return withVerifiedEvidenceDirectory(
      this.baseDir,
      relativeParts,
      { create: true },
      async (directory) => {
        try {
          await this.readFromDirectory(directory, ref);
          return { ref, created: false };
        } catch (error) {
          if (!isMissing(error)) throw error;
        }

        const temporaryName = `.${ref.digest}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
        let temporary: FileHandle | undefined;
        try {
          temporary = await directory.createExclusiveFile(temporaryName, 0o600);
          await temporary.writeFile(bytes);
          await temporary.sync();
          const temporaryIdentity = await temporary.stat({ bigint: true });
          try {
            await directory.linkFile(temporaryName, ref.digest);
          } catch (error) {
            if (!isAlreadyExists(error)) throw error;
            await this.readFromDirectory(directory, ref);
            return { ref, created: false };
          }

          let finalHandle: FileHandle | undefined;
          try {
            finalHandle = await directory.openRegularFile(ref.digest, "Evidence blob");
            const finalIdentity = await finalHandle.stat({ bigint: true });
            if (!sameFileIdentity(temporaryIdentity, finalIdentity)) {
              throw new EvidenceBlobIntegrityError(
                ref.digest,
                directory.filePath(ref.digest),
                "published file does not match the created blob",
              );
            }
          } catch (error) {
            await directory.unlinkFile(ref.digest).catch(() => undefined);
            throw error;
          } finally {
            await finalHandle?.close().catch(() => undefined);
          }

          await directory.sync();
          return { ref, created: true };
        } finally {
          await temporary?.close().catch(() => undefined);
          await directory.unlinkFile(temporaryName).catch(() => undefined);
        }
      },
    );
  }

  async read(ref: EvidenceBlobRef): Promise<Buffer> {
    assertEvidenceBlobRef(ref);
    try {
      return await withVerifiedEvidenceDirectory(
        this.baseDir,
        this.directoryParts(ref.digest),
        { create: false },
        (directory) => this.readFromDirectory(directory, ref),
      );
    } catch (error) {
      if (error instanceof EvidenceBlobIntegrityError || isMissing(error)) throw error;
      throw new EvidenceBlobIntegrityError(
        ref.digest,
        this.pathFor(ref.digest),
        `blob is unreadable: ${errorMessage(error)}`,
      );
    }
  }

  async readPage(
    ref: EvidenceBlobRef,
    offsetBytes: number,
    limitBytes: number,
  ): Promise<EvidenceBlobPage> {
    assertEvidenceBlobRef(ref);
    try {
      return await withVerifiedEvidenceDirectory(
        this.baseDir,
        this.directoryParts(ref.digest),
        { create: false },
        async (directory) => {
          const handle = await directory.openRegularFile(ref.digest, "Evidence blob");
          try {
            let validatedVersion = await handle.stat({ bigint: true });
            this.assertExpectedSize(ref, validatedVersion);
            const cachedVersion = this.validationCache.get(ref.digest);
            if (cachedVersion !== fileVersionKey(validatedVersion)) {
              this.validationCache.delete(ref.digest);
              await validateDigestFromHandle(handle, ref);
              const afterValidation = await handle.stat({ bigint: true });
              if (!sameFileVersion(validatedVersion, afterValidation)) {
                throw this.integrityError(
                  ref,
                  directory,
                  "blob changed while its digest was validated",
                );
              }
              validatedVersion = afterValidation;
              this.rememberValidation(ref.digest, fileVersionKey(validatedVersion));
            }

            const page = await readUtf8PageFromHandle(
              handle,
              ref,
              directory.filePath(ref.digest),
              offsetBytes,
              limitBytes,
            );
            const afterPage = await handle.stat({ bigint: true });
            if (!sameFileVersion(validatedVersion, afterPage)) {
              this.validationCache.delete(ref.digest);
              throw this.integrityError(ref, directory, "blob changed while its page was read");
            }
            await directory.assertStable();
            return page;
          } catch (error) {
            if (!(error instanceof EvidenceBlobIntegrityError)) {
              this.validationCache.delete(ref.digest);
            }
            throw error;
          } finally {
            await handle.close().catch(() => undefined);
          }
        },
      );
    } catch (error) {
      if (error instanceof EvidenceBlobIntegrityError || isMissing(error)) throw error;
      throw new EvidenceBlobIntegrityError(
        ref.digest,
        this.pathFor(ref.digest),
        `blob is unreadable: ${errorMessage(error)}`,
      );
    }
  }

  private async readFromDirectory(
    directory: VerifiedEvidenceDirectory,
    ref: EvidenceBlobRef,
  ): Promise<Buffer> {
    const handle = await directory.openRegularFile(ref.digest, "Evidence blob");
    try {
      const before = await handle.stat({ bigint: true });
      this.assertExpectedSize(ref, before);
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (!sameFileVersion(before, after)) {
        throw this.integrityError(ref, directory, "blob changed while it was read");
      }
      if (bytes.byteLength !== ref.sizeBytes) {
        throw this.integrityError(
          ref,
          directory,
          `expected ${ref.sizeBytes} bytes, found ${bytes.byteLength}`,
        );
      }
      const actualDigest = sha256(bytes);
      if (actualDigest !== ref.digest) {
        throw this.integrityError(ref, directory, `expected ${ref.digest}, found ${actualDigest}`);
      }
      await directory.assertStable();
      this.rememberValidation(ref.digest, fileVersionKey(after));
      return bytes;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private assertExpectedSize(ref: EvidenceBlobRef, stats: BigIntStats): void {
    if (stats.size !== BigInt(ref.sizeBytes)) {
      throw new EvidenceBlobIntegrityError(
        ref.digest,
        this.pathFor(ref.digest),
        `expected ${ref.sizeBytes} bytes, found ${stats.size.toString()}`,
      );
    }
  }

  private integrityError(
    ref: EvidenceBlobRef,
    directory: VerifiedEvidenceDirectory,
    detail: string,
  ): EvidenceBlobIntegrityError {
    return new EvidenceBlobIntegrityError(ref.digest, directory.filePath(ref.digest), detail);
  }

  private rememberValidation(digest: string, version: string): void {
    this.validationCache.delete(digest);
    this.validationCache.set(digest, version);
    if (this.validationCache.size > VALIDATION_CACHE_LIMIT) {
      const oldest = this.validationCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.validationCache.delete(oldest);
    }
  }

  private directoryParts(digest: string): readonly string[] {
    assertSha256Digest(digest);
    return ["blobs", "sha256", digest.slice(0, 2)];
  }

  private pathFor(digest: string): string {
    assertSha256Digest(digest);
    return join(this.baseDir, ...this.directoryParts(digest), digest);
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

async function openDirectoryWitness(
  path: string,
  label: string,
  create: boolean,
  makePrivate: boolean,
): Promise<DirectoryWitness> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`${label} is not a regular non-symlink directory`);
  }

  if (process.platform === "win32") {
    return { path, label, identity: before };
  }

  let handle: FileHandle | undefined;
  try {
    try {
      handle = await open(path, directoryNoFollowFlags());
    } catch (error) {
      if (isSymlinkOpenError(error)) {
        throw new Error(`${label} is not a regular non-symlink directory`, { cause: error });
      }
      throw error;
    }
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    if (
      !opened.isDirectory() ||
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(after, opened)
    ) {
      throw new Error(`${label} changed while it was being opened`);
    }
    if (makePrivate) await handle.chmod(0o700);
    const finalState = await lstat(path, { bigint: true });
    const finalOpened = await handle.stat({ bigint: true });
    if (
      finalState.isSymbolicLink() ||
      !finalState.isDirectory() ||
      !sameFileIdentity(opened, finalOpened) ||
      !sameFileIdentity(finalState, finalOpened)
    ) {
      throw new Error(`${label} changed while it was being secured`);
    }
    return { path, label, identity: finalOpened, handle };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

async function validateDigestFromHandle(handle: FileHandle, ref: EvidenceBlobRef): Promise<void> {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(ref.sizeBytes, 1)));
  let position = 0;
  while (position < ref.sizeBytes) {
    const requested = Math.min(chunk.byteLength, ref.sizeBytes - position);
    const { bytesRead } = await handle.read(chunk, 0, requested, position);
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position !== ref.sizeBytes) {
    throw new EvidenceBlobIntegrityError(
      ref.digest,
      "(opened handle)",
      `expected ${ref.sizeBytes} bytes, read ${position}`,
    );
  }
  const actualDigest = hash.digest("hex");
  if (actualDigest !== ref.digest) {
    throw new EvidenceBlobIntegrityError(
      ref.digest,
      "(opened handle)",
      `expected ${ref.digest}, found ${actualDigest}`,
    );
  }
}

async function readUtf8PageFromHandle(
  handle: FileHandle,
  ref: EvidenceBlobRef,
  blobPath: string,
  offsetBytes: number,
  limitBytes: number,
): Promise<EvidenceBlobPage> {
  if (offsetBytes > ref.sizeBytes) {
    throw new EvidenceBlobIntegrityError(
      ref.digest,
      blobPath,
      `offsetBytes ${offsetBytes} exceeds output size ${ref.sizeBytes}`,
    );
  }
  if (offsetBytes === ref.sizeBytes) {
    return {
      bytes: Buffer.alloc(0),
      offsetBytes,
      endOffsetBytes: offsetBytes,
      totalBytes: ref.sizeBytes,
    };
  }

  const remaining = ref.sizeBytes - offsetBytes;
  const readLength = Math.min(remaining, limitBytes + 1);
  const window = Buffer.allocUnsafe(readLength);
  const { bytesRead } = await handle.read(window, 0, readLength, offsetBytes);
  if (bytesRead !== readLength) {
    throw new EvidenceBlobIntegrityError(
      ref.digest,
      blobPath,
      `expected ${readLength} page bytes, read ${bytesRead}`,
    );
  }
  if (isUtf8ContinuationByte(window[0]!)) {
    throw new EvidenceBlobIntegrityError(
      ref.digest,
      blobPath,
      `offsetBytes ${offsetBytes} is not a UTF-8 code point boundary`,
    );
  }

  let contentLength = Math.min(limitBytes, remaining);
  if (contentLength < remaining) {
    while (contentLength > 0 && isUtf8ContinuationByte(window[contentLength]!)) {
      contentLength--;
    }
  }
  if (contentLength === 0) {
    throw new EvidenceBlobIntegrityError(
      ref.digest,
      blobPath,
      `limitBytes ${limitBytes} cannot contain the next complete UTF-8 code point`,
    );
  }
  return {
    bytes: window.subarray(0, contentLength),
    offsetBytes,
    endOffsetBytes: offsetBytes + contentLength,
    totalBytes: ref.sizeBytes,
  };
}

function assertSha256Digest(digest: string): void {
  if (!SHA256_DIGEST_RE.test(digest)) {
    throw new EvidenceBlobIntegrityError(digest, "(unresolved)", "digest is invalid");
  }
}

function assertPathPart(part: string, label: string): void {
  if (
    part.length === 0 ||
    part === "." ||
    part === ".." ||
    part.includes("/") ||
    part.includes("\\") ||
    part.includes("\0")
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function readOnlyNoFollowFlags(): number {
  return constants.O_RDONLY | noFollowFlag();
}

function writeExclusiveNoFollowFlags(): number {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag();
}

function directoryNoFollowFlags(): number {
  return constants.O_RDONLY | constants.O_DIRECTORY | noFollowFlag();
}

function noFollowFlag(): number {
  return process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileVersionKey(stats: BigIntStats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].map(String).join(":");
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
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

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(code ?? "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
