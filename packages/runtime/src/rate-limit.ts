export interface RateLimitInfo {
  readonly remaining?: number;
  readonly limit?: number;
  readonly resetAt?: number;
  readonly retryAfterMs?: number;
}

/** Normalize common OpenAI-, Anthropic-, and IETF-style rate-limit response headers. */
export function parseRateLimitHeaders(headers: Headers): RateLimitInfo | undefined {
  const info: { remaining?: number; limit?: number; resetAt?: number; retryAfterMs?: number } = {};
  const remaining =
    headers.get("x-ratelimit-remaining") ??
    headers.get("ratelimit-remaining") ??
    headers.get("x-ratelimit-requests-remaining");
  if (remaining !== null) {
    const value = Number(remaining);
    if (Number.isFinite(value)) info.remaining = value;
  }
  const limit =
    headers.get("x-ratelimit-limit") ??
    headers.get("ratelimit-limit") ??
    headers.get("x-ratelimit-requests-limit");
  if (limit !== null) {
    const value = Number(limit);
    if (Number.isFinite(value)) info.limit = value;
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    if (/^\d+$/u.test(retryAfter.trim())) info.retryAfterMs = Number(retryAfter.trim()) * 1000;
    else {
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) info.retryAfterMs = Math.max(0, date - Date.now());
    }
  }
  const resetSeconds = headers.get("ratelimit-reset");
  if (resetSeconds !== null) {
    const seconds = Number(resetSeconds);
    if (Number.isFinite(seconds)) info.resetAt = Date.now() + seconds * 1000;
  } else {
    const resetRaw =
      headers.get("x-ratelimit-reset") ?? headers.get("anthropic-ratelimit-tokens-reset");
    if (resetRaw !== null) {
      const value = Number(resetRaw);
      if (Number.isFinite(value)) info.resetAt = value > 1e12 ? value : value * 1000;
      else {
        const date = Date.parse(resetRaw);
        if (!Number.isNaN(date)) info.resetAt = date;
      }
    }
  }
  return Object.keys(info).length > 0 ? info : undefined;
}
