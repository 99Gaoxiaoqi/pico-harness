import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { readVersionedJson, writeJsonAtomic } from "./atomic-json.js";
import {
  StorageOperationJournal,
  type ForkStorageOperation,
  type NewStorageOperation,
  type StorageOperation,
} from "./operation-journal.js";

const FORK_BUNDLE_MANIFEST_VERSION = 1 as const;
const FORK_BUNDLE_MANIFEST_NAME = "fork-bundle.json";
const SHA256_DIGEST = /^[0-9a-f]{64}$/u;

export type NewForkStorageOperation = Extract<NewStorageOperation, { kind: "fork" }>;
export type ForkSourceCursor = ForkStorageOperation["sourceCursor"];

/**
 * Session adapter 从 JSONL meta 中提取的稳定身份。fork 必须指向创建操作
 * 记录的精确父游标，不能只用可变的 sourceSessionId 判断。
 */
export interface ForkTargetSessionIdentity {
  readonly sessionId: string;
  readonly logId: string;
  readonly forkedFrom: ForkSourceCursor;
}

export interface ForkPreparedSessionFile {
  /** 必须是 targetSessionPath 的同目录隐藏临时文件，以便最终 rename 原子发布。 */
  readonly stagedSessionPath: string;
  readonly targetSessionPath: string;
}

export interface ForkPreparedBundle {
  readonly operationId: string;
  readonly sourceCursor: ForkSourceCursor;
  readonly targetSessionId: string;
  readonly stagingDirectory: string;
  readonly stagedSessionPath: string;
  readonly targetSessionPath: string;
  readonly contentSha256: string;
  readonly sizeBytes: number;
  readonly targetIdentity: ForkTargetSessionIdentity;
}

export interface ForkOperationCallbacks {
  /** 返回当前 source durable head；仅 prepared 阶段检查，允许 fork 快照完成后源会话继续追加。 */
  readSourceCursor(operation: ForkStorageOperation): Promise<ForkSourceCursor | undefined>;
  /**
   * 生成完整目标 JSONL；必须以 operationId 幂等。可重复使用已生成的同内容
   * 临时文件，但不得提前创建 targetSessionPath。
   */
  prepareTargetBundle(
    operation: ForkStorageOperation,
    stagingDirectory: string,
  ): Promise<ForkPreparedSessionFile>;
  /** 只读解析 Session meta；无法验证时返回 undefined。 */
  inspectSessionFile(
    operation: ForkStorageOperation,
    path: string,
  ): Promise<ForkTargetSessionIdentity | undefined>;
  /** 克隆 File History / Summary / Artifact；必须以 operationId 幂等。 */
  cloneSidecars(operation: ForkStorageOperation, bundle: ForkPreparedBundle): Promise<void>;
  /** 发布可重建 Catalog 投影；必须以 operationId 幂等。 */
  publishCatalog(operation: ForkStorageOperation, bundle: ForkPreparedBundle): Promise<void>;
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
 * prepared -> 准备并校验隐藏 JSONL -> workspace_applied
 * workspace_applied -> 克隆 sidecars -> sidecars_committed
 * sidecars_committed -> rename 发布 JSONL -> Catalog -> completed
 *
 * Journal 总在外部副作用完成后才前进，因此所有写 callback 都必须把
 * operationId 当作幂等键。进程可在任意 callback 返回前后崩溃并继续收敛。
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
    if (operation.kind !== "fork") throw new Error(`Storage operation is not a fork: ${operationId}`);
    if (operation.state === "completed") {
      await this.cleanupStaging(operation);
      return operation;
    }
    return this.forward(operation);
  }

  private async forward(initial: ForkStorageOperation): Promise<ForkStorageOperation> {
    let operation = initial;
    try {
      if (operation.state === "prepared") {
        await this.assertSourceCursor(operation);
        await this.prepareBundle(operation);
        operation = await this.advance(operation, "workspace_applied");
      }

      if (operation.state === "workspace_applied") {
        const bundle = await this.loadAndVerifyStagedBundle(operation);
        await this.callbacks.cloneSidecars(operation, bundle);
        operation = await this.advance(operation, "sidecars_committed");
      }

      if (operation.state === "sidecars_committed") {
        const bundle = await this.loadBundleManifest(operation);
        await this.publishTarget(operation, bundle);
        await this.callbacks.publishCatalog(operation, bundle);
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

  private async assertSourceCursor(operation: ForkStorageOperation): Promise<void> {
    if (operation.sessionId !== operation.sourceSessionId) {
      throw new ForkOperationConflictError(
        "Fork operation sessionId must identify the source session",
        "invalid_operation",
      );
    }
    const actual = await this.callbacks.readSourceCursor(operation);
    if (!actual || !sameCursor(actual, operation.sourceCursor)) {
      throw new ForkOperationConflictError(
        `Source cursor changed before fork preparation (expected ${formatCursor(operation.sourceCursor)}, found ${formatCursor(actual)})`,
        "source_cursor_changed",
      );
    }
  }

  private async prepareBundle(operation: ForkStorageOperation): Promise<ForkPreparedBundle> {
    const stagingDirectory = assertSafeStagingDirectory(operation.stagingDirectory);
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });

    const existingManifest = await this.tryLoadBundleManifest(operation);
    if (existingManifest) {
      const verified = await this.verifyStagedBundle(operation, existingManifest);
      await this.assertNoConflictingTarget(operation, verified);
      return verified;
    }

    const prepared = await this.callbacks.prepareTargetBundle(operation, stagingDirectory);
    const paths = validatePreparedPaths(prepared, operation);
    const inspected = await this.callbacks.inspectSessionFile(operation, paths.stagedSessionPath);
    assertTargetIdentity(operation, inspected, paths.stagedSessionPath, "staging_corrupt");
    const contents = await readRegularFile(paths.stagedSessionPath, "staging_corrupt");
    const bundle = {
      operationId: operation.operationId,
      sourceCursor: structuredClone(operation.sourceCursor),
      targetSessionId: operation.targetSessionId,
      stagingDirectory,
      stagedSessionPath: paths.stagedSessionPath,
      targetSessionPath: paths.targetSessionPath,
      contentSha256: sha256(contents),
      sizeBytes: contents.byteLength,
      targetIdentity: structuredClone(inspected),
    } satisfies ForkPreparedBundle;
    await writeJsonAtomic(this.manifestPath(operation), {
      schemaVersion: FORK_BUNDLE_MANIFEST_VERSION,
      ...bundle,
    });
    await this.assertNoConflictingTarget(operation, bundle);
    return bundle;
  }

  private async loadAndVerifyStagedBundle(
    operation: ForkStorageOperation,
  ): Promise<ForkPreparedBundle> {
    const bundle = await this.loadBundleManifest(operation);
    return this.verifyStagedBundle(operation, bundle);
  }

  private async verifyStagedBundle(
    operation: ForkStorageOperation,
    bundle: ForkPreparedBundle,
  ): Promise<ForkPreparedBundle> {
    const contents = await readRegularFile(bundle.stagedSessionPath, "staging_corrupt");
    if (contents.byteLength !== bundle.sizeBytes || sha256(contents) !== bundle.contentSha256) {
      throw new ForkOperationConflictError(
        "Staged target session content no longer matches its durable bundle manifest",
        "staging_corrupt",
        [bundle.stagedSessionPath],
      );
    }
    const inspected = await this.callbacks.inspectSessionFile(operation, bundle.stagedSessionPath);
    assertTargetIdentity(operation, inspected, bundle.stagedSessionPath, "staging_corrupt");
    if (!sameTargetIdentity(inspected, bundle.targetIdentity)) {
      throw new ForkOperationConflictError(
        "Staged target session identity no longer matches its durable bundle manifest",
        "staging_corrupt",
        [bundle.stagedSessionPath],
      );
    }
    return bundle;
  }

  private async publishTarget(
    operation: ForkStorageOperation,
    bundle: ForkPreparedBundle,
  ): Promise<void> {
    if (await pathExists(bundle.targetSessionPath)) {
      await this.assertPublishedTarget(operation, bundle);
      return;
    }

    await this.verifyStagedBundle(operation, bundle);
    try {
      await rename(bundle.stagedSessionPath, bundle.targetSessionPath);
    } catch (error) {
      if (isNodeCode(error, "EXDEV")) {
        throw new ForkOperationConflictError(
          "Staged and target session files are not on the same filesystem",
          "invalid_operation",
          [bundle.stagedSessionPath, bundle.targetSessionPath],
        );
      }
      throw error;
    }
    await syncFileAndDirectory(bundle.targetSessionPath);
    await this.assertPublishedTarget(operation, bundle);
  }

  private async assertNoConflictingTarget(
    operation: ForkStorageOperation,
    bundle: ForkPreparedBundle,
  ): Promise<void> {
    if (await pathExists(bundle.targetSessionPath)) {
      await this.assertPublishedTarget(operation, bundle);
    }
  }

  private async assertPublishedTarget(
    operation: ForkStorageOperation,
    bundle: ForkPreparedBundle,
  ): Promise<void> {
    const contents = await readRegularFile(bundle.targetSessionPath, "target_conflict");
    const inspected = await this.callbacks.inspectSessionFile(operation, bundle.targetSessionPath);
    const matches =
      contents.byteLength === bundle.sizeBytes &&
      sha256(contents) === bundle.contentSha256 &&
      sameTargetIdentity(inspected, bundle.targetIdentity);
    if (!matches) {
      throw new ForkOperationConflictError(
        "Published target session conflicts with the prepared fork bundle",
        "target_conflict",
        [bundle.targetSessionPath],
      );
    }
    assertTargetIdentity(operation, inspected, bundle.targetSessionPath, "target_conflict");
  }

  private async tryLoadBundleManifest(
    operation: ForkStorageOperation,
  ): Promise<ForkPreparedBundle | undefined> {
    if (!(await pathExists(this.manifestPath(operation)))) return undefined;
    return this.loadBundleManifest(operation);
  }

  private async loadBundleManifest(operation: ForkStorageOperation): Promise<ForkPreparedBundle> {
    let bundle: ForkPreparedBundle;
    try {
      bundle = await readVersionedJson(this.manifestPath(operation), parseBundleManifest);
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) {
        throw new ForkOperationConflictError(
          "Fork bundle manifest is missing",
          "staging_corrupt",
          [this.manifestPath(operation)],
        );
      }
      if (error instanceof ForkOperationConflictError) throw error;
      throw new ForkOperationConflictError(
        `Fork bundle manifest cannot be decoded: ${errorMessage(error)}`,
        "staging_corrupt",
        [this.manifestPath(operation)],
      );
    }
    validateBundleForOperation(bundle, operation);
    return bundle;
  }

  private manifestPath(operation: ForkStorageOperation): string {
    return join(assertSafeStagingDirectory(operation.stagingDirectory), FORK_BUNDLE_MANIFEST_NAME);
  }

  private async cleanupStaging(operation: ForkStorageOperation): Promise<void> {
    const stagingDirectory = assertSafeStagingDirectory(operation.stagingDirectory);
    await rm(stagingDirectory, { recursive: true, force: true });
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
  const cursor = parseCursor(value["sourceCursor"]);
  const targetIdentity = parseTargetIdentity(value["targetIdentity"]);
  if (
    typeof value["operationId"] !== "string" ||
    !cursor ||
    typeof value["targetSessionId"] !== "string" ||
    typeof value["stagingDirectory"] !== "string" ||
    typeof value["stagedSessionPath"] !== "string" ||
    typeof value["targetSessionPath"] !== "string" ||
    typeof value["contentSha256"] !== "string" ||
    !SHA256_DIGEST.test(value["contentSha256"]) ||
    !isNonNegativeInteger(value["sizeBytes"]) ||
    !targetIdentity
  ) {
    throw new Error("Invalid fork bundle manifest");
  }
  return {
    operationId: value["operationId"],
    sourceCursor: cursor,
    targetSessionId: value["targetSessionId"],
    stagingDirectory: value["stagingDirectory"],
    stagedSessionPath: value["stagedSessionPath"],
    targetSessionPath: value["targetSessionPath"],
    contentSha256: value["contentSha256"],
    sizeBytes: value["sizeBytes"],
    targetIdentity,
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
  validatePreparedPaths(bundle, operation);
  if (!sameTargetIdentity(bundle.targetIdentity, expectedTargetIdentity(operation, bundle))) {
    throw new ForkOperationConflictError(
      "Fork bundle manifest contains an invalid target identity",
      "staging_corrupt",
      [bundle.stagedSessionPath],
    );
  }
}

function validatePreparedPaths(
  prepared: ForkPreparedSessionFile,
  operation: ForkStorageOperation,
): ForkPreparedSessionFile {
  if (!isAbsolute(prepared.stagedSessionPath) || !isAbsolute(prepared.targetSessionPath)) {
    throw new ForkOperationConflictError(
      "Fork Session paths must be absolute",
      "invalid_operation",
      [prepared.stagedSessionPath, prepared.targetSessionPath],
    );
  }
  const stagedSessionPath = resolve(prepared.stagedSessionPath);
  const targetSessionPath = resolve(prepared.targetSessionPath);
  if (
    stagedSessionPath === targetSessionPath ||
    dirname(stagedSessionPath) !== dirname(targetSessionPath) ||
    !basename(stagedSessionPath).startsWith(".")
  ) {
    throw new ForkOperationConflictError(
      "Staged JSONL must be a hidden sibling of the final target for atomic rename publication",
      "invalid_operation",
      [stagedSessionPath, targetSessionPath],
    );
  }
  if (!basename(stagedSessionPath).includes(operation.operationId)) {
    throw new ForkOperationConflictError(
      "Staged JSONL path must be scoped by operationId",
      "invalid_operation",
      [stagedSessionPath],
    );
  }
  return { stagedSessionPath, targetSessionPath };
}

function assertTargetIdentity(
  operation: ForkStorageOperation,
  identity: ForkTargetSessionIdentity | undefined,
  path: string,
  reason: "staging_corrupt" | "target_conflict",
): asserts identity is ForkTargetSessionIdentity {
  if (
    !identity ||
    identity.sessionId !== operation.targetSessionId ||
    identity.logId.length === 0 ||
    identity.logId === operation.sourceCursor.logId ||
    !sameCursor(identity.forkedFrom, operation.sourceCursor)
  ) {
    throw new ForkOperationConflictError(
      "Target Session identity or fork lineage does not match the operation",
      reason,
      [path],
    );
  }
}

function expectedTargetIdentity(
  operation: ForkStorageOperation,
  bundle: ForkPreparedBundle,
): ForkTargetSessionIdentity {
  return {
    sessionId: operation.targetSessionId,
    logId: bundle.targetIdentity.logId,
    forkedFrom: operation.sourceCursor,
  };
}

function parseTargetIdentity(value: unknown): ForkTargetSessionIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const cursor = parseCursor(value["forkedFrom"]);
  if (
    typeof value["sessionId"] !== "string" ||
    typeof value["logId"] !== "string" ||
    !cursor
  ) {
    return undefined;
  }
  return { sessionId: value["sessionId"], logId: value["logId"], forkedFrom: cursor };
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

function sameTargetIdentity(
  left: ForkTargetSessionIdentity | undefined,
  right: ForkTargetSessionIdentity,
): boolean {
  return (
    left !== undefined &&
    left.sessionId === right.sessionId &&
    left.logId === right.logId &&
    sameCursor(left.forkedFrom, right.forkedFrom)
  );
}

function sameCursor(left: ForkSourceCursor, right: ForkSourceCursor): boolean {
  return (
    left.logId === right.logId &&
    left.seq === right.seq &&
    left.epoch === right.epoch &&
    left.eventId === right.eventId
  );
}

function formatCursor(cursor: ForkSourceCursor | undefined): string {
  return cursor
    ? `${cursor.logId}:${cursor.epoch}:${cursor.seq}:${cursor.eventId}`
    : "missing";
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

async function readRegularFile(
  path: string,
  reason: "staging_corrupt" | "target_conflict",
): Promise<Buffer> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ForkOperationConflictError(
        "Fork Session path is not a regular file",
        reason,
        [path],
      );
    }
    return await readFile(path);
  } catch (error) {
    if (error instanceof ForkOperationConflictError) throw error;
    if (isNodeCode(error, "ENOENT")) {
      throw new ForkOperationConflictError("Fork Session file is missing", reason, [path]);
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

async function syncFileAndDirectory(path: string): Promise<void> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY);
    await file.sync();
  } finally {
    await file?.close().catch(() => undefined);
  }

  let directory: FileHandle | undefined;
  try {
    directory = await open(dirname(path), constants.O_RDONLY);
    await directory.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return (
    error instanceof Error &&
    new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(
      (error as NodeJS.ErrnoException).code ?? "",
    )
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
