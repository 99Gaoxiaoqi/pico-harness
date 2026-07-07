// 4.3 REST 端点矩阵测试。
//
// 验证:
// 1. POST /sessions 创建 → GET /sessions/:id 查状态
// 2. POST /sessions/:id/messages 发消息(mock provider,验证返回结构)
// 3. POST /approvals/:taskId approve/reject/modify
// 4. GET /tools 列表
// 5. 404/错误处理
//
// 为避免依赖真实 LLM,messages 端点的 run 用 mock:assembleEngine 注入 ScriptedProvider。
// 由于 assembleEngine 内部调 createProvider(走真实 HTTP),本测试用 vi.mock 替换 provider factory,
// 让 createProvider 返回一个总是直接给最终答案的 ScriptedProvider。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { Message, ToolDefinition } from "../../src/schema/message.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { startHttpServer } from "../../src/server/http.js";
import { globalApprovalManager } from "../../src/approval/manager.js";
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
    return { role: "assistant", content: "任务完成:这是 mock 答案" };
  }
}

/** HTTP helper:发请求,返回 {status, body} */
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

// 替换 provider factory:createProvider 返回 DoneProvider,避免真实 HTTP。
// 必须在 import http.ts 之前 hoist mock。vi.mock 工厂不能引用外部变量,故内联。
vi.mock("../../src/provider/factory.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../../src/provider/factory.js");
  return {
    ...actual,
    createProvider: () => new DoneProvider(),
  };
});

describe("REST 端点矩阵 (4.3)", () => {
  let workDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-http-"));
    port = await findFreePort();
    globalSessionManager.clear();
    globalApprovalManager.clear();
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
    globalApprovalManager.clear();
    await safeRm(workDir);
  });

  it("POST /sessions 创建 → GET /sessions/:id 查状态", async () => {
    const createRes = await request(port, "POST", "/sessions", {});
    expect(createRes.status).toBe(201);
    const createBody = createRes.body as { sessionId: string };
    expect(createBody.sessionId).toBeTruthy();

    const getRes = await request(port, "GET", `/sessions/${createBody.sessionId}`);
    expect(getRes.status).toBe(200);
    const getBody = getRes.body as Record<string, unknown>;
    expect(getBody["sessionId"]).toBe(createBody.sessionId);
    expect(getBody["length"]).toBe(0);
    expect(getBody["epoch"]).toBe(0);
    expect(getBody["createdAt"]).toBeTruthy();
  });

  it("POST /sessions/:id/messages 发消息(mock provider)→ 返回 reply", async () => {
    const createRes = await request(port, "POST", "/sessions", {});
    const sid = (createRes.body as { sessionId: string }).sessionId;

    const msgRes = await request(port, "POST", `/sessions/${sid}/messages`, {
      prompt: "你好",
    });
    expect(msgRes.status).toBe(200);
    const msgBody = msgRes.body as Record<string, unknown>;
    expect(msgBody["reply"]).toBe("任务完成:这是 mock 答案");
    expect(msgBody["sessionId"]).toBe(sid);
    expect(typeof msgBody["newMessageCount"]).toBe("number");
    expect(msgBody["newMessageCount"]).toBeGreaterThan(0);
  });

  it("POST /sessions/:id/messages 缺少 prompt → 400", async () => {
    const createRes = await request(port, "POST", "/sessions", {});
    const sid = (createRes.body as { sessionId: string }).sessionId;

    const msgRes = await request(port, "POST", `/sessions/${sid}/messages`, {});
    expect(msgRes.status).toBe(400);
    expect((msgRes.body as { error: string }).error).toContain("prompt");
  });

  it("POST /sessions/:id/messages 不存在的会话 → 404", async () => {
    const msgRes = await request(port, "POST", `/sessions/nope/messages`, {
      prompt: "x",
    });
    expect(msgRes.status).toBe(404);
  });

  it("GET /sessions/:id 不存在 → 404", async () => {
    const res = await request(port, "GET", `/sessions/nope`);
    expect(res.status).toBe(404);
  });

  it("POST /approvals/:taskId approve → 200(需先有待审批任务)", async () => {
    // 注册一个 pending 审批任务(模拟 Middleware 挂起的 taskId)
    const taskId = "task-approve-1";
    const pendingPromise = globalApprovalManager.waitForApproval(
      taskId,
      "bash",
      '{"command":"rm -rf x"}',
      () => {
        /* 不实际通知 */
      },
    );

    const res = await request(port, "POST", `/approvals/${taskId}`, {
      action: "approve",
      reason: "测试批准",
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body["taskId"]).toBe(taskId);
    expect(body["action"]).toBe("approve");

    // pending Promise 被唤醒
    const result = await pendingPromise;
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("测试批准");
  });

  it("POST /approvals/:taskId reject → 200,allowed=false", async () => {
    const taskId = "task-reject-1";
    const pendingPromise = globalApprovalManager.waitForApproval(
      taskId,
      "bash",
      '{"command":"rm -rf y"}',
      () => {},
    );

    const res = await request(port, "POST", `/approvals/${taskId}`, {
      action: "reject",
      reason: "测试拒绝",
    });
    expect(res.status).toBe(200);
    const result = await pendingPromise;
    expect(result.allowed).toBe(false);
  });

  it("POST /approvals/:taskId modify 缺 modifiedContent → 400", async () => {
    const res = await request(port, "POST", `/approvals/some-task`, {
      action: "modify",
    });
    expect(res.status).toBe(400);
  });

  it("POST /approvals/:taskId 不存在的任务 → 404", async () => {
    const res = await request(port, "POST", `/approvals/nonexistent`, {
      action: "approve",
    });
    expect(res.status).toBe(404);
  });

  it("GET /tools → 返回工具列表(非空)", async () => {
    const res = await request(port, "GET", `/tools`);
    expect(res.status).toBe(200);
    const body = res.body as { tools: ToolDefinition[] };
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    const names = body.tools.map((t) => t.name);
    // 默认注册表至少含 read_file / bash / write_file 等
    expect(names).toContain("read_file");
    expect(names).toContain("bash");
  });

  it("未知路由 → 404", async () => {
    const res = await request(port, "GET", `/unknown-path`);
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toContain("未知路由");
  });

  it("GET / → 404(无根路由)", async () => {
    const res = await request(port, "GET", `/`);
    expect(res.status).toBe(404);
  });
});
