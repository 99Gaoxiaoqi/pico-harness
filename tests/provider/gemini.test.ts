// GeminiProvider 单测 (generate + generateStream)。
// 用全局 fetch mock 拦截请求,验证 Gemini 原生协议的翻译与解析:
// - 消息翻译:system 顶层 system_instruction、assistant→role:"model"、toolCallId→functionResponse
// - 纯文本响应:text 拼接
// - 工具调用:functionCall 解析为 toolCalls、args 是 JSON 字符串
// - 流式:SSE delta 顺序、functionCall 累积
// - 错误:HTTP 429/500 → LLMStatusError;上下文溢出 → ContextOverflowError
// - key 在 query param 不在 header
// 不依赖真实 API key。

import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "../../src/provider/gemini.js";
import { ContextOverflowError, LLMStatusError } from "../../src/provider/errors.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";

const cfg = { baseURL: "https://generativelanguage.googleapis.com", apiKey: "AIza-test-key", model: "gemini-2.0-flash" };

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

/** Mock fetch 返回 JSON body(非流式)。记录调用 url/body/header。 */
function mockJsonFetch(
  json: unknown,
  status = 200,
): { calls: { url: string; body: unknown; headers: Record<string, string> }[] } {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body as string) : null,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      body: null,
      async json() {
        return json;
      },
      async text() {
        return JSON.stringify(json);
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls };
}

/** Mock fetch 返回错误体(非流式)。 */
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

function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Mock fetch 返回流式 body。 */
function mockStreamFetch(
  body: ReadableStream<Uint8Array>,
  status = 200,
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
      statusText: status === 200 ? "OK" : "Error",
      body,
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

describe("GeminiProvider.generate (非流式)", () => {
  it("纯文本响应:提取 text,content 正确拼接", async () => {
    mockJsonFetch({
      candidates: [
        {
          content: { parts: [{ text: "Hello, world!" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
    });

    const p = new GeminiProvider(cfg);
    const msg = await p.generate(history, []);

    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("Hello, world!");
    expect(msg.toolCalls).toBeUndefined();
    expect(msg.usage).toMatchObject({ promptTokens: 10, completionTokens: 3 });
  });

  it("消息翻译:system → system_instruction,assistant → role:model", async () => {
    const { calls } = mockJsonFetch({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    });

    const p = new GeminiProvider(cfg);
    await p.generate(
      [
        { role: "system", content: "你是助手" },
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好啊", toolCalls: [{ id: "c1", name: "echo", arguments: '{"text":"x"}' }] },
        { role: "user", content: "hi", toolCallId: "echo" },
      ],
      [echoTool],
    );

    const body = calls[0]!.body as Record<string, unknown>;
    // system 提到顶层 system_instruction
    expect(body.system_instruction).toEqual({ parts: [{ text: "你是助手" }] });
    const contents = body.contents as { role: string; parts: unknown[] }[];
    // user 文本
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "你好" }] });
    // assistant → model,含 text + functionCall(args 为对象)
    expect(contents[1]!.role).toBe("model");
    const modelParts = contents[1]!.parts as { text?: string; functionCall?: { name: string; args: unknown } }[];
    expect(modelParts[0]!.text).toBe("你好啊");
    expect(modelParts[1]!.functionCall).toEqual({ name: "echo", args: { text: "x" } });
    // toolCallId 的 user → functionResponse
    expect(contents[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "echo", response: { result: "hi" } } }],
    });
    // tools → functionDeclarations(parameters 为 JSON Schema)
    const tools = body.tools as { functionDeclarations: { name: string; parameters: Record<string, unknown> }[] }[];
    expect(tools[0]!.functionDeclarations[0]!.name).toBe("echo");
    expect(tools[0]!.functionDeclarations[0]!.parameters).toMatchObject({ type: "object" });
  });

  it("工具调用响应:functionCall 解析为 toolCalls,args 是 JSON 字符串", async () => {
    mockJsonFetch({
      candidates: [
        {
          content: {
            parts: [
              { text: "好的" },
              { functionCall: { name: "echo", args: { text: "hi" } } },
            ],
          },
          finishReason: "STOP",
        },
      ],
    });

    const p = new GeminiProvider(cfg);
    const msg = await p.generate(history, [echoTool]);

    expect(msg.content).toBe("好的");
    expect(msg.toolCalls).toEqual([
      { id: "gemini-call-0", name: "echo", arguments: '{"text":"hi"}' },
    ]);
  });

  it("同名 functionCall 生成唯一 toolCallId", async () => {
    mockJsonFetch({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: "echo", args: { text: "one" } } },
              { functionCall: { name: "echo", args: { text: "two" } } },
            ],
          },
          finishReason: "STOP",
        },
      ],
    });

    const p = new GeminiProvider(cfg);
    const msg = await p.generate(history, [echoTool]);

    expect(msg.toolCalls).toEqual([
      { id: "gemini-call-0", name: "echo", arguments: '{"text":"one"}' },
      { id: "gemini-call-1", name: "echo", arguments: '{"text":"two"}' },
    ]);
  });

  it("key 在 query param,不在 header(无 Authorization)", async () => {
    const { calls } = mockJsonFetch({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    });

    const p = new GeminiProvider(cfg);
    await p.generate(history, []);

    expect(calls[0]!.url).toContain("key=AIza-test-key");
    expect(calls[0]!.url).toContain(":generateContent");
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  it("HTTP 429 → 抛 LLMStatusError", async () => {
    mockErrorFetch(429, "RESOURCE_EXHAUSTED");
    const p = new GeminiProvider(cfg);
    await expect(p.generate(history, [])).rejects.toThrow(LLMStatusError);
  });

  it("HTTP 500 → 抛 LLMStatusError", async () => {
    mockErrorFetch(500, "Internal Server Error");
    const p = new GeminiProvider(cfg);
    await expect(p.generate(history, [])).rejects.toThrow(LLMStatusError);
  });

  it("上下文溢出状态码 → 抛 ContextOverflowError", async () => {
    mockErrorFetch(400, "Request exceeds the maximum context window");
    const p = new GeminiProvider(cfg);
    await expect(p.generate(history, [])).rejects.toThrow(ContextOverflowError);
  });

  it("空 candidates → 抛 Error", async () => {
    mockJsonFetch({ candidates: [] });
    const p = new GeminiProvider(cfg);
    await expect(p.generate(history, [])).rejects.toThrow(/空/);
  });
});

describe("GeminiProvider.generateStream (流式)", () => {
  it("纯文本流:text 按顺序转发 onDelta,content 拼接", async () => {
    const sse =
      sseData({
        candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: undefined }],
      }) +
      sseData({
        candidates: [{ content: { parts: [{ text: ", " }] } }],
      }) +
      sseData({
        candidates: [{ content: { parts: [{ text: "world!" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      });

    mockStreamFetch(sseStream([sse]));

    const deltas: string[] = [];
    const p = new GeminiProvider(cfg);
    const msg = await p.generateStream!(history, [], (d) => deltas.push(d));

    expect(deltas).toEqual(["Hello", ", ", "world!"]);
    expect(msg.content).toBe("Hello, world!");
    expect(msg.toolCalls).toBeUndefined();
    expect(msg.usage).toMatchObject({ promptTokens: 5, completionTokens: 3 });
  });

  it("工具调用流:functionCall 累积为 toolCalls,args 是 JSON 字符串", async () => {
    const sse =
      sseData({
        candidates: [{ content: { parts: [{ text: "好的" }] } }],
      }) +
      sseData({
        candidates: [
          { content: { parts: [{ functionCall: { name: "echo", args: { text: "hi" } } }] } },
        ],
        finishReason: "STOP",
      });

    mockStreamFetch(sseStream([sse]));

    const deltas: string[] = [];
    const p = new GeminiProvider(cfg);
    const msg = await p.generateStream!(history, [echoTool], (d) => deltas.push(d));

    expect(deltas).toEqual(["好的"]);
    expect(msg.content).toBe("好的");
    expect(msg.toolCalls).toEqual([
      expect.objectContaining({ name: "echo", arguments: '{"text":"hi"}' }),
    ]);
  });

  it("工具调用流:同名 functionCall 按出现顺序保留为多个调用", async () => {
    const sse =
      sseData({
        candidates: [
          { content: { parts: [{ functionCall: { name: "echo", args: { text: "one" } } }] } },
        ],
      }) +
      sseData({
        candidates: [
          { content: { parts: [{ functionCall: { name: "echo", args: { text: "two" } } }] } },
        ],
        finishReason: "STOP",
      });

    mockStreamFetch(sseStream([sse]));

    const p = new GeminiProvider(cfg);
    const msg = await p.generateStream!(history, [echoTool], () => {});

    expect(msg.toolCalls).toEqual([
      { id: "gemini-call-0", name: "echo", arguments: '{"text":"one"}' },
      { id: "gemini-call-1", name: "echo", arguments: '{"text":"two"}' },
    ]);
  });

  it("流式端点 URL 含 streamGenerateContent + key= + alt=sse", async () => {
    const { calls } = mockStreamFetch(
      sseStream([
        sseData({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }] }),
      ]),
    );

    const p = new GeminiProvider(cfg);
    await p.generateStream!(history, [], () => {});

    expect(calls[0]!.url).toContain(":streamGenerateContent");
    expect(calls[0]!.url).toContain("key=AIza-test-key");
    expect(calls[0]!.url).toContain("alt=sse");
  });

  it("分块传输边界:一个 SSE 事件被拆成多个 chunk 也能正确解析", async () => {
    const full =
      sseData({ candidates: [{ content: { parts: [{ text: "AB" }] } }] }) +
      sseData({ candidates: [{ content: { parts: [{ text: "CD" }] }, finishReason: "STOP" }] });

    // 按 30 字符切片模拟网络分片
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += 30) {
      chunks.push(full.slice(i, i + 30));
    }

    mockStreamFetch(sseStream(chunks));

    const deltas: string[] = [];
    const p = new GeminiProvider(cfg);
    const msg = await p.generateStream!(history, [], (d) => deltas.push(d));

    expect(deltas).toEqual(["AB", "CD"]);
    expect(msg.content).toBe("ABCD");
  });

  it("HTTP 非 200 → 抛 LLMStatusError", async () => {
    mockErrorFetch(500, "Internal Server Error");
    const p = new GeminiProvider(cfg);
    await expect(p.generateStream!(history, [], () => {})).rejects.toThrow(LLMStatusError);
  });
});

// Gemini 真实模型 e2e:必须显式 opt-in,避免默认 npm test 因本机凭证误触真实网络。
const RUN_GEMINI_E2E = process.env.RUN_GEMINI_E2E === "1" && !!process.env.GEMINI_API_KEY;
const e2eDescribe = RUN_GEMINI_E2E ? describe : describe.skip;
e2eDescribe("GeminiProvider e2e (真实模型)", () => {
  it("真实 generate 返回文本", async () => {
    const p = new GeminiProvider({
      baseURL: "https://generativelanguage.googleapis.com",
      apiKey: process.env.GEMINI_API_KEY!,
      model: "gemini-2.0-flash",
    });
    const msg = await p.generate([{ role: "user", content: "用一个字回答:你好吗?" }], []);
    expect(msg.content.length).toBeGreaterThan(0);
  });
});
