// errors.ts 的结构化错误单测:
// 验证类型层级、statusCode 透传、overflow 正则命中/不命中、abort 识别。

import { describe, expect, it } from "vitest";
import {
  ContextOverflowError,
  isAbortError,
  isContextOverflowStatus,
  LLMStatusError,
} from "../src/provider/errors.js";

describe("LLMStatusError", () => {
  it("带 statusCode 与正确 name", () => {
    const err = new LLMStatusError(429, "rate limited");
    expect(err.statusCode).toBe(429);
    expect(err.name).toBe("LLMStatusError");
    expect(err.message).toBe("rate limited");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("ContextOverflowError", () => {
  it("是 LLMStatusError 子类,且 name 正确", () => {
    const err = new ContextOverflowError("context too long");
    expect(err).toBeInstanceOf(LLMStatusError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ContextOverflowError");
    expect(err.message).toBe("context too long");
    expect(typeof err.statusCode).toBe("number");
  });
});

describe("isContextOverflowStatus", () => {
  it("400 + maximum context length 命中返回 true", () => {
    expect(
      isContextOverflowStatus(400, "This model's maximum context length is 8192 tokens"),
    ).toBe(true);
  });

  it("413 + 不匹配的消息返回 false", () => {
    expect(isContextOverflowStatus(413, "request too large")).toBe(false);
  });

  it("429 不在白名单返回 false(即使消息像限流)", () => {
    expect(isContextOverflowStatus(429, "rate limit")).toBe(false);
  });

  it("422 + exceed context window 命中返回 true", () => {
    expect(isContextOverflowStatus(422, "input exceeds the context window")).toBe(true);
  });
});

describe("isAbortError", () => {
  it("识别 DOMException AbortError", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("普通 Error 不是 abort", () => {
    expect(isAbortError(new Error("boom"))).toBe(false);
  });

  it("非对象不是 abort", () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});
