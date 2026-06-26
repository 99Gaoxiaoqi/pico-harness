// 模型调用重试(generateWithRetry)的单测。
// 用 vi.fn 控制每次 generate 的抛错 / 返回,验证:
// 退避重试、状态码白名单、ContextOverflow 不重试、abort 中断、onRetry 回调、
// 兜底判定(裸 Error 提取状态码)、网络错误重试、provider 自定义判定优先。
//
// 用 vi.spyOn(Math, "random") 固定抖动,使退避延迟确定化(0.5 → delay[0]=300ms),
// 便于精确断言 onRetry.delayMs;真实定时器等待(单次重试 ~300ms)。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextOverflowError, LLMStatusError } from "../src/provider/errors.js";
import {
  backoffDelays,
  defaultIsRetryableError,
  generateWithRetry,
  type RetryInfo,
} from "../src/provider/retry.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolDefinition } from "../src/schema/message.js";

const ok: Message = { role: "assistant", content: "ok" };
const msgs: Message[] = [{ role: "user", content: "hi" }];
const tools: ToolDefinition[] = [];

/** 构造可按调用次序编排抛错 / 返回的 mock provider;默认无 isRetryableError(走兜底) */
function makeProvider(opts?: {
  isRetryableError?: (e: unknown) => boolean;
  modelName?: string;
}): { provider: LLMProvider; fn: ReturnType<typeof vi.fn> } {
  const fn = vi.fn();
  const provider: LLMProvider = {
    generate: fn as unknown as LLMProvider["generate"],
    ...(opts?.isRetryableError ? { isRetryableError: opts.isRetryableError } : {}),
    ...(opts?.modelName ? { modelName: opts.modelName } : {}),
  };
  return { provider, fn };
}

beforeEach(() => {
  // 固定抖动:backoffDelays(3) → [300, 300],便于精确断言 delayMs
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateWithRetry 主流程", () => {
  it("429 后第 2 次恢复,共调用 2 次", async () => {
    const { provider, fn } = makeProvider();
    fn.mockRejectedValueOnce(new LLMStatusError(429, "rate limited"));
    fn.mockResolvedValueOnce(ok);

    const res = await generateWithRetry(provider, msgs, tools);

    expect(res).toBe(ok);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("400 立即抛出不重试", async () => {
    const { provider, fn } = makeProvider();
    fn.mockRejectedValue(new LLMStatusError(400, "bad request"));

    await expect(generateWithRetry(provider, msgs, tools)).rejects.toBeInstanceOf(LLMStatusError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("连续 3 次 500 后抛出(达上限,默认 maxAttempts=3)", async () => {
    const { provider, fn } = makeProvider();
    fn.mockRejectedValue(new LLMStatusError(500, "boom"));

    await expect(generateWithRetry(provider, msgs, tools)).rejects.toBeInstanceOf(LLMStatusError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("ContextOverflowError 不重试(直接抛,交给响应式压缩层)", async () => {
    const { provider, fn } = makeProvider();
    fn.mockRejectedValue(new ContextOverflowError("context too long"));

    await expect(generateWithRetry(provider, msgs, tools)).rejects.toBeInstanceOf(
      ContextOverflowError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("signal 已 abort 时只调 1 次,抛 AbortError", async () => {
    const { provider, fn } = makeProvider();
    // 抛可重试错误,但退避前 throwIfAborted 会先行抛出
    fn.mockRejectedValue(new LLMStatusError(429, "rate limited"));
    const ac = new AbortController();
    ac.abort();

    await expect(
      generateWithRetry(provider, msgs, tools, { signal: ac.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("onRetry 回调携带正确 attempt / delayMs / statusCode", async () => {
    const { provider, fn } = makeProvider();
    fn.mockRejectedValueOnce(new LLMStatusError(429, "rate limited"));
    fn.mockResolvedValueOnce(ok);
    const onRetry = vi.fn();

    await generateWithRetry(provider, msgs, tools, { onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    const info = onRetry.mock.calls[0]![0] as RetryInfo;
    expect(info).toMatchObject({
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 300, // Math.random=0.5 → backoffDelays(3)[0]=300
      statusCode: 429,
    });
  });

  it("兜底判定:裸 Error 带 [429] 字符串也能重试", async () => {
    const { provider, fn } = makeProvider(); // 无 isRetryableError → 走 default 兜底
    fn.mockRejectedValueOnce(new Error("request failed [429] rate limited"));
    fn.mockResolvedValueOnce(ok);

    const res = await generateWithRetry(provider, msgs, tools);

    expect(res).toBe(ok);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("网络错误(TypeError fetch failed)重试", async () => {
    const { provider, fn } = makeProvider();
    fn.mockRejectedValueOnce(new TypeError("fetch failed"));
    fn.mockResolvedValueOnce(ok);

    const res = await generateWithRetry(provider, msgs, tools);

    expect(res).toBe(ok);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("generateWithRetry 边界与优先级", () => {
  it("maxAttempts<=1 走快路径:可重试错误也只调 1 次", async () => {
    const { provider, fn } = makeProvider();
    fn.mockRejectedValue(new LLMStatusError(429, "rate limited"));

    await expect(
      generateWithRetry(provider, msgs, tools, { maxAttempts: 1 }),
    ).rejects.toBeInstanceOf(LLMStatusError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("provider 自定义 isRetryableError 优先于默认兜底", async () => {
    // 默认会重试 429,但 provider 声明一律不重试
    const { provider, fn } = makeProvider({ isRetryableError: () => false });
    fn.mockRejectedValueOnce(new LLMStatusError(429, "rate limited"));

    await expect(generateWithRetry(provider, msgs, tools)).rejects.toBeInstanceOf(LLMStatusError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("sleep 期间 abort 立即唤醒,不熬满 delay", async () => {
    const { provider, fn } = makeProvider();
    fn.mockRejectedValue(new LLMStatusError(503, "unavailable"));
    const ac = new AbortController();

    // 在 generate 抛错后、退避 sleep 期间触发 abort:
    // 用微任务延迟让出控制权,使重试进入 sleepForRetry 后再 abort。
    const promise = generateWithRetry(provider, msgs, tools, { signal: ac.signal });
    queueMicrotask(() => ac.abort());

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("defaultIsRetryableError 兜底判定", () => {
  it("abort 错误不重试", () => {
    expect(defaultIsRetryableError(new DOMException("aborted", "AbortError"))).toBe(false);
  });

  it("ContextOverflowError 不重试", () => {
    expect(defaultIsRetryableError(new ContextOverflowError("overflow"))).toBe(false);
  });

  it("LLMStatusError 429/500/502/503/504 重试,400 不重试", () => {
    expect(defaultIsRetryableError(new LLMStatusError(429, "rl"))).toBe(true);
    expect(defaultIsRetryableError(new LLMStatusError(500, "boom"))).toBe(true);
    expect(defaultIsRetryableError(new LLMStatusError(502, "bg"))).toBe(true);
    expect(defaultIsRetryableError(new LLMStatusError(503, "unavail"))).toBe(true);
    expect(defaultIsRetryableError(new LLMStatusError(504, "timeout"))).toBe(true);
    expect(defaultIsRetryableError(new LLMStatusError(400, "bad"))).toBe(false);
  });

  it("裸 Error 提取 [503] 重试,[400] 不重试,无状态码不重试", () => {
    expect(defaultIsRetryableError(new Error("failed [503]"))).toBe(true);
    expect(defaultIsRetryableError(new Error("failed [400]"))).toBe(false);
    expect(defaultIsRetryableError(new Error("plain boom"))).toBe(false);
  });

  it("TypeError 网络错误重试", () => {
    expect(defaultIsRetryableError(new TypeError("fetch failed"))).toBe(true);
  });

  it("非 Error 值不重试", () => {
    expect(defaultIsRetryableError(null)).toBe(false);
    expect(defaultIsRetryableError("oops")).toBe(false);
  });
});

describe("backoffDelays 退避序列", () => {
  it("长度 = maxAttempts - 1", () => {
    expect(backoffDelays(3)).toHaveLength(2);
    expect(backoffDelays(1)).toHaveLength(0);
  });

  it("每个值落在 [300, 5000] 区间", () => {
    vi.restoreAllMocks(); // 用真实 Math.random 验证边界
    const delays = backoffDelays(10);
    expect(delays).toHaveLength(9);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(300);
      expect(d).toBeLessThanOrEqual(5000);
    }
  });

  it("randomize=0.5 时序列确定:[300, 300, 600, 1200, 2400]", () => {
    // Math.random 已在 beforeEach 固定为 0.5
    expect(backoffDelays(6)).toEqual([300, 300, 600, 1200, 2400]);
  });
});
