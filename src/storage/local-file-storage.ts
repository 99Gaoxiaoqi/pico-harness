import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  LeaseConflictError,
  OwnerLease,
  type OwnerLeaseRecord,
} from "./owner-lease.js";

const FILE_TRANSACTION_SCHEMA_VERSION = 1 as const;
const LOCK_SCHEMA_VERSION = 1 as const;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_STALE_AFTER_MS = 30_000;
const syncSleepArray = new Int32Array(new SharedArrayBuffer(4));
const heldSyncLocks = new Map<string, number>();
const heldAsyncLocks = new AsyncLocalStorage<ReadonlySet<string>>();
const localAsyncLockTails = new Map<string, Promise<void>>();

export class FileStorageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileStorageIntegrityError";
  }
}

export class FileLockTimeoutError extends LeaseConflictError {
  constructor(
    message: string,
    readonly lockPath: string,
    owner?: OwnerLeaseRecord,
  ) {
    super(message, owner);
    this.name = "FileLockTimeoutError";
  }
}

export interface FileLockOptions {
  readonly timeoutMs?: number;
  readonly retryIntervalMs?: number;
  readonly staleAfterMs?: number;
  readonly now?: () => number;
}

export interface FileTransactionReplacement {
  readonly relativePath: string;
  readonly content: string | Buffer;
}

export interface FileTransactionAppend {
  readonly relativePath: string;
  readonly content: string | Buffer;
}

export interface FileTransactionInput {
  readonly replacements?: readonly FileTransactionReplacement[];
  readonly appends?: readonly FileTransactionAppend[];
}

export type FileTransactionStage =
  | "commit-published"
  | "targets-applied"
  | "commit-cleared";

export interface FileTransactionOptions {
  readonly commitFileName?: string;
  readonly transactionId?: string;
  readonly onStage?: (stage: FileTransactionStage, transactionId: string) => void;
}

interface PersistedReplacement {
  readonly relativePath: string;
  readonly expectedSize: number;
  readonly expectedHash: string;
  readonly nextHash: string;
  readonly contentBase64: string;
}

interface PersistedAppend {
  readonly relativePath: string;
  readonly expectedSize: number;
  readonly expectedHash: string;
  readonly nextSize: number;
  readonly nextHash: string;
  readonly contentBase64: string;
}

interface PersistedFileTransaction {
  readonly schemaVersion: typeof FILE_TRANSACTION_SCHEMA_VERSION;
  readonly transactionId: string;
  readonly createdAt: string;
  readonly replacements: readonly PersistedReplacement[];
  readonly appends: readonly PersistedAppend[];
}

/**
 * Short synchronous critical sections use the same owner record and stale-owner rules as
 * OwnerLease. Re-entrant calls on the JavaScript thread reuse the already-held lock.
 */
export function withFileLockSync<Result>(
  lockDirectory: string,
  ownerId: string,
  operation: () => Result,
  options: FileLockOptions = {},
): Result {
  const canonicalLock = resolve(lockDirectory);
  const heldDepth = heldSyncLocks.get(canonicalLock);
  if (heldDepth !== undefined) {
    heldSyncLocks.set(canonicalLock, heldDepth + 1);
    try {
      return operation();
    } finally {
      releaseReentrantSyncLock(canonicalLock);
    }
  }

  const owner = acquireFileLockSync(canonicalLock, ownerId, options);
  heldSyncLocks.set(canonicalLock, 1);
  try {
    return operation();
  } finally {
    heldSyncLocks.delete(canonicalLock);
    releaseFileLockSync(canonicalLock, owner);
  }
}

/** Async counterpart for RuntimeEventStore and other promise-based stores. */
export async function withFileLock<Result>(
  lockDirectory: string,
  ownerId: string,
  operation: () => Promise<Result>,
  options: FileLockOptions = {},
): Promise<Result> {
  const canonicalLock = resolve(lockDirectory);
  if (heldAsyncLocks.getStore()?.has(canonicalLock)) return operation();

  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolveTurn) => {
    releaseTurn = resolveTurn;
  });
  const previous = localAsyncLockTails.get(canonicalLock) ?? Promise.resolve();
  const tail = previous.catch(() => undefined).then(() => turn);
  localAsyncLockTails.set(canonicalLock, tail);
  await previous.catch(() => undefined);

  let lease: OwnerLease | undefined;
  try {
    lease = await acquireFileLock(canonicalLock, ownerId, options);
    const scope = new Set(heldAsyncLocks.getStore() ?? []);
    scope.add(canonicalLock);
    return await heldAsyncLocks.run(scope, operation);
  } finally {
    try {
      await lease?.release();
    } finally {
      releaseTurn();
      if (localAsyncLockTails.get(canonicalLock) === tail) {
        localAsyncLockTails.delete(canonicalLock);
      }
    }
  }
}

export function writeJsonAtomicSync(path: string, value: unknown): void {
  writeFileAtomicSync(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

export function writeFileAtomicSync(path: string, content: string | Buffer): void {
  const target = resolve(path);
  const directory = dirname(target);
  const temporaryPath = join(
    directory,
    `.${basename(target)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  mkdirPrivateSync(directory);
  let descriptor: number | undefined;
  let published = false;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, target);
    published = true;
    chmodSync(target, 0o600);
    syncDirectorySync(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!published) removeTemporaryFileSync(temporaryPath);
  }
}

export function readJsonFileSync(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/**
 * Reads a JSONL ledger under its owning lock. A non-newline-terminated tail is uncommitted and
 * may be truncated; every complete line must remain valid JSON.
 */
export function readJsonLinesSync(path: string, repairIncompleteTail = false): unknown[] {
  if (!existsSync(path)) return [];
  let bytes = readFileSync(path);
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0x0a) {
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (!repairIncompleteTail) {
      throw new FileStorageIntegrityError(`JSONL has an incomplete final record: ${path}`);
    }
    const committedSize = lastNewline < 0 ? 0 : lastNewline + 1;
    truncateSync(path, committedSize);
    syncFileSync(path);
    bytes = bytes.subarray(0, committedSize);
  }
  if (bytes.length === 0) return [];
  return bytes
    .toString("utf8")
    .split("\n")
    .slice(0, -1)
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (error) {
        throw new FileStorageIntegrityError(
          `JSONL record ${index + 1} is invalid in ${path}: ${errorMessage(error)}`,
        );
      }
    });
}

export function appendFileDurableSync(path: string, content: string | Buffer): void {
  const target = resolve(path);
  mkdirPrivateSync(dirname(target));
  const descriptor = openSync(target, "a", 0o600);
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(target, 0o600);
}

/**
 * Publishes a small write-ahead commit marker, then idempotently applies replacement and append
 * targets. Callers must hold the storage root's lock.
 */
export function commitFileTransactionSync(
  storageRoot: string,
  input: FileTransactionInput,
  options: FileTransactionOptions = {},
): string {
  const root = resolve(storageRoot);
  mkdirPrivateSync(root);
  recoverFileTransactionSync(root, options);
  const transactionId = options.transactionId ?? randomUUID();
  const transaction = prepareTransaction(root, transactionId, input);
  if (transaction.replacements.length === 0 && transaction.appends.length === 0) {
    return transactionId;
  }
  const commitPath = transactionCommitPath(root, options.commitFileName);
  writeJsonAtomicSync(commitPath, transaction);
  options.onStage?.("commit-published", transactionId);
  applyTransaction(root, transaction);
  options.onStage?.("targets-applied", transactionId);
  unlinkSync(commitPath);
  syncDirectorySync(dirname(commitPath));
  options.onStage?.("commit-cleared", transactionId);
  return transactionId;
}

/** Completes a previously published commit. Callers must hold the storage root's lock. */
export function recoverFileTransactionSync(
  storageRoot: string,
  options: Pick<FileTransactionOptions, "commitFileName" | "onStage"> = {},
): string | undefined {
  const root = resolve(storageRoot);
  const commitPath = transactionCommitPath(root, options.commitFileName);
  if (!existsSync(commitPath)) return undefined;
  const transaction = decodePersistedTransaction(readJsonFileSync(commitPath), commitPath);
  applyTransaction(root, transaction);
  options.onStage?.("targets-applied", transaction.transactionId);
  unlinkSync(commitPath);
  syncDirectorySync(dirname(commitPath));
  options.onStage?.("commit-cleared", transaction.transactionId);
  return transaction.transactionId;
}

export function mkdirPrivateSync(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function syncDirectorySync(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function acquireFileLockSync(
  lockDirectory: string,
  ownerId: string,
  options: FileLockOptions,
): OwnerLeaseRecord {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_LOCK_RETRY_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let lastOwner: OwnerLeaseRecord | undefined;

  for (;;) {
    const candidate = prepareSyncLockCandidate(lockDirectory, ownerId, now);
    try {
      const inspection = inspectSyncLock(lockDirectory);
      if (inspection.state === "absent" && publishSyncLockCandidate(candidate.path, lockDirectory)) {
        return candidate.owner;
      }
      if (inspection.state === "unverifiable") {
        throw new LeaseConflictError(
          `Lock directory exists but its owner cannot be verified: ${lockDirectory}`,
        );
      }
      if (inspection.state === "owned") {
        lastOwner = inspection.owner;
        if (canProveOwnerIsDead(inspection.owner, now(), staleAfterMs)) {
          moveStaleSyncLock(lockDirectory, inspection.owner);
          if (publishSyncLockCandidate(candidate.path, lockDirectory)) return candidate.owner;
        }
      }
    } finally {
      if (existsSync(candidate.path)) rmSync(candidate.path, { recursive: true, force: true });
    }
    if (now() >= deadline) {
      throw new FileLockTimeoutError(
        `Timed out waiting for file lock ${lockDirectory}`,
        lockDirectory,
        lastOwner,
      );
    }
    Atomics.wait(syncSleepArray, 0, 0, retryIntervalMs);
  }
}

async function acquireFileLock(
  lockDirectory: string,
  ownerId: string,
  options: FileLockOptions,
): Promise<OwnerLease> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_LOCK_RETRY_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const deadline = Date.now() + timeoutMs;
  let lastOwner: OwnerLeaseRecord | undefined;
  for (;;) {
    try {
      return await OwnerLease.acquire({ leaseDirectory: lockDirectory, ownerId, staleAfterMs });
    } catch (error) {
      if (!(error instanceof LeaseConflictError)) throw error;
      lastOwner = error.owner;
      if (Date.now() >= deadline) {
        throw new FileLockTimeoutError(
          `Timed out waiting for file lock ${lockDirectory}`,
          lockDirectory,
          lastOwner,
        );
      }
      await new Promise<void>((resolveRetry) => setTimeout(resolveRetry, retryIntervalMs));
    }
  }
}

function releaseReentrantSyncLock(lockDirectory: string): void {
  const depth = heldSyncLocks.get(lockDirectory);
  if (depth === undefined || depth <= 1) heldSyncLocks.delete(lockDirectory);
  else heldSyncLocks.set(lockDirectory, depth - 1);
}

function releaseFileLockSync(lockDirectory: string, expected: OwnerLeaseRecord): void {
  const current = readSyncLockOwner(join(lockDirectory, "owner.json"));
  if (!current) {
    if (!existsSync(lockDirectory)) return;
    throw new LeaseConflictError(`Lock ownership can no longer be verified: ${lockDirectory}`);
  }
  if (current.leaseId !== expected.leaseId) return;
  rmSync(lockDirectory, { recursive: true, force: true });
  syncDirectorySync(dirname(lockDirectory));
}

function prepareSyncLockCandidate(
  lockDirectory: string,
  ownerId: string,
  now: () => number,
): { path: string; owner: OwnerLeaseRecord } {
  const leaseId = randomUUID();
  const parent = dirname(lockDirectory);
  mkdirPrivateSync(parent);
  const candidatePath = join(parent, `.${basename(lockDirectory)}.candidate-${leaseId}`);
  mkdirSync(candidatePath, { mode: 0o700 });
  const timestamp = new Date(now()).toISOString();
  const owner: OwnerLeaseRecord = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    leaseId,
    ownerId,
    pid: process.pid,
    hostname: hostname(),
    processStartedAt: new Date(now() - process.uptime() * 1_000).toISOString(),
    acquiredAt: timestamp,
    heartbeatAt: timestamp,
  };
  writeJsonAtomicSync(join(candidatePath, "owner.json"), owner);
  return { path: candidatePath, owner };
}

type SyncLockInspection =
  | { state: "absent" }
  | { state: "unverifiable" }
  | { state: "owned"; owner: OwnerLeaseRecord };

function inspectSyncLock(lockDirectory: string): SyncLockInspection {
  const owner = readSyncLockOwner(join(lockDirectory, "owner.json"));
  if (owner) return { state: "owned", owner };
  return existsSync(lockDirectory) ? { state: "unverifiable" } : { state: "absent" };
}

function readSyncLockOwner(path: string): OwnerLeaseRecord | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value["schemaVersion"] !== LOCK_SCHEMA_VERSION) return undefined;
  const pid = value["pid"];
  if (
    typeof value["leaseId"] !== "string" ||
    typeof value["ownerId"] !== "string" ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof value["hostname"] !== "string" ||
    typeof value["processStartedAt"] !== "string" ||
    typeof value["acquiredAt"] !== "string" ||
    typeof value["heartbeatAt"] !== "string"
  ) {
    return undefined;
  }
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    leaseId: value["leaseId"],
    ownerId: value["ownerId"],
    pid,
    hostname: value["hostname"],
    processStartedAt: value["processStartedAt"],
    acquiredAt: value["acquiredAt"],
    heartbeatAt: value["heartbeatAt"],
  };
}

function publishSyncLockCandidate(candidatePath: string, lockDirectory: string): boolean {
  if (existsSync(lockDirectory)) return false;
  try {
    renameSync(candidatePath, lockDirectory);
    return true;
  } catch (error) {
    if (existsSync(lockDirectory)) return false;
    throw error;
  }
}

function canProveOwnerIsDead(
  owner: OwnerLeaseRecord,
  now: number,
  staleAfterMs: number,
): boolean {
  if (owner.hostname !== hostname()) return false;
  const heartbeatAt = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatAt) || now - heartbeatAt < staleAfterMs) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return isNodeCode(error, "ESRCH");
  }
}

function moveStaleSyncLock(lockDirectory: string, owner: OwnerLeaseRecord): void {
  const current = readSyncLockOwner(join(lockDirectory, "owner.json"));
  if (current?.leaseId !== owner.leaseId) return;
  const digest = createHash("sha256").update(owner.leaseId).digest("hex");
  const tombstone = join(dirname(lockDirectory), `.${basename(lockDirectory)}.tombstone-${digest}`);
  if (existsSync(tombstone)) return;
  try {
    renameSync(lockDirectory, tombstone);
  } catch (error) {
    if (!existsSync(tombstone) && existsSync(lockDirectory)) throw error;
  }
}

function prepareTransaction(
  root: string,
  transactionId: string,
  input: FileTransactionInput,
): PersistedFileTransaction {
  const replacements = (input.replacements ?? []).map((replacement) => {
    const target = resolveTransactionTarget(root, replacement.relativePath);
    const current = readOptionalFile(target);
    const next = toBuffer(replacement.content);
    return {
      relativePath: normalizedRelativePath(root, target),
      expectedSize: current.length,
      expectedHash: sha256(current),
      nextHash: sha256(next),
      contentBase64: next.toString("base64"),
    };
  });
  const appends = (input.appends ?? []).map((append) => {
    const target = resolveTransactionTarget(root, append.relativePath);
    const current = readOptionalFile(target);
    const addition = toBuffer(append.content);
    const next = Buffer.concat([current, addition]);
    return {
      relativePath: normalizedRelativePath(root, target),
      expectedSize: current.length,
      expectedHash: sha256(current),
      nextSize: next.length,
      nextHash: sha256(next),
      contentBase64: addition.toString("base64"),
    };
  });
  const targets = [...replacements, ...appends].map(({ relativePath }) => relativePath);
  if (new Set(targets).size !== targets.length) {
    throw new Error("A file transaction may mutate each target only once");
  }
  return {
    schemaVersion: FILE_TRANSACTION_SCHEMA_VERSION,
    transactionId,
    createdAt: new Date().toISOString(),
    replacements,
    appends,
  };
}

function applyTransaction(root: string, transaction: PersistedFileTransaction): void {
  for (const replacement of transaction.replacements) {
    const target = resolveTransactionTarget(root, replacement.relativePath);
    const current = readOptionalFile(target);
    const currentHash = sha256(current);
    if (currentHash === replacement.nextHash) continue;
    if (
      current.length !== replacement.expectedSize ||
      currentHash !== replacement.expectedHash
    ) {
      throw targetConflict(target, transaction.transactionId);
    }
    const next = Buffer.from(replacement.contentBase64, "base64");
    if (sha256(next) !== replacement.nextHash) {
      throw new FileStorageIntegrityError(
        `Replacement payload hash mismatch in transaction ${transaction.transactionId}`,
      );
    }
    writeFileAtomicSync(target, next);
  }

  for (const append of transaction.appends) {
    const target = resolveTransactionTarget(root, append.relativePath);
    let current = readOptionalFile(target);
    let currentHash = sha256(current);
    if (current.length === append.nextSize && currentHash === append.nextHash) continue;
    const addition = Buffer.from(append.contentBase64, "base64");
    if (
      current.length > append.expectedSize &&
      current.length < append.nextSize &&
      sha256(current.subarray(0, append.expectedSize)) === append.expectedHash &&
      addition.subarray(0, current.length - append.expectedSize).equals(
        current.subarray(append.expectedSize),
      )
    ) {
      truncateSync(target, append.expectedSize);
      syncFileSync(target);
      current = current.subarray(0, append.expectedSize);
      currentHash = sha256(current);
    }
    if (current.length !== append.expectedSize || currentHash !== append.expectedHash) {
      throw targetConflict(target, transaction.transactionId);
    }
    appendFileDurableSync(target, addition);
    const applied = readOptionalFile(target);
    if (applied.length !== append.nextSize || sha256(applied) !== append.nextHash) {
      throw new FileStorageIntegrityError(
        `Append verification failed for ${target} in transaction ${transaction.transactionId}`,
      );
    }
  }
}

function decodePersistedTransaction(value: unknown, path: string): PersistedFileTransaction {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== FILE_TRANSACTION_SCHEMA_VERSION ||
    typeof value["transactionId"] !== "string" ||
    typeof value["createdAt"] !== "string" ||
    !Array.isArray(value["replacements"]) ||
    !Array.isArray(value["appends"])
  ) {
    throw new FileStorageIntegrityError(`Invalid file transaction marker: ${path}`);
  }
  return value as unknown as PersistedFileTransaction;
}

function transactionCommitPath(root: string, fileName = "commit.json"): string {
  if (!fileName || isAbsolute(fileName) || fileName.includes("..") || fileName.includes(sep)) {
    throw new Error(`Invalid transaction commit file name: ${fileName}`);
  }
  return join(root, fileName);
}

function resolveTransactionTarget(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath)) {
    throw new Error(`Transaction target must be relative: ${relativePath}`);
  }
  const target = resolve(root, relativePath);
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Transaction target escapes storage root: ${relativePath}`);
  }
  return target;
}

function normalizedRelativePath(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

function readOptionalFile(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return Buffer.alloc(0);
    throw error;
  }
}

function syncFileSync(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeTemporaryFileSync(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isNodeCode(error, "ENOENT")) throw error;
  }
}

function targetConflict(path: string, transactionId: string): FileStorageIntegrityError {
  return new FileStorageIntegrityError(
    `Target changed outside file transaction ${transactionId}: ${path}`,
  );
}

function toBuffer(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(String(error.code))
  );
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
