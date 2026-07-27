import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LeaseConflictError, OwnerLease, type OwnerLeaseRecord } from "./owner-lease.js";

const FILE_TRANSACTION_SCHEMA_VERSION = 1 as const;
const LOCK_SCHEMA_VERSION = 1 as const;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_STALE_AFTER_MS = 30_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const syncSleepArray = new Int32Array(new SharedArrayBuffer(4));
const heldSyncLocks = new Map<string, number>();
const heldAsyncLocks = new AsyncLocalStorage<ReadonlySet<string>>();
const localAsyncLockTails = new Map<string, Promise<void>>();
const capabilityCheckedRoots = new Set<string>();

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

export type FileTransactionStage = "commit-published" | "targets-applied" | "commit-cleared";

export interface FileTransactionOptions {
  readonly commitFileName?: string;
  /**
   * Optional transaction namespace boundary, relative to storageRoot. Recovery validates the
   * persisted marker against the same prefixes before applying any target.
   */
  readonly allowedTargetPrefixes?: readonly string[];
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
  const canonicalLock = canonicalStoragePathSync(lockDirectory);
  if (heldAsyncLocks.getStore()?.has(canonicalLock)) {
    return assertSynchronousResult(operation(), canonicalLock);
  }
  const heldDepth = heldSyncLocks.get(canonicalLock);
  if (heldDepth !== undefined) {
    heldSyncLocks.set(canonicalLock, heldDepth + 1);
    try {
      return assertSynchronousResult(operation(), canonicalLock);
    } finally {
      releaseReentrantSyncLock(canonicalLock);
    }
  }

  const owner = acquireFileLockSync(canonicalLock, ownerId, options);
  heldSyncLocks.set(canonicalLock, 1);
  try {
    const result = assertSynchronousResult(operation(), canonicalLock);
    assertSyncLockOwnership(canonicalLock, owner);
    return result;
  } finally {
    heldSyncLocks.delete(canonicalLock);
    releaseFileLockSync(canonicalLock, owner);
  }
}

/**
 * Runs one final critical section and retains the lock as an unverifiable fence.
 *
 * Older storage implementations only understand owner lease records, so the fence makes them
 * fail closed instead of continuing to write an obsolete layout. The caller must explicitly
 * remove the fenced lock directory before rolling back to that implementation.
 */
export function withPermanentFileLockFenceSync<Result>(
  lockDirectory: string,
  ownerId: string,
  reason: string,
  operation: () => Result,
  options: FileLockOptions = {},
): Result {
  const canonicalLock = canonicalStoragePathSync(lockDirectory);
  if (!reason.trim()) throw new Error("Permanent file lock fence requires a reason");
  if (heldAsyncLocks.getStore()?.has(canonicalLock) || heldSyncLocks.has(canonicalLock)) {
    throw new LeaseConflictError(`Cannot retain a re-entrant lock as a fence: ${canonicalLock}`);
  }

  const owner = acquireFileLockSync(canonicalLock, ownerId, options);
  heldSyncLocks.set(canonicalLock, 1);
  let fenced = false;
  try {
    const result = assertSynchronousResult(operation(), canonicalLock);
    assertSyncLockOwnership(canonicalLock, owner);
    writeJsonAtomicSync(join(canonicalLock, "owner.json"), {
      schemaVersion: 0,
      type: "permanent-file-lock-fence",
      reason,
      createdAt: new Date().toISOString(),
    });
    fenced = true;
    return result;
  } finally {
    heldSyncLocks.delete(canonicalLock);
    if (!fenced) releaseFileLockSync(canonicalLock, owner);
  }
}

export function hasPermanentFileLockFenceSync(lockDirectory: string, reason: string): boolean {
  const ownerPath = join(resolve(lockDirectory), "owner.json");
  if (!existsSync(ownerPath)) return false;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(ownerPath, "utf8")) as unknown;
  } catch {
    return false;
  }
  return (
    isRecord(value) &&
    value["schemaVersion"] === 0 &&
    value["type"] === "permanent-file-lock-fence" &&
    value["reason"] === reason &&
    typeof value["createdAt"] === "string"
  );
}

/** Async counterpart for promise-based stores that need heartbeat-backed ownership. */
export async function withFileLock<Result>(
  lockDirectory: string,
  ownerId: string,
  operation: () => Promise<Result>,
  options: FileLockOptions = {},
): Promise<Result> {
  const canonicalLock = canonicalStoragePathSync(lockDirectory);
  if (heldAsyncLocks.getStore()?.has(canonicalLock)) return operation();
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolveTurn) => {
    releaseTurn = resolveTurn;
  });
  const previous = localAsyncLockTails.get(canonicalLock) ?? Promise.resolve();
  const tail = previous.catch(() => undefined).then(() => turn);
  localAsyncLockTails.set(canonicalLock, tail);

  let lease: OwnerLease | undefined;
  let reachedFront = false;
  try {
    await waitForLocalLockTurn(previous, deadline, canonicalLock);
    reachedFront = true;
    lease = await acquireFileLock(canonicalLock, ownerId, {
      ...options,
      timeoutMs: Math.max(0, deadline - Date.now()),
    });
    const scope = new Set(heldAsyncLocks.getStore() ?? []);
    scope.add(canonicalLock);
    const result = await heldAsyncLocks.run(scope, operation);
    await lease.assertOwnership();
    return result;
  } finally {
    try {
      await lease?.release();
    } finally {
      releaseTurn();
      if (reachedFront && localAsyncLockTails.get(canonicalLock) === tail) {
        localAsyncLockTails.delete(canonicalLock);
      } else if (!reachedFront) {
        void tail.finally(() => {
          if (localAsyncLockTails.get(canonicalLock) === tail) {
            localAsyncLockTails.delete(canonicalLock);
          }
        });
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
  assertPrivateDataFileSync(path);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function readFirstJsonLineSync(path: string): unknown {
  assertPrivateDataFileSync(path);
  const descriptor = openSync(path, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = Buffer.allocUnsafe(4_096);
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, total);
      if (bytesRead === 0) {
        throw new FileStorageIntegrityError(`JSONL has no complete first record: ${path}`);
      }
      const content = chunk.subarray(0, bytesRead);
      const newline = content.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(content.subarray(0, newline));
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      }
      chunks.push(content);
      total += bytesRead;
      if (total > 1024 * 1024) {
        throw new FileStorageIntegrityError(`JSONL first record exceeds 1 MiB: ${path}`);
      }
    }
  } finally {
    closeSync(descriptor);
  }
}

export function readLastJsonLineSync(path: string): unknown {
  assertPrivateDataFileSync(path);
  const size = statSync(path).size;
  if (size === 0) throw new FileStorageIntegrityError(`JSONL is empty: ${path}`);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const chunks: Buffer[] = [];
  let position = size;
  let skipTrailingNewline = true;
  try {
    while (position > 0) {
      const length = Math.min(4_096, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = readSync(descriptor, chunk, 0, length, position);
      if (bytesRead !== length) {
        throw new FileStorageIntegrityError(`Cannot read JSONL tail: ${path}`);
      }
      let content = chunk;
      if (skipTrailingNewline) {
        if (content[content.length - 1] !== 0x0a) {
          throw new FileStorageIntegrityError(`JSONL has an incomplete final record: ${path}`);
        }
        content = content.subarray(0, -1);
        skipTrailingNewline = false;
      }
      const newline = content.lastIndexOf(0x0a);
      if (newline >= 0) {
        chunks.unshift(content.subarray(newline + 1));
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      }
      chunks.unshift(content);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Reads a JSONL ledger under its owning lock. A non-newline-terminated tail is uncommitted and
 * may be truncated; every complete line must remain valid JSON.
 */
export function readJsonLinesSync(path: string, repairIncompleteTail = false): unknown[] {
  if (!existsSync(path)) return [];
  assertPrivateDataFileSync(path);
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
  const descriptor = openSync(
    target,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new FileStorageIntegrityError(`Append target must be a regular file: ${target}`);
    }
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(target, 0o600);
  syncDirectorySync(dirname(target));
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
  ensurePrivateStorageRootSync(root);
  recoverFileTransactionSync(root, options);
  validateInputTargetPrefixes(root, input, options.allowedTargetPrefixes);
  const transactionId = options.transactionId ?? randomUUID();
  const transaction = prepareTransaction(root, transactionId, input);
  validateTransactionTargets(root, transaction, options.allowedTargetPrefixes);
  if (transaction.replacements.length === 0 && transaction.appends.length === 0) {
    return transactionId;
  }
  const commitPath = transactionCommitPath(root, options.commitFileName);
  writeJsonAtomicSync(commitPath, transaction);
  options.onStage?.("commit-published", transactionId);
  applyTransaction(root, transaction, options.allowedTargetPrefixes);
  options.onStage?.("targets-applied", transactionId);
  unlinkSync(commitPath);
  syncDirectorySync(dirname(commitPath));
  options.onStage?.("commit-cleared", transactionId);
  return transactionId;
}

/** Completes a previously published commit. Callers must hold the storage root's lock. */
export function recoverFileTransactionSync(
  storageRoot: string,
  options: Pick<
    FileTransactionOptions,
    "allowedTargetPrefixes" | "commitFileName" | "onStage"
  > = {},
): string | undefined {
  const root = resolve(storageRoot);
  const commitPath = transactionCommitPath(root, options.commitFileName);
  if (!existsSync(commitPath)) return undefined;
  const transaction = decodePersistedTransaction(readJsonFileSync(commitPath), commitPath);
  applyTransaction(root, transaction, options.allowedTargetPrefixes);
  options.onStage?.("targets-applied", transaction.transactionId);
  unlinkSync(commitPath);
  syncDirectorySync(dirname(commitPath));
  options.onStage?.("commit-cleared", transaction.transactionId);
  return transaction.transactionId;
}

/**
 * Validates a durable marker without applying it. Read-only diagnostics use this to distinguish
 * a recoverable pending transaction from a corrupt commit.
 */
export function validateFileTransactionMarkerSync(
  storageRoot: string,
  options: Pick<FileTransactionOptions, "allowedTargetPrefixes" | "commitFileName"> = {},
): string {
  return inspectFileTransactionMarkerSync(storageRoot, options).transactionId;
}

export interface FileTransactionInspection {
  readonly transactionId: string;
  readonly status: "pending" | "partially-applied" | "applied";
}

export interface FileTransactionReplacementInspection extends FileTransactionInspection {
  readonly replacement?: {
    readonly relativePath: string;
    readonly content: Buffer;
  };
}

/** Validates both marker structure and the recoverability of every current target. */
export function inspectFileTransactionMarkerSync(
  storageRoot: string,
  options: Pick<FileTransactionOptions, "allowedTargetPrefixes" | "commitFileName"> = {},
): FileTransactionInspection {
  return inspectPersistedFileTransactionSync(storageRoot, options).inspection;
}

/**
 * Strictly validates a pending transaction and returns one decoded replacement payload when
 * present. Callers use this for read-only preflight decisions; no target is applied or rewritten.
 */
export function inspectFileTransactionReplacementSync(
  storageRoot: string,
  relativePath: string,
  options: Pick<FileTransactionOptions, "allowedTargetPrefixes" | "commitFileName"> = {},
): FileTransactionReplacementInspection {
  const root = resolve(storageRoot);
  const { transaction, inspection } = inspectPersistedFileTransactionSync(root, options);
  const requested = normalizedRelativePath(root, resolveTransactionTarget(root, relativePath));
  const replacement = transaction.replacements.find(
    (entry) =>
      normalizedRelativePath(root, resolveTransactionTarget(root, entry.relativePath)) ===
      requested,
  );
  return {
    ...inspection,
    ...(replacement
      ? {
          replacement: {
            relativePath: requested,
            content: Buffer.from(replacement.contentBase64, "base64"),
          },
        }
      : {}),
  };
}

function inspectPersistedFileTransactionSync(
  storageRoot: string,
  options: Pick<FileTransactionOptions, "allowedTargetPrefixes" | "commitFileName">,
): {
  readonly transaction: PersistedFileTransaction;
  readonly inspection: FileTransactionInspection;
} {
  const root = resolve(storageRoot);
  const commitPath = transactionCommitPath(root, options.commitFileName);
  const transaction = decodePersistedTransaction(readJsonFileSync(commitPath), commitPath);
  validateTransactionTargets(root, transaction, options.allowedTargetPrefixes);
  return {
    transaction,
    inspection: inspectTransactionTargets(root, transaction),
  };
}

function inspectTransactionTargets(
  root: string,
  transaction: PersistedFileTransaction,
): FileTransactionInspection {
  let applied = 0;
  let pending = 0;
  let partial = 0;
  for (const replacement of transaction.replacements) {
    const target = resolveTransactionTarget(root, replacement.relativePath);
    const current = readOptionalFile(target);
    const hash = sha256(current);
    if (hash === replacement.nextHash) {
      applied++;
    } else if (current.length === replacement.expectedSize && hash === replacement.expectedHash) {
      pending++;
    } else {
      throw targetConflict(target, transaction.transactionId);
    }
  }
  for (const append of transaction.appends) {
    const target = resolveTransactionTarget(root, append.relativePath);
    const current = readOptionalFile(target);
    const addition = Buffer.from(append.contentBase64, "base64");
    if (
      current.length >= append.expectedSize &&
      sha256(current.subarray(0, append.expectedSize)) === append.expectedHash
    ) {
      const projected = Buffer.concat([current.subarray(0, append.expectedSize), addition]);
      if (projected.length !== append.nextSize || sha256(projected) !== append.nextHash) {
        throw new FileStorageIntegrityError(
          `Append payload hash mismatch in transaction ${transaction.transactionId}`,
        );
      }
    }
    const hash = sha256(current);
    if (current.length === append.nextSize && hash === append.nextHash) {
      applied++;
      continue;
    }
    if (current.length === append.expectedSize && hash === append.expectedHash) {
      pending++;
      continue;
    }
    if (
      current.length > append.expectedSize &&
      current.length < append.nextSize &&
      sha256(current.subarray(0, append.expectedSize)) === append.expectedHash &&
      addition
        .subarray(0, current.length - append.expectedSize)
        .equals(current.subarray(append.expectedSize))
    ) {
      partial++;
      continue;
    }
    throw targetConflict(target, transaction.transactionId);
  }
  return {
    transactionId: transaction.transactionId,
    status:
      partial > 0 || (applied > 0 && pending > 0)
        ? "partially-applied"
        : pending > 0
          ? "pending"
          : "applied",
  };
}

export function mkdirPrivateSync(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function syncDirectorySync(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Probes the exact storage root used by a Store. The result is cached only after the local
 * filesystem proves private modes, atomic mkdir/rename, file+directory fsync, and recovery of a
 * published transaction.
 */
export function assertLocalFileStorageCapabilitiesSync(storageRoot: string): void {
  const root = resolve(storageRoot);
  ensurePrivateStorageRootSync(root);
  const canonicalRoot = realpathSync.native(root);
  if (capabilityCheckedRoots.has(canonicalRoot)) return;
  const probeRoot = join(root, `.storage-capability-${process.pid}-${randomUUID()}`);
  try {
    mkdirSync(probeRoot, { mode: 0o700 });
    const lockPath = join(probeRoot, "lock");
    mkdirSync(lockPath, { mode: 0o700 });
    try {
      mkdirSync(lockPath);
      throw new FileStorageIntegrityError("Atomic mkdir did not reject a duplicate lock");
    } catch (error) {
      if (!isNodeCode(error, "EEXIST")) throw error;
    }
    rmSync(lockPath, { recursive: true });

    const statePath = join(probeRoot, "state.json");
    writeFileAtomicSync(statePath, '{"revision":1}\n');
    if (readFileSync(statePath, "utf8") !== '{"revision":1}\n') {
      throw new FileStorageIntegrityError("Atomic rename probe returned unexpected content");
    }
    if (process.platform !== "win32") {
      const directoryMode = statSync(probeRoot).mode & 0o777;
      const fileMode = statSync(statePath).mode & 0o777;
      if (directoryMode !== 0o700 || fileMode !== 0o600) {
        throw new FileStorageIntegrityError(
          `Private storage mode probe failed (${directoryMode.toString(8)}/${fileMode.toString(8)})`,
        );
      }
    }

    let crashInjected = false;
    try {
      commitFileTransactionSync(
        probeRoot,
        {
          replacements: [{ relativePath: "state.json", content: '{"revision":2}\n' }],
          appends: [{ relativePath: "events.jsonl", content: '{"eventId":"probe"}\n' }],
        },
        {
          transactionId: "storage-capability-probe",
          onStage(stage) {
            if (stage === "commit-published") {
              crashInjected = true;
              throw new Error("storage capability crash probe");
            }
          },
        },
      );
    } catch (error) {
      if (!crashInjected || errorMessage(error) !== "storage capability crash probe") throw error;
    }
    if (!crashInjected) {
      throw new FileStorageIntegrityError("Crash recovery probe did not publish a commit marker");
    }
    if (recoverFileTransactionSync(probeRoot) !== "storage-capability-probe") {
      throw new FileStorageIntegrityError("Crash recovery probe did not recover its transaction");
    }
    if (
      readFileSync(statePath, "utf8") !== '{"revision":2}\n' ||
      readFileSync(join(probeRoot, "events.jsonl"), "utf8") !== '{"eventId":"probe"}\n'
    ) {
      throw new FileStorageIntegrityError("Crash recovery probe produced unexpected content");
    }
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
    syncDirectorySync(root);
  }
  capabilityCheckedRoots.add(canonicalRoot);
}

function canonicalStoragePathSync(path: string): string {
  const resolvedPath = resolve(path);
  if (existsSync(resolvedPath)) {
    const metadata = lstatSync(resolvedPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new FileStorageIntegrityError(`File lock must be a real directory: ${resolvedPath}`);
    }
  }
  let existing = dirname(resolvedPath);
  const missingSegments: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missingSegments.unshift(basename(existing));
    existing = parent;
  }
  return join(resolve(realpathSync.native(existing), ...missingSegments), basename(resolvedPath));
}

function ensurePrivateStorageRootSync(root: string): void {
  if (existsSync(root)) {
    const metadata = lstatSync(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new FileStorageIntegrityError(`Storage root must be a real directory: ${root}`);
    }
  }
  mkdirPrivateSync(root);
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
      if (
        inspection.state === "absent" &&
        publishSyncLockCandidate(candidate.path, lockDirectory)
      ) {
        return candidate.owner;
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
        `Timed out waiting for file lock ${lockDirectory}${
          lastOwner ? ` held by ${lastOwner.ownerId} (${lastOwner.hostname}:${lastOwner.pid})` : ""
        }`,
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
          `Timed out waiting for file lock ${lockDirectory}${
            lastOwner
              ? ` held by ${lastOwner.ownerId} (${lastOwner.hostname}:${lastOwner.pid})`
              : ""
          }`,
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
  if (current.leaseId !== expected.leaseId) {
    throw new LeaseConflictError(
      `Lock ownership changed before release: ${lockDirectory}`,
      current,
    );
  }
  rmSync(lockDirectory, { recursive: true, force: true });
  syncDirectorySync(dirname(lockDirectory));
}

function assertSyncLockOwnership(lockDirectory: string, expected: OwnerLeaseRecord): void {
  const current = readSyncLockOwner(join(lockDirectory, "owner.json"));
  if (current?.leaseId !== expected.leaseId) {
    throw new LeaseConflictError(`Lock ownership changed: ${lockDirectory}`, current);
  }
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

function canProveOwnerIsDead(owner: OwnerLeaseRecord, now: number, staleAfterMs: number): boolean {
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
    assertSafeTransactionTarget(root, target, true);
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
    assertSafeTransactionTarget(root, target, true);
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

function applyTransaction(
  root: string,
  transaction: PersistedFileTransaction,
  allowedTargetPrefixes?: readonly string[],
): void {
  validateTransactionTargets(root, transaction, allowedTargetPrefixes);
  // Prove every target is recoverable before mutating any of them. Without this pass, a
  // conflict in a later target could strand an earlier target in a newly partial transaction.
  inspectTransactionTargets(root, transaction);
  for (const replacement of transaction.replacements) {
    const target = resolveTransactionTarget(root, replacement.relativePath);
    const current = readOptionalFile(target);
    const currentHash = sha256(current);
    if (currentHash === replacement.nextHash) continue;
    if (current.length !== replacement.expectedSize || currentHash !== replacement.expectedHash) {
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
      addition
        .subarray(0, current.length - append.expectedSize)
        .equals(current.subarray(append.expectedSize))
    ) {
      truncateFileNoFollowSync(target, append.expectedSize);
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
    value["transactionId"].length === 0 ||
    typeof value["createdAt"] !== "string" ||
    value["createdAt"].length === 0 ||
    !Array.isArray(value["replacements"]) ||
    !Array.isArray(value["appends"])
  ) {
    throw new FileStorageIntegrityError(`Invalid file transaction marker: ${path}`);
  }
  const replacements = value["replacements"].map((entry, index) =>
    decodePersistedReplacement(entry, path, index),
  );
  const appends = value["appends"].map((entry, index) => decodePersistedAppend(entry, path, index));
  return {
    schemaVersion: FILE_TRANSACTION_SCHEMA_VERSION,
    transactionId: value["transactionId"],
    createdAt: value["createdAt"],
    replacements,
    appends,
  };
}

function decodePersistedReplacement(
  value: unknown,
  path: string,
  index: number,
): PersistedReplacement {
  if (
    !isRecord(value) ||
    typeof value["relativePath"] !== "string" ||
    !isNonNegativeSafeInteger(value["expectedSize"]) ||
    !isSha256(value["expectedHash"]) ||
    !isSha256(value["nextHash"]) ||
    typeof value["contentBase64"] !== "string"
  ) {
    throw invalidTransactionEntry(path, "replacement", index);
  }
  const content = decodeCanonicalBase64(value["contentBase64"], path);
  if (sha256(content) !== value["nextHash"]) {
    throw invalidTransactionEntry(path, "replacement", index);
  }
  return {
    relativePath: value["relativePath"],
    expectedSize: value["expectedSize"],
    expectedHash: value["expectedHash"],
    nextHash: value["nextHash"],
    contentBase64: value["contentBase64"],
  };
}

function decodePersistedAppend(value: unknown, path: string, index: number): PersistedAppend {
  if (
    !isRecord(value) ||
    typeof value["relativePath"] !== "string" ||
    !isNonNegativeSafeInteger(value["expectedSize"]) ||
    !isSha256(value["expectedHash"]) ||
    !isNonNegativeSafeInteger(value["nextSize"]) ||
    !isSha256(value["nextHash"]) ||
    typeof value["contentBase64"] !== "string"
  ) {
    throw invalidTransactionEntry(path, "append", index);
  }
  const content = decodeCanonicalBase64(value["contentBase64"], path);
  if (value["nextSize"] !== value["expectedSize"] + content.length) {
    throw invalidTransactionEntry(path, "append", index);
  }
  return {
    relativePath: value["relativePath"],
    expectedSize: value["expectedSize"],
    expectedHash: value["expectedHash"],
    nextSize: value["nextSize"],
    nextHash: value["nextHash"],
    contentBase64: value["contentBase64"],
  };
}

function validateTransactionTargets(
  root: string,
  transaction: PersistedFileTransaction,
  allowedTargetPrefixes?: readonly string[],
): void {
  const targets = [...transaction.replacements, ...transaction.appends].map((entry) =>
    resolveTransactionTarget(root, entry.relativePath),
  );
  const normalizedTargets = targets.map((target) => normalizedRelativePath(root, target));
  if (new Set(normalizedTargets).size !== normalizedTargets.length) {
    throw new FileStorageIntegrityError(
      `File transaction ${transaction.transactionId} mutates one target more than once`,
    );
  }
  const normalizedPrefixes = allowedTargetPrefixes?.map((prefix) =>
    normalizedTransactionPrefix(root, prefix),
  );
  if (
    normalizedPrefixes &&
    normalizedTargets.some(
      (target) =>
        !normalizedPrefixes.some((prefix) => target === prefix || target.startsWith(`${prefix}/`)),
    )
  ) {
    throw new FileStorageIntegrityError(
      `File transaction ${transaction.transactionId} targets a path outside its namespace`,
    );
  }
  for (const target of targets) assertSafeTransactionTarget(root, target, false);
}

function validateInputTargetPrefixes(
  root: string,
  input: FileTransactionInput,
  allowedTargetPrefixes?: readonly string[],
): void {
  if (!allowedTargetPrefixes) return;
  const prefixes = allowedTargetPrefixes.map((prefix) => normalizedTransactionPrefix(root, prefix));
  for (const entry of [...(input.replacements ?? []), ...(input.appends ?? [])]) {
    const target = normalizedRelativePath(root, resolveTransactionTarget(root, entry.relativePath));
    if (!prefixes.some((prefix) => target === prefix || target.startsWith(`${prefix}/`))) {
      throw new FileStorageIntegrityError(
        `File transaction target is outside its namespace: ${entry.relativePath}`,
      );
    }
  }
}

function normalizedTransactionPrefix(root: string, prefix: string): string {
  if (!prefix || isAbsolute(prefix)) {
    throw new Error(`Transaction target prefix must be relative: ${prefix}`);
  }
  const target = resolve(root, prefix);
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Transaction target prefix escapes storage root: ${prefix}`);
  }
  return normalizedRelativePath(root, target);
}

function decodeCanonicalBase64(value: string, path: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new FileStorageIntegrityError(`Invalid base64 payload in file transaction ${path}`);
  }
  return content;
}

function invalidTransactionEntry(
  path: string,
  kind: "replacement" | "append",
  index: number,
): FileStorageIntegrityError {
  return new FileStorageIntegrityError(
    `Invalid ${kind} ${index + 1} in file transaction marker: ${path}`,
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function transactionCommitPath(root: string, fileName = "commit.json"): string {
  const segments = fileName.split(/[\\/]+/u);
  if (
    !fileName ||
    isAbsolute(fileName) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid transaction commit file name: ${fileName}`);
  }
  const path = resolve(root, fileName);
  if (path === root || !path.startsWith(`${root}${sep}`)) {
    throw new Error(`Transaction commit file escapes storage root: ${fileName}`);
  }
  return path;
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

function assertSafeTransactionTarget(root: string, target: string, createParents: boolean): void {
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new FileStorageIntegrityError(`Storage root must be a real directory: ${root}`);
  }
  const parentRelative = relative(root, dirname(target));
  if (parentRelative.startsWith("..") || isAbsolute(parentRelative)) {
    throw new FileStorageIntegrityError(`Transaction target escapes storage root: ${target}`);
  }
  let current = root;
  for (const segment of parentRelative.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) {
      if (!createParents) {
        throw new FileStorageIntegrityError(`Transaction target parent does not exist: ${current}`);
      }
      mkdirSync(current, { mode: 0o700 });
      syncDirectorySync(dirname(current));
    }
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new FileStorageIntegrityError(
        `Transaction target parent must be a real directory: ${current}`,
      );
    }
  }
  if (!existsSync(target)) return;
  const targetMetadata = lstatSync(target);
  if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) {
    throw new FileStorageIntegrityError(
      `Transaction target must be a regular file or absent: ${target}`,
    );
  }
}

function normalizedRelativePath(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

function readOptionalFile(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(descriptor).isFile()) {
      throw new FileStorageIntegrityError(`Transaction target must be a regular file: ${path}`);
    }
    return readFileSync(descriptor);
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return Buffer.alloc(0);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncFileSync(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new FileStorageIntegrityError(`Storage target must be a regular file: ${path}`);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function truncateFileNoFollowSync(path: string, size: number): void {
  const descriptor = openSync(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new FileStorageIntegrityError(`Storage target must be a regular file: ${path}`);
    }
    ftruncateSync(descriptor, size);
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

function assertSynchronousResult<Result>(value: Result, lockPath: string): Result {
  if (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  ) {
    void Promise.resolve(value).catch(() => undefined);
    throw new TypeError(
      `withFileLockSync callback for ${lockPath} returned a Promise; use withFileLock instead`,
    );
  }
  return value;
}

export function assertPrivateDataFileSync(path: string): void {
  if (process.platform === "win32") return;
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o777) !== 0o600) {
    throw new FileStorageIntegrityError(`Storage data file must be a regular 0600 file: ${path}`);
  }
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700) {
    throw new FileStorageIntegrityError(
      `Storage data directory must be a regular 0700 directory: ${dirname(path)}`,
    );
  }
}

async function waitForLocalLockTurn(
  previous: Promise<void>,
  deadline: number,
  lockPath: string,
): Promise<void> {
  const remainingMs = Math.max(0, deadline - Date.now());
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      previous.catch(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new FileLockTimeoutError(
                `Timed out waiting for in-process file lock ${lockPath}`,
                lockPath,
              ),
            ),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
