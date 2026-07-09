// 多凭证轮换池:把"单个 LLM_API_KEY"升级为"多个 key 轮询 + 限流冷却"。
//
// 解决问题:retry.ts 原本只对同一个 key 指数退避重试,key 用光后 429 不停。
// CredentialPool 让 429 时标记当前 key 限流、切到下一个未限流 key 重试,
// 多账号轮换绕开单 key 的速率配额。
//
// 设计原则(极简):
// - 轮询策略:简单 round-robin,不搞权重 / 健康分。
// - 冷却期:默认 60 秒(对齐常见 API 限流恢复窗口),到期自动恢复。
// - 全限流兜底:所有 key 都在限流期 → 取最早到期的那个,不抛错,
//   让上层 retry 层根据退避时长决定等多久。
// - 单 key 兼容:keys.length <= 1 时 getNext 总返回那一个(行为等同现有单 key)。

/** 默认限流冷却时间(ms),对齐常见 API 限流恢复窗口。 */
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * 多凭证轮换池。
 *
 * now() 默认读 Date.now(),测试时可注入虚拟时钟验证冷却恢复。
 */
export class CredentialPool {
  private readonly keys: string[];
  private index = 0; // 轮询位置
  private readonly rateLimited = new Map<string, number>(); // key → 限流到期时间戳(ms)
  private readonly now: () => number;

  constructor(keys: string[] = [], now: () => number = Date.now) {
    // 过滤掉空字符串(逗号分隔可能产生空段)
    this.keys = keys.filter((k) => k.length > 0);
    this.now = now;
  }

  /**
   * 轮询取下一个可用 key。
   *
   * - 跳过仍在限流期的 key。
   * - 单 key / 空池:总返回那���个(空池返回空串,保留单 key 兼容语义)。
   * - 全限流:取最早到期的那个(不抛错,让 retry 层决定退避多久)。
   */
  getNext(): string {
    // 单 key / 空池快路径:无轮换可言,直接返回(行为等同现有单 key 流程)
    if (this.keys.length <= 1) {
      return this.keys[0] ?? "";
    }

    const availableKey = this.getNextAvailable();
    if (availableKey !== undefined) return availableKey;

    // 全限流兜底:取最早到期的那个(retry 层会据退避时长等待)
    const earliestKey = this.earliestExpiryKey();
    if (earliestKey !== undefined) {
      // 推进 index,避免全限流时一直卡在同一 key
      const pos = this.keys.indexOf(earliestKey);
      this.index = (pos + 1) % this.keys.length;
      return earliestKey;
    }

    // 理论不可达(sweepExpired 后若无标记,上面 for 必命中),保险兜底
    const key = this.keys[this.index] ?? "";
    this.index = (this.index + 1) % this.keys.length;
    return key;
  }

  /**
   * 只返回当前未冷却的 key。
   *
   * 与 getNext() 的兼容兜底不同,全限流时返回 undefined,
   * 供 retry/CLI 判断"没有真正轮换到可用凭证",从而走退避等待。
   */
  getNextAvailable(): string | undefined {
    if (this.keys.length === 0) return undefined;
    this.sweepExpired();

    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[(this.index + i) % this.keys.length]!;
      if (!this.rateLimited.has(key)) {
        this.index = (this.index + i + 1) % this.keys.length;
        return key;
      }
    }
    return undefined;
  }

  /** 标记某 key 限流,冷却 cooldownMs(默认 60s)后自动恢复。 */
  markRateLimited(key: string, cooldownMs: number = DEFAULT_COOLDOWN_MS): void {
    if (!this.keys.includes(key)) return; // 非池内 key,忽略
    this.rateLimited.set(key, this.now() + cooldownMs);
  }

  /**
   * 用 RateLimit 信息精确冷却。
   *
   * 优先级:
   * - retryAfterMs > 0 → 按 retryAfterMs 冷却(Retry-After header)
   * - resetAt > now    → 按 (resetAt - now) 冷却(X-RateLimit-Reset header)
   * - 否则             → 默认 60s
   *
   * 注:此处只取 resetAt / retryAfterMs 两个字段,避免引入 RateLimitInfo 类型
   * 的耦合;5.7a 的 ratelimit.ts 会提供正式类型,合并时调用方自行映射即可。
   */
  markRateLimitedWithInfo(key: string, info: { resetAt?: number; retryAfterMs?: number }): void {
    let cooldown = DEFAULT_COOLDOWN_MS;
    if (info.retryAfterMs !== undefined && info.retryAfterMs > 0) {
      cooldown = info.retryAfterMs;
    } else if (info.resetAt !== undefined) {
      const diff = info.resetAt - this.now();
      if (diff > 0) cooldown = diff;
    }
    this.markRateLimited(key, cooldown);
  }

  /**
   * 查询某 key 的限流状态。
   *
   * - rateLimited:false 表示当前可用(未标记或已过期)
   * - resetsAt:限流到期时间戳(ms);rateLimited=false 时为 undefined
   * - 非池内 key 视为未限流(rateLimited=false)
   */
  getRateLimitStatus(key: string): { rateLimited: boolean; resetsAt?: number } {
    this.sweepExpired();
    const resetsAt = this.rateLimited.get(key);
    if (resetsAt === undefined) {
      return { rateLimited: false };
    }
    return { rateLimited: true, resetsAt };
  }

  /** 池内 key 总数。 */
  get size(): number {
    return this.keys.length;
  }

  /** 当前未限流(可用)的 key 数量。 */
  get available(): number {
    this.sweepExpired();
    return this.keys.filter((k) => !this.rateLimited.has(k)).length;
  }

  /** 移除已过期的限流标记。 */
  private sweepExpired(): void {
    if (this.rateLimited.size === 0) return;
    const now = this.now();
    for (const [key, expiry] of this.rateLimited) {
      if (expiry <= now) {
        this.rateLimited.delete(key);
      }
    }
  }

  /** 取限流到期时间最早的 key(全限流兜底用)。 */
  private earliestExpiryKey(): string | undefined {
    let earliestKey: string | undefined;
    let earliestExpiry = Infinity;
    for (const [key, expiry] of this.rateLimited) {
      if (expiry < earliestExpiry) {
        earliestExpiry = expiry;
        earliestKey = key;
      }
    }
    return earliestKey;
  }
}
