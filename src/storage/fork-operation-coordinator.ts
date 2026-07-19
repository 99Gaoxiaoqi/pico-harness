import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readVersionedJson, writeJsonAtomic } from "./atomic-json.js";
import { LeaseConflictError, OwnerLease, type OwnerLeaseRecord } from "./owner-lease.js";
import {
  isTerminalStorageOperation,
  StorageOperationJournal,
  type ForkStorageOperation,
  type NewStorageOperation,
  type StorageOperation,
  type StorageOperationDispositionInput,
} from "./operation-journal.js";

const FORK_BUNDLE_MANIFEST_VERSION = 2 as const;
const FORK_BUNDLE_MANIFEST_NAME = "fork-bundle.json";
const DEFAULT_FORK_LEASE_ACQUISITION_TIMEOUT_MS = 5_000;
const DEFAULT_FORK_LEASE_RETRY_INITIAL_MS = 20;
const DEFAULT_FORK_LEASE_RETRY_MAX_MS = 500;
const SHA256_DIGEST = /^[0-9a-f]{64}$/u;

export type NewForkStorageOperation = Extract<NewStorageOperation, { kind: "fork" }>;
export type ForkSourceCursor = ForkStorageOperation["sourceCursor"];

/** Coordinator 只校验不可变 payload，不解释其中的 Runtime fork 数据。 */
export interface ForkPreparedBundleFile {
  readonly stagedBundlePath: string;
}

export interface ForkPreparedBundle {
  readonly operationId: string;
  readonly sourceCursor: ForkSourceCursor;
  readonly targetSessionId: string;
  readonly stagingDirectory: string;
  readonly stagedBundlePath: string;
  readonly contentSha256: string;
  readonly sizeBytes: number;
}

/** Short-lived authority issued only while the coordinator owns the target lease. */
export interface ForkRuntimePublicationCapability {
  assertOwned(): Promise<void>;
}

export interface ForkOperationCallbacks {
  /** 返回已经冻结的不可变 fork payload；不得在此后重新读取 source。 */
  prepareTargetBundle(
    operation: ForkStorageOperation,
    stagingDirectory: string,
  ): Promise<ForkPreparedBundleFile>;
  /** 持有 target lease 后重查 Runtime 归属；必须在任何 sidecar 写入前完成。 */
  assertTargetAvailable(operation: ForkStorageOperation): Promise<void>;
  /** Runtime 已初始化时，验证其事实属于当前 operation 的可重放 bootstrap。 */
  assertRuntimeTargetOwned(
    operation: ForkStorageOperation,
    bundle: ForkPreparedBundle,
  ): Promise<void>;
  /** 克隆 File History / Summary / Artifact；必须以 operationId 幂等。 */
  cloneSidecars(operation: ForkStorageOperation, bundle: ForkPreparedBundle): Promise<void>;
  /** 向 RuntimeEventStore 发布消息、fork marker 与过滤后的 Session state。 */
  publishRuntime(
    operation: ForkStorageOperation,
    bundle: ForkPreparedBundle,
    publication: ForkRuntimePublicationCapability,
  ): Promise<void>;
}

export interface ForkOperationCoordinatorOptions {
  readonly journal: StorageOperationJournal;
  readonly callbacks: ForkOperationCallbacks;
  /** 必须与普通 Session 初始化使用同一 target owner lease。 */
  readonly targetLeaseDirectory: (targetSessionId: string) => string;
  readonly leaseAcquisitionTimeoutMs?: number;
  readonly leaseRetryInitialMs?: number;
  readonly leaseRetryMaxMs?: number;
  readonly random?: () => number;
}

export interface ForkReconciliationOptions {
  readonly signal?: AbortSignal;
  /** 每个 target 独立计算截止时间，避免一个冲突 target 吃掉整批恢复预算。 */
  readonly leaseAcquisitionTimeoutMs?: number;
  /** 可选的绝对截止时间（Unix epoch milliseconds）。 */
  readonly deadlineAt?: number;
}

export interface ForkLeaseContentionDiagnostic {
  readonly code: "fork_target_lease_timeout";
  readonly targetSessionId: string;
  readonly leaseDirectory: string;
  readonly attempts: number;
  readonly waitedMs: number;
  readonly deadlineAt: string;
  readonly lastOwner?: OwnerLeaseRecord;
}

export type ForkReconciliationResult = ForkReconciliationSuccess | ForkReconciliationTimeout;

export interface ForkReconciliationSuccess {
  readonly operationId: string;
  readonly state: ForkStorageOperation["state"];
}

export interface ForkReconciliationTimeout extends ForkReconciliationSuccess {
  readonly status: "lease_timeout";
  readonly diagnostic: ForkLeaseContentionDiagnostic;
}

export interface ForkAbortResult {
  readonly operation: ForkStorageOperation;
  readonly stagingCleanup: "completed" | "failed";
  readonly cleanupDiagnostic?: string;
}

export type ForkOperationConflictReason =
  | "invalid_operation"
  | "source_cursor_changed"
  | "staging_corrupt"
  | "target_conflict";

export class ForkOperationConflictError extends Error {
  constructor(
    message: string,
    readonly reason: ForkOperationConflictReason,
    readonly conflictingPaths: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ForkOperationConflictError";
  }
}

export class ForkOperationLeaseTimeoutError extends Error {
  constructor(readonly diagnostic: ForkLeaseContentionDiagnostic) {
    super(
      `Timed out acquiring fork target lease for ${diagnostic.targetSessionId} after ${diagnostic.waitedMs}ms`,
    );
    this.name = "ForkOperationLeaseTimeoutError";
  }
}

/**
 * fork 的 forward-only Saga：
 * prepared -> 校验不可变 source bundle -> workspace_applied
 * workspace_applied -> 幂等克隆 sidecars -> sidecars_committed
 * sidecars_committed -> 发布 Runtime fork + Session state -> completed
 *
 * Journal 总在外部副作用完成后才前进。崩溃重放只消费 staging 中冻结的
 * bundle，绝不重新读取可继续追加的 source 会话。
 */
export class ForkOperationCoordinator {
  private readonly journal: StorageOperationJournal;
  private readonly callbacks: ForkOperationCallbacks;
  private readonly resolveTargetLeaseDirectory: (targetSessionId: string) => string;
  private readonly leaseAcquisitionTimeoutMs: number;
  private readonly leaseRetryInitialMs: number;
  private readonly leaseRetryMaxMs: number;
  private readonly random: () => number;

  constructor(options: ForkOperationCoordinatorOptions) {
    this.journal = options.journal;
    this.callbacks = options.callbacks;
    this.resolveTargetLeaseDirectory = options.targetLeaseDirectory;
    this.leaseAcquisitionTimeoutMs = assertNonNegativeFinite(
      options.leaseAcquisitionTimeoutMs ?? DEFAULT_FORK_LEASE_ACQUISITION_TIMEOUT_MS,
      "leaseAcquisitionTimeoutMs",
    );
    this.leaseRetryInitialMs = assertPositiveFinite(
      options.leaseRetryInitialMs ?? DEFAULT_FORK_LEASE_RETRY_INITIAL_MS,
      "leaseRetryInitialMs",
    );
    this.leaseRetryMaxMs = assertPositiveFinite(
      options.leaseRetryMaxMs ?? DEFAULT_FORK_LEASE_RETRY_MAX_MS,
      "leaseRetryMaxMs",
    );
    if (this.leaseRetryMaxMs < this.leaseRetryInitialMs) {
      throw new Error("leaseRetryMaxMs must be greater than or equal to leaseRetryInitialMs");
    }
    this.random = options.random ?? Math.random;
  }

  async execute(
    input: NewForkStorageOperation,
    options: ForkReconciliationOptions = {},
  ): Promise<ForkStorageOperation> {
    const operation = await this.journal.create(input);
    if (operation.kind !== "fork") throw new Error("Expected fork operation");
    return this.forward(operation, options);
  }

  async reconcileUnfinished(
    options: ForkReconciliationOptions = {},
  ): Promise<ForkReconciliationResult[]> {
    const results: ForkReconciliationResult[] = [];
    for (const operation of await this.journal.listUnfinished()) {
      options.signal?.throwIfAborted();
      if (operation.kind !== "fork") continue;
      try {
        const result = await this.forward(operation, options);
        results.push({ operationId: result.operationId, state: result.state });
      } catch (error) {
        if (!(error instanceof ForkOperationLeaseTimeoutError)) throw error;
        const latest = await this.reloadOperation(operation);
        results.push({
          operationId: latest.operationId,
          state: latest.state,
          status: "lease_timeout",
          diagnostic: error.diagnostic,
        });
      }
    }
    return results;
  }

  /** 显式重放单个操作；已 completed 时仅补做 staging 清理。 */
  async reconcile(
    operationId: string,
    options: ForkReconciliationOptions = {},
  ): Promise<ForkStorageOperation> {
    const operation = await this.journal.get(operationId);
    if (!operation) throw new Error(`Storage operation not found: ${operationId}`);
    if (operation.kind !== "fork") {
      throw new Error(`Storage operation is not a fork: ${operationId}`);
    }
    if (operation.state === "completed") {
      await this.cleanupStaging(operation);
      return operation;
    }
    return this.forward(operation, options);
  }

  async retryNeedsAttention(
    input: StorageOperationDispositionInput,
    options: ForkReconciliationOptions = {},
  ): Promise<ForkStorageOperation> {
    const current = await this.journal.get(input.operationId);
    if (!current) throw new Error(`Storage operation not found: ${input.operationId}`);
    if (current.kind !== "fork") {
      throw new Error(`Storage operation is not a fork: ${input.operationId}`);
    }
    const restored = await this.journal.retryNeedsAttention(input);
    if (restored.kind !== "fork") throw new Error("Fork operation changed kind");
    return this.forward(restored, options);
  }

  async abortNeedsAttention(input: StorageOperationDispositionInput): Promise<ForkAbortResult> {
    const current = await this.journal.get(input.operationId);
    if (!current) throw new Error(`Storage operation not found: ${input.operationId}`);
    if (current.kind !== "fork") {
      throw new Error(`Storage operation is not a fork: ${input.operationId}`);
    }
    const aborted = await this.journal.abortNeedsAttention(input);
    if (aborted.kind !== "fork") throw new Error("Fork operation changed kind");
    try {
      await this.cleanupStaging(aborted);
      return { operation: aborted, stagingCleanup: "completed" };
    } catch (error) {
      return {
        operation: aborted,
        stagingCleanup: "failed",
        cleanupDiagnostic: errorMessage(error),
      };
    }
  }

  private async forward(
    initial: ForkStorageOperation,
    options: ForkReconciliationOptions,
  ): Promise<ForkStorageOperation> {
    for (;;) {
      options.signal?.throwIfAborted();
      const current = await this.reloadOperation(initial);
      if (isTerminalStorageOperation(current.state)) {
        if (current.state === "completed") await this.cleanupStaging(current);
        return current;
      }

      let lease: OwnerLease;
      try {
        lease = await this.acquireTargetLease(current, options);
      } catch (error) {
        if (!(error instanceof ForkOperationLeaseTimeoutError)) throw error;
        const latest = await this.reloadOperation(initial);
        if (isTerminalStorageOperation(latest.state)) {
          if (latest.state === "completed") await this.cleanupStaging(latest);
          return latest;
        }
        throw error;
      }

      try {
        const owned = await this.reloadOperation(initial);
        if (isTerminalStorageOperation(owned.state)) {
          if (owned.state === "completed") await this.cleanupStaging(owned);
          return owned;
        }
        await lease.assertOwnership();
        return await this.forwardOwned(owned, lease);
      } finally {
        await lease.release();
      }
    }
  }

  private async acquireTargetLease(
    operation: ForkStorageOperation,
    options: ForkReconciliationOptions,
  ): Promise<OwnerLease> {
    const timeoutMs = assertNonNegativeFinite(
      options.leaseAcquisitionTimeoutMs ?? this.leaseAcquisitionTimeoutMs,
      "leaseAcquisitionTimeoutMs",
    );
    const startedAt = Date.now();
    const deadline = Math.min(
      startedAt + timeoutMs,
      options.deadlineAt === undefined
        ? Number.POSITIVE_INFINITY
        : assertFinite(options.deadlineAt, "deadlineAt"),
    );
    const leaseDirectory = this.resolveTargetLeaseDirectory(operation.targetSessionId);
    let attempts = 0;
    let lastOwner: OwnerLeaseRecord | undefined;
    for (;;) {
      options.signal?.throwIfAborted();
      attempts += 1;
      try {
        return await OwnerLease.acquire({
          leaseDirectory,
          ownerId: `fork-operation:${operation.operationId}`,
        });
      } catch (error) {
        if (!(error instanceof LeaseConflictError)) throw error;
        lastOwner = error.owner;
      }

      const now = Date.now();
      if (now >= deadline) {
        throw new ForkOperationLeaseTimeoutError({
          code: "fork_target_lease_timeout",
          targetSessionId: operation.targetSessionId,
          leaseDirectory,
          attempts,
          waitedMs: Math.max(0, now - startedAt),
          deadlineAt: new Date(deadline).toISOString(),
          ...(lastOwner ? { lastOwner: structuredClone(lastOwner) } : {}),
        });
      }

      const exponentialDelay = Math.min(
        this.leaseRetryMaxMs,
        this.leaseRetryInitialMs * 2 ** Math.min(attempts - 1, 30),
      );
      const jitter = 0.5 + clampRandom(this.random());
      const waitMs = Math.max(1, Math.min(deadline - now, Math.round(exponentialDelay * jitter)));
      await delay(waitMs, undefined, options.signal ? { signal: options.signal } : undefined);
    }
  }

  private async forwardOwned(
    initial: ForkStorageOperation,
    lease: OwnerLease,
  ): Promise<ForkStorageOperation> {
    let operation = initial;
    try {
      if (operation.state === "prepared") {
        this.assertOperation(operation);
        await lease.assertOwnership();
        await this.assertTargetOwner(operation);
        await this.callbacks.assertTargetAvailable(operation);
        await lease.assertOwnership();
        await this.prepareBundle(operation);
        await lease.assertOwnership();
        operation = await this.advance(operation, "workspace_applied");
      }

      if (operation.state === "workspace_applied" || operation.state === "session_committed") {
        const bundle = await this.loadAndVerifyStagedBundle(operation);
        await lease.assertOwnership();
        await this.assertTargetOwner(operation);
        await this.callbacks.assertTargetAvailable(operation);
        await lease.assertOwnership();
        await this.callbacks.cloneSidecars(operation, bundle);
        await lease.assertOwnership();
        operation = await this.advance(operation, "sidecars_committed");
      }

      if (operation.state === "sidecars_committed") {
        const bundle = await this.loadAndVerifyStagedBundle(operation);
        await lease.assertOwnership();
        await this.assertTargetOwner(operation);
        await this.callbacks.assertRuntimeTargetOwned(operation, bundle);
        await lease.assertOwnership();
        let publicationActive = true;
        const publication: ForkRuntimePublicationCapability = {
          async assertOwned() {
            if (!publicationActive) {
              throw new Error(
                `Fork Runtime publication capability expired: ${operation.operationId}`,
              );
            }
            await lease.assertOwnership();
          },
        };
        try {
          await this.callbacks.publishRuntime(operation, bundle, publication);
        } finally {
          publicationActive = false;
        }
        await lease.assertOwnership();
        operation = await this.advance(operation, "completed");
        await this.cleanupStaging(operation);
      }
      return operation;
    } catch (error) {
      if (!(error instanceof ForkOperationConflictError)) throw error;
      return this.advance(operation, "needs_attention", {
        phase: operation.state,
        message: `${error.reason}: ${error.message}`,
        ...(error.conflictingPaths.length > 0
          ? { conflictingPaths: [...error.conflictingPaths] }
          : {}),
      });
    }
  }

  private async reloadOperation(initial: ForkStorageOperation): Promise<ForkStorageOperation> {
    const current = await this.journal.get(initial.operationId);
    if (!current) throw new Error(`Storage operation not found: ${initial.operationId}`);
    if (current.kind !== "fork") {
      throw new Error(`Storage operation is not a fork: ${initial.operationId}`);
    }
    if (
      current.sourceSessionId !== initial.sourceSessionId ||
      current.targetSessionId !== initial.targetSessionId ||
      current.stagingDirectory !== initial.stagingDirectory ||
      !sameCursor(current.sourceCursor, initial.sourceCursor)
    ) {
      throw new Error(`Fork operation identity changed: ${initial.operationId}`);
    }
    return current;
  }

  private assertOperation(operation: ForkStorageOperation): void {
    if (operation.sessionId !== operation.sourceSessionId) {
      throw new ForkOperationConflictError(
        "Fork operation sessionId must identify the source session",
        "invalid_operation",
      );
    }
  }

  private async assertTargetOwner(operation: ForkStorageOperation): Promise<void> {
    const contenders = (await this.journal.list()).filter(
      (candidate): candidate is ForkStorageOperation =>
        candidate.kind === "fork" &&
        candidate.targetSessionId === operation.targetSessionId &&
        retainsTargetClaim(candidate),
    );
    const advanced = contenders.filter((candidate) => candidate.state !== "prepared");
    const owner = (advanced.length > 0 ? advanced : contenders).toSorted(compareForkClaims)[0];
    if (owner?.operationId === operation.operationId) return;
    throw new ForkOperationConflictError(
      `Fork target ${operation.targetSessionId} is claimed by operation ${owner?.operationId ?? "unknown"}`,
      "target_conflict",
    );
  }

  private async prepareBundle(operation: ForkStorageOperation): Promise<ForkPreparedBundle> {
    const stagingDirectory = assertSafeStagingDirectory(operation.stagingDirectory);
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });

    const existingManifest = await this.tryLoadBundleManifest(operation);
    if (existingManifest) return this.verifyStagedBundle(operation, existingManifest);

    const prepared = await this.callbacks.prepareTargetBundle(operation, stagingDirectory);
    const stagedBundlePath = validatePreparedPath(prepared, operation);
    const contents = await readRegularFile(stagedBundlePath);
    const bundle = {
      operationId: operation.operationId,
      sourceCursor: structuredClone(operation.sourceCursor),
      targetSessionId: operation.targetSessionId,
      stagingDirectory,
      stagedBundlePath,
      contentSha256: sha256(contents),
      sizeBytes: contents.byteLength,
    } satisfies ForkPreparedBundle;
    await writeJsonAtomic(this.manifestPath(operation), {
      schemaVersion: FORK_BUNDLE_MANIFEST_VERSION,
      ...bundle,
    });
    return bundle;
  }

  private async loadAndVerifyStagedBundle(
    operation: ForkStorageOperation,
  ): Promise<ForkPreparedBundle> {
    return this.verifyStagedBundle(operation, await this.loadBundleManifest(operation));
  }

  private async verifyStagedBundle(
    operation: ForkStorageOperation,
    bundle: ForkPreparedBundle,
  ): Promise<ForkPreparedBundle> {
    validateBundleForOperation(bundle, operation);
    const contents = await readRegularFile(bundle.stagedBundlePath);
    if (contents.byteLength !== bundle.sizeBytes || sha256(contents) !== bundle.contentSha256) {
      throw new ForkOperationConflictError(
        "Frozen fork payload no longer matches its durable bundle manifest",
        "staging_corrupt",
        [bundle.stagedBundlePath],
      );
    }
    return bundle;
  }

  private async tryLoadBundleManifest(
    operation: ForkStorageOperation,
  ): Promise<ForkPreparedBundle | undefined> {
    if (!(await pathExists(this.manifestPath(operation)))) return undefined;
    return this.loadBundleManifest(operation);
  }

  private async loadBundleManifest(operation: ForkStorageOperation): Promise<ForkPreparedBundle> {
    try {
      const bundle = await readVersionedJson(this.manifestPath(operation), parseBundleManifest);
      validateBundleForOperation(bundle, operation);
      return bundle;
    } catch (error) {
      if (error instanceof ForkOperationConflictError) throw error;
      if (isNodeCode(error, "ENOENT")) {
        throw new ForkOperationConflictError("Fork bundle manifest is missing", "staging_corrupt", [
          this.manifestPath(operation),
        ]);
      }
      throw new ForkOperationConflictError(
        `Fork bundle manifest cannot be decoded: ${errorMessage(error)}`,
        "staging_corrupt",
        [this.manifestPath(operation)],
      );
    }
  }

  private manifestPath(operation: ForkStorageOperation): string {
    return join(assertSafeStagingDirectory(operation.stagingDirectory), FORK_BUNDLE_MANIFEST_NAME);
  }

  private async cleanupStaging(operation: ForkStorageOperation): Promise<void> {
    await rm(assertSafeStagingDirectory(operation.stagingDirectory), {
      recursive: true,
      force: true,
    });
  }

  private async advance(
    operation: ForkStorageOperation,
    nextState: ForkStorageOperation["state"],
    error?: { phase: string; message: string; conflictingPaths?: string[] },
  ): Promise<ForkStorageOperation> {
    const advanced: StorageOperation = await this.journal.advance({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      nextState,
      ...(error ? { error } : {}),
    });
    if (advanced.kind !== "fork") throw new Error("Fork operation changed kind");
    return advanced;
  }
}

function retainsTargetClaim(operation: ForkStorageOperation): boolean {
  if (operation.state === "aborted") return false;
  return !(
    operation.state === "needs_attention" &&
    operation.error?.message.startsWith("target_conflict:") === true
  );
}

function compareForkClaims(left: ForkStorageOperation, right: ForkStorageOperation): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.operationId.localeCompare(right.operationId)
  );
}

function parseBundleManifest(value: unknown): ForkPreparedBundle {
  if (!isRecord(value) || value["schemaVersion"] !== FORK_BUNDLE_MANIFEST_VERSION) {
    throw new Error("Unsupported fork bundle manifest schema");
  }
  const sourceCursor = parseCursor(value["sourceCursor"]);
  if (
    typeof value["operationId"] !== "string" ||
    !sourceCursor ||
    typeof value["targetSessionId"] !== "string" ||
    typeof value["stagingDirectory"] !== "string" ||
    typeof value["stagedBundlePath"] !== "string" ||
    typeof value["contentSha256"] !== "string" ||
    !SHA256_DIGEST.test(value["contentSha256"]) ||
    !isNonNegativeInteger(value["sizeBytes"])
  ) {
    throw new Error("Invalid fork bundle manifest");
  }
  return {
    operationId: value["operationId"],
    sourceCursor,
    targetSessionId: value["targetSessionId"],
    stagingDirectory: value["stagingDirectory"],
    stagedBundlePath: value["stagedBundlePath"],
    contentSha256: value["contentSha256"],
    sizeBytes: value["sizeBytes"],
  };
}

function validateBundleForOperation(
  bundle: ForkPreparedBundle,
  operation: ForkStorageOperation,
): void {
  const matches =
    bundle.operationId === operation.operationId &&
    bundle.targetSessionId === operation.targetSessionId &&
    resolve(bundle.stagingDirectory) === assertSafeStagingDirectory(operation.stagingDirectory) &&
    sameCursor(bundle.sourceCursor, operation.sourceCursor);
  if (!matches) {
    throw new ForkOperationConflictError(
      "Fork bundle manifest belongs to another operation or source cursor",
      "staging_corrupt",
      [join(operation.stagingDirectory, FORK_BUNDLE_MANIFEST_NAME)],
    );
  }
  validatePreparedPath({ stagedBundlePath: bundle.stagedBundlePath }, operation);
}

function validatePreparedPath(
  prepared: ForkPreparedBundleFile,
  operation: ForkStorageOperation,
): string {
  if (!isAbsolute(prepared.stagedBundlePath)) {
    throw new ForkOperationConflictError(
      "Frozen fork payload path must be absolute",
      "invalid_operation",
      [prepared.stagedBundlePath],
    );
  }
  const stagingDirectory = assertSafeStagingDirectory(operation.stagingDirectory);
  const stagedBundlePath = resolve(prepared.stagedBundlePath);
  const relativePath = relative(stagingDirectory, stagedBundlePath);
  if (
    !relativePath ||
    relativePath === FORK_BUNDLE_MANIFEST_NAME ||
    relativePath.startsWith(`..${parse(stagingDirectory).root === "/" ? "/" : "\\"}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    throw new ForkOperationConflictError(
      "Frozen fork payload must be an operation-scoped file inside its staging directory",
      "invalid_operation",
      [stagedBundlePath],
    );
  }
  return stagedBundlePath;
}

function parseCursor(value: unknown): ForkSourceCursor | undefined {
  if (
    !isRecord(value) ||
    typeof value["logId"] !== "string" ||
    !isNonNegativeInteger(value["seq"]) ||
    !isNonNegativeInteger(value["epoch"]) ||
    typeof value["eventId"] !== "string"
  ) {
    return undefined;
  }
  return {
    logId: value["logId"],
    seq: value["seq"],
    epoch: value["epoch"],
    eventId: value["eventId"],
  };
}

function sameCursor(left: ForkSourceCursor, right: ForkSourceCursor): boolean {
  return (
    left.logId === right.logId &&
    left.seq === right.seq &&
    left.epoch === right.epoch &&
    left.eventId === right.eventId
  );
}

function assertSafeStagingDirectory(path: string): string {
  if (!isAbsolute(path)) {
    throw new ForkOperationConflictError(
      "Fork staging directory must be absolute",
      "invalid_operation",
      [path],
    );
  }
  const normalized = resolve(path);
  if (normalized === parse(normalized).root) {
    throw new ForkOperationConflictError(
      "Filesystem root cannot be used as a fork staging directory",
      "invalid_operation",
      [normalized],
    );
  }
  return normalized;
}

async function readRegularFile(path: string): Promise<Buffer> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ForkOperationConflictError(
        "Frozen fork payload is not a regular file",
        "staging_corrupt",
        [path],
      );
    }
    return await readFile(path);
  } catch (error) {
    if (error instanceof ForkOperationConflictError) throw error;
    if (isNodeCode(error, "ENOENT")) {
      throw new ForkOperationConflictError("Frozen fork payload is missing", "staging_corrupt", [
        path,
      ]);
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return false;
    throw error;
  }
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertNonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}

function assertPositiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

function assertFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
