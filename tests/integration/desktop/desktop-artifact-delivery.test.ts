import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeRequest, type RuntimeParams } from "@pico/protocol";
import { SqliteSessionWorkbarRepository } from "@pico/storage";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { resolvePicoPaths } from "@pico/pico-host/pico-paths";
import { buildDefaultToolRegistry } from "@pico/pico-host/default-registry";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";
import { createArtifactExporter } from "../../../apps/desktop/src/main/artifact-export.js";
import { createArtifactBridge } from "../../../apps/desktop/src/preload/artifact-bridge.js";
import type { DesktopRuntimeApi } from "../../../apps/desktop/src/preload/contract.js";
import {
  appendArtifactStreamChunk,
  artifactContentView,
  queryAllWorkbarArtifacts,
  type ArtifactChunkEnvelope,
  type ArtifactStreamAccumulator,
} from "../../../apps/desktop/src/renderer/workbar-panels/FilesPanelController.js";

test("正式 write_file 交付物经过会话查询、分块预览及另存/文件定位，普通源码不登记", async (t) => {
  const fixture = await createFixture(t);
  const { workspace, sessionId, query, registry } = fixture;
  const content = "# 交付报告\n中文与 emoji 🧪\n".repeat(3000);
  const revisions: number[] = fixture.revisions;
  const tool = registry.getTool("write_file");
  assert.ok(tool);
  await tool.execute(JSON.stringify({ path: "src/index.ts", content: "export const value = 1;" }));
  assert.deepEqual(
    record(await query({ workspacePath: workspace, sessionId, action: "list" })).artifacts,
    [],
  );
  const output = await registry.execute({
    id: "deliver-report",
    name: "write_file",
    arguments: JSON.stringify({ path: "reports/交付报告.md", content, artifact: true }),
  });
  assert.equal(output.isError, false);
  assert.match(output.output, /已登记生成文件/u);
  assert.deepEqual(revisions, [1]);
  assert.equal(await readFile(join(workspace, "reports/交付报告.md"), "utf8"), content);

  const runtime = {
    "session.artifacts.query": async (params: RuntimeParams<"session.artifacts.query">) => ({
      ok: true as const,
      value: await query(params),
    }),
  } as DesktopRuntimeApi;
  const listed = await queryAllWorkbarArtifacts(runtime, { workspacePath: workspace, sessionId });
  assert.equal(listed.artifacts.length, 1);
  const artifact = listed.artifacts[0]!;
  assert.equal(artifact.name, "交付报告.md");
  assert.equal(artifact.size, Buffer.byteLength(content));
  const reference = { workspacePath: workspace, sessionId, artifactId: artifact.id };
  let stream: ArtifactStreamAccumulator | undefined;
  do {
    const chunk = await query({
      ...reference,
      action: "read_chunk",
      offsetBytes: stream?.nextOffset ?? 0,
      limitBytes: 32768,
    });
    stream = appendArtifactStreamChunk(stream, artifact, chunk as unknown as ArtifactChunkEnvelope);
  } while (!stream.complete);
  assert.equal(artifactContentView(stream).content, content);

  const saved = join(fixture.root, "用户另存.md");
  const revealed: string[] = [];
  const exporter = createArtifactExporter({
    query,
    chooseSavePath: async (name) => {
      assert.equal(name, "交付报告.md");
      return saved;
    },
    revealFile: (path) => revealed.push(path),
  });
  t.after(() => exporter.dispose());
  await exporter.export(reference, "saveAs");
  assert.equal(await readFile(saved, "utf8"), content);
  await exporter.export(reference, "open");
  assert.equal(revealed.length, 1);
  assert.equal(await readFile(revealed[0]!, "utf8"), content);

  const bridgeCalls: unknown[] = [];
  const bridge = createArtifactBridge({
    invoke: async (...args) => {
      bridgeCalls.push(args);
      return { ok: true, value: undefined };
    },
  });
  assert.equal((await bridge.saveAs(reference)).ok, true);
  assert.deepEqual(bridgeCalls, [["pico:artifact:save-as", reference]]);
});

test("write_file 自动登记 HTML 和 HTM，显式标记不重复登记，普通源码仍需显式标记", async (t) => {
  const fixture = await createFixture(t);
  const tool = fixture.registry.getTool("write_file")!;
  const files = [
    { path: "pages/preview.html", content: "<h1>预览</h1>" },
    { path: "pages/legacy.HTM", content: "<p>旧扩展名</p>", artifact: false },
    { path: "pages/explicit.HTML", content: "<p>显式登记</p>", artifact: true },
  ];
  for (const file of files) {
    assert.match(await tool.execute(JSON.stringify(file)), /已登记生成文件/u);
    assert.equal(await readFile(join(fixture.workspace, file.path), "utf8"), file.content);
  }
  await tool.execute(
    JSON.stringify({ path: "src/index.ts", content: "export const ready = true;" }),
  );

  const listed = fixture.repository.queryArtifacts({ sessionId: fixture.sessionId }).artifacts;
  assert.deepEqual(listed.map((artifact) => artifact.title).sort(), [
    "explicit.HTML",
    "legacy.HTM",
    "preview.html",
  ]);
  assert.deepEqual(fixture.revisions, [1, 2, 3]);
});

test("交付物保留路径授权、跨会话隔离和导出取消语义", async (t) => {
  const fixture = await createFixture(t);
  const tool = fixture.registry.getTool("write_file")!;
  await assert.rejects(
    tool.execute(JSON.stringify({ path: "../outside.md", content: "禁止", artifact: true })),
  );
  assert.equal(
    fixture.repository.queryArtifacts({ sessionId: fixture.sessionId }).artifacts.length,
    0,
  );
  await tool.execute(JSON.stringify({ path: "result.txt", content: "限定会话", artifact: true }));
  const artifactId = fixture.repository.queryArtifacts({ sessionId: fixture.sessionId })
    .artifacts[0]!.artifactId;
  const other = record(
    await fixture.desktop.handle(
      createRuntimeRequest("session.create", { workspacePath: fixture.workspace }),
    ),
  );
  const otherSessionId = String(record(other.session).sessionId);
  let prompted = 0;
  const exporter = createArtifactExporter({
    query: fixture.query,
    chooseSavePath: async () => {
      prompted++;
      return undefined;
    },
    revealFile: () => assert.fail("取消或跨会话请求不得打开文件"),
  });
  t.after(() => exporter.dispose());
  await assert.rejects(
    exporter.export(
      { workspacePath: fixture.workspace, sessionId: otherSessionId, artifactId },
      "saveAs",
    ),
  );
  assert.equal(prompted, 0);
  await exporter.export(
    { workspacePath: fixture.workspace, sessionId: fixture.sessionId, artifactId },
    "saveAs",
  );
  assert.equal(prompted, 1);
  const bridge = createArtifactBridge({
    invoke: async () => assert.fail("非法源路径不应穿过 preload"),
  });
  const invalid = await bridge.open({
    workspacePath: fixture.workspace,
    sessionId: fixture.sessionId,
    artifactId,
    path: "/private/secret",
  } as never);
  assert.equal(invalid.ok, false);
});

async function createFixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-artifact-delivery-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  await mkdir(picoHome);
  const workspace = await realpath(workDir);
  await writeDesktopModelRouting(picoHome);
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(workspace);
  const desktop = new DesktopRuntimeService({
    runtimeService: new WorkspaceRuntimeService({
      env: { PICO_HOME: picoHome },
      execute: async () => ({ ok: true }),
    }),
    trustStore,
    env: { PICO_HOME: picoHome },
  });
  t.after(async () => {
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = record(
    await desktop.handle(createRuntimeRequest("session.create", { workspacePath: workspace })),
  );
  const sessionId = String(record(created.session).sessionId);
  const repository = new SqliteSessionWorkbarRepository({
    storageRoot: resolvePicoPaths(workspace, { picoHome }).workspace.root,
  });
  const revisions: number[] = [];
  const registry = buildDefaultToolRegistry(workspace, {
    sessionArtifacts: { repository, sessionId, onChanged: (revision) => revisions.push(revision) },
  });
  const query = (params: RuntimeParams<"session.artifacts.query">) =>
    desktop.handle(createRuntimeRequest("session.artifacts.query", params));
  return { root, workspace, desktop, sessionId, repository, revisions, registry, query };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
