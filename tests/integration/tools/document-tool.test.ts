import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectMediaBytes } from "@pico/core/media";
import { KNOWN_TOOL_NAMES } from "@pico/core/known-tool-names";
import { findGroupForTool, isPlanModeTool } from "@pico/runtime/tool-surface";
import { SqliteSessionWorkbarRepository } from "@pico/storage";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { buildDefaultToolRegistry } from "../../../packages/pico-host/src/default-registry.js";
import { publishSessionArtifact } from "../../../packages/pico-host/src/session-artifact-writer.js";
import { readSessionInputArtifact } from "../../../packages/pico-host/src/session-input-attachments.js";
import { isResearchToolAllowed } from "../../../packages/pico-host/src/research-mode.js";
import { documentPdf } from "../../fixtures/document-attachments.js";
import { initializeRuntimeEventOwner } from "../helpers/runtime-event-owner.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-document-tool-"));
  const workspace = join(root, "workspace");
  const storageRoot = join(root, "storage");
  await mkdir(workspace);
  const store = new SqliteRuntimeEventStore({ storageRoot });
  for (const sessionId of ["source", "other"])
    await initializeRuntimeEventOwner(store, { sessionId, workDir: workspace });
  const repository = new SqliteSessionWorkbarRepository({ storageRoot });
  const revisions: number[] = [];
  const authority = {
    repository,
    sessionId: "source",
    onChanged: (revision: number) => revisions.push(revision),
  };
  const registry = buildDefaultToolRegistry(workspace, { sessionArtifacts: authority });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const publish = (title: string, mimeType: string, bytes: Buffer) =>
    publishSessionArtifact(authority, { title, mimeType, bytes });
  let sequence = 0;
  const call = (args: Record<string, unknown>, signal?: AbortSignal) =>
    registry.execute(
      {
        id: `document-${++sequence}`,
        name: "document",
        arguments: JSON.stringify(args),
      },
      signal ? { signal } : undefined,
    );
  return { workspace, storageRoot, registry, repository, authority, revisions, publish, call };
}

test(
  "会话文档工具提供有界概况、分页与搜索，并发布带来源的 PDF 页面图片",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal(buildDefaultToolRegistry(f.workspace).getTool("document"), undefined);
    assert.equal(f.registry.isReadOnlyTool("document"), true);
    assert.equal(f.registry.getNesting("document"), "direct_only");
    assert.equal(f.registry.getPermissionCategory("document"), "read");
    assert.equal(findGroupForTool("document")?.economy, "always");
    assert.equal(isPlanModeTool("document"), true);
    assert.equal(isResearchToolAllowed("document"), true);
    assert.equal(KNOWN_TOOL_NAMES.has("document"), true);
    const text = "line alpha\n".repeat(3000) + "unique-end-marker";
    const artifactId = f.publish("资料.txt", "text/plain", Buffer.from(text));
    const ref = `pico://artifact/${artifactId}`;
    const overview = await f.call({ artifact_id: ref, action: "inspect" });
    assert.equal(overview.isError, false, overview.output);
    const inspected = JSON.parse(overview.output);
    assert.equal(inspected.source.ref, ref);
    assert.equal(inspected.manifest.kind, "text");
    assert.ok(!inspected.text.includes("unique-end-marker"));
    const first = await f.call({ artifact_id: artifactId, action: "read", limit: 80 });
    assert.equal(first.isError, false, first.output);
    const page = JSON.parse(first.output);
    assert.equal(typeof page.nextOffset, "number");
    assert.ok(page.nextOffset > 0);
    const second = await f.call({
      artifact_id: ref,
      action: "read",
      offset: page.nextOffset,
      limit: 80,
    });
    assert.equal(second.isError, false, second.output);
    assert.ok(JSON.parse(second.output).nextOffset > page.nextOffset);
    const found = await f.call({ artifact_id: ref, action: "search", query: "unique-end-marker" });
    assert.equal(found.isError, false, found.output);
    assert.match(JSON.parse(found.output).text, /unique-end-marker/u);
    assert.equal(JSON.parse(found.output).total, 1);
    const pdf = f.publish("页面.pdf", "application/pdf", documentPdf());
    const view = await f.call({ artifact_id: pdf, action: "view", page: 1 });
    assert.equal(view.isError, false, view.output);
    const image = /\n\n!\[文件第1页\]\(pico:\/\/artifact\/([^\s)]+)\)$/u.exec(view.output);
    assert.ok(image, "view 必须返回独立 Markdown 图片行");
    const source = JSON.parse(view.output.split("\n\n")[0]!).source;
    assert.equal(source.ref, `pico://artifact/${pdf}`);
    assert.equal(source.page, 1);
    const imageArtifact = readSessionInputArtifact({ ...f.authority, artifactId: image[1]! });
    assert.equal(imageArtifact.artifact.mimeType, "image/png");
    assert.equal(inspectMediaBytes(imageArtifact.bytes)?.mimeType, "image/png");
    assert.equal(f.revisions.length, 3, "两次上传和派生页面各发布一次");
  },
);

test("文档工具拒绝跨会话、路径注入、损坏字节和已取消的读取", async (t) => {
  const f = await fixture(t);
  const foreignId = publishSessionArtifact(
    { repository: f.repository, sessionId: "other" },
    {
      title: "私有.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("别的会话资料"),
    },
  );
  const foreign = await f.call({ artifact_id: foreignId, action: "read" });
  assert.equal(foreign.isError, true);
  assert.match(foreign.output, /不属于当前会话/u);
  const path = await f.call({ artifact_id: "/etc/passwd", action: "read" });
  assert.equal(path.isError, true);
  assert.match(path.output, /不支持文件路径/u);
  const artifactId = f.publish("完整性.txt", "text/plain", Buffer.from("original bytes"));
  const artifact = f.repository.queryArtifacts({ sessionId: "source", artifactId }).artifacts[0]!;
  await writeFile(
    join(f.storageRoot, "artifacts", "blobs", artifact.digest.slice(0, 2), artifact.digest),
    "tampered bytes",
  );
  const corrupt = await f.call({ artifact_id: artifactId, action: "read" });
  assert.equal(corrupt.isError, true);
  assert.match(corrupt.output, /摘要|digest|校验/u);
  const controller = new AbortController();
  controller.abort(new Error("document read cancelled"));
  await assert.rejects(
    f.registry
      .getTool("document")!
      .execute(JSON.stringify({ artifact_id: artifactId, action: "read" }), {
        signal: controller.signal,
      }),
    /document read cancelled/u,
  );
});
