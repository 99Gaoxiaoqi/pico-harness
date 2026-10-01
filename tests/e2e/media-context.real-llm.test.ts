import assert from "node:assert/strict";
import test from "node:test";
import { createProvider } from "@pico/pico-host/provider/factory";
import { fromAiSdkContent } from "@pico/pico-host/provider/ai-sdk-messages";
import { loadUserDefaultRealModel } from "./real-llm-user-model.js";

const realModelTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;

realModelTest(
  "大型图片和视频编码历史经过真实配置路由后仍可继续对话",
  { timeout: 90_000 },
  async (t) => {
    const model = await loadUserDefaultRealModel({
      ...(process.env.PICO_MEDIA_E2E_MODEL_ROUTE
        ? { modelRouteId: process.env.PICO_MEDIA_E2E_MODEL_ROUTE }
        : {}),
    });
    const content = `![generated image](data:image/png;base64,${Buffer.alloc(1_366_531).toString("base64")})\n[generated video](data:video/mp4;base64,${Buffer.alloc(3 * 1024 * 1024).toString("base64")})`;
    const media = fromAiSdkContent([{ type: "text", text: content }], model.provider);
    const original = structuredClone(media);
    const originalFetch = globalThis.fetch;
    let requestBytes: number | undefined;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    globalThis.fetch = async (input, init) => {
      if (typeof init?.body === "string") {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (Array.isArray(body.messages) || Array.isArray(body.input)) {
          assert.ok(!init.body.includes("data:image/") && !init.body.includes("data:video/"));
          requestBytes = Buffer.byteLength(init.body);
          assert.ok(requestBytes < 16_000, "实际请求没有携带媒体编码文本");
        }
      }
      return originalFetch(input, init);
    };
    const provider = createProvider(model.provider, model.config);
    const answer = await provider.generate(
      [
        {
          role: "user",
          content: "Earlier we generated media. This is a continuation connectivity check.",
        },
        media,
        {
          role: "user",
          content: "Do not generate or describe media. Reply exactly MEDIA_CONTEXT_OK.",
        },
      ],
      [],
      { signal: AbortSignal.timeout(60_000), maxOutputTokens: 128 },
    );
    assert.match(answer.content, /MEDIA_CONTEXT_OK/u);
    assert.deepEqual(media, original);
    assert.ok(requestBytes !== undefined, "已检查真实出站请求");
    if (answer.usage) assert.ok(answer.usage.promptTokens < 128_000, "报告输入未溢出上下文");
    console.log(
      JSON.stringify({
        route: model.route.id,
        requestBytes,
        promptTokens: answer.usage?.promptTokens ?? null,
        completionTokens: answer.usage?.completionTokens ?? null,
        result: "MEDIA_CONTEXT_OK",
      }),
    );
  },
);
