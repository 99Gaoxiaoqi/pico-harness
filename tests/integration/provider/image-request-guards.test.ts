import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import type { ImagePart, Message, ProviderProtocol } from "@pico/core";
import { createProvider } from "@pico/pico-host/provider/factory";
import { Session } from "@pico/pico-host/session";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { buildDefaultToolRegistry } from "@pico/pico-host/default-registry";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import { SqliteSessionWorkbarRepository } from "@pico/storage";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1kAAAAASUVORK5CYII=",
  "base64",
);
const wires = ["openai", "responses", "claude"] as const;
type ArtifactImage = Extract<ImagePart, { type: "image_artifact" }>;
const imageRef = (artifactId: string, bytes: Buffer): ArtifactImage => ({
  type: "image_artifact",
  artifactId,
  mimeType: "image/png",
  sizeBytes: bytes.length,
  digest: createHash("sha256").update(bytes).digest("hex"),
});
function makeProvider(
  wire: ProviderProtocol,
  readImageArtifact: (image: ArtifactImage) => string | undefined,
  vision = true,
) {
  return createProvider(
    wire,
    {
      model: "fixture",
      apiKey: "test",
      baseURL: "https://fixture.invalid",
      thinkingEffort: "off",
      capabilities: resolveModelRouteCapabilities(wire, "fixture", {
        vision,
        context: 128_000,
        output: 1024,
      }),
    },
    undefined,
    { readImageArtifact },
  );
}
function reply(wire: ProviderProtocol): Response {
  if (wire === "claude")
    return Response.json({
      id: "msg",
      type: "message",
      role: "assistant",
      model: "fixture",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    });
  if (wire === "responses")
    return Response.json({
      id: "resp",
      object: "response",
      created_at: 0,
      model: "fixture",
      output: [
        {
          type: "message",
          id: "msg",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "OK", annotations: [] }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      status: "completed",
      error: null,
      incomplete_details: null,
    });
  return Response.json({
    id: "fixture",
    model: "fixture",
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  });
}

test("三协议的隐藏提醒与引导不解除本轮图片保护，普通新文字消息可切换非视觉模型", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const bytes = new Map<string, Buffer>();
  for (const [id, mib] of [
    ["A", 6],
    ["B", 6],
    ["page", 1],
  ] as const) {
    const value = Buffer.alloc(mib * 1024 * 1024);
    png.copy(value);
    bytes.set(id, value);
  }
  const history: Message[] = [
    {
      role: "user",
      content: "Compare my two images",
      images: [imageRef("A", bytes.get("A")!), imageRef("B", bytes.get("B")!)],
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
      images: [imageRef("page", bytes.get("page")!)],
    },
  ];
  const controls: Message[] = [
    ...["system_reminder", "continuation", "plan_continuation", "grace", "steer"].map(
      (picoKind) => ({
        role: "user" as const,
        content: "Continue the current task",
        providerData: { picoKind, picoHiddenFromTranscript: true },
      }),
    ),
    { role: "user", content: "Keep comparing those images", providerData: { picoKind: "steer" } },
  ];
  for (const wire of wires) {
    let fetches = 0,
      attempts = 0;
    globalThis.fetch = async () => {
      fetches++;
      return reply(wire);
    };
    const reader = (image: ArtifactImage) => bytes.get(image.artifactId)?.toString("base64");
    const provider = makeProvider(wire, reader);
    for (const control of controls) {
      await assert.rejects(
        provider.generate([...history, control], [], {
          onProviderAttemptStart: async () => {
            attempts++;
          },
        }),
        /artifact_id=page.*12 MiB/u,
      );
      await assert.rejects(
        makeProvider(wire, reader, false).generate([...history, control], []),
        /不支持图像输入/u,
      );
    }
    assert.equal(fetches, 0, "本地失败不得发起网络请求");
    assert.equal(attempts, 0, "本地失败不得创建计费尝试");
    assert.equal(
      (
        await makeProvider(wire, reader, false).generate(
          [...history, ...controls, { role: "user", content: "New text-only question" }],
          [],
        )
      ).content,
      "OK",
    );
    assert.equal(fetches, 1);
  }
});

test("真实会话重复查看约9MiB图片：三协议只发送一次图片，保留归属且拒绝伪造引用", async (t) => {
  const originalFetch = globalThis.fetch;
  const root = await mkdtemp(join(tmpdir(), "pico-image-dedup-"));
  const session = new Session("image-dedup", root, {
    persistence: true,
    picoHome: join(root, "home"),
    runtimePort: createEngineRuntimePort(),
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const canvas = createCanvas(1536, 1536);
  const context = canvas.getContext("2d");
  const pixels = context.createImageData(1536, 1536);
  // Deterministic incompressible content: a valid image below both upload and resize limits.
  let state = 123456789;
  for (let i = 0; i < pixels.data.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels.data[i] = state & 255;
  }
  context.putImageData(pixels, 0, 0);
  const bytes = await canvas.encode("png");
  canvas.width = canvas.height = 0;
  assert.ok(bytes.length > 6 * 1024 * 1024 && bytes.length < 10 * 1024 * 1024);
  const repository = new SqliteSessionWorkbarRepository({
    storageRoot: session.runtimeStorageRoot,
  });
  repository.publishArtifactSnapshot({
    sessionId: session.id,
    artifactId: "large-image",
    title: "large.png",
    mimeType: "image/png",
    content: bytes,
  });
  const reference = imageRef("large-image", bytes);
  await session.commitMessages({
    role: "user",
    content: "Please look again at my image",
    images: [reference],
  });
  const call = {
    id: "view",
    name: "view_image",
    arguments: JSON.stringify({ artifact_id: reference.artifactId }),
  };
  const run = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  await run.commitMessages(session, [{ role: "assistant", content: "", toolCalls: [call] }]);
  await run.recordToolStarted(call.id, call.name, call.arguments);
  const registry = buildDefaultToolRegistry(root, {
    sessionArtifacts: { repository, sessionId: session.id },
  });
  const viewed = await registry.execute(call);
  assert.equal(viewed.isError, false, viewed.output);
  const observation = run.registerToolResult({
    toolCallId: call.id,
    toolName: call.name,
    status: "succeeded",
    body: {
      storage: "inline",
      content: viewed.output,
      sizeBytes: Buffer.byteLength(viewed.output),
      sha256: createHash("sha256").update(viewed.output).digest("hex"),
    },
    projection: {
      version: 1,
      mode: "full",
      text: viewed.output,
      strategy: "full",
      truncated: false,
    },
  });
  await run.commitMessages(session, [observation]);
  const history = session.getModelContext();
  assert.equal(history.at(-1)!.images?.[0]?.type, "image_artifact");
  const canonical = JSON.stringify(session.getHistory());
  for (const wire of wires) {
    let body = "",
      reads = 0,
      requests = 0;
    globalThis.fetch = async (_url, init) => {
      requests++;
      body = String(init?.body);
      return reply(wire);
    };
    const provider = makeProvider(wire, (ref) => {
      reads++;
      return session.readMediaArtifact(ref);
    });
    assert.equal((await provider.generate(history, [])).content, "OK");
    assert.equal(
      body.split(bytes.toString("base64")).length - 1,
      1,
      "去重实际图片字节，不只是预算计数",
    );
    assert.match(body, /Image reference: artifact_id=large-image/u, "重复工具结果仍保留图片归属");
    assert.equal(reads, 1, "相同不可变引用只读取解码一次");
    const tampered = history.map((message) =>
      message.toolCallId
        ? { ...message, images: [{ ...reference, digest: "0".repeat(64) }] }
        : message,
    );
    await assert.rejects(provider.generate(tampered, []), /附件已失效或无法读取/u);
    assert.equal(requests, 1, "伪造元数据不得复用已验证图片或发请求");
  }
  assert.equal(JSON.stringify(session.getHistory()), canonical, "请求投影不修改持久消息");
  assert.equal(session.readMediaArtifact(reference), bytes.toString("base64"), "原图保留");
});
