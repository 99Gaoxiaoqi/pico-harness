/**
 * 3-B-3 硬切后 Desktop 不再内嵌 daemon：默认构造的 LocalRuntimeClient 走 kernel
 * 承载（connectOrSpawn 自动拉起 detached 常驻 daemon candidate，candidate 自持
 * residency 阻止 idle 自退），Electron 主进程只做瘦客户端。quit 时 daemon 保持
 * 常驻（cron 调度依赖），不再需要"own 进程 + 优雅关停"的控制器。
 *
 * 保留 shutdown fence 纯函数：它仍被 lifecycle-races 集成测试覆盖其语义
 * （before-quit 期间阻止重复退出直到 daemon 停完）。
 */

export interface DesktopBeforeQuitEvent {
  preventDefault(): void;
}

export interface DesktopDaemonShutdownFenceOptions {
  /** Owned daemon 排空的硬上限。 */
  timeoutMs?: number;
  /** 测试可注入手动 timer，生产默认使用 Node timer。 */
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export type DesktopTerminalCleanupFenceOptions = DesktopDaemonShutdownFenceOptions;

export function isDesktopRuntimeInvocationAllowed(
  method: string,
  quitting: boolean,
  terminalCreateAllowed = true,
): boolean {
  return method !== "terminal.create" || (!quitting && terminalCreateAllowed);
}

/** Serializes close/reopen transitions so cleanup from an old window cannot hit a new one. */
export class DesktopTerminalGenerationController {
  #sealed = true;
  #sealVersion = 0;
  #transitionTail: Promise<void> = Promise.resolve();

  isCreateAllowed(): boolean {
    return !this.#sealed;
  }

  seal(): void {
    this.#sealed = true;
    this.#sealVersion++;
  }

  cleanup(stopAll: () => Promise<void>): Promise<void> {
    this.seal();
    return this.#enqueue(stopAll);
  }

  open(resume: () => Promise<void>): Promise<void> {
    const expectedSealVersion = this.#sealVersion;
    return this.#enqueue(async () => {
      await resume();
      if (this.#sealVersion === expectedSealVersion) this.#sealed = false;
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#transitionTail.then(operation, operation);
    this.#transitionTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/**
 * Workbar terminals are not restored across Desktop restarts, while the Runtime daemon is.
 * Fence Electron shutdown until the daemon has released every terminal it still owns.
 */
export function createDesktopTerminalCleanupFence(
  terminal: { stopAll(): Promise<void> },
  quit: () => void,
  onStopError: (error: unknown) => void,
  options: DesktopTerminalCleanupFenceOptions = {},
): (event: DesktopBeforeQuitEvent) => void {
  let cleanupPromise: Promise<void> | undefined;
  let timeoutHandle: unknown;
  let timeoutPending = false;
  let finished = false;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("Desktop terminal cleanup timeoutMs 必须是非负有限数");
  }
  const scheduleTimeout =
    options.setTimeout ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancelTimeout =
    options.clearTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const finish = (error?: unknown): void => {
    if (finished) return;
    finished = true;
    if (timeoutPending) {
      cancelTimeout(timeoutHandle);
      timeoutPending = false;
      timeoutHandle = undefined;
    }
    try {
      if (error !== undefined) onStopError(error);
    } finally {
      quit();
    }
  };

  return (event) => {
    if (finished) return;
    event.preventDefault();
    if (cleanupPromise) return;
    cleanupPromise = Promise.resolve().then(() => terminal.stopAll());
    timeoutHandle = scheduleTimeout(
      () => finish(new Error(`Pico desktop terminal cleanup exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    timeoutPending = true;
    void cleanupPromise.then(
      () => finish(),
      (error) => finish(error),
    );
  };
}

/** Keeps every repeated before-quit event fenced until the owned daemon finishes draining. */
export function createDesktopDaemonShutdownFence(
  daemon: { ownsProcess: boolean; stop(): Promise<void> },
  quit: () => void,
  onStopError: (error: unknown) => void,
  options: DesktopDaemonShutdownFenceOptions = {},
): (event: DesktopBeforeQuitEvent) => void {
  let stoppingPromise: Promise<void> | undefined;
  let timeoutHandle: unknown;
  let timeoutPending = false;
  let finished = false;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("Desktop daemon shutdown timeoutMs 必须是非负有限数");
  }
  const scheduleTimeout =
    options.setTimeout ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancelTimeout =
    options.clearTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const finish = (outcome: { readonly error?: never } | { readonly error: unknown }): void => {
    if (finished) return;
    finished = true;
    if (timeoutPending) {
      cancelTimeout(timeoutHandle);
      timeoutPending = false;
      timeoutHandle = undefined;
    }
    if (!("error" in outcome)) {
      quit();
      return;
    }
    try {
      onStopError(outcome.error);
    } finally {
      quit();
    }
  };

  return (event) => {
    if (finished) return;
    if (!stoppingPromise && !daemon.ownsProcess) return;
    event.preventDefault();
    if (stoppingPromise) return;
    stoppingPromise = Promise.resolve().then(() => daemon.stop());
    timeoutHandle = scheduleTimeout(() => {
      timeoutPending = false;
      timeoutHandle = undefined;
      finish({ error: new Error(`Pico desktop daemon stop exceeded ${timeoutMs}ms`) });
    }, timeoutMs);
    timeoutPending = true;
    void stoppingPromise.then(
      () => finish({}),
      (error) => finish({ error }),
    );
  };
}
