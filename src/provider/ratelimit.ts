/** API 限流状态信息(从响应 header 解析) */
export interface RateLimitInfo {
  /** 剩余配额 */
  remaining?: number;
  /** 总配额 */
  limit?: number;
  /** 配额重置时间戳(ms epoch) */
  resetAt?: number;
  /** Retry-After 建议等待时间(ms) */
  retryAfterMs?: number;
}

/**
 * 从 HTTP 响应 header 解析限流信息。
 * 支持常见的 X-RateLimit-* 和 Retry-After header(不同 API 命名不同)。
 * 无任何限流 header 时返回 undefined。
 */
export function parseRateLimitHeaders(headers: Headers): RateLimitInfo | undefined {
  const info: RateLimitInfo = {};

  // X-RateLimit-Remaining / x-ratelimit-remaining(header 名大小写不敏感)
  const remaining = headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining");
  if (remaining !== null) info.remaining = Number(remaining);

  // X-RateLimit-Limit
  const limit = headers.get("x-ratelimit-limit") ?? headers.get("ratelimit-limit");
  if (limit !== null) info.limit = Number(limit);

  // X-RateLimit-Reset(可能是 epoch 秒或 HTTP date)
  const reset = headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset");
  if (reset !== null) {
    const num = Number(reset);
    if (!isNaN(num)) {
      // 可能是秒(常见)或毫秒
      info.resetAt = num < 1e12 ? num * 1000 : num;
    } else {
      // HTTP date 格式
      const ms = Date.parse(reset);
      if (!isNaN(ms)) info.resetAt = ms;
    }
  }

  // Retry-After(秒数或 HTTP date)
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const num = Number(retryAfter);
    if (!isNaN(num)) {
      info.retryAfterMs = num * 1000; // 秒→毫秒
    } else {
      const ms = Date.parse(retryAfter);
      if (!isNaN(ms)) info.retryAfterMs = ms - Date.now();
    }
  }

  // 至少有一个字段才返回
  return Object.keys(info).length > 0 ? info : undefined;
}
