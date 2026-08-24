import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync, readdirSync, type Dirent } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { withVerifiedEvidenceDirectory } from "../context/evidence-blob-store.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { LeaseConflictError, OwnerLease } from "./owner-lease.js";
import {
  isFileHistoryMutationLeaseHeld,
  withFileHistoryMutationLease,
} from "./file-history-mutation-lease.js";
import {
  openOperationalDatabaseReadOnly,
  operationalDatabasePath,
} from "./sqlite/sqlite-database.js";
import { withWorkspaceSqliteLease } from "./sqlite/workspace-scopes.js";

const SHA256_DIGEST_RE = /^[a-f0-9]{64}$/u;
const DEFAULT_BATCH_SIZE = 100;
const MAX_ERROR_LENGTH = 2_000;

type BlobKind = "evidence" | "file_history" | "runtime_asset";

interface BlobGcIntent {
  readonly source: "hard_cut" | "retention";
  readonly intentId: string;
  readonly kind: BlobKind;
  readonly digest: string;
  readonly byteLength?: number;
  readonly storageUri?: string;
  readonly requiresReferenceCheck: boolean;
  readonly attemptCount: number;
}

export interface RunWorkspaceBlobGcOptions {
  readonly workDir: string;
  readonly picoHome: string;
  readonly limit?: number;
  readonly now?: () => Date;
}

export interface WorkspaceBlobGcResult {
  readonly status: "completed" | "lease_busy";
  readonly processed: number;
  readonly completed: number;
  readonly retryable: number;
}

/**
 * Replays the two durable EventLog blob-GC outboxes outside their originating
 * SQLite transactions. A workspace lease prevents concurrent replay, while the
 * global File History mutation lease closes the reference-check/unlink race.
 */
export async function runWorkspaceBlobGcOnce(
  options: RunWorkspaceBlobGcOptions,
): Promise<WorkspaceBlobGcResult> {
  const limit = options.limit ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("Blob GC limit must be a positive safe integer");
  }

  const paths = resolvePicoPaths(options.workDir, { picoHome: options.picoHome });
  let lease: OwnerLease;
  try {
    lease = await OwnerLease.acquire({
      leaseDirectory: join(paths.workspace.root, ".leases", "blob-gc"),
      ownerId: `blob-gc:${process.pid}:${randomUUID()}`,
      staleAfterMs: 30_000,
    });
  } catch (error) {
    if (error instanceof LeaseConflictError) {
      return { status: "lease_busy", processed: 0, completed: 0, retryable: 0 };
    }
    throw error;
  }

  let processed = 0;
  let completed = 0;
  let retryable = 0;
  try {
    const intents = readPendingIntents(paths.workspace.root, limit, options.now?.() ?? new Date());
    for (const intent of intents) {
      await lease.assertOwnership();
      processed += 1;
      try {
        await applyIntent(intent, paths, lease);
        recordIntentResult(paths.workspace.root, intent, { status: "completed" });
        completed += 1;
      } catch (error) {
        recordIntentResult(paths.workspace.root, intent, {
          status: "retryable",
          error: boundedError(error),
          now: options.now?.() ?? new Date(),
        });
        retryable += 1;
      }
    }
  } finally {
    await lease.release();
  }
  return { status: "completed", processed, completed, retryable };
}

async function applyIntent(
  intent: BlobGcIntent,
  paths: ReturnType<typeof resolvePicoPaths>,
  workspaceLease: OwnerLease,
): Promise<void> {
  if (!SHA256_DIGEST_RE.test(intent.digest)) {
    throw new Error(`Blob GC intent ${intent.intentId} has an invalid SHA-256 digest`);
  }

  if (intent.kind === "file_history") {
    await withFileHistoryMutationLease(
      paths.home.fileHistory,
      `blob-gc:${process.pid}:${intent.intentId}`,
      async (mutationLease) => {
        await workspaceLease.assertOwnership();
        await mutationLease.assertOwnership();
        if (fileHistoryDigestIsReferenced(paths.home.workspaces, intent.digest)) {
          throw new Error(`File History blob ${intent.digest} is still referenced`);
        }
        if (!isFileHistoryMutationLeaseHeld(paths.home.fileHistory)) {
          throw new Error("File History mutation lease was lost before unlink");
        }
        await unlinkVerifiedCasBlobIfPresent(paths.home.fileHistory, intent);
      },
      { waitForExternalLease: false },
    );
    return;
  }

  if (intent.kind === "evidence") {
    if (
      intent.requiresReferenceCheck &&
      workspaceDigestIsReferenced(paths.workspace.root, "evidence", intent.digest)
    ) {
      throw new Error(`Evidence blob ${intent.digest} is still referenced`);
    }
    try {
      await withVerifiedEvidenceDirectory(
        paths.workspace.evidence,
        ["blobs", "sha256", intent.digest.slice(0, 2)],
        { create: false },
        async (directory) => {
          let handle;
          try {
            handle = await directory.openRegularFile(intent.digest, "Evidence blob GC target");
          } catch (error) {
            if (isMissing(error)) return;
            throw error;
          }
          try {
            const metadata = await handle.stat();
            if (intent.byteLength !== undefined && metadata.size !== intent.byteLength) {
              throw new Error(
                `Blob GC target size mismatch for ${intent.digest}: expected ${intent.byteLength}, found ${metadata.size}`,
              );
            }
            await directory.unlinkFile(intent.digest);
            await directory.sync();
          } finally {
            await handle.close().catch(() => undefined);
          }
        },
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return;
  }

  if (!intent.storageUri) {
    throw new Error(`Runtime asset ${intent.digest} has no replayable storage URI`);
  }
  const assetPath = resolveRuntimeAssetPath(intent.storageUri);
  assertContainedPath(paths.workspace.root, assetPath);
  if (!(await realPathIsContained(paths.workspace.root, assetPath))) return;
  await verifyAndUnlinkRuntimeAsset(assetPath, intent);
}

function readPendingIntents(storageRoot: string, limit: number, now: Date): BlobGcIntent[] {
  return withWorkspaceSqliteLease(storageRoot, (lease) =>
    lease.transaction("read", () => {
      const hardCut = lease.database
        .prepare(
          `SELECT intent_id, asset_scope, storage_uri, content_digest, byte_length,
                  requires_reference_check, attempt_count
           FROM event_log_blob_gc_intents
           WHERE state = 'pending'
              OR (state = 'retryable' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
           ORDER BY created_at, intent_id LIMIT ?`,
        )
        .all(now.toISOString(), limit) as Array<Record<string, unknown>>;
      const remaining = Math.max(0, limit - hardCut.length);
      const retention =
        remaining === 0
          ? []
          : (lease.database
              .prepare(
                `SELECT intent_id, blob_kind, digest, byte_length, storage_uri, attempt_count
                 FROM retention_gc_intents
                 WHERE completed_at IS NULL
                   AND (status = 'pending' OR updated_at <= ?)
                 ORDER BY updated_at, intent_id LIMIT ?`,
              )
              .all(now.getTime() - 60_000, remaining) as Array<Record<string, unknown>>);
      return [...hardCut.map(decodeHardCutIntent), ...retention.map(decodeRetentionIntent)];
    }),
  );
}

function recordIntentResult(
  storageRoot: string,
  intent: BlobGcIntent,
  result:
    | { readonly status: "completed" }
    | { readonly status: "retryable"; readonly error: string; readonly now: Date },
): void {
  withWorkspaceSqliteLease(storageRoot, (lease) =>
    lease.transaction("write", () => {
      if (intent.source === "retention") {
        const now = result.status === "retryable" ? result.now.getTime() : Date.now();
        const update =
          result.status === "completed"
            ? lease.database
                .prepare(
                  `UPDATE retention_gc_intents
                   SET status = 'completed', attempt_count = attempt_count + 1,
                       last_error = NULL, updated_at = ?, completed_at = ?
                   WHERE intent_id = ? AND completed_at IS NULL`,
                )
                .run(now, now, intent.intentId)
            : lease.database
                .prepare(
                  `UPDATE retention_gc_intents
                   SET status = 'failed', attempt_count = attempt_count + 1,
                       last_error = ?, updated_at = ?
                   WHERE intent_id = ? AND completed_at IS NULL`,
                )
                .run(result.error, now, intent.intentId);
        if (update.changes !== 1) {
          throw new Error(`Retention Blob GC intent ${intent.intentId} is no longer open`);
        }
        return;
      }

      const now = result.status === "retryable" ? result.now : new Date();
      const nextAttemptAt = new Date(
        now.getTime() + retryDelayMs(intent.attemptCount + 1),
      ).toISOString();
      const update =
        result.status === "completed"
          ? lease.database
              .prepare(
                `UPDATE event_log_blob_gc_intents
                 SET state = 'completed', attempt_count = attempt_count + 1,
                     next_attempt_at = NULL, last_error = NULL, updated_at = ?
                 WHERE intent_id = ? AND state IN ('pending','retryable')`,
              )
              .run(now.toISOString(), intent.intentId)
          : lease.database
              .prepare(
                `UPDATE event_log_blob_gc_intents
                 SET state = 'retryable', attempt_count = attempt_count + 1,
                     next_attempt_at = ?, last_error = ?, updated_at = ?
                 WHERE intent_id = ? AND state IN ('pending','retryable')`,
              )
              .run(nextAttemptAt, result.error, now.toISOString(), intent.intentId);
      if (update.changes !== 1) {
        throw new Error(`Hard-cut Blob GC intent ${intent.intentId} is no longer open`);
      }
    }),
  );
}

function fileHistoryDigestIsReferenced(workspacesRoot: string, digest: string): boolean {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(workspacesRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const storageRoot = join(workspacesRoot, entry.name);
    const databasePath = operationalDatabasePath(storageRoot);
    let metadata;
    try {
      metadata = lstatSync(databasePath);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Workspace database is not a regular file: ${databasePath}`);
    }
    const database = openOperationalDatabaseReadOnly(storageRoot);
    try {
      if (databaseJsonColumnContains(database, "file_history", "state_json", digest)) return true;
      if (databaseJsonColumnContains(database, "file_history_snapshots", "snapshot_json", digest)) {
        return true;
      }
    } finally {
      database.close();
    }
  }
  return false;
}

function workspaceDigestIsReferenced(
  storageRoot: string,
  kind: "evidence",
  digest: string,
): boolean {
  const database = openOperationalDatabaseReadOnly(storageRoot);
  try {
    if (kind === "evidence") {
      return databaseJsonColumnContains(database, "evidence_records", "content_json", digest);
    }
    return false;
  } finally {
    database.close();
  }
}

function databaseJsonColumnContains(
  database: DatabaseSync,
  table: string,
  column: string,
  digest: string,
): boolean {
  const present = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as Record<string, unknown> | undefined;
  if (!present) return false;
  const row = database
    .prepare(`SELECT 1 AS present FROM ${table} WHERE instr(${column}, ?) > 0 LIMIT 1`)
    .get(digest) as Record<string, unknown> | undefined;
  return row?.["present"] === 1;
}

async function unlinkVerifiedCasBlobIfPresent(
  baseDirectory: string,
  intent: BlobGcIntent,
): Promise<void> {
  try {
    await withVerifiedEvidenceDirectory(
      baseDirectory,
      ["blobs", "sha256", intent.digest.slice(0, 2)],
      { create: false },
      async (directory) => {
        let handle;
        try {
          handle = await directory.openRegularFile(intent.digest, "CAS blob GC target");
        } catch (error) {
          if (isMissing(error)) return;
          throw error;
        }
        try {
          const metadata = await handle.stat();
          if (intent.byteLength !== undefined && metadata.size !== intent.byteLength) {
            throw new Error(
              `Blob GC target size mismatch for ${intent.digest}: expected ${intent.byteLength}, found ${metadata.size}`,
            );
          }
          await directory.unlinkFile(intent.digest);
          await directory.sync();
        } finally {
          await handle.close().catch(() => undefined);
        }
      },
    );
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

async function verifyAndUnlinkRuntimeAsset(path: string, intent: BlobGcIntent): Promise<void> {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Runtime asset is not a regular non-symlink file: ${path}`);
  }
  if (intent.byteLength !== undefined && before.size !== BigInt(intent.byteLength)) {
    throw new Error(`Runtime asset size does not match GC intent ${intent.intentId}`);
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  if (digest.digest("hex") !== intent.digest) {
    throw new Error(`Runtime asset digest does not match GC intent ${intent.intentId}`);
  }
  const after = await lstat(path, { bigint: true });
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs
  ) {
    throw new Error(`Runtime asset changed during GC verification: ${path}`);
  }
  await unlink(path);
  await syncDirectory(dirname(path));
}

function resolveRuntimeAssetPath(storageUri: string): string {
  if (storageUri.startsWith("file:")) return resolve(fileURLToPath(storageUri));
  if (!isAbsolute(storageUri)) {
    throw new Error("Runtime asset storage URI must be an absolute path or file URL");
  }
  return resolve(storageUri);
}

function assertContainedPath(root: string, candidate: string): void {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Runtime asset path is outside the workspace storage root: ${candidate}`);
  }
}

async function realPathIsContained(root: string, candidate: string): Promise<boolean> {
  let physicalCandidate: string;
  try {
    physicalCandidate = await realpath(candidate);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  const physicalRoot = await realpath(root);
  assertContainedPath(physicalRoot, physicalCandidate);
  return true;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function decodeHardCutIntent(row: Record<string, unknown>): BlobGcIntent {
  const assetScope = requiredString(row["asset_scope"], "asset_scope");
  const kind =
    assetScope === "evidence_blob"
      ? "evidence"
      : assetScope === "file_history_blob"
        ? "file_history"
        : assetScope === "runtime_asset"
          ? "runtime_asset"
          : undefined;
  if (!kind) throw new Error(`Unsupported hard-cut GC asset scope: ${assetScope}`);
  const storageUri = optionalString(row["storage_uri"], "storage_uri");
  const byteLength = optionalNonNegativeInteger(row["byte_length"], "byte_length");
  return {
    source: "hard_cut",
    intentId: requiredString(row["intent_id"], "intent_id"),
    kind,
    digest: requiredString(row["content_digest"], "content_digest"),
    ...(byteLength === undefined ? {} : { byteLength }),
    ...(storageUri === undefined ? {} : { storageUri }),
    requiresReferenceCheck: row["requires_reference_check"] === 1,
    attemptCount: requiredNonNegativeInteger(row["attempt_count"], "attempt_count"),
  };
}

function decodeRetentionIntent(row: Record<string, unknown>): BlobGcIntent {
  const kind = requiredString(row["blob_kind"], "blob_kind");
  if (kind !== "evidence" && kind !== "file_history" && kind !== "runtime_asset") {
    throw new Error(`Unsupported retention GC blob kind: ${kind}`);
  }
  const storageUri = optionalString(row["storage_uri"], "storage_uri");
  return {
    source: "retention",
    intentId: requiredString(row["intent_id"], "intent_id"),
    kind,
    digest: requiredString(row["digest"], "digest"),
    byteLength: requiredNonNegativeInteger(row["byte_length"], "byte_length"),
    ...(storageUri === undefined ? {} : { storageUri }),
    requiresReferenceCheck: kind !== "runtime_asset",
    attemptCount: requiredNonNegativeInteger(row["attempt_count"], "attempt_count"),
  };
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(60 * 60_000, 1_000 * 2 ** Math.min(12, Math.max(0, attemptCount - 1)));
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH) || "Unknown Blob GC failure";
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredString(value, label);
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredNonNegativeInteger(value, label);
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return (
    isNodeError(error) &&
    new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(error.code ?? "")
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
