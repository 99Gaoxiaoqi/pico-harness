// 5.5e 图片入口测试:POST /sessions/:id/messages 的 body.images 透传到 session message。
//
// 验证:
// 1. body 带 images(base64 内联)→ user 消息含 images 字段(ImagePart[]),
//    且 type/mimeType/data 与请求一致。
// 2. 无 images → 回归:user 消息不含 images 字段(undefined)。
//
// 不依赖真实 LLM:用 vi.mock 替换 createProvider 为总是返回最终答案的 mock。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { Message } from "../../src/schema/message.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { startHttpServer } from "../../src/server/http.js";
import { globalSessionManager } from "../../src/engine/session.js";

/** 跨平台安全删除 */
async function safeRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (String(err).includes("EBUSY") || String(err).includes("EPERM")) {
        await new Promise((r) => setTimeout(r, 80 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

/** 找空闲端口 */
async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:http");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("无法获取端口"));
      }
    });
    srv.on("error", reject);
  });
}

/** 总是返回"任务完成"纯文本答案的 mock provider */
class DoneProvider implements LLMProvider {
  readonly modelName = "mock";
  async generate(): Promise<Message> {
    return { role: "assistant", content: "ok" };
  }
}

/** HTTP helper */
async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 非 JSON,保留原文
  }
  return { status: res.status, body: parsed };
}

// 替换 provider factory,避免真实 HTTP。必须 hoist 在 import http.ts 之前。
vi.mock("../../src/provider/factory.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../../src/provider/factory.js");
  return {
    ...actual,
    createProvider: () => new DoneProvider(),
  };
});

describe("HTTP 图片入口 (5.5e)", () => {
  let workDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-http-img-"));
    port = await findFreePort();
    globalSessionManager.clear();
    server = await startHttpServer({
      kind: "openai",
      enableThinking: false,
      thinkingEffort: "off",
      planMode: false,
      traceEnabled: false,
      port,
      workDir,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalSessionManager.clear();
    await safeRm(workDir);
  });

  it("body 带 images → user 消息含 ImagePart[]", async () => {
    const createRes = await request(port, "POST", "/sessions", {});
    const sid = (createRes.body as { sessionId: string }).sessionId;

    const msgRes = await request(port, "POST", `/sessions/${sid}/messages`, {
      prompt: "看图",
      images: [
        { data: "BASE64DATA1", mimeType: "image/png" },
        { data: "BASE64DATA2", mimeType: "image/jpeg" },
      ],
    });
    expect(msgRes.status).toBe(200);

    // 直接从 globalSessionManager 取 session,验证 history 里的 user 消息带 images
    const session = globalSessionManager.get(sid)!;
    const history = session.getHistory();
    const userMsg = history.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.images).toBeDefined();
    expect(userMsg!.images).toHaveLength(2);
    expect(userMsg!.images![0]).toEqual({
      type: "image_base64",
      mimeType: "image/png",
      data: "BASE64DATA1",
    });
    expect(userMsg!.images![1]).toEqual({
      type: "image_base64",
      mimeType: "image/jpeg",
      data: "BASE64DATA2",
    });
  });

  it("无 images → 回归:user 消息不含 images 字段", async () => {
    const createRes = await request(port, "POST", "/sessions", {});
    const sid = (createRes.body as { sessionId: string }).sessionId;

    const msgRes = await request(port, "POST", `/sessions/${sid}/messages`, {
      prompt: "纯文本",
    });
    expect(msgRes.status).toBe(200);

    const session = globalSessionManager.get(sid)!;
    const history = session.getHistory();
    const userMsg = history.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.images).toBeUndefined();
  });
});
