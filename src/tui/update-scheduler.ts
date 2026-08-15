import type { RenderOptions } from "ink";

/**
 * TUI 渲染合流与 Ink 渲染选项（3-D Phase 5 从 repl.tsx 提取——客户端壳是
 * 唯一消费者，in-process 路径退役后由本模块持有）。
 */

export const TUI_RENDER_OPTIONS = {
  alternateScreen: true,
  incrementalRendering: true,
  patchConsole: true,
  exitOnCtrlC: false,
} as const satisfies RenderOptions;

/**
 * 最小间隔合流调度器：高频投影更新（33ms 渲染合流）只在间隔到期时落地，
 * 期间只保留最新值；到期前的更新触发一次定时补发。保证 UI 不会被事件流
 * 打爆，也不会丢最终状态。
 */
export function createTuiUpdateScheduler<T>(
  apply: (value: T) => void,
  minIntervalMs: number,
): (value: T) => void {
  let latest: T | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastAppliedAt = 0;

  return (value) => {
    latest = value;
    const now = Date.now();
    const elapsed = now - lastAppliedAt;
    if (elapsed >= minIntervalMs) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastAppliedAt = now;
      apply(value);
      latest = null;
      return;
    }

    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!latest) return;
      lastAppliedAt = Date.now();
      apply(latest);
      latest = null;
    }, minIntervalMs - elapsed);
  };
}
