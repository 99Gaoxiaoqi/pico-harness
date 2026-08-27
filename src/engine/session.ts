// 会话管理:Session 物理隔离与完整模型历史的底层实现。
//
// 解决两个核心痛点:
// 1. 多端并发下的 Session 物理隔离 —— 飞书群 A 在重构代码、群 B 在查日志,
//    绝不能共用同一个 contextHistory,否则大模型瞬间精神分裂。
//    通过 SessionManager + 读写锁,为每个用户对话框分配独立安全数据池。
// 2. 长程任务历史滚雪球 → 超时 / 天价 Token / API 400。
//    Session 保留全量事实，Engine 在 token 水位超标时做请求投影与安全摘要。
//
// 经此改造,engine.Run 沦为纯"打工执行器":不内部维护状态,
// 依靠喂给它的 Session 推理 —— 随时休眠、随时被唤醒的记忆连续体。

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type CanonicalUsage, type Message, type UsageReportedField } from "../schema/message.js";
import type { CostStatus } from "../observability/pricing.js";
import { logger } from "../observability/logger.js";
import {
  assertDurableTranscriptEvent,
  type DurableTranscriptEvent,
} from "../presentation/transcript-event-store.js";
import type { CommitReceipt, SessionCursor } from "./session-persistence.js";
import { createSessionIdentity, type SessionIdentity } from "./session-identity.js";
import type { GoalManager } from "./goal-manager.js";
import {
  normalizeSessionRuntimeStatePatch,
  normalizeSessionRuntimeStateWritePatch,
  normalizeSessionUsageSnapshot,
  SESSION_RUNTIME_STATE_VERSION,
  type PersistedSessionSettings,
  type PersistedPromptCacheState,
  type SessionHydrationSnapshot,
  type SessionRuntimePersistence,
  type SessionRuntimeStateWritePatch,
  type SessionRuntimeStateSnapshot,
  type SessionUsageSnapshot,
} from "./session-runtime.js";
import {
  createFileHistoryState,
  type FileHistoryIo,
  type FileHistoryState,
  type FileHistoryDiffStat,
  fileHistoryBeginRewindPoint,
  fileHistoryBindSourceEvent,
  fileHistoryDiffStat,
  fileHistoryDefaultBaseDir,
  fileHistoryLoadState,
  fileHistoryMessageDiffStat,
  fileHistoryPrepareDurableRewindPlan,
  fileHistoryPrepareRewindTransaction,
  fileHistoryRegisterRoot,
  fileHistoryRewind,
  type FileHistoryRewindTransactionHooks,
  type FileHistoryDurableRewindPlan,
} from "../safety/file-history.js";
import { resolvePicoHome, resolvePicoPaths, workspaceIdForPath } from "../paths/pico-paths.js";
import {
  createEngineRuntimeCapability,
  type EngineRuntimeCapability,
  type EngineRuntimePort,
  type EngineRuntimeWriteGuard,
} from "./runtime-port.js";
import { EngineRuntimeCapabilityOwner } from "./runtime-capability-owner.js";
import {
  type RuntimeEventBase,
  type RuntimeEvent,
  type RuntimePlanEvent,
} from "./session-runtime-event.js";
import { projectActivePlanEntries } from "../plan/reducer.js";
import type { SessionForkRuntimePort } from "./session-fork-runtime-port.js";
import {
  createCanonicalTranscriptToolStart,
  createRuntimeTranscriptToolStartEvent,
  createTranscriptToolStartIdentity,
  type CanonicalTranscriptToolStart,
} from "./transcript-tool-start.js";
import {
  projectRuntimeModelMessage,
  runtimeEventHasModelHistoryEntry,
} from "./runtime-model-message.js";
import { materializeRuntimeHistoryEntries } from "./session-runtime-read-model.js";
import {
  type RuntimeEventStoreAppendResult,
  type RuntimeEventStoreEntry,
  type RuntimeOwnerFence,
  type RuntimeSessionManifest,
  type RuntimeSessionProjectionSnapshot,
} from "../storage/runtime-event-store-contracts.js";
import {
  appendRuntimeEventBatchWithArbitration,
  SqliteRuntimeEventStore,
} from "../storage/sqlite/sqlite-runtime-event-store.js";
import {
  projectRuntimeSessionMessageEntries,
  projectRuntimeSessionMessages,
  projectRuntimeSessionForkSeedEntries,
  projectRuntimeSessionModelToolResultEntries,
  projectRuntimeSessionSequencedMessageEntries,
  projectRuntimeSessionState,
  projectRuntimeSessionTranscriptEventEntries,
  type RuntimeSessionForkSeedEntry,
} from "./session-runtime-projection.js";
import { LeaseConflictError, OwnerLease } from "../storage/owner-lease.js";
import { sessionOwnerLeaseDirectory } from "../storage/session-owner-lease.js";
import { SessionMessageLedger } from "./session-message-ledger.js";
import { configureDefaultSessionFactory, SessionManager } from "./session-manager.js";
import { registerSessionDrain, sessionEntryKey } from "./session-manager-state.js";

class SessionWriteUncertainError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionWriteUncertainError";
  }
}

export interface SessionOptions {
  persistence?: boolean;
  /** Host-owned Pico state root. Omitted callers keep the process default. */
  picoHome?: string;
  /** Host-owned durable authority; lets an isolated cwd keep facts in its root workspace ledger. */
  runtimeStorageRoot?: string;
  identity?: SessionIdentity;
  /** Runtime adapter used for ambient/external durable commits. */
  runtimePort?: EngineRuntimePort;
}

/** fork 只读边界：hydration 与父日志游标必须指向同一次 durable flush。 */
export interface DurableRuntimeForkCheckpoint {
  /** Target bootstrap replaces this many copied transcript messages with summary. */
  readonly coveredMessageCount: number;
  readonly summary: Message;
}

export interface DurableSessionForkSnapshot {
  readonly hydration: SessionHydrationSnapshot;
  readonly runtimeSeedEntries: readonly RuntimeSessionForkSeedEntry[];
  readonly planEntries: readonly { readonly sequence: number; readonly event: RuntimePlanEvent }[];
  readonly cursor: SessionCursor;
  readonly rootLogId: string;
  readonly modelCheckpoint?: DurableRuntimeForkCheckpoint;
}

interface SerializedExecutionLease {
  readonly nestedTasks: Set<Promise<void>>;
  readonly nestedErrors: unknown[];
}

interface SerializedExecutionContext {
  active: boolean;
  readonly lease: SerializedExecutionLease;
}

async function drainSerializedExecutionLease(
  lease: SerializedExecutionLease,
): Promise<readonly unknown[]> {
  while (lease.nestedTasks.size > 0) {
    await Promise.all([...lease.nestedTasks]);
  }
  return lease.nestedErrors;
}

function throwSerializedExecutionErrors(
  hasPrimary: boolean,
  primary: unknown,
  nested: readonly unknown[],
): never {
  const nestedWithoutPrimary = hasPrimary
    ? nested.filter((error) => !Object.is(error, primary))
    : nested;
  if (hasPrimary) {
    if (nestedWithoutPrimary.length > 0) {
      throw new AggregateError(
        [primary, ...nestedWithoutPrimary],
        "Session serialized task and nested work both failed",
      );
    }
    throw primary;
  }
  if (nestedWithoutPrimary.length === 1) throw nestedWithoutPrimary[0];
  throw new AggregateError(nestedWithoutPrimary, "Session nested serialized work failed");
}

/**
 * Session:一次持续的人机交互过程。
 * 负责维护该会话的完整历史,并提供模型投影副本。
 */
export class Session
  extends EngineRuntimeCapabilityOwner
  implements SessionRuntimePersistence, EngineRuntimeWriteGuard
{
  /** 会话标识(终端目录哈希 / 飞书 ChatID / 微信 OpenID) */
  readonly id: string;
  /** 该会话绑定的物理工作区 */
  readonly workDir: string;
  /** 会话与项目/worktree 的显式身份,供后续 resume 过滤使用。 */
  readonly identity: SessionIdentity;
  /** Frozen state root so a live Session never follows later environment changes. */
  readonly picoHome: string;
  readonly runtimeStorageRoot: string;
  /** Frozen File History root shared by the Session and AgentEngine journals. */
  readonly fileHistoryBaseDir: string;
  /** File History 持久化落点(blob CAS 根 + manifest 行所在的 workspace 库根)。 */
  readonly fileHistoryIo: FileHistoryIo;
  createdAt: Date;
  updatedAt: Date;

  /** 累计输入 Token(由 CostTracker 在每轮推理后累加) */
  totalPromptTokens = 0;
  /** 累计输出 Token */
  totalCompletionTokens = 0;
  /** 累计真实新输入 Token(不含 cache) */
  totalInputTokens = 0;
  /** 累计 cache read Token */
  totalCacheReadTokens = 0;
  /** 累计 cache write Token */
  totalCacheWriteTokens = 0;
  /** 累计 reasoning Token */
  totalReasoningTokens = 0;
  /** 累计花费(人民币元) */
  totalCostCNY = 0;
  /** 最近一次成本状态 */
  lastCostStatus: CostStatus | null = null;
  totalProviderCalls = 0;
  totalUsageReports = 0;
  totalInputReports = 0;
  totalCacheReadReports = 0;
  totalCacheHitCalls: number | null = 0;
  totalCacheWriteReports = 0;
  totalReasoningReports = 0;
  totalEstimatedCostReports = 0;
  totalIncludedCostReports = 0;
  totalUnknownCostReports = 0;

  /** Disposable message ordering/projection state; durable ownership remains in Session. */
  private readonly messageLedger = new SessionMessageLedger();
  private readonly inMemoryCommitReceipts = new Map<
    string,
    { readonly message: Message; readonly receipt: CommitReceipt }
  >();
  private inMemoryCommitSeq = 0;

  readonly fileHistory: FileHistoryState = createFileHistoryState();

  conversationId: string;

  /**
   * SqliteRuntimeEventStore(pico.sqlite)是唯一 durable 会话真源。undefined 表示
   * 持久化关闭。默认开启;PICO_PERSISTENCE=0 关闭。
   */
  private store?: SqliteRuntimeEventStore;
  private runtimeInitialization?: Promise<RuntimeSessionManifest>;
  private runtimeOwnership?: OwnerLease;
  private runtimeOwnershipPromise?: Promise<OwnerLease>;
  private runtimeOwnerFence?: RuntimeOwnerFence;
  private runtimeProjectionCursor?: SessionCursor;
  /** Session 发起的 RuntimeEvent 共用一条队列，保留调用顺序。 */
  private persistenceTail: Promise<void> = Promise.resolve();
  /** Runtime lifecycle is injected by durable hosts; in-memory Sessions do not need one. */
  private readonly runtimePort?: EngineRuntimePort;
  private lifecycle: "open" | "write_uncertain" | "closing" | "closed" = "open";
  private persistenceFailure?: SessionWriteUncertainError;
  private closePromise?: Promise<void>;
  /** close() seals task admission before the durable/resource drain starts. */
  private acceptingSerializedTasks = true;
  private pendingSerializedTasks = 0;
  /** Nested work shares one tracked lease so detached children cannot outlive serialization. */
  private readonly serializedTask = new AsyncLocalStorage<SerializedExecutionContext>();
  /** close 前已接纳的任务/持久化操作在该 token 有效期内可完成写入。 */
  private readonly writeAdmission = new AsyncLocalStorage<{ active: boolean }>();

  private persistedSettings?: PersistedSessionSettings;
  private persistedGoal?: ReturnType<GoalManager["snapshot"]>;
  private persistedPromptCache?: PersistedPromptCacheState;
  private goalBinding?: { unsubscribe: () => void };

  /**
   * 并发安全:per-session 串行执行队列。
   * 飞书多群/连发消息时,同一 Session 的 engine.run 必须串行,
   * 否则并发读写 history 导致上下文错乱、孤儿 ToolResult、API 400。
   * 通过 Promise 链实现:每个 run 排队等前一个完成。
   */
  private runQueue: Promise<unknown> = Promise.resolve();

  constructor(id: string, workDir: string, options?: SessionOptions) {
    super();
    this.id = id;
    this.workDir = workDir;
    this.picoHome = resolvePicoHome({ picoHome: options?.picoHome });
    this.runtimeStorageRoot = resolve(
      options?.runtimeStorageRoot ??
        resolvePicoPaths(workDir, { picoHome: this.picoHome }).workspace.root,
    );
    this.fileHistoryBaseDir = options?.picoHome
      ? resolvePicoPaths(workDir, { picoHome: this.picoHome }).home.fileHistory
      : fileHistoryDefaultBaseDir();
    // manifest 行与 Session 事件同库(票 08 方案 a):storageRoot 与 initPersistence
    // 的 RuntimeEventStore 解析口径一致。
    this.fileHistoryIo = {
      baseDir: this.fileHistoryBaseDir,
      storageRoot: this.runtimeStorageRoot,
    };
    this.identity =
      options?.identity ??
      createSessionIdentity({
        sessionId: id,
        cwd: workDir,
        originalCwd: process.cwd(),
        projectRoot: workDir,
        sessionProjectDir: workDir,
      });
    this.conversationId = id;
    this.runtimePort = options?.runtimePort;
    this.createdAt = new Date();
    this.updatedAt = new Date();
    fileHistoryRegisterRoot(this.fileHistory, "workspace", resolve(workDir));
    this.initPersistence(options?.persistence);
  }

  /**
   * 初始化持久化。开关优先级:
   *   1. 构造参数 persistence(显式,优先级最高)—— 测试用它精确控制,避免环境变量在
   *      并行测试间相互污染(vitest 默认并行跑文件,共享 process.env 不安全)。
   *   2. 环境变量 PICO_PERSISTENCE —— 生产入口的全局默认,=0 关闭。
   *   3. 默认开启。
   * durable 事件落点为 workspace Runtime 文件账本。
   */
  private initPersistence(explicit?: boolean): void {
    const enabled = explicit ?? process.env.PICO_PERSISTENCE !== "0";
    if (!enabled) return;
    this.store = new SqliteRuntimeEventStore({
      storageRoot: this.runtimeStorageRoot,
    });
  }

  /**
   * 重启后读取 Session manifest + events，重建内存投影。
   * 在 SessionManager.getOrCreate 新建实例时自动调用一次。
   * 持久化关闭时为空操作。
   */
  async recover(): Promise<void> {
    if (this.store) await this.ensureRuntimeOwnership();
    await this.recoverFileHistory();
    if (!this.store) return;
    try {
      const manifest = await this.ensureRuntimeSession();
      // SQLite 纪元:恢复直读 session_messages 物化投影 + by_kind 状态事件,
      // 不再全量重放事件账本(票 03;投影 delta 语义在流式路径保留)。
      const recovery = await this.store.readSessionRecovery(this.id);
      if (!recovery) throw new Error(`Runtime session ${this.id} disappeared during recovery`);
      if (recovery.manifest.createdAt !== manifest.createdAt) {
        throw new Error(`Runtime session ${this.id} manifest changed during recovery`);
      }
      const runtime = projectRuntimeSessionState(recovery.stateEntries.map(({ event }) => event));
      this.createdAt = new Date(manifest.createdAt);
      this.persistedSettings = runtime.settings;
      this.persistedGoal = runtime.goal;
      this.persistedPromptCache = runtime.promptCache;
      this.restoreUsage(runtime.usage);
      this.messageLedger.replace(structuredClone(recovery.messages));
      const cursor = recovery.cursor;
      this.runtimeProjectionCursor = cursor ? { ...cursor } : undefined;
      this.conversationId = cursor ? `${cursor.logId}:${cursor.epoch}` : this.id;
      this.updatedAt = recovery.lastEventAt ? new Date(recovery.lastEventAt) : this.createdAt;
    } catch (error) {
      this.markWriteUncertain("Runtime session initialize/replay failed", error);
      throw error;
    }
  }

  private ensureRuntimeSession(): Promise<RuntimeSessionManifest> {
    const store = this.store;
    if (!store) return Promise.reject(new Error("Session persistence is disabled"));
    if (this.runtimeInitialization) return this.runtimeInitialization;
    const initialization = (async () => {
      await this.ensureRuntimeOwnership();
      const manifest = await store.initializeSession({ sessionId: this.id, workDir: this.workDir });
      const currentFence = await store.readOwnerFence(this.id);
      const ownerFence = await store.advanceOwnerFence(this.id, currentFence.epoch);
      this.runtimeOwnerFence = ownerFence;
      return manifest;
    })();
    const tracked = initialization.catch((error: unknown) => {
      if (this.runtimeInitialization === tracked) this.runtimeInitialization = undefined;
      throw error;
    });
    this.runtimeInitialization = tracked;
    return tracked;
  }

  /** One live process owns a durable Session until close; the RuntimeEvent log remains authoritative. */
  private ensureRuntimeOwnership(): Promise<OwnerLease> {
    if (!this.store) return Promise.reject(new Error("Session persistence is disabled"));
    if (this.runtimeOwnership) return Promise.resolve(this.runtimeOwnership);
    if (this.runtimeOwnershipPromise) return this.runtimeOwnershipPromise;

    const acquisition = OwnerLease.acquire({
      leaseDirectory: sessionOwnerLeaseDirectory(
        { id: workspaceIdForPath(this.runtimeStorageRoot), root: this.runtimeStorageRoot },
        this.id,
      ),
      ownerId: `runtime-session:${this.id}`,
    }).then((lease) => {
      this.runtimeOwnership = lease;
      this.watchRuntimeOwnership(lease);
      return lease;
    });
    this.runtimeOwnershipPromise = acquisition;
    void acquisition.then(
      () => {
        if (this.runtimeOwnershipPromise === acquisition) {
          this.runtimeOwnershipPromise = undefined;
        }
      },
      () => {
        if (this.runtimeOwnershipPromise === acquisition) {
          this.runtimeOwnershipPromise = undefined;
        }
      },
    );
    return acquisition;
  }

  private watchRuntimeOwnership(lease: OwnerLease): void {
    const markLost = (): void => {
      if (this.runtimeOwnership !== lease) return;
      if (this.lifecycle === "closing" || this.lifecycle === "closed") return;
      this.markWriteUncertain("Runtime Session owner lease was lost", lease.lostSignal.reason);
    };
    if (lease.lostSignal.aborted) {
      markLost();
      return;
    }
    lease.lostSignal.addEventListener("abort", markLost, { once: true });
  }

  private applyRuntimeHistoryProjection(projection: RuntimeSessionProjectionSnapshot): void {
    this.messageLedger.replace(
      projectRuntimeSessionMessages(projection.entries.map(({ event }) => event)),
    );
    const cursor = projection.cursor;
    this.runtimeProjectionCursor = cursor ? { ...cursor } : undefined;
    this.conversationId = cursor ? `${cursor.logId}:${cursor.epoch}` : this.id;
    const lastEvent = projection.entries.at(-1)?.event;
    this.updatedAt = lastEvent ? new Date(lastEvent.at) : this.createdAt;
  }

  private async replayRuntimeHistoryProjection(): Promise<void> {
    const store = this.store;
    if (!store) throw new Error("Session persistence is disabled");
    const projection = await store.readSessionProjection(this.id);
    if (!projection) throw new Error(`Runtime session ${this.id} has no canonical projection`);
    const runtime = projectRuntimeSessionState(projection.entries.map(({ event }) => event));
    this.persistedSettings = runtime.settings;
    this.persistedGoal = runtime.goal;
    this.persistedPromptCache = runtime.promptCache;
    this.restoreUsage(runtime.usage);
    this.applyRuntimeHistoryProjection(projection);
  }

  /** Refresh disposable in-memory state after a trusted coordinator appends an atomic batch. */
  async refreshRuntimeProjection(): Promise<void> {
    this.assertWritable();
    await this.ensureRuntimeSession();
    await this.replayRuntimeHistoryProjection();
  }

  private applyRuntimeHistoryProjectionDelta(
    messages: readonly Message[],
    cursor: SessionCursor,
    updatedAt: string,
  ): void {
    this.messageLedger.appendProjected(messages);
    this.runtimeProjectionCursor = { ...cursor };
    this.conversationId = `${cursor.logId}:${cursor.epoch}`;
    this.updatedAt = new Date(updatedAt);
  }

  private async recoverFileHistory(): Promise<void> {
    await fileHistoryLoadState(this.fileHistory, this.id, this.fileHistoryIo);
    if (!this.fileHistory.roots.has("workspace")) {
      fileHistoryRegisterRoot(this.fileHistory, "workspace", resolve(this.workDir));
    }
  }

  /**
   * 串行执行一个任务:同一 Session 的多个调用自动排队,
   * 保证同一时刻只有一个 engine.run 在操作 history。
   * 返回任务的 Promise(结果需调用方 await)。
   */
  serialize<T>(task: () => Promise<T>): Promise<T> {
    if (this.serializedTask.getStore()?.active) {
      return Promise.reject(
        new Error(`Session ${this.id} does not support re-entrant serialized execution`),
      );
    }
    if (!this.acceptingSerializedTasks || this.lifecycle !== "open") {
      const state = this.acceptingSerializedTasks ? this.lifecycle : "closing";
      return Promise.reject(new Error(`Session ${this.id} is ${state}`));
    }
    this.pendingSerializedTasks++;
    const runTask = (): Promise<T> => {
      const lease: SerializedExecutionLease = { nestedTasks: new Set(), nestedErrors: [] };
      const context: SerializedExecutionContext = { active: true, lease };
      return this.serializedTask.run(context, () =>
        this.runWithWriteAdmission(async (): Promise<T> => {
          let result: T | undefined;
          let hasPrimaryError = false;
          let primaryError: unknown;
          try {
            result = await task();
          } catch (error) {
            hasPrimaryError = true;
            primaryError = error;
          } finally {
            // Seal this exact parent before yielding to drain. Already-running children keep
            // their own active context and may still attach grandchildren to the shared lease.
            context.active = false;
            const nestedErrors = await drainSerializedExecutionLease(lease);
            this.pendingSerializedTasks--;
            if (hasPrimaryError || nestedErrors.length > 0) {
              throwSerializedExecutionErrors(hasPrimaryError, primaryError, nestedErrors);
            }
          }
          return result as T;
        }),
      );
    };
    const result = this.runQueue.then(runTask, runTask);
    // 无论成功失败,都更新队列链;吞掉错误让调用方自己的 catch 处理
    this.runQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Enter this Session's serialization capability, or reuse the exact active one.
   * Infrastructure repairs use this boundary so standalone callers cannot mutate the
   * in-memory projection concurrently, while callers already inside serialize() do not deadlock.
   */
  withSerializedExecution<T>(task: () => Promise<T>): Promise<T> {
    const context = this.serializedTask.getStore();
    if (!context?.active) return this.serialize(task);
    return this.startSerializedChild(context, task, false);
  }

  /**
   * Start detached work owned by the active serialized scope. Its completion delays queue
   * release and an uncaught failure is surfaced by the parent serialize() result.
   */
  spawnSerializedExecution(task: () => Promise<unknown>): void {
    const context = this.serializedTask.getStore();
    if (!context?.active) {
      throw new Error(`Session ${this.id} has no active serialized scope for detached work`);
    }
    void this.startSerializedChild(context, task, true);
  }

  private startSerializedChild<T>(
    parent: SerializedExecutionContext,
    task: () => Promise<T>,
    propagateFailure: boolean,
  ): Promise<T> {
    const child: SerializedExecutionContext = { active: true, lease: parent.lease };
    const execution = this.serializedTask.run(child, () => Promise.resolve().then(task));
    const observed = execution
      .then(
        () => undefined,
        (error: unknown) => {
          if (
            propagateFailure &&
            !parent.lease.nestedErrors.some((existing) => Object.is(existing, error))
          ) {
            parent.lease.nestedErrors.push(error);
          }
        },
      )
      .finally(() => {
        child.active = false;
        parent.lease.nestedTasks.delete(observed);
      });
    parent.lease.nestedTasks.add(observed);
    return execution;
  }

  /** True while an already-admitted serialize task is queued or running. */
  get hasPendingTasks(): boolean {
    return this.pendingSerializedTasks > 0;
  }

  /** 记录一次推理的 Token 用量与花费(供 CostTracker 调用) */
  recordUsage(
    promptTokens: number,
    completionTokens: number,
    costCNY: number,
    canonical?: CanonicalUsage,
    costStatus?: CostStatus,
    reportedFields: readonly UsageReportedField[] = ["prompt", "completion"],
  ): void {
    this.assertWritable();
    this.totalProviderCalls++;
    this.totalUsageReports++;
    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    if (canonical) {
      this.totalInputTokens += canonical.inputTokens;
      this.totalCacheReadTokens += canonical.cacheReadTokens;
      this.totalCacheWriteTokens += canonical.cacheWriteTokens;
      this.totalReasoningTokens += canonical.reasoningTokens;
    }
    this.totalCostCNY += costCNY;
    if (costStatus) {
      this.lastCostStatus = costStatus;
      if (costStatus === "estimated") this.totalEstimatedCostReports++;
      else if (costStatus === "included") this.totalIncludedCostReports++;
      else this.totalUnknownCostReports++;
    }
    const reported = new Set(reportedFields);
    if (reported.has("input")) this.totalInputReports++;
    if (reported.has("cacheRead")) {
      this.totalCacheReadReports++;
      if (this.totalCacheHitCalls !== null && (canonical?.cacheReadTokens ?? 0) > 0) {
        this.totalCacheHitCalls++;
      }
    }
    if (reported.has("cacheWrite")) this.totalCacheWriteReports++;
    if (reported.has("reasoning")) this.totalReasoningReports++;
    this.updatedAt = new Date();
  }

  /** Record a completed provider call whose response did not include usage metadata. */
  recordMissingUsage(): void {
    this.assertWritable();
    this.totalProviderCalls++;
    this.updatedAt = new Date();
  }

  /** 返回与内部状态隔离的运行态快照，供启动恢复和 TUI 状态水合。 */
  getRuntimeStateSnapshot(): SessionRuntimeStateSnapshot {
    const snapshot: SessionRuntimeStateSnapshot = {
      stateVersion: SESSION_RUNTIME_STATE_VERSION,
      ...(this.persistedSettings ? { settings: this.persistedSettings } : {}),
      ...(this.persistedGoal ? { goal: this.persistedGoal } : {}),
      ...(this.persistedPromptCache ? { promptCache: this.persistedPromptCache } : {}),
      usage: this.getUsageSnapshot(),
    };
    return structuredClone(snapshot);
  }

  /** 更新一个完整 section，内存立即生效，然后追加 session.state.committed。 */
  updateRuntimeState(patch: SessionRuntimeStateWritePatch): void {
    this.assertWritable();
    const normalized = normalizeSessionRuntimeStatePatch(patch);
    if (!normalized) {
      throw new Error("Runtime session state update is invalid");
    }
    if (normalized.settings) this.persistedSettings = normalized.settings;
    if (normalized.goal) this.persistedGoal = normalized.goal;
    if (normalized.promptCache) this.persistedPromptCache = normalized.promptCache;
    this.updatedAt = new Date();

    if (this.store) {
      const persisted = normalizeSessionRuntimeStateWritePatch(normalized)!;
      void this.enqueuePersistence("runtime state", async (store, ownerFence) => {
        await this.ensureRuntimeSession();
        return store.appendSessionState(this.id, persisted, { ownerFence });
      }).catch((error: unknown) => {
        logger.error({ error: String(error) }, "[session] runtime state 持久化失败");
      });
    }
  }

  /**
   * Resolve one Session's stable shard identity. Crossing the route RPM threshold is persisted as
   * once per route so crossing a threshold never changes an existing Session's key. Sessions
   * created after route activation receive the sharded key.
   */
  preparePromptCacheSharding(
    routeIdentity: string,
    messages: readonly Message[],
    routeThresholdActive: boolean,
  ): { shardSeed?: string; active: boolean } {
    this.assertWritable();
    const anchor = messages.find((message) => message.role !== "system");
    const shardSeed =
      this.persistedPromptCache?.shardSeed ??
      (anchor
        ? createHash("sha256")
            .update(JSON.stringify({ role: anchor.role, content: anchor.content }))
            .digest("hex")
        : undefined);
    const routeDigest = createHash("sha256").update(routeIdentity).digest("hex");
    const routeShardDecisions: Record<string, boolean> = {
      ...(this.persistedPromptCache?.routeShardDecisions ?? {}),
    };
    const hasDecision = Object.hasOwn(routeShardDecisions, routeDigest);
    const active = hasDecision ? routeShardDecisions[routeDigest]! : routeThresholdActive;
    if (!hasDecision) {
      routeShardDecisions[routeDigest] = active;
      while (Object.keys(routeShardDecisions).length > 64) {
        const oldest = Object.keys(routeShardDecisions)[0];
        if (oldest === undefined) break;
        delete routeShardDecisions[oldest];
      }
    }
    if (shardSeed && (!this.persistedPromptCache || !hasDecision)) {
      this.updateRuntimeState({
        promptCache: {
          stateVersion: 1,
          shardSeed,
          routeShardDecisions,
        },
      });
    }
    return { ...(shardSeed ? { shardSeed } : {}), active };
  }

  /**
   * 把会话 GoalManager 绑定到 RuntimeEvent 状态流。
   * 有持久快照时先恢复；无快照时保存当前初始状态。
   */
  bindGoalManager(manager: GoalManager): () => void {
    this.assertWritable();
    this.goalBinding?.unsubscribe();
    if (this.persistedGoal) {
      manager.restore(this.persistedGoal);
    } else {
      this.updateRuntimeState({ goal: manager.snapshot() });
    }
    const unsubscribe = manager.subscribe((goal) => {
      this.updateRuntimeState({ goal });
    });
    const binding = { unsubscribe };
    this.goalBinding = binding;
    return () => {
      if (this.goalBinding !== binding) return;
      unsubscribe();
      this.goalBinding = undefined;
    };
  }

  /** 等待当前已排队的会话写入完成。 */
  async flushPersistence(): Promise<void> {
    await this.persistenceTail;
    if (this.persistenceFailure) throw this.persistenceFailure;
  }

  /** 从 durable RuntimeEvent 边界读取水合快照。 */
  async readHydrationSnapshot(): Promise<SessionHydrationSnapshot> {
    await this.flushPersistence();
    const store = this.store;
    if (!store) {
      return {
        schemaVersion: 1,
        persistenceSequence: null,
        sessionId: this.id,
        conversationId: this.conversationId,
        workDir: this.workDir,
        identity: structuredClone(this.identity),
        createdAt: this.createdAt.toISOString(),
        updatedAt: this.updatedAt.toISOString(),
        messages: structuredClone([...this.messageLedger.readHistory()]),
        messageSequences: this.messageLedger.readHistory().map((_, index) => index + 1),
        transcriptEvents: [],
        transcriptEventSequences: [],
        toolResults: [],
        runtime: this.getRuntimeStateSnapshot(),
      };
    }
    const manifest = await this.ensureRuntimeSession();
    const entries = await store.readSessionEntries(this.id);
    return this.runtimeHydrationSnapshot(manifest, entries);
  }

  /**
   * 在 fork 前 drain Session 写队列，再从同一批 RuntimeEvent entries
   * 生成 hydration 与 cursor。返回后 source 可继续追加，
   * 调用方必须以 cursor 作为已冻结 bundle 的父边界。
   */
  async readDurableForkSnapshot(): Promise<DurableSessionForkSnapshot> {
    await this.flushPersistence();
    const store = this.store;
    if (!store) {
      throw new Error(`Session ${this.id} 还没有可用于 fork 的 durable event`);
    }
    const manifest = await this.ensureRuntimeSession();
    const entries = await store.readSessionEntries(this.id);
    const cursor = runtimeCursorForEntries(this.id, entries);
    if (!cursor) throw new Error(`Session ${this.id} 还没有可用于 fork 的 durable event`);
    const events = entries.map(({ event }) => event);
    const modelCheckpoint = deriveDurableRuntimeForkCheckpoint(events);
    return {
      hydration: this.runtimeHydrationSnapshot(manifest, entries),
      runtimeSeedEntries: projectRuntimeSessionForkSeedEntries(entries),
      planEntries: projectActivePlanEntries(entries) as readonly {
        readonly sequence: number;
        readonly event: RuntimePlanEvent;
      }[],
      rootLogId: await resolveRuntimeRootSessionId(store, this.id),
      cursor,
      ...(modelCheckpoint ? { modelCheckpoint } : {}),
    };
  }

  /**
   * 在 fork 前 drain Session 写队列，再从 RuntimeEvent entries 中截取到
   * 指定 throughEventId（含）为止的切片，生成 hydration 与 cursor。
   * 用于 non-destructive rewind：旧 Session 完全不变，fork 在历史中间分叉。
   *
   * 与 {@link readDurableForkSnapshot} 的区别仅在于边界：这里把 source head
   * 替换为指定的历史 event。调用方必须保证 throughEventId 真实存在于 source。
   */
  async readDurableForkSnapshotAt(throughEventId: string): Promise<DurableSessionForkSnapshot> {
    await this.flushPersistence();
    const store = this.store;
    if (!store) {
      throw new Error(`Session ${this.id} 还没有可用于 fork 的 durable event`);
    }
    const manifest = await this.ensureRuntimeSession();
    const all = await store.readSessionEntries(this.id);
    const boundaryIndex = all.findIndex((entry) => entry.event.eventId === throughEventId);
    if (boundaryIndex < 0) {
      throw new Error(`Session ${this.id} 中找不到 fork 边界事件 ${throughEventId}`);
    }
    const entries = all.slice(0, boundaryIndex + 1);
    const cursor = runtimeCursorForEntry(this.id, all, all[boundaryIndex]!);
    const events = entries.map(({ event }) => event);
    const modelCheckpoint = deriveDurableRuntimeForkCheckpoint(events);
    return {
      hydration: this.runtimeHydrationSnapshot(manifest, entries),
      runtimeSeedEntries: projectRuntimeSessionForkSeedEntries(entries),
      planEntries: projectActivePlanEntries(entries) as readonly {
        readonly sequence: number;
        readonly event: RuntimePlanEvent;
      }[],
      rootLogId: await resolveRuntimeRootSessionId(store, this.id),
      cursor,
      ...(modelCheckpoint ? { modelCheckpoint } : {}),
    };
  }

  private runtimeHydrationSnapshot(
    manifest: RuntimeSessionManifest,
    entries: readonly RuntimeEventStoreEntry[],
  ): SessionHydrationSnapshot {
    const events = entries.map(({ event }) => event);
    const cursor = runtimeCursorForEntries(this.id, entries);
    const updatedAt = entries.at(-1)?.event.at ?? manifest.createdAt;
    const messages = projectRuntimeSessionSequencedMessageEntries(entries);
    const transcript = projectRuntimeSessionTranscriptEventEntries(entries);
    const toolResults = projectRuntimeSessionModelToolResultEntries(entries);
    return {
      schemaVersion: 1,
      persistenceSequence: cursor?.seq ?? null,
      sessionId: this.id,
      conversationId: cursor ? `${cursor.logId}:${cursor.epoch}` : this.id,
      workDir: this.workDir,
      identity: structuredClone(this.identity),
      createdAt: manifest.createdAt,
      updatedAt,
      messages: messages.map(({ message }) => message),
      messageSequences: messages.map(({ sequence }) => sequence),
      transcriptEvents: transcript.map(({ event }) => event),
      transcriptEventSequences: transcript.map(({ sequence }) => sequence),
      toolResults,
      runtime: projectRuntimeSessionState(events),
    };
  }

  private getUsageSnapshot(): SessionUsageSnapshot {
    return {
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalInputTokens: this.totalInputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheWriteTokens: this.totalCacheWriteTokens,
      totalReasoningTokens: this.totalReasoningTokens,
      totalCostCNY: this.totalCostCNY,
      lastCostStatus: this.lastCostStatus,
      totalProviderCalls: this.totalProviderCalls,
      totalUsageReports: this.totalUsageReports,
      totalInputReports: this.totalInputReports,
      totalCacheReadReports: this.totalCacheReadReports,
      totalCacheHitCalls: this.totalCacheHitCalls,
      totalCacheWriteReports: this.totalCacheWriteReports,
      totalReasoningReports: this.totalReasoningReports,
      totalEstimatedCostReports: this.totalEstimatedCostReports,
      totalIncludedCostReports: this.totalIncludedCostReports,
      totalUnknownCostReports: this.totalUnknownCostReports,
    };
  }

  private restoreUsage(usage: SessionUsageSnapshot): void {
    this.totalPromptTokens = usage.totalPromptTokens;
    this.totalCompletionTokens = usage.totalCompletionTokens;
    this.totalInputTokens = usage.totalInputTokens;
    this.totalCacheReadTokens = usage.totalCacheReadTokens;
    this.totalCacheWriteTokens = usage.totalCacheWriteTokens;
    this.totalReasoningTokens = usage.totalReasoningTokens;
    this.totalCostCNY = usage.totalCostCNY;
    this.lastCostStatus = usage.lastCostStatus;
    this.totalProviderCalls = usage.totalProviderCalls;
    this.totalUsageReports = usage.totalUsageReports;
    this.totalInputReports = usage.totalInputReports;
    this.totalCacheReadReports = usage.totalCacheReadReports;
    this.totalCacheHitCalls = usage.totalCacheHitCalls;
    this.totalCacheWriteReports = usage.totalCacheWriteReports;
    this.totalReasoningReports = usage.totalReasoningReports;
    this.totalEstimatedCostReports = usage.totalEstimatedCostReports;
    this.totalIncludedCostReports = usage.totalIncludedCostReports;
    this.totalUnknownCostReports = usage.totalUnknownCostReports;
  }

  /** 生产接口：RuntimeEvent durable 后才刷新 Session 内存投影。 */
  async commitMessages(...msgs: Message[]): Promise<void> {
    this.assertWritable();
    if (!this.store) {
      for (const msg of msgs) this.appendOneInMemory(msg);
      return;
    }
    const runtimePort = this.runtimePort;
    if (!runtimePort) {
      throw new Error(`Durable Session ${this.id} requires an explicit RuntimePort`);
    }
    await this.enqueuePersistence("messages", async () => {
      await this.ensureRuntimeSession();
      const runtimeRun = runtimePort.currentRun();
      if (runtimeRun?.claimsSession(this)) {
        await runtimeRun.commitMessages(this, msgs);
        return;
      }
      if (!(await runtimePort.commitExternalMessages(this, msgs))) {
        throw new Error(`Runtime session ${this.id} is not initialized`);
      }
    });
  }

  /**
   * 以宿主提供的稳定 eventId 追加一条消息。同 ID+同 payload 重试只返回
   * 首次 receipt，不分配新 seq；同 ID 被不同 payload 复用则失败关闭。
   * persistence:false 只提供进程内幂等，receipt.durable=false。
   */
  async commitMessageOnce(eventId: string, message: Message): Promise<CommitReceipt> {
    this.assertWritable();
    if (!this.store) return this.commitProjectionMessageOnce(eventId, message);
    const runtimePort = this.runtimePort;
    if (!runtimePort) {
      throw new Error(`Durable Session ${this.id} requires an explicit RuntimePort`);
    }
    return this.enqueuePersistence("message", async () => {
      await this.ensureRuntimeSession();
      const runtimeRun = runtimePort.currentRun();
      if (runtimeRun?.claimsSession(this)) {
        return runtimeRun.commitMessageOnce(this, eventId, message);
      }
      const receipt = await runtimePort.commitExternalMessageOnce(this, eventId, message);
      if (!receipt) throw new Error(`Runtime session ${this.id} is not initialized`);
      return receipt;
    });
  }

  /** Advances the disposable in-memory Session projection once for one durable append batch. */
  async commitRuntimeProjectionBatch(
    commits: readonly RuntimeEventStoreAppendResult[],
  ): Promise<void> {
    this.assertWritable();
    if (commits.length === 0) return;
    const store = this.store;
    if (!store) throw new Error("Session persistence is disabled");
    await this.ensureRuntimeSession();

    const previousCursor = this.runtimeProjectionCursor;
    const targetCursor = commits.at(-1)!.cursor;
    let precedingSequence = previousCursor?.seq ?? -1;
    const commitsAreFreshAndOrdered = commits.every((commit) => {
      const ordered =
        commit.inserted && commit.cursor.logId === this.id && commit.cursor.seq > precedingSequence;
      precedingSequence = commit.cursor.seq;
      return ordered;
    });

    if (!previousCursor || this.messageLedger.deferredCount > 0 || !commitsAreFreshAndOrdered) {
      await this.replayRuntimeHistoryProjection();
      return;
    }

    const delta = await store.readSessionProjectionDelta(this.id, previousCursor, targetCursor);
    if (!delta) {
      await this.replayRuntimeHistoryProjection();
      return;
    }

    const entriesByEventId = new Map(delta.entries.map((entry) => [entry.event.eventId, entry]));
    const commitsMatchCanonicalMessages = commits.every((commit) => {
      const entry = entriesByEventId.get(commit.cursor.eventId);
      return (
        entry !== undefined &&
        entry.sequence === commit.cursor.seq &&
        entry.event.at === commit.committedAt &&
        runtimeEventHasModelHistoryEntry(entry.event)
      );
    });
    if (!commitsMatchCanonicalMessages) {
      await this.replayRuntimeHistoryProjection();
      return;
    }

    const messages = delta.entries.flatMap((entry) => {
      const message = projectRuntimeModelMessage(entry.event);
      return message ? [message] : [];
    });
    this.applyRuntimeHistoryProjectionDelta(messages, delta.cursor, delta.entries.at(-1)!.event.at);
  }

  /**
   * RuntimeEvent 已经 durable 后写入 Session 投影的内部入口。
   * 调用方必须使用同一个 RuntimeEvent ID，避免投影重试产生新事实。
   */
  async commitProjectionMessageOnce(eventId: string, message: Message): Promise<CommitReceipt> {
    this.assertWritable();
    if (!eventId.trim()) throw new Error("Session eventId 不能为空");
    if (this.store) assertRuntimeCommittedMessage(message);
    if (!this.store) {
      const existing = this.inMemoryCommitReceipts.get(eventId);
      if (existing) {
        if (!isDeepStrictEqual(existing.message, message)) {
          throw new Error(`Session eventId conflict: ${eventId} is already bound to another event`);
        }
        return { ...existing.receipt, inserted: false };
      }
      if (this.messageLedger.wouldDefer(message)) {
        throw new Error("Exactly-once message cannot be deferred behind incomplete tool results");
      }
      this.appendOneInMemory(message);
      const committedAt = new Date().toISOString();
      const receipt: CommitReceipt = {
        eventId,
        cursor: {
          logId: `in-memory:${this.id}`,
          seq: this.inMemoryCommitSeq++,
          epoch: 0,
          eventId,
        },
        committedAt,
        durable: false,
        inserted: true,
      };
      this.inMemoryCommitReceipts.set(eventId, {
        message: structuredClone(message),
        receipt,
      });
      return receipt;
    }
    await this.ensureRuntimeSession();
    const entry = await this.store.readSessionEvent(this.id, eventId);
    if (!entry || entry.event.kind !== "message.committed") {
      throw new Error(`Runtime message event ${eventId} is not durable`);
    }
    if (!isDeepStrictEqual(entry.event.data.message, message)) {
      throw new Error(`Runtime event ID ${eventId} is already bound to another payload`);
    }
    const ownerFence = await this.assertRuntimeEventWriteAllowed();
    const persisted = await this.store.append(entry.event, { ownerFence });
    const confirmedFence = await this.assertRuntimeEventWriteAllowed();
    if (confirmedFence.epoch !== ownerFence.epoch) {
      throw new LeaseConflictError(`Runtime Session ${this.id} owner fence changed during append`);
    }
    await this.replayRuntimeHistoryProjection();
    return commitReceiptFromAppend(persisted);
  }

  /**
   * Rebuilds the disposable Session projection from canonical RuntimeEvent history.
   */
  async replaceRuntimeProjection(
    messages: readonly Message[],
    projectionEventId: string,
  ): Promise<void> {
    this.assertWritable();
    if (!projectionEventId.trim()) throw new Error("Runtime projection eventId 不能为空");
    if (!this.store) {
      this.messageLedger.replace(messages);
      this.updatedAt = new Date();
      return;
    }
    await this.ensureRuntimeSession();
    const projection = await this.store.readSessionProjection(this.id);
    if (!projection) throw new Error(`Runtime session ${this.id} has no canonical projection`);
    const projected = projectRuntimeSessionMessages(projection.entries.map(({ event }) => event));
    if (!isDeepStrictEqual(projected, messages)) {
      throw new Error(`Runtime projection ${projectionEventId} does not match canonical events`);
    }
    this.applyRuntimeHistoryProjection(projection);
  }

  /** Rebuilds the replaceable Session usage projection from canonical model-call facts. */
  async replaceRuntimeUsage(usage: SessionUsageSnapshot, projectionEventId: string): Promise<void> {
    this.assertWritable();
    if (!projectionEventId.trim()) throw new Error("Runtime usage projection eventId 不能为空");
    const normalized = normalizeSessionUsageSnapshot(usage);
    if (!normalized) throw new Error("Runtime usage projection is invalid");
    if (!this.store) {
      this.restoreUsage(normalized);
      this.updatedAt = new Date();
      return;
    }
    await this.ensureRuntimeSession();
    const events = await this.store.readSession(this.id);
    const projected = projectRuntimeSessionState(events).usage;
    if (!isDeepStrictEqual(projected, normalized)) {
      throw new Error(`Runtime usage projection ${projectionEventId} is stale`);
    }
    this.restoreUsage(projected);
    this.updatedAt = new Date(events.at(-1)?.at ?? this.updatedAt);
  }

  private appendOneInMemory(msg: Message): void {
    const result = this.messageLedger.append(msg);
    if (result.appended.length > 0) this.updatedAt = new Date();
  }

  /**
   * 硬重置兜底:截断历史,只保留 fromIndex 起的消息(含)。
   * 用于 loop.ts 捕获 ContextCompactionError 后,丢弃爆掉的历史,
   * 仅保留本轮用户输入(history[beforeLen])让模型重新规划。
   * 累计成本统计保留(对齐 kimi-code clear 不碰 usage 的语义)。
   */
  async truncateTo(fromIndex: number): Promise<void> {
    this.assertWritable();
    if (fromIndex < 0) fromIndex = 0;
    if (this.store) {
      throw new Error(
        "Durable Runtime does not support Session.truncateTo; use canonical checkpoint or rewind",
      );
    }
    this.messageLedger.truncateTo(fromIndex);
    this.updatedAt = new Date();
  }

  /**
   * 对话 undo:从末尾向前删 count 个 user prompt 轮次。
   * 跳过 system injection 消息,遇到 compaction 边界停止。
   * fork 语义:生成新 conversationId，旧 RuntimeEvent 保留在事件流中。
   */
  async undo(count: number): Promise<void> {
    this.assertWritable();
    if (count <= 0) return;
    if (this.store) {
      throw new Error(
        "Durable Runtime does not support destructive Session.undo; use forkFromCheckpoint for a non-destructive rewind",
      );
    }
    const { cutIndex, removedCount } = findUndoCut(this.messageLedger.readHistory(), count);
    if (removedCount === 0) return;
    this.messageLedger.retainPrefix(cutIndex, { resetOrderingState: true });
    this.conversationId = `${this.id}-${Date.now().toString(36)}`;
    this.updatedAt = new Date();
  }

  async beginRewindPoint(input: {
    userPrompt: string;
    transcriptIndex?: number;
    interactionMode?: PersistedSessionSettings["mode"];
    prePlanMode?: NonNullable<PersistedSessionSettings["prePlanMode"]>;
    messageId?: string;
  }): Promise<string> {
    this.assertWritable();
    if (input.prePlanMode !== undefined && input.interactionMode !== "plan") {
      throw new Error("prePlanMode requires interactionMode=plan");
    }
    const messageId = input.messageId ?? randomUUID();
    await this.flushPersistence();
    const beforeSessionSeq = Math.max(0, (await this.store?.getHeadCursor(this.id))?.seq ?? 0);
    await fileHistoryBeginRewindPoint(
      this.fileHistory,
      {
        messageId,
        sourceMessageEventId: `user-message:${messageId}`,
        beforeSessionSeq,
        userPrompt: input.userPrompt,
        messageIndex: this.messageLedger.length,
        ...(input.transcriptIndex !== undefined ? { transcriptIndex: input.transcriptIndex } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        ...(input.prePlanMode !== undefined ? { prePlanMode: input.prePlanMode } : {}),
      },
      this.id,
      this.fileHistoryIo,
    );
    return messageId;
  }

  async bindRewindPointSource(messageId: string, receipt: CommitReceipt): Promise<void> {
    this.assertWritable();
    const snapshot = this.requireRewindSnapshot(messageId);
    await fileHistoryBindSourceEvent(this.fileHistory, {
      messageId,
      sourceMessageEventId: receipt.eventId,
      beforeSessionSeq: snapshot.beforeSessionSeq,
    });
  }

  /** Rewind Saga 以 operationId 作事件幂等键。 */
  async rewindOnce(
    _operationId: string,
    _messageIndex: number,
  ): Promise<CommitReceipt | undefined> {
    throw new Error(
      "Destructive Session.rewindOnce has been removed; rewind is now non-destructive via forkFromCheckpoint",
    );
  }

  /**
   * 非破坏性 code rewind：仅回滚工作区文件到 checkpoint 状态。
   * 不追加 history.rewound、不丢弃后续 FileHistory 快照。
   * 被 {@link forkFromCheckpoint} 的 code / both 模式复用。
   */
  async rewindCode(
    messageId: string,
    expectedCurrentFingerprints?: ReadonlyMap<string, string>,
  ): Promise<void> {
    this.assertWritable();
    await this.flushPersistence();
    await fileHistoryRewind(
      this.fileHistory,
      messageId,
      this.id,
      this.fileHistoryBaseDir,
      expectedCurrentFingerprints ? { expectedCurrentFingerprints } : {},
    );
  }

  async prepareDurableRewindPlan(
    messageId: string,
    expectedCurrentFingerprints?: ReadonlyMap<string, string>,
  ): Promise<FileHistoryDurableRewindPlan> {
    this.assertWritable();
    await this.flushPersistence();
    return fileHistoryPrepareDurableRewindPlan(
      this.fileHistory,
      messageId,
      this.id,
      this.fileHistoryBaseDir,
      expectedCurrentFingerprints ? { expectedCurrentFingerprints } : {},
    );
  }

  async getRewindDiffStat(messageId: string): Promise<FileHistoryDiffStat> {
    return fileHistoryDiffStat(this.fileHistory, messageId, this.id, this.fileHistoryBaseDir);
  }

  async getRewindPointChangeStat(messageId: string): Promise<FileHistoryDiffStat> {
    return fileHistoryMessageDiffStat(
      this.fileHistory,
      messageId,
      this.id,
      this.fileHistoryBaseDir,
    );
  }

  /**
   * Non-destructive rewind: 从 checkpoint 处创建新 Session（fork），
   * 原 Session 完全不变。消除跨账本悬空引用（Memory Source、TaskRun checkpoint）。
   *
   * mode 语义与破坏性 rewind 对齐：
   * - "code": 只回滚工作区文件到 checkpoint 状态。无新 Session。
   * - "conversation": 只 fork 对话（新 Session 截断到 checkpoint 之前），不动文件。
   * - "both": fork 对话 + 回滚工作区文件。
   *
   * `runtimePort` 由宿主注入（engine 不能 import runtime 适配器层）。
   * `createTargetSessionId` 让宿主控制新 Session 的命名空间。
   */
  async forkFromCheckpoint(
    checkpointId: string,
    mode: "code" | "conversation" | "both",
    runtimePort: SessionForkRuntimePort,
    createTargetSessionId: () => string,
    expectedFingerprints?: Record<string, string>,
    options: {
      readonly fileTransactionHooks?: FileHistoryRewindTransactionHooks;
      readonly fallbackSettings?: PersistedSessionSettings;
      readonly operationId?: string;
    } = {},
  ): Promise<{ targetSessionId: string }> {
    this.assertWritable();
    const snapshot = this.requireRewindSnapshot(checkpointId);
    const expectedCurrentFingerprints = expectedFingerprints
      ? new Map(Object.entries(expectedFingerprints))
      : undefined;

    await this.flushPersistence();
    const fileTransaction =
      mode === "code"
        ? await fileHistoryPrepareRewindTransaction(
            this.fileHistory,
            checkpointId,
            this.id,
            this.fileHistoryBaseDir,
            expectedCurrentFingerprints ? { expectedCurrentFingerprints } : {},
          )
        : undefined;

    // code-only 不创建派生 Session；多文件恢复仍通过同一补偿事务避免部分应用。
    if (mode === "code") {
      await fileTransaction!.apply(options.fileTransactionHooks);
      fileTransaction!.commit();
      return { targetSessionId: this.id };
    }

    const store = this.store;
    if (!store) {
      throw new Error(`Session ${this.id} 需要 durable runtime 才能执行 fork rewind`);
    }

    // 解析 fork 边界：checkpoint 记录的 beforeSessionSeq 是该用户消息追加前的 head seq。
    // fork 到这个边界即丢弃该用户消息及其后续。边界可能不存在（首条用户消息前为空对话）。
    const targetSessionId = createTargetSessionId();
    const throughEventId = await this.resolveForkBoundaryEventId(snapshot.beforeSessionSeq);

    // both 的文件阶段由 durable Fork coordinator 管理：它先冻结
    // original/rewound 双向状态并创建 journal，再执行首个文件写入。
    await runtimePort.forkSession({
      workDir: this.workDir,
      picoHome: this.picoHome,
      fileHistoryBaseDir: this.fileHistoryBaseDir,
      sourceSessionId: this.id,
      targetSessionId,
      ...(options.operationId ? { operationId: options.operationId } : {}),
      ...(throughEventId ? { throughEventId } : {}),
      ...(options.fallbackSettings ? { fallbackSettings: options.fallbackSettings } : {}),
      ...(mode === "both"
        ? {
            cleanupOnlyOnFailure: true,
            rewind: {
              checkpointId,
              ...(expectedFingerprints ? { expectedFingerprints } : {}),
              ...(options.fileTransactionHooks
                ? { fileTransactionHooks: options.fileTransactionHooks }
                : {}),
            },
          }
        : {}),
    });

    return { targetSessionId };
  }

  /**
   * 解析 fork rewind 的 RuntimeEvent 边界 event id。
   * beforeSessionSeq=0 且无 seq 0 条目表示首条用户消息之前的空对话，返回 undefined。
   */
  private async resolveForkBoundaryEventId(beforeSessionSeq: number): Promise<string | undefined> {
    if (!this.store) return undefined;
    const entries = await this.store.readSessionEntries(this.id);
    if (beforeSessionSeq <= 0) {
      return entries.find((entry) => entry.sequence === 0)?.event.eventId;
    }
    return entries.find((entry) => entry.sequence === beforeSessionSeq)?.event.eventId;
  }

  private requireRewindSnapshot(messageId: string): FileHistoryState["snapshots"][number] {
    const snapshot = this.fileHistory.snapshots.find(
      (candidate) => candidate.messageId === messageId,
    );
    if (!snapshot) throw new Error(`FileHistory: 找不到 messageId=${messageId} 的快照`);
    return snapshot;
  }

  /** Replace an explicitly in-memory Session prefix with one summary message. */
  async applyInMemoryCompaction(summary: string, compactedCount: number): Promise<void> {
    this.assertWritable();
    if (this.store) {
      throw new Error(
        "Durable Runtime does not support Session.applyInMemoryCompaction; use a canonical Runtime checkpoint",
      );
    }
    if (compactedCount < 0) compactedCount = 0;
    const summaryMsg: Message = {
      role: "assistant",
      content: summary,
      providerData: { picoKind: "compaction_summary" },
    };
    this.messageLedger.compact(summaryMsg, compactedCount);
    this.updatedAt = new Date();
  }

  /** 全量历史深拷贝，供宿主投影、诊断与压缩读取，不作为 Provider 的直接投影策略。 */
  getHistory(): Message[] {
    return structuredClone([...this.messageLedger.readHistory()]);
  }

  /** 当前历史消息条数 */
  get length(): number {
    return this.messageLedger.length;
  }

  /**
   * Return the complete model-visible history. Unlike the legacy sliding
   * window this never splits or drops a tool exchange; token-pressure policy
   * belongs to the projection/compaction layer.
   */
  getModelContext(): Message[] {
    return this.messageLedger.getModelContext();
  }

  /** True only while the tail tool exchange is still waiting for results. */
  hasPendingToolResults(): boolean {
    return this.messageLedger.hasPendingToolResults();
  }

  /**
   * 暴露 ToolResult 外挂元数据(按 toolCallId 索引),供 MicroCompaction
   * 读取缓存年龄与使用率。返回只读视图。
   */
  getToolResultMeta(): ReadonlyMap<string, { cachedAt: number; accessCount: number }> {
    return this.messageLedger.getToolResultMeta();
  }

  /** Durable event authority; undefined only for explicitly in-memory sessions. */
  get runtimeEventStore(): SqliteRuntimeEventStore | undefined {
    return this.store;
  }

  /** One inseparable Runtime scope: Session identity, workspace, store, and owner guard. */
  get runtimeEventCapability(): EngineRuntimeCapability | undefined {
    const store = this.store;
    if (!store) return undefined;
    return createEngineRuntimeCapability({
      owner: this,
      runtimeAuthority: store,
    });
  }

  /** Capability issuance must use the exact durable authority owned by this Session. */
  assertRuntimeEventAuthority(authority: object): void {
    if (!this.store || authority !== this.store) {
      throw new Error(`Runtime authority is not owned by Session ${this.id}`);
    }
  }

  /** RuntimeRun's only authority over Session ownership; the lease itself stays private here. */
  async assertRuntimeEventWriteAllowed(): Promise<RuntimeOwnerFence> {
    this.assertWritable();
    let ownership: OwnerLease;
    try {
      ownership = await this.ensureRuntimeOwnership();
      await ownership.assertOwnership();
      await this.ensureRuntimeSession();
    } catch (error) {
      // LeaseConflictError = 真正��了所有权（leaseId 不匹配）→ 标记不可写。
      // 瞬时文件系统错误（EPERM/ENOENT/EBUSY）→ 不标记不可写，直接抛出让调用方重试。
      if (error instanceof LeaseConflictError) {
        this.markWriteUncertain("Runtime Session owner lease validation failed", error);
      }
      throw this.persistenceFailure ?? error;
    }
    this.assertWritable();
    const expected = this.runtimeOwnerFence;
    if (!expected || expected.epoch <= 0) {
      throw new Error(`Runtime Session ${this.id} has no active owner fence`);
    }
    const actual = await this.store!.readOwnerFence(this.id);
    if (actual.epoch !== expected.epoch) {
      const error = new LeaseConflictError(
        `Runtime Session ${this.id} owner fence changed from ${expected.epoch} to ${actual.epoch}`,
      );
      this.markWriteUncertain("Runtime Session owner fence validation failed", error);
      throw this.persistenceFailure ?? error;
    }
    return { ...expected };
  }

  /** Append one structured transcript fact to the same canonical RuntimeEvent ledger. */
  async recordTranscriptEvent(
    event: DurableTranscriptEvent,
    options: { readonly eventId?: string } = {},
  ): Promise<CommitReceipt> {
    let durableEvent = structuredClone(event);
    return this.enqueuePersistence("transcript event", async (store, ownerFence) => {
      await this.ensureRuntimeSession();
      const runtimeEventId = options.eventId ?? `transcript:${durableEvent.eventId}`;
      const entries = await store.readSessionEntries(this.id);
      const existing = entries.find((entry) => entry.event.eventId === runtimeEventId);
      if (existing) {
        if (existing.event.kind !== "transcript.event.recorded") {
          throw new Error(`Runtime event ID ${runtimeEventId} is already bound to another payload`);
        }
        durableEvent = { ...durableEvent, sequence: existing.event.data.event.sequence };
      } else {
        const projected = projectRuntimeSessionTranscriptEventEntries(entries);
        durableEvent = {
          ...durableEvent,
          sequence: (projected.at(-1)?.event.sequence ?? 0) + 1,
        };
      }
      return commitReceiptFromAppend(
        await store.appendTranscriptEvent(this.id, durableEvent, {
          eventId: runtimeEventId,
          ownerFence,
        }),
      );
    });
  }

  /**
   * Atomically records the structured starts for one accepted provider batch.
   * The whole batch is durable before Reporter callbacks or tool execution begin.
   */
  async recordRuntimeTranscriptToolStarts(input: {
    readonly invocationId: string;
    readonly runId: string;
    readonly turnId: string;
    readonly createdAt: number;
    readonly toolCalls: readonly {
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    }[];
    readonly refs?: RuntimeEventBase["refs"];
  }): Promise<readonly CanonicalTranscriptToolStart[]> {
    if (input.toolCalls.length === 0) return [];
    const toolCalls = structuredClone(input.toolCalls);
    const batch = {
      invocationId: input.invocationId,
      runId: input.runId,
      turnId: input.turnId,
      createdAt: input.createdAt,
      ...(input.refs ? { refs: structuredClone(input.refs) } : {}),
    };
    const identities = toolCalls.map((_toolCall, callIndex) =>
      createTranscriptToolStartIdentity({
        sessionId: this.id,
        runId: batch.runId,
        turnId: batch.turnId,
        callIndex,
      }),
    );

    return this.enqueuePersistence("transcript tool start batch", async (store, ownerFence) => {
      await this.ensureRuntimeSession();
      const entries = await store.readSessionEntries(this.id);
      const existing = identities.map(({ runtimeEventId }) =>
        entries.find((entry) => entry.event.eventId === runtimeEventId),
      );
      const existingCount = existing.filter(Boolean).length;
      if (existingCount !== 0) {
        if (existingCount !== toolCalls.length) {
          throw new Error(
            `Runtime transcript tool start batch ${batch.runId}/${batch.turnId} is partially durable`,
          );
        }
        return existing.map((entry, callIndex) => {
          if (!entry || entry.event.kind !== "transcript.event.recorded") {
            throw new Error(
              `Runtime transcript tool start ${identities[callIndex]!.runtimeEventId} is bound to another payload`,
            );
          }
          const start = entry.event.data.event;
          assertDurableTranscriptEvent(start);
          if (start.type !== "tool.started") {
            throw new Error(
              `Runtime transcript tool start ${entry.event.eventId} has an incompatible event type`,
            );
          }
          const expected = createRuntimeTranscriptToolStartEvent({
            sessionId: this.id,
            invocationId: batch.invocationId,
            runId: batch.runId,
            turnId: batch.turnId,
            start: createCanonicalTranscriptToolStart({
              sessionId: this.id,
              runId: batch.runId,
              turnId: batch.turnId,
              callIndex,
              toolCall: toolCalls[callIndex]!,
              sequence: start.sequence,
              createdAt: start.createdAt,
            }),
            ...(batch.refs ? { refs: batch.refs } : {}),
          });
          if (!isDeepStrictEqual(entry.event, expected)) {
            throw new Error(
              `Runtime transcript tool start ${entry.event.eventId} is bound to another payload`,
            );
          }
          return structuredClone(start);
        });
      }

      const nextSequence =
        projectRuntimeSessionTranscriptEventEntries(entries).reduce(
          (maximum, entry) => Math.max(maximum, entry.event.sequence),
          0,
        ) + 1;
      const starts = toolCalls.map((toolCall, callIndex) =>
        createCanonicalTranscriptToolStart({
          sessionId: this.id,
          runId: batch.runId,
          turnId: batch.turnId,
          callIndex,
          toolCall,
          sequence: nextSequence + callIndex,
          createdAt: batch.createdAt,
        }),
      );
      const events = starts.map((start) =>
        createRuntimeTranscriptToolStartEvent({
          sessionId: this.id,
          invocationId: batch.invocationId,
          runId: batch.runId,
          turnId: batch.turnId,
          start,
          ...(batch.refs ? { refs: batch.refs } : {}),
        }),
      );
      await appendRuntimeEventBatchWithArbitration(store, events, { ownerFence });
      return structuredClone(starts);
    });
  }

  /** Session 发起的 durable 操作共用一条队列。 */
  private enqueuePersistence<Result>(
    kind: string,
    write: (store: SqliteRuntimeEventStore, ownerFence: RuntimeOwnerFence) => Promise<Result>,
  ): Promise<Result> {
    this.assertWritable();
    const store = this.store;
    if (!store) throw new Error("Session persistence is disabled");

    const operation = this.persistenceTail.then(() =>
      this.runWithWriteAdmission(async () => {
        const ownerFence = await this.assertRuntimeEventWriteAllowed();
        const result = await write(store, ownerFence);
        const confirmedFence = await this.assertRuntimeEventWriteAllowed();
        if (confirmedFence.epoch !== ownerFence.epoch) {
          throw new LeaseConflictError(
            `Runtime Session ${this.id} owner fence changed during write`,
          );
        }
        return result;
      }),
    );
    const settled = operation.then(
      () => undefined,
      (error: unknown) => {
        this.markWriteUncertain(`${kind} durable commit failed`, error);
      },
    );
    this.persistenceTail = settled;
    return operation;
  }

  private assertWritable(): void {
    if (this.persistenceFailure) throw this.persistenceFailure;
    if (this.lifecycle === "open") return;
    if (this.lifecycle === "closing" && this.writeAdmission.getStore()?.active) return;
    throw new SessionWriteUncertainError(`Session is not writable (${this.lifecycle})`);
  }

  private runWithWriteAdmission<Result>(operation: () => Promise<Result>): Promise<Result> {
    const admission = { active: true };
    return this.writeAdmission.run(admission, async () => {
      try {
        return await operation();
      } finally {
        admission.active = false;
      }
    });
  }

  private markWriteUncertain(message: string, cause: unknown): void {
    if (this.lifecycle === "closed") return;
    if (this.persistenceFailure) return;
    const error =
      cause instanceof SessionWriteUncertainError
        ? cause
        : new SessionWriteUncertainError(message, cause);
    this.persistenceFailure = error;
    if (this.lifecycle !== "closing") this.lifecycle = "write_uncertain";
    logger.error({ error: String(cause) }, `[session] ${message}; 已进入 write_uncertain`);
  }

  /**
   * 发起关闭：同步停止接收新的 serialize 任务，返回的 Promise 在已接纳
   * 的任务与 RuntimeEvent tail 完全 drain 后关闭资源并 resolve。
   * 幂等(重复调用安全)。
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.acceptingSerializedTasks = false;
    this.lifecycle = "closing";
    const drain = this.runQueue
      .then(() => this.persistenceTail)
      .then(async () => {
        const store = this.store;
        const ownership =
          this.runtimeOwnership ?? (await this.runtimeOwnershipPromise?.catch(() => undefined));
        this.store = undefined;
        this.runtimeOwnership = undefined;
        this.runtimeOwnershipPromise = undefined;
        this.runtimeOwnerFence = undefined;
        let closeError: unknown;
        try {
          this.goalBinding?.unsubscribe();
          this.goalBinding = undefined;
        } catch (error) {
          closeError = error;
        }
        try {
          store?.close();
        } catch (error) {
          closeError ??= error;
        }
        try {
          await ownership?.release();
        } catch (error) {
          closeError ??= error;
        } finally {
          this.lifecycle = "closed";
        }
        if (closeError) throw closeError;
      });
    this.closePromise = registerSessionDrain(
      sessionEntryKey(this.id, this.workDir, this.picoHome, this.runtimeStorageRoot),
      drain,
    );
    return this.closePromise;
  }
}

export function deriveDurableRuntimeForkCheckpoint(
  events: readonly RuntimeEvent[],
): DurableRuntimeForkCheckpoint | undefined {
  const modelHead = materializeRuntimeHistoryEntries(events)[0];
  if (!modelHead) return undefined;
  const checkpoint = events.find(
    (event) => event.eventId === modelHead.eventId && event.kind === "context.checkpoint.recorded",
  );
  if (!checkpoint || checkpoint.kind !== "context.checkpoint.recorded") return undefined;
  const summary = checkpoint.data.summary;
  const checkpointThroughEventId = checkpoint.data.throughEventId;

  const transcript = projectRuntimeSessionMessageEntries(events);
  let throughEventId = checkpointThroughEventId;
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(throughEventId)) {
      throw new Error(`Runtime checkpoint lineage contains a cycle at ${throughEventId}`);
    }
    visited.add(throughEventId);

    const transcriptIndex = transcript.findIndex((entry) => entry.eventId === throughEventId);
    if (transcriptIndex >= 0) {
      return {
        coveredMessageCount: transcriptIndex + 1,
        summary: structuredClone(summary),
      };
    }

    const parent = events.find(
      (event) => event.eventId === throughEventId && event.kind === "context.checkpoint.recorded",
    );
    if (!parent || parent.kind !== "context.checkpoint.recorded") {
      throw new Error(
        `Runtime checkpoint ${checkpoint.eventId} cannot resolve transcript boundary ${throughEventId}`,
      );
    }
    throughEventId = parent.data.throughEventId;
  }
}

function runtimeCursorForEntries(
  sessionId: string,
  entries: readonly RuntimeEventStoreEntry[],
): SessionCursor | undefined {
  const head = entries.at(-1);
  return head ? runtimeCursorForEntry(sessionId, entries, head) : undefined;
}

function runtimeCursorForEntry(
  sessionId: string,
  entries: readonly RuntimeEventStoreEntry[],
  entry: RuntimeEventStoreEntry,
): SessionCursor {
  // Rewind/branch mechanism removed: epoch is always 0 (no history.rewound is produced).
  // The field is retained in SessionCursor for persisted-schema stability.
  void entries;
  return {
    logId: sessionId,
    seq: entry.sequence,
    epoch: 0,
    eventId: entry.event.eventId,
  };
}

function commitReceiptFromAppend(result: RuntimeEventStoreAppendResult): CommitReceipt {
  return {
    eventId: result.cursor.eventId,
    cursor: result.cursor,
    committedAt: result.committedAt,
    durable: true,
    inserted: result.inserted,
  };
}

async function resolveRuntimeRootSessionId(
  store: SqliteRuntimeEventStore,
  sessionId: string,
): Promise<string> {
  const visited = new Set<string>();
  let current = sessionId;
  while (!visited.has(current)) {
    visited.add(current);
    // by_kind 首条点查(票 04):沿 fork 父链逐会话取首个 session.forked 标记,
    // 不再为找标记全量读会话事件。
    const forkEntry = await store.readFirstSessionEntryOfKind(current, "session.forked");
    const fork = forkEntry?.event.kind === "session.forked" ? forkEntry.event : undefined;
    if (!fork) return current;
    current = fork.data.parentSessionId;
  }
  throw new Error(`Runtime session lineage contains a cycle at ${current}`);
}

function assertRuntimeCommittedMessage(message: Message): void {
  if (message.toolCallId !== undefined || message.toolResultEvidenceUri !== undefined) {
    throw new Error(
      `Runtime ToolResult projection ${message.toolCallId ?? "without call ID"} cannot be persisted as message.committed`,
    );
  }
}

/** Undo skips system messages and never crosses an in-memory compaction boundary. */
function findUndoCut(
  history: readonly Message[],
  count: number,
): { cutIndex: number; removedCount: number } {
  if (count <= 0) return { cutIndex: history.length, removedCount: 0 };
  let removedCount = 0;
  let cutIndex = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    if (isCompactionSummaryMessage(message)) return { cutIndex: index + 1, removedCount };
    if (message.role !== "user") continue;
    removedCount++;
    if (removedCount === count) {
      cutIndex = index;
      break;
    }
  }
  return { cutIndex, removedCount };
}

function isCompactionSummaryMessage(message: Message): boolean {
  return (
    message.role === "assistant" && message.providerData?.["picoKind"] === "compaction_summary"
  );
}

/** SessionManager is kept as a public re-export for existing consumers. */
export { SessionManager } from "./session-manager.js";

configureDefaultSessionFactory((id, workDir, options) => new Session(id, workDir, options));
export const globalSessionManager = new SessionManager();
