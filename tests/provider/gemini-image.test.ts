// GeminiProvider 图片多模态翻译单测 (5.5d)。
// 验证 buildRequestBody 把 user 消息的 images 翻译成 Gemini inlineData part:
// - image_base64 → {inlineData:{mimeType,data}} part
// - 多张图片 → 多个 inlineData part,顺序在 text part 之前
// - 无 images → 回归为只有 text part
// - image_url → 抛错(Gemini inlineData 不支持)
// 不依赖真实 API key。

import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "../../src/provider/gemini.js";
import type { Message } from "../../src/schema/message.js";

const cfg = {
  baseURL: "https://generativelanguage.googleapis.com",
  apiKey: "AIza-test-key",
  model: "gemini-2.0-flash",
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Mock fetch 返回 JSON body(非流式),记录 body 供断言。 */
function mockJsonFetch(json: unknown): { calls: { body: unknown }[] } {
  const calls: { body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    calls.push({ body: init?.body ? JSON.parse(init.body as string) : null });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
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

/** 从请求体里取出 contents。 */
function getContents(body: unknown): { role: string; parts: unknown[] }[] {
  return (body as Record<string, unknown>).contents as { role: string; parts: unknown[] }[];
}

describe("GeminiProvider 图片多模态翻译 (5.5d)", () => {
  it("image_base64 → inlineData part,顺序:image 在前,text 在后", async () => {
    const { calls } = mockJsonFetch({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    });

    const msg: Message = {
      role: "user",
      content: "这张图是什么?",
      images: [{ type: "image_base64", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" }],
    };
    const p = new GeminiProvider(cfg);
    await p.generate([msg], []);

    const contents = getContents(calls[0]!.body);
    expect(contents[0]!.role).toBe("user");
    expect(contents[0]!.parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" } },
      { text: "这张图是什么?" },
    ]);
  });

  it("多张图片 → 多个 inlineData part,全部在 text part 之前", async () => {
    const { calls } = mockJsonFetch({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    });

    const msg: Message = {
      role: "user",
      content: "对比这两张图",
      images: [
        { type: "image_base64", mimeType: "image/png", data: "AAAA" },
        { type: "image_base64", mimeType: "image/jpeg", data: "BBBB" },
      ],
    };
    const p = new GeminiProvider(cfg);
    await p.generate([msg], []);

    const contents = getContents(calls[0]!.body);
    expect(contents[0]!.parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "AAAA" } },
      { inlineData: { mimeType: "image/jpeg", data: "BBBB" } },
      { text: "对比这两张图" },
    ]);
  });

  it("无 images → 回归为只有 text part", async () => {
    const { calls } = mockJsonFetch({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    });

    const msg: Message = { role: "user", content: "你好" };
    const p = new GeminiProvider(cfg);
    await p.generate([msg], []);

    const contents = getContents(calls[0]!.body);
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "你好" }] });
  });

  it("image_url → 抛错(Gemini inlineData 不支持)", async () => {
    mockJsonFetch({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    });

    const msg: Message = {
      role: "user",
      content: "看这张图",
      images: [{ type: "image_url", url: "https://example.com/a.png" }],
    };
    const p = new GeminiProvider(cfg);
    await expect(p.generate([msg], [])).rejects.toThrow(/image_url/);
  });
});
