import {
  FileStorageIntegrityError,
  recoverFileTransactionSync,
  withFileLockSync,
  type FileTransactionOptions,
} from "./local-file-storage.js";

/**
 * Per-ledger injections for {@link withLedgerStoreLock}. Each ledger supplies its own assertions
 * and error mapping so the shared lock/recover skeleton can stay identical across stores while
 * preserving their distinct integrity-error types.
 */
export interface LedgerStoreLockOptions {
  /** Directory protected by the OwnerLease file lock. */
  readonly lockDirectory: string;
  /** Workspace storage root passed to {@link recoverFileTransactionSync}. */
  readonly storageRoot: string;
  /** OwnerLease identifier claimed for the file lock. */
  readonly ownerId: string;
  /**
   * Transaction options forwarded to {@link recoverFileTransactionSync}. Each ledger injects its
   * own allowed target prefixes / commit file name.
   */
  readonly transactionOptions?: Pick<
    FileTransactionOptions,
    "allowedTargetPrefixes" | "commitFileName" | "onStage"
  >;
  /** When set, the operation runs without acquiring the lock (no recovery either). */
  readonly readOnly?: boolean;
  /** Assertion invoked outside the lock (e.g. root-identity + boundary check). Optional. */
  readonly preLockAssert?: () => void;
  /**
   * Assertion invoked inside the lock before recovery runs (after re-establishing any
   * root-identity guarantees). Optional.
   */
  readonly postLockAssert?: () => void;
  /** Assertion invoked inside the lock after recovery completes. Optional. */
  readonly postRecoverAssert?: () => void;
  /** Maps low-level errors into the ledger's own integrity-error type. Optional. */
  readonly mapError?: (error: unknown) => unknown;
}

/**
 * Shared lock/recover skeleton for the file-backed ledgers (RuntimeEventStore, TaskRunStore, ...).
 *
 * Sequence:
 * 1. {@link LedgerStoreLockOptions.preLockAssert} (outside the lock)
 * 2. short-circuit {@link LedgerStoreLockOptions.readOnly} path (no lock, no recovery)
 * 3. `withFileLockSync`:
 *    a. {@link LedgerStoreLockOptions.postLockAssert}
 *    b. `recoverFileTransactionSync`
 *    c. {@link LedgerStoreLockOptions.postRecoverAssert}
 *    d. `operation`
 * 4. {@link LedgerStoreLockOptions.mapError} on any thrown error
 *
 * Ledgers with extra concerns (retry loops, lease contention) keep that logic in their own
 * callers; this helper only captures the common pre/post lock + recover skeleton.
 */
export function withLedgerStoreLock<Result>(
  options: LedgerStoreLockOptions,
  operation: () => Result,
): Result {
  const {
    lockDirectory,
    storageRoot,
    ownerId,
    transactionOptions,
    readOnly = false,
    preLockAssert,
    postLockAssert,
    postRecoverAssert,
    mapError,
  } = options;

  try {
    preLockAssert?.();
    if (readOnly) return operation();
    return withFileLockSync(lockDirectory, ownerId, () => {
      postLockAssert?.();
      recoverFileTransactionSync(storageRoot, transactionOptions);
      postRecoverAssert?.();
      return operation();
    });
  } catch (error) {
    if (mapError) throw mapError(error);
    throw error;
  }
}

/**
 * Convenience for the common error-mapping pattern: pass the ledger's own integrity-error class
 * and a label, and low-level {@link FileStorageIntegrityError} / {@link SyntaxError} instances are
 * wrapped while everything else is rethrown unchanged. The ledger's own error type is also
 * rethrown as-is so already-mapped errors are not double-wrapped.
 */
export function createFileStorageErrorMapper<TError extends Error>(
  LedgerError: new (message: string, options?: { cause?: unknown }) => TError,
  label: string,
): (error: unknown) => unknown {
  return (error: unknown) => {
    if (error instanceof LedgerError) throw error;
    if (error instanceof FileStorageIntegrityError || error instanceof SyntaxError) {
      throw new LedgerError(`${label} storage is invalid: ${error.message}`, { cause: error });
    }
    throw error;
  };
}
