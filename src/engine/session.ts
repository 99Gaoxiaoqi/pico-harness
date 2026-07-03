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

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalUsage, Message } from "../schema/message.js";
import type { CostStatus } from "../observability/pricing.js";
import { logger } from "../observability/logger.js";
import { SessionStore } from "./session-store.js";
import { FTS5Store } from "../memory/fts5-store.js";

/** 清洗 sessionId 为安全文件名片段(/、: 等破坏路径的字符替换为 _) */
function sanitizeFilePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
}

/**
 * Session:一次持续的人机交互过程。
 * 负责维护该会话的完整历史,并提供 WorkingMemory 提取。
 */
export class Session {
  /** 会话标识(终端目录哈希 / 飞书 ChatID / 微信 OpenID) */
  readonly id: string;
  /** 该会话绑定的物理工作区 */
  readonly workDir: string;
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

  private history: Message[] = [];

  /**
   * 持久化:事件溯源 JSONL。undefined 表示持久化关闭(环境变量门控)。
   * 默认开启(对标 kimi-code wire.jsonl);PICO_PERSISTENCE=0 关闭。
   */
  private store?: SessionStore;
  /** 下一条 record 的序列号(单调递增,保证重放顺序与幂等) */
  private nextSeq = 0;
  /**
   * 未落盘的 append 写入 Promise 集合。
   * truncate 落盘前必须先 await 这些 Promise,否则 fire-and-forget 乱序可能
   * 让 truncate record 先于 earlier appends 写入磁盘,崩溃恢复重放时
   * 会因缺失 message 导致历史丢失(对标 C1 竞态修复)。
   */
  private pendingWrites: Promise<void>[] = [];

  /**
   * 并发安全:per-session 串行执行队列。
   * 飞书多群/连发消息时,同一 Session 的 engine.run 必须串行,
   * 否则并发读写 history 导致上下文错乱、孤儿 ToolResult、API 400。
   * 通过 Promise 链实现:每个 run 排队等前一个完成。
   */
  private runQueue: Promise<unknown> = Promise.resolve();

  /**
   * FTS5 全文检索存储。可选,初始化失败降级为 undefined。
   * 用于对话历史的语义检索和周期性记忆提醒。
   */
  private fts5?: FTS5Store;

  constructor(id: string, workDir: string, options?: { persistence?: boolean }) {
    this.id = id;
    this.workDir = workDir;
    this.createdAt = new Date();
    this.updatedAt = new Date();
    this.initPersistence(options?.persistence);
    this.initFTS5();
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
    const enabled = explicit ?? (process.env.PICO_PERSISTENCE !== "0");
    if (!enabled) return;
    try {
      const dir = join(this.workDir, ".claw", "sessions");
      mkdirSync(dir, { recursive: true });
      this.store = new SessionStore(join(dir, `${sanitizeFilePart(this.id)}.jsonl`));
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
  private initFTS5(): void {
    try {
      const store = FTS5Store.acquire(this.workDir);
      this.fts5 = store ?? undefined;
    } catch (err) {
      logger.warn({ err }, '[session] FTS5 初始化失败,降级为纯内存');
      this.fts5 = undefined;
    }
  }

  /**
   * 重启后重放事件日志,重建内存 history(对标 kimi-code AgentRecords.replay)。
   * 在 SessionManager.getOrCreate 新建实例时自动调用一次。
   * 持久化关闭时为空操作。
   */
  async recover(): Promise<void> {
    if (!this.store) return;
    let records;
    try {
      records = await this.store.load();
    } catch (error) {
      // 兜底:load 内部已对中间行损坏改为跳过+warn,这里只会捕获未预期的致命错误
      logger.warn({ error: String(error) }, "[session] 日志重放失败,降级为空历史");
      return;
    }
    if (records.length === 0) return;

    // 重放:message 累积进 pending,truncate 则截断 pending(对标 wire 折叠语义)
    let pending: Message[] = [];
    for (const r of records) {
      if (r.type === "message") {
        pending.push(r.message);
      } else if (r.type === "truncate") {
        pending = pending.slice(r.fromIndex);
      }
    }
    this.history = pending;
    this.nextSeq = (records[records.length - 1]?.seq ?? -1) + 1;
  }

  /**
   * 串行执行一个任务:同一 Session 的多个调用自动排队,
   * 保证同一时刻只有一个 engine.run 在操作 history。
   * 返回任务的 Promise(结果需调用方 await)。
   */
  serialize<T>(task: () => Promise<T>): Promise<T> {
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
  ): void {
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
    }
  }

  /** 向 Session 追加消息(可批量)。内存写后追加事件到 JSONL(对标 kimi-code wire.jsonl) */
  append(...msgs: Message[]): void {
    const beforeLen = this.history.length;
    this.history.push(...msgs);
    this.updatedAt = new Date();

    // FTS5 索引:为每条消息建立全文检索索引(用于记忆提醒和语义检索)
    if (this.fts5) {
      for (let i = 0; i < msgs.length; i++) {
        try {
          this.fts5.insert(this.id, beforeLen + i, msgs[i]!);
        } catch (err) {
          logger.warn({ err }, '[session] FTS5 索引失败');
        }
      }
    }

    // 事件追加落盘:fire-and-forget,失败仅 warn 不阻塞主循环(对标 kimi-code append)。
    // Promise 收集到 pendingWrites,供 persistTruncate 落盘前 await,避免 truncate
    // 抢先写入导致重放时 message 缺失(C1 竞态修复)。
    if (this.store) {
      for (const m of msgs) {
        const seq = this.nextSeq++;
        const writePromise = this.store
          .appendMessage(seq, m)
          .catch((err) =>
            logger.warn({ seq }, `[session] 持久化写入失败: ${String(err)}`),
          );
        this.pendingWrites.push(writePromise);
      }
    }
  }

  /**
   * 硬重置兜底:截断历史,只保留 fromIndex 起的消息(含)。
   * 用于 loop.ts 捕获 ContextCompactionError 后,丢弃爆掉的历史,
   * 仅保留本轮用户输入(history[beforeLen])让模型重新规划。
   * 累计成本统计保留(对齐 kimi-code clear 不碰 usage 的语义)。
   */
  truncateTo(fromIndex: number): void {
    if (fromIndex < 0) fromIndex = 0;
    if (fromIndex >= this.history.length) {
      this.history = [];
      this.updatedAt = new Date();
      // 追加 truncate 事件(fromIndex = 历史长度 → 重放后为空)
      void this.persistTruncate(fromIndex);
      return;
    }
    this.history = this.history.slice(fromIndex);
    this.updatedAt = new Date();
    void this.persistTruncate(fromIndex);
  }

  /**
   * 追加 truncate 事件到 JSONL。重放时据此折叠历史。
   * 关键:落盘前必须先 await earlier appends(pendingWrites),保证 truncate record
   * 在文件中位于所有 prior message records 之后;否则 fire-and-forget 乱序会让
   * truncate 先写完,崩溃恢复重放时因缺失 message 导致折叠后历史丢失(C1 修复)。
   * truncateTo 同步调用,内部用 void 触发本异步方法;调用方靠 flush/重启等落盘。
   */
  private async persistTruncate(fromIndex: number): Promise<void> {
    if (!this.store) return;
    // 先捕获并清空当前 pending,再 await。避免 await 期间新 append push 的 promise
    // 被错误清空(truncateTo 之后继续 append 是合法的续接场景)。
    const pending = this.pendingWrites;
    this.pendingWrites = [];
    await Promise.all(pending);
    const seq = this.nextSeq++;
    this.store.appendTruncate(seq, fromIndex).catch((err) =>
      logger.warn({ seq }, `[session] truncate 落盘失败: ${String(err)}`),
    );
  }

  /**
   * 模型摘要压缩:用一条 role:assistant 的 summary 消息替换 history 前 compactedCount 条。
   * 对标 kimi-code applyCompaction —— 真改 Session.history(与字符级 Compactor 不同,
   * 字符级只改临时 context 不碰 Session)。
   *
   * 内存语义:history = [summaryMsg, ...history.slice(compactedCount)]。
   * 保留尾部(从 compactedCount 起的消息)不动,前缀浓缩成一条摘要。
   *
   * 持久化顺序(复用 pendingWrites 机制,保证重放正确):
   *   1. 先 await earlier appends(让 prior message records 先落盘)
   *   2. append truncate(beforeLen) —— 丢弃当前累积的全部 beforeLen 条
   *   3. append summary message —— 重放后成为新 history 的第一条
   *   4. append retained tail —— 重放后跟在 summary 之后
   * 重放结果:[summary, ...retained],与内存一致。
   *
   * 用 truncate + 重写尾部而非"前插 summary",因为本 JSONL 只支持
   * message(push)+ truncate(slice)两种 record,无法表达"在头部插入"。
   * 压缩是低频事件,重写尾部(retainLastN 通常很小)开销可接受。
   *
   * 本方法只做纯存储,summary 内容的 REFERENCE-ONLY 包装由调用方(FullCompactor)负责。
   *
   * @param summary 摘要消息正文(已由调用方套上 REFERENCE-ONLY 前后标记)
   * @param compactedCount 被压缩的前缀条数(0..history.length)
   */
  applyCompaction(summary: string, compactedCount: number): void {
    if (compactedCount < 0) compactedCount = 0;
    if (compactedCount > this.history.length) compactedCount = this.history.length;
    const beforeLen = this.history.length;
    const retained = this.history.slice(compactedCount);
    // 摘要消息:role=assistant(对标 kimi-code compaction_summary)
    const summaryMsg: Message = {
      role: "assistant",
      content: summary,
    };
    // 内存:用 summary 替换前 compactedCount 条
    this.history = [summaryMsg, ...retained];
    this.updatedAt = new Date();
    void this.persistCompaction(beforeLen, summaryMsg, retained);
  }

  /**
   * 持久化模型摘要压缩事件:truncate(清空当前累积)→ summary → retained tail。
   * 关键顺序:truncate 必须在 summary/tail 之前落盘,重放才正确(drop all → rebuild)。
   * 复用 pendingWrites:先 await earlier appends,再 await truncate 写入,
   * 最后把 summary/tail 作为 fire-and-forget 收集进 pendingWrites 供后续 await。
   */
  private async persistCompaction(
    beforeLen: number,
    summaryMsg: Message,
    retained: Message[],
  ): Promise<void> {
    if (!this.store) return;
    const pending = this.pendingWrites;
    this.pendingWrites = [];
    await Promise.all(pending);
    // 1. truncate:丢弃当前累积的全部 beforeLen 条(必须先于 summary/tail 落盘)
    const truncSeq = this.nextSeq++;
    try {
      await this.store.appendTruncate(truncSeq, beforeLen);
    } catch (err) {
      logger.warn({ seq: truncSeq }, `[session] compaction truncate 落盘失败: ${String(err)}`);
    }
    // 2. summary message(重放后成为新 history 头部)
    const sumSeq = this.nextSeq++;
    this.pendingWrites.push(
      this.store.appendMessage(sumSeq, summaryMsg).catch((err) =>
        logger.warn({ seq: sumSeq }, `[session] compaction summary 落盘失败: ${String(err)}`),
      ),
    );
    // 3. retained tail(重放后跟在 summary 之后,保持原顺序)
    for (const m of retained) {
      const seq = this.nextSeq++;
      this.pendingWrites.push(
        this.store.appendMessage(seq, m).catch((err) =>
          logger.warn({ seq }, `[session] compaction retained 落盘失败: ${String(err)}`),
        ),
      );
    }
  }

  /** 返回全量历史的深拷贝(仅供调试 / 测试,不参与推理) */
  getHistory(): Message[] {
    return this.history.map((m) => ({ ...m }));
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
    if (total <= limit || limit <= 0) {
      // 历史总量小于限制或不设限:全量返回(深拷贝以防外部修改污染内部)
      return this.history.map((m) => ({ ...m }));
    }

    // 截取最近的 limit 条
    let res = this.history.slice(total - limit).map((m) => ({ ...m }));

    // 丢弃断头的孤儿 ToolResult,保证历史连续性
    while (res.length > 0) {
      const first = res[0]!;
      if (first.role === "user" && first.toolCallId) {
        res = res.slice(1);
      } else {
        break;
      }
    }
    return res;
  }

  /**
   * 全文检索历史对话(基于 FTS5)。
   * 用于 MemoryNudger 生成记忆提醒时查询相关历史。
   * @param query - 搜索关键词
   * @param limit - 返回结果数(默认 10)
   * @returns 匹配的对话片段(按相关性排序,仅返回当前 Session 的消息)
   */
  search(query: string, limit = 10): Array<{ content: string; turnIndex: number; sessionId: string }> {
    if (!this.fts5) {
      logger.warn('[session] FTS5 未初始化,无法检索');
      return [];
    }

    try {
      // 传入 sessionId 过滤,只返回当前 Session 的消息
      const results = this.fts5.search(query, limit, this.id);
      return results.map((r) => ({
        content: r.content,
        turnIndex: r.turnIndex,
        sessionId: r.sessionId,
      }));
    } catch (err) {
      logger.warn({ err, query }, '[session] FTS5 检索失败');
      return [];
    }
  }

  /** 获取 FTS5Store 实例(用于 MemoryNudger) */
  get fts5Store(): FTS5Store | undefined {
    return this.fts5;
  }

  /**
   * 关闭底层资源(FTS5 SQLite 连接引用)。进程退出或测试清理前调用。
   * 【连接池化】只释放本 Session 持有的引用(FTS5Store.release),引用计数归零
   * 才真正关闭共享的 sessions.db。关键:Windows 上 SQLite 文件未释放句柄时删除会
   * 触发 EBUSY,必须释放后才能 rm 工作目录。幂等(重复调用安全)。
   */
  close(): void {
    if (this.fts5) {
      FTS5Store.release(this.workDir);
      this.fts5 = undefined;
    }
  }
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
  private readonly maxSessions: number;
  private readonly ttlMs: number;

  constructor(options?: { maxSessions?: number; ttlMs?: number }) {
    this.maxSessions = options?.maxSessions ?? SessionManager.DEFAULT_MAX_SESSIONS;
    this.ttlMs = options?.ttlMs ?? SessionManager.DEFAULT_TTL_MS;
  }

  /**
   * 获取或创建一个会话(同 id 复用,不同 id 物理隔离)。
   * 新建时自动重放磁盘日志恢复历史(recover)。返回 Promise 以支持异步恢复。
   * persistence 显式透传给 Session(测试场景精确控制,避免环境变量并行污染)。
   *
   * 命中时做 MRU 提升(删除后重新 set 到末尾);新建后触发 LRU 驱赶 + TTL 惰性清理。
   */
  async getOrCreate(
    id: string,
    workDir: string,
    options?: { persistence?: boolean },
  ): Promise<Session> {
    // TTL 惰性清理:借这次访问顺带扫一遍过期项(低频,不阻塞主流程)。
    this.evictExpired();

    const existing = this.entries.get(id);
    if (existing) {
      existing.lastAccessMs = Date.now();
      this.touch(id); // MRU 提升
      return existing.session;
    }

    const sess = new Session(id, workDir, options);
    await sess.recover();
    this.entries.set(id, { session: sess, lastAccessMs: Date.now() });
    // LRU 驱赶:新增后若超 maxSessions,驱逐最旧(刚 set 的不会是最旧)。
    this.evictLru();
    return sess;
  }

  /**
   * 获取已存在的会话(不创建)。命中时做 MRU 提升与 lastAccess 更新。
   * 不触发 TTL 清理(get 应轻量;清理在 getOrCreate 路径做)。
   */
  get(id: string): Session | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.lastAccessMs = Date.now();
    this.touch(id);
    return entry.session;
  }

  /** 删除已存在的会话并返回被删除实例;不存在时返回 undefined。释放底层资源。 */
  delete(id: string): Session | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    entry.session.close();
    return entry.session;
  }

  /** 当前管理的会话总数 */
  get size(): number {
    return this.entries.size;
  }

  /** 清空所有会话(主要用于测试)。释放每个 Session 的底层资源。 */
  clear(): void {
    for (const { session } of this.entries.values()) {
      session.close();
    }
    this.entries.clear();
  }

  /** MRU 提升:把 key 移到 Map 末尾(最近使用),保持迭代序 = LRU 序。 */
  private touch(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  /** LRU 驱赶:超出 maxSessions 时驱逐最旧项,直到回到上限内。 */
  private evictLru(): void {
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  /** TTL 惰性清理:驱逐空闲超过 ttlMs 的会话。每次 getOrCreate 调一次。 */
  private evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.lastAccessMs > this.ttlMs) {
        // 复用 delete:从 entries 移除并 close()
        this.entries.delete(id);
        entry.session.close();
      }
    }
  }
}

/**
 * 全局 SessionManager 单例。
 * 飞书后台无论收到多少群聊,都通过分配不同的 sessionId 各自安好。
 */
export const globalSessionManager = new SessionManager();
