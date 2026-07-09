// Steer 队列:host 在 Agent 运行期间注入的引导文本,下一轮 drain 给模型。
//
// 语义(ROADMAP 3.2):Agent 正在跑一个长任务(多轮 ReAct),host 想中途插话
// 引导它("现在重点处理测试文件")。不能打断当前 LLM 调用,等当前轮的工具执行完后,
// 把 steer 文本作为 user 消息注入,下一轮模型就能看到。
//
// 双点浮现(loop.ts 集成):
//   - A 点(provider 调用前):peek 当前 steer,临时拼进 compactedContext 末尾,
//     本轮模型立即看到(不落 session)。让 host 插的话尽快生效。
//   - C 点(工具结果 append 后):drain 队列,把每条 steer 落成一条 user 消息,
//     写进 session。下一轮 getWorkingMemory 自动浮现,永久可见。
//
// 极简:数组 + push/peek/drain,无并发原语(session.serialize 保证 per-session
// 串行,host 在 run 期间 push 不需要锁)。

/** Steer 队列:host 在 Agent 运行期间注入的引导文本,下一轮 drain 给模型。 */
export class SteerQueue {
  private queue: string[] = [];

  /** 入队一条引导文本(FIFO)。 */
  push(text: string): void {
    if (text) this.queue.push(text);
  }

  /**
   * 窥视队首(不移除)。A 点用它临时拼进 compactedContext,
   * 让本轮模型在 drain 之前就能先看到 steer。
   */
  peek(): string | undefined {
    return this.queue[0];
  }

  /**
   * 取出并清空整个队列。C 点用它在工具结果落地后把所有 steer 写进 session,
   * 下一轮 getWorkingMemory 自动浮现。返回的顺序即 push 顺序(FIFO)。
   */
  drain(): string[] {
    const r = this.queue;
    this.queue = [];
    return r;
  }

  /** 是否有待处理的 steer。 */
  get pending(): boolean {
    return this.queue.length > 0;
  }
}
