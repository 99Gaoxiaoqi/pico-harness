// 有状态资源冲突调度器:在一批 tool_call 上做最大独立集贪心并行。
//
// 对应 kimi-code packages/agent-core/src/loop/tool-scheduler.ts。
//
// 职责:仅管"执行顺序"——
//   - 资源不冲突的任务可重叠执行
//   - 资源冲突的任务等待冲突方完成后才启动
//   - 结果按 provider 原始顺序回传(由调用侧 add 的顺序保证)
//
// 两个硬不变量(代码强制保证):
//   1. start 准入:新进 active 的任务必须与所有 activeTasks 不冲突,
//      且与排在它前面的 queuedTasks 不冲突(否则会乱序抢跑)。
//   2. 结果保序:任务可乱序完成,但 add() 返回的 Promise 按 add 顺序 resolve。
//
// 执行器韧性(对标 hermes ThreadPoolExecutor + 中断响应):
//   - maxConcurrency: 并发名额上限,超出则进 queued 等名额释放(不报错、不丢弃)。
//   - signal: AbortSignal,触发时排队的任务立即 reject,正在跑的任务也 reject 其
//     外部句柄(调度层中断)。正在跑的工具执行本身跑到自然结束,真正中途取消是
//     后续 runOneTool 内部检查 signal 的改动,不在此层。

import { ToolAccesses, type ToolAccesses as ToolAccessesType } from "./tool-access.js";

/** 默认不限制并发(保持原行为,向后兼容) */
const DEFAULT_MAX_CONCURRENCY = Infinity;

/** AbortSignal 不可用时用作 fallback 的中止错误 */
function makeAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("aborted", "AbortError");
}

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

/** 调度器配置:并发上限 + 中止信号,全可选,向后兼容无参构造 */
export interface ToolSchedulerOptions {
  /**
   * 最大并发执行数。超出 maxConcurrency 的任务进 queued 等名额释放。
   * 默认 Infinity(不限制,保持原行为)。对齐 hermes _MAX_TOOL_WORKERS=8。
   */
  readonly maxConcurrency?: number;
  /**
   * 中止信号。abort 时:
   *   - queued 中所有任务立即 reject(不泄漏,否则 Promise.all 永久卡死)
   *   - active 任务 reject 其外部句柄(让 Promise.all 快速收口)
   *   - 调度器进入终态,后续 add 也直接 reject
   */
  readonly signal?: AbortSignal;
}

/**
 * ToolScheduler:单批 tool_call 的并发调度器。
 *
 * 用法:
 *   const scheduler = new ToolScheduler<Result>();
 *   const promises = toolCalls.map(tc => scheduler.add({ accesses, start: () => exec(tc) }));
 *   const results = await Promise.all(promises);  // 按 add 顺序,即 provider order
 *
 * 带护栏:
 *   const scheduler = new ToolScheduler<Result>({ maxConcurrency: 8, signal: ctrl.signal });
 */
export class ToolScheduler<R> {
  /** 正在并行执行的任务(两两不冲突,且不超过 maxConcurrency) */
  private readonly active: ScheduledTask<R>[] = [];
  /** 排队等待(冲突 �� 名额已满)的任务 */
  private queued: ScheduledTask<R>[] = [];
  private readonly maxConcurrency: number;
  private readonly signal?: AbortSignal;
  /** 是否已中止(避免重复处理,也用于 add 时短路) */
  private aborted = false;

  constructor(options: ToolSchedulerOptions = {}) {
    const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    // fail-fast:无效并发上限立即抛错,避免 isBlocked 恒真导致所有任务进 queued、
    // Promise.all 静默死锁(参考 compactor 的 ContextCompactionError 哲学:宁可崩溃不可静默错)
    if (maxConcurrency < 1) {
      throw new Error(`maxConcurrency must be >= 1, got: ${maxConcurrency}`);
    }
    this.maxConcurrency = maxConcurrency;
    this.signal = options.signal;
    // 启动即监听;若信号已被 abort(常见于复用),attachAbort 内部会立即触发
    if (this.signal) this.attachAbort(this.signal);
  }

  /**
   * 加入一个任务。立即返回其结果 Promise(按 add 顺序 resolve,即 provider order)。
   * 任务是否立即启动取决于它与当前 active/前面 queued 的冲突关系,以及并发名额。
   */
  add(task: ToolCallTask<R>): Promise<R> {
    // 创建外部可控的 Promise,返回句柄给调用方
    let resolveFn!: (value: R) => void;
    let rejectFn!: (reason: unknown) => void;
    const result = new Promise<R>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });

    // 已中止:直接 reject,不进队列(否则永不 resolve)
    if (this.aborted) {
      rejectFn(makeAbortError(this.signal));
      return result;
    }

    const scheduled: ScheduledTask<R> = { ...task, resolve: resolveFn, reject: rejectFn };

    // 准入判定:冲突? 或 排在前面的 queued 冲突? 或 并发名额已满?
    if (this.isBlocked(scheduled)) {
      this.queued.push(scheduled);
    } else {
      this.start(scheduled);
    }

    return result;
  }

  /** 判定任务是否被阻塞:与任何 active 冲突,或与任何前面 queued 冲突,或名额已满 */
  private isBlocked(task: ScheduledTask<R>): boolean {
    return (
      this.conflictsWithAny(task, this.active) ||
      this.conflictsWithAny(task, this.queued) ||
      this.active.length >= this.maxConcurrency
    );
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
   * 贪心唤醒:扫描整个队列,凡是不再被任何 active/前面 queued 阻塞、且名额未满的全部启动。
   * 每完成一个任务都重新评估,最大化并行度。
   */
  private startQueuedTasks(): void {
    if (this.aborted) return; // 已中止,不再启动新任务
    const stillQueued: ScheduledTask<R>[] = [];
    for (const task of this.queued) {
      // 注意:这里判定要用"已经决定留下来的 stillQueued",保证不会让排在
      // 还没唤醒的阻塞任务后面的任务抢跑(维持 provider order 的正确性)。
      const blockedByActive = this.conflictsWithAny(task, this.active);
      const blockedByQueuedBefore = stillQueued.some((c) =>
        ToolAccesses.conflict(task.accesses, c.accesses),
      );
      // 名额已满 → 留在队列里等下次 finish 释放名额
      if (blockedByActive || blockedByQueuedBefore || this.active.length >= this.maxConcurrency) {
        stillQueued.push(task);
      } else {
        this.start(task);
      }
    }
    this.queued = stillQueued;
  }

  /** 绑定中止信号:已 abort 立即处理,未 abort 监听一次性触发 */
  private attachAbort(signal: AbortSignal): void {
    if (signal.aborted) {
      this.abortRemaining();
      return;
    }
    signal.addEventListener("abort", () => this.abortRemaining(), { once: true });
  }

  /**
   * 中止处理:把所有未结算的任务(queued + active 的外部句柄)全部 reject。
   *
   * queued:直接 reject(关键 —— 否则 Promise.all 永久卡死)。
   * active:reject 外部 controlled promise,让 Promise.all 快速收口。
   *         注意:无法取消正在跑的工具执行(start 返回的 promise 调度器只能等它 settle),
   *         真正中途取消工具执行是 runOneTool 内部检查 signal 的职责,不在此层。
   */
  private abortRemaining(): void {
    if (this.aborted) return; // 幂等:重复 abort 不重复处理
    this.aborted = true;
    const err = makeAbortError(this.signal);
    const rejectAll = (list: ScheduledTask<R>[]) => {
      for (const task of list) task.reject(err);
      list.length = 0;
    };
    rejectAll(this.queued);
    rejectAll(this.active);
  }
}
