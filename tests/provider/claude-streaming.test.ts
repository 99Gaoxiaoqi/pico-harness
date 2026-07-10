// ClaudeProvider 流式输出单测 (generateStream)。
// 用全局 fetch mock 拦截请求,返回手搓的 SSE ReadableStream,
// 验证 Anthropic 流式协议解析(text_delta / input_json_delta / usage / 错误)。
// 不依赖真实 API key。

import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProvider } from "../../src/provider/claude.js";
import { ContextOverflowError, LLMStatusError } from "../../src/provider/errors.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";

const cfg = { baseURL: "https://test.local/v1", apiKey: "sk-test", model: "claude-3-5-sonnet" };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const echoTool: ToolDefinition = {
  name: "echo",
  description: "回显",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

const history: Message[] = [
  { role: "system", content: "你是助手" },
  { role: "user", content: "回显 hi" },
];

/**
 * 把一段段 SSE 文本编码成 ReadableStream<Uint8Array>。
 * @param sseChunks SSE 片段数组,会按顺序写入流(每段之间用 \n\n 分隔由调用方控制)。
 */
function sseStream(sseChunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of sseChunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** 构造一个"事件:data"的 SSE 块 */
function sseEvent(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Mock fetch 返回流式 body */
function mockStreamFetch(
  body: ReadableStream<Uint8Array>,
  status = 200,
  statusText = "OK",
): { calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      body,
      // 错误场景用 text() 读取报错体
      async text() {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let out = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          out += decoder.decode(value, { stream: true });
        }
        return out;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls };
}

/** Mock fetch 返回纯文本错误体(非流式) */
function mockErrorFetch(status: number, text: string): void {
  globalThis.fetch = vi.fn(async () => {
    return {
      ok: false,
      status,
      statusText: "Error",
      body: null,
      async text() {
        return text;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("ClaudeProvider 流式输出 (generateStream)", () => {
  it("纯文本流:text_delta 按顺序转发到 onDelta,content 正确拼接", async () => {
    const sse =
      sseEvent("message_start", {
        type: "message_start",
        message: { id: "msg_1", usage: { input_tokens: 10 } },
      }) +
      sseEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: ", " },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "world!" },
      }) +
      sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      }) +
      sseEvent("message_stop", { type: "message_stop" });

    mockStreamFetch(sseStream([sse]));

    const deltas: string[] = [];
    const p = new ClaudeProvider(cfg);
    const msg = await p.generateStream!(history, [], (d) => deltas.push(d));

    expect(deltas).toEqual(["Hello", ", ", "world!"]);
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("Hello, world!");
    expect(msg.toolCalls).toBeUndefined();
  });

  it("工具调用流:content_block_start(tool_use) + input_json_delta 分片累积,input 正确解析", async () => {
    const sse =
      sseEvent("message_start", {
        type: "message_start",
        message: { id: "msg_1", usage: { input_tokens: 10 } },
      }) +
      sseEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "好的" },
      }) +
      sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sseEvent("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "echo", input: {} },
      }) +
      // input 分片传输
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"text":' },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"hi"}' },
      }) +
      sseEvent("content_block_stop", { type: "content_block_stop", index: 1 }) +
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 8 },
      }) +
      sseEvent("message_stop", { type: "message_stop" });

    mockStreamFetch(sseStream([sse]));

    const deltas: string[] = [];
    const p = new ClaudeProvider(cfg);
    const msg = await p.generateStream!(history, [echoTool], (d) => deltas.push(d));

    expect(deltas).toEqual(["好的"]);
    expect(msg.content).toBe("好的");
    expect(msg.toolCalls).toEqual([{ id: "toolu_1", name: "echo", arguments: '{"text":"hi"}' }]);
  });

  it("usage 统计:message_start 的 input_tokens + message_delta 的 output_tokens + cache 字段", async () => {
    const sse =
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          usage: {
            input_tokens: 1000,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 300,
          },
        },
      }) +
      sseEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }) +
      sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 200 },
      }) +
      sseEvent("message_stop", { type: "message_stop" });

    mockStreamFetch(sseStream([sse]));

    const p = new ClaudeProvider(cfg);
    const msg = await p.generateStream!(history, [], () => {});

    expect(msg.usage).toMatchObject({
      promptTokens: 1000,
      completionTokens: 200,
      cacheWriteTokens: 100,
      cacheReadTokens: 300,
    });
  });

  it("请求体含 stream: true,并复用翻译逻辑(system 顶层 + input_schema)", async () => {
    const { calls } = mockStreamFetch(
      sseStream([
        sseEvent("message_start", {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 1 } },
        }) +
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }) +
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "x" },
          }) +
          sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
          sseEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          }) +
          sseEvent("message_stop", { type: "message_stop" }),
      ]),
    );

    const p = new ClaudeProvider(cfg);
    await p.generateStream!(history, [echoTool], () => {});

    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.system).toBeDefined();
    const tools = body.tools as Record<string, unknown>[];
    expect(tools[0]!.input_schema).toBeDefined();
  });

  it("HTTP 非 200 → 抛 LLMStatusError", async () => {
    mockErrorFetch(500, "Internal Server Error");

    const p = new ClaudeProvider(cfg);
    await expect(p.generateStream!(history, [], () => {})).rejects.toThrow(LLMStatusError);
  });

  it("上下文溢出状态码 → 抛 ContextOverflowError", async () => {
    mockErrorFetch(400, "prompt is too long, exceeds maximum context length");

    const p = new ClaudeProvider(cfg);
    await expect(p.generateStream!(history, [], () => {})).rejects.toThrow(ContextOverflowError);
  });

  it("error 事件:服务端推送错误 → 抛 Error", async () => {
    const sse = sseEvent("error", {
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    });
    mockStreamFetch(sseStream([sse]));

    const p = new ClaudeProvider(cfg);
    await expect(p.generateStream!(history, [], () => {})).rejects.toThrow(/Overloaded/);
  });

  it("ping 事件被忽略,不影响流", async () => {
    const sse =
      sseEvent("ping", { type: "ping" }) +
      sseEvent("message_start", {
        type: "message_start",
        message: { id: "msg_1", usage: { input_tokens: 1 } },
      }) +
      sseEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }) +
      sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sseEvent("ping", { type: "ping" }) +
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      }) +
      sseEvent("message_stop", { type: "message_stop" });

    mockStreamFetch(sseStream([sse]));

    const deltas: string[] = [];
    const p = new ClaudeProvider(cfg);
    const msg = await p.generateStream!(history, [], (d) => deltas.push(d));

    expect(deltas).toEqual(["ok"]);
    expect(msg.content).toBe("ok");
  });

  it("分块传输边界:一个 SSE 事件被拆成多个 chunk 也能正确解析", async () => {
    // 完整的两条事件,但故意按"非事件边界"切分
    const full =
      sseEvent("message_start", {
        type: "message_start",
        message: { id: "msg_1", usage: { input_tokens: 1 } },
      }) +
      sseEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "AB" },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "CD" },
      }) +
      sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      }) +
      sseEvent("message_stop", { type: "message_stop" });

    // 按 50 字符切片模拟网络分片(可能切断事件边界)
    const chunkSize = 50;
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += chunkSize) {
      chunks.push(full.slice(i, i + chunkSize));
    }

    mockStreamFetch(sseStream(chunks));

    const deltas: string[] = [];
    const p = new ClaudeProvider(cfg);
    const msg = await p.generateStream!(history, [], (d) => deltas.push(d));

    expect(deltas).toEqual(["AB", "CD"]);
    expect(msg.content).toBe("ABCD");
  });
});
