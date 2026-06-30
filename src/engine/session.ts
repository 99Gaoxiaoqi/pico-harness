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
import { SessionStore } from "./session-store.js";

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
   * 并发安全:per-session 串行执行队列。
   * 飞书多群/连发消息时,同一 Session 的 engine.run 必须串行,
   * 否则并发读写 history 导致上下文错乱、孤儿 ToolResult、API 400。
   * 通过 Promise 链实现:每个 run 排队等前一个完成。
   */
  private runQueue: Promise<unknown> = Promise.resolve();

  constructor(id: string, workDir: string, options?: { persistence?: boolean }) {
    this.id = id;
    this.workDir = workDir;
    this.createdAt = new Date();
    this.updatedAt = new Date();
    this.initPersistence(options?.persistence);
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
      console.warn(`[session] 持久化初始化失败,降级为纯内存: ${String(error)}`);
      this.store = undefined;
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
      // 中间行损坏(非末行撕裂):不静默吞,降级为空 history 从头开始
      console.warn(`[session] 日志重放失败,降级为空历史: ${String(error)}`);
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
    this.history.push(...msgs);
    this.updatedAt = new Date();
    // 事件追加落盘:fire-and-forget,失败仅 warn 不阻塞主循环(对标 kimi-code append)
    if (this.store) {
      for (const m of msgs) {
        const seq = this.nextSeq++;
        this.store.appendMessage(seq, m).catch((err) =>
          console.warn(`[session] 持久化写入失败(seq=${seq}): ${String(err)}`),
        );
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
      this.persistTruncate(fromIndex);
      return;
    }
    this.history = this.history.slice(fromIndex);
    this.updatedAt = new Date();
    this.persistTruncate(fromIndex);
  }

  /** 追加 truncate 事件到 JSONL(fire-and-forget)。重放时据此折叠历史。 */
  private persistTruncate(fromIndex: number): void {
    if (!this.store) return;
    const seq = this.nextSeq++;
    this.store.appendTruncate(seq, fromIndex).catch((err) =>
      console.warn(`[session] truncate 落盘失败(seq=${seq}): ${String(err)}`),
    );
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
}

/**
 * SessionManager:全局会话管理器,负责多用户 / 多终端的物理隔离。
 * 以 sessionId 为 key,O(1) 路由到对应 Session 实例。
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  /**
   * 获取或创建一个会话(同 id 复用,不同 id 物理隔离)。
   * 新建时自动重放磁盘日志恢复历史(recover)。返回 Promise 以支持异步恢复。
   * persistence 显式透传给 Session(测试场景精确控制,避免环境变量并行污染)。
   */
  async getOrCreate(
    id: string,
    workDir: string,
    options?: { persistence?: boolean },
  ): Promise<Session> {
    let sess = this.sessions.get(id);
    if (!sess) {
      sess = new Session(id, workDir, options);
      await sess.recover();
      this.sessions.set(id, sess);
    }
    return sess;
  }

  /** 获取已存在的会话(不创建) */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** 删除已存在的会话并返回被删除实例;不存在时返回 undefined */
  delete(id: string): Session | undefined {
    const sess = this.sessions.get(id);
    if (sess) {
      this.sessions.delete(id);
    }
    return sess;
  }

  /** 当前管理的会话总数 */
  get size(): number {
    return this.sessions.size;
  }

  /** 清空所有会话(主要用于测试) */
  clear(): void {
    this.sessions.clear();
  }
}

/**
 * 全局 SessionManager 单例。
 * 飞书后台无论收到多少群聊,都通过分配不同的 sessionId 各自安好。
 */
export const globalSessionManager = new SessionManager();
