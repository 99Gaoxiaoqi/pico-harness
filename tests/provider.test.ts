// Provider 适配器的翻译层单测。
// 用全局 fetch mock 拦截请求,验证 schema.Message ↔ 厂商格式的双向翻译,
// 不依赖真实 API key。

import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProvider } from "../src/provider/claude.js";
import { createProvider } from "../src/provider/factory.js";
import { isModelUnavailableError } from "../src/provider/fallback.js";
import { OpenAIProvider } from "../src/provider/openai.js";
import { resolveProviderProfile } from "../src/provider/profile.js";
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
              {
                id: "c1",
                type: "function",
                function: { name: "echo", arguments: '{"text":"hi"}' },
              },
            ],
          },
        },
      ],
    });
    const p = new OpenAIProvider(cfg);
    const msg = await p.generate(history, [echoTool]);
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("好的");
    expect(msg.toolCalls).toEqual([{ id: "c1", name: "echo", arguments: '{"text":"hi"}' }]);
  });

  it("空 tools 时不挂载 tools 字段", async () => {
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

  it("工厂只创建 raw provider,不在 factory 内做 glm-5.2 fallback", async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      calls.push({ body });

      return new Response(JSON.stringify({ error: { message: "model glm-5.2 unavailable" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const p = createProvider("openai", cfg);

    await expect(p.generate(history, [])).rejects.toThrow("model glm-5.2 unavailable");
    expect(calls.map((call) => call.body.model)).toEqual(["glm-5.2"]);
  });

  it("把 glm-5.2 额度耗尽视为当前模型不可用", () => {
    expect(
      isModelUnavailableError(
        new Error(
          "429 RateLimitError: You have exceeded the 5-hour usage quota. Received Model Group=glm-5.2",
        ),
        "glm-5.2",
      ),
    ).toBe(true);
  });

  it("解析 OpenAI cache/reasoning usage 与 reasoning_content", async () => {
    mockFetch({
      choices: [
        {
          message: {
            role: "assistant",
            content: "答案",
            reasoning_content: "内部推理摘要",
          },
        },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 200 },
        completion_tokens_details: { reasoning_tokens: 80 },
      },
    });
    const p = new OpenAIProvider(cfg);
    const msg = await p.generate(history, []);

    expect(msg.reasoning).toBe("内部推理摘要");
    expect(msg.usage).toMatchObject({
      promptTokens: 1000,
      completionTokens: 300,
      cacheReadTokens: 200,
      reasoningTokens: 80,
    });
  });

  it("ProviderProfile 声明 glm-5.2 的 fallback 与消息怪癖", () => {
    const profile = resolveProviderProfile("openai", "glm-5.2");
    expect(profile.fallbackModel).toBe("kimi-k2.5");
    expect(profile.assistantContent).toBe("null_when_empty");
    expect(profile.contextWindowTokens).toBeGreaterThan(0);
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
    // Claude profile 默认 supportsPromptCache=true:system 会被转成带 cache_control 的 block 数组。
    // 断言语义不变(内容仍是 "你是助手"),只是结构升级为数组。
    const systemBlocks = body.system as { type: string; text: string; cache_control?: unknown }[];
    expect(systemBlocks[0]!.text).toBe("你是助手");
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
    expect(msg.toolCalls).toEqual([{ id: "c1", name: "echo", arguments: '{"text":"hi"}' }]);
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

  it("解析 Claude cache creation/read usage", async () => {
    mockFetch({
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 300,
      },
    });
    const p = new ClaudeProvider(cfg);
    const msg = await p.generate(history, []);

    expect(msg.usage).toMatchObject({
      promptTokens: 1000,
      completionTokens: 200,
      cacheWriteTokens: 100,
      cacheReadTokens: 300,
    });
  });

  it("ProviderProfile 返回 Claude contextWindowTokens", () => {
    const profile = resolveProviderProfile("claude", "claude-3-5-sonnet");
    expect(profile.contextWindowTokens).toBeGreaterThan(0);
  });

  it("prompt cache:supportsPromptCache 模型在 system/tools/历史前缀尾注入断点", async () => {
    const calls = mockFetch({ content: [{ type: "text", text: "ok" }] });
    const p = new ClaudeProvider(cfg); // claude profile 默认 supportsPromptCache=true
    const hist: Message[] = [
      { role: "system", content: "你是助手" },
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "答1" },
      { role: "user", content: "第二轮" },
      { role: "assistant", content: "答2" },
      { role: "user", content: "本轮新输入" },
    ];
    await p.generate(hist, [echoTool]);

    const body = calls[0]!.body as Record<string, unknown>;
    // 断点① system:字符串转数组并打 cache_control
    const systemBlocks = body.system as { cache_control?: { type: string } }[];
    expect(systemBlocks[0]!.cache_control?.type).toBe("ephemeral");
    // 断点② tools 尾:最后一个 tool 带 cache_control
    const tools = body.tools as { cache_control?: { type: string } }[];
    expect(tools[tools.length - 1]!.cache_control?.type).toBe("ephemeral");
    // 断点③ 历史前缀尾:倒数第二条消息(答2)的末 block 带 cache_control,
    // 最后一条(本轮新输入)不带——它在每轮都变,不进缓存边界。
    const msgs = body.messages as {
      role: string;
      content: { cache_control?: { type: string } }[];
    }[];
    const prefixTail = msgs[msgs.length - 2]!;
    expect(prefixTail.content.at(-1)!.cache_control?.type).toBe("ephemeral");
    const lastMsg = msgs[msgs.length - 1]!;
    expect(lastMsg.content.at(-1)!.cache_control).toBeUndefined();
  });

  it("prompt cache:断点总数不超过 Anthropic 上限 4", async () => {
    const calls = mockFetch({ content: [{ type: "text", text: "ok" }] });
    const p = new ClaudeProvider(cfg);
    // 构造超长历史,确保注入逻辑不会越界产生 >4 个断点。
    const hist: Message[] = [{ role: "system", content: "你是助手" }];
    for (let i = 0; i < 20; i++) {
      hist.push({ role: "user", content: `第${i}轮问题` });
      hist.push({ role: "assistant", content: `第${i}轮回答` });
    }
    hist.push({ role: "user", content: "最新输入" });
    await p.generate(hist, [echoTool]);

    const body = calls[0]!.body as Record<string, unknown>;
    let count = 0;
    for (const block of body.system as { cache_control?: unknown }[]) {
      if (block.cache_control) count++;
    }
    for (const tool of body.tools as { cache_control?: unknown }[]) {
      if (tool.cache_control) count++;
    }
    for (const msg of body.messages as { content: { cache_control?: unknown }[] }[]) {
      for (const block of msg.content) {
        if (block.cache_control) count++;
      }
    }
    expect(count).toBeLessThanOrEqual(4);
  });
});
