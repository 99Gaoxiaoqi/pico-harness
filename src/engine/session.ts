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

import type { Message } from "../schema/message.js";

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
  /** 累计花费(人民币元) */
  totalCostCNY = 0;

  private history: Message[] = [];

  /**
   * 并发安全:per-session 串行执行队列。
   * 飞书多群/连发消息时,同一 Session 的 engine.run 必须串行,
   * 否则并发读写 history 导致上下文错乱、孤儿 ToolResult、API 400。
   * 通过 Promise 链实现:每个 run 排队等前一个完成。
   */
  private runQueue: Promise<unknown> = Promise.resolve();

  constructor(id: string, workDir: string) {
    this.id = id;
    this.workDir = workDir;
    this.createdAt = new Date();
    this.updatedAt = new Date();
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
  recordUsage(promptTokens: number, completionTokens: number, costCNY: number): void {
    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    this.totalCostCNY += costCNY;
  }

  /** 向 Session 追加消息(可批量) */
  append(...msgs: Message[]): void {
    this.history.push(...msgs);
    this.updatedAt = new Date();
    // 【持久化预留点】:真实工业级实现(如 Claude Code)会在此把 history
    // 以 JSONL 格式追加落盘到 workDir/.claw/sessions/<id>.jsonl,以支持重启恢复。
    // 第 13 讲将补齐文件系统持久化记忆。
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

  /** 获取或创建一个会话(同 id 复用,不同 id 物理隔离) */
  getOrCreate(id: string, workDir: string): Session {
    let sess = this.sessions.get(id);
    if (!sess) {
      sess = new Session(id, workDir);
      this.sessions.set(id, sess);
    }
    return sess;
  }

  /** 获取已存在的会话(不创建) */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
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
