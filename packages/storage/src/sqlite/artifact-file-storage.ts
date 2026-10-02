import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { FileStorageIntegrityError } from "../local-file-storage.js";

/** Managed immutable files. SQLite owns identities and references, never file bytes. */
export function artifactBlobRelativePath(digest: string): string {
  if (!/^[a-f0-9]{64}$/u.test(digest))
    throw new FileStorageIntegrityError("Invalid artifact digest");
  return `artifacts/blobs/${digest.slice(0, 2)}/${digest}`;
}

export function artifactIngestRelativePath(ingestId: string): string {
  if (!ingestId || Buffer.byteLength(ingestId) > 256)
    throw new FileStorageIntegrityError("Invalid artifact ingest identity");
  return `artifacts/ingests/${Buffer.from(ingestId).toString("hex")}`;
}

function storageRoot(database: DatabaseSync): string {
  const row = database
    .prepare("PRAGMA database_list")
    .all()
    .find((item) => item.name === "main");
  if (typeof row?.file !== "string" || !row.file)
    throw new FileStorageIntegrityError("Artifact files require a persistent workspace database");
  return dirname(row.file);
}

function managedPath(database: DatabaseSync, relativePath: string, create: boolean): string {
  if (!/^artifacts\/(?:blobs\/[a-f0-9]{2}\/[a-f0-9]{64}|ingests\/[a-f0-9]+)$/u.test(relativePath))
    throw new FileStorageIntegrityError("Invalid artifact file path");
  let directory = storageRoot(database);
  const parts = relativePath.split("/");
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part);
    if (create && !existsSync(directory)) {
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      // Durability includes newly created ancestor directory entries, not only the leaf file.
      const parent = openSync(dirname(directory), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    }
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new FileStorageIntegrityError("Artifact directory must be a real directory");
  }
  return join(directory, parts.at(-1)!);
}

function openManaged(database: DatabaseSync, path: string, flags: number, create = false): number {
  const file = managedPath(database, path, create);
  const fd = openSync(file, flags | constants.O_NOFOLLOW, 0o600);
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new FileStorageIntegrityError("Artifact content must be a regular file");
  }
  return fd;
}

function readFd(fd: number, offset: number, length: number): Buffer {
  const content = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const size = readSync(fd, content, read, length - read, offset + read);
    if (size === 0) throw new FileStorageIntegrityError("Artifact file was truncated");
    read += size;
  }
  return content;
}

function writeAll(fd: number, bytes: Uint8Array, offset: number): void {
  let written = 0;
  while (written < bytes.length)
    written += writeSync(fd, bytes, written, bytes.length - written, offset + written);
  fsyncSync(fd);
}

function publishFile(database: DatabaseSync, relativePath: string, bytes: Uint8Array): void {
  const destination = managedPath(database, relativePath, true);
  if (existsSync(destination)) {
    const fd = openManaged(database, relativePath, constants.O_RDONLY);
    try {
      if (fstatSync(fd).size !== bytes.length || !readFd(fd, 0, bytes.length).equals(bytes))
        throw new FileStorageIntegrityError("Artifact file conflicts with its immutable identity");
    } finally {
      closeSync(fd);
    }
    return;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeAll(fd, bytes, 0);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, destination);
    const directory = openSync(dirname(destination), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function writeArtifactBlobFile(
  database: DatabaseSync,
  digest: string,
  bytes: Uint8Array,
): string {
  if (createHash("sha256").update(bytes).digest("hex") !== digest)
    throw new FileStorageIntegrityError("Artifact content digest mismatch");
  const relativePath = artifactBlobRelativePath(digest);
  publishFile(database, relativePath, bytes);
  return relativePath;
}

export function readArtifactBlobFile(
  database: DatabaseSync,
  digest: string,
  relativePath: string,
  sizeBytes: number,
  offset = 0,
  limit = sizeBytes,
): Buffer {
  if (relativePath !== artifactBlobRelativePath(digest))
    throw new FileStorageIntegrityError("Artifact content path does not match its digest");
  const fd = openManaged(database, relativePath, constants.O_RDONLY);
  try {
    if (fstatSync(fd).size !== sizeBytes)
      throw new FileStorageIntegrityError("Artifact file size mismatch");
    const content = readFd(fd, offset, Math.min(limit, Math.max(0, sizeBytes - offset)));
    if (
      offset === 0 &&
      content.length === sizeBytes &&
      createHash("sha256").update(content).digest("hex") !== digest
    )
      throw new FileStorageIntegrityError("Artifact file digest mismatch");
    return content;
  } finally {
    closeSync(fd);
  }
}

export function createArtifactIngestFile(
  database: DatabaseSync,
  ingestId: string,
  bytes: Uint8Array = new Uint8Array(),
): string {
  const path = artifactIngestRelativePath(ingestId);
  publishFile(database, path, bytes);
  return path;
}

export function appendArtifactIngestFile(
  database: DatabaseSync,
  ingestId: string,
  relativePath: string,
  sizeBytes: number,
  offset: number,
  bytes: Uint8Array,
): number {
  if (relativePath !== artifactIngestRelativePath(ingestId))
    throw new FileStorageIntegrityError("Artifact ingest path mismatch");
  const fd = openManaged(database, relativePath, constants.O_RDWR);
  try {
    const actual = fstatSync(fd).size;
    if (actual < sizeBytes) throw new FileStorageIntegrityError("Artifact ingest was truncated");
    // A crash between fsync and SQLite COMMIT may leave an uncommitted tail.
    if (actual > sizeBytes) ftruncateSync(fd, sizeBytes);
    if (
      offset < sizeBytes &&
      offset + bytes.length <= sizeBytes &&
      readFd(fd, offset, bytes.length).equals(bytes)
    )
      return sizeBytes;
    if (offset !== sizeBytes)
      throw new FileStorageIntegrityError(
        `Artifact ingest offset conflict: expected ${sizeBytes}, received ${offset}`,
      );
    writeAll(fd, bytes, offset);
    return sizeBytes + bytes.length;
  } finally {
    closeSync(fd);
  }
}

export function readArtifactIngestFile(
  database: DatabaseSync,
  ingestId: string,
  relativePath: string,
  sizeBytes: number,
): Buffer {
  if (relativePath !== artifactIngestRelativePath(ingestId))
    throw new FileStorageIntegrityError("Artifact ingest path mismatch");
  const fd = openManaged(database, relativePath, constants.O_RDONLY);
  try {
    if (fstatSync(fd).size < sizeBytes)
      throw new FileStorageIntegrityError("Artifact ingest was truncated");
    return readFd(fd, 0, sizeBytes);
  } finally {
    closeSync(fd);
  }
}

/** Must run after metadata commits; orphan files are harmless after interrupted cleanup. */
export function removeArtifactFile(database: DatabaseSync, relativePath: string): void {
  try {
    unlinkSync(managedPath(database, relativePath, false));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Runs before the v2 DDL removes BLOB columns. Original DB stays backed up. */
export function migrateLegacyArtifactFiles(database: DatabaseSync): void {
  for (const row of database
    .prepare("SELECT digest, size_bytes, content FROM artifact_blobs")
    .iterate()) {
    const bytes = row.content as Uint8Array;
    if (bytes.length !== row.size_bytes)
      throw new FileStorageIntegrityError("Legacy artifact size mismatch");
    writeArtifactBlobFile(database, row.digest as string, bytes);
  }
  for (const row of database
    .prepare("SELECT ingest_id, content FROM session_artifact_ingests")
    .iterate())
    createArtifactIngestFile(database, row.ingest_id as string, row.content as Uint8Array);
}
