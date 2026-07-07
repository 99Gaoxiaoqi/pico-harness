// RateLimit header 回传单测(第 N 讲:5.7c)。
// 验证三个 provider 在 resp.ok 后正确解析 RateLimit header 并回调 onRateLimitInfo:
// - OpenAI:  generate + generateStream
// - Claude:  generate + generateStream
// - Gemini:  generate + generateStream
// - 无 RateLimit header 时回调不被调用

import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../../src/provider/openai.js";
import { ClaudeProvider } from "../../src/provider/claude.js";
import { GeminiProvider } from "../../src/provider/gemini.js";
import type { RateLimitInfo } from "../../src/provider/ratelimit.js";
import type { Message } from "../../src/schema/message.js";

const history: Message[] = [
  { role: "system", content: "你是助手" },
  { role: "user", content: "hi" },
];

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/**
 * 构造一个 mock fetch,返回带指定 RateLimit header 的非流式 JSON 响应。
 * headers 可省略(模拟"无限流 header"场景)。
 */
function mockJsonFetchWithHeaders(json: unknown, headers: Record<string, string> = {}): void {
  globalThis.fetch = vi.fn(async () => {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(headers),
      body: null,
      async json() {
        return json;
      },
      async text() {
        return JSON.stringify(json);
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/**
 * 构造一个 mock fetch,返回带指定 RateLimit header 的流式 SSE 响应。
 * sse 是原始 SSE 文本(以 \n\n 分隔的事件)。
 */
function mockStreamFetchWithHeaders(sse: string, headers: Record<string, string> = {}): void {
  globalThis.fetch = vi.fn(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(headers),
      body,
      async text() {
        return sse;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

// ===== OpenAI =====
describe("OpenAIProvider RateLimit 回传", () => {
  it("generate:命中 X-RateLimit-Remaining 回调 onRateLimitInfo", async () => {
    mockJsonFetchWithHeaders(
      {
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      { "x-ratelimit-remaining": "5", "x-ratelimit-limit": "100" },
    );
    const received: RateLimitInfo[] = [];
    const p = new OpenAIProvider({
      baseURL: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      onRateLimitInfo: (info) => received.push(info),
    });
    await p.generate(history, []);
    expect(received).toHaveLength(1);
    expect(received[0]!.remaining).toBe(5);
    expect(received[0]!.limit).toBe(100);
  });

  it("generate:无 RateLimit header 时不回调", async () => {
    mockJsonFetchWithHeaders({
      choices: [{ message: { role: "assistant", content: "hi" } }],
    });
    const received: RateLimitInfo[] = [];
    const p = new OpenAIProvider({
      baseURL: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      onRateLimitInfo: (info) => received.push(info),
    });
    await p.generate(history, []);
    expect(received).toHaveLength(0);
  });

  it("generateStream:命中 X-RateLimit-Remaining 回调", async () => {
    const sse = `data: ${JSON.stringify({
      choices: [{ delta: { content: "hi" }, finish_reason: null }],
    })}\n\ndata: [DONE]\n\n`;
    mockStreamFetchWithHeaders(sse, { "x-ratelimit-remaining": "3" });
    const received: RateLimitInfo[] = [];
    const p = new OpenAIProvider({
      baseURL: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      onRateLimitInfo: (info) => received.push(info),
    });
    await p.generateStream(history, [], () => {});
    expect(received).toHaveLength(1);
    expect(received[0]!.remaining).toBe(3);
  });
});

// ===== Claude =====
describe("ClaudeProvider RateLimit 回传", () => {
  it("generate:命中 anthropic-ratelimit 风格 + retry-after 回调", async () => {
    mockJsonFetchWithHeaders(
      { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
      { "anthropic-ratelimit-tokens-reset": "1700000000", "retry-after": "30" },
    );
    const received: RateLimitInfo[] = [];
    const p = new ClaudeProvider({
      baseURL: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      model: "claude-3-5-sonnet-20241022",
      onRateLimitInfo: (info) => received.push(info),
    });
    await p.generate(history, []);
    expect(received).toHaveLength(1);
    expect(received[0]!.retryAfterMs).toBe(30_000);
    expect(received[0]!.resetAt).toBe(1700000000 * 1000); // 秒级时间戳 → 毫秒
  });

  it("generate:无 RateLimit header 时不回调", async () => {
    mockJsonFetchWithHeaders({
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
    });
    const received: RateLimitInfo[] = [];
    const p = new ClaudeProvider({
      baseURL: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      model: "claude-3-5-sonnet-20241022",
      onRateLimitInfo: (info) => received.push(info),
    });
    await p.generate(history, []);
    expect(received).toHaveLength(0);
  });

  it("generateStream:命中 ratelimit-remaining (IETF draft) 回调", async () => {
    const sse = `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 1 } },
    })}\n\nevent: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      usage: { output_tokens: 1 },
    })}\n\nevent: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    mockStreamFetchWithHeaders(sse, { "ratelimit-remaining": "8", "ratelimit-reset": "60" });
    const received: RateLimitInfo[] = [];
    const p = new ClaudeProvider({
      baseURL: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      model: "claude-3-5-sonnet-20241022",
      onRateLimitInfo: (info) => received.push(info),
    });
    await p.generateStream(history, [], () => {});
    expect(received).toHaveLength(1);
    expect(received[0]!.remaining).toBe(8);
  });
});

// ===== Gemini =====
describe("GeminiProvider RateLimit 回传", () => {
  it("generate:命中 X-RateLimit-* 回调", async () => {
    mockJsonFetchWithHeaders(
      {
        candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      },
      { "x-ratelimit-remaining": "12", "x-ratelimit-limit": "60" },
    );
    const received: RateLimitInfo[] = [];
    const p = new GeminiProvider({
      baseURL: "https://generativelanguage.googleapis.com",
      apiKey: "AIza-test",
      model: "gemini-2.0-flash",
      onRateLimitInfo: (info) => received.push(info),
    });
    await p.generate(history, []);
    expect(received).toHaveLength(1);
    expect(received[0]!.remaining).toBe(12);
    expect(received[0]!.limit).toBe(60);
  });

  it("generate:无 RateLimit header 时不回调", async () => {
    mockJsonFetchWithHeaders({
      candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
    });
    const received: RateLimitInfo[] = [];
    const p = new GeminiProvider({
      baseURL: "https://generativelanguage.googleapis.com",
      apiKey: "AIza-test",
      model: "gemini-2.0-flash",
      onRateLimitInfo: (info) => received.push(info),
    });
    await p.generate(history, []);
    expect(received).toHaveLength(0);
  });

  it("generateStream:命中 X-RateLimit-Remaining 回调", async () => {
    const sse = `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: "hi" }] } }],
    })}\n\n`;
    mockStreamFetchWithHeaders(sse, { "x-ratelimit-remaining": "2" });
    const received: RateLimitInfo[] = [];
    const p = new GeminiProvider({
      baseURL: "https://generativelanguage.googleapis.com",
      apiKey: "AIza-test",
      model: "gemini-2.0-flash",
      onRateLimitInfo: (info) => received.push(info),
    });
    await p.generateStream(history, [], () => {});
    expect(received).toHaveLength(1);
    expect(received[0]!.remaining).toBe(2);
  });
});
