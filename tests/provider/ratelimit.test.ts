// parseRateLimitHeaders 单测 (5.7a)。
// 覆盖 X-RateLimit-* / Retry-After 各种格式(秒 / HTTP date),
// 大小写不敏感、部分字段、无 header 兜底等。

import { describe, expect, it } from "vitest";
import { parseRateLimitHeaders } from "../../src/provider/ratelimit.js";

describe("parseRateLimitHeaders", () => {
  it("X-RateLimit-Remaining + Limit → 解析正确", () => {
    const headers = new Headers({
      "x-ratelimit-remaining": "42",
      "x-ratelimit-limit": "100",
    });
    expect(parseRateLimitHeaders(headers)).toEqual({ remaining: 42, limit: 100 });
  });

  it("X-RateLimit-Reset 是 epoch 秒 → 转成毫秒", () => {
    const headers = new Headers({ "x-ratelimit-reset": "1700000000" });
    expect(parseRateLimitHeaders(headers)).toEqual({ resetAt: 1700000000000 });
  });

  it("X-RateLimit-Reset 是 epoch 毫秒 → 保持毫秒", () => {
    const headers = new Headers({ "x-ratelimit-reset": "1700000000000" });
    expect(parseRateLimitHeaders(headers)).toEqual({ resetAt: 1700000000000 });
  });

  it("X-RateLimit-Reset 是 HTTP date → 解析正确", () => {
    const dateStr = "Wed, 21 Oct 2015 07:28:00 GMT";
    const expected = Date.parse(dateStr);
    const headers = new Headers({ "x-ratelimit-reset": dateStr });
    expect(parseRateLimitHeaders(headers)).toEqual({ resetAt: expected });
  });

  it("Retry-After 是秒数 → 转毫秒", () => {
    const headers = new Headers({ "retry-after": "30" });
    expect(parseRateLimitHeaders(headers)).toEqual({ retryAfterMs: 30000 });
  });

  it("Retry-After 是 HTTP date → 算差值", () => {
    const futureMs = Date.now() + 60000;
    const dateStr = new Date(futureMs).toUTCString();
    const headers = new Headers({ "retry-after": dateStr });
    const result = parseRateLimitHeaders(headers);
    expect(result?.retryAfterMs).toBeGreaterThanOrEqual(59000);
    expect(result?.retryAfterMs).toBeLessThanOrEqual(60000);
  });

  it("无任何 header → undefined", () => {
    const headers = new Headers();
    expect(parseRateLimitHeaders(headers)).toBeUndefined();
  });

  it("header 名大小写不敏感", () => {
    const headers = new Headers();
    // Headers 构造时小写,key 自动归一化;手动用 mixed-case 验证
    headers.set("X-RateLimit-Remaining", "7");
    headers.set("X-RATELIMIT-LIMIT", "10");
    const result = parseRateLimitHeaders(headers);
    expect(result).toEqual({ remaining: 7, limit: 10 });
  });

  it("只有部分 header → 只填部分字段", () => {
    const headers = new Headers({ "x-ratelimit-remaining": "5" });
    expect(parseRateLimitHeaders(headers)).toEqual({ remaining: 5 });
  });

  it("支持无 x- 前缀的 ratelimit-* 命名", () => {
    const headers = new Headers({
      "ratelimit-remaining": "3",
      "ratelimit-limit": "8",
    });
    expect(parseRateLimitHeaders(headers)).toEqual({ remaining: 3, limit: 8 });
  });

  it("全部字段齐全 → 返回完整对象", () => {
    const headers = new Headers({
      "x-ratelimit-remaining": "42",
      "x-ratelimit-limit": "100",
      "x-ratelimit-reset": "1700000000",
      "retry-after": "30",
    });
    expect(parseRateLimitHeaders(headers)).toEqual({
      remaining: 42,
      limit: 100,
      resetAt: 1700000000000,
      retryAfterMs: 30000,
    });
  });
});
