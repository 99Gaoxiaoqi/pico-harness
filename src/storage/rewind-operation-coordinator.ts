import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { FileHistoryBlobStore } from "./file-history-blob-store.js";
import { withFileHistoryMutationLease } from "./file-history-mutation-lease.js";
import {
  StorageOperationJournal,
  type NewStorageOperation,
  type RewindStorageOperation,
  type StorageOperation,
  type StoredFileState,
} from "./operation-journal.js";

export type NewRewindStorageOperation = Extract<NewStorageOperation, { kind: "rewind" }>;

export interface RewindWorkspaceTarget {
  rootId: string;
  relativePath: string;
  absolutePath: string;
  state: StoredFileState;
  contents?: Buffer;
}

export interface RewindOperationCallbacks {
  /** rootId 必须由当前已信任 workspace roots 解析，不能直接使用 journal 字符串。 */
  resolveRoot(rootId: string): string | undefined;
  /** 首次副作用前验证 Session/FileHistory 未偏移；已提交同 operationId 须幂等通过。 */
  validatePrecondition?(operation: RewindStorageOperation): Promise<void>;
  /** 必须幂等；协调器可在进程崩溃后重复调用。 */
  applyWorkspace(
    operation: RewindStorageOperation,
    targets: readonly RewindWorkspaceTarget[],
  ): Promise<void>;
  /** 以 operationId 作幂等键提交精确 Session rewind 事件。 */
  commitSession(operation: RewindStorageOperation): Promise<void>;
  /** 修剪 File History/Summary 并使派生投影失效；必须幂等。 */
  commitSidecars(operation: RewindStorageOperation): Promise<void>;
}

export interface RewindOperationCoordinatorOptions {
  journal: StorageOperationJournal;
  blobStore: FileHistoryBlobStore;
  callbacks: RewindOperationCallbacks;
}

export interface RewindReconciliationResult {
  operationId: string;
  state: RewindStorageOperation["state"];
}

export class RewindOperationConflictError extends Error {
  constructor(
    message: string,
    readonly conflictingPaths: string[],
  ) {
    super(message);
    this.name = "RewindOperationConflictError";
  }
}

/**
 * 把 workspace / Session / sidecar 三个独立事实源协调成可向前收敛的 rewind saga。
 * Journal 在每个外部副作用完成后才前进，因此 callbacks 必须以 operationId 幂等。
 */
export class RewindOperationCoordinator {
  private readonly journal: StorageOperationJournal;
  private readonly blobStore: FileHistoryBlobStore;
  private readonly callbacks: RewindOperationCallbacks;

  constructor(options: RewindOperationCoordinatorOptions) {
    this.journal = options.journal;
    this.blobStore = options.blobStore;
    this.callbacks = options.callbacks;
    this.journal.attachReferenceIndex(this.blobStore.rootDirectory);
  }

  async execute(input: NewRewindStorageOperation): Promise<RewindStorageOperation> {
    return this.executePrepared(async () => input);
  }

  /**
   * 供需要先把当前工作区内容写入 CAS 的调用方使用。prepare 与
   * operation journal 发布持有同一 mutation lease，随后释放租约再执行
   * Session/sidecar forward，避免 commitSidecars 内的 FileHistory save 嵌套取锁。
   */
  async executePrepared(
    prepare: () => Promise<NewRewindStorageOperation>,
  ): Promise<RewindStorageOperation> {
    const operation = await withFileHistoryMutationLease(
      this.blobStore.rootDirectory,
      `rewind-reference:${process.pid}`,
      async () => this.journal.create(await prepare()),
    );
    if (operation.kind !== "rewind") throw new Error("Expected rewind operation");
    return this.forward(operation);
  }

  /** 启动时只协调 rewind；fork 由独立发布协调器处理。 */
  async reconcileUnfinished(sessionId?: string): Promise<RewindReconciliationResult[]> {
    const results: RewindReconciliationResult[] = [];
    for (const operation of await this.journal.listUnfinished()) {
      if (operation.kind !== "rewind") continue;
      if (sessionId !== undefined && operation.sessionId !== sessionId) continue;
      const result = await this.forward(operation);
      results.push({ operationId: result.operationId, state: result.state });
    }
    return results;
  }

  private async forward(initial: RewindStorageOperation): Promise<RewindStorageOperation> {
    let operation = initial;
    try {
      if (operation.state === "prepared" || operation.state === "workspace_applied") {
        await this.callbacks.validatePrecondition?.(operation);
      }
      if (operation.state === "prepared") {
        if (operation.mode !== "conversation") {
          const preflight = await this.preflightWorkspace(operation);
          if (preflight.some((file) => file.current === "conflict")) {
            const conflicts = preflight
              .filter((file) => file.current === "conflict")
              .map((file) => file.target.absolutePath);
            throw new RewindOperationConflictError(
              "Workspace files no longer match the recorded rewind precondition",
              conflicts,
            );
          }
          if (preflight.some((file) => file.current !== "before")) {
            await this.callbacks.applyWorkspace(
              operation,
              preflight.map((file) => file.target),
            );
            const verified = await this.preflightWorkspace(operation);
            const conflicts = verified
              .filter((file) => file.current !== "before")
              .map((file) => file.target.absolutePath);
            if (conflicts.length > 0) {
              throw new RewindOperationConflictError(
                "Workspace callback did not converge to the recorded target state",
                conflicts,
              );
            }
          }
          operation = await this.advance(operation, "workspace_applied");
        }
      }

      // 若崩溃发生在 workspace_applied 之后，恢复时仍要先确认工作区保持
      // 已恢复状态；外部编辑不能被当成已完成的 Session rewind。
      if (operation.state === "workspace_applied" && operation.mode !== "conversation") {
        const verified = await this.preflightWorkspace(operation);
        const conflicts = verified
          .filter((file) => file.current !== "before")
          .map((file) => file.target.absolutePath);
        if (conflicts.length > 0) {
          throw new RewindOperationConflictError(
            "Workspace changed after the rewind workspace phase",
            conflicts,
          );
        }
      }

      if (operation.state === "prepared" || operation.state === "workspace_applied") {
        await this.callbacks.commitSession(operation);
        operation = await this.advance(operation, "session_committed");
      }
      if (operation.state === "session_committed") {
        await this.callbacks.commitSidecars(operation);
        operation = await this.advance(operation, "sidecars_committed");
      }
      if (operation.state === "sidecars_committed") {
        operation = await this.advance(operation, "completed");
      }
      return operation;
    } catch (error) {
      if (!(error instanceof RewindOperationConflictError)) throw error;
      return this.advance(operation, "needs_attention", {
        phase: operation.state,
        message: error.message,
        conflictingPaths: error.conflictingPaths,
      });
    }
  }

  private async preflightWorkspace(operation: RewindStorageOperation): Promise<
    Array<{
      target: RewindWorkspaceTarget;
      current: "before" | "after" | "conflict";
    }>
  > {
    const results: Array<{
      target: RewindWorkspaceTarget;
      current: "before" | "after" | "conflict";
    }> = [];

    // 先完整验证所有 blob，任何文件写入都必须在此循环结束之后发生。
    for (const file of operation.files) {
      await this.readStoredContents(file.before);
      await this.readStoredContents(file.after);
    }

    for (const file of operation.files) {
      const root = this.callbacks.resolveRoot(file.rootId);
      if (!root || !isAbsolute(root)) {
        throw new RewindOperationConflictError(`Unknown workspace root: ${file.rootId}`, [
          `${file.rootId}:${file.relativePath}`,
        ]);
      }
      const absolutePath = resolveWithinRoot(root, file.relativePath);
      const beforeContents = await this.readStoredContents(file.before);
      const target: RewindWorkspaceTarget = {
        rootId: file.rootId,
        relativePath: file.relativePath,
        absolutePath,
        state: file.before,
        ...(beforeContents ? { contents: beforeContents } : {}),
      };
      const current = await readCurrentState(absolutePath);
      results.push({
        target,
        current: matchesStoredState(current, file.before)
          ? "before"
          : matchesStoredState(current, file.after)
            ? "after"
            : "conflict",
      });
    }
    return results;
  }

  private async readStoredContents(state: StoredFileState): Promise<Buffer | undefined> {
    if (state.kind === "missing") return undefined;
    return this.blobStore.read({
      algorithm: "sha256",
      digest: state.blobSha256,
      sizeBytes: state.sizeBytes,
    });
  }

  private async advance(
    operation: RewindStorageOperation,
    nextState: RewindStorageOperation["state"],
    error?: { phase: string; message: string; conflictingPaths?: string[] },
  ): Promise<RewindStorageOperation> {
    const advanced: StorageOperation = await this.journal.advance({
      operationId: operation.operationId,
      expectedVersion: operation.version,
      nextState,
      ...(error ? { error } : {}),
    });
    if (advanced.kind !== "rewind") throw new Error("Rewind operation changed kind");
    return advanced;
  }
}

interface CurrentFileState {
  kind: "missing" | "file" | "other";
  digest?: string;
  sizeBytes?: number;
  mode?: number;
}

async function readCurrentState(path: string): Promise<CurrentFileState> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return { kind: "other" };
    const contents = await readFile(path);
    return {
      kind: "file",
      digest: createHash("sha256").update(contents).digest("hex"),
      sizeBytes: contents.byteLength,
      mode: metadata.mode & 0o777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

function matchesStoredState(current: CurrentFileState, expected: StoredFileState): boolean {
  if (expected.kind === "missing") return current.kind === "missing";
  return (
    current.kind === "file" &&
    current.digest === expected.blobSha256 &&
    current.sizeBytes === expected.sizeBytes &&
    current.mode === expected.mode
  );
}

function resolveWithinRoot(root: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new RewindOperationConflictError(`Invalid relative workspace path: ${relativePath}`, [
      relativePath,
    ]);
  }
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, ...relativePath.split("/"));
  const relativePathToRoot = relative(resolvedRoot, path);
  if (relativePathToRoot.startsWith("..") || isAbsolute(relativePathToRoot)) {
    throw new RewindOperationConflictError(`Workspace path escapes root: ${relativePath}`, [path]);
  }
  return path;
}
