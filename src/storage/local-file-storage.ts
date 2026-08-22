import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { raceWithDeadlineReject } from "../util/race-with-deadline.js";
import { LeaseConflictError, OwnerLease, type OwnerLeaseRecord } from "./owner-lease.js";

/**
 * SQLite 纪元后的本地文件面(票 09,ADR 24 决策 3)。
 *
 * 目录锁仪式(.storage/lock)、commit.json 自研 WAL、JSONL 读写器与能力探针
 * 已整体退役——跨进程互斥由 pico.sqlite 的 BEGIN IMMEDIATE + busy_timeout 接管。
 * 保留的是仍被 sqlite 模块与其他文件面组件使用的原语:私有目录/原子写、
 * 0600 断言、FileStorageIntegrityError,以及低频文件面(agent-recovery
 * launch-intent)所需的异步 OwnerLease 文件锁。
 */

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;
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

/** Async lock for promise-based file surfaces that need heartbeat-backed ownership. */
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

export function mkdirPrivateSync(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  "EACCES",
  "EINVAL",
  "EISDIR",
  "ENOTSUP",
  "EPERM",
]);

/**
 * 目录 fsync 在部分文件系统（Windows NTFS、网络盘、容器挂载）上不被支持。
 * 与异步 syncDirectory 的既有降级模式一致：这些 errno 视为 best-effort 跳过，
 * 其余错误照常抛出。对齐 atomic-json / blob-store / session 等 8+ 处 async 兄弟实现。
 */
export function isUnsupportedDirectorySync(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    UNSUPPORTED_DIRECTORY_SYNC_CODES.has(String((error as { code?: unknown }).code))
  );
}

export function syncDirectorySync(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    closeSync(descriptor);
  }
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

async function acquireFileLock(
  lockDirectory: string,
  ownerId: string,
  options: FileLockOptions,
): Promise<OwnerLease> {
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_LOCK_RETRY_MS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  let lastOwner: OwnerLeaseRecord | undefined;
  for (;;) {
    try {
      return await OwnerLease.acquire({
        leaseDirectory: lockDirectory,
        ownerId,
        staleAfterMs: options.staleAfterMs,
      });
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

async function waitForLocalLockTurn(
  previous: Promise<void>,
  deadline: number,
  lockPath: string,
): Promise<void> {
  // 动态剩余超时:deadline 与当前时间的差值,保留此计算(每轮重算,非固定值)。
  const remainingMs = Math.max(0, deadline - Date.now());
  // previous reject 时 .catch 吞掉(轮次传递,锁竞争失败由后续轮处理);仅超时 reject。
  // 定时器句柄清理收敛进 raceWithDeadlineReject。
  await raceWithDeadlineReject(
    previous.catch(() => undefined),
    remainingMs,
    () =>
      new FileLockTimeoutError(`Timed out waiting for in-process file lock ${lockPath}`, lockPath),
  );
}

function removeTemporaryFileSync(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isNodeCode(error, "ENOENT")) throw error;
  }
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
