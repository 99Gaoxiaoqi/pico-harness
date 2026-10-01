import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@pico/core";
import { createProvider } from "@pico/pico-host/provider/factory";
import { fromAiSdkContent } from "@pico/pico-host/provider/ai-sdk-messages";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import { estimateMessagesTokens } from "@pico/runtime/context-budget";
import { FullCompactor } from "@pico/runtime/full-compactor";

const image = `data:image/png;base64,${Buffer.alloc(1_366_531).toString("base64")}`;
const video = `data:video/mp4;base64,${Buffer.alloc(3 * 1024 * 1024).toString("base64")}`;
const mediaText = `已生成。![图片](${image})\n[视频](${video})\n继续处理。`;
const summary =
  "## Goal\nContinue media task.\n## Progress\nImage and video created.\n## Next Steps\nContinue user's instructions.\n## Critical Context\nOriginal media remains in the session.";

function response(wire: "openai" | "claude" | "responses", content = "MEDIA_CONTEXT_OK") {
  const usage = { input_tokens: 20, output_tokens: 5, total_tokens: 25 };
  if (wire === "openai")
    return {
      id: "chat",
      model: "fixture",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    };
  if (wire === "claude")
    return {
      id: "msg",
      type: "message",
      role: "assistant",
      model: "fixture",
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      usage,
    };
  return {
    id: "resp",
    object: "response",
    created_at: 1,
    model: "fixture",
    status: "completed",
    usage,
    output: [
      {
        type: "message",
        id: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: content, annotations: [] }],
      },
    ],
  };
}

test("图片与视频历史使用有界文本请求，预检/诊断/压缩一致且原始重放数据不变", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const wire of ["openai", "claude", "responses"] as const) {
    const bodies: Record<string, unknown>[] = [];
    let summarizing = false;
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(response(wire, summarizing ? summary : undefined));
    };
    const provider = createProvider(wire, {
      model: wire === "claude" ? "claude-sonnet-4-5" : "fixture",
      apiKey: "test",
      baseURL: "https://fixture.invalid",
      thinkingEffort: "off",
      capabilities: resolveModelRouteCapabilities(wire, "fixture", {
        context: 128_000,
        output: 4096,
      }),
    });
    const saved = fromAiSdkContent([{ type: "text", text: mediaText }], wire);
    const messages: Message[] = [
      { role: "user", content: "生成图片和视频" },
      saved,
      { role: "user", content: "继续" },
    ];
    const original = structuredClone(messages);
    assert.ok(estimateMessagesTokens(messages) < 200, "诊断不计入媒体编码文本");
    const answer = await provider.generate(messages, []);
    assert.equal(answer.content, "MEDIA_CONTEXT_OK", "128K路由预检通过并发送");
    const body = JSON.stringify(bodies[0]);
    assert.ok(body.length < 4096, "实际wire请求有界");
    assert.ok(!body.includes("data:image/") && !body.includes("data:video/"));
    assert.match(body, /image data omitted: image\/png/u);
    assert.match(body, /video data omitted: video\/mp4/u);
    assert.match(body, /继续处理/u);
    assert.deepEqual(messages, original);
    await provider.generate(
      [
        { role: "user", content: mediaText },
        { role: "assistant", content: mediaText },
        { role: "user", content: "继续" },
      ],
      [],
    );
    assert.ok(JSON.stringify(bodies[1]).length < 4096, "无SDK重放缓存的路径同样投影");

    summarizing = true;
    const compactor = new FullCompactor({ provider, maxAttempts: 1 });
    const preview = await compactor.preview({ id: `media-${wire}` }, messages, {
      trigger: "manual",
      inputBudgetTokens: 120_000,
      targetRetainedTokens: 0,
      phase: "standalone",
    });
    assert.ok(preview?.summary.includes("Original media"));
    const compactBody = JSON.stringify(bodies.at(-1));
    assert.ok(!compactBody.includes("data:image/") && !compactBody.includes("data:video/"));
    assert.ok(compactBody.length < 20_000);
    assert.deepEqual(messages, original);

    const sent = bodies.length;
    await assert.rejects(
      provider.generate([{ role: "user", content: "普通正文".repeat(150_000) }], []),
      /请求前预检失败/u,
    );
    assert.equal(bodies.length, sent, "普通文本超限仍在发送前拦截");
  }
});
