// Provider 适配器的翻译层单测。
// 用全局 fetch mock 拦截请求,验证 schema.Message ↔ 厂商格式的双向翻译,
// 不依赖真实 API key。

import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProvider } from "../src/provider/claude.js";
import { OpenAIProvider } from "../src/provider/openai.js";
import type { Message, ToolDefinition } from "../src/schema/message.js";

const cfg = { baseURL: "https://test.local/v1", apiKey: "sk-test", model: "glm-5.2" };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** 捕获请求体,返回预设响应 */
function mockFetch(responseBody: unknown) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body as string) : null,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

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

describe("OpenAIProvider 翻译层", () => {
  it("正向:system/user 翻译为 OpenAI messages,工具挂到 tools", async () => {
    const calls = mockFetch({
      choices: [{ message: { role: "assistant", content: "done", tool_calls: [] } }],
    });
    const p = new OpenAIProvider(cfg);
    await p.generate(history, [echoTool]);

    const body = calls[0]!.body as Record<string, unknown>;
    const msgs = body.messages as Record<string, unknown>[];
    expect(msgs[0]).toEqual({ role: "system", content: "你是助手" });
    expect(msgs[1]).toEqual({ role: "user", content: "回显 hi" });
    expect(body.tools).toBeDefined();
    // 鉴权用 Bearer
    expect(calls[0]!.headers.Authorization).toBe("Bearer sk-test");
  });

  it("反向:tool_calls 解析为 schema.ToolCall", async () => {
    mockFetch({
      choices: [
        {
          message: {
            role: "assistant",
            content: "好的",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"hi"}' } },
            ],
          },
        },
      ],
    });
    const p = new OpenAIProvider(cfg);
    const msg = await p.generate(history, [echoTool]);
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("好的");
    expect(msg.toolCalls).toEqual([
      { id: "c1", name: "echo", arguments: '{"text":"hi"}' },
    ]);
  });

  it("慢思考:空 tools 时不挂载 tools 字段", async () => {
    const calls = mockFetch({
      choices: [{ message: { role: "assistant", content: "思考中" } }],
    });
    const p = new OpenAIProvider(cfg);
    await p.generate(history, []);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
  });

  it("历史工具结果翻译为 role=tool + tool_call_id", async () => {
    const calls = mockFetch({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
    const p = new OpenAIProvider(cfg);
    const hist: Message[] = [
      ...history,
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", arguments: "{}" }] },
      { role: "user", content: "echo: hi", toolCallId: "c1" },
    ];
    await p.generate(hist, []);
    const msgs = (calls[0]!.body as Record<string, unknown>).messages as Record<string, unknown>[];
    // 末尾应是 tool 消息
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe("tool");
    expect(last.tool_call_id).toBe("c1");
  });
});

describe("ClaudeProvider 翻译层", () => {
  it("正向:system 抽到顶层字段,工具用 input_schema", async () => {
    const calls = mockFetch({
      content: [{ type: "text", text: "done" }],
    });
    const p = new ClaudeProvider(cfg);
    await p.generate(history, [echoTool]);

    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.system).toBe("你是助手");
    const msgs = body.messages as { role: string; content: unknown[] }[];
    expect(msgs[0]!.role).toBe("user");
    // 鉴权用 x-api-key + anthropic-version
    expect(calls[0]!.headers["x-api-key"]).toBe("sk-test");
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    const tools = body.tools as Record<string, unknown>[];
    expect(tools[0]!.input_schema).toBeDefined();
  });

  it("反向:tool_use block 解析为 schema.ToolCall", async () => {
    mockFetch({
      content: [
        { type: "text", text: "好的" },
        { type: "tool_use", id: "c1", name: "echo", input: { text: "hi" } },
      ],
    });
    const p = new ClaudeProvider(cfg);
    const msg = await p.generate(history, [echoTool]);
    expect(msg.content).toBe("好的");
    expect(msg.toolCalls).toEqual([
      { id: "c1", name: "echo", arguments: '{"text":"hi"}' },
    ]);
  });

  it("历史工具结果翻译为 tool_result block", async () => {
    const calls = mockFetch({
      content: [{ type: "text", text: "ok" }],
    });
    const p = new ClaudeProvider(cfg);
    const hist: Message[] = [
      ...history,
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", arguments: "{}" }] },
      { role: "user", content: "echo: hi", toolCallId: "c1" },
    ];
    await p.generate(hist, []);
    const msgs = (calls[0]!.body as Record<string, unknown>).messages as {
      role: string;
      content: { type: string }[];
    }[];
    // 末尾 user 消息应含 tool_result block
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content.some((b) => b.type === "tool_result")).toBe(true);
  });
});
