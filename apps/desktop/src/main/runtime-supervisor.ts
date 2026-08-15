import { raceWithDeadlineReject } from "../../../../src/util/race-with-deadline.js";

/**
 * Runtime 连接监督器（3-C：fail-stuck 自动恢复）。
 *
 * 两相位状态机：healthy ⇄ degraded。周期 ping 判定 daemon 可达性：
 * - 连续失败达阈值 → 广播 unavailable（渲染层降级到恢复屏）；
 * - degraded 期间任一次 ping 成功 → 广播 recovered（渲染层自动 re-bootstrap）；
 * - 从未降级时的成功保持静默。
 *
 * 不自动重启 daemon（避免重启循环掩盖配置错误）：kernel 承载下探活 ping 本身
 * 就在幂等重试窗口内尝试重生（见 src/daemon/client.ts KERNEL_RETRY_SAFE_METHODS），
 * supervisor 只负责把可达性相位变化广播给渲染层。
 *
 * daemon 可能"socket 存活但进程假死"（死锁/事件循环阻塞/MCP 子进程 stdout 满
 * 管道阻塞）：LocalRuntimeClient.request 只在 TCP 握手与认证阶段有超时，请求本身
 * 无 per-request 超时，pending Promise 永不 settle——因此每个探活 tick 用
 * raceWithDeadlineReject 显式叠加超时，超时同样计入连续失败。
 *
 * 纯依赖注入（ping 函数 + notify 回调），不 import Electron——决策逻辑在
 * 集成测试（tests/integration/desktop-runtime-supervisor.test.ts）里实盘验证。
 */
export type RuntimeSupervisorEvent = "unavailable" | "recovered";

export interface RuntimeSupervisorOptions {
  /** 探活请求（通常为 runtime.ping + 结果解析）；reject/超时均计为失败。 */
  ping(): Promise<unknown>;
  /** 相位事件广播；unavailable 在每个达到阈值的 tick 都会发（不去重）。 */
  notify(event: RuntimeSupervisorEvent): void;
  intervalMs?: number;
  timeoutMs?: number;
  maxConsecutiveFailures?: number;
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export function startRuntimeSupervisor(options: RuntimeSupervisorOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxConsecutiveFailures =
    options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  let consecutiveFailures = 0;
  let degraded = false;
  let stopped = false;
  const handleFailure = (): void => {
    if (stopped) return;
    consecutiveFailures += 1;
    if (consecutiveFailures >= maxConsecutiveFailures) {
      // 不做一次性去重：daemon 抖动（复活窗口 < 一个探活 tick）下，去重标志只能由
      // 探活自身采到的成功 ping 复位，会在 renderer 重连成功后 daemon 再次死亡时
      // 静默不再广播。每次达阈值都 notify，渲染层按当前相位幂等处理冗余事件。
      degraded = true;
      options.notify("unavailable");
    }
  };
  const timer = setInterval(() => {
    if (stopped) return;
    // Promise.race 只会 settle 一次：请求先回则 result 生效，超时先到则 reject，
    // 二者互斥，不会对同一次 tick 重复计数。底层 pending 请求由连接断开/关闭时的
    // rejectAll 兜底回收。
    raceWithDeadlineReject(options.ping(), timeoutMs, () => new Error("runtime.ping 探活超时"))
      .then(() => {
        if (stopped) return;
        consecutiveFailures = 0;
        if (degraded) {
          degraded = false;
          options.notify("recovered");
        }
      })
      .catch(() => handleFailure());
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
