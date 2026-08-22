/**
 * 子代理真实执行容量的 turn 域 FIFO 信号量（移植参考宿主实现的
 * ChildAgentRunLimiter 语义，含 turn 重置：换新实例、���实例 close）。
 *
 * 域的选择依据：limiter 的域 = 拥有 spawn 能力的执行作用域生命周期。主循环
 * 以 turn 为节奏推进，容量按 turn 配速——每 turn 满血准入，跨 turn 仍在跑的
 * child 归还名额到旧实例、不占新 turn 预算（避免多轮委派的会话被累积的
 * 在飞子代理堵死）；turn 结束仍在排队的等待者被拒绝（"permit scope ended"，
 * 饱和背压）。满则 FIFO 排队（不拒绝、不丢弃），排队中被取消则干净出队。
 */

export interface ChildRunPermit {
  release(): void;
}

interface ChildRunWaiter {
  signal: AbortSignal | undefined;
  resolve: () => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

/** 默认执行容量（每 turn）：对齐参考宿主的 32；env PICO_CHILD_RUN_CAPACITY
 * 可覆盖（manager 构造时读取一次）。 */
export const DEFAULT_MAX_ACTIVE_CHILD_RUNS = 32;

export class ChildRunLimiter {
  private active = 0;
  private readonly waiters: ChildRunWaiter[] = [];
  private closedError: Error | undefined;

  constructor(
    readonly capacity: number,
    options: { readonly label?: string } = {},
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("Child run capacity must be a positive safe integer");
    }
    this.label = options.label ?? "child-run";
  }

  readonly label: string;

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<ChildRunPermit> {
    if (this.closedError) throw this.closedError;
    if (signal?.aborted) throw abortReason(signal);
    if (this.active < this.capacity && this.waiters.length === 0) {
      this.active += 1;
      return this.createPermit();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: ChildRunWaiter = {
        signal,
        resolve: () => resolve(),
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          signal?.removeEventListener("abort", waiter.onAbort);
          reject(abortReason(signal!));
        },
      };
      this.waiters.push(waiter);
      if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
    // grantWaiting 已把名额记在 active 上。
    return this.createPermit();
  }

  /** 进程关停：拒绝全部等待者并让后续 acquire 立即失败。 */
  close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
  }

  private createPermit(): ChildRunPermit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.grantWaiting();
      },
    };
  }

  private grantWaiting(): void {
    if (this.closedError) return;
    while (this.active < this.capacity && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      this.active += 1;
      waiter.resolve();
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("子代理等待执行容量时被取消");
}

export function resolveChildRunCapacity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env["PICO_CHILD_RUN_CAPACITY"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_ACTIVE_CHILD_RUNS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    return DEFAULT_MAX_ACTIVE_CHILD_RUNS;
  }
  return value;
}
