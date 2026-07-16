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
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  isMessageHiddenFromTranscript,
  type CanonicalUsage,
  type Message,
  type UsageReportedField,
} from "../schema/message.js";
import type { CostStatus } from "../observability/pricing.js";
import { logger } from "../observability/logger.js";
import type { TranscriptEvent } from "../presentation/transcript-event-store.js";
import type { CommitReceipt, SessionCursor } from "./session-persistence.js";
import { createSessionIdentity, type SessionIdentity } from "./session-identity.js";
import type { GoalManager } from "./goal-manager.js";
import {
  normalizeSessionRuntimeStatePatch,
  SESSION_RUNTIME_STATE_VERSION,
  type PersistedSessionSettings,
  type SessionHydrationSnapshot,
  type SessionRuntimePersistence,
  type SessionRuntimeStatePatch,
  type SessionRuntimeStateSnapshot,
  type SessionUsageSnapshot,
} from "./session-runtime.js";
import { hasIncompleteToolExchange } from "../context/safe-compaction-boundary.js";
import type { SessionSummaryStore } from "../memory/memory-store.js";
import { createSessionSummaryStore } from "../memory/summary-store.js";
import {
  createFileHistoryState,
  type FileHistoryBackup,
  type FileHistoryState,
  type FileHistoryDiffStat,
  fileHistoryBeginRewindPoint,
  fileHistoryBindSourceEvent,
  fileHistoryDiscardFrom,
  fileHistoryDiffStat,
  fileHistoryDefaultBaseDir,
  fileHistoryLoadState,
  fileHistoryMessageDiffStat,
  fileHistoryPrepareRewind,
  fileHistoryRegisterRoot,
  resolveBackupPath,
} from "../safety/file-history.js";
import { FileHistoryBlobStore } from "../storage/file-history-blob-store.js";
import {
  StorageOperationJournal,
  type RewindStorageOperation,
  type StoredFileState,
} from "../storage/operation-journal.js";
import {
  RewindOperationCoordinator,
  RewindOperationConflictError,
  type NewRewindStorageOperation,
  type RewindWorkspaceTarget,
} from "../storage/rewind-operation-coordinator.js";
import { resolvePicoHome, resolvePicoPaths } from "../paths/pico-paths.js";
import {
  currentRuntimeRun,
  RuntimeRun,
  type RuntimeEventWriteGuard,
} from "../runtime/runtime-run.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  runtimeEventHasModelMessage,
  type RuntimeEventBase,
  type RuntimeEvent,
  type RuntimeHistoryRewoundEvent,
  type RuntimeMessageCommittedEvent,
} from "../runtime/runtime-event.js";
import { materializeRuntimeHistoryEntries } from "../runtime/runtime-event-read-model.js";
import {
  RuntimeEventStore,
  type RuntimeEventStoreAppendResult,
  type RuntimeEventStoreEntry,
  type RuntimeSessionManifest,
  type RuntimeSessionProjectionSnapshot,
} from "../runtime/runtime-event-store.js";
import {
  projectRuntimeSessionMessageEntries,
  projectRuntimeSessionMessages,
  projectRuntimeSessionSequencedMessageEntries,
  projectRuntimeSessionState,
  projectRuntimeSessionTranscriptEventEntries,
} from "../runtime/runtime-session-projection.js";
import { OwnerLease } from "../storage/owner-lease.js";

/** 进程级 per-key drain 表，让不同 SessionManager 实例也不会越过旧 tail。 */
const sessionDrains = new Map<string, Promise<void>>();
const summaryStorePool = new Map<string, { store: SessionSummaryStore; refCount: number }>();

function sessionEntryKey(id: string, workDir: string, picoHome?: string): string {
  return `${resolvePicoPaths(workDir, { picoHome }).workspace.root}\0${id}`;
}

function registerSessionDrain(key: string, drain: Promise<void>): Promise<void> {
  const previous = sessionDrains.get(key);
  const tracked = previous ? Promise.all([previous, drain]).then(() => undefined) : drain;
  sessionDrains.set(key, tracked);
  void tracked.then(
    () => {
      if (sessionDrains.get(key) === tracked) sessionDrains.delete(key);
    },
    () => {
      if (sessionDrains.get(key) === tracked) sessionDrains.delete(key);
    },
  );
  return tracked;
}

function acquireSummaryStore(filePath: string): SessionSummaryStore {
  const existing = summaryStorePool.get(filePath);
  if (existing) {
    existing.refCount++;
    return existing.store;
  }
  const store = createSessionSummaryStore({ persistent: true, filePath });
  summaryStorePool.set(filePath, { store, refCount: 1 });
  return store;
}

function releaseSummaryStore(filePath: string): void {
  const existing = summaryStorePool.get(filePath);
  if (!existing) return;
  existing.refCount = Math.max(0, existing.refCount - 1);
  if (existing.refCount === 0) summaryStorePool.delete(filePath);
}

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
  identity?: SessionIdentity;
}

/** fork 只读边界：hydration 与父日志游标必须指向同一次 durable flush。 */
export interface DurableRuntimeForkCheckpoint {
  /** Target bootstrap replaces this many copied transcript messages with summary. */
  readonly coveredMessageCount: number;
  readonly summary: Message;
}

export interface DurableSessionForkSnapshot {
  readonly hydration: SessionHydrationSnapshot;
  readonly cursor: SessionCursor;
  readonly rootLogId: string;
  readonly modelCheckpoint?: DurableRuntimeForkCheckpoint;
}

/** Immutable target seed published before the Runtime fork bootstrap begins. */
export interface DurableRuntimeForkSeed {
  readonly sourceSessionId: string;
  readonly messages: readonly Message[];
}

export interface DurableTuiRewindHandoff {
  readonly operationId: string;
  readonly inputText: string;
  readonly transcriptIndex: number;
  readonly interactionMode?: PersistedSessionSettings["mode"];
  readonly prePlanMode?: NonNullable<PersistedSessionSettings["prePlanMode"]>;
}

/**
 * Session:一次持续的人机交互过程。
 * 负责维护该会话的完整历史,并提供模型投影副本。
 */
export class Session implements SessionRuntimePersistence, RuntimeEventWriteGuard {
  /** 会话标识(终端目录哈希 / 飞书 ChatID / 微信 OpenID) */
  readonly id: string;
  /** 该会话绑定的物理工作区 */
  readonly workDir: string;
  /** 会话与项目/worktree 的显式身份,供后续 resume 过滤使用。 */
  readonly identity: SessionIdentity;
  /** Frozen state root so a live Session never follows later environment changes. */
  readonly picoHome: string;
  /** Frozen File History root shared by the Session and AgentEngine journals. */
  readonly fileHistoryBaseDir: string;
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
  totalCacheWriteReports = 0;
  totalReasoningReports = 0;
  totalEstimatedCostReports = 0;
  totalIncludedCostReports = 0;
  totalUnknownCostReports = 0;

  private history: Message[] = [];

  /**
   * ToolResult 外挂元数据(按 toolCallId 索引),供 MicroCompaction 判断
   * 缓存年龄 + 使用率。不改 Message schema,只在 Session 层维护。
   * - cachedAt:首次 append 该 ToolResult 的时间戳
   * - accessCount:被 getModelContext 投影给模型的次数
   */
  private toolResultMeta = new Map<string, { cachedAt: number; accessCount: number }>();

  /**
   * deferredMessages:tool 调用顺序完整性保证(3.4)。
   * 当 assistant 发出 toolCalls 但 results 尚未到齐时,后续到达的非 ToolResult 消息
   * 暂存于此,不入 history;待 pendingToolCallIds 清空后逐条重新走 append 入 history。
   * 避免出现"assistant 发起 toolCalls → user 闲聊 → toolResult"的乱序,
   * 模型 API 要求 toolCalls 紧跟 toolResults。
   */
  private deferredMessages: Message[] = [];
  /** 正在等待 ToolResult 的 toolCallId 集合。非空表示有 toolCalls 尚未配对。 */
  private pendingToolCallIds: Set<string> = new Set();
  private readonly inMemoryCommitReceipts = new Map<
    string,
    { readonly message: Message; readonly receipt: CommitReceipt }
  >();
  private inMemoryCommitSeq = 0;

  readonly fileHistory: FileHistoryState = createFileHistoryState();

  conversationId: string;

  /**
   * RuntimeEventStore 是唯一 durable 会话真源。undefined 表示持久化关闭。
   * 默认开启；PICO_PERSISTENCE=0 关闭。
   */
  private store?: RuntimeEventStore;
  private runtimeInitialization?: Promise<RuntimeSessionManifest>;
  private runtimeOwnership?: OwnerLease;
  private runtimeOwnershipPromise?: Promise<OwnerLease>;
  private runtimeProjectionCursor?: SessionCursor;
  private runtimeProjectionBranchId?: string;
  /** Session 发起的 RuntimeEvent 共用一条队列，保留调用顺序。 */
  private persistenceTail: Promise<void> = Promise.resolve();
  private lifecycle: "open" | "write_uncertain" | "closing" | "closed" = "open";
  private persistenceFailure?: SessionWriteUncertainError;
  private closePromise?: Promise<void>;
  /** close() seals task admission before the durable/resource drain starts. */
  private acceptingSerializedTasks = true;
  private pendingSerializedTasks = 0;
  /** Nested admission for the same Session is unsafe and would otherwise self-deadlock. */
  private readonly serializedTask = new AsyncLocalStorage<boolean>();
  /** close 前已接纳的任务/持久化操作在该 token 有效期内可完成写入。 */
  private readonly writeAdmission = new AsyncLocalStorage<{ active: boolean }>();

  private persistedSettings?: PersistedSessionSettings;
  private persistedGoal?: ReturnType<GoalManager["snapshot"]>;
  private goalBinding?: { unsubscribe: () => void };

  /**
   * 并发安全:per-session 串行执行队列。
   * 飞书多群/连发消息时,同一 Session 的 engine.run 必须串行,
   * 否则并发读写 history 导致上下文错乱、孤儿 ToolResult、API 400。
   * 通过 Promise 链实现:每个 run 排队等前一个完成。
   */
  private runQueue: Promise<unknown> = Promise.resolve();

  private summaryStore!: SessionSummaryStore;
  private summaryStoreLeasePath?: string;

  constructor(id: string, workDir: string, options?: SessionOptions) {
    this.id = id;
    this.workDir = workDir;
    this.picoHome = resolvePicoHome({ picoHome: options?.picoHome });
    this.fileHistoryBaseDir = options?.picoHome
      ? resolvePicoPaths(workDir, { picoHome: this.picoHome }).home.fileHistory
      : fileHistoryDefaultBaseDir();
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
    this.createdAt = new Date();
    this.updatedAt = new Date();
    fileHistoryRegisterRoot(this.fileHistory, "workspace", resolve(workDir));
    this.initPersistence(options?.persistence);
    const summaryPath = join(
      resolvePicoPaths(this.workDir, { picoHome: this.picoHome }).workspace.memory,
      "summaries.json",
    );
    if (this.store) {
      this.summaryStore = acquireSummaryStore(summaryPath);
      this.summaryStoreLeasePath = summaryPath;
    } else {
      this.summaryStore = createSessionSummaryStore({ persistent: false, filePath: summaryPath });
    }
  }

  /**
   * 初始化持久化。开关优先级:
   *   1. 构造参数 persistence(显式,优先级最高)—— 测试用它精确控制,避免环境变量在
   *      并行测试间相互污染(vitest 默认并行跑文件,共享 process.env 不安全)。
   *   2. 环境变量 PICO_PERSISTENCE —— 生产入口的全局默认,=0 关闭。
   *   3. 默认开启。
   * durable 事件落点为 workspace runtime.sqlite。
   */
  private initPersistence(explicit?: boolean): void {
    const enabled = explicit ?? process.env.PICO_PERSISTENCE !== "0";
    if (!enabled) return;
    this.store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(this.workDir, { picoHome: this.picoHome }).workspace
        .runtimeDatabase,
    });
  }

  /**
   * 重启后读取 runtime.sqlite manifest + events，重建内存投影。
   * 在 SessionManager.getOrCreate 新建实例时自动调用一次。
   * 持久化关闭时为空操作。
   */
  async recover(): Promise<void> {
    if (this.store) await this.ensureRuntimeOwnership();
    await this.recoverFileHistory();
    if (!this.store) return;
    try {
      const manifest = await this.ensureRuntimeSession();
      const projection = await this.store.readSessionProjection(this.id);
      if (!projection) throw new Error(`Runtime session ${this.id} disappeared during recovery`);
      const entries = projection.entries;
      const events = entries.map(({ event }) => event);
      const runtime = projectRuntimeSessionState(events);
      this.createdAt = new Date(manifest.createdAt);
      this.persistedSettings = runtime.settings;
      this.persistedGoal = runtime.goal;
      this.restoreUsage(runtime.usage);
      this.applyRuntimeHistoryProjection(projection);
      await this.recoverRewindPointBindings(entries);
    } catch (error) {
      this.markWriteUncertain("Runtime session initialize/replay failed", error);
      throw error;
    }
    await this.recoverStorageOperations();
  }

  private ensureRuntimeSession(): Promise<RuntimeSessionManifest> {
    const store = this.store;
    if (!store) return Promise.reject(new Error("Session persistence is disabled"));
    if (this.runtimeInitialization) return this.runtimeInitialization;
    const initialization = this.ensureRuntimeOwnership().then(() =>
      store.initializeSession({ sessionId: this.id, workDir: this.workDir }),
    );
    const tracked = initialization.catch((error: unknown) => {
      if (this.runtimeInitialization === tracked) this.runtimeInitialization = undefined;
      throw error;
    });
    this.runtimeInitialization = tracked;
    return tracked;
  }

  /** One live process owns a durable Session until close; SQLite remains the data authority. */
  private ensureRuntimeOwnership(): Promise<OwnerLease> {
    if (!this.store) return Promise.reject(new Error("Session persistence is disabled"));
    if (this.runtimeOwnership) return Promise.resolve(this.runtimeOwnership);
    if (this.runtimeOwnershipPromise) return this.runtimeOwnershipPromise;

    const paths = resolvePicoPaths(this.workDir, { picoHome: this.picoHome }).workspace;
    const scope = createHash("sha256").update(`${paths.id}\0${this.id}`).digest("hex");
    const acquisition = OwnerLease.acquire({
      leaseDirectory: join(paths.root, "session-owners", scope),
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
    this.history = projectRuntimeSessionMessages(projection.entries.map(({ event }) => event));
    this.deferredMessages = [];
    this.rebuildPendingToolState();
    this.rebuildToolResultMeta();
    const cursor = projection.cursor;
    this.runtimeProjectionCursor = cursor ? { ...cursor } : undefined;
    this.runtimeProjectionBranchId = projection.activeBranchId;
    this.conversationId = cursor ? `${cursor.logId}:${cursor.epoch}` : this.id;
    const lastEvent = projection.entries.at(-1)?.event;
    this.updatedAt = lastEvent ? new Date(lastEvent.at) : this.createdAt;
  }

  private async replayRuntimeHistoryProjection(): Promise<void> {
    const store = this.store;
    if (!store) throw new Error("Session persistence is disabled");
    const projection = await store.readSessionProjection(this.id);
    if (!projection) throw new Error(`Runtime session ${this.id} has no canonical projection`);
    this.applyRuntimeHistoryProjection(projection);
  }

  private applyRuntimeHistoryProjectionDelta(
    messages: readonly Message[],
    cursor: SessionCursor,
    activeBranchId: string,
    updatedAt: string,
  ): void {
    for (const message of messages) {
      this.history.push(message);
      this.applyRuntimeMessageState(message);
    }
    this.runtimeProjectionCursor = { ...cursor };
    this.runtimeProjectionBranchId = activeBranchId;
    this.conversationId = `${cursor.logId}:${cursor.epoch}`;
    this.updatedAt = new Date(updatedAt);
  }

  private applyRuntimeMessageState(message: Message): void {
    if (message.role === "assistant") {
      for (const toolCall of message.toolCalls ?? []) this.pendingToolCallIds.add(toolCall.id);
      return;
    }
    if (message.role !== "user" || !message.toolCallId) return;
    this.pendingToolCallIds.delete(message.toolCallId);
    if (!this.toolResultMeta.has(message.toolCallId)) {
      this.toolResultMeta.set(message.toolCallId, { cachedAt: Date.now(), accessCount: 0 });
    }
  }

  /**
   * 从当前 history 重建 toolResultMeta 表(用于 recover 后或需要重置时)。
   * cachedAt 用当前时间(原始时间未持久化),accessCount 归零。
   */
  private rebuildToolResultMeta(): void {
    this.toolResultMeta = new Map();
    const now = Date.now();
    for (const msg of this.history) {
      if (msg.role === "user" && msg.toolCallId) {
        if (!this.toolResultMeta.has(msg.toolCallId)) {
          this.toolResultMeta.set(msg.toolCallId, { cachedAt: now, accessCount: 0 });
        }
      }
    }
  }

  private rebuildPendingToolState(): void {
    this.pendingToolCallIds.clear();
    for (const message of this.history) {
      if (message.role === "assistant") {
        for (const toolCall of message.toolCalls ?? []) this.pendingToolCallIds.add(toolCall.id);
      } else if (message.role === "user" && message.toolCallId) {
        this.pendingToolCallIds.delete(message.toolCallId);
      }
    }
  }

  /**
   * 清理 history 中已不存在的 ToolResult 对应的 meta 条目。
   * 在 truncate / undo / rewind / compaction 等缩短 history 的操作后调用,
   * 防止 toolResultMeta 无限增长。
   */
  private pruneToolResultMeta(): void {
    if (this.toolResultMeta.size === 0) return;
    const live = new Set<string>();
    for (const msg of this.history) {
      if (msg.role === "user" && msg.toolCallId) live.add(msg.toolCallId);
    }
    for (const id of this.toolResultMeta.keys()) {
      if (!live.has(id)) this.toolResultMeta.delete(id);
    }
  }

  private async recoverFileHistory(): Promise<void> {
    try {
      await fileHistoryLoadState(this.fileHistory, this.id, this.fileHistoryBaseDir);
      if (!this.fileHistory.roots.has("workspace")) {
        fileHistoryRegisterRoot(this.fileHistory, "workspace", resolve(this.workDir));
      }
    } catch (error) {
      logger.warn({ error: String(error) }, "[session] 文件历史恢复失败,降级为空快照");
    }
  }

  private async recoverRewindPointBindings(
    entries: readonly RuntimeEventStoreEntry[],
  ): Promise<void> {
    const events = new Map(
      entries
        .filter(
          (entry): entry is RuntimeEventStoreEntry & { event: RuntimeMessageCommittedEvent } =>
            entry.event.kind === "message.committed",
        )
        .map((entry) => [entry.event.eventId, entry] as const),
    );
    for (const snapshot of this.fileHistory.snapshots) {
      if (snapshot.sourceMessageEventId) continue;
      const eventId = `user-message:${snapshot.messageId}`;
      const event = events.get(eventId);
      if (!event) continue;
      await fileHistoryBindSourceEvent(
        this.fileHistory,
        {
          messageId: snapshot.messageId,
          sourceMessageEventId: event.event.eventId,
          beforeSessionSeq: snapshot.beforeSessionSeq ?? event.sequence,
        },
        this.id,
        this.fileHistoryBaseDir,
      );
    }
  }

  private async recoverStorageOperations(): Promise<void> {
    const results = await this.createRewindCoordinator().reconcileUnfinished(this.id);
    for (const result of results) {
      if (result.state === "needs_attention") {
        logger.warn(
          { operationId: result.operationId, sessionId: this.id },
          "[rewind] 未完成操作检测到外部冲突，等待人工处理",
        );
      }
    }
  }

  /**
   * 串行执行一个任务:同一 Session 的多个调用自动排队,
   * 保证同一时刻只有一个 engine.run 在操作 history。
   * 返回任务的 Promise(结果需调用方 await)。
   */
  serialize<T>(task: () => Promise<T>): Promise<T> {
    if (this.serializedTask.getStore()) {
      return Promise.reject(
        new Error(`Session ${this.id} does not support re-entrant serialized execution`),
      );
    }
    if (!this.acceptingSerializedTasks || this.lifecycle !== "open") {
      const state = this.acceptingSerializedTasks ? this.lifecycle : "closing";
      return Promise.reject(new Error(`Session ${this.id} is ${state}`));
    }
    this.pendingSerializedTasks++;
    const runTask = (): Promise<T> =>
      this.serializedTask.run(true, () =>
        this.runWithWriteAdmission(async () => {
          try {
            return await task();
          } finally {
            this.pendingSerializedTasks--;
          }
        }),
      );
    const result = this.runQueue.then(runTask, runTask);
    // 无论成功失败,都更新队列链;吞掉错误让调用方自己的 catch 处理
    this.runQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
    if (reported.has("cacheRead")) this.totalCacheReadReports++;
    if (reported.has("cacheWrite")) this.totalCacheWriteReports++;
    if (reported.has("reasoning")) this.totalReasoningReports++;
    this.updateRuntimeState({ usage: this.getUsageSnapshot() });
  }

  /** Record a completed provider call whose response did not include usage metadata. */
  recordMissingUsage(): void {
    this.assertWritable();
    this.totalProviderCalls++;
    this.updateRuntimeState({ usage: this.getUsageSnapshot() });
  }

  /** 返回与内部状态隔离的运行态快照，供启动恢复和 TUI 状态水合。 */
  getRuntimeStateSnapshot(): SessionRuntimeStateSnapshot {
    const snapshot: SessionRuntimeStateSnapshot = {
      stateVersion: SESSION_RUNTIME_STATE_VERSION,
      ...(this.persistedSettings ? { settings: this.persistedSettings } : {}),
      ...(this.persistedGoal ? { goal: this.persistedGoal } : {}),
      usage: this.getUsageSnapshot(),
    };
    return structuredClone(snapshot);
  }

  /** 更新一个完整 section，内存立即生效，然后追加 session.state.committed。 */
  updateRuntimeState(patch: SessionRuntimeStatePatch): void {
    this.assertWritable();
    const normalized = normalizeSessionRuntimeStatePatch(patch);
    if (!normalized) {
      logger.warn("[session] 忽略无效的 runtime_state 更新");
      return;
    }
    if (normalized.settings) this.persistedSettings = normalized.settings;
    if (normalized.goal) this.persistedGoal = normalized.goal;
    if (normalized.usage) this.restoreUsage(normalized.usage);
    this.updatedAt = new Date();

    if (this.store) {
      const persisted = structuredClone(normalized);
      void this.enqueuePersistence("runtime state", async (store) => {
        await this.ensureRuntimeSession();
        return store.appendSessionState(this.id, persisted);
      }).catch((error: unknown) => {
        logger.error({ error: String(error) }, "[session] runtime state 持久化失败");
      });
    }
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
        messages: structuredClone(this.history),
        messageSequences: this.history.map((_, index) => index + 1),
        transcriptEvents: [],
        transcriptEventSequences: [],
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
    const modelCheckpoint = durableForkModelCheckpoint(events);
    return {
      hydration: this.runtimeHydrationSnapshot(manifest, entries),
      rootLogId: await resolveRuntimeRootSessionId(store, this.id),
      cursor,
      ...(modelCheckpoint ? { modelCheckpoint } : {}),
    };
  }

  /**
   * Reads the original fork seed rather than the mutable current Session projection.
   * Runtime uses this durable boundary to resume a fork bootstrap after interruption.
   */
  async readDurableRuntimeForkSeed(): Promise<DurableRuntimeForkSeed | undefined> {
    await this.flushPersistence();
    const store = this.store;
    if (!store) return undefined;
    await this.ensureRuntimeSession();
    const events = await store.readSession(this.id);
    const seedIndex = events.findIndex(
      (event) => event.kind === "session.forked" && event.data.sourceDigest !== undefined,
    );
    if (seedIndex < 0) return undefined;
    const seed = events[seedIndex]!;
    if (seed.kind !== "session.forked" || seed.data.parentSessionId === this.id) return undefined;
    const messages = projectRuntimeSessionMessages(events.slice(0, seedIndex + 1));
    if (
      seed.data.messageCount !== messages.length ||
      seed.data.sourceDigest !== messageDigest(messages)
    ) {
      throw new Error(`Runtime fork seed ${this.id} 与完成标记不一致`);
    }
    return {
      sourceSessionId: seed.data.parentSessionId,
      messages,
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
    const runtimeRun = currentRuntimeRun();
    await this.enqueuePersistence("messages", async () => {
      await this.ensureRuntimeSession();
      if (runtimeRun?.claimsSession(this)) {
        await runtimeRun.commitMessages(this, msgs);
        return;
      }
      if (!(await RuntimeRun.commitExternalMessages(this, msgs))) {
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
    const runtimeRun = currentRuntimeRun();
    return this.enqueuePersistence("message", async () => {
      await this.ensureRuntimeSession();
      if (runtimeRun?.claimsSession(this)) {
        return runtimeRun.commitMessageOnce(this, eventId, message);
      }
      const receipt = await RuntimeRun.commitExternalMessageOnce(this, eventId, message);
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
    const previousBranchId = this.runtimeProjectionBranchId;
    const targetCursor = commits.at(-1)!.cursor;
    let precedingSequence = previousCursor?.seq ?? -1;
    const commitsAreFreshAndOrdered = commits.every((commit) => {
      const ordered =
        commit.inserted && commit.cursor.logId === this.id && commit.cursor.seq > precedingSequence;
      precedingSequence = commit.cursor.seq;
      return ordered;
    });

    if (
      !previousCursor ||
      !previousBranchId ||
      this.deferredMessages.length > 0 ||
      !commitsAreFreshAndOrdered
    ) {
      await this.replayRuntimeHistoryProjection();
      return;
    }

    const delta = await store.readSessionProjectionDelta(
      this.id,
      previousCursor,
      targetCursor,
      previousBranchId,
    );
    if (!delta || delta.entries.some((entry) => entry.event.kind === "history.rewound")) {
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
        runtimeEventHasModelMessage(entry.event)
      );
    });
    if (!commitsMatchCanonicalMessages) {
      await this.replayRuntimeHistoryProjection();
      return;
    }

    const messages = delta.entries
      .filter((entry): entry is RuntimeEventStoreEntry & { event: RuntimeMessageCommittedEvent } =>
        runtimeEventHasModelMessage(entry.event),
      )
      .map((entry) => structuredClone(entry.event.data.message));
    this.applyRuntimeHistoryProjectionDelta(
      messages,
      delta.cursor,
      delta.activeBranchId,
      delta.entries.at(-1)!.event.at,
    );
  }

  /**
   * RuntimeEvent 已经 durable 后写入 Session 投影的内部入口。
   * 调用方必须使用同一个 RuntimeEvent ID，避免投影重试产生新事实。
   */
  async commitProjectionMessageOnce(eventId: string, message: Message): Promise<CommitReceipt> {
    this.assertWritable();
    if (!eventId.trim()) throw new Error("Session eventId 不能为空");
    if (!this.store) {
      const existing = this.inMemoryCommitReceipts.get(eventId);
      if (existing) {
        if (!isDeepStrictEqual(existing.message, message)) {
          throw new Error(`Session eventId conflict: ${eventId} is already bound to another event`);
        }
        return { ...existing.receipt, inserted: false };
      }
      const prepared = this.prepareAppend(message);
      if (prepared.deferred) {
        throw new Error("Exactly-once message cannot be deferred behind incomplete tool results");
      }
      this.doAppend(message);
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
      if (
        prepared.toolResult &&
        this.pendingToolCallIds.size === 0 &&
        this.deferredMessages.length > 0
      ) {
        const pending = this.deferredMessages;
        this.deferredMessages = [];
        for (const deferred of pending) this.appendOneInMemory(deferred);
      }
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
    const persisted = await this.store.append(entry.event);
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
      this.history = structuredClone([...messages]);
      this.deferredMessages = [];
      this.rebuildPendingToolState();
      this.rebuildToolResultMeta();
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
    const normalized = normalizeSessionRuntimeStatePatch({ usage })?.usage;
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

  private prepareAppend(msg: Message): {
    readonly deferred: boolean;
    readonly toolResult: boolean;
  } {
    const hasToolCalls =
      msg.role === "assistant" && msg.toolCalls !== undefined && msg.toolCalls.length > 0;
    const isToolResult = msg.role === "user" && msg.toolCallId !== undefined;

    // 1. assistant 带 toolCalls:登记 pendingToolCallIds,然后正常入 history
    //    (toolCalls 消息是配对的源头,绝不能延迟,否则 ToolResult 变孤儿)
    if (hasToolCalls && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        this.pendingToolCallIds.add(tc.id);
      }
    }

    // 2. ToolResult 到达:从 pending 删除;记录 toolResultMeta
    if (isToolResult && msg.toolCallId) {
      this.pendingToolCallIds.delete(msg.toolCallId);
      // 记录元数据(cachedAt = 当前时间,accessCount 后续 bump)
      if (!this.toolResultMeta.has(msg.toolCallId)) {
        this.toolResultMeta.set(msg.toolCallId, {
          cachedAt: Date.now(),
          accessCount: 0,
        });
      }
    }

    // 3. 决定是否暂存:普通消息(非 ToolResult、非带 toolCalls 的 assistant)
    //    且 pendingToolCallIds 非空 → 暂存,不入 history
    //    ToolResult 与 带 toolCalls 的 assistant 永远直接入 history
    const isDeferredCandidate = !isToolResult && !hasToolCalls;
    if (isDeferredCandidate && this.pendingToolCallIds.size > 0) {
      this.deferredMessages.push(msg);
      return { deferred: true, toolResult: isToolResult };
    }
    return { deferred: false, toolResult: isToolResult };
  }

  private appendOneInMemory(msg: Message): void {
    const prepared = this.prepareAppend(msg);
    if (prepared.deferred) return;
    this.doAppend(msg);
    if (
      prepared.toolResult &&
      this.pendingToolCallIds.size === 0 &&
      this.deferredMessages.length > 0
    ) {
      const pending = this.deferredMessages;
      this.deferredMessages = [];
      for (const deferred of pending) this.appendOneInMemory(deferred);
    }
  }

  /** persistence:false 兼容路径。 */
  private doAppend(msg: Message): void {
    this.history.push(msg);
    this.updatedAt = new Date();
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
    const nextHistory = fromIndex >= this.history.length ? [] : this.history.slice(fromIndex);
    if (this.store) {
      await this.replaceRuntimeHistory(nextHistory, "truncate");
      return;
    }
    this.history = nextHistory;
    this.pruneToolResultMeta();
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
    const { cutIndex, removedCount } = findUndoCut(this.history, count);
    if (removedCount === 0) return;
    const runtimeBranchId = `undo:${randomUUID()}`;
    if (this.store) {
      await this.commitRuntimeRewind(cutIndex, runtimeBranchId);
      return;
    }
    const nextHistory = this.history.slice(0, cutIndex);
    this.history = nextHistory;
    this.pruneToolResultMeta();
    // 3.4: undo 时清空 deferred 与 pending,避免遗留半截 tool 配对状态
    this.deferredMessages = [];
    this.pendingToolCallIds.clear();
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
        userPrompt: input.userPrompt,
        messageIndex: this.history.length,
        ...(input.transcriptIndex !== undefined ? { transcriptIndex: input.transcriptIndex } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        ...(input.prePlanMode !== undefined ? { prePlanMode: input.prePlanMode } : {}),
        beforeSessionSeq,
      },
      this.id,
      this.fileHistoryBaseDir,
    );
    return messageId;
  }

  async bindRewindPointSource(messageId: string, receipt: CommitReceipt): Promise<void> {
    this.assertWritable();
    const snapshot = this.fileHistory.snapshots.find(
      (candidate) => candidate.messageId === messageId,
    );
    await fileHistoryBindSourceEvent(
      this.fileHistory,
      {
        messageId,
        sourceMessageEventId: receipt.eventId,
        beforeSessionSeq: snapshot?.beforeSessionSeq ?? receipt.cursor.seq,
      },
      this.id,
      this.fileHistoryBaseDir,
    );
  }

  async rewindTo(messageIndex: number): Promise<void> {
    await this.rewindConversationOnce(undefined, messageIndex);
  }

  /** Rewind Saga 以 operationId 作事件幂等键。 */
  async rewindOnce(operationId: string, messageIndex: number): Promise<CommitReceipt | undefined> {
    if (!operationId.trim()) throw new Error("Rewind operationId 不能为空");
    return this.rewindConversationOnce(`rewind:${operationId}`, messageIndex);
  }

  private async rewindConversationOnce(
    eventId: string | undefined,
    messageIndex: number,
  ): Promise<CommitReceipt | undefined> {
    this.assertWritable();
    const runtimeBranchId = eventId ?? `rewind:${randomUUID()}`;
    if (this.store) return this.commitRuntimeRewind(messageIndex, runtimeBranchId);
    const nextHistory = this.history.slice(0, messageIndex);
    this.history = nextHistory;
    this.pruneToolResultMeta();
    this.deferredMessages = [];
    this.pendingToolCallIds.clear();
    this.conversationId = `${this.id}-${Date.now().toString(36)}`;
    this.updatedAt = new Date();
    return undefined;
  }

  private commitRuntimeRewind(messageIndex: number, eventId: string): Promise<CommitReceipt> {
    return this.enqueuePersistence("rewind", async (store) => {
      await this.ensureRuntimeSession();
      const entries = await store.readSessionEntries(this.id);
      const existing = entries.find((entry) => entry.event.eventId === eventId);
      if (existing) {
        if (existing.event.kind !== "history.rewound" || existing.event.data.branchId !== eventId) {
          throw new Error(`Runtime event ID ${eventId} is already bound to another payload`);
        }
        await this.replayRuntimeHistoryProjection();
        return commitReceiptFromEntry(this.id, entries, existing, false);
      }

      const messages = projectRuntimeSessionMessageEntries(entries.map(({ event }) => event));
      const retainedCount = Math.max(0, Math.min(Math.trunc(messageIndex), messages.length));
      const throughEventId = messages[retainedCount - 1]?.eventId;
      const event: RuntimeHistoryRewoundEvent = {
        ...this.runtimeEventBase(eventId, "session-rewind", "internal"),
        kind: "history.rewound",
        data: { branchId: eventId, ...(throughEventId ? { throughEventId } : {}) },
      };
      const appended = await store.append(event);
      await this.replayRuntimeHistoryProjection();
      return commitReceiptFromAppend(appended);
    });
  }

  async rewindCode(
    messageId: string,
    expectedCurrentFingerprints?: ReadonlyMap<string, string>,
  ): Promise<void> {
    this.assertWritable();
    const snapshot = this.requireRewindSnapshot(messageId);
    await this.executeRewindOperation(
      "code",
      snapshot,
      snapshot.messageIndex ?? this.history.length,
      randomUUID(),
      expectedCurrentFingerprints,
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

  async rewindConversation(messageIndex: number, messageId?: string): Promise<void> {
    this.assertWritable();
    if (!messageId) {
      await this.rewindTo(messageIndex);
      return;
    }
    await this.executeRewindOperation(
      "conversation",
      this.requireRewindSnapshot(messageId),
      messageIndex,
    );
  }

  async rewindBoth(
    messageId: string,
    messageIndex: number,
    expectedCurrentFingerprints?: ReadonlyMap<string, string>,
  ): Promise<void> {
    this.assertWritable();
    await this.executeRewindOperation(
      "both",
      this.requireRewindSnapshot(messageId),
      messageIndex,
      randomUUID(),
      expectedCurrentFingerprints,
    );
  }

  private requireRewindSnapshot(messageId: string): FileHistoryState["snapshots"][number] {
    const snapshot = this.fileHistory.snapshots.find(
      (candidate) => candidate.messageId === messageId,
    );
    if (!snapshot) throw new Error(`FileHistory: 找不到 messageId=${messageId} 的快照`);
    return snapshot;
  }

  private async executeRewindOperation(
    mode: NewRewindStorageOperation["mode"],
    snapshot: FileHistoryState["snapshots"][number],
    messageIndex: number,
    operationId = randomUUID(),
    expectedCurrentFingerprints?: ReadonlyMap<string, string>,
  ): Promise<void> {
    await this.flushPersistence();
    const coordinator = this.createRewindCoordinator();
    const operation = await coordinator.executePrepared(async () => {
      const files =
        mode === "conversation"
          ? []
          : await this.buildRewindFileTransitions(snapshot.messageId, expectedCurrentFingerprints);
      const head = await this.store?.getHeadCursor(this.id);
      return {
        operationId,
        kind: "rewind",
        sessionId: this.id,
        mode,
        precondition: {
          sessionLastSeq: Math.max(0, head?.seq ?? 0),
          effectiveHistoryDigest: sessionHistoryDigest(this.history),
          fileHistoryRevision: this.fileHistory.revision,
        },
        target: {
          messageId: snapshot.messageId,
          ...(snapshot.sourceMessageEventId
            ? { sourceMessageEventId: snapshot.sourceMessageEventId }
            : {}),
          messageIndex,
          ...(snapshot.userPrompt !== undefined ? { userPrompt: snapshot.userPrompt } : {}),
          ...(snapshot.transcriptIndex !== undefined
            ? { transcriptIndex: snapshot.transcriptIndex }
            : {}),
          ...(isPersistedInteractionMode(snapshot.interactionMode)
            ? { interactionMode: snapshot.interactionMode }
            : {}),
          ...(snapshot.interactionMode === "plan" && isPersistedPrePlanMode(snapshot.prePlanMode)
            ? { prePlanMode: snapshot.prePlanMode }
            : {}),
        },
        files,
      };
    });
    if (operation.state === "needs_attention") {
      const conflicts = operation.error?.conflictingPaths?.join(", ");
      throw new Error(
        conflicts
          ? `Rewind 需要人工处理：工作区已发生外部变化 (${conflicts})`
          : `Rewind 需要人工处理：${operation.error?.message ?? "unknown conflict"}`,
      );
    }
  }

  private createRewindCoordinator(): RewindOperationCoordinator {
    const baseDir = this.fileHistoryBaseDir;
    return new RewindOperationCoordinator({
      journal: new StorageOperationJournal({
        workDir: this.workDir,
        picoHome: this.picoHome,
      }),
      blobStore: new FileHistoryBlobStore({ baseDir }),
      callbacks: {
        resolveRoot: (rootId) => this.fileHistory.roots.get(rootId),
        validatePrecondition: async (operation) => {
          await this.validateRewindPrecondition(operation);
        },
        applyWorkspace: async (operation, targets) => {
          await applyRewindWorkspaceTargets(operation.operationId, targets);
        },
        commitSession: async (operation) => {
          if (operation.sessionId !== this.id) {
            throw new Error(`Rewind operation ${operation.operationId} 不属于当前 Session`);
          }
          if (operation.mode !== "code") {
            await this.rewindOnce(operation.operationId, operation.target.messageIndex);
            await this.commitRewindRuntimeMode(operation);
          }
        },
        commitSidecars: async (operation) => {
          if (operation.mode === "code") return;
          await fileHistoryDiscardFrom(
            this.fileHistory,
            operation.target.messageId,
            this.id,
            this.fileHistoryBaseDir,
          );
          this.summaryStore.invalidateIfBeyond?.(this.id, {
            throughEventId: operation.target.sourceMessageEventId ?? null,
            messageCount: operation.target.messageIndex,
            prefixDigest: null,
          });
        },
      },
    });
  }

  /**
   * completed rewind 在下一条显式用户消息提交前持续作为 TUI handoff。
   * 因此 UI 应用后立即崩溃也不会丢失原 prompt；重启只会幂等回填。
   */
  async getPendingTuiRewindHandoff(): Promise<DurableTuiRewindHandoff | undefined> {
    if (!this.store) return undefined;
    await this.flushPersistence();
    const operations = (
      await new StorageOperationJournal({
        workDir: this.workDir,
        picoHome: this.picoHome,
      }).list()
    ).filter(
      (operation): operation is RewindStorageOperation =>
        operation.kind === "rewind" &&
        operation.sessionId === this.id &&
        operation.state === "completed" &&
        operation.mode !== "code" &&
        typeof operation.target.userPrompt === "string" &&
        operation.target.transcriptIndex !== undefined,
    );
    if (operations.length === 0) return undefined;
    const entries = await this.store.readSessionEntries(this.id);
    for (const operation of operations.toReversed()) {
      const rewind = entries.find(
        (entry) => entry.event.eventId === `rewind:${operation.operationId}`,
      );
      if (!rewind || rewind.event.kind !== "history.rewound") continue;
      const superseded = entries.some(
        (entry) =>
          entry.sequence > rewind.sequence &&
          entry.event.kind === "message.committed" &&
          entry.event.visibility === "model" &&
          !entry.event.partial &&
          entry.event.data.message.role === "user" &&
          entry.event.data.message.toolCallId === undefined &&
          !isMessageHiddenFromTranscript(entry.event.data.message),
      );
      if (superseded) return undefined;
      return {
        operationId: operation.operationId,
        inputText: operation.target.userPrompt!,
        transcriptIndex: operation.target.transcriptIndex!,
        ...(operation.target.interactionMode
          ? { interactionMode: operation.target.interactionMode }
          : {}),
        ...(operation.target.prePlanMode ? { prePlanMode: operation.target.prePlanMode } : {}),
      };
    }
    return undefined;
  }

  private async commitRewindRuntimeMode(operation: RewindStorageOperation): Promise<void> {
    const mode = operation.target.interactionMode;
    if (!mode || !this.persistedSettings) return;
    const settings = restorePersistedInteractionMode(
      this.persistedSettings,
      mode,
      operation.target.prePlanMode,
    );
    const patch: SessionRuntimeStatePatch = { settings };
    if (this.store) {
      await this.commitRuntimeStateOnce(patch, `rewind:${operation.operationId}:runtime`);
    }
    this.persistedSettings = settings;
    this.updatedAt = new Date();
  }

  private commitRuntimeStateOnce(
    patch: SessionRuntimeStatePatch,
    eventId: string,
  ): Promise<CommitReceipt> {
    return this.enqueuePersistence("runtime state", async (store) => {
      await this.ensureRuntimeSession();
      const entries = await store.readSessionEntries(this.id);
      const existing = entries.find((entry) => entry.event.eventId === eventId);
      if (existing) {
        if (
          existing.event.kind !== "session.state.committed" ||
          !isDeepStrictEqual(existing.event.data.patch, patch)
        ) {
          throw new Error(`Runtime event ID ${eventId} is already bound to another payload`);
        }
        return commitReceiptFromEntry(this.id, entries, existing, false);
      }
      return commitReceiptFromAppend(
        await store.appendSessionState(this.id, structuredClone(patch), { eventId }),
      );
    });
  }

  private async buildRewindFileTransitions(
    messageId: string,
    expectedCurrentFingerprints?: ReadonlyMap<string, string>,
  ): Promise<NewRewindStorageOperation["files"]> {
    const baseDir = this.fileHistoryBaseDir;
    const prepared = await fileHistoryPrepareRewind(this.fileHistory, messageId, this.id, baseDir, {
      ...(expectedCurrentFingerprints ? { expectedCurrentFingerprints } : {}),
    });
    const blobStore = new FileHistoryBlobStore({ baseDir });
    const files: NewRewindStorageOperation["files"] = [];
    for (const file of prepared.files) {
      const location = resolveFileHistoryLocation(this.fileHistory.roots, file.filePath);
      const before = await storedPreimageState(file.backup, this.id, baseDir, blobStore);
      const after = await storedCurrentState(file.filePath, blobStore);
      files.push({ ...location, before, after });
    }
    return files;
  }

  private async validateRewindPrecondition(operation: RewindStorageOperation): Promise<void> {
    const entries = this.store ? await this.store.readSessionEntries(this.id) : [];
    const eventId = `rewind:${operation.operationId}`;
    const existing = entries.find((entry) => entry.event.eventId === eventId);
    if (existing) {
      if (existing.event.kind === "history.rewound" && existing.event.data.branchId === eventId) {
        return;
      }
      throw new RewindOperationConflictError(
        `Rewind operationId ${operation.operationId} 已被其他 Session 事件使用`,
        [],
      );
    }

    const currentSeq = Math.max(0, (await this.store?.getHeadCursor(this.id))?.seq ?? 0);
    const currentDigest = sessionHistoryDigest(this.history);
    const mismatches = [
      ...(currentSeq !== operation.precondition.sessionLastSeq
        ? [`session seq ${currentSeq} != ${operation.precondition.sessionLastSeq}`]
        : []),
      ...(currentDigest !== operation.precondition.effectiveHistoryDigest
        ? ["effective history digest changed"]
        : []),
      ...(operation.state === "prepared" &&
      this.fileHistory.revision !== operation.precondition.fileHistoryRevision
        ? [
            `file history revision ${this.fileHistory.revision} != ${operation.precondition.fileHistoryRevision}`,
          ]
        : []),
    ];
    if (mismatches.length > 0) {
      throw new RewindOperationConflictError(
        `Rewind precondition drifted: ${mismatches.join("; ")}`,
        [],
      );
    }
  }

  /**
   * 模型摘要压缩:用一条 role:assistant 的 summary 消息替换 history 前 compactedCount 条。
   * 对标 kimi-code applyCompaction —— 真改 Session.history(与字符级 Compactor 不同,
   * 字符级只改临时 context 不碰 Session)。
   *
   * 内存语义:history = [summaryMsg, ...history.slice(compactedCount)]。
   * 保留尾部(从 compactedCount 起的消息)不动,前缀浓缩成一条摘要。
   *
   * 持久化通过 RuntimeEvent rewind + message facts 重建活动分支。
   *
   * 本方法只做纯存储,summary 内容的 REFERENCE-ONLY 包装由调用方(FullCompactor)负责。
   *
   * @param summary 摘要消息正文(已由调用方套上 REFERENCE-ONLY 前后标记)
   * @param compactedCount 被压缩的前缀条数(0..history.length)
   */
  async applyCompaction(
    summary: string,
    compactedCount: number,
    options: { readonly summaryProviderData?: Record<string, unknown> } = {},
  ): Promise<void> {
    this.assertWritable();
    if (compactedCount < 0) compactedCount = 0;
    if (compactedCount > this.history.length) compactedCount = this.history.length;
    const retained = this.history.slice(compactedCount);
    // 摘要消息:role=assistant(对标 kimi-code compaction_summary)
    const summaryMsg: Message = {
      role: "assistant",
      content: summary,
      providerData: { ...options.summaryProviderData, picoKind: "compaction_summary" },
    };
    const nextHistory = [summaryMsg, ...retained];
    if (this.store) {
      await this.replaceRuntimeHistory(nextHistory, "compaction");
      return;
    }
    this.history = nextHistory;
    // 压缩后清理已消失 ToolResult 的 meta(被摘要吞掉的前缀条目)
    this.pruneToolResultMeta();
    this.updatedAt = new Date();
  }

  private replaceRuntimeHistory(messages: readonly Message[], reason: string): Promise<void> {
    const operationId = `${reason}:${randomUUID()}`;
    return this.enqueuePersistence(reason, async (store) => {
      await this.ensureRuntimeSession();
      const rewindEvent: RuntimeHistoryRewoundEvent = {
        ...this.runtimeEventBase(`${operationId}:rewind`, "session-history", "internal"),
        kind: "history.rewound",
        data: { branchId: operationId },
      };
      const events: RuntimeEvent[] = [rewindEvent];
      for (const [index, message] of messages.entries()) {
        const event: RuntimeMessageCommittedEvent = {
          ...this.runtimeEventBase(`${operationId}:message:${index}`, "session-history", "model"),
          kind: "message.committed",
          data: { message: structuredClone(message) },
        };
        events.push(event);
      }
      await store.appendBatch(events);
      await this.replayRuntimeHistoryProjection();
    });
  }

  private runtimeEventBase(
    eventId: string,
    runId: string,
    visibility: RuntimeEventBase["visibility"],
  ): RuntimeEventBase {
    return {
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      eventId,
      sessionId: this.id,
      invocationId: `session:${this.id}`,
      runId,
      turnId: runId,
      at: new Date().toISOString(),
      partial: false,
      visibility,
    };
  }

  /** 全量历史深拷贝，供宿主投影、诊断与压缩读取，不作为 Provider 的直接投影策略。 */
  getHistory(): Message[] {
    return structuredClone(this.history);
  }

  /** 当前历史消息条数 */
  get length(): number {
    return this.history.length;
  }

  /**
   * Return the complete model-visible history. Unlike the legacy sliding
   * window this never splits or drops a tool exchange; token-pressure policy
   * belongs to the projection/compaction layer.
   */
  getModelContext(): Message[] {
    const context = this.history.map((message) => ({ ...message }));
    for (const message of context) {
      if (message.role !== "user" || message.toolCallId === undefined) continue;
      const meta = this.toolResultMeta.get(message.toolCallId);
      if (meta) meta.accessCount++;
    }
    return context;
  }

  /** True only while the tail tool exchange is still waiting for results. */
  hasPendingToolResults(): boolean {
    return hasIncompleteToolExchange(this.history);
  }

  /**
   * 暴露 ToolResult 外挂元数据(按 toolCallId 索引),供 MicroCompaction
   * 读取缓存年龄与使用率。返回只读视图。
   */
  getToolResultMeta(): ReadonlyMap<string, { cachedAt: number; accessCount: number }> {
    return this.toolResultMeta;
  }

  saveMemorySummary(summary: string, messageCount: number): void {
    this.assertWritable();
    this.summaryStore.save(this.id, summary, messageCount);
  }

  /** Durable event authority; undefined only for explicitly in-memory sessions. */
  get runtimeEventStore(): RuntimeEventStore | undefined {
    return this.store;
  }

  /** RuntimeRun's only authority over Session ownership; the lease itself stays private here. */
  async assertRuntimeEventWriteAllowed(): Promise<void> {
    this.assertWritable();
    let ownership: OwnerLease;
    try {
      ownership = await this.ensureRuntimeOwnership();
      await ownership.assertOwnership();
    } catch (error) {
      this.markWriteUncertain("Runtime Session owner lease validation failed", error);
      throw this.persistenceFailure ?? error;
    }
    this.assertWritable();
  }

  /** Append one structured transcript fact to the same canonical RuntimeEvent ledger. */
  async recordTranscriptEvent(
    event: TranscriptEvent,
    options: { readonly eventId?: string } = {},
  ): Promise<CommitReceipt> {
    const durableEvent = structuredClone(event);
    return this.enqueuePersistence("transcript event", async (store) => {
      await this.ensureRuntimeSession();
      const runtimeEventId = options.eventId ?? `transcript:${durableEvent.eventId}`;
      const entries = await store.readSessionEntries(this.id);
      const existing = entries.find((entry) => entry.event.eventId === runtimeEventId);
      if (!existing) {
        const projected = projectRuntimeSessionTranscriptEventEntries(entries);
        const expectedSequence = (projected.at(-1)?.event.sequence ?? 0) + 1;
        if (durableEvent.sequence !== expectedSequence) {
          throw new Error(
            `Transcript event sequence mismatch: ${durableEvent.sequence}, expected ${expectedSequence}`,
          );
        }
      }
      return commitReceiptFromAppend(
        await store.appendTranscriptEvent(this.id, durableEvent, { eventId: runtimeEventId }),
      );
    });
  }

  /** Session 发起的 durable 操作共用一条队列。 */
  private enqueuePersistence<Result>(
    kind: string,
    write: (store: RuntimeEventStore) => Promise<Result>,
  ): Promise<Result> {
    this.assertWritable();
    const store = this.store;
    if (!store) throw new Error("Session persistence is disabled");

    const operation = this.persistenceTail.then(() =>
      this.runWithWriteAdmission(async () => {
        await this.assertRuntimeEventWriteAllowed();
        const result = await write(store);
        await this.assertRuntimeEventWriteAllowed();
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
        let closeError: unknown;
        try {
          this.goalBinding?.unsubscribe();
          this.goalBinding = undefined;
          if (this.summaryStoreLeasePath) {
            releaseSummaryStore(this.summaryStoreLeasePath);
            this.summaryStoreLeasePath = undefined;
          }
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
      sessionEntryKey(this.id, this.workDir, this.picoHome),
      drain,
    );
    return this.closePromise;
  }
}

async function storedPreimageState(
  backup: FileHistoryBackup,
  sessionId: string,
  baseDir: string,
  blobStore: FileHistoryBlobStore,
): Promise<StoredFileState> {
  if (backup.backupFileName === null) return { kind: "missing" };
  const ref =
    backup.blobRef ??
    (await blobStore.putFile(resolveBackupPath(sessionId, backup.backupFileName, baseDir))).ref;
  return {
    kind: "file",
    blobSha256: ref.digest,
    sizeBytes: ref.sizeBytes,
    mode: backup.originMode ?? 0o644,
  };
}

async function storedCurrentState(
  filePath: string,
  blobStore: FileHistoryBlobStore,
): Promise<StoredFileState> {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`FileHistory: ${filePath} 当前不是可恢复的普通文件`);
    }
    const { ref } = await blobStore.putFile(filePath);
    return {
      kind: "file",
      blobSha256: ref.digest,
      sizeBytes: ref.sizeBytes,
      mode: metadata.mode & 0o777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

function resolveFileHistoryLocation(
  roots: ReadonlyMap<string, string>,
  filePath: string,
): { rootId: string; relativePath: string } {
  const absolutePath = resolve(filePath);
  const matches = [...roots.entries()]
    .map(([rootId, root]) => ({
      rootId,
      root: resolve(root),
      relativePath: relative(root, absolutePath),
    }))
    .filter(
      (candidate) =>
        candidate.relativePath.length > 0 &&
        !candidate.relativePath.startsWith("..") &&
        !isAbsolute(candidate.relativePath),
    )
    .toSorted((left, right) => right.root.length - left.root.length);
  const selected = matches[0];
  if (!selected) throw new Error(`FileHistory: ${filePath} 不属于已信任 workspace root`);
  return {
    rootId: selected.rootId,
    relativePath: selected.relativePath.split("\\").join("/"),
  };
}

async function applyRewindWorkspaceTargets(
  operationId: string,
  targets: readonly RewindWorkspaceTarget[],
): Promise<void> {
  for (const target of targets) {
    if (target.state.kind === "missing") {
      try {
        const current = await lstat(target.absolutePath);
        if (!current.isFile() && !current.isSymbolicLink()) {
          throw new Error(`Rewind 拒绝删除非文件路径: ${target.absolutePath}`);
        }
        await unlink(target.absolutePath);
        await syncRewindDirectory(dirname(target.absolutePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    if (!target.contents) throw new Error(`Rewind 缺少 CAS 内容: ${target.absolutePath}`);
    const directory = dirname(target.absolutePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(
      directory,
      `.${basename(target.absolutePath)}.pico-rewind-${operationId}-${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    let published = false;
    try {
      handle = await open(temporary, "wx", 0o600);
      await writeAllRewindFile(handle, target.contents);
      await handle.chmod(target.state.mode);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target.absolutePath);
      published = true;
      await syncRewindDirectory(directory);
    } finally {
      await handle?.close().catch(() => undefined);
      if (!published) await unlink(temporary).catch(() => undefined);
    }
  }
}

function sessionHistoryDigest(history: readonly Message[]): string {
  return createHash("sha256").update(JSON.stringify(history)).digest("hex");
}

async function writeAllRewindFile(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("Rewind temporary file write made no progress");
    offset += bytesWritten;
  }
}

async function syncRewindDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function durableForkModelCheckpoint(
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
  if (!summary || !checkpointThroughEventId) return undefined;

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
      (event) =>
        event.eventId === throughEventId &&
        event.kind === "context.checkpoint.recorded" &&
        event.data.throughEventId !== undefined &&
        event.data.summary !== undefined,
    );
    if (!parent || parent.kind !== "context.checkpoint.recorded") {
      throw new Error(
        `Runtime checkpoint ${checkpoint.eventId} cannot resolve transcript boundary ${throughEventId}`,
      );
    }
    const parentThroughEventId = parent.data.throughEventId;
    if (!parentThroughEventId) {
      throw new Error(`Runtime checkpoint ${parent.eventId} has no transcript boundary`);
    }
    throughEventId = parentThroughEventId;
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
  return {
    logId: sessionId,
    seq: entry.sequence,
    epoch: entries.filter(
      (candidate) =>
        candidate.sequence <= entry.sequence && candidate.event.kind === "history.rewound",
    ).length,
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

function commitReceiptFromEntry(
  sessionId: string,
  entries: readonly RuntimeEventStoreEntry[],
  entry: RuntimeEventStoreEntry,
  inserted: boolean,
): CommitReceipt {
  return {
    eventId: entry.event.eventId,
    cursor: runtimeCursorForEntry(sessionId, entries, entry),
    committedAt: entry.event.at,
    durable: true,
    inserted,
  };
}

async function resolveRuntimeRootSessionId(
  store: RuntimeEventStore,
  sessionId: string,
): Promise<string> {
  const visited = new Set<string>();
  let current = sessionId;
  while (!visited.has(current)) {
    visited.add(current);
    const fork = (await store.readSession(current)).find(
      (event) => event.kind === "session.forked",
    );
    if (!fork || fork.kind !== "session.forked") return current;
    current = fork.data.parentSessionId;
  }
  throw new Error(`Runtime session lineage contains a cycle at ${current}`);
}

function messageDigest(messages: readonly Message[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

/** 旧 undo 交互语义：跳过 system，且不跨越 compaction summary。 */
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
  if (message.role !== "assistant") return false;
  const marker = message.providerData?.["picoKind"];
  return (
    marker === "compaction_summary" ||
    message.content.startsWith("[上下文压缩") ||
    message.content.includes("--- 历史摘要结束")
  );
}

function isPersistedInteractionMode(value: unknown): value is PersistedSessionSettings["mode"] {
  return value === "default" || value === "plan" || value === "auto" || value === "yolo";
}

function isPersistedPrePlanMode(
  value: unknown,
): value is NonNullable<PersistedSessionSettings["prePlanMode"]> {
  return value === "default" || value === "auto" || value === "yolo";
}

function restorePersistedInteractionMode(
  current: PersistedSessionSettings,
  mode: PersistedSessionSettings["mode"],
  prePlanMode?: NonNullable<PersistedSessionSettings["prePlanMode"]>,
): PersistedSessionSettings {
  const next = structuredClone(current);
  if (mode === "plan") {
    next.prePlanMode =
      prePlanMode ?? (current.mode === "plan" ? (current.prePlanMode ?? "yolo") : current.mode);
  } else {
    delete next.prePlanMode;
  }
  next.mode = mode;
  return next;
}

/**
 * SessionManager:全局会话管理器,负责多用户 / 多终端的物理隔离。
 * 以 sessionId 为 key,O(1) 路由到对应 Session 实例。
 *
 * 【内存治理】LRU + TTL 双重驱逐,防长跑内存膨胀:
 * - LRU:maxSessions 上限(默认 128)。超出时驱逐"最近最少使用"的 Session,
 *   驱逐前调 session.close() 释放 SQLite 句柄(防 fd 泄漏)。
 * - TTL:空闲超时(默认 24h)。每次 getOrCreate 惰性扫描,驱逐长期闲置 Session。
 *   飞书多群场景下,沉默群的历史不再常驻内存,被再次唤醒时从 RuntimeEvent recover 重建。
 * - MRU 提升:get/getOrCreate/delete+set 把目标提到 Map 末尾(最近使用),
 *   Map 的迭代序即 LRU 序,首个元素即最旧。对标 hermes GatewaySession 的容量管理。
 *
 * 注意:驱逐只释放内存实例 + SQLite 句柄;runtime.sqlite 事件不删,
 * 被 recover 唤醒即可续传。
 */
export class SessionManager {
  /** 默认最大常驻会话数(对标 hermes gateway 的会话池上限量级) */
  static readonly DEFAULT_MAX_SESSIONS = 128;
  /** 默认空闲超时 24h:超过未访问的会话被惰性驱逐 */
  static readonly DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

  private readonly entries = new Map<
    string,
    { session: Session; lastAccessMs: number; pinCount: number }
  >();
  /** 合并同 key 的并发 recover，避免 drain 结束后同时创建两个实例。 */
  private readonly openingByKey = new Map<string, Promise<Session>>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;

  constructor(options?: { maxSessions?: number; ttlMs?: number }) {
    this.maxSessions = options?.maxSessions ?? SessionManager.DEFAULT_MAX_SESSIONS;
    this.ttlMs = options?.ttlMs ?? SessionManager.DEFAULT_TTL_MS;
  }

  /**
   * 获取或创建一个会话(同 id + 同 workDir 复用,否则物理隔离)。
   * 新建时自动投影 runtime.sqlite 事件恢复历史。返回 Promise 以支持异步恢复。
   * persistence 显式透传给 Session(测试场景精确控制,避免环境变量并行污染)。
   *
   * 命中时做 MRU 提升(删除后重新 set 到末尾);新建后触发 LRU 驱赶 + TTL 惰性清理。
   */
  async getOrCreate(id: string, workDir: string, options?: SessionOptions): Promise<Session> {
    // TTL 惰性清理:借这次访问顺带扫一遍过期项(低频,不阻塞主流程)。
    this.evictExpired();

    const key = this.entryKey(id, workDir, options?.picoHome);
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastAccessMs = Date.now();
      this.touch(key); // MRU 提升
      return existing.session;
    }

    const opening = this.openingByKey.get(key);
    if (opening) return opening;

    const created = this.openAfterDrain(key, id, workDir, options);
    this.openingByKey.set(key, created);
    try {
      return await created;
    } finally {
      if (this.openingByKey.get(key) === created) this.openingByKey.delete(key);
    }
  }

  /**
   * 获取已存在的会话(不创建)。命中时做 MRU 提升与 lastAccess 更新。
   * 不触发 TTL 清理(get 应轻量;清理在 getOrCreate 路径做)。
   */
  get(
    id: string,
    workDir?: string,
    options: { readonly picoHome?: string } = {},
  ): Session | undefined {
    const key = this.findEntryKey(id, workDir, options.picoHome);
    if (!key) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.lastAccessMs = Date.now();
    this.touch(key);
    return entry.session;
  }

  /**
   * Pins the exact managed Session for a long-lived SessionRuntime. The returned release
   * is idempotent; the final release starts a fresh idle window without weakening identity checks.
   */
  pin(session: Session): () => void {
    const key = this.entryKey(session.id, session.workDir, session.picoHome);
    const entry = this.entries.get(key);
    if (!entry) {
      throw new Error(`SessionManager cannot pin unmanaged Session: ${session.id}`);
    }
    if (entry.session !== session) {
      throw new Error(`SessionManager cannot pin a different Session instance: ${session.id}`);
    }
    entry.pinCount++;
    entry.lastAccessMs = Date.now();
    this.touch(key);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.pinCount--;
      if (entry.pinCount < 0) {
        throw new Error(`SessionManager pin underflow: ${session.id}`);
      }
      if (entry.pinCount === 0 && this.entries.get(key) === entry) {
        entry.lastAccessMs = Date.now();
        this.touch(key);
      }
    };
  }

  /** 删除已存在的会话并返回被删除实例;不存在时返回 undefined。释放底层资源。 */
  delete(
    id: string,
    workDir?: string,
    options: { readonly picoHome?: string } = {},
  ): Session | undefined {
    const key = this.findEntryKey(id, workDir, options.picoHome);
    if (!key) return undefined;
    return this.deleteByKey(key);
  }

  /** 当前管理的会话总数 */
  get size(): number {
    return this.entries.size;
  }

  /** 清空所有会话(主要用于测试)。释放每个 Session 的底层资源。 */
  clear(): void {
    for (const key of [...this.entries.keys()]) this.deleteByKey(key);
  }

  /** MRU 提升:把 key 移到 Map 末尾(最近使用),保持迭代序 = LRU 序。 */
  private touch(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  /** LRU 驱赶:超出 maxSessions 时驱逐最旧项,直到回到上限内。 */
  private evictLru(protectedKey?: string): void {
    while (this.entries.size > this.maxSessions) {
      const oldestInactive = [...this.entries].find(
        ([key, entry]) =>
          key !== protectedKey && entry.pinCount === 0 && !entry.session.hasPendingTasks,
      )?.[0];
      if (oldestInactive === undefined) break;
      this.deleteByKey(oldestInactive);
    }
  }

  /** TTL 惰性清理:驱逐空闲超过 ttlMs 的会话。每次 getOrCreate 调一次。 */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (
        entry.pinCount === 0 &&
        !entry.session.hasPendingTasks &&
        now - entry.lastAccessMs > this.ttlMs
      ) {
        this.deleteByKey(key);
      }
    }
  }

  private deleteByKey(key: string): Session | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.startDrain(key, entry.session);
    return entry.session;
  }

  private async openAfterDrain(
    key: string,
    id: string,
    workDir: string,
    options?: SessionOptions,
  ): Promise<Session> {
    await sessionDrains.get(key);

    // drain 等待期间可能已有其他路径完成创建，再检查一次。
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastAccessMs = Date.now();
      this.touch(key);
      return existing.session;
    }

    const session = new Session(id, workDir, options);
    try {
      await session.recover();
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
    this.entries.set(key, { session, lastAccessMs: Date.now(), pinCount: 0 });
    // A newly returned Session must not be immediately closed when older entries are pinned.
    this.evictLru(key);
    return session;
  }

  private startDrain(key: string, session: Session): void {
    void session.close().catch((error: unknown) => {
      logger.warn({ key, error: String(error) }, "[session] 驱逐时持久化 drain 失败");
    });
  }

  private entryKey(id: string, workDir: string, picoHome?: string): string {
    return sessionEntryKey(id, workDir, picoHome);
  }

  private findEntryKey(id: string, workDir?: string, picoHome?: string): string | undefined {
    if (workDir !== undefined) {
      const key = this.entryKey(id, workDir, picoHome);
      return this.entries.has(key) ? key : undefined;
    }

    for (const [key, entry] of [...this.entries].reverse()) {
      if (entry.session.id === id) return key;
    }
    return undefined;
  }
}

/**
 * 全局 SessionManager 单例。
 * 飞书后台无论收到多少群聊,都通过分配不同的 sessionId 各自安好。
 */
export const globalSessionManager = new SessionManager();
