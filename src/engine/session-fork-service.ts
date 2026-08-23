import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolvePicoHome, resolvePicoPaths, type PicoWorkspacePaths } from "../paths/pico-paths.js";
import { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import { sessionOwnerLeaseDirectory } from "../storage/session-owner-lease.js";
import {
  fileHistoryCloneSession,
  fileHistoryDefaultBaseDir,
  type FileHistoryIo,
} from "../safety/file-history.js";
import type { Message } from "../schema/message.js";
import { readVersionedJson, writeJsonAtomic } from "../storage/atomic-json.js";
import {
  ForkOperationCoordinator,
  ForkOperationConflictError,
  ForkOperationLeaseTimeoutError,
  type ForkAbortResult,
  type ForkOperationCallbacks,
  type ForkPreparedBundle,
  type ForkReconciliationOptions,
  type ForkReconciliationResult,
  type ForkRuntimePublicationCapability,
  type ForkSourceCursor,
} from "../storage/fork-operation-coordinator.js";
import {
  StorageOperationJournal,
  type ForkStorageOperation,
  type StorageOperation,
  type StorageOperationDispositionInput,
} from "../storage/operation-journal.js";
import type {
  PersistedInteractionMode,
  PersistedSessionSettings,
  PersistedSessionSettingsWrite,
  SessionRuntimeStatePatch,
  SessionRuntimeStateWritePatch,
} from "./session-runtime.js";
import { normalizeSessionRuntimeStatePatch } from "./session-runtime.js";
import {
  deriveDurableRuntimeForkCheckpoint,
  globalSessionManager,
  type DurableSessionForkSnapshot,
  type SessionManager,
} from "./session.js";
import type {
  SessionForkModelCheckpoint,
  SessionForkRuntimePort,
} from "./session-fork-runtime-port.js";
import { SessionForkRuntimeConflictError } from "./session-fork-runtime-port.js";
import {
  runtimeEventHasModelHistoryEntry,
  type RuntimeModelHistoryEvent,
} from "./runtime-model-message.js";
import {
  projectRuntimeSessionForkSeedEntries,
  type RuntimeSessionForkSeedEntry,
} from "./session-runtime-projection.js";
import {
  assertDurableTranscriptEvent,
  projectTranscriptEvents,
  type DurableTranscriptEvent,
} from "../presentation/transcript-event-store.js";
import { decodeRuntimeEvent } from "../storage/runtime-event.js";
import type { RuntimePlanEvent } from "./session-runtime-event.js";
import { planOperationFingerprint, PlanConflictError } from "../plan/contract.js";
import { projectActivePlanEntries, projectPlanEntries, reducePlanEvent } from "../plan/reducer.js";

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/u;
const FROZEN_FORK_BUNDLE_VERSION = 7 as const;
const FROZEN_FORK_BUNDLE_NAME = "runtime-fork.json";
const FORK_SIDECARS_VERSION = 2 as const;
const FORK_SIDECARS_NAME = "fork-sidecars.json";

export interface SessionForkServiceHooks {
  /** 故障注入：sidecar 结果已可重放、Runtime 发布前。 */
  readonly afterSidecars?: (operation: ForkStorageOperation) => void | Promise<void>;
  /** 故障注入：Runtime fork bootstrap 写入前。 */
  readonly beforeRuntimeBootstrap?: (operation: ForkStorageOperation) => void | Promise<void>;
}

export interface SessionForkServiceOptions {
  readonly workDir: string;
  readonly picoHome?: string;
  readonly sessionManager?: SessionManager;
  readonly journal?: StorageOperationJournal;
  readonly runtimeStore?: SqliteRuntimeEventStore;
  readonly fileHistoryBaseDir?: string;
  readonly hooks?: SessionForkServiceHooks;
  readonly createOperationId?: () => string;
  /** Runtime-owned fork lifecycle; keeps the coordinator independent of RuntimeRun. */
  readonly runtimePort: SessionForkRuntimePort;
}

export interface ForkSessionInput {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  /** fork 不继承 source 权限 mode，由当前产品启动默认值决定。 */
  readonly targetMode: PersistedInteractionMode;
  /**
   * Non-destructive rewind: 仅截取到 source 中该 RuntimeEvent 为止（含）
   * 的条目作为 fork 边界。省略时与原行为一致——从 source 当前 head fork。
   * 用于把 rewind checkpoint 表达为对历史切片的 fork。
   */
  readonly throughEventId?: string;
}

export interface ForkSessionResult {
  readonly operation: ForkStorageOperation;
  readonly sourceTitle?: string;
  readonly targetTitle?: string;
}

export interface ForkOperationDispositionResult {
  readonly operation: ForkStorageOperation;
  readonly reconciliation?: ForkReconciliationResult;
  readonly stagingCleanup?: ForkAbortResult["stagingCleanup"];
  readonly cleanupDiagnostic?: string;
}

export class SessionForkNeedsAttentionError extends Error {
  constructor(readonly operation: ForkStorageOperation) {
    super(
      "Fork " +
        operation.operationId +
        " 需要人工处理: " +
        (operation.error?.message ?? operation.state),
    );
    this.name = "SessionForkNeedsAttentionError";
  }
}

interface FrozenForkBundle {
  readonly schemaVersion: typeof FROZEN_FORK_BUNDLE_VERSION;
  readonly operationId: string;
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly sourceCursor: ForkSourceCursor;
  readonly seedEntries: readonly RuntimeSessionForkSeedEntry[];
  readonly planEntries: readonly { readonly sequence: number; readonly event: RuntimePlanEvent }[];
  readonly modelCheckpoint?: SessionForkModelCheckpoint;
  readonly sourceTitle?: string;
  readonly settings?: PersistedSessionSettings;
  readonly goal?: NonNullable<SessionRuntimeStatePatch["goal"]>;
}

interface ForkSidecarsBundle {
  readonly schemaVersion: typeof FORK_SIDECARS_VERSION;
  readonly operationId: string;
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
}

/** Runtime facts 与 operation journal 共同构成发布边界；staging 只保存崩溃恢复输入。 */
export class SessionForkService {
  readonly workDir: string;
  readonly journal: StorageOperationJournal;
  private readonly picoHome: string;
  private readonly workspacePaths: PicoWorkspacePaths;
  private readonly sessionManager: SessionManager;
  private readonly runtimeStore: SqliteRuntimeEventStore;
  private readonly ownsRuntimeStore: boolean;
  private readonly fileHistoryIo: FileHistoryIo;
  private readonly hooks?: SessionForkServiceHooks;
  private readonly createOperationId: () => string;
  private readonly runtimePort: SessionForkRuntimePort;
  private readonly coordinator: ForkOperationCoordinator;

  constructor(options: SessionForkServiceOptions) {
    this.workDir = resolve(options.workDir);
    this.picoHome = resolvePicoHome({ picoHome: options.picoHome });
    const paths = resolvePicoPaths(this.workDir, { picoHome: this.picoHome });
    this.workspacePaths = paths.workspace;
    this.sessionManager = options.sessionManager ?? globalSessionManager;
    this.journal =
      options.journal ??
      new StorageOperationJournal({ workDir: this.workDir, picoHome: this.picoHome });
    this.runtimeStore =
      options.runtimeStore ??
      new SqliteRuntimeEventStore({ storageRoot: this.workspacePaths.root });
    this.ownsRuntimeStore = options.runtimeStore === undefined;
    this.fileHistoryIo = {
      baseDir:
        options.fileHistoryBaseDir ??
        (options.picoHome ? paths.home.fileHistory : fileHistoryDefaultBaseDir()),
      // manifest 行与 RuntimeEvent/journal 同库(票 08 方案 a)。
      storageRoot: this.workspacePaths.root,
    };
    this.hooks = options.hooks;
    this.createOperationId = options.createOperationId ?? randomUUID;
    this.runtimePort = options.runtimePort;
    this.coordinator = new ForkOperationCoordinator({
      journal: this.journal,
      targetLeaseDirectory: (sessionId) =>
        sessionOwnerLeaseDirectory(this.workspacePaths, sessionId),
      callbacks: this.createCallbacks(),
    });
  }

  /**
   * 归还自建的 runtime store lease(SQLite 纪元:连接句柄随 lease 存活,
   * 短生命周期调用方——如启动期 fork 恢复——必须显式关闭;注入的 store
   * 归调用方所有,不在此释放)。
   */
  close(): void {
    if (this.ownsRuntimeStore) this.runtimeStore.close();
  }

  async fork(input: ForkSessionInput): Promise<ForkSessionResult> {
    assertSafeSessionId(input.sourceSessionId);
    assertSafeSessionId(input.targetSessionId);
    if (input.sourceSessionId === input.targetSessionId) {
      throw new Error("Fork source 与 target sessionId 不能相同");
    }
    const source = await this.sessionManager.getOrCreate(input.sourceSessionId, this.workDir, {
      persistence: true,
      picoHome: this.picoHome,
      runtimePort: this.runtimePort.engineRuntimePort,
    });
    const sourceRuntimeStore = source.runtimeEventStore;
    if (!sourceRuntimeStore) {
      throw new Error(`Fork requires a durable source Session: ${input.sourceSessionId}`);
    }
    if (resolve(sourceRuntimeStore.storageRoot) !== resolve(this.runtimeStore.storageRoot)) {
      throw new Error(
        `Fork Runtime store does not match source Session store: ${input.sourceSessionId}`,
      );
    }
    // withSerializedExecution 而非裸 serialize：daemon 侧 rewind.apply 在
    // withSession 的 serialize task 内调用本方法（forkFromCheckpoint → fork），
    // 裸 serialize 会触发 ALS 重入守卫直接抛错；外部调用者（in-process repl）
    // 不在 serialize 内时行为不变（排队执行）。
    return source.withSerializedExecution(async () => {
      await assertTargetNotPublished(this.runtimeStore, input.targetSessionId);
      const runtimeCapability = source.runtimeEventCapability;
      if (!runtimeCapability) {
        throw new Error(`Fork requires a durable source Session: ${source.id}`);
      }
      await this.runtimePort.reconcileIncompleteRuns({
        capability: runtimeCapability,
      });
      await this.runtimePort.repairSessionProjection(source, {
        capability: runtimeCapability,
      });
      this.runtimePort.validateModelHistory(await sourceRuntimeStore.readSession(source.id));
      const snapshot = input.throughEventId
        ? await source.readDurableForkSnapshotAt(input.throughEventId)
        : await source.readDurableForkSnapshot();
      const operationId = this.createOperationId();
      const stagingDirectory = join(this.workspacePaths.forkStaging, operationId);
      const frozen = createFrozenForkBundle(operationId, input, snapshot);

      // 必须先冻结 payload 再创建 journal。这样 journal 一旦可见，reconcile
      // 就永远不需要从已经继续推进的 source 重建消息。
      await writeJsonAtomic(this.frozenBundlePath(stagingDirectory), frozen);
      const operation = await this.coordinator.execute({
        kind: "fork",
        operationId,
        sessionId: input.sourceSessionId,
        sourceSessionId: input.sourceSessionId,
        sourceCursor: snapshot.cursor,
        targetSessionId: input.targetSessionId,
        targetMode: input.targetMode,
        stagingDirectory,
      });
      if (operation.state === "needs_attention") {
        throw new SessionForkNeedsAttentionError(operation);
      }
      return {
        operation,
        ...(frozen.sourceTitle
          ? {
              sourceTitle: frozen.sourceTitle,
              targetTitle: forkTitleFrom(frozen.sourceTitle),
            }
          : {}),
      };
    });
  }

  async reconcileUnfinished(
    options: ForkReconciliationOptions = {},
  ): Promise<ForkReconciliationResult[]> {
    return this.coordinator.reconcileUnfinished(options);
  }

  async listNeedsAttention(): Promise<StorageOperation[]> {
    return this.journal.listNeedsAttention();
  }

  async getOperation(operationId: string): Promise<StorageOperation | undefined> {
    return this.journal.get(operationId);
  }

  async retryNeedsAttention(
    input: StorageOperationDispositionInput,
    options: ForkReconciliationOptions = {},
  ): Promise<ForkOperationDispositionResult> {
    try {
      const operation = await this.coordinator.retryNeedsAttention(input, options);
      return {
        operation,
        reconciliation: { operationId: operation.operationId, state: operation.state },
      };
    } catch (error) {
      if (!(error instanceof ForkOperationLeaseTimeoutError)) throw error;
      const operation = await this.requireForkOperation(input.operationId);
      return {
        operation,
        reconciliation: {
          operationId: operation.operationId,
          state: operation.state,
          status: "lease_timeout",
          diagnostic: error.diagnostic,
        },
      };
    }
  }

  async abortNeedsAttention(
    input: StorageOperationDispositionInput,
  ): Promise<ForkOperationDispositionResult> {
    const result = await this.coordinator.abortNeedsAttention(input);
    return {
      operation: result.operation,
      stagingCleanup: result.stagingCleanup,
      ...(result.cleanupDiagnostic ? { cleanupDiagnostic: result.cleanupDiagnostic } : {}),
    };
  }

  private createCallbacks(): ForkOperationCallbacks {
    return {
      prepareTargetBundle: async (operation, stagingDirectory) => {
        const stagedBundlePath = this.frozenBundlePath(stagingDirectory);
        await this.readFrozenBundle(operation, stagedBundlePath);
        return { stagedBundlePath };
      },
      assertTargetAvailable: async (operation) => {
        if (await this.runtimeStore.readSessionManifest(operation.targetSessionId)) {
          throw new ForkOperationConflictError(
            `Fork target Runtime is already occupied: ${operation.targetSessionId}`,
            "target_conflict",
          );
        }
      },
      assertRuntimeTargetOwned: async (operation, bundle) => {
        await this.assertRuntimeTargetOwned(operation, bundle);
      },
      cloneSidecars: async (operation) => {
        await this.ensureSidecars(operation);
        await this.hooks?.afterSidecars?.(operation);
      },
      publishRuntime: async (operation, bundle, publication) =>
        this.publishRuntime(operation, bundle, publication),
    };
  }

  private async ensureSidecars(operation: ForkStorageOperation): Promise<ForkSidecarsBundle> {
    const existing = await this.tryReadSidecars(operation);
    if (existing) return existing;

    try {
      await fileHistoryCloneSession(
        operation.sourceSessionId,
        operation.targetSessionId,
        this.fileHistoryIo,
      );
    } catch (error) {
      throw new ForkOperationConflictError(
        `Fork sidecar 快照无法完整冻结: ${errorMessage(error)}`,
        "staging_corrupt",
      );
    }

    const sidecars = {
      schemaVersion: FORK_SIDECARS_VERSION,
      operationId: operation.operationId,
      sourceSessionId: operation.sourceSessionId,
      targetSessionId: operation.targetSessionId,
    } satisfies ForkSidecarsBundle;
    await writeJsonAtomic(this.sidecarsPath(operation), sidecars);
    return sidecars;
  }

  private async publishRuntime(
    operation: ForkStorageOperation,
    prepared: ForkPreparedBundle,
    publication: ForkRuntimePublicationCapability,
  ): Promise<void> {
    const { frozen, seedEntries, modelCheckpoint } = await this.readRuntimePublication(
      operation,
      prepared,
    );
    const sourceThroughEventId = await resolveFrozenSourceThroughEventId(this.runtimeStore, frozen);

    await this.hooks?.beforeRuntimeBootstrap?.(operation);
    try {
      const runtimePatch = filteredRuntimePatch(
        frozen,
        operation.targetMode ?? "yolo",
        operation.createdAt,
      );
      const workflowEvents = this.buildForkWorkflowEntries(
        operation,
        frozen,
        seedEntries,
        modelCheckpoint,
        sourceThroughEventId,
        runtimePatch,
      );
      await this.runtimePort.bootstrapFork({
        sourceSessionId: operation.sourceSessionId,
        targetSessionId: operation.targetSessionId,
        operationId: operation.operationId,
        operationCreatedAt: operation.createdAt,
        seedEntries,
        ...(modelCheckpoint ? { modelCheckpoint } : {}),
        ...(sourceThroughEventId ? { sourceThroughEventId } : {}),
        workDir: this.workDir,
        runtimeAuthority: this.runtimeStore,
        publication,
        ...(workflowEvents.length > 0 ? { workflowEvents } : {}),
        ...(runtimePatch
          ? {
              statePublication: {
                patch: runtimePatch,
                eventId: runtimeStateEventId(operation.operationId),
                at: operation.createdAt,
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof ForkOperationConflictError) throw error;
      if (error instanceof SessionForkRuntimeConflictError) {
        throw new ForkOperationConflictError(error.message, error.reason, [], { cause: error });
      }
      await this.assertRuntimeTargetOwned(operation, prepared);
      throw error;
    }
  }

  private buildForkWorkflowEntries(
    operation: ForkStorageOperation,
    frozen: FrozenForkBundle,
    seedEntries: readonly RuntimeSessionForkSeedEntry[],
    modelCheckpoint: SessionForkModelCheckpoint | undefined,
    sourceThroughEventId: string | undefined,
    runtimePatch: SessionRuntimeStateWritePatch | undefined,
  ): readonly RuntimePlanEvent[] {
    if (frozen.planEntries.length === 0) return [];
    const statePublication = runtimePatch
      ? {
          patch: runtimePatch,
          eventId: runtimeStateEventId(operation.operationId),
          at: operation.createdAt,
        }
      : undefined;
    const runId = this.runtimePort.deriveBootstrapRunId({
      sourceSessionId: operation.sourceSessionId,
      targetSessionId: operation.targetSessionId,
      operationId: operation.operationId,
      operationCreatedAt: operation.createdAt,
      seedEntries,
      ...(modelCheckpoint ? { modelCheckpoint } : {}),
      ...(sourceThroughEventId ? { sourceThroughEventId } : {}),
      ...(statePublication ? { statePublication } : {}),
      workDir: this.workDir,
      runtimeAuthority: this.runtimeStore,
    });
    const workflowEntries = [...frozen.planEntries].sort(
      (left, right) => left.sequence - right.sequence,
    );
    const rewritten: RuntimePlanEvent[] = workflowEntries.map(({ event }, index) => {
      const operationId = `fork:${operation.operationId}:workflow:${index}`;
      return {
        ...structuredClone(event),
        eventId: operationId,
        sessionId: operation.targetSessionId,
        invocationId: `fork:${operation.operationId}:invocation`,
        runId,
        turnId: `turn:${runId}:input`,
        at: operation.createdAt,
        data: {
          ...structuredClone(event.data),
          operationId,
          fingerprint: planOperationFingerprint(`fork.${event.kind}`, event.data),
        },
      } as RuntimePlanEvent;
    });
    const inherited = projectPlanEntries(
      operation.targetSessionId,
      rewritten.map((event, index) => ({ sequence: index + 1, event })),
    );
    if (inherited.execution?.status === "active") {
      // Recover inherited in_progress steps — they belong to the source session's runs,
      // not the fork. Without this, orphan detection fails (fork doesn't copy run.terminal).
      for (const step of inherited.execution.steps) {
        if (step.status !== "in_progress") continue;
        const recoverOpId = `fork:${operation.operationId}:recover:${step.id}`;
        rewritten.push({
          ...structuredClone(rewritten.at(-1)!),
          eventId: recoverOpId,
          kind: "plan.step.recovered",
          data: {
            operationId: recoverOpId,
            fingerprint: planOperationFingerprint(`fork.plan.step.recovered`, {
              planId: inherited.execution.planId,
              stepId: step.id,
            }),
            planId: inherited.execution.planId,
            stepId: step.id,
            note: "fork: inherited in_progress step reset to pending",
          },
        } as RuntimePlanEvent);
      }
      const operationId = `fork:${operation.operationId}:plan:interrupted`;
      rewritten.push({
        ...rewritten.at(-1)!,
        eventId: operationId,
        kind: "plan.execution.interrupted",
        data: {
          operationId,
          fingerprint: planOperationFingerprint("fork.plan.execution.interrupted", {
            planId: inherited.execution.planId,
          }),
          planId: inherited.execution.planId,
          reason: "forked active execution requires explicit resume",
        },
      } as RuntimePlanEvent);
    }
    // 落账前用 reducer 预校验（与 PlanCoordinator.commit 一致）。fork 语料
    // 自守：上方守卫（execution active + step in_progress）与 reducePlanEvent
    // 对 recovered/interrupted 的前置条件一一对应，正常路径必然通过；此校验
    // 是防御性兜底——若源语料出现未预期的异常态，宁可在此失败转
    // needs_attention，也不向目标账本写入不变量被破坏的 plan 事实。
    try {
      let candidate = projectPlanEntries(operation.targetSessionId, []);
      for (const event of rewritten) candidate = reducePlanEvent(candidate, event);
    } catch (error) {
      if (error instanceof PlanConflictError) {
        throw new ForkOperationConflictError(
          `Fork plan workflow violates reducer invariants: ${error.message}`,
          "staging_corrupt",
          [],
          { cause: error },
        );
      }
      throw error;
    }
    return rewritten;
  }

  private async assertRuntimeTargetOwned(
    operation: ForkStorageOperation,
    prepared: ForkPreparedBundle,
  ): Promise<void> {
    if (!(await this.runtimeStore.readSessionManifest(operation.targetSessionId))) return;
    const events = await this.runtimeStore.readSession(operation.targetSessionId);
    if (events.length === 0) return;
    const { frozen, seedEntries, modelCheckpoint } = await this.readRuntimePublication(
      operation,
      prepared,
    );
    const runtimePatch = filteredRuntimePatch(
      frozen,
      operation.targetMode ?? "yolo",
      operation.createdAt,
    );
    const expectedRunId = this.runtimePort.deriveBootstrapRunId({
      sourceSessionId: operation.sourceSessionId,
      targetSessionId: operation.targetSessionId,
      operationId: operation.operationId,
      operationCreatedAt: operation.createdAt,
      seedEntries,
      ...(modelCheckpoint ? { modelCheckpoint } : {}),
      ...(runtimePatch
        ? {
            statePublication: {
              patch: runtimePatch,
              eventId: runtimeStateEventId(operation.operationId),
              at: operation.createdAt,
            },
          }
        : {}),
      workDir: this.workDir,
      runtimeAuthority: this.runtimeStore,
    });
    const ownsRuntime = events.every(
      (event) =>
        event.runId === expectedRunId ||
        (event.kind === "session.state.committed" &&
          event.eventId === runtimeStateEventId(operation.operationId)),
    );
    if (ownsRuntime) return;
    throw new ForkOperationConflictError(
      `Fork target Runtime belongs to another operation: ${operation.targetSessionId}`,
      "target_conflict",
    );
  }

  private async readRuntimePublication(
    operation: ForkStorageOperation,
    prepared: ForkPreparedBundle,
  ): Promise<{
    readonly frozen: FrozenForkBundle;
    readonly seedEntries: readonly RuntimeSessionForkSeedEntry[];
    readonly modelCheckpoint?: SessionForkModelCheckpoint;
  }> {
    const frozen = await this.readFrozenBundle(operation, prepared.stagedBundlePath);
    await this.readSidecars(operation);
    const seedEntries = structuredClone(frozen.seedEntries);
    const summary = frozen.modelCheckpoint
      ? structuredClone(frozen.modelCheckpoint.summary)
      : undefined;
    return {
      frozen,
      seedEntries,
      ...(frozen.modelCheckpoint && summary
        ? {
            modelCheckpoint: {
              coveredMessageCount: frozen.modelCheckpoint.coveredMessageCount,
              summary,
            },
          }
        : {}),
    };
  }

  private async readFrozenBundle(
    operation: ForkStorageOperation,
    path: string,
  ): Promise<FrozenForkBundle> {
    try {
      const frozen = await readVersionedJson(path, parseFrozenForkBundle);
      validateFrozenBundleForOperation(frozen, operation, path);
      return frozen;
    } catch (error) {
      if (error instanceof ForkOperationConflictError) throw error;
      throw new ForkOperationConflictError(
        `Frozen Runtime fork bundle cannot be decoded: ${errorMessage(error)}`,
        "staging_corrupt",
        [path],
      );
    }
  }

  private async tryReadSidecars(
    operation: ForkStorageOperation,
  ): Promise<ForkSidecarsBundle | undefined> {
    const path = this.sidecarsPath(operation);
    try {
      const sidecars = await readVersionedJson(path, parseForkSidecarsBundle);
      validateSidecarsForOperation(sidecars, operation, path);
      return sidecars;
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) return undefined;
      if (error instanceof ForkOperationConflictError) throw error;
      throw new ForkOperationConflictError(
        `Fork sidecar result cannot be decoded: ${errorMessage(error)}`,
        "staging_corrupt",
        [path],
      );
    }
  }

  private async readSidecars(operation: ForkStorageOperation): Promise<ForkSidecarsBundle> {
    const sidecars = await this.tryReadSidecars(operation);
    if (sidecars) return sidecars;
    throw new ForkOperationConflictError("Fork sidecar result is missing", "staging_corrupt", [
      this.sidecarsPath(operation),
    ]);
  }

  private frozenBundlePath(stagingDirectory: string): string {
    return join(stagingDirectory, FROZEN_FORK_BUNDLE_NAME);
  }

  private sidecarsPath(operation: ForkStorageOperation): string {
    return join(operation.stagingDirectory, FORK_SIDECARS_NAME);
  }

  private async requireForkOperation(operationId: string): Promise<ForkStorageOperation> {
    const operation = await this.journal.get(operationId);
    if (!operation) throw new Error(`Storage operation not found: ${operationId}`);
    if (operation.kind !== "fork") {
      throw new Error(`Storage operation is not a fork: ${operationId}`);
    }
    return operation;
  }
}

export async function reconcileUnfinishedSessionForks(
  workDir: string,
  options: ForkReconciliationOptions & {
    readonly picoHome?: string;
    readonly runtimePort: SessionForkRuntimePort;
  },
): Promise<ForkReconciliationResult[]> {
  const { picoHome, ...reconciliation } = options;
  const service = new SessionForkService({
    workDir,
    picoHome,
    runtimePort: options.runtimePort,
  });
  try {
    return await service.reconcileUnfinished(reconciliation);
  } finally {
    service.close();
  }
}

export async function reconcileUnfinishedSessionForksOrThrow(
  workDir: string,
  options: ForkReconciliationOptions & {
    readonly picoHome?: string;
    readonly runtimePort: SessionForkRuntimePort;
  },
): Promise<void> {
  const results = await reconcileUnfinishedSessionForks(workDir, options);
  const blocked = results.filter(
    (result) =>
      result.state === "needs_attention" ||
      ("status" in result && result.status === "lease_timeout"),
  );
  if (blocked.length === 0) return;
  throw new Error(
    `未完成的 fork 恢复需要人工处理: ${blocked.map((result) => result.operationId).join(", ")}`,
  );
}

function createFrozenForkBundle(
  operationId: string,
  input: ForkSessionInput,
  snapshot: DurableSessionForkSnapshot,
): FrozenForkBundle {
  const sourceTitle = sourceDisplayTitle(snapshot);
  return {
    schemaVersion: FROZEN_FORK_BUNDLE_VERSION,
    operationId,
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.targetSessionId,
    sourceCursor: structuredClone(snapshot.cursor),
    seedEntries: snapshot.runtimeSeedEntries.map(stripForkSeedUsage),
    planEntries: structuredClone(snapshot.planEntries),
    ...(snapshot.modelCheckpoint
      ? {
          modelCheckpoint: {
            coveredMessageCount: snapshot.modelCheckpoint.coveredMessageCount,
            summary: stripMessageUsage(snapshot.modelCheckpoint.summary),
          },
        }
      : {}),
    ...(sourceTitle ? { sourceTitle } : {}),
    ...(snapshot.hydration.runtime.settings
      ? { settings: structuredClone(snapshot.hydration.runtime.settings) }
      : {}),
    ...(snapshot.hydration.runtime.goal
      ? { goal: structuredClone(snapshot.hydration.runtime.goal) }
      : {}),
  };
}

function filteredRuntimePatch(
  frozen: FrozenForkBundle,
  targetMode: PersistedInteractionMode,
  forkCreatedAt: string,
): SessionRuntimeStateWritePatch | undefined {
  const settings = frozen.settings
    ? filterForkSettings(frozen.settings, frozen.sourceSessionId, targetMode, frozen.sourceTitle)
    : undefined;
  return settings || frozen.goal
    ? {
        ...(settings ? { settings } : {}),
        ...(frozen.goal ? { goal: resetForkGoalUsage(frozen.goal, forkCreatedAt) } : {}),
      }
    : undefined;
}

/** A fork retains the task definition but begins a new independent budget window. */
function resetForkGoalUsage(
  source: NonNullable<SessionRuntimeStatePatch["goal"]>,
  forkCreatedAt: string,
): NonNullable<SessionRuntimeStatePatch["goal"]> {
  const startedAt = parseForkCreatedAt(forkCreatedAt);
  return {
    ...structuredClone(source),
    goals: source.goals.map((goal) => ({
      ...structuredClone(goal),
      budgetUsage: { turns: 0, tokens: 0, costCNY: 0, startedAt },
    })),
  };
}

function filterForkSettings(
  settings: PersistedSessionSettings,
  sourceSessionId: string,
  targetMode: PersistedInteractionMode,
  sourceTitle: string | undefined,
): PersistedSessionSettingsWrite {
  return {
    ...(sourceTitle ? { title: forkTitleFrom(sourceTitle) } : {}),
    forkFrom: sourceSessionId,
    ...(settings.sideConversation === true ? { sideConversation: true } : {}),
    provider: settings.provider,
    model: settings.model,
    modelRouteId: settings.modelRouteId,
    collaborationMode: targetMode === "plan" ? "plan" : "agent",
    orchestrationMode: settings.orchestrationMode ?? "default",
    permissionMode: targetMode === "plan" ? "yolo" : targetMode,
    thinkingEffort: settings.thinkingEffort,
    thinkingEffortExplicit: settings.thinkingEffortExplicit,
    additionalDirectories: [],
  };
}

function stripMessageUsage(message: Message): Message {
  const { usage: _usage, ...copy } = structuredClone(message);
  return copy;
}

function stripRuntimeHistoryUsage(event: RuntimeModelHistoryEvent): RuntimeModelHistoryEvent {
  const copy = structuredClone(event);
  return copy.kind === "message.committed"
    ? {
        ...copy,
        data: { message: stripMessageUsage(copy.data.message) },
      }
    : copy;
}

function stripForkSeedUsage(entry: RuntimeSessionForkSeedEntry): RuntimeSessionForkSeedEntry {
  return entry.kind === "model"
    ? {
        kind: "model",
        sourceSequence: entry.sourceSequence,
        event: stripRuntimeHistoryUsage(entry.event),
      }
    : structuredClone(entry);
}

function parseFrozenForkBundle(value: unknown): FrozenForkBundle {
  if (
    isRecord(value) &&
    (value["schemaVersion"] === 1 ||
      value["schemaVersion"] === 2 ||
      value["schemaVersion"] === 3 ||
      value["schemaVersion"] === 4 ||
      value["schemaVersion"] === 5 ||
      value["schemaVersion"] === 6)
  ) {
    throw new Error(
      `Frozen Runtime fork bundle v${String(value["schemaVersion"])} is no longer supported; recreate the fork from canonical Runtime facts`,
    );
  }
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== FROZEN_FORK_BUNDLE_VERSION ||
    typeof value["operationId"] !== "string" ||
    typeof value["sourceSessionId"] !== "string" ||
    typeof value["targetSessionId"] !== "string" ||
    !isForkSourceCursor(value["sourceCursor"]) ||
    Object.hasOwn(value, "messages") ||
    Object.hasOwn(value, "historyEntries") ||
    !isSessionForkModelCheckpoint(value["modelCheckpoint"]) ||
    !Array.isArray(value["seedEntries"]) ||
    !Array.isArray(value["planEntries"]) ||
    (value["sourceTitle"] !== undefined && typeof value["sourceTitle"] !== "string")
  ) {
    throw new Error("Invalid frozen Runtime fork bundle");
  }
  assertExactKeys(value, [
    "schemaVersion",
    "operationId",
    "sourceSessionId",
    "targetSessionId",
    "sourceCursor",
    "seedEntries",
    "planEntries",
    "modelCheckpoint",
    "sourceTitle",
    "settings",
    "goal",
  ]);
  const seedEntries = parseFrozenRuntimeSeedEntries(value["seedEntries"]);
  const planEntries = parseFrozenPlanEntries(value["planEntries"], value["sourceSessionId"]);
  if (
    seedEntries.some(
      (entry) => entry.kind === "model" && entry.event.sessionId !== value["sourceSessionId"],
    )
  ) {
    throw new Error("Frozen Runtime v5 model seed belongs to another Session");
  }
  const modelCheckpoint = value["modelCheckpoint"];
  const modelEntryCount = seedEntries.filter((entry) => entry.kind === "model").length;
  if (modelCheckpoint && modelCheckpoint.coveredMessageCount > modelEntryCount) {
    throw new Error("Frozen Runtime fork checkpoint exceeds its model seed");
  }

  const hasSettings = value["settings"] !== undefined;
  const hasGoal = value["goal"] !== undefined;
  const normalized =
    hasSettings || hasGoal
      ? normalizeSessionRuntimeStatePatch({
          ...(hasSettings ? { settings: value["settings"] } : {}),
          ...(hasGoal ? { goal: value["goal"] } : {}),
        })
      : undefined;
  if (
    (hasSettings && !normalized?.settings) ||
    (hasGoal && !normalized?.goal) ||
    (!hasSettings && normalized?.settings) ||
    (!hasGoal && normalized?.goal)
  ) {
    throw new Error("Invalid frozen Runtime state");
  }

  return {
    schemaVersion: value["schemaVersion"],
    operationId: value["operationId"],
    sourceSessionId: value["sourceSessionId"],
    targetSessionId: value["targetSessionId"],
    sourceCursor: structuredClone(value["sourceCursor"]),
    seedEntries,
    planEntries,
    ...(modelCheckpoint ? { modelCheckpoint: structuredClone(modelCheckpoint) } : {}),
    ...(value["sourceTitle"] !== undefined ? { sourceTitle: value["sourceTitle"] } : {}),
    ...(normalized?.settings ? { settings: normalized.settings } : {}),
    ...(normalized?.goal ? { goal: normalized.goal } : {}),
  };
}

function parseFrozenPlanEntries(
  value: unknown,
  sourceSessionId: unknown,
): { sequence: number; event: RuntimePlanEvent }[] {
  if (!Array.isArray(value) || typeof sourceSessionId !== "string") {
    throw new Error("Frozen Runtime plan seed must be an array");
  }
  let previous = 0;
  return value.map((item, index) => {
    if (
      !isRecord(item) ||
      !isNonNegativeInteger(item["sequence"]) ||
      item["sequence"] <= previous
    ) {
      throw new Error(`Frozen Runtime plan seed ${index} has an invalid sequence`);
    }
    previous = item["sequence"];
    const event = decodeRuntimeEvent(structuredClone(item["event"]));
    if (!event.kind.startsWith("plan.") || event.sessionId !== sourceSessionId) {
      throw new Error(`Frozen Runtime plan seed ${index} is invalid`);
    }
    return { sequence: item["sequence"], event: event as RuntimePlanEvent };
  });
}

function parseFrozenRuntimeSeedEntries(value: unknown): RuntimeSessionForkSeedEntry[] {
  if (!Array.isArray(value)) throw new Error("Frozen Runtime v5 seed must be an array");
  let previousSourceSequence = 0;
  const transcriptEvents: DurableTranscriptEvent[] = [];
  const parsed = value.map((item, index): RuntimeSessionForkSeedEntry => {
    if (!isRecord(item)) throw new Error(`Frozen Runtime seed ${index} must be an object`);
    assertExactKeys(item, ["kind", "sourceSequence", "event"]);
    const sourceSequence = item["sourceSequence"];
    if (
      typeof sourceSequence !== "number" ||
      !Number.isSafeInteger(sourceSequence) ||
      sourceSequence <= previousSourceSequence
    ) {
      throw new Error("Frozen Runtime seed source sequences must be strictly increasing");
    }
    previousSourceSequence = sourceSequence;
    if (item["kind"] === "model") {
      const event = decodeRuntimeEvent(structuredClone(item["event"]));
      if (!runtimeEventHasModelHistoryEntry(event)) {
        throw new Error(`Frozen Runtime event ${event.eventId} is not model-visible`);
      }
      return { kind: "model", sourceSequence, event };
    }
    if (item["kind"] === "transcript") {
      const event = structuredClone(item["event"]);
      assertDurableTranscriptEvent(event);
      transcriptEvents.push(event);
      return { kind: "transcript", sourceSequence, event };
    }
    throw new Error(`Frozen Runtime seed ${index} has an invalid kind`);
  });
  projectTranscriptEvents(transcriptEvents);
  return parsed;
}

function parseForkSidecarsBundle(value: unknown): ForkSidecarsBundle {
  if (isRecord(value) && value["schemaVersion"] === 1) {
    throw new Error("Fork sidecar v1 is no longer supported");
  }
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== FORK_SIDECARS_VERSION ||
    typeof value["operationId"] !== "string" ||
    typeof value["sourceSessionId"] !== "string" ||
    typeof value["targetSessionId"] !== "string"
  ) {
    throw new Error("Invalid fork sidecar result");
  }
  return {
    schemaVersion: FORK_SIDECARS_VERSION,
    operationId: value["operationId"],
    sourceSessionId: value["sourceSessionId"],
    targetSessionId: value["targetSessionId"],
  };
}

function validateFrozenBundleForOperation(
  frozen: FrozenForkBundle,
  operation: ForkStorageOperation,
  path: string,
): void {
  if (
    frozen.operationId !== operation.operationId ||
    frozen.sourceSessionId !== operation.sourceSessionId ||
    frozen.targetSessionId !== operation.targetSessionId ||
    !sameCursor(frozen.sourceCursor, operation.sourceCursor)
  ) {
    throw new ForkOperationConflictError(
      "Frozen Runtime fork bundle belongs to another operation or source cursor",
      "staging_corrupt",
      [path],
    );
  }
}

function validateSidecarsForOperation(
  sidecars: ForkSidecarsBundle,
  operation: ForkStorageOperation,
  path: string,
): void {
  if (
    sidecars.operationId !== operation.operationId ||
    sidecars.sourceSessionId !== operation.sourceSessionId ||
    sidecars.targetSessionId !== operation.targetSessionId
  ) {
    throw new ForkOperationConflictError(
      "Fork sidecar result belongs to another operation",
      "staging_corrupt",
      [path],
    );
  }
}

function isMessageValue(value: unknown): value is Message {
  return (
    isRecord(value) &&
    (value["role"] === "system" || value["role"] === "user" || value["role"] === "assistant") &&
    typeof value["content"] === "string"
  );
}

function isSessionForkModelCheckpoint(
  value: unknown,
): value is SessionForkModelCheckpoint | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  assertExactKeys(value, ["coveredMessageCount", "summary"]);
  return (
    typeof value["coveredMessageCount"] === "number" &&
    Number.isSafeInteger(value["coveredMessageCount"]) &&
    value["coveredMessageCount"] > 0 &&
    isMessageValue(value["summary"])
  );
}

function isForkSourceCursor(value: unknown): value is ForkSourceCursor {
  if (!isRecord(value)) return false;
  assertExactKeys(value, ["logId", "seq", "epoch", "eventId"]);
  return (
    typeof value["logId"] === "string" &&
    isNonNegativeInteger(value["seq"]) &&
    isNonNegativeInteger(value["epoch"]) &&
    typeof value["eventId"] === "string"
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

function sourceDisplayTitle(snapshot: DurableSessionForkSnapshot): string | undefined {
  const explicit = snapshot.hydration.runtime.settings?.title;
  if (explicit) return explicit;
  return snapshot.hydration.messages.find(
    (message) =>
      message.role === "user" && message.toolCallId === undefined && message.content.trim(),
  )?.content;
}

function forkTitleFrom(sourceTitle: string): string {
  const compacted = sourceTitle.replace(/\s+/gu, " ").trim();
  const prefix = "Fork of ";
  return prefix + compacted.slice(0, 120 - prefix.length);
}

function runtimeStateEventId(operationId: string): string {
  return "fork:" + operationId + ":state";
}

async function resolveFrozenSourceThroughEventId(
  store: SqliteRuntimeEventStore,
  frozen: FrozenForkBundle,
): Promise<string | undefined> {
  const entries = await store.readSessionEntries(frozen.sourceSessionId);
  const cursorEntry = entries.find((entry) => entry.sequence === frozen.sourceCursor.seq);
  if (
    frozen.sourceCursor.logId !== frozen.sourceSessionId ||
    !cursorEntry ||
    cursorEntry.event.eventId !== frozen.sourceCursor.eventId
  ) {
    throw new ForkOperationConflictError(
      "Frozen source cursor is no longer resolvable in RuntimeEventStore",
      "source_cursor_changed",
    );
  }
  const bounded = entries.filter((entry) => entry.sequence <= frozen.sourceCursor.seq);
  const boundedEvents = bounded.map(({ event }) => event);
  const seedEntries = projectRuntimeSessionForkSeedEntries(bounded).map(stripForkSeedUsage);
  if (!isDeepStrictEqual(seedEntries, frozen.seedEntries)) {
    throw new ForkOperationConflictError(
      "Frozen source canonical seed does not match the RuntimeEvent cursor",
      "source_cursor_changed",
    );
  }
  if (!isDeepStrictEqual(projectActivePlanEntries(bounded), frozen.planEntries)) {
    throw new ForkOperationConflictError(
      "Frozen source Plan facts do not match the RuntimeEvent cursor",
      "source_cursor_changed",
    );
  }
  const checkpoint = deriveDurableRuntimeForkCheckpoint(boundedEvents);
  const normalizedCheckpoint = checkpoint
    ? {
        coveredMessageCount: checkpoint.coveredMessageCount,
        summary: stripMessageUsage(checkpoint.summary),
      }
    : undefined;
  if (!isDeepStrictEqual(normalizedCheckpoint, frozen.modelCheckpoint)) {
    throw new ForkOperationConflictError(
      "Frozen source checkpoint does not match the RuntimeEvent cursor",
      "source_cursor_changed",
    );
  }
  return seedEntries.findLast((entry) => entry.kind === "model")?.event.eventId;
}

function parseForkCreatedAt(createdAt: string): number {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Fork operation has an invalid createdAt timestamp: ${createdAt}`);
  }
  return timestamp;
}

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error("无效 sessionId: " + sessionId);
}

async function assertTargetNotPublished(
  runtimeStore: SqliteRuntimeEventStore,
  targetSessionId: string,
): Promise<void> {
  if (await runtimeStore.readSessionManifest(targetSessionId)) {
    throw new Error("Fork 目标 Runtime 已存在: " + targetSessionId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected !== undefined) {
    throw new Error(`Frozen Runtime payload contains unsupported field ${unexpected}`);
  }
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
