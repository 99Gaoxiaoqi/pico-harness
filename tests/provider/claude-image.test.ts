// ClaudeProvider 图片多模态翻译单测 (5.5c)。
// 用全局 fetch mock 拦截 generate 的非流式请求,
// 验证 user 消息里的 ImagePart 被正确翻译为 Anthropic image block。
// 不依赖真实 API key。

import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProvider } from "../../src/provider/claude.js";
import type { Message } from "../../src/schema/message.js";

const cfg = { baseURL: "https://test.local/v1", apiKey: "sk-test", model: "claude-3-5-sonnet" };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Mock fetch:返回一个最小合法的 Anthropic 非流式响应,并捕获请求体供断言。 */
function mockOkFetch(): { calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      async json() {
        return {
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
      async text() {
        return "";
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls };
}

/** Mock fetch:永不 resolve(用于测 throw 场景,确保 fetch 不被调用)。 */
function mockShouldNotFetch(): void {
  globalThis.fetch = vi.fn(async () => {
    throw new Error("fetch 不应被调用(image_url 应在翻译阶段抛错)");
  }) as unknown as typeof fetch;
}

describe("ClaudeProvider 图片多模态翻译 (buildRequestBody)", () => {
  it("单张 base64 图片:user content 含 [image block, text block],顺序正确", async () => {
    const { calls } = mockOkFetch();

    const messages: Message[] = [
      {
        role: "user",
        content: "这张图里是什么?",
        images: [{ type: "image_base64", mimeType: "image/png", data: "QUJDQ0Q=" }],
      },
    ];

    const p = new ClaudeProvider(cfg);
    await p.generate(messages, []);

    const body = calls[0]!.body as Record<string, unknown>;
    const msgs = body.messages as { role: string; content: unknown[] }[];
    expect(msgs[0]!.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "QUJDQ0Q=" },
      },
      { type: "text", text: "这张图里是什么?" },
    ]);
  });

  it("多张图片:生成多个 image block,都在 text block 之前", async () => {
    const { calls } = mockOkFetch();

    const messages: Message[] = [
      {
        role: "user",
        content: "比较这两张图",
        images: [
          { type: "image_base64", mimeType: "image/png", data: "AAAA" },
          { type: "image_base64", mimeType: "image/jpeg", data: "BBBB" },
        ],
      },
    ];

    const p = new ClaudeProvider(cfg);
    await p.generate(messages, []);

    const body = calls[0]!.body as Record<string, unknown>;
    const content = (body.messages as { content: unknown[] }[])[0]!.content;
    expect(content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
      { type: "text", text: "比较这两张图" },
    ]);
  });

  it("回归:无 images 时 user content 只有单个 text block", async () => {
    const { calls } = mockOkFetch();

    const messages: Message[] = [{ role: "user", content: "纯文本消息" }];

    const p = new ClaudeProvider(cfg);
    await p.generate(messages, []);

    const body = calls[0]!.body as Record<string, unknown>;
    const content = (body.messages as { content: unknown[] }[])[0]!.content;
    expect(content).toEqual([{ type: "text", text: "纯文本消息" }]);
  });

  it("image_url:抛错提示不支持,需用 base64", async () => {
    mockShouldNotFetch();

    const messages: Message[] = [
      {
        role: "user",
        content: "看这张",
        images: [{ type: "image_url", url: "https://example.com/x.png" }],
      },
    ];

    const p = new ClaudeProvider(cfg);
    await expect(p.generate(messages, [])).rejects.toThrow(/不支持 image_url/);
  });
});
