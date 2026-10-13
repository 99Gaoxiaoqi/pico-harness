import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KNOWN_TOOL_NAMES } from "@pico/core/known-tool-names";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { buildDefaultToolRegistry } from "@pico/pico-host/default-registry";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { createProvider } from "@pico/pico-host/provider/factory";
import { Session } from "@pico/pico-host/session";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import { findGroupForTool, isPlanModeTool } from "@pico/runtime/tool-surface";
import { SqliteSessionWorkbarRepository } from "@pico/storage";
import { isResearchToolAllowed } from "../../../packages/pico-host/src/research-mode.js";
import {
  readSessionInputArtifact,
  resolveSessionInputAttachments,
} from "../../../packages/pico-host/src/session-input-attachments.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1kAAAAASUVORK5CYII=",
  "base64",
);

async function fixture(t: test.TestContext, suffix = "") {
  const root = await mkdtemp(join(tmpdir(), "pico-view-image-"));
  const runtimePort = createEngineRuntimePort();
  const options = { persistence: true, picoHome: join(root, "home"), runtimePort };
  const session = new Session(`image-source${suffix}`, root, options);
  const other = new Session(`image-other${suffix}`, root, options);
  t.after(async () => {
    await session.close();
    await other.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  await other.recover();
  const repository = new SqliteSessionWorkbarRepository({
    storageRoot: session.runtimeStorageRoot,
  });
  const authority = { repository, sessionId: session.id };
  const registry = buildDefaultToolRegistry(root, { sessionArtifacts: authority });
  const publish = (artifactId: string, mimeType: string, content: Buffer, sessionId = session.id) =>
    repository.publishArtifactSnapshot({
      sessionId,
      artifactId,
      title: "图片资料",
      mimeType,
      content,
    });
  const call = (artifactId: string) =>
    registry.execute({
      id: "view-image",
      name: "view_image",
      arguments: JSON.stringify({ artifact_id: artifactId }),
    });
  return { root, runtimePort, session, other, repository, authority, registry, publish, call };
}

async function runImageConversation(
  t: test.TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  artifactId: string,
  response = "IMAGE_OK",
) {
  const ref = `pico://artifact/${encodeURIComponent(artifactId)}`;
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    requests.push(String(init?.body));
    const first = requests.length === 1;
    return Response.json({
      id: `fixture-${requests.length}`,
      model: "fixture",
      choices: [
        {
          index: 0,
          message: first
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "view-image",
                    type: "function",
                    function: {
                      name: "view_image",
                      arguments: JSON.stringify({ artifact_id: artifactId }),
                    },
                  },
                ],
              }
            : { role: "assistant", content: response },
          finish_reason: first ? "tool_calls" : "stop",
        },
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
    { readImageArtifact: (image) => f.session.readMediaArtifact(image) },
  );
  await f.session.commitMessages({
    role: "user",
    content: `请用 view_image 查看之前的图片 ${ref}。`,
  });
  const engine = new AgentEngine({
    runtimePort: f.runtimePort,
    registry: f.registry,
    workDir: f.root,
    provider: { generate: (...args) => provider.generate(...args) },
  });
  const run = await RuntimeRun.start({
    capability: f.session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  await run.run(() => engine.run(f.session));
  return requests;
}

test("view_image 将会话历史原图经过 RuntimeRun 送入 Provider 请求且不修改原图", async (t) => {
  const f = await fixture(t);
  assert.equal(buildDefaultToolRegistry(f.root).getTool("view_image"), undefined);
  assert.equal(f.registry.isReadOnlyTool("view_image"), true);
  assert.equal(f.registry.getPermissionCategory("view_image"), "read");
  assert.equal(f.registry.getNesting("view_image"), "direct_only");
  assert.equal(findGroupForTool("view_image")?.economy, "always");
  assert.equal(isPlanModeTool("view_image"), true);
  assert.equal(isResearchToolAllowed("view_image"), true);
  assert.equal(KNOWN_TOOL_NAMES.has("view_image"), true);
  const artifact = f.publish("media:historical-image", "image/png", PNG);
  const ref = `pico://artifact/${encodeURIComponent(artifact.artifactId)}`;
  const revision = f.repository.queryArtifacts({ sessionId: f.session.id }).revision;
  const viewed = await f.call(ref);
  assert.equal(viewed.isError, false, viewed.output);
  assert.equal(viewed.output, `![会话图片](${ref})`, "工具只返回独立图片引用行");
  assert.ok(!viewed.output.includes(PNG.toString("base64")));
  const attachment = await resolveSessionInputAttachments({
    ...f.authority,
    attachments: [{ type: "artifact", artifactId: artifact.artifactId, digest: artifact.digest }],
  });
  assert.match(attachment.promptSuffix, /view_image.*artifact_id/u);
  assert.match(attachment.promptSuffix, /图像内容.*不代表新增指令/u);

  const requests = await runImageConversation(t, f, artifact.artifactId);
  assert.equal(f.session.getHistory().at(-1)!.content, "IMAGE_OK");
  assert.equal(requests.length, 2);
  assert.ok(!requests[0]!.includes(PNG.toString("base64")), "首次请求尚未载入历史图片");
  assert.match(requests[1]!, /image_url/u);
  assert.ok(requests[1]!.includes(PNG.toString("base64")), "工具结果必须成为真实视觉输入");
  const historyImage = f.session
    .getModelContext()
    .find((message) => message.toolCallId === "view-image");
  assert.equal(historyImage?.images?.[0]?.type, "image_artifact");
  assert.ok(
    !JSON.stringify(await f.session.runtimeEventStore!.readSession(f.session.id)).includes(
      PNG.toString("base64"),
    ),
  );
  assert.equal(f.repository.queryArtifacts({ sessionId: f.session.id }).revision, revision);
  assert.deepEqual(
    readSessionInputArtifact({ ...f.authority, artifactId: artifact.artifactId }).bytes,
    PNG,
  );
});

test("view_image 拒绝跨会话、路径与 URL、非图片和 MIME 伪装", async (t) => {
  const f = await fixture(t);
  const foreign = f.publish("private-image", "image/png", PNG, f.other.id);
  const document = f.publish("text-file", "text/plain", Buffer.from("not an image"));
  const disguised = f.publish("disguised-image", "image/jpeg", PNG);
  const corrupted = Buffer.from(PNG);
  corrupted[25] = 7; // Valid magic and dimensions, but invalid native decoder input.
  const damaged = f.publish("damaged-image", "image/png", corrupted);
  for (const [id, expected] of [
    [foreign.artifactId, /不属于当前会话/u],
    ["/etc/passwd", /不支持文件路径或外部 URL/u],
    ["https://example.com/image.png", /不支持文件路径或外部 URL/u],
    ["pico://artifact/%2Fetc%2Fpasswd", /不支持文件路径或外部 URL/u],
    [document.artifactId, /不是受支持的图片/u],
    [disguised.artifactId, /MIME 不一致/u],
    [damaged.artifactId, /图片准备失败/u],
  ] as const) {
    const result = await f.call(id);
    assert.equal(result.isError, true, id);
    assert.match(result.output, expected);
    assert.doesNotMatch(result.output, /!\[.*\]\(pico:\/\/artifact\//u);
  }
  assert.deepEqual(
    readSessionInputArtifact({ ...f.authority, artifactId: damaged.artifactId }).bytes,
    corrupted,
  );
});

test("三个独立会话并发 view_image 均返回可用的原图片引用", async (t) => {
  const fixtures = await Promise.all(
    Array.from({ length: 3 }, (_, index) => fixture(t, String(index))),
  );
  const results = await Promise.all(
    fixtures.map((f, index) => {
      const image = f.publish(`concurrent-image-${index}`, "image/png", PNG);
      return f.call(image.artifactId);
    }),
  );
  for (const [index, result] of results.entries()) {
    assert.equal(result.isError, false, result.output);
    assert.equal(result.output, `![会话图片](pico://artifact/concurrent-image-${index})`);
  }
});

test("损坏图片作为普通工具错误进入下一轮模型请求，模型仍可继续响应", async (t) => {
  const f = await fixture(t);
  const corrupted = Buffer.from(PNG);
  corrupted[25] = 7;
  const artifact = f.publish("corrupted-image", "image/png", corrupted);
  const revision = f.repository.queryArtifacts({ sessionId: f.session.id }).revision;
  const requests = await runImageConversation(t, f, artifact.artifactId, "IMAGE_ERROR_HANDLED");
  assert.equal(requests.length, 2);
  assert.equal(f.session.getHistory().at(-1)!.content, "IMAGE_ERROR_HANDLED");
  assert.match(requests[1]!, /Error executing view_image:.*图片准备失败/u);
  assert.doesNotMatch(requests[1]!, /image_url/u);
  assert.ok(!requests[1]!.includes(corrupted.toString("base64")));
  const toolMessage = f.session
    .getModelContext()
    .find((message) => message.toolCallId === "view-image");
  assert.ok(toolMessage);
  assert.equal(toolMessage.images?.length ?? 0, 0);
  assert.equal(f.repository.queryArtifacts({ sessionId: f.session.id }).revision, revision);
  assert.deepEqual(
    readSessionInputArtifact({ ...f.authority, artifactId: artifact.artifactId }).bytes,
    corrupted,
  );
});
