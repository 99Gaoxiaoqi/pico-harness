import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readVersionedJson, writeJsonAtomic } from "./atomic-json.js";
import { LeaseConflictError, OwnerLease } from "./owner-lease.js";
import {
  isTerminalStorageOperation,
  StorageOperationJournal,
  type ForkStorageOperation,
  type NewStorageOperation,
  type StorageOperation,
} from "./operation-journal.js";

const FORK_BUNDLE_MANIFEST_VERSION = 2 as const;
const FORK_BUNDLE_MANIFEST_NAME = "fork-bundle.json";
const FORK_LEASE_RETRY_MS = 20;
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

export interface ForkOperationCallbacks {
  /** 返回已经冻结的不可变 fork payload；不得在此后重新读取 source。 */
  prepareTargetBundle(
    operation: ForkStorageOperation,
    stagingDirectory: string,
  ): Promise<ForkPreparedBundleFile>;
  /** 持有 target lease 后重查 Runtime 归属；必须在任何 sidecar 写入前完成。 */
  assertTargetAvailable(operation: ForkStorageOperation): Promise<void>;
  /** 克隆 File History / Summary / Artifact；必须以 operationId 幂等。 */
  cloneSidecars(operation: ForkStorageOperation, bundle: ForkPreparedBundle): Promise<void>;
  /** 向 RuntimeEventStore 发布消息、fork marker 与过滤后的 Session state。 */
  publishRuntime(operation: ForkStorageOperation, bundle: ForkPreparedBundle): Promise<void>;
}

export interface ForkOperationCoordinatorOptions {
  readonly journal: StorageOperationJournal;
  readonly callbacks: ForkOperationCallbacks;
}

export interface ForkReconciliationResult {
  readonly operationId: string;
  readonly state: ForkStorageOperation["state"];
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
  ) {
    super(message);
    this.name = "ForkOperationConflictError";
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

  constructor(options: ForkOperationCoordinatorOptions) {
    this.journal = options.journal;
    this.callbacks = options.callbacks;
  }

  async execute(input: NewForkStorageOperation): Promise<ForkStorageOperation> {
    const operation = await this.journal.create(input);
    if (operation.kind !== "fork") throw new Error("Expected fork operation");
    return this.forward(operation);
  }

  async reconcileUnfinished(): Promise<ForkReconciliationResult[]> {
    const results: ForkReconciliationResult[] = [];
    for (const operation of await this.journal.listUnfinished()) {
      if (operation.kind !== "fork") continue;
      const result = await this.forward(operation);
      results.push({ operationId: result.operationId, state: result.state });
    }
    return results;
  }

  /** 显式重放单个操作；已 completed 时仅补做 staging 清理。 */
  async reconcile(operationId: string): Promise<ForkStorageOperation> {
    const operation = await this.journal.get(operationId);
    if (!operation) throw new Error(`Storage operation not found: ${operationId}`);
    if (operation.kind !== "fork") {
      throw new Error(`Storage operation is not a fork: ${operationId}`);
    }
    if (operation.state === "completed") {
      await this.cleanupStaging(operation);
      return operation;
    }
    return this.forward(operation);
  }

  private async forward(initial: ForkStorageOperation): Promise<ForkStorageOperation> {
    for (;;) {
      const current = await this.reloadOperation(initial);
      if (isTerminalStorageOperation(current.state)) {
        if (current.state === "completed") await this.cleanupStaging(current);
        return current;
      }

      let lease: OwnerLease;
      try {
        lease = await OwnerLease.acquire({
          leaseDirectory: this.targetLeaseDirectory(current.targetSessionId),
          ownerId: `fork-operation:${current.operationId}`,
        });
      } catch (error) {
        if (!(error instanceof LeaseConflictError) || !error.owner) throw error;
        await delay(FORK_LEASE_RETRY_MS);
        continue;
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

  private async forwardOwned(
    initial: ForkStorageOperation,
    lease: OwnerLease,
  ): Promise<ForkStorageOperation> {
    let operation = initial;
    try {
      if (operation.state === "prepared") {
        this.assertOperation(operation);
        await lease.assertOwnership();
        await this.prepareBundle(operation);
        await lease.assertOwnership();
        operation = await this.advance(operation, "workspace_applied");
      }

      if (operation.state === "workspace_applied" || operation.state === "session_committed") {
        const bundle = await this.loadAndVerifyStagedBundle(operation);
        await lease.assertOwnership();
        await this.callbacks.assertTargetAvailable(operation);
        await lease.assertOwnership();
        await this.callbacks.cloneSidecars(operation, bundle);
        await lease.assertOwnership();
        operation = await this.advance(operation, "sidecars_committed");
      }

      if (operation.state === "sidecars_committed") {
        const bundle = await this.loadAndVerifyStagedBundle(operation);
        await lease.assertOwnership();
        await this.callbacks.publishRuntime(operation, bundle);
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

  private targetLeaseDirectory(targetSessionId: string): string {
    const targetDigest = createHash("sha256").update(targetSessionId).digest("hex");
    return join(this.journal.directory, ".fork-target-leases", targetDigest);
  }

  private assertOperation(operation: ForkStorageOperation): void {
    if (operation.sessionId !== operation.sourceSessionId) {
      throw new ForkOperationConflictError(
        "Fork operation sessionId must identify the source session",
        "invalid_operation",
      );
    }
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

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
