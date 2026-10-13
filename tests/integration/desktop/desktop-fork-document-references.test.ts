import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  createRuntimeRequest,
  type RuntimeMethod,
  type RuntimeParams,
  type RuntimeResult,
} from "@pico/protocol";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { globalSessionManager } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { resolvePicoPaths } from "@pico/pico-host";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { SqliteSessionWorkbarRepository } from "@pico/storage";
import { buildDefaultToolRegistry } from "@pico/pico-host/default-registry";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";
import { documentPdf } from "../../fixtures/document-attachments.js";

test("上传文档及页图在分叉、再次分叉与重开后沿历史引用读取，并隔离无关会话", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-fork-documents-"));
  await mkdir(join(root, "workspace"));
  const workspacePath = await realpath(join(root, "workspace"));
  const picoHome = join(root, "home");
  await writeDesktopModelRouting(picoHome);
  const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(workspacePath);
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => ({ ok: true }) });
  const desktop = new DesktopRuntimeService({ runtimeService: runtime, trustStore, env });
  const storageRoot = resolvePicoPaths(workspacePath, { picoHome }).workspace.root;
  const repository = new SqliteSessionWorkbarRepository({ storageRoot });
  const ids: string[] = [];
  t.after(async () => {
    await desktop.close();
    for (const id of ids)
      await globalSessionManager.delete(id, workspacePath, { picoHome })?.close();
    await desktop.shutdownOwnershipFence().released;
    await rm(root, { recursive: true, force: true });
  });
  const request = <M extends RuntimeMethod>(
    method: M,
    params: Omit<RuntimeParams<M>, "workspacePath">,
  ) =>
    desktop.handle(
      createRuntimeRequest(method, { workspacePath, ...params } as RuntimeParams<M>),
    ) as Promise<RuntimeResult<M>>;
  async function create() {
    const { session } = await request("session.create", {});
    ids.push(session.sessionId);
    return session.sessionId;
  }
  async function upload(sessionId: string, title: string, mimeType: string, bytes: Buffer) {
    const { revision } = await request("session.artifacts.query", { sessionId, action: "list" });
    const begin = await request("session.artifacts.command", {
      sessionId,
      action: "begin",
      title,
      mimeType,
      expectedRevision: Number(revision),
      idempotencyKey: randomUUID(),
    });
    await request("session.artifacts.command", {
      sessionId,
      action: "append",
      ingestId: String(begin.ingestId),
      offsetBytes: 0,
      contentBase64: bytes.toString("base64"),
    });
    const digest = createHash("sha256").update(bytes).digest("hex");
    await request("session.artifacts.command", {
      sessionId,
      action: "commit",
      ingestId: String(begin.ingestId),
      expectedRevision: Number(begin.revision),
      idempotencyKey: randomUUID(),
      expectedDigest: digest,
      expectedSizeBytes: bytes.length,
    });
    return { type: "artifact" as const, artifactId: String(begin.artifactId), digest };
  }
  async function fork(sessionId: string) {
    const { session } = await request("session.fork", { sessionId });
    ids.push(session.sessionId);
    return session.sessionId;
  }
  const lease = (sessionId: string) =>
    globalSessionManager.getOrCreatePinned(sessionId, workspacePath, {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    });
  const documentTool = (sessionId: string) =>
    buildDefaultToolRegistry(workspacePath, {
      sessionArtifacts: { repository, sessionId },
    }).getTool("document")!;
  const read = (sessionId: string, ref: string) =>
    documentTool(sessionId).execute(JSON.stringify({ artifact_id: ref, action: "read" }));

  const source = await create();
  const other = await create();
  const bytes = Buffer.from("Alpha document\nunique-ending");
  const document = await upload(source, "资料.txt", "text/plain", bytes);
  const pdf = await upload(source, "报告.pdf", "application/pdf", documentPdf());
  const foreign = await upload(other, "无关资料.txt", "text/plain", bytes);
  const sent = await request("session.send", {
    sessionId: source,
    input: { kind: "text", text: "读取附件", attachments: [document, pdf] },
    idempotencyKey: randomUUID(),
  });
  assert.ok(sent.run);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await runtime.getWorkspaceRun(workspacePath, sent.run.runId))?.status === "succeeded")
      break;
    await delay(10);
  }
  assert.equal((await runtime.getWorkspaceRun(workspacePath, sent.run.runId))?.status, "succeeded");

  const originalRef = `pico://artifact/${document.artifactId}`;
  const sourceLease = await lease(source);
  let pageRef: string;
  try {
    const run = await RuntimeRun.start({
      capability: sourceLease.session.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    const args = JSON.stringify({ artifact_id: pdf.artifactId, action: "view", page: 1 });
    await run.commitMessages(sourceLease.session, [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "view-page", name: "document", arguments: args }],
      },
    ]);
    await run.recordToolStarted("view-page", "document", args);
    const output = await documentTool(source).execute(args);
    pageRef = /!\[文件第1页\]\((pico:\/\/artifact\/[^)]+)\)/u.exec(output)![1]!;
    const observation = run.registerToolResult({
      toolCallId: "view-page",
      toolName: "document",
      status: "succeeded",
      body: {
        storage: "inline",
        content: output,
        sizeBytes: Buffer.byteLength(output),
        sha256: createHash("sha256").update(output).digest("hex"),
      },
      projection: { version: 1, mode: "full", text: output, strategy: "full", truncated: false },
    });
    await run.commitMessages(sourceLease.session, [observation]);
    await run.finish("completed");
  } finally {
    sourceLease.release();
  }

  const first = await fork(source);
  const firstRead = JSON.parse(await read(first, originalRef));
  assert.match(firstRead.text, /unique-ending/u);
  assert.notEqual(firstRead.source.ref, originalRef);
  assert.match(await read(first, firstRead.source.ref), /unique-ending/u);
  const second = await fork(first);
  for (const sessionId of [first, second]) {
    await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
    const reopened = await lease(sessionId);
    try {
      const history = reopened.session.getModelContext();
      const inherited = history.find((message) => message.content.includes(originalRef));
      assert.ok(inherited, "历史正文保留原始文档引用");
      assert.match(await read(sessionId, originalRef), /unique-ending/u);
      assert.match(await read(sessionId, firstRead.source.ref), /unique-ending/u);
      for (const ref of [originalRef, pageRef!]) {
        const artifactId = decodeURIComponent(ref.slice("pico://artifact/".length));
        const chunk = await request("session.artifacts.query", {
          sessionId,
          action: "read_chunk",
          artifactId,
        });
        assert.ok(String(chunk.contentBase64).length > 0, "桌面历史链接读取当前副本");
      }
      const page = history.find((message) => message.toolCallId === "view-page");
      assert.equal(page?.images?.length, 1, "fork 前的文档页图仍可用于后续视觉分析");
      const image = page!.images![0]!;
      assert.equal(image.type, "image_artifact");
      if (image.type === "image_artifact") assert.ok(reopened.session.readMediaArtifact(image));
      await assert.rejects(read(sessionId, foreign.artifactId), /不属于当前会话/u);
    } finally {
      reopened.release();
    }
  }
  const later = await upload(source, "分叉之后.txt", "text/plain", Buffer.from("later upload"));
  await assert.rejects(read(second, later.artifactId), /不属于当前会话/u);
});
