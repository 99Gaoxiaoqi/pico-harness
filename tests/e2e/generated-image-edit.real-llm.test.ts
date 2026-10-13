import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { createProvider } from "@pico/pico-host/provider/factory";
import { loadUserDefaultRealModel } from "./real-llm-user-model.js";

const enabled = process.env.RUN_LLM_E2E === "1" && !!process.env.PICO_IMAGE_EDIT_FIXTURE;
(enabled ? test : test.skip)(
  "真实改图请求发送历史生成图并持久保存返回图片",
  { timeout: 150_000 },
  async (t) => {
    const bytes = await readFile(process.env.PICO_IMAGE_EDIT_FIXTURE!);
    const original = bytes.toString("base64");
    const model = await loadUserDefaultRealModel({
      modelRouteId: process.env.PICO_MEDIA_E2E_MODEL_ROUTE ?? "codex-oauth/gpt-5.6-luna-fast",
    });
    const root = await mkdtemp(join(tmpdir(), "pico-image-edit-e2e-"));
    const session = new Session("image-edit", root, {
      persistence: true,
      picoHome: join(root, "home"),
      runtimePort: createEngineRuntimePort(),
    });
    const originalFetch = globalThis.fetch;
    t.after(async () => {
      globalThis.fetch = originalFetch;
      await session.close();
      await rm(root, { recursive: true, force: true });
    });
    await session.recover();
    await session.commitMessages({
      role: "assistant",
      content: `![generated image](data:image/png;base64,${original})`,
    });
    await session.commitMessages({
      role: "user",
      content:
        "请实际编辑上一张参考图片：只把橙红色花朵改成黄色向日葵，保留蓝色机器人跪着拿铲子种花的姿势、月球地面、地球的位置、正方形尺寸和原有插画画风。直接展示改后的图片。",
    });
    let imageOnWire = false;
    globalThis.fetch = async (input, init) => {
      if (typeof init?.body === "string") imageOnWire ||= init.body.includes(original);
      return originalFetch(input, init);
    };
    const provider = createProvider(model.provider, model.config, undefined, {
      readImageArtifact: (image) => session.readMediaArtifact(image),
    });
    const response = await provider.generate(session.getModelContext(), [], {
      signal: AbortSignal.timeout(120_000),
    });
    assert.ok(imageOnWire, "必须在真实出站请求中发送原图字节");
    await session.commitMessages(response);
    const result = session.getModelContext().at(-1)!;
    const generated = result.images?.find((image) => image.type === "image_artifact");
    assert.ok(generated?.type === "image_artifact", "服务必须实际返回可持久化图片");
    assert.notEqual(
      generated.digest,
      session.getModelContext()[0]!.images![0]!.type === "image_artifact"
        ? (session.getModelContext()[0]!.images![0] as { digest: string }).digest
        : "",
    );
    const data = session.readMediaArtifact(generated);
    assert.ok(data);
    if (process.env.PICO_IMAGE_EDIT_OUTPUT)
      await writeFile(process.env.PICO_IMAGE_EDIT_OUTPUT, Buffer.from(data, "base64"));
    console.log(
      JSON.stringify({
        route: model.route.id,
        imageOnWire,
        mimeType: generated.mimeType,
        sizeBytes: generated.sizeBytes,
      }),
    );
  },
);
