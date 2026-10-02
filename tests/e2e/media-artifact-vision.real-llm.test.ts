import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { createProvider } from "@pico/pico-host/provider/factory";
import { loadUserDefaultRealModel } from "./real-llm-user-model.js";

const realModelTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;
const redPng =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";

realModelTest(
  "重开后的Artifact图片引用在真实视觉请求中还原并识别颜色",
  { timeout: 90_000 },
  async (t) => {
    const model = await loadUserDefaultRealModel({
      ...(process.env.PICO_MEDIA_E2E_MODEL_ROUTE
        ? { modelRouteId: process.env.PICO_MEDIA_E2E_MODEL_ROUTE }
        : {}),
    });
    assert.equal(model.config.capabilities?.vision, true, "此验收要求用户配置已声明vision的路线");
    const root = await mkdtemp(join(tmpdir(), "pico-artifact-vision-e2e-"));
    const options = {
      persistence: true,
      picoHome: join(root, "home"),
      runtimePort: createEngineRuntimePort(),
    };
    let session = new Session("artifact-vision", root, options);
    const originalFetch = globalThis.fetch;
    t.after(async () => {
      globalThis.fetch = originalFetch;
      await session.close();
      await rm(root, { recursive: true, force: true });
    });
    await session.recover();
    await session.commitMessages({
      role: "user",
      content: "What is the dominant color of this image? Reply with just the English color name.",
      images: [{ type: "image_base64", mimeType: "image/png", data: redPng }],
    });
    const canonical = JSON.stringify(await session.runtimeEventStore!.readSession(session.id));
    assert.ok(!canonical.includes(redPng), "持久事件仅保留artifact引用");
    await session.close();
    session = new Session("artifact-vision", root, options);
    await session.recover();
    let imageOnWire = false;
    globalThis.fetch = async (input, init) => {
      if (
        typeof init?.body === "string" &&
        (init.body.includes('"messages"') || init.body.includes('"input"'))
      ) {
        imageOnWire ||= init.body.includes(redPng);
        assert.ok(!init.body.includes("pico://artifact/"), "内部引用应在发送前完全物化");
      }
      return originalFetch(input, init);
    };
    const provider = createProvider(model.provider, model.config, undefined, {
      readImageArtifact: (image) => session.readMediaArtifact(image),
    });
    const answer = await provider.generate(session.getModelContext(), [], {
      signal: AbortSignal.timeout(60_000),
      maxOutputTokens: 128,
    });
    assert.match(answer.content, /\bred\b/iu);
    assert.ok(imageOnWire, "已核对实际出站请求图片字节");
    assert.ok(
      !JSON.stringify(session.getModelContext()).includes(redPng),
      "模型请求不污染会话历史",
    );
    console.log(
      JSON.stringify({ route: model.route.id, imageOnWire, result: answer.content.trim() }),
    );
  },
);
