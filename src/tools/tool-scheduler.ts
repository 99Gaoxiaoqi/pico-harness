// 有状态资源冲突调度器:在一批 tool_call 上做最大独立集贪心并行。
//
// 对应 kimi-code packages/agent-core/src/loop/tool-scheduler.ts。
//
// 职责:仅管"执行顺序"——
//   - 资源不冲突的任务可重叠执行
//   - 资源冲突的任务等待冲突方完成后才启动
//   - 结果按 provider 原始顺序��传(由调用侧 add 的顺序保证)
//
// 两个硬不变量(代码强制保证):
//   1. start 准入:新进 active 的任务必须与所有 activeTasks 不冲突,
//      且与排在它前面的 queuedTasks 不冲突(否则会乱序抢跑)。
//   2. 结果保序:任务可乱序完成,但 add() 返回的 Promise 按 add 顺序 resolve。

import { ToolAccesses, type ToolAccesses as ToolAccessesType } from "./tool-access.js";

/**
 * 调度器管理的单个任务。
 * accesses:本任务声明的资源访问集(用于冲突判定)
 * start:启动执行,返回结果 Promise
 */
export interface ToolCallTask<R> {
  readonly accesses: ToolAccessesType;
  readonly start: () => Promise<R>;
}

interface ScheduledTask<R> extends ToolCallTask<R> {
  /** 外部可控的 result Promise —— add() 返回它的句柄,内部执行完毕时 resolve */
  readonly resolve: (value: R) => void;
  readonly reject: (reason: unknown) => void;
  /** 真正正在跑的执行 Promise(可能因冲突而尚未启动) */
  running?: Promise<void>;
}

/**
 * ToolScheduler:单批 tool_call 的并发调度器。
 *
 * 用法:
 *   const scheduler = new ToolScheduler<Result>();
 *   const promises = toolCalls.map(tc => scheduler.add({ accesses, start: () => exec(tc) }));
 *   const results = await Promise.all(promises);  // 按 add 顺序,即 provider order
 */
export class ToolScheduler<R> {
  /** 正在并行执行的任务(两两不冲突) */
  private readonly active: ScheduledTask<R>[] = [];
  /** 排队等待冲突解除的任务 */
  private queued: ScheduledTask<R>[] = [];

  /**
   * 加入一个任务。立即返回其结果 Promise(按 add 顺序 resolve,即 provider order)。
   * 任务是否立即启动取决于它与当前 active/前面 queued 的冲突关系。
   */
  add(task: ToolCallTask<R>): Promise<R> {
    // 创建外部可控的 Promise,返回句柄给调用方
    let resolveFn!: (value: R) => void;
    let rejectFn!: (reason: unknown) => void;
    const result = new Promise<R>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });

    const scheduled: ScheduledTask<R> = { ...task, resolve: resolveFn, reject: rejectFn };

    // 准入判定:与正在跑的冲突?或与前面排队还没跑的冲突?
    if (this.isBlocked(scheduled)) {
      this.queued.push(scheduled);
    } else {
      this.start(scheduled);
    }

    return result;
  }

  /** 判定任务是否被阻塞:与任何 active 冲突,或与任何前面 queued 冲突 */
  private isBlocked(task: ScheduledTask<R>): boolean {
    return this.conflictsWithAny(task, this.active) || this.conflictsWithAny(task, this.queued);
  }

  private conflictsWithAny(task: ScheduledTask<R>, candidates: readonly ScheduledTask<R>[]): boolean {
    return candidates.some((c) => ToolAccesses.conflict(task.accesses, c.accesses));
  }

  /** 启动任务执行 */
  private start(task: ScheduledTask<R>): void {
    this.active.push(task);
    let started: Promise<R>;
    try {
      started = task.start();
    } catch (error) {
      task.reject(error);
      this.finish(task);
      return;
    }

    // 执行完毕 → resolve 外部句柄 → finish 移出 active → 唤醒队列
    task.running = started
      .then(
        (value) => task.resolve(value),
        (error) => task.reject(error),
      )
      .finally(() => {
        this.finish(task);
      });
  }

  /** 任务完成(正常或异常):移出 active,重新评估队列 */
  private finish(task: ScheduledTask<R>): void {
    const index = this.active.indexOf(task);
    if (index >= 0) this.active.splice(index, 1);
    this.startQueuedTasks();
  }

  /**
   * 贪心唤醒:扫描整个队列,凡是不再被任何 active/前面 queued 阻塞的全部启动。
   * 每完成一个任务都重新评估,最大化并行度。
   */
  private startQueuedTasks(): void {
    const stillQueued: ScheduledTask<R>[] = [];
    for (const task of this.queued) {
      // 注意:这里判定要用"已经决定留下来的 stillQueued",保证不会让排在
      // 还没唤醒的阻塞任务后面的任务抢跑(维持 provider order 的正确性)。
      const blockedByActive = this.conflictsWithAny(task, this.active);
      const blockedByQueuedBefore = stillQueued.some((c) =>
        ToolAccesses.conflict(task.accesses, c.accesses),
      );
      if (blockedByActive || blockedByQueuedBefore) {
        stillQueued.push(task);
      } else {
        this.start(task);
      }
    }
    this.queued = stillQueued;
  }
}
