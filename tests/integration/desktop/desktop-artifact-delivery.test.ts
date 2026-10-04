import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import test from "node:test";
import { createRuntimeRequest, type RuntimeParams } from "@pico/protocol";
import { SqliteSessionWorkbarRepository } from "@pico/storage";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { globalSessionManager } from "@pico/pico-host/session";
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
  const syncs = injectSyncFailure(t, "directory", "EPERM");
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
  assert.ok(syncs.directory > 0, "unsupported directory syncs are attempted before degrading");
  assert.ok(syncs.file > 0, "artifact bytes still receive a successful file fsync");
});

test("目录无法打开时正式交付仍可查询、分块读取与另存不可变快照", async (t) => {
  const fixture = await createFixture(t);
  const opens = injectOpenFailure(t, fixture.storageRoot, "directory", "EPERM");
  const content = "目录句柄不可用仍保留交付字节 🧪\n".repeat(100);
  const result = await fixture.registry.execute({
    id: "directory-open-delivery",
    name: "write_file",
    arguments: JSON.stringify({ path: "reports/result.md", content, artifact: true }),
  });
  assert.equal(result.isError, false);
  assert.match(result.output, /已登记生成文件/u);
  assert.deepEqual(fixture.revisions, [1]);
  const artifact = fixture.repository.queryArtifacts({ sessionId: fixture.sessionId })
    .artifacts[0]!;
  const reference = {
    workspacePath: fixture.workspace,
    sessionId: fixture.sessionId,
    artifactId: artifact.artifactId,
  };
  const chunk = record(await fixture.query({ ...reference, action: "read_chunk" }));
  assert.equal(Buffer.from(String(chunk.contentBase64), "base64").toString("utf8"), content);
  await fs.promises.writeFile(join(fixture.workspace, "reports/result.md"), "源码已变");
  const saved = join(fixture.root, "snapshot.md");
  const exporter = createArtifactExporter({
    query: fixture.query,
    chooseSavePath: async () => saved,
    revealFile: () => assert.fail("另存不得打开文件"),
  });
  t.after(() => exporter.dispose());
  await exporter.export(reference, "saveAs");
  assert.equal(await readFile(saved, "utf8"), content);
  assert.ok(opens.directory > 0, "真实存储链尝试目录 open 后才降级");
});

test("交付登记仅降级不支持的目录同步，文件同步失败与目录 I/O 错误仍拒绝登记", async (t) => {
  for (const [operation, target, code] of [
    ["sync", "file", "EPERM"],
    ["sync", "directory", "EIO"],
    ["open", "file", "EPERM"],
    ["open", "directory", "EIO"],
  ] as const) {
    await t.test(`${operation} ${target} ${code}`, async (child) => {
      const fixture = await createFixture(child);
      if (operation === "sync") injectSyncFailure(child, target, code);
      else injectOpenFailure(child, fixture.storageRoot, target, code);
      const result = await fixture.registry.execute({
        id: `reject-${target}-${code}`,
        name: "write_file",
        arguments: JSON.stringify({
          path: "reports/failure.txt",
          content: "必须同步",
          artifact: true,
        }),
      });
      assert.equal(result.isError, true);
      assert.match(result.output, /生成文件登记失败/u);
      assert.match(result.output, new RegExp(code, "u"));
      assert.equal(
        await readFile(join(fixture.workspace, "reports/failure.txt"), "utf8"),
        "必须同步",
      );
      assert.deepEqual(
        fixture.repository.queryArtifacts({ sessionId: fixture.sessionId }).artifacts,
        [],
      );
      assert.deepEqual(
        fixture.revisions,
        [],
        "failed persistence must not publish an artifact revision",
      );
    });
  }
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
  fixture.sessionIds.push(otherSessionId);
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
  const sessionIds: string[] = [];
  t.after(async () => {
    await desktop.close();
    for (const id of sessionIds)
      await globalSessionManager.delete(id, workspace, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = record(
    await desktop.handle(createRuntimeRequest("session.create", { workspacePath: workspace })),
  );
  const sessionId = String(record(created.session).sessionId);
  sessionIds.push(sessionId);
  const storageRoot = await realpath(resolvePicoPaths(workspace, { picoHome }).workspace.root);
  const repository = new SqliteSessionWorkbarRepository({ storageRoot });
  const revisions: number[] = [];
  const registry = buildDefaultToolRegistry(workspace, {
    sessionArtifacts: { repository, sessionId, onChanged: (revision) => revisions.push(revision) },
  });
  const query = (params: RuntimeParams<"session.artifacts.query">) =>
    desktop.handle(createRuntimeRequest("session.artifacts.query", params));
  return {
    root,
    workspace,
    desktop,
    sessionId,
    sessionIds,
    storageRoot,
    repository,
    revisions,
    registry,
    query,
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function injectSyncFailure(
  t: test.TestContext,
  target: "directory" | "file",
  code: "EPERM" | "EIO",
) {
  const originalSync = fs.fsyncSync;
  const calls = { directory: 0, file: 0 };
  const sync = t.mock.method(fs, "fsyncSync", (fd: number) => {
    const kind = fs.fstatSync(fd).isDirectory() ? "directory" : "file";
    calls[kind]++;
    if (kind === target)
      throw Object.assign(new Error(`${code}: injected ${kind} fsync failure`), { code });
    originalSync(fd);
  });
  syncBuiltinESMExports();
  t.after(() => {
    sync.mock.restore();
    syncBuiltinESMExports();
  });
  return calls;
}

function injectOpenFailure(
  t: test.TestContext,
  storageRoot: string,
  target: "directory" | "file",
  code: "EPERM" | "EIO",
) {
  const originalOpen = fs.openSync;
  const calls = { directory: 0, file: 0 };
  const open = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const path = args[0];
    const canonical =
      typeof path === "string"
        ? fs.existsSync(path)
          ? fs.realpathSync.native(path)
          : join(fs.realpathSync.native(dirname(path)), basename(path))
        : undefined;
    const artifacts = join(storageRoot, "artifacts");
    if (
      canonical !== undefined &&
      (canonical === storageRoot ||
        canonical === artifacts ||
        canonical.startsWith(`${artifacts}${sep}`))
    ) {
      const kind =
        fs.existsSync(canonical) && fs.lstatSync(canonical).isDirectory() ? "directory" : "file";
      calls[kind]++;
      if (kind === target)
        throw Object.assign(new Error(`${code}: injected ${kind} open failure`), { code });
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    open.mock.restore();
    syncBuiltinESMExports();
  });
  return calls;
}
