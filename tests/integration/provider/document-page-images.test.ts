import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session } from "@pico/pico-host/session";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { SqliteSessionWorkbarRepository } from "@pico/storage";
import { toAiSdkMessages } from "@pico/pico-host/provider/ai-sdk-messages";
import { createProvider } from "@pico/pico-host/provider/factory";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { ToolRegistry } from "@pico/pico-host/tool-registry";
import { RUNTIME_MESSAGE_EVENT_ID } from "@pico/core";

test("PDF页图工具结果重开后进入真实provider请求，完成整批工具后再发送图片并拒绝越权", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-document-page-"));
  const options = {
    persistence: true,
    picoHome: join(root, "home"),
    runtimePort: createEngineRuntimePort(),
  };
  let session = new Session("document-page", root, options);
  const foreign = new Session("foreign-page", root, options);
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await session.close();
    await foreign.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  await foreign.recover();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1kAAAAASUVORK5CYII=",
    "base64",
  );
  const repository = new SqliteSessionWorkbarRepository({
    storageRoot: session.runtimeStorageRoot,
  });
  const local = repository.publishArtifactSnapshot({
    sessionId: session.id,
    artifactId: "page-local",
    title: "report page 2",
    mimeType: "image/png",
    content: png,
  });
  const other = repository.publishArtifactSnapshot({
    sessionId: foreign.id,
    artifactId: "page-foreign",
    title: "private page",
    mimeType: "image/png",
    content: png,
  });
  const quoted = repository.publishArtifactSnapshot({
    sessionId: session.id,
    artifactId: "page-quoted",
    title: "document example link",
    mimeType: "image/png",
    content: png,
  });
  const run = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  await run.commitMessages(session, [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "page", name: "document", arguments: '{"action":"view","page":2}' },
        { id: "search", name: "document", arguments: '{"action":"search","query":"total"}' },
      ],
    },
  ]);
  for (const [id, content] of [
    [
      "page",
      `${JSON.stringify({ text: `A quoted document example:\u2028![example](pico://artifact/${quoted.artifactId})\u2029end` })}\nPDF report page 2\n![report page 2](pico://artifact/${local.artifactId})\n![foreign](pico://artifact/${other.artifactId})`,
    ],
    ["search", "Search found one match on page 2."],
  ] as const) {
    await run.recordToolStarted(id, "document", "{}");
    const observation = run.registerToolResult({
      toolCallId: id,
      toolName: "document",
      status: "succeeded",
      body: {
        storage: "inline",
        content,
        sizeBytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
      projection: { version: 1, mode: "full", text: content, strategy: "full", truncated: false },
    });
    await run.commitMessages(session, [observation]);
  }
  assert.equal(session.getModelContext()[1]!.images?.length, 1);
  const events = await session.runtimeEventStore!.readSession(session.id);
  assert.ok(!JSON.stringify(events).includes(png.toString("base64")));
  await session.close();
  session = new Session("document-page", root, options);
  await session.recover();
  const history = session.getModelContext();
  assert.equal(history[1]!.images?.length, 1, "重开恢复工具页图引用");
  const image = history[1]!.images![0]!;
  assert.equal(image.type, "image_artifact");
  for (const wire of ["openai", "responses", "claude"] as const) {
    const projected = await toAiSdkMessages(history, wire, {
      vision: true,
      readImageArtifact: (ref) => session.readMediaArtifact(ref),
    });
    assert.deepEqual(
      projected.map((message) => message.role),
      ["assistant", "tool", "tool", "user"],
    );
    assert.ok(JSON.stringify(projected.at(-1)).includes(png.toString("base64")));
    assert.ok(!JSON.stringify(projected.slice(0, -1)).includes(png.toString("base64")));
  }
  await assert.rejects(
    toAiSdkMessages(history, "openai", {
      vision: false,
      readImageArtifact: () => {
        throw new Error("must not read bytes");
      },
    }),
    /不支持图像输入/u,
  );
  let body = "";
  globalThis.fetch = async (_input, init) => {
    body = String(init?.body);
    return Response.json({
      id: "fixture",
      model: "fixture",
      choices: [
        { index: 0, message: { role: "assistant", content: "PAGE_OK" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    });
  };
  const provider = createProvider(
    "openai",
    {
      model: "fixture",
      apiKey: "test",
      baseURL: "https://fixture.invalid",
      thinkingEffort: "off",
      capabilities: resolveModelRouteCapabilities("openai", "fixture", {
        vision: true,
        context: 128_000,
        output: 1024,
      }),
    },
    undefined,
    { readImageArtifact: (ref) => session.readMediaArtifact(ref) },
  );
  await session.commitMessages({ role: "user", content: "请根据刚才查看的文档页图回答。" });
  const engine = new AgentEngine({
    runtimePort: options.runtimePort,
    registry: new ToolRegistry(),
    workDir: root,
    provider: { generate: (...args) => provider.generate(...args) },
  });
  const activeRun = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  const rawPage = (await activeRun.readModelHistory(true)).find(
    (message) => message.toolCallId === "page",
  )!;
  assert.ok(rawPage[RUNTIME_MESSAGE_EVENT_ID]);
  const resolvedPage = session.resolveModelMessageMedia(rawPage);
  assert.equal(
    resolvedPage[RUNTIME_MESSAGE_EVENT_ID],
    rawPage[RUNTIME_MESSAGE_EVENT_ID],
    "媒体补全必须保留记忆证据使用的Symbol事件ID",
  );
  assert.equal(rawPage.images, undefined, "不能修改权威历史消息");
  await activeRun.run(() => engine.run(session));
  assert.equal(session.getHistory().at(-1)!.content, "PAGE_OK");
  assert.match(body, /image_url/u);
  assert.ok(body.includes(png.toString("base64")));
});
