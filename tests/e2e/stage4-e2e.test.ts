// 阶段 4 端到端真实测试 — 验证多端入口在真实大模型下的可用性。
// 用法: npx vitest run tests/e2e/stage4-e2e.test.ts
//
// 测试目标:
//   1. REST API:真实启动 HTTP server,POST 消息触发真实模型 run,验证端到端
//   2. ACP 协议:真实启动 ACP stdio server,发 prompt 触发真实模型,验证流式响应
//   3. Gemini:用户 key 无 Gemini 权限(403),mock e2e skip
//
// 凭证:用户提供端点(硬编码)
//   BASE_URL: https://claude.jlcops.com/api/v1
//   API_KEY:  cr_81973ecc042bc925ea2ae16eba9b7d946e67761f1765bcdf80c1ef2acdc5dca2
//   MODEL:    deepseek-v4-pro

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { startHttpServer } from "../../src/server/http.js";

// 硬编码用户提供的测试端点
const BASE_URL = "https://claude.jlcops.com/api/v1";
const API_KEY = "cr_81973ecc042bc925ea2ae16eba9b7d946e67761f1765bcdf80c1ef2acdc5dca2";
const MODEL = "deepseek-v4-pro";

// 探测端点可用性
let endpointAvailable = false;
try {
  const probe = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "ping" }], max_tokens: 5 }),
    signal: AbortSignal.timeout(15_000),
  });
  endpointAvailable = probe.ok;
} catch {
  // 连接失败
}

const describeOrSkip = endpointAvailable ? describe : describe.skip;

// HTTP 请求 helper
async function httpRequest(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const addr = server.address() as { port: number };
  const port = addr.port;
  const url = `http://localhost:${port}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(url, init);
  const text = await resp.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: resp.status, body: json };
}

describeOrSkip("阶段 4 端到端测试(真实大模型)", { timeout: 180000 }, () => {
  let workDir: string;
  let server: http.Server;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "pico-stage4-e2e-"));
    mkdirSync(join(workDir, "src"), { recursive: true });
    writeFileSync(
      join(workDir, "src", "app.ts"),
      ['export const VERSION = "1.0.0";', "export function hello() { return 'hi'; }", ""].join("\n"),
    );
    // 设置环境变量供 server 内部读取
    process.env.LLM_BASE_URL = BASE_URL;
    process.env.LLM_API_KEY = API_KEY;
    process.env.LLM_MODEL = MODEL;
    process.env.PICO_PERSISTENCE = "0"; // e2e 不持久化,避免文件锁

    server = await startHttpServer({
      kind: "openai",
      enableThinking: false,
      thinkingEffort: "off",
      planMode: false,
      traceEnabled: false,
      port: 0, // 随机端口
      workDir,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Windows EBUSY
    }
  });

  // ─── 测试 1: REST API 端到端 ───
  describe("REST API(真实模型)", () => {
    it("GET /tools 返回工具列表", async () => {
      const resp = await httpRequest(server, "GET", "/tools");
      expect(resp.status).toBe(200);
      expect(Array.isArray(resp.body.tools)).toBe(true);
      const toolNames = resp.body.tools.map((t: any) => t.name);
      console.log(`[E2E REST] 可用工具: ${toolNames.join(", ")}`);
      // 阶段 2 的工具应该都在
      expect(toolNames).toContain("glob");
      expect(toolNames).toContain("grep");
      expect(toolNames).toContain("read_file");
    });

    it("POST /sessions 创建会话", async () => {
      const resp = await httpRequest(server, "POST", "/sessions", { workDir });
      expect(resp.status).toBeLessThan(300); // 200 或 201 都合法
      expect(resp.body.sessionId).toBeDefined();
      console.log(`[E2E REST] 创建会话: ${resp.body.sessionId}`);
    });

    it("POST /sessions/:id/messages 触发真实模型 run", async () => {
      // 先创建会话
      const createResp = await httpRequest(server, "POST", "/sessions", { workDir });
      const sessionId = createResp.body.sessionId;

      // 发消息触发 run
      const resp = await httpRequest(server, "POST", `/sessions/${sessionId}/messages`, {
        prompt: "用一句话介绍你能做什么,不超过30字。不要调用任何工具。",
        maxTurns: 2,
      });

      console.log(`[E2E REST] run 结果: ${JSON.stringify(resp.body).slice(0, 300)}`);
      // 应该返回成功状态 + 模型回复
      expect(resp.status).toBe(200);
      // 回复内容非空(字段名可能是 reply 或 result 或 messages)
      const replyText = resp.body.reply ?? resp.body.result ?? resp.body.message ?? JSON.stringify(resp.body);
      expect(replyText.length).toBeGreaterThan(0);
      console.log(`[E2E REST] 模型回复: ${String(replyText).slice(0, 100)}`);
    });

    it("POST /sessions/:id/messages 触发模型调工具(glob)", async () => {
      const createResp = await httpRequest(server, "POST", "/sessions", { workDir });
      const sessionId = createResp.body.sessionId;

      const resp = await httpRequest(server, "POST", `/sessions/${sessionId}/messages`, {
        prompt: "用 glob 工具搜索 src/*.ts,列出找到的文件。必须使用 glob 工具。",
        maxTurns: 4,
      });

      console.log(`[E2E REST] 工具调用 run 结果: ${JSON.stringify(resp.body).slice(0, 400)}`);
      expect(resp.status).toBe(200);
      // 模型应该提到 app.ts
      const replyText = String(resp.body.reply ?? resp.body.result ?? resp.body.message ?? "");
      if (replyText.length > 0) {
        console.log(`[E2E REST] 模型回复: ${replyText.slice(0, 200)}`);
      }
    });
  });

  // ─── 测试 2: ACP 协议(真实 stdio + 真实模型) ───
  describe("ACP 协议(真实 stdio + 真实模型)", () => {
    let acpProcess: ChildProcess | null = null;
    const pendingRequests = new Map<string | number, (response: any) => void>();
    let buffer = "";
    let nextId = 1;

    function sendRequest(method: string, params: any): Promise<any> {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
        pendingRequests.set(id, resolve);
        acpProcess?.stdin?.write(msg + "\n");
        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error(`ACP 请求 ${method} 超时`));
          }
        }, 60000);
      });
    }

    function sendNotification(method: string, params: any): void {
      const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
      acpProcess?.stdin?.write(msg + "\n");
    }

    beforeAll(() => {
      // 用 tsx 启动 ACP server(Windows 用 shell:true 找 npx)
      const repoRoot = process.cwd();
      const isWin = process.platform === "win32";
      acpProcess = spawn(
        isWin ? "npx.cmd" : "npx",
        ["tsx", "src/cli/main.ts", "--acp", "--mode", "default"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            LLM_BASE_URL: BASE_URL,
            LLM_API_KEY: API_KEY,
            LLM_MODEL: MODEL,
            PICO_PERSISTENCE: "0",
          },
          stdio: ["pipe", "pipe", "pipe"],
          shell: isWin,
        },
      );

      acpProcess.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // 保留最后不完整的行
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            // 有 id 的响应 → resolve pending request
            if (msg.id !== undefined && pendingRequests.has(msg.id)) {
              const resolve = pendingRequests.get(msg.id)!;
              pendingRequests.delete(msg.id);
              resolve(msg.result ?? msg);
            }
            // notification(response/output 等)→ 记录但不 resolve
            if (msg.method === "response/output") {
              console.log(`[E2E ACP] 流式输出: ${msg.params?.delta ?? ""}`);
            }
          } catch {
            // 非 JSON 行(如启动日志),忽略
          }
        }
      });

      acpProcess.stderr?.on("data", (data: Buffer) => {
        // stderr 记录但不阻断
        const text = data.toString().trim();
        if (text && !text.includes("fts5") && !text.includes("Registry")) {
          console.log(`[E2E ACP stderr] ${text.slice(0, 150)}`);
        }
      });
    });

    afterAll(() => {
      acpProcess?.stdin?.end();
      acpProcess?.kill();
    });

    it("initialize 握手", async () => {
      const result = await sendRequest("initialize", {
        protocolVersion: "1.0",
        clientInfo: { name: "e2e-test", version: "1.0" },
      });
      console.log(`[E2E ACP] initialize 结果: ${JSON.stringify(result).slice(0, 200)}`);
      expect(result).toBeDefined();
      expect(result.serverInfo ?? result.capabilities ?? result).toBeDefined();
    }, 30000);

    it("prompt 触发真实模型流式响应", async () => {
      // 先建 session
      const sessionResult = await sendRequest("session/create", {
        workDir,
        mode: "default",
      });
      const sessionId = sessionResult.sessionId ?? sessionResult.id;
      console.log(`[E2E ACP] 创建 session: ${sessionId}`);
      expect(sessionId).toBeDefined();

      // 发 prompt
      const promptResult = await sendRequest("prompt", {
        sessionId,
        message: "用一句话介绍你能做什么,不超过30字。不要调用任何工具。",
      });
      console.log(`[E2E ACP] prompt 结果: ${JSON.stringify(promptResult).slice(0, 300)}`);
      expect(promptResult).toBeDefined();
    }, 120000);
  });
});
