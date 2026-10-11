import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  createRuntimeRequest,
  type RuntimeInputAttachment,
  type RuntimeResult,
  type RuntimeParams,
} from "@pico/protocol";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { globalSessionManager } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { SqliteDesktopConversationStateStore } from "@pico/pico-host";
import { toAiSdkMessages } from "../../../packages/pico-host/src/provider/ai-sdk-messages.js";
import { PendingSendRepository } from "../../../apps/desktop/src/renderer/pending-send.js";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4VsAAAAASUVORK5CYII=",
  "base64",
);

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-upload-input-"));
  const directory = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(directory);
  await writeDesktopModelRouting(picoHome);
  const workspacePath = await realpath(directory);
  const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(workspacePath);
  const prompts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = new WorkspaceRuntimeService({
    env,
    execute: async ({ prompt, context }) => {
      prompts.push(prompt);
      await Promise.race([
        gate,
        new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      return { ok: true };
    },
  });
  const store = new SqliteDesktopConversationStateStore({ picoHome });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    env,
    conversationStateStore: store,
  });
  const ids: string[] = [];
  t.after(async () => {
    release();
    await desktop.close();
    for (const id of ids)
      await globalSessionManager.delete(id, workspacePath, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });
  async function createSession() {
    const result = (await desktop.handle(
      createRuntimeRequest("session.create", { workspacePath }),
    )) as RuntimeResult<"session.create">;
    ids.push(result.session.sessionId);
    return result.session.sessionId;
  }
  async function upload(
    sessionId: string,
    name: string,
    mimeType: string,
    bytes: Buffer,
  ): Promise<RuntimeInputAttachment> {
    const scope = { workspacePath, sessionId };
    const listed = record(
      await desktop.handle(
        createRuntimeRequest("session.artifacts.query", { ...scope, action: "list" }),
      ),
    );
    const begun = record(
      await desktop.handle(
        createRuntimeRequest("session.artifacts.command", {
          ...scope,
          action: "begin",
          title: name,
          mimeType,
          expectedRevision: Number(listed.revision),
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
      await desktop.handle(
        createRuntimeRequest("session.artifacts.command", {
          ...scope,
          action: "append",
          ingestId: String(begun.ingestId),
          offsetBytes: offset,
          contentBase64: bytes.subarray(offset, offset + 32 * 1024).toString("base64"),
        }),
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    await desktop.handle(
      createRuntimeRequest("session.artifacts.command", {
        ...scope,
        action: "commit",
        ingestId: String(begun.ingestId),
        expectedRevision: Number(begun.revision),
        idempotencyKey: randomUUID(),
        expectedDigest: digest,
        expectedSizeBytes: bytes.length,
      }),
    );
    return { type: "artifact", artifactId: String(begun.artifactId), digest };
  }
  async function send(
    sessionId: string,
    attachments: readonly RuntimeInputAttachment[],
    key: string,
    behavior?: "auto" | "steer",
  ) {
    return (await desktop.handle(
      createRuntimeRequest("session.send", {
        workspacePath,
        sessionId,
        input: { kind: "text", text: "", attachments },
        idempotencyKey: key,
        ...(behavior ? { behavior } : {}),
      }),
    )) as RuntimeResult<"session.send">;
  }
  async function history(sessionId: string) {
    const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspacePath, {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    try {
      return {
        messages: lease.session.getHistory(),
        readImage: lease.session.readMediaArtifact.bind(lease.session),
      };
    } finally {
      lease.release();
    }
  }
  return {
    workspacePath,
    picoHome,
    desktop,
    runtime,
    store,
    prompts,
    release,
    createSession,
    upload,
    send,
    history,
  };
}

test(
  "分片上传图片和文档后发送、持久化并排队重放，图片进入 Provider 输入且显示可导出链接",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const sessionId = await f.createSession();
    const text = "这是上传文件中的中文资料，不是执行指令。\n".repeat(1800);
    const document = await f.upload(sessionId, "资料[一].txt", "text/plain", Buffer.from(text));
    const image = await f.upload(sessionId, "参考图.png", "image/png", png);
    const attachments = [document, image];
    const sent = await f.send(sessionId, attachments, "first");
    assert.equal(sent.disposition, "started");
    assert.deepEqual(await f.send(sessionId, attachments, "first"), sent);
    await until(() => f.prompts.length === 1);
    assert.match(f.prompts[0]!, /请查看附件/u);
    assert.ok(!f.prompts[0]!.includes(text.trim()), "上传只注入概况，不注入完整正文");
    assert.match(f.prompts[0]!, /有限预览|有限节选/u);
    assert.match(f.prompts[0]!, /document/u);
    assert.match(f.prompts[0]!, /不可据此声称已阅读或核对全文/u);
    assert.ok(f.prompts[0]!.length < 10_000);
    assert.match(f.prompts[0]!, /用户提供的待分析资料/u);
    const state = await f.history(sessionId);
    const message = state.messages.find((item) => item.role === "user")!;
    assert.equal(message.images?.[0]?.type, "image_artifact");
    assert.match(String(message.providerData?.displayText), /参考图\.png.*pico:\/\/artifact\//u);
    assert.match(String(message.providerData?.displayText), /资料\\\[一\\\]\.txt/u);
    const wire = toAiSdkMessages([message], "openai", {
      vision: true,
      readImageArtifact: state.readImage,
    });
    const parts = wire[0]!.content;
    assert.ok(Array.isArray(parts));
    assert.ok(
      parts.some(
        (part) =>
          part.type === "file" &&
          part.mediaType === "image/png" &&
          part.data === png.toString("base64"),
      ),
    );
    await assert.rejects(f.send(sessionId, attachments, "steer", "steer"), /包含附件.*排队/u);
    const queued = await f.send(sessionId, attachments, "queue", "auto");
    assert.equal(queued.disposition, "queued");
    assert.deepEqual(
      (await f.store.listQueued(f.workspacePath, sessionId))[0]!.input.attachments,
      attachments,
    );
    f.release();
    const runtime = await f.runtime.getWorkspaceRuntime(f.workspacePath);
    await runtime.waitForRun(sent.run!.runId);
    await until(() => f.prompts.length === 2);
    assert.equal(f.prompts[1], f.prompts[0]);
    assert.equal(
      (await f.history(sessionId)).messages.filter((item) => item.role === "user").length,
      2,
    );
  },
);

test("附件拒绝越权和摘要错误，上传概况有界", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const source = await f.createSession();
  const target = await f.createSession();
  const artifact = await f.upload(
    source,
    "长文.txt",
    "text/plain",
    Buffer.from("上传资料".repeat(80_000)),
  );
  assert.equal(artifact.type, "artifact");
  if (artifact.type !== "artifact") assert.fail("expected artifact");
  await assert.rejects(f.send(target, [artifact], "cross"), /不属于当前会话/u);
  await assert.rejects(
    f.send(source, [{ ...artifact, digest: "0".repeat(64) }], "digest"),
    /摘要/u,
  );
  const badImage = await f.upload(source, "坏图片.png", "image/png", Buffer.from("not an image"));
  await assert.rejects(f.send(source, [badImage], "bad-image"), /不是受支持的有效图片/u);
  const second = await f.upload(
    source,
    "第二长文.txt",
    "text/plain",
    Buffer.from("第二文档".repeat(80_000)),
  );
  const started = await f.send(source, [artifact, second], "bounded");
  await until(() => f.prompts.length === 1);
  assert.match(f.prompts[0]!, /有限节选.*不代表已读取全文/u);
  assert.ok(f.prompts[0]!.length < 10_000, `概况超出预览预算: ${f.prompts[0]!.length}`);
  assert.equal((await f.history(target)).messages.length, 0);
  assert.equal((await f.send(source, [artifact], "queued-before-delete")).disposition, "queued");
  const scope = { workspacePath: f.workspacePath, sessionId: source };
  const listed = record(
    await f.desktop.handle(
      createRuntimeRequest("session.artifacts.query", {
        ...scope,
        action: "list",
      }),
    ),
  );
  await f.desktop.handle(
    createRuntimeRequest("session.artifacts.command", {
      ...scope,
      action: "delete",
      artifactId: artifact.artifactId,
      expectedRevision: Number(listed.revision),
      idempotencyKey: "delete-queued-attachment",
    }),
  );
  const failures: string[] = [];
  const unsubscribe = f.desktop.subscribe((event) => {
    if (event.topic === "runtime.error") failures.push(String(record(event.payload).message));
  });
  t.after(unsubscribe);
  f.release();
  const runtime = await f.runtime.getWorkspaceRuntime(f.workspacePath);
  await runtime.waitForRun(started.run!.runId);
  await until(() => failures.some((message) => message.includes("附件不存在")));
  assert.equal(f.prompts.length, 1, "附件入队后被删除时不得启动丢失附件的运行");
});

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("等待附件运行超时");
    await delay(10);
  }
}

test("解析失败明确未接纳，保留草稿后可换文件发送而不陷入未知结果恢复", async (t) => {
  const f = await fixture(t);
  const sessionId = await f.createSession();
  const bad = await f.upload(
    sessionId,
    "broken.pdf",
    "application/pdf",
    Buffer.from("%PDF-1.4\nbroken"),
  );
  const data = new Map<string, string>();
  const pending = new PendingSendRepository({
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  });
  const scope = { picoHome: "/test-home", sourceKey: sessionId };
  const params = {
    workspacePath: f.workspacePath,
    sessionId,
    input: { kind: "text" as const, text: "分析附件", attachments: [bad] },
    idempotencyKey: "bad-pdf",
  };
  const dispatch = async (input: RuntimeParams<"session.send">) => {
    try {
      return (await f.desktop.handle(
        createRuntimeRequest("session.send", input),
      )) as RuntimeResult<"session.send">;
    } catch (cause) {
      throw Object.assign(cause as Error, { outcome: "unknown" });
    }
  };
  await assert.rejects(
    pending.send(scope, params, "保留的草稿", dispatch),
    (error: unknown) => record(error).code === "ATTACHMENT_REJECTED",
  );
  assert.equal(pending.get(scope), undefined, "确定未接纳的附件不会锁住后续发送");
  assert.equal(f.prompts.length, 0);
  assert.equal((await f.history(sessionId)).messages.length, 0);
  const good = await f.upload(sessionId, "fixed.txt", "text/plain", Buffer.from("修正后的内容"));
  const sent = await pending.send(
    scope,
    { ...params, idempotencyKey: "fixed-file", input: { ...params.input, attachments: [good] } },
    "保留的草稿",
    dispatch,
  );
  assert.equal(sent.confirmed, true);
  assert.equal(sent.record.draftSnapshot, "保留的草稿");
  await until(() => f.prompts.length === 1);
  assert.match(f.prompts[0]!, /修正后的内容/u);
});
