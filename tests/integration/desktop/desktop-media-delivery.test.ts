import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRuntimeRequest,
  type RuntimeResult,
  type RuntimeParams,
  type RuntimeMediaReference,
} from "@pico/protocol";
import {
  AgentRuntime,
  type RunAgentCliDependencies,
  type RunAgentCliOptions,
} from "@pico/pico-host/agent-runtime";
import { createProductionRuntimeServices } from "@pico/pico-host/production-host";
import { globalSessionManager, Session } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import {
  createManagedExecutionBoundary,
  createWorkspaceWritePermissionProfile,
} from "@pico/core/permission-profile";
import { SqliteSessionWorkbarRepository } from "@pico/storage";
import { SessionSubscriptionRegistry } from "@pico/pico-host/session-subscription-owner";
import { SqliteSessionContinuitySource } from "@pico/pico-host/sqlite-session-continuity-source";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { initializeRuntimeEventOwner } from "../helpers/runtime-event-owner.js";
import { createArtifactExporter } from "../../../apps/desktop/src/main/artifact-export.js";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1kAAAAASUVORK5CYII=",
  "base64",
);
const mp4 = Buffer.from("000000186674797069736f6d0000000069736f6d6d703432000000086d646174", "hex");

test(
  "生产回复捕获 bash 生成本地图片/视频，重开及 fork 后按会话读取并另存不可变快照",
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-media-production-"));
    const picoHome = join(root, "home");
    await mkdir(picoHome);
    await mkdir(join(root, "workspace"));
    const workspacePath = await realpath(join(root, "workspace"));
    await writeDesktopModelRouting(picoHome);
    let generations = 0;
    const agentRuntime = new (class extends AgentRuntime {
      override execute(options: RunAgentCliOptions, dependencies: RunAgentCliDependencies) {
        let step = 0;
        const script = `const f=require("node:fs");f.writeFileSync("image.png",Buffer.from("${png.toString("base64")}","base64"));f.writeFileSync("movie.mp4",Buffer.from("${mp4.toString("base64")}","base64"));`;
        return super.execute(options, {
          ...dependencies,
          isolatedHeadless: true,
          provider: {
            modelName: "test/media-delivery",
            generate: async () => {
              generations++;
              if (step++ === 0)
                return {
                  role: "assistant" as const,
                  content: "",
                  toolCalls: [
                    {
                      id: "generate-media",
                      name: "bash",
                      arguments: JSON.stringify({
                        command: `'${process.execPath}' -e '${script}'`,
                      }),
                    },
                  ],
                };
              return {
                role: "assistant" as const,
                content: "![图片](image.png)\n\n![视频](movie.mp4)\n\n`![不解析](ignored.png)`",
              };
            },
          },
        });
      }
    })();
    const makeServices = () =>
      createProductionRuntimeServices({
        env: { PICO_HOME: picoHome, PICO_TEST_TOKEN: "synthetic-token" },
        agentRuntime,
      });
    let services = makeServices();
    const artifactRevisions: number[] = [];
    let unsubscribe = services.desktopService.subscribe((notice) => {
      const payload = notice.payload as Record<string, unknown> | null;
      if (
        notice.topic === "session.resourceChanged" &&
        payload?.["resource"] === "artifacts" &&
        typeof payload["revision"] === "number"
      )
        artifactRevisions.push(payload["revision"]);
    });
    t.after(() => unsubscribe());
    const ids: string[] = [];
    t.after(async () => {
      await services.desktopService.close();
      for (const id of ids)
        await globalSessionManager.delete(id, workspacePath, { picoHome })?.close();
      await rm(root, { recursive: true, force: true });
    });
    await services.trustStore.trust(workspacePath);
    await services.service.handle(createRuntimeRequest("workspace.register", { workspacePath }));
    const request = createRuntimeRequest("session.send", {
      workspacePath,
      input: { kind: "text", text: "生成图片和视频并在回复中展示" },
      initialSettings: { permissionMode: "full-access", orchestrationMode: "default" },
      idempotencyKey: "media-input",
    });
    const first = (await services.desktopService.handle(
      request,
    )) as unknown as RuntimeResult<"session.send">;
    const sessionId = first.session.sessionId;
    ids.push(sessionId);
    const runtime = await services.service.getWorkspaceRuntime(workspacePath);
    const finished = await runtime.waitForRun(first.run!.runId);
    assert.equal(finished.status, "succeeded", finished.error);
    assert.deepEqual(await readFile(join(workspacePath, "movie.mp4")), mp4);
    assert.deepEqual(artifactRevisions, [2], "已订阅的文件面板收到新媒体的artifacts资源事件");
    const registry = new SessionSubscriptionRegistry(
      "media-host",
      new SqliteSessionContinuitySource({
        picoHome,
        readMetadata: (workspace, id) =>
          services.desktopService.readSessionContinuityMetadata(workspace, id),
      }),
    );
    t.after(() => registry.shutdown());
    const view = async (id: string) =>
      (await registry.open(
        { workspacePath, sessionId: id },
        { connectionId: "test", push: async () => undefined },
      )) as RuntimeResult<"session.subscription.open">;
    const references = (await view(sessionId)).durableTail.flatMap((record) =>
      record.item.kind === "assistantMessage" ? (record.item.media ?? []) : [],
    );
    assert.deepEqual(
      references.map((media) => media.kind),
      ["image", "video"],
    );
    assert.deepEqual(
      references.map((media) => media.source),
      ["image.png", "movie.mp4"],
    );
    await rm(join(workspacePath, "image.png"));
    await rm(join(workspacePath, "movie.mp4"));
    await services.desktopService.close();
    await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
    unsubscribe();
    services = makeServices();
    unsubscribe = services.desktopService.subscribe((notice) => {
      const payload = notice.payload as Record<string, unknown> | null;
      if (
        notice.topic === "session.resourceChanged" &&
        payload?.["resource"] === "artifacts" &&
        typeof payload["revision"] === "number"
      )
        artifactRevisions.push(payload["revision"]);
    });
    const reopened = await view(sessionId);
    assert.deepEqual(
      reopened.durableTail.flatMap((record) =>
        record.item.kind === "assistantMessage" ? (record.item.media ?? []) : [],
      ),
      references,
    );
    await services.desktopService.handle(request);
    assert.equal(generations, 2, "重放输入不能再次执行模型或shell");
    assert.deepEqual(artifactRevisions, [2], "幂等重试不重复发媒体资源事件");
    const fork = (await services.desktopService.handle(
      createRuntimeRequest("session.fork", { workspacePath, sessionId }),
    )) as unknown as RuntimeResult<"session.fork">;
    const forkId = fork.session.sessionId;
    ids.push(forkId);
    const forkRefs = (await view(forkId)).durableTail.flatMap((record) =>
      record.item.kind === "assistantMessage" ? (record.item.media ?? []) : [],
    );
    assert.equal(forkRefs.length, 2);
    assert.notEqual(forkRefs[0]!.artifactId, references[0]!.artifactId);
    assert.equal(forkRefs[0]!.digest, references[0]!.digest);
    const query = (params: RuntimeParams<"session.artifacts.query">) =>
      services.desktopService.handle(createRuntimeRequest("session.artifacts.query", params));
    for (const [index, ref] of forkRefs.entries()) {
      const bytes = [png, mp4][index]!;
      const expected = createHash("sha256").update(bytes).digest("hex");
      const part = (await query({
        workspacePath,
        sessionId: forkId,
        artifactId: ref.artifactId,
        action: "read_chunk",
        offsetBytes: 3,
        limitBytes: 7,
      })) as Record<string, unknown>;
      assert.deepEqual(Buffer.from(String(part.contentBase64), "base64"), bytes.subarray(3, 10));
      const destination = join(root, `export-${index}`);
      const exporter = createArtifactExporter({
        query,
        chooseSavePath: async () => destination,
        revealFile: () => assert.fail("不应打开"),
      });
      await exporter.export(
        { workspacePath, sessionId: forkId, artifactId: ref.artifactId },
        "saveAs",
      );
      assert.equal(
        createHash("sha256")
          .update(await readFile(destination))
          .digest("hex"),
        expected,
      );
      await exporter.dispose();
    }
    await assert.rejects(
      query({
        workspacePath,
        sessionId: forkId,
        artifactId: references[0]!.artifactId,
        action: "get",
      }),
    );
  },
);

test("媒体定稿拒绝越界/超限/假引用，保留文字；pure media 与 commitMessageOnce 重试不丢失快照", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-media-session-"));
  await mkdir(join(root, "workspace"));
  const workspace = await realpath(join(root, "workspace"));
  const options = {
    persistence: true,
    picoHome: join(root, "home"),
    runtimePort: createEngineRuntimePort(),
  };
  let session = new Session("media-session", workspace, options);
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  await writeFile(join(workspace, "image.png"), png);
  await writeFile(join(root, "secret.png"), png);
  await symlink(join(root, "secret.png"), join(workspace, "escape.png"));
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
  png.copy(oversized);
  await writeFile(join(workspace, "large.png"), oversized);
  const original = { role: "assistant" as const, content: "![图](image.png)" };
  const receipt = await session.commitMessageOnce("stable-media", original);
  const saved = await session.runtimeEventStore!.readSessionEvent(session.id, "stable-media");
  assert.equal(saved?.event.kind, "message.committed");
  const refs =
    saved!.event.kind === "message.committed"
      ? (saved!.event.data.message.providerData?.picoMedia as RuntimeMediaReference[])
      : [];
  assert.equal(refs.length, 1);
  await writeFile(join(workspace, "image.png"), "changed");
  await session.close();
  session = new Session("media-session", workspace, options);
  await session.recover();
  const retry = await session.commitMessageOnce("stable-media", original);
  assert.equal(retry.inserted, false);
  assert.deepEqual(retry.cursor, receipt.cursor);
  await writeFile(join(workspace, "link.png"), png);
  await session.commitMessages({
    role: "assistant",
    content:
      "[普通图片链接](link.png)\ntext remains\n![越界](../secret.png)\n![链接](escape.png)\n![过大](large.png)\n![远程](https://example.com/a.png)\n```md\n![代码](image.png)\n```",
    providerData: { picoMedia: refs },
  });
  const last = (await session.runtimeEventStore!.readSession(session.id))
    .filter((event) => event.kind === "message.committed")
    .at(-1)!;
  assert.equal(last.kind, "message.committed");
  if (last.kind === "message.committed")
    assert.equal(last.data.message.providerData?.picoMedia, undefined);
  await session.commitMessages({
    role: "assistant",
    content: "",
    images: [{ type: "image_base64", mimeType: "image/png", data: png.toString("base64") }],
  });
  const projected = await session.runtimeEventStore!.readTranscriptProjectionPage({
    sessionId: session.id,
    maxBytes: 1024 * 1024,
  });
  assert.ok(
    projected.items.some((record) => {
      const item = record.payload as Record<string, unknown>;
      return (
        item.kind === "assistantMessage" &&
        item.content === "" &&
        Array.isArray(item.media) &&
        item.media.length === 1
      );
    }),
  );
  await session.commitMessages(
    {
      role: "assistant",
      content: "",
      images: [{ type: "image_base64", mimeType: "image/png", data: "bad base64" }],
    },
    {
      role: "user",
      content: "",
      images: [{ type: "image_url", url: "https://example.com/remote.png" }],
    },
  );
  const failedMedia = await session.runtimeEventStore!.readTranscriptProjectionPage({
    sessionId: session.id,
    maxBytes: 1024 * 1024,
  });
  assert.equal(
    failedMedia.items.filter(
      (record) => (record.payload as Record<string, unknown>).content === "媒体无法预览",
    ).length,
    2,
  );
  await writeFile(join(workspace, "denied.png"), png);
  const profile = createWorkspaceWritePermissionProfile();
  session.updateRuntimeState({
    boundary: createManagedExecutionBoundary({
      ...profile,
      name: "custom",
      fileSystem: {
        ...profile.fileSystem,
        entries: [
          ...profile.fileSystem.entries,
          { kind: "path", access: "deny", path: join(workspace, "denied.png"), match: "exact" },
        ],
      },
    }),
  });
  await session.commitMessageOnce("denied-media", {
    role: "assistant",
    content: "![禁止](denied.png)",
  });
  const denied = await session.runtimeEventStore!.readSessionEvent(session.id, "denied-media");
  if (denied?.event.kind === "message.committed")
    assert.equal(denied.event.data.message.providerData?.picoMedia, undefined);
  assert.equal(session.getRuntimeStateSnapshot().boundary?.kind, "managed");
  const repository = new SqliteSessionWorkbarRepository({
    storageRoot: session.runtimeStorageRoot,
  });
  assert.equal(
    repository.queryArtifacts({ sessionId: session.id }).artifacts.length,
    1,
    "同bytes复用session snapshot",
  );
  const other = new Session("other-media-session", workspace, options);
  try {
    await other.recover();
    await other.commitMessages({
      role: "assistant",
      content: `![偷取](pico://artifact/${refs[0]!.artifactId})`,
      providerData: { picoMedia: refs },
    });
    assert.equal(repository.queryArtifacts({ sessionId: other.id }).artifacts.length, 0);
  } finally {
    await other.close();
  }
  const projectionStore = new SqliteRuntimeEventStore({ storageRoot: session.runtimeStorageRoot });
  try {
    const projectionId = "media-multi-message";
    const { ownerFence } = await initializeRuntimeEventOwner(projectionStore, {
      sessionId: projectionId,
      workDir: workspace,
    });
    const artifact = repository.publishArtifactSnapshot({
      sessionId: projectionId,
      artifactId: "projection-image",
      title: "图",
      mimeType: "image/png",
      content: png,
    });
    const ref = { ...refs[0]!, artifactId: artifact.artifactId };
    const base = {
      schemaVersion: 2 as const,
      sessionId: projectionId,
      invocationId: "projection",
      runId: "projection-run",
      turnId: "same-turn",
      at: new Date().toISOString(),
      partial: false,
      visibility: "model" as const,
      kind: "message.committed" as const,
    };
    await projectionStore.append(
      {
        ...base,
        eventId: "with-media",
        data: {
          message: {
            role: "assistant",
            content: "![图](image.png)",
            providerData: { picoMedia: [ref] },
          },
        },
      },
      { ownerFence },
    );
    await projectionStore.append(
      {
        ...base,
        eventId: "text-later",
        data: { message: { role: "assistant", content: "媒体已生成" } },
      },
      { ownerFence },
    );
    const page = await projectionStore.readTranscriptProjectionPage({
      sessionId: projectionId,
      maxBytes: 1024 * 1024,
    });
    const item = page.items[0]!.payload as Record<string, unknown>;
    assert.equal(item.content, "媒体已生成");
    assert.deepEqual(item.media, [ref], "同turn后续纯文字保留已登记媒体");
  } finally {
    await projectionStore.close();
  }
  await assert.rejects(
    session.commitMessageOnce("stable-media", { ...original, content: "different" }),
    /another payload/u,
  );
});
