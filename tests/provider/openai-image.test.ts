// OpenAIProvider 图片多模态翻译单测 (5.5b)。
// 用全局 fetch mock 拦截请求,验证 schema.Message.images → OpenAI Chat Completions
// 的 content 数组翻译。不依赖真实 API key。

import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../../src/provider/openai.js";
import type { Message } from "../../src/schema/message.js";

const cfg = { baseURL: "https://test.local/v1", apiKey: "sk-test", model: "glm-5.2" };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** 捕获请求体,返回预设的 JSON 响应(非流式)。 */
function mockFetch(responseBody: unknown) {
  const calls: { body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    calls.push({ body: init?.body ? JSON.parse(init.body as string) : null });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

/** 构造一个 OpenAI 风格的流式 SSE body。 */
function sseBody(deltas: { content?: string }[]) {
  const events = deltas
    .map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}`)
    .concat(["data: [DONE]"]);
  return events.join("\n\n") + "\n\n";
}

/** 捕获请求体,返回预设的流式 SSE 响应。 */
function mockFetchStream(deltas: { content?: string }[]) {
  const calls: { body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    calls.push({ body: init?.body ? JSON.parse(init.body as string) : null });
    return new Response(sseBody(deltas), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe("OpenAIProvider 图片多模态翻译", () => {
  it("image_base64 → content 数组含 data:image/png;base64,xxx", async () => {
    const calls = mockFetch({
      choices: [{ message: { role: "assistant", content: "看到图了" } }],
    });
    const p = new OpenAIProvider(cfg);
    const hist: Message[] = [
      { role: "system", content: "你是助手" },
      {
        role: "user",
        content: "看这张图",
        images: [{ type: "image_base64", mimeType: "image/png", data: "xxx" }],
      },
    ];
    await p.generate(hist, []);

    const msgs = (calls[0]!.body as Record<string, unknown>).messages as Record<
      string,
      unknown
    >[];
    const userMsg = msgs[1]!;
    expect(userMsg.role).toBe("user");
    // 有图片时 content 必须是数组
    expect(Array.isArray(userMsg.content)).toBe(true);
    const content = userMsg.content as Record<string, unknown>[];
    // 第一段是文本
    expect(content[0]).toEqual({ type: "text", text: "看这张图" });
    // 第二段是 image_url,base64 被拼成 data URL
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,xxx" },
    });
  });

  it("image_url → content 数组直接用 url", async () => {
    const calls = mockFetch({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
    const p = new OpenAIProvider(cfg);
    const hist: Message[] = [
      {
        role: "user",
        content: "这是网络图",
        images: [{ type: "image_url", url: "https://example.com/a.jpg" }],
      },
    ];
    await p.generate(hist, []);

    const msgs = (calls[0]!.body as Record<string, unknown>).messages as Record<
      string,
      unknown
    >[];
    const content = msgs[0]!.content as Record<string, unknown>[];
    expect(content[0]).toEqual({ type: "text", text: "这是网络图" });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "https://example.com/a.jpg" },
    });
  });

  it("无 images → content 仍是纯字符串(回归)", async () => {
    const calls = mockFetch({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
    const p = new OpenAIProvider(cfg);
    const hist: Message[] = [{ role: "user", content: "纯文本" }];
    await p.generate(hist, []);

    const msgs = (calls[0]!.body as Record<string, unknown>).messages as Record<
      string,
      unknown
    >[];
    // 无图片时保持字符串,不变成数组
    expect(msgs[0]!.content).toBe("纯文本");
    expect(typeof msgs[0]!.content).toBe("string");
  });

  it("多张图片 → 数组有多个 image_url", async () => {
    const calls = mockFetch({
      choices: [{ message: { role: "assistant", content: "看到了" } }],
    });
    const p = new OpenAIProvider(cfg);
    const hist: Message[] = [
      {
        role: "user",
        content: "对比这两张",
        images: [
          { type: "image_base64", mimeType: "image/png", data: "aaa" },
          { type: "image_url", url: "https://example.com/b.jpg" },
        ],
      },
    ];
    await p.generate(hist, []);

    const msgs = (calls[0]!.body as Record<string, unknown>).messages as Record<
      string,
      unknown
    >[];
    const content = msgs[0]!.content as Record<string, unknown>[];
    // 文本 + 2 张图 = 3 个 block
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: "text", text: "对比这两张" });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,aaa" },
    });
    expect(content[2]).toEqual({
      type: "image_url",
      image_url: { url: "https://example.com/b.jpg" },
    });
    // 全部 image_url block
    const imageBlocks = content.filter((b) => b.type === "image_url");
    expect(imageBlocks).toHaveLength(2);
  });

  it("generateStream 也走多模态翻译(图片 → image_url)", async () => {
    const calls = mockFetchStream([{ content: "看" }, { content: "到了" }]);
    const p = new OpenAIProvider(cfg);
    const hist: Message[] = [
      {
        role: "user",
        content: "看图",
        images: [{ type: "image_base64", mimeType: "image/jpeg", data: "yyy" }],
      },
    ];
    const deltas: string[] = [];
    const msg = await p.generateStream(hist, [], (d) => deltas.push(d));

    // 流式请求体里 user 消息同样被翻译成数组
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.stream).toBe(true);
    const msgs = body.messages as Record<string, unknown>[];
    const content = msgs[0]!.content as Record<string, unknown>[];
    expect(content[0]).toEqual({ type: "text", text: "看图" });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,yyy" },
    });
    // 流式 delta 转发正常
    expect(deltas).toEqual(["看", "到了"]);
    expect(msg.content).toBe("看到了");
  });
});
