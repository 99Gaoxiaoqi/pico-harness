// RateLimit header 解析工具(第 N 讲:provider 限流信息回传)。
//
// 不同上游的限流 header 命名不一,这里统一解析为干净的 RateLimitInfo:
// - OpenAI 兼容:X-RateLimit-Remaining / X-RateLimit-Limit / X-RateLimit-Reset
// - Anthropic:   retry-after / anthropic-ratelimit-*-reset 等
// - 通用:        X-RateLimit-*、ratelimit-remaining(IETF draft)等
//
// 未命中任何已知 header 时返回 undefined(调用方据此决定是否回调)。

/** 标准化后的限流信息(协议无关)。所有时间戳/时长单位为毫秒。 */
export interface RateLimitInfo {
  /** 剩余可用请求数 */
  remaining?: number;
  /** 窗口内总配额 */
  limit?: number;
  /** 配额重置时刻(Unix 毫秒时间戳) */
  resetAt?: number;
  /** 建议等待时长(毫秒);多见于 retry-after */
  retryAfterMs?: number;
}

/**
 * 从响应 headers 中解析限流信息。
 * @returns 命中任意字段时返回 RateLimitInfo;否则 undefined。
 */
export function parseRateLimitHeaders(headers: Headers): RateLimitInfo | undefined {
  const info: RateLimitInfo = {};

  // 1. remaining:剩余请求数(多命名变体)
  const remaining =
    headers.get("x-ratelimit-remaining") ??
    headers.get("ratelimit-remaining") ??
    headers.get("x-ratelimit-requests-remaining");
  if (remaining !== null) {
    const n = Number(remaining);
    if (Number.isFinite(n)) info.remaining = n;
  }

  // 2. limit:窗口内总配额
  const limit =
    headers.get("x-ratelimit-limit") ??
    headers.get("ratelimit-limit") ??
    headers.get("x-ratelimit-requests-limit");
  if (limit !== null) {
    const n = Number(limit);
    if (Number.isFinite(n)) info.limit = n;
  }

  // 3. retry-after:HTTP 标准头,可为秒数或 HTTP date
  //    重置等待时长(毫秒)优先于 resetAt,因为前者语义更精确
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    if (/^\d+$/.test(retryAfter.trim())) {
      info.retryAfterMs = Number(retryAfter.trim()) * 1000;
    } else {
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) info.retryAfterMs = Math.max(0, date - Date.now());
    }
  }

  // 4. resetAt:配额重置时刻(Unix 毫秒时间戳)
  //    - OpenAI 的 x-ratelimit-reset 常为秒级时间戳或日期
  //    - IETF draft 的 ratelimit-reset 为窗口剩余秒数
  const resetSeconds = headers.get("ratelimit-reset");
  if (resetSeconds !== null) {
    const s = Number(resetSeconds);
    if (Number.isFinite(s)) info.resetAt = Date.now() + s * 1000;
  } else {
    const resetRaw =
      headers.get("x-ratelimit-reset") ?? headers.get("anthropic-ratelimit-tokens-reset");
    if (resetRaw !== null) {
      const n = Number(resetRaw);
      if (Number.isFinite(n)) {
        // 纯数字:秒级时间戳(OpenAI 风格)→ 毫秒
        info.resetAt = n > 1e12 ? n : n * 1000;
      } else {
        const date = Date.parse(resetRaw);
        if (!Number.isNaN(date)) info.resetAt = date;
      }
    }
  }

  // 命中任意字段才算有效
  return info.remaining !== undefined ||
    info.limit !== undefined ||
    info.resetAt !== undefined ||
    info.retryAfterMs !== undefined
    ? info
    : undefined;
}
