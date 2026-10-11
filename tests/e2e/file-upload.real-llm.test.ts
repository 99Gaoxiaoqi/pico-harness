import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import test from "node:test";
import {
  createRuntimeRequest,
  type RuntimeArtifactInputAttachment,
  type RuntimeResult,
} from "@pico/protocol";
import { createProductionRuntimeServices } from "@pico/pico-host/production-host";
import {
  UserConfigStore,
  EMPTY_USER_CONFIG_REVISION,
} from "@pico/pico-host/input/user-config-store";
import { globalSessionManager } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { documentPdf, documentWord, documentExcel } from "../fixtures/document-attachments.js";
import { loadUserDefaultRealModel } from "./real-llm-user-model.js";

test(
  "real model: artifact上传的文本、PDF、Word、Excel和图片进入同一会话请求",
  { timeout: 240_000 },
  async (t) => {
    const model = await loadUserDefaultRealModel({
      modelRouteId: process.env["PICO_FILE_UPLOAD_E2E_MODEL_ROUTE"],
    }).catch((error: unknown) => {
      if (error instanceof Error && /缺少凭证环境变量|defaults.modelRouteId/u.test(error.message))
        return undefined;
      throw error;
    });
    if (!model) {
      t.skip("No configured real-model credentials");
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "pico-file-upload-real-"));
    const picoHome = join(root, "home");
    await mkdir(join(root, "workspace"));
    const workspacePath = await realpath(join(root, "workspace"));
    const skillDir = join(workspacePath, ".pico", "skills", "attachments-only");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: attachments-only\ndescription: Read the supplied attachments only\nallowed-tools: []\n---\nAnswer from the supplied attachment text and image. Do not call tools.\n",
    );
    const userConfigStore = new UserConfigStore({ picoHome });
    const secretEnv = "PICO_FILE_UPLOAD_REAL_KEY";
    await userConfigStore.write(
      {
        version: 1,
        defaults: {
          modelRouteId: model.route.id,
          collaborationMode: "agent",
          permissionMode: "full-access",
          orchestrationMode: "default",
        },
        providers: {
          [model.route.providerId]: {
            protocol: model.provider,
            baseURL: model.config.baseURL,
            apiKeyEnv: secretEnv,
            ...(model.route.auth ? { auth: model.route.auth } : {}),
            discoverModels: false,
            models: [model.route.model],
          },
        },
      },
      { expectedRevision: EMPTY_USER_CONFIG_REVISION },
    );
    const services = createProductionRuntimeServices({
      env: { ...process.env, PICO_HOME: picoHome, [secretEnv]: model.config.apiKey },
      userConfigStore,
    });
    let sessionId = "";
    t.after(async () => {
      await services.desktopService.close();
      if (sessionId)
        await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
      await rm(root, { recursive: true, force: true });
    });
    await services.trustStore.trust(workspacePath);
    const created = (await services.desktopService.handle(
      createRuntimeRequest("session.create", { workspacePath }),
    )) as RuntimeResult<"session.create">;
    sessionId = created.session.sessionId;
    const scope = { workspacePath, sessionId };
    const marker = `TXT_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const files = [
      {
        name: "notes.txt",
        mimeType: "text/plain",
        bytes: Buffer.from(`这份UTF-8文本中的唯一标记是 ${marker}。`),
      },
      { name: "sample.pdf", mimeType: "application/pdf", bytes: documentPdf() },
      {
        name: "sample.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: documentWord(),
      },
      {
        name: "sample.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes: await documentExcel(),
      },
      { name: "color.png", mimeType: "image/png", bytes: redPng() },
    ];
    const attachments: RuntimeArtifactInputAttachment[] = [];
    for (const file of files) {
      const listed = record(
        await services.desktopService.handle(
          createRuntimeRequest("session.artifacts.query", { ...scope, action: "list" }),
        ),
      );
      const begun = record(
        await services.desktopService.handle(
          createRuntimeRequest("session.artifacts.command", {
            ...scope,
            action: "begin",
            title: file.name,
            mimeType: file.mimeType,
            expectedRevision: Number(listed.revision),
            idempotencyKey: randomUUID(),
          }),
        ),
      );
      for (let offset = 0; offset < file.bytes.length; offset += 32 * 1024) {
        await services.desktopService.handle(
          createRuntimeRequest("session.artifacts.command", {
            ...scope,
            action: "append",
            ingestId: String(begun.ingestId),
            offsetBytes: offset,
            contentBase64: file.bytes.subarray(offset, offset + 32 * 1024).toString("base64"),
          }),
        );
      }
      const digest = createHash("sha256").update(file.bytes).digest("hex");
      await services.desktopService.handle(
        createRuntimeRequest("session.artifacts.command", {
          ...scope,
          action: "commit",
          ingestId: String(begun.ingestId),
          expectedRevision: Number(begun.revision),
          expectedDigest: digest,
          expectedSizeBytes: file.bytes.length,
          idempotencyKey: randomUUID(),
        }),
      );
      attachments.push({ type: "artifact", artifactId: String(begun.artifactId), digest });
    }
    assert.ok(JSON.stringify(attachments).length < 1500);
    const sent = (await services.desktopService.handle(
      createRuntimeRequest("session.send", {
        ...scope,
        input: {
          kind: "text",
          text: "请根据这五个附件回答，只输出JSON对象，不调用工具：txtToken为文本唯一标记；pdfText为PDF正文；wordTitle为Word标题；sheetNames为Excel全部工作表名称数组；emptySecondCell为Excel“空列”那行第二列是否为空（布尔）；thirdCell为该行第三列文本；imageColor为图片主色英文单词。不要猜测无法读取的内容。",
          skills: [{ name: "attachments-only" }],
          attachments,
        },
        idempotencyKey: "file-upload-real",
      }),
    )) as RuntimeResult<"session.send">;
    assert.ok(sent.run);
    const runtime = await services.service.getWorkspaceRuntime(workspacePath);
    const completed = await runtime.waitForRun(sent.run.runId);
    assert.equal(completed.status, "succeeded", completed.error ?? "真实模型未完成附件请求");
    const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspacePath, {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    try {
      const messages = lease.session.getHistory();
      const answer = messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content)
        .join("\n");
      const json = /\{[\s\S]*\}/u.exec(answer)?.[0];
      assert.ok(json, "真实模型没有返回可验证的JSON答案");
      const result = record(JSON.parse(json));
      assert.equal(result.txtToken, marker);
      assert.match(String(result.pdfText), /Pico upload\s*42/u);
      assert.equal(result.wordTitle, "Pico 文档上传");
      assert.deepEqual(result.sheetNames, ["预算", "指标"]);
      assert.equal(result.emptySecondCell, true);
      assert.equal(result.thirdCell, "仍在第三列");
      assert.match(String(result.imageColor), /^red$/iu);
      assert.ok(
        messages.every((message) => !message.toolCalls?.length),
        "附件读取不应触发工具执行",
      );
      const input = messages.find((message) => message.role === "user")!;
      assert.equal(input.images?.length, 1);
      assert.equal(input.images[0]!.type, "image_artifact");
      assert.ok(JSON.stringify(input.images).length < 512);
      for (const attachment of attachments)
        assert.ok(
          String(input.providerData?.displayText).includes(
            `pico://artifact/${encodeURIComponent(attachment.artifactId)}`,
          ),
        );
      assert.ok(!JSON.stringify(input).includes(files[4]!.bytes.toString("base64")));
      assert.ok(input.content.length < 20_000);
      t.diagnostic(
        `真实附件验收通过：${model.route.id}；5类文件；图片使用artifact引用；无工具调用。`,
      );
    } finally {
      lease.release();
    }
  },
);

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function redPng(): Buffer {
  const dimension = 64;
  const scanlines = Buffer.alloc(dimension * (1 + dimension * 3));
  for (let row = 0; row < dimension; row++)
    for (let col = 0; col < dimension; col++)
      scanlines[row * (1 + dimension * 3) + 1 + col * 3] = 255;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(dimension, 0);
  header.writeUInt32BE(dimension, 4);
  header[8] = 8;
  header[9] = 2;
  const chunk = (type: string, content: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), content]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(content.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
