import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ImagePart } from "@pico/core";
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
  const history = session.getModelContext();
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
    assert.equal((await provider.generate(history, [])).content, "MEDIA_OK");
    if (!vision) {
      assert.equal(reads, 0);
      assert.ok(!bodies.at(-1)!.includes(png.toString("base64")));
    } else {
      assert.ok(reads > 0);
      assert.ok(bodies.at(-1)!.includes(png.toString("base64")));
      assert.ok(
        bodies.at(-1)!.includes(largePng.toString("base64")),
        "explicit image above UI preview limit is materialized on wire",
      );
    }
  }
  let budgetReads = 0;
  const budgetImage = { ...artifact, sizeBytes: 2 * 1024 * 1024 };
  const projected = toAiSdkMessages(
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
        return png.toString("base64");
      },
    },
  );
  assert.equal(budgetReads, 6, "12MiB budget is checked before any artifact byte read");
  assert.match(JSON.stringify(projected), /request image budget exceeded/u);
  assert.ok(
    !JSON.stringify(history).includes(png.toString("base64")),
    "request hydration never mutates durable history",
  );
});
