import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ImagePart } from "@pico/core";
import { parseConversation } from "../../../apps/desktop/src/renderer/conversation/runtime-projection.js";
import { Session } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { createProvider } from "@pico/pico-host/provider/factory";
import { fromAiSdkContent, toAiSdkMessages } from "@pico/pico-host/provider/ai-sdk-messages";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import { SqliteSessionWorkbarRepository } from "@pico/storage";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1kAAAAASUVORK5CYII=",
  "base64",
);
const mp4 = Buffer.from("000000186674797069736f6d0000000069736f6d6d703432000000086d646174", "hex");

test("媒体消息仅持久引用，重开后真实请求按视觉能力/预算读取且拒绝跨会话与伪造digest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-media-references-"));
  const options = {
    persistence: true,
    picoHome: join(root, "home"),
    runtimePort: createEngineRuntimePort(),
  };
  let session = new Session("media-source", root, options);
  const other = new Session("media-other", root, options);
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await other.close();
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  await other.recover();
  await session.commitMessageOnce("user-image", {
    role: "user",
    content: "查看图片",
    images: [{ type: "image_base64", mimeType: "image/png", data: png.toString("base64") }],
  });
  const signature = { anthropic: { signature: "authentic-signed-thinking" } };
  const assistant = fromAiSdkContent(
    [
      { type: "reasoning", text: "private thought", providerMetadata: signature },
      {
        type: "text",
        text: `![图片](data:image/png;base64,${png.toString("base64")})\n[视频](data:video/mp4;base64,${mp4.toString("base64")})`,
      },
      { type: "file", file: { base64: png.toString("base64"), mediaType: "image/png" } },
    ],
    "openai",
  );
  await session.commitMessageOnce("assistant-image", assistant);
  const events = await session.runtimeEventStore!.readSession(session.id);
  const durable = JSON.stringify(events);
  assert.ok(
    !durable.includes(png.toString("base64")) && !durable.includes(mp4.toString("base64")),
    "canonical messages omit binary encodings, including SDK replay/projection",
  );
  assert.match(durable, /image_artifact/u);
  assert.match(durable, /pico:\/\/artifact/u);
  assert.match(durable, /authentic-signed-thinking/u);
  const artifact = session.getModelContext()[0]!.images![0] as Extract<
    ImagePart,
    { type: "image_artifact" }
  >;
  assert.equal(session.readMediaArtifact(artifact), png.toString("base64"));
  assert.equal(other.readMediaArtifact(artifact), undefined);
  assert.equal(session.readMediaArtifact({ ...artifact, digest: "0".repeat(64) }), undefined);
  const once = await session.commitMessageOnce("user-image", {
    role: "user",
    content: "查看图片",
    images: [{ type: "image_base64", mimeType: "image/png", data: png.toString("base64") }],
  });
  assert.equal(once.inserted, false);
  const largePng = Buffer.alloc(2 * 1024 * 1024 + 1);
  png.copy(largePng);
  const generated = fromAiSdkContent(
    [
      {
        type: "text",
        text: `![generated image 1](data:image/png;base64,${largePng.toString("base64")})`,
      },
    ],
    "openai",
  );
  await session.commitMessageOnce("large-generated-image", generated);
  const generatedEvent = await session.runtimeEventStore!.readSessionEvent(
    session.id,
    "large-generated-image",
  );
  assert.equal(generatedEvent?.event.kind, "message.committed");
  if (generatedEvent?.event.kind === "message.committed") {
    const saved = generatedEvent.event.data.message;
    assert.match(saved.content, /pico:\/\/artifact\//u, "生成图片超过2MiB仍保存为可预览引用");
    assert.equal(saved.images, undefined, "展示用图片不自动成为模型视觉输入");
    assert.ok(JSON.stringify(saved).length < 4096, "生成图片没有在正文或SDK副本保存编码");
    const refs = saved.providerData?.["picoMedia"] as { artifactId: string; sizeBytes: number }[];
    assert.equal(refs[0]!.sizeBytes, largePng.length);
    const ref = refs[0]!;
    assert.ok(ref.artifactId);
  }
  await session.commitMessageOnce("large-explicit-image", {
    role: "user",
    content: "查看超过预览上限的显式图片",
    images: [{ type: "image_base64", mimeType: "image/png", data: largePng.toString("base64") }],
  });
  const largeImage = session.getModelContext().at(-1)!.images![0] as typeof artifact;
  assert.equal(largeImage.type, "image_artifact");
  assert.equal(largeImage.sizeBytes, largePng.length);
  assert.equal(session.readMediaArtifact(largeImage), largePng.toString("base64"));
  const largeEvent = await session.runtimeEventStore!.readSessionEvent(
    session.id,
    "large-explicit-image",
  );
  assert.ok(
    JSON.stringify(largeEvent).length < 4096,
    "2–10MiB attachment remains a compact durable reference",
  );
  await session.close();
  session = new Session("media-source", root, options);
  await session.recover();
  const page = await session.runtimeEventStore!.readTranscriptProjectionPage({
    sessionId: session.id,
    maxBytes: 1024 * 1024,
  });
  const projectedGenerated = page.items.find((item) =>
    JSON.stringify(item.payload).includes("generated image 1"),
  )!.payload;
  const conversation = parseConversation({ items: [projectedGenerated] }, root, session.id);
  assert.equal(conversation.items.length, 1, "重开后大图仍投影到桌面消息");
  const item = conversation.items[0]!;
  assert.ok(item.kind === "assistantMessage");
  assert.equal(item.media?.[0]?.sizeBytes, largePng.length, "桌面未过滤2–10MiB生成图片");
  const history = session.getModelContext();
  const generatedHistory = history.find((message) =>
    message.content.includes("generated image 1"),
  )!;
  assert.equal(
    generatedHistory.images?.[0]?.type,
    "image_artifact",
    "生成图在重开后的模型上下文恢复成参考图",
  );
  const generatedRequest = await toAiSdkMessages(
    [generatedHistory, { role: "user", content: "Edit the previous image" }],
    "openai",
    { vision: true, readImageArtifact: (image) => session.readMediaArtifact(image) },
  );
  const referenceTurn = generatedRequest.find((message) => message.role === "user")!;
  assert.ok(
    JSON.stringify(referenceTurn).includes(largePng.toString("base64")),
    "参考图必须出现在模型支持的user图片输入中",
  );
  assert.ok(
    !JSON.stringify(generatedRequest[0]).includes(largePng.toString("base64")),
    "不把图片放进会被Chat Completions丢弃的assistant文件字段",
  );

  assert.equal(
    session.readMediaArtifact(history[0]!.images![0] as typeof artifact),
    png.toString("base64"),
  );
  const bytesReader = SqliteSessionWorkbarRepository.prototype.readArtifactChunk;
  let reads = 0;
  SqliteSessionWorkbarRepository.prototype.readArtifactChunk = function (input) {
    reads++;
    return bytesReader.call(this, input);
  };
  t.after(() => {
    SqliteSessionWorkbarRepository.prototype.readArtifactChunk = bytesReader;
  });
  const bodies: string[] = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(String(init?.body));
    return Response.json({
      id: "fixture",
      model: "fixture",
      choices: [
        { index: 0, message: { role: "assistant", content: "MEDIA_OK" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    });
  };
  for (const vision of [false, true, "unknown"] as const) {
    const provider = createProvider(
      "openai",
      {
        model: "fixture",
        apiKey: "test",
        baseURL: "https://fixture.invalid",
        thinkingEffort: "off",
        capabilities: resolveModelRouteCapabilities("openai", "fixture", {
          ...(typeof vision === "boolean" ? { vision } : {}),
          context: 128_000,
          output: 1024,
        }),
      },
      undefined,
      { readImageArtifact: (image) => session.readMediaArtifact(image) },
    );
    if (vision === false) {
      await assert.rejects(provider.generate(history, []), /不支持图像输入/u);
      assert.equal(reads, 0);
      assert.equal(bodies.length, 0, "当前上传图片不会被静默丢弃后发送请求");
      assert.equal(
        (await provider.generate([...history, { role: "user", content: "只回答文字" }], []))
          .content,
        "MEDIA_OK",
      );
      assert.ok(!bodies.at(-1)!.includes(png.toString("base64")), "历史图片不阻止新文字对话");
    } else {
      assert.equal((await provider.generate(history, [])).content, "MEDIA_OK");
      assert.ok(reads > 0);
      assert.ok(bodies.at(-1)!.includes(png.toString("base64")));
      assert.ok(bodies.at(-1)!.includes(largePng.toString("base64")), "大附件仍发送完整小尺寸原图");
    }
  }

  const newestDigest = "e".repeat(64);
  const paddedPng = Buffer.alloc(2 * 1024 * 1024);
  png.copy(paddedPng);
  const selectionReads: string[] = [];
  const crowded = await toAiSdkMessages(
    [
      {
        role: "assistant",
        content: "earlier generated pictures",
        images: Array.from({ length: 6 }, (_, index) => ({
          ...artifact,
          artifactId: `old:${index}`,
          sizeBytes: 2 * 1024 * 1024,
        })),
      },
      {
        role: "user",
        content: "Inspect this new upload",
        images: [
          { ...artifact, artifactId: "newest", digest: newestDigest, sizeBytes: 2 * 1024 * 1024 },
        ],
      },
    ],
    "openai",
    {
      vision: true,
      readImageArtifact: (image) => {
        selectionReads.push(image.artifactId);
        return paddedPng.toString("base64");
      },
    },
  );
  assert.equal(selectionReads[0], "newest", "优先读取本轮图片");
  assert.equal(selectionReads.length, 6);
  assert.match(JSON.stringify(crowded), /artifact_id=old:0;.*request image budget exceeded/u);
  let budgetReads = 0;
  const budgetImage = { ...artifact, sizeBytes: 2 * 1024 * 1024 };
  await assert.rejects(
    toAiSdkMessages(
      [
        {
          role: "user",
          content: "many images",
          images: Array.from({ length: 8 }, () => budgetImage),
        },
      ],
      "openai",
      {
        vision: true,
        readImageArtifact: () => {
          budgetReads++;
          return paddedPng.toString("base64");
        },
      },
    ),
    /图片未发送.*12 MiB/u,
  );
  assert.equal(budgetReads, 6, "预算耗尽后不再读取其他图片");
  // Regression: tool images arriving later cannot silently evict current user evidence.
  const sixMiB = Buffer.alloc(6 * 1024 * 1024);
  png.copy(sixMiB);
  for (const wire of ["openai", "responses", "claude"] as const) {
    const seen: string[] = [];
    await assert.rejects(
      toAiSdkMessages(
        [
          {
            role: "user",
            content: "compare",
            images: [
              { ...artifact, artifactId: "A", sizeBytes: sixMiB.length },
              { ...artifact, artifactId: "B", sizeBytes: sixMiB.length },
            ],
          },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "page", name: "document", arguments: "{}" }],
          },
          {
            role: "user",
            toolCallId: "page",
            content: "page",
            images: [{ ...artifact, artifactId: "page" }],
          },
        ],
        wire,
        {
          vision: true,
          readImageArtifact: (ref) => {
            seen.push(ref.artifactId);
            return sixMiB.toString("base64");
          },
        },
      ),
      /artifact_id=page.*12 MiB/u,
    );
    assert.deepEqual(seen, ["A", "B"], "保留用户两张原图；工具图装不下时明确失败");
  }
  assert.ok(
    !JSON.stringify(history).includes(png.toString("base64")),
    "request hydration never mutates durable history",
  );
});
