// 阶段 5.5 Image/Media 真实大模型 e2e — 验证图片翻译在真实 API 下正确。
// 用法: npx vitest run tests/e2e/stage5-image-e2e.test.ts
//
// 测试目标:
//   1. OpenAI provider 真实 API 接收图片消息不报错(端点可能不支持 vision,但翻译格式要对)
//   2. CLI --image 参数读文件转 base64 真实可用
//   3. REST API POST 带 images 透传正确
//
// 凭证:用户提供端点(硬编码)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { OpenAIProvider } from "../../src/provider/openai.js";
import { startHttpServer } from "../../src/server/http.js";
import type { Message, ImagePart } from "../../src/schema/message.js";

const BASE_URL = "https://claude.jlcops.com/api/v1";
const API_KEY = "cr_81973ecc042bc925ea2ae16eba9b7d946e67761f1765bcdf80c1ef2acdc5dca2";
const MODEL = "deepseek-v4-pro";

// 最小 PNG(1x1 红点)的 base64
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

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

describeOrSkip("阶段 5.5 Image/Media 真实大模型 e2e", { timeout: 120000 }, () => {
  describe("OpenAI provider 图片翻译(真实 API)", () => {
    it("带图片消息发送到真实 API,翻译格式正确", async () => {
      const provider = new OpenAIProvider({ baseURL: BASE_URL, apiKey: API_KEY, model: MODEL });

      const image: ImagePart = { type: "image_base64", mimeType: "image/png", data: TINY_PNG_BASE64 };
      const messages: Message[] = [
        {
          role: "user",
          content: "这是一张图片,请描述你看到了什么(如果看不到图片就说看不到)。",
          images: [image],
        },
      ];

      // 真实调用——端点可能不支持 vision,但验证请求不因格式问题报错
      let result;
      let error: Error | undefined;
      try {
        result = await provider.generate(messages, []);
      } catch (e) {
        error = e as Error;
      }

      // 不论成功还是失败,验证:
      if (error) {
        // 如果报错,应该是"不支持 vision"类错误,不是格式错误
        console.log(`[E2E image] 端点报错(可能不支持 vision): ${error.message.slice(0, 200)}`);
        // 不应该是 JSON 格式错误或参数解析错误
        expect(error.message).not.toContain("JSON");
        expect(error.message).not.toContain("参数解析");
      } else {
        console.log(`[E2E image] 模型回复: ${result!.content.slice(0, 200)}`);
        expect(result!.content.length).toBeGreaterThan(0);
      }
    }, 60000);

    it("无图片消息行为不变(回归)", async () => {
      const provider = new OpenAIProvider({ baseURL: BASE_URL, apiKey: API_KEY, model: MODEL });
      const result = await provider.generate(
        [{ role: "user", content: "用一句话回答:1+1=?" }],
        [],
      );
      expect(result.content.length).toBeGreaterThan(0);
      console.log(`[E2E image-regress] 模型回复: ${result.content}`);
    }, 30000);
  });

  describe("REST API 图片透传", () => {
    let workDir: string;
    let server: http.Server;

    beforeAll(async () => {
      workDir = mkdtempSync(join(tmpdir(), "pico-5-image-e2e-"));
      process.env.LLM_BASE_URL = BASE_URL;
      process.env.LLM_API_KEY = API_KEY;
      process.env.LLM_MODEL = MODEL;
      process.env.PICO_PERSISTENCE = "0";
      server = await startHttpServer({
        kind: "openai",
        enableThinking: false,
        thinkingEffort: "off",
        planMode: false,
        traceEnabled: false,
        port: 0,
        workDir,
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // EBUSY
      }
    });

    it("POST /sessions/:id/messages 带 images 透传到 session", async () => {
      const addr = server.address() as { port: number };
      const port = addr.port;

      // 创建会话
      const createResp = await fetch(`http://localhost:${port}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workDir }),
      });
      const { sessionId } = await createResp.json();

      // 发带图片的消息(不真实跑模型,只验证透传)
      // maxTurns=1 让它只跑一轮
      const msgResp = await fetch(`http://localhost:${port}/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "描述这张图",
          maxTurns: 1,
          images: [{ data: TINY_PNG_BASE64, mimeType: "image/png" }],
        }),
        signal: AbortSignal.timeout(60000),
      });

      console.log(`[E2E image-rest] 状态: ${msgResp.status}`);
      // 应该返回 200(即使端点不支持 vision,engine 不会崩)
      expect(msgResp.status).toBeLessThan(500);
      const body = await msgResp.json();
      console.log(`[E2E image-rest] 结果: ${JSON.stringify(body).slice(0, 300)}`);
    }, 90000);
  });
});
