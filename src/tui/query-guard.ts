// QueryGuard:查询生命周期同步状态机(对标 Claude Code src/utils/QueryGuard.ts)。
//
// 三态:idle(空闲) / dispatching(已派发,异步链未到 onQuery) / running(执行中)。
// generation 号防陈旧:并发提交时旧查询的 finally 块看到 generation 不匹配,
// 跳过 cleanup,避免竞态(用户连按 Enter 时第二个查询让第一个的 cleanup 作废)。
//
// 用 useSyncExternalStore 订阅,组件读 isActive 是同步的(无 React batch 延迟),
// 输入框 disabled 状态立即可见。

/** 创建一个简易信号(订阅/通知),供 useSyncExternalStore */
function createSignal() {
  const listeners = new Set<() => void>();
  return {
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: () => listeners.forEach((fn) => fn()),
  };
}

export class QueryGuard {
  private _status: "idle" | "dispatching" | "running" = "idle";
  private _generation = 0;
  private readonly _changed = createSignal();

  /** useSyncExternalStore:订阅状态变化(稳定引用,可作 useEffect dep) */
  readonly subscribe = (fn: () => void): (() => void) => this._changed.subscribe(fn);
  /** useSyncExternalStore:返回当前 status(稳定字符串字面量) */
  readonly getSnapshot = (): string => this._status;

  /** idle → dispatching(队列预留)。非 idle 时返回 false。 */
  reserve(): boolean {
    if (this._status !== "idle") return false;
    this._status = "dispatching";
    this._notify();
    return true;
  }

  /** dispatching → idle(预留取消,队列无可处理项时)。 */
  cancelReservation(): void {
    if (this._status !== "dispatching") return;
    this._status = "idle";
    this._notify();
  }

  /** → running,返回 generation 号。已在 running 时返回 null(并发防护)。 */
  tryStart(): number | null {
    if (this._status === "running") return null;
    this._status = "running";
    this._generation++;
    this._notify();
    return this._generation;
  }

  /** running → idle。generation 不匹配(被更新的查询取代)时返回 false,跳过 cleanup。 */
  end(generation: number): boolean {
    if (this._generation !== generation) return false;
    if (this._status !== "running") return false;
    this._status = "idle";
    this._notify();
    return true;
  }

  /** 强制结束(取消),generation 自增使旧查询的 finally 看到 mismatch。 */
  forceEnd(): void {
    if (this._status === "idle") return;
    this._status = "idle";
    this._generation++;
    this._notify();
  }

  /** 是否活跃(dispatching 或 running)——同步读取,无 React batch 延迟。 */
  get isActive(): boolean {
    return this._status !== "idle";
  }

  get generation(): number {
    return this._generation;
  }

  private _notify(): void {
    this._changed.emit();
  }
}

// 在原型上绑定 subscribe/getSnapshot(实例共享,避免每帧重建函数引用)
QueryGuard.prototype.subscribe = function (this: QueryGuard, fn: () => void) {
  return this._changed.subscribe(fn);
};
QueryGuard.prototype.getSnapshot = function (this: QueryGuard) {
  return this._status;
};
