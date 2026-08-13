/**
 * 把目标与截止时间赛跑的两个统一原语。
 *
 * 全栈原本散落 12 处手写的"Promise.race + setTimeout"超时模板，行为与定时器
 * 清理参差不齐（部分未保存句柄、未 clearTimeout 而泄漏）。这里收敛为两个语义：
 *
 * - raceWithDeadline：超时后 resolve(false)，不 reject。用于"排空/截止"语义——
 *   超时不算错误，只是放弃等待（典型：runtime close 排空、hook stop 排空、
 *   TUI cleanup 排空、工具批次 settle 兜底）。
 *
 * - raceWithDeadlineReject：超时后 reject(errorFactory(timeoutMs))。用于
 *   "请求/握手"语义——超时即失败（典型：IPC 认证握手、MCP server 启动、
 *   SSE endpoint 事件、文件锁等待、探活）。
 *
 * 两者都在 finally 中 clearTimeout，杜绝定时器句柄泄漏；范式同 retry.ts
 * abortableSleep 的 clearTimeout 清理。类型用 ReturnType<typeof setTimeout>
 * 兼容 @types/node（避免 NodeJS.Timeout 跨版本差异）。
 */

/**
 * 把目标与截止时间赛跑；超时 resolve(false)，不 reject。
 *
 * - 传入数组：用 Promise.allSettled 归一（任一目标 reject 不影响整体，
 *   全部 settle 后返回 true）；空数组短路返回 true（无目标可等待）。
 * - 传入单个 Promise：直接 race；目标 reject 时本函数也随之 reject
 *   （与原各处 settleWithinDeadline 行为一致）。
 *
 * 用于"排空/截止"语义。
 */
export async function raceWithDeadline(
  target: Promise<unknown> | readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<boolean> {
  if (Array.isArray(target)) {
    // 空数组短路：无目标可等待，立即视为已排空。
    if (target.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.allSettled(target).then((): true => true),
        new Promise<false>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // Promise.resolve 透传 Promise 并对非数组分支做类型窄化（Array.isArray
      // 守卫不排除 readonly 数组，直接 target.then 会报 TS2339）。
      Promise.resolve(target).then((): true => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 把目标与截止时间赛跑；超时 reject(errorFactory(timeoutMs))。
 *
 * 目标先 settle（resolve 或 reject）则透传其结果；超时则调用 errorFactory
 * 构造错误并 reject。用于"请求/握手"语义。调用方可在 errorFactory 内顺带
 * 触发超时专属副作用（如 SSE abort）——它仅在截止时间到达时被调用一次。
 */
export async function raceWithDeadlineReject<T>(
  target: Promise<T>,
  timeoutMs: number,
  errorFactory: (timeoutMs: number) => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      target,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(errorFactory(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
