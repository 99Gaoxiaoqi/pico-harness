// 会话管理:Session 物理隔离与 WorkingMemory (短期工作记忆) 的底层实现。
//
// 解决两个核心痛点:
// 1. 多端并发下的 Session 物理隔离 —— 飞书群 A 在重构代码、群 B 在查日志,
//    绝不能共用同一个 contextHistory,否则大模型瞬间精神分裂。
//    通过 SessionManager + 读写锁,为每个用户对话框分配独立安全数据池。
// 2. 长程任务历史滚雪球 → 超时 / 天价 Token / API 400。
//    通过 GetWorkingMemory(limit) 滑动窗口,只截取最近 N 条消息发给大模型,
//    严格控制 Context 规模,同时巧妙处理孤儿 ToolResult,规避 400。
//
// 经此改造,engine.Run 沦为纯"打工执行器":不内部维护状态,
// 依靠喂给它的 Session 推理 —— 随时休眠、随时被唤醒的记忆连续体。

import { chmodSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  isMessageHiddenFromTranscript,
  toCanonicalUsage,
  type CanonicalUsage,
  type Message,
  type UsageReportedField,
} from "../schema/message.js";
import type { CostStatus } from "../observability/pricing.js";
import { logger } from "../observability/logger.js";
import {
  SessionStore,
  SessionWriteUncertainError,
  type CommitReceipt,
  type SessionLineage,
} from "./session-store.js";
import { findLegacyUndoCut, replaySessionRecords } from "./session-reducer.js";
import { createSessionIdentity, type SessionIdentity } from "./session-identity.js";
import type { GoalManager } from "./goal-manager.js";
import {
  createEmptyUsageSnapshot,
  normalizeSessionRuntimeStatePatch,
  SESSION_RUNTIME_STATE_VERSION,
  type PersistedSessionSettings,
  type SessionHydrationSnapshot,
  type SessionRuntimePersistence,
  type SessionRuntimeStatePatch,
  type SessionRuntimeStateSnapshot,
  type SessionUsageSnapshot,
} from "./session-runtime.js";
import { FTS5Store } from "../memory/fts5-store.js";
import { JsonlMemoryStore } from "../memory/jsonl-memory-store.js";
import type {
  ConversationSearchStore,
  MemoryBackendStatus,
  SessionSummaryStore,
} from "../memory/memory-store.js";
import { createSessionSummaryStore } from "../memory/summary-store.js";
import {
  createFileHistoryState,
  type FileHistoryState,
  type FileHistoryDiffStat,
  fileHistoryBeginRewindPoint,
  fileHistoryDiscardFrom,
  fileHistoryDiffStat,
  fileHistoryLoadState,
  fileHistoryMessageDiffStat,
  fileHistoryRewind,
} from "../safety/file-history.js";
import type {
  SessionCatalog,
  SessionCatalogEntry,
  SessionCatalogLineage,
} from "../storage/session-catalog.js";
import {
  getDefaultSessionCatalogProjector,
  SessionCatalogProjector,
  type SessionCatalogProjectionHealth,
} from "../storage/session-catalog-projection.js";

/** 清洗 sessionId 为安全文件名片段(/、: 等破坏路径的字符替换为 _) */
function sanitizeFilePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
}

/** 进程级 per-key drain 表，让不同 SessionManager 实例也不会越过旧 tail。 */
const sessionDrains = new Map<string, Promise<void>>();
const summaryStorePool = new Map<string, { store: SessionSummaryStore; refCount: number }>();

function sessionEntryKey(id: string, workDir: string): string {
  return `${resolve(workDir)}\0${id}`;
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

export interface SessionOptions {
  persistence?: boolean;
  identity?: SessionIdentity;
  /** Deterministic backend injection for integration and embedders. */
  memorySearchStore?: ConversationSearchStore;
  /** Catalog 是 JSONL 的可重建投影；false 仅供无持久测试显式关闭。 */
  sessionCatalog?: SessionCatalog | false;
}

/**
 * Session:一次持续的人机交互过程。
 * 负责维护该会话的完整历史,并提供 WorkingMemory 提取。
 */
export class Session implements SessionRuntimePersistence {
  /** 会话标识(终端目录哈希 / 飞书 ChatID / 微信 OpenID) */
  readonly id: string;
  /** 该会话绑定的物理工作区 */
  readonly workDir: string;
  /** 会话与项目/worktree 的显式身份,供后续 resume 过滤使用。 */
  readonly identity: SessionIdentity;
  readonly createdAt: Date;
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
   * - accessCount:被 getWorkingMemory 读出的次数
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

  readonly fileHistory: FileHistoryState = createFileHistoryState();

  conversationId: string;

  /**
   * 持久化:事件溯源 JSONL。undefined 表示持久化关闭(环境变量门控)。
   * 默认开启(对标 kimi-code wire.jsonl);PICO_PERSISTENCE=0 关闭。
   */
  private store?: SessionStore;
  /** 下一条 record 的序列号(单调递增,保证重放顺序与幂等) */
  private nextSeq = 0;
  /**
   * 唯一 JSONL 写入队列。所有 record 在逻辑变更点同步分配 seq，
   * 再串行接到 tail，因此物理落盘顺序与逻辑调用顺序一致。
   */
  private persistenceTail: Promise<void> = Promise.resolve();
  /** Catalog 与 JSONL writer 解耦；失败只降级投影，close/flush 会等它收敛。 */
  private catalogTail: Promise<void> = Promise.resolve();
  private compatibilityAppendTail: Promise<void> = Promise.resolve();
  private lifecycle: "open" | "write_uncertain" | "closing" | "closed" = "open";
  private persistenceFailure?: SessionWriteUncertainError;
  private closePromise?: Promise<void>;

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

  /** 当前检索后端；SQLite 不可用时由 JSONL 重放消息重建内存索引。 */
  private searchStore!: ConversationSearchStore;
  /** acquire 得到的共享 FTS5 租约；即使降级也需要对称 release。 */
  private fts5Lease?: FTS5Store;
  private summaryStore!: SessionSummaryStore;
  private summaryStoreLeasePath?: string;
  private catalogProjector?: SessionCatalogProjector;
  private catalogHealthState?: SessionCatalogProjectionHealth;
  private catalogEntryState?: SessionCatalogEntry;
  private sessionLogPath?: string;

  constructor(id: string, workDir: string, options?: SessionOptions) {
    this.id = id;
    this.workDir = workDir;
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
    this.initPersistence(options?.persistence);
    const defaultCatalogEnabled = process.env.PICO_SESSION_CATALOG !== "0";
    if (
      this.store &&
      options?.sessionCatalog !== false &&
      (options?.sessionCatalog !== undefined || defaultCatalogEnabled)
    ) {
      this.catalogProjector = options?.sessionCatalog
        ? new SessionCatalogProjector(options.sessionCatalog)
        : getDefaultSessionCatalogProjector();
    }
    this.initMemorySearch(options?.memorySearchStore);
    const summaryPath = join(this.workDir, ".claw", "memory", "summaries.json");
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
   * 文件落点复用 .claw/ 约定:<workDir>/.claw/sessions/<id>.jsonl,
   * 与 traces/、artifacts/、skills/ 同级。
   */
  private initPersistence(explicit?: boolean): void {
    // 显式参数优先;未传时回落到环境变量,再回落到默认开启
    const enabled = explicit ?? process.env.PICO_PERSISTENCE !== "0";
    if (!enabled) return;
    try {
      const dir = join(this.workDir, ".claw", "sessions");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      this.sessionLogPath = join(dir, `${sanitizeFilePart(this.id)}.jsonl`);
      this.store = new SessionStore(this.sessionLogPath, this.identity);
    } catch (error) {
      // 持久化初始化失败不应阻断会话本身,降级为纯内存
      logger.warn({ error: String(error) }, "[session] 持久化初始化失败,降级为纯内存");
      this.store = undefined;
    }
  }

  /**
   * 初始化 FTS5 全文检索存储。
   * 【连接池化】通过 FTS5Store.acquire 复用 workDir 级单例,避免每 Session 开一个
   * SQLite 连接。失败时降级为 undefined,不影响主流程(记忆提醒功能可选)。
   */
  private initMemorySearch(explicit?: ConversationSearchStore): void {
    if (explicit) {
      this.searchStore = explicit;
      this.switchMemorySearchToJsonlIfDegraded();
      return;
    }
    try {
      const store = FTS5Store.acquire(this.workDir);
      if (store) this.fts5Lease = store;
      if (store?.status.state === "healthy") {
        this.searchStore = store;
        return;
      }
      this.searchStore = this.createJsonlMemoryFallback(store?.status);
    } catch (err) {
      logger.warn({ err }, "[session] FTS5 初始化失败,降级为 JSONL 重建索引");
      this.searchStore = this.createJsonlMemoryFallback({
        backend: "sqlite_fts5",
        state: "degraded",
        persistentSource: "sqlite",
        nodeVersion: process.version,
        nodeModuleAbi: process.versions.modules,
        reason: err instanceof Error ? err.message : String(err),
        recommendation:
          "请在当前 Node 环境运行 npm rebuild better-sqlite3；仍失败时重新运行 npm ci。",
      });
    }
  }

  private createJsonlMemoryFallback(status?: MemoryBackendStatus): JsonlMemoryStore {
    return new JsonlMemoryStore({
      persistentSource: this.store ? "session_jsonl" : "none",
      reason: status?.reason ?? "SQLite FTS5 unavailable",
      ...(status?.recommendation ? { recommendation: status.recommendation } : {}),
      nodeVersion: status?.nodeVersion,
      nodeModuleAbi: status?.nodeModuleAbi,
    });
  }

  /** SQLite 在运行期失效时立即切换到可重建的 JSONL 内存索引。 */
  private switchMemorySearchToJsonlIfDegraded(): boolean {
    const current = this.searchStore;
    const status = current.status;
    if (status.state !== "degraded" || status.backend === "jsonl_memory") return false;

    const fallback = this.createJsonlMemoryFallback(status);
    fallback.replaceSession(this.id, this.history);
    this.searchStore = fallback;

    if (current === this.fts5Lease) {
      FTS5Store.release(this.workDir);
      this.fts5Lease = undefined;
    } else {
      current.close();
    }
    logger.warn(
      { reason: status.reason, backend: status.backend },
      "[session] 记忆索引运行期降级,已切换为 JSONL 重建索引",
    );
    return true;
  }

  /**
   * 重启后重放事件日志,重建内存 history(对标 kimi-code AgentRecords.replay)。
   * 在 SessionManager.getOrCreate 新建实例时自动调用一次。
   * 持久化关闭时为空操作。
   */
  async recover(): Promise<void> {
    await this.recoverFileHistory();
    if (!this.store) {
      this.rebuildSearchIndex();
      return;
    }
    let records;
    try {
      await this.store.openWriter();
      records = await this.store.loadStrict();
      this.conversationId = `${this.store.getLogId()}:${this.store.getEpoch()}`;
    } catch (error) {
      this.markWriteUncertain("Session journal open/replay failed", error);
      throw error;
    }
    await this.projectSessionCatalog({ openedAt: new Date().toISOString() });
    if (records.length === 0) {
      this.rebuildSearchIndex(this.store.getHeadCursor());
      return;
    }

    const replay = replaySessionRecords(records);
    this.history = replay.history;
    this.persistedSettings = replay.runtime.settings;
    this.persistedGoal = replay.runtime.goal;
    // 旧 JSONL 没有 runtime_state:从当前有效 assistant message.usage 回填 token。
    // 旧数据无计价路由，成本只能保持 0/null。新日志取持久值与可恢复值的较大者，
    // 容忍“message 已落盘、usage 记录末行撕裂”。
    this.restoreUsage(
      mergeUsageWithHistory(replay.runtime.usage, deriveUsageFromHistory(this.history)),
    );
    // 3.1:重放后从 history 重建 toolResultMeta(cachedAt 未知,用当前时间;
    // accessCount 归零)。避免恢复后已有 ToolResult 丢失年龄追踪。
    this.rebuildToolResultMeta();
    this.nextSeq = replay.maxSeq + 1;
    this.rebuildSearchIndex(this.store.getHeadCursor());
  }

  private rebuildSearchIndex(cursor?: CommitReceipt["cursor"]): void {
    if (cursor && this.searchStore.projectReplace) {
      this.searchStore.projectReplace(this.id, this.history, cursor);
    } else {
      this.searchStore.replaceSession(this.id, this.history);
    }
    this.switchMemorySearchToJsonlIfDegraded();
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
      await fileHistoryLoadState(this.fileHistory, this.id);
    } catch (error) {
      logger.warn({ error: String(error) }, "[session] 文件历史恢复失败,降级为空快照");
    }
  }

  /**
   * 串行执行一个任务:同一 Session 的多个调用自动排队,
   * 保证同一时刻只有一个 engine.run 在操作 history。
   * 返回任务的 Promise(结果需调用方 await)。
   */
  serialize<T>(task: () => Promise<T>): Promise<T> {
    if (this.lifecycle !== "open") {
      return Promise.reject(new Error(`Session ${this.id} is ${this.lifecycle}`));
    }
    const result = this.runQueue.then(task, task);
    // 无论成功失败,都更新队列链;吞掉错误让调用方自己的 catch 处理
    this.runQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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

  /** 更新一个完整 section，内存立即生效，然后追加到现有 Session JSONL。 */
  updateRuntimeState(patch: SessionRuntimeStatePatch): void {
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
      void this.commitPersistence("runtime_state", (store, seq) =>
        store.commitRuntimeState(persisted, { expectedSeq: seq }),
      )
        .then((receipt) => this.scheduleSessionCatalog(receipt))
        .catch((error: unknown) => {
          logger.error({ error: String(error) }, "[session] runtime_state 持久化失败");
        });
    }
  }

  /**
   * 把会话 GoalManager 绑定到同一份 JSONL。返回解绑函数供 11.4 热切换使用。
   * 有持久快照时先恢复；无快照时保存当前初始状态。
   */
  bindGoalManager(manager: GoalManager): () => void {
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
    await this.compatibilityAppendTail;
    await this.persistenceTail;
    await this.catalogTail;
    if (this.persistenceFailure) throw this.persistenceFailure;
  }

  /** 在首个 await 前同步冻结状态与当前 tail，不被后来写入污染边界。 */
  readHydrationSnapshot(): Promise<SessionHydrationSnapshot> {
    const snapshot: SessionHydrationSnapshot = {
      schemaVersion: 1,
      persistenceSequence: this.store && this.nextSeq > 0 ? this.nextSeq - 1 : null,
      sessionId: this.id,
      conversationId: this.conversationId,
      workDir: this.workDir,
      identity: structuredClone(this.identity),
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      messages: structuredClone(this.history),
      runtime: this.getRuntimeStateSnapshot(),
    };
    const barrier = this.persistenceTail;
    return barrier.then(() => snapshot);
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

  /**
   * 向 Session 追加消息(可批量)。内存写后追加事件到 JSONL(对标 kimi-code wire.jsonl)
   *
   * 3.4 deferredMessages:tool 调用顺序完整性保证。
   * - assistant 带 toolCalls:登记 pendingToolCallIds(等待对应 ToolResult)
   * - ToolResult 到达:从 pendingToolCallIds 删除;若清空,把 deferredMessages flush 入 history
   * - 其他消息:若 pendingToolCallIds 非空,暂存到 deferredMessages 不入 history;
   *   否则正常入 history
   */
  /** @deprecated 仅供 legacy 同步调用方；生产路径必须 await commitMessages。 */
  append(...msgs: Message[]): void {
    if (this.store) {
      for (const msg of msgs) this.appendOneCompatibility(msg);
      return;
    }
    for (const msg of msgs) this.appendOneInMemory(msg);
  }

  private appendOneCompatibility(msg: Message): void {
    const prepared = this.prepareAppend(msg);
    if (prepared.deferred) return;
    this.doAppend(msg);
    const persisted = structuredClone(msg);
    const operation = this.commitPersistence("compatibility message", (store, seq) =>
      store.commitMessage(persisted, { expectedSeq: seq }),
    );
    void operation.then(
      (receipt) => this.scheduleSessionCatalog(receipt, { appendedMessage: msg }),
      () => undefined,
    );
    this.compatibilityAppendTail = Promise.all([this.compatibilityAppendTail, operation])
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error({ error: String(error) }, "[session] 兼容 append 持久化失败");
      });
    if (
      prepared.toolResult &&
      this.pendingToolCallIds.size === 0 &&
      this.deferredMessages.length > 0
    ) {
      const pending = this.deferredMessages;
      this.deferredMessages = [];
      for (const deferred of pending) this.appendOneCompatibility(deferred);
    }
  }

  /** 生产接口：每条消息在 JSONL fdatasync 后才进入正式 history/FTS。 */
  async commitMessages(...msgs: Message[]): Promise<void> {
    this.assertWritable();
    if (!this.store) {
      for (const msg of msgs) this.appendOneInMemory(msg);
      return;
    }
    for (const msg of msgs) await this.appendOneDurable(msg);
  }

  /**
   * 用父会话的 durable cursor 原子播种 fork。Catalog 重建时从
   * session.seeded 事件取 parentLogId/forkEventId，不再依赖可变的标题。
   */
  async seedForkFrom(source: Session, messages: readonly Message[]): Promise<void> {
    this.assertWritable();
    if (this.history.length > 0) return;
    const parent = await source.readDurableForkPoint();
    const lineage = {
      relation: "fork",
      rootLogId: parent.rootLogId,
      ...(parent.cursor ? { parent: parent.cursor } : {}),
    } satisfies SessionLineage;
    const seeded = [...structuredClone(messages)];
    if (!this.store) {
      for (const message of seeded) this.appendOneInMemory(message);
      return;
    }
    const receipt = await this.commitPersistence("fork seed", (store, seq) =>
      store.commitSeed(seeded, lineage, { expectedSeq: seq }),
    );
    this.history = seeded;
    this.conversationId = `${receipt.cursor.logId}:${receipt.cursor.epoch}`;
    this.updatedAt = new Date();
    this.rebuildToolResultMeta();
    this.rebuildSearchIndex(receipt.cursor);
    this.scheduleSessionCatalog(receipt, {
      rebuildSummary: true,
      lineage: catalogLineageFromSession(lineage, source.id),
    });
  }

  private async readDurableForkPoint(): Promise<{
    readonly rootLogId: string;
    readonly cursor?: CommitReceipt["cursor"];
  }> {
    await this.flushPersistence();
    const store = this.store;
    if (!store) return { rootLogId: this.id };
    const snapshot = await store.inspectJournal();
    let rootLogId =
      snapshot.metadata && "lineage" in snapshot.metadata
        ? snapshot.metadata.lineage.rootLogId
        : store.getLogId();
    for (const record of snapshot.records) {
      if (record.type === "event" && record.kind === "session.seeded" && record.data.lineage) {
        rootLogId = record.data.lineage.rootLogId;
      }
    }
    return {
      rootLogId,
      ...(store.getHeadCursor() ? { cursor: store.getHeadCursor() } : {}),
    };
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

  private async appendOneDurable(msg: Message): Promise<void> {
    const prepared = this.prepareAppend(msg);
    if (prepared.deferred) return;
    await this.commitAppend(msg);
    if (
      prepared.toolResult &&
      this.pendingToolCallIds.size === 0 &&
      this.deferredMessages.length > 0
    ) {
      const pending = this.deferredMessages;
      this.deferredMessages = [];
      for (const deferred of pending) await this.appendOneDurable(deferred);
    }
  }

  /** persistence:false 兼容路径。 */
  private doAppend(msg: Message): void {
    const beforeLen = this.history.length;
    this.history.push(msg);
    this.updatedAt = new Date();

    try {
      this.searchStore.insert(this.id, beforeLen, msg);
      this.switchMemorySearchToJsonlIfDegraded();
    } catch (err) {
      logger.warn({ err }, "[session] 记忆索引失败");
    }
  }

  private async commitAppend(msg: Message): Promise<void> {
    const beforeLen = this.history.length;
    const persisted = structuredClone(msg);
    const receipt = await this.commitPersistence("message", (store, seq) =>
      store.commitMessage(persisted, { expectedSeq: seq }),
    );
    this.history.push(msg);
    this.conversationId = `${receipt.cursor.logId}:${receipt.cursor.epoch}`;
    this.updatedAt = new Date();
    try {
      if (this.searchStore.projectInsert) {
        this.searchStore.projectInsert(this.id, beforeLen, msg, receipt.cursor);
      } else {
        this.searchStore.insert(this.id, beforeLen, msg);
      }
      this.switchMemorySearchToJsonlIfDegraded();
    } catch (err) {
      logger.warn({ err }, "[session] 记忆投影失败");
    }
    this.scheduleSessionCatalog(receipt, { appendedMessage: msg });
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
    this.store?.bumpEpoch();
    const receipt = this.store
      ? await this.commitPersistence("truncate", (store, seq) =>
          store.commitTruncate(fromIndex, { expectedSeq: seq }),
        )
      : undefined;
    this.history = nextHistory;
    if (receipt) this.conversationId = `${receipt.cursor.logId}:${receipt.cursor.epoch}`;
    this.rebuildSearchIndex(receipt?.cursor);
    this.pruneToolResultMeta();
    this.updatedAt = new Date();
    if (receipt) this.scheduleSessionCatalog(receipt, { rebuildSummary: true });
  }

  /**
   * 对话 undo:从末尾向前删 count 个 user prompt 轮次。
   * 跳过 system injection 消息,遇到 compaction 边界停止。
   * fork 语义:生成新 conversationId,旧 JSONL 保留在磁盘。
   */
  async undo(count: number): Promise<void> {
    this.assertWritable();
    if (count <= 0) return;
    const { cutIndex, removedCount } = findLegacyUndoCut(this.history, count);
    if (removedCount === 0) return;
    const nextHistory = this.history.slice(0, cutIndex);
    this.store?.bumpEpoch();
    const receipt = this.store
      ? await this.commitPersistence("rewind", (store, seq) =>
          store.commitRewind(cutIndex, { expectedSeq: seq }),
        )
      : undefined;
    this.history = nextHistory;
    this.rebuildSearchIndex(receipt?.cursor);
    this.pruneToolResultMeta();
    // 3.4: undo 时清空 deferred 与 pending,避免遗留半截 tool 配对状态
    this.deferredMessages = [];
    this.pendingToolCallIds.clear();
    this.conversationId = receipt
      ? `${receipt.cursor.logId}:${receipt.cursor.epoch}`
      : `${this.id}-${Date.now().toString(36)}`;
    this.updatedAt = new Date();
    if (receipt) this.scheduleSessionCatalog(receipt, { rebuildSummary: true });
  }

  async beginRewindPoint(input: {
    userPrompt: string;
    transcriptIndex?: number;
    interactionMode?: string;
    messageId?: string;
  }): Promise<string> {
    const messageId = input.messageId ?? randomUUID();
    await fileHistoryBeginRewindPoint(
      this.fileHistory,
      {
        messageId,
        userPrompt: input.userPrompt,
        messageIndex: this.history.length,
        ...(input.transcriptIndex !== undefined ? { transcriptIndex: input.transcriptIndex } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      },
      this.id,
    );
    return messageId;
  }

  async rewindTo(messageIndex: number): Promise<void> {
    this.assertWritable();
    const nextHistory = this.history.slice(0, messageIndex);
    this.store?.bumpEpoch();
    const receipt = this.store
      ? await this.commitPersistence("rewind", (store, seq) =>
          store.commitRewind(messageIndex, { expectedSeq: seq }),
        )
      : undefined;
    this.history = nextHistory;
    this.rebuildSearchIndex(receipt?.cursor);
    this.pruneToolResultMeta();
    this.deferredMessages = [];
    this.pendingToolCallIds.clear();
    this.conversationId = receipt
      ? `${receipt.cursor.logId}:${receipt.cursor.epoch}`
      : `${this.id}-${Date.now().toString(36)}`;
    this.updatedAt = new Date();
    if (receipt) this.scheduleSessionCatalog(receipt, { rebuildSummary: true });
  }

  async rewindCode(messageId: string): Promise<void> {
    await fileHistoryRewind(this.fileHistory, messageId, this.id);
  }

  async getRewindDiffStat(messageId: string): Promise<FileHistoryDiffStat> {
    return fileHistoryDiffStat(this.fileHistory, messageId, this.id);
  }

  async getRewindPointChangeStat(messageId: string): Promise<FileHistoryDiffStat> {
    return fileHistoryMessageDiffStat(this.fileHistory, messageId, this.id);
  }

  async rewindConversation(messageIndex: number, messageId?: string): Promise<void> {
    await this.rewindTo(messageIndex);
    if (messageId) {
      await fileHistoryDiscardFrom(this.fileHistory, messageId, this.id);
    }
  }

  async rewindBoth(messageId: string, messageIndex: number): Promise<void> {
    await fileHistoryRewind(this.fileHistory, messageId, this.id);
    await this.rewindTo(messageIndex);
    await fileHistoryDiscardFrom(this.fileHistory, messageId, this.id);
  }

  /**
   * 模型摘要压缩:用一条 role:assistant 的 summary 消息替换 history 前 compactedCount 条。
   * 对标 kimi-code applyCompaction —— 真改 Session.history(与字符级 Compactor 不同,
   * 字符级只改临时 context 不碰 Session)。
   *
   * 内存语义:history = [summaryMsg, ...history.slice(compactedCount)]。
   * 保留尾部(从 compactedCount 起的消息)不动,前缀浓缩成一条摘要。
   *
   * 持久化使用单个 history.compacted canonical event，其 JSONL fdatasync
   * 成功后才替换正式内存 history 并重建投影。
   *
   * 本方法只做纯存储,summary 内容的 REFERENCE-ONLY 包装由调用方(FullCompactor)负责。
   *
   * @param summary 摘要消息正文(已由调用方套上 REFERENCE-ONLY 前后标记)
   * @param compactedCount 被压缩的前缀条数(0..history.length)
   */
  async applyCompaction(summary: string, compactedCount: number): Promise<void> {
    this.assertWritable();
    if (compactedCount < 0) compactedCount = 0;
    if (compactedCount > this.history.length) compactedCount = this.history.length;
    const retained = this.history.slice(compactedCount);
    // 摘要消息:role=assistant(对标 kimi-code compaction_summary)
    const summaryMsg: Message = {
      role: "assistant",
      content: summary,
      providerData: { picoKind: "compaction_summary" },
    };
    const nextHistory = [summaryMsg, ...retained];
    this.store?.bumpEpoch();
    const receipt = this.store
      ? await this.commitPersistence("compaction", (store, seq) =>
          store.commitCompaction(summaryMsg, retained, { expectedSeq: seq }),
        )
      : undefined;
    this.history = nextHistory;
    if (receipt) this.conversationId = `${receipt.cursor.logId}:${receipt.cursor.epoch}`;
    this.rebuildSearchIndex(receipt?.cursor);
    // 压缩后清理已消失 ToolResult 的 meta(被摘要吞掉的前缀条目)
    this.pruneToolResultMeta();
    this.updatedAt = new Date();
    if (receipt) this.scheduleSessionCatalog(receipt, { rebuildSummary: true });
  }

  /** 返回全量历史的深拷贝(仅供调试 / 测试,不参与推理) */
  getHistory(): Message[] {
    return structuredClone(this.history);
  }

  /** 当前历史消息条数 */
  get length(): number {
    return this.history.length;
  }

  /**
   * 驾驭工程的核心!不返回全量历史,而是从后往前截取最近的 limit 条消息,
   * 形成 Agent 的"短期工作记忆"。
   *
   * 【驾驭防线】大模型 API 强制要求历史消息的连续性!
   * 若截断的第一条恰好是个孤儿 ToolResult(role=user 且带 toolCallId),
   * 但发出该 ToolCall 的 assistant 消息已被截断抛弃,API 直接 400 Bad Request。
   * 故切片首条若属孤儿工具响应,必须强行舍弃,顺延到下一条正常消息。
   */
  getWorkingMemory(limit: number): Message[] {
    const total = this.history.length;
    let res: Message[];
    if (total <= limit || limit <= 0) {
      // 历史总量小于限制或不设限:全量返回(深拷贝以防外部修改污染内部)
      res = this.history.map((m) => ({ ...m }));
    } else {
      // 截取最近的 limit 条
      res = this.history.slice(total - limit).map((m) => ({ ...m }));

      // 丢弃断头的孤儿 ToolResult,保证历史连续性
      while (res.length > 0) {
        const first = res[0]!;
        if (first.role === "user" && first.toolCallId) {
          res = res.slice(1);
        } else {
          break;
        }
      }
    }

    // 3.1 MicroCompaction:对本次返回的 ToolResult bump accessCount
    // (bump 只对本次返回的算一次访问,反映"近期被读过")
    for (const msg of res) {
      if (msg.role === "user" && msg.toolCallId) {
        const meta = this.toolResultMeta.get(msg.toolCallId);
        if (meta) meta.accessCount++;
      }
    }
    return res;
  }

  /**
   * 暴露 ToolResult 外挂元数据(按 toolCallId 索引),供 MicroCompaction
   * 读取缓存年龄与使用率。返回只读视图。
   */
  getToolResultMeta(): ReadonlyMap<string, { cachedAt: number; accessCount: number }> {
    return this.toolResultMeta;
  }

  /**
   * 全文检索历史对话(基于 FTS5)。
   * 用于 MemoryNudger 生成记忆提醒时查询相关历史。
   * @param query - 搜索关键词
   * @param limit - 返回结果数(默认 10)
   * @returns 匹配的对话片段(按相关性排序,仅返回当前 Session 的消息)
   */
  search(
    query: string,
    limit = 10,
  ): Array<{ content: string; turnIndex: number; sessionId: string }> {
    try {
      // 传入 sessionId 过滤,只返回当前 Session 的消息
      let results = this.searchStore.search(query, limit, this.id);
      if (this.switchMemorySearchToJsonlIfDegraded()) {
        results = this.searchStore.search(query, limit, this.id);
      }
      return results.map((r) => ({
        content: r.content,
        turnIndex: r.turnIndex,
        sessionId: r.sessionId,
      }));
    } catch (err) {
      logger.warn({ err, query }, "[session] 记忆检索失败");
      return [];
    }
  }

  /** 获取 FTS5Store 实例(用于 MemoryNudger) */
  get fts5Store(): FTS5Store | undefined {
    return this.fts5Lease?.status.state === "healthy" ? this.fts5Lease : undefined;
  }

  get memoryStatus(): MemoryBackendStatus {
    return this.searchStore.status;
  }

  get sessionCatalogHealth(): SessionCatalogProjectionHealth | undefined {
    return this.catalogHealthState;
  }

  get sessionSummaryStore(): SessionSummaryStore {
    return this.summaryStore;
  }

  saveMemorySummary(summary: string, messageCount: number): void {
    this.summaryStore.save(this.id, summary, messageCount);
  }

  /**
   * 获取底层 SessionStore(4.3 cursor 多端同步)。
   * WS 层通过它订阅 onRecord 推送事件流、读取 epoch 判断世代。
   * 持久化关闭时返回 undefined,WS 层据此降级为无推送模式。
   */
  get recordStore(): SessionStore | undefined {
    return this.store;
  }

  /** 所有 canonical event 共用一条队列，保证 seq 分配与物理 append 顺序一致。 */
  private commitPersistence(
    kind: string,
    write: (store: SessionStore, seq: number) => Promise<CommitReceipt>,
  ): Promise<CommitReceipt> {
    this.assertWritable();
    const store = this.store;
    if (!store) throw new Error("Session persistence is disabled");

    const seq = this.nextSeq++;
    const operation = this.persistenceTail.then(() => write(store, seq));
    const settled = operation.then(
      () => undefined,
      (error: unknown) => {
        this.markWriteUncertain(`${kind} durable commit failed at seq ${seq}`, error);
      },
    );
    this.persistenceTail = settled;
    return operation;
  }

  private async projectSessionCatalog(options: { openedAt?: string } = {}): Promise<void> {
    const projector = this.catalogProjector;
    const logPath = this.sessionLogPath;
    if (!projector || !logPath) return;
    try {
      const result = await projector.projectJournal(logPath, options);
      this.catalogHealthState = result.health;
      if (result.entry) this.catalogEntryState = result.entry;
    } catch (error) {
      // Projector 的契约是 fail-open，但 Session 边界仍不信任任何派生存储。
      logger.warn(
        { error: String(error), sessionId: this.id },
        "[session-catalog] 目录同步失败，JSONL 仍是可恢复真源",
      );
    }
  }

  private scheduleSessionCatalog(
    receipt: CommitReceipt,
    update: {
      readonly appendedMessage?: Message;
      readonly rebuildSummary?: boolean;
      readonly lineage?: SessionCatalogLineage;
    } = {},
  ): void {
    const projector = this.catalogProjector;
    const logPath = this.sessionLogPath;
    if (!projector || !logPath) return;
    const prior = this.catalogEntryState;
    let firstUserMessage = prior?.firstUserMessage;
    let lastUserMessage = prior?.lastUserMessage;
    if (update.rebuildSummary) {
      ({ firstUserMessage, lastUserMessage } = catalogUserSummary(this.history));
    } else if (update.appendedMessage && isCatalogUserMessage(update.appendedMessage)) {
      const content = compactCatalogText(update.appendedMessage.content);
      firstUserMessage ??= content;
      lastUserMessage = content;
    }
    const title = compactCatalogText(this.persistedSettings?.title) ?? firstUserMessage;
    const lineage =
      update.lineage ??
      prior?.lineage ??
      ({ relation: "root", rootLogId: receipt.cursor.logId } satisfies SessionCatalogLineage);
    const entry = {
      schemaVersion: 1,
      logId: receipt.cursor.logId,
      sessionId: this.id,
      logPath,
      identity: this.identity,
      lineage,
      ...(title ? { title } : {}),
      ...(firstUserMessage ? { firstUserMessage } : {}),
      ...(lastUserMessage ? { lastUserMessage } : {}),
      messageCount: this.history.length,
      createdAt: prior?.createdAt ?? this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      lastOpenedAt: prior?.lastOpenedAt ?? this.createdAt.toISOString(),
      journalSchemaVersion: 3,
      head: receipt.cursor,
      health: "healthy",
    } satisfies SessionCatalogEntry;
    // 先更新进程内摘要，后续 commit 可在 O(1) 基础上继续投影。
    this.catalogEntryState = entry;
    this.catalogTail = this.catalogTail
      .then(async () => {
        const result = await projector.projectEntry(entry);
        this.catalogHealthState = result.health;
        if (result.entry && this.catalogEntryState?.head?.eventId === result.entry.head?.eventId) {
          this.catalogEntryState = result.entry;
        }
      })
      .catch((error: unknown) => {
        // Catalog 绝不得把 durable Session 标记为 write_uncertain。
        logger.warn({ error: String(error) }, "[session-catalog] 增量投影队列异常，已降级");
      });
  }

  private assertWritable(): void {
    if (this.lifecycle === "write_uncertain" && this.persistenceFailure) {
      throw this.persistenceFailure;
    }
    if (this.lifecycle !== "open") {
      throw new SessionWriteUncertainError(`Session is not writable (${this.lifecycle})`);
    }
  }

  private markWriteUncertain(message: string, cause: unknown): void {
    if (this.lifecycle === "closed" || this.lifecycle === "closing") return;
    const error =
      cause instanceof SessionWriteUncertainError
        ? cause
        : new SessionWriteUncertainError(message, cause);
    this.persistenceFailure ??= error;
    this.lifecycle = "write_uncertain";
    logger.error({ error: String(cause) }, `[session] ${message}; 已进入 write_uncertain`);
  }

  /**
   * 发起关闭：同步释放 FTS5 句柄以保持旧调用方行为，返回的 Promise
   * 在已排队 run 结束且 JSONL tail 完全 drain 后 resolve。
   * 【连接池化】只释放本 Session 持有的引用(FTS5Store.release),引用计数归零
   * 才真正关闭共享的 sessions.db。关键:Windows 上 SQLite 文件未释放句柄时删除会
   * 触发 EBUSY,必须释放后才能 rm 工作目录。幂等(重复调用安全)。
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifecycle = "closing";
    this.goalBinding?.unsubscribe();
    this.goalBinding = undefined;
    const leasedFts5 = this.fts5Lease;
    if (leasedFts5) {
      FTS5Store.release(this.workDir);
      this.fts5Lease = undefined;
    }
    if (this.searchStore !== leasedFts5) {
      this.searchStore.close();
    }
    if (this.summaryStoreLeasePath) {
      releaseSummaryStore(this.summaryStoreLeasePath);
      this.summaryStoreLeasePath = undefined;
    }

    const drain = this.runQueue
      .then(() => this.compatibilityAppendTail)
      .then(() => {
        // 已排队 run 全部结束后，在同一同步边界禁止后续写入并冻结最终 tail。
        // 若先捕获 tail、再异步标记 closed，窗口内的新写入会逃出 close 的 drain。
        this.lifecycle = "closed";
        return this.persistenceTail;
      })
      .then(() => this.catalogTail)
      .then(() => {
        const store = this.store;
        this.store = undefined;
        return store?.close();
      });
    this.closePromise = registerSessionDrain(sessionEntryKey(this.id, this.workDir), drain);
    return this.closePromise;
  }
}

function catalogUserSummary(history: readonly Message[]): {
  firstUserMessage?: string;
  lastUserMessage?: string;
} {
  const visible = history.filter(isCatalogUserMessage);
  const firstUserMessage = compactCatalogText(visible[0]?.content);
  const lastUserMessage = compactCatalogText(visible.at(-1)?.content);
  return {
    ...(firstUserMessage ? { firstUserMessage } : {}),
    ...(lastUserMessage ? { lastUserMessage } : {}),
  };
}

function isCatalogUserMessage(message: Message): boolean {
  return (
    message.role === "user" &&
    message.toolCallId === undefined &&
    !isMessageHiddenFromTranscript(message) &&
    message.content.trim().length > 0
  );
}

function compactCatalogText(value: string | undefined): string | undefined {
  const compacted = value?.replace(/\s+/gu, " ").trim();
  if (!compacted) return undefined;
  return compacted.length <= 240 ? compacted : `${compacted.slice(0, 239)}…`;
}

function catalogLineageFromSession(
  lineage: SessionLineage,
  parentSessionId?: string,
): SessionCatalogLineage {
  return {
    relation: lineage.relation,
    rootLogId: lineage.rootLogId,
    ...(lineage.parent ? { parentLogId: lineage.parent.logId } : {}),
    ...(lineage.relation === "fork" && lineage.parent
      ? { forkEventId: lineage.parent.eventId }
      : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(lineage.parentTaskId ? { parentTaskId: lineage.parentTaskId } : {}),
  };
}

function deriveUsageFromHistory(history: readonly Message[]): SessionUsageSnapshot {
  const usage = createEmptyUsageSnapshot();
  for (const message of history) {
    if (!message.usage) continue;
    const canonical = toCanonicalUsage(message.usage);
    usage.totalPromptTokens += Math.max(0, canonical.totalPromptTokens);
    usage.totalCompletionTokens += Math.max(0, canonical.totalCompletionTokens);
    usage.totalInputTokens += canonical.inputTokens;
    usage.totalCacheReadTokens += canonical.cacheReadTokens;
    usage.totalCacheWriteTokens += canonical.cacheWriteTokens;
    usage.totalReasoningTokens += canonical.reasoningTokens;
    usage.totalProviderCalls++;
    usage.totalUsageReports++;
    const reported = new Set(message.usage.reportedFields ?? ["prompt", "completion"]);
    if (reported.has("input")) usage.totalInputReports++;
    if (reported.has("cacheRead")) usage.totalCacheReadReports++;
    if (reported.has("cacheWrite")) usage.totalCacheWriteReports++;
    if (reported.has("reasoning")) usage.totalReasoningReports++;
  }
  return usage;
}

function mergeUsageWithHistory(
  persisted: SessionUsageSnapshot | undefined,
  fromHistory: SessionUsageSnapshot,
): SessionUsageSnapshot {
  if (!persisted) return fromHistory;
  return {
    totalPromptTokens: Math.max(persisted.totalPromptTokens, fromHistory.totalPromptTokens),
    totalCompletionTokens: Math.max(
      persisted.totalCompletionTokens,
      fromHistory.totalCompletionTokens,
    ),
    totalInputTokens: Math.max(persisted.totalInputTokens, fromHistory.totalInputTokens),
    totalCacheReadTokens: Math.max(
      persisted.totalCacheReadTokens,
      fromHistory.totalCacheReadTokens,
    ),
    totalCacheWriteTokens: Math.max(
      persisted.totalCacheWriteTokens,
      fromHistory.totalCacheWriteTokens,
    ),
    totalReasoningTokens: Math.max(
      persisted.totalReasoningTokens,
      fromHistory.totalReasoningTokens,
    ),
    totalCostCNY: persisted.totalCostCNY,
    lastCostStatus: persisted.lastCostStatus,
    totalProviderCalls: Math.max(persisted.totalProviderCalls, fromHistory.totalProviderCalls),
    totalUsageReports: Math.max(persisted.totalUsageReports, fromHistory.totalUsageReports),
    totalInputReports: Math.max(persisted.totalInputReports, fromHistory.totalInputReports),
    totalCacheReadReports: Math.max(
      persisted.totalCacheReadReports,
      fromHistory.totalCacheReadReports,
    ),
    totalCacheWriteReports: Math.max(
      persisted.totalCacheWriteReports,
      fromHistory.totalCacheWriteReports,
    ),
    totalReasoningReports: Math.max(
      persisted.totalReasoningReports,
      fromHistory.totalReasoningReports,
    ),
    totalEstimatedCostReports: persisted.totalEstimatedCostReports,
    totalIncludedCostReports: persisted.totalIncludedCostReports,
    totalUnknownCostReports: persisted.totalUnknownCostReports,
  };
}

/**
 * SessionManager:全局会话管理器,负责多用户 / 多终���的物理隔离。
 * 以 sessionId 为 key,O(1) 路由到对应 Session 实例。
 *
 * 【内存治理】LRU + TTL 双重驱逐,防长跑内存膨胀:
 * - LRU:maxSessions 上限(默认 128)。超出时驱逐"最近最少使用"的 Session,
 *   驱逐前调 session.close() 释放 SQLite 句柄(防 fd 泄漏)。
 * - TTL:空闲超时(默认 24h)。每次 getOrCreate 惰性扫描,驱逐长期闲置 Session。
 *   飞书多群场景下,沉默群的历史不再常驻内存,被再次唤醒时从 JSONL recover 重建。
 * - MRU 提升:get/getOrCreate/delete+set 把目标提到 Map 末尾(最近使用),
 *   Map 的迭代序即 LRU 序,首个元素即最旧。对标 hermes GatewaySession 的容量管理。
 *
 * 注意:驱逐只释放内存实例 + SQLite 句柄;持久化在磁盘的 JSONL 不删,
 * 被 recover 唤醒即可续传。
 */
export class SessionManager {
  /** 默认最大常驻会话数(对标 hermes gateway 的会话池上限量级) */
  static readonly DEFAULT_MAX_SESSIONS = 128;
  /** 默认空闲超时 24h:超过未访问的会话被惰性驱逐 */
  static readonly DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

  private readonly entries = new Map<string, { session: Session; lastAccessMs: number }>();
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
   * 新建时自动重放磁盘日志恢复历史(recover)。返回 Promise 以支持异步恢复。
   * persistence 显式透传给 Session(测试场景精确控制,避免环境变量并行污染)。
   *
   * 命中时做 MRU 提升(删除后重新 set 到末尾);新建后触发 LRU 驱赶 + TTL 惰性清理。
   */
  async getOrCreate(id: string, workDir: string, options?: SessionOptions): Promise<Session> {
    // TTL 惰性清理:借这次访问顺带扫一遍过期项(低频,不阻塞主流程)。
    this.evictExpired();

    const key = this.entryKey(id, workDir);
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
  get(id: string, workDir?: string): Session | undefined {
    const key = this.findEntryKey(id, workDir);
    if (!key) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.lastAccessMs = Date.now();
    this.touch(key);
    return entry.session;
  }

  /** 删除已存在的会话并返回被删除实例;不存在时返回 undefined。释放底层资源。 */
  delete(id: string, workDir?: string): Session | undefined {
    const key = this.findEntryKey(id, workDir);
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
  private evictLru(): void {
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.deleteByKey(oldest);
    }
  }

  /** TTL 惰性清理:驱逐空闲超过 ttlMs 的会话。每次 getOrCreate 调一次。 */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastAccessMs > this.ttlMs) {
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
    await session.recover();
    this.entries.set(key, { session, lastAccessMs: Date.now() });
    this.evictLru();
    return session;
  }

  private startDrain(key: string, session: Session): void {
    void session.close().catch((error: unknown) => {
      logger.warn({ key, error: String(error) }, "[session] 驱逐时持久化 drain 失败");
    });
  }

  private entryKey(id: string, workDir: string): string {
    return sessionEntryKey(id, workDir);
  }

  private findEntryKey(id: string, workDir?: string): string | undefined {
    if (workDir !== undefined) {
      const key = this.entryKey(id, workDir);
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
