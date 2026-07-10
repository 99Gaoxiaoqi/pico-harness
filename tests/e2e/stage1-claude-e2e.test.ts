// 阶段 1 Claude 流式真实 API 端到端测试。
// 验证 ClaudeProvider 的 generateStream 在真实兼容端点下的行为:
//   1. SSE 流式回调多次触发,delta 拼接等于最终 content
//   2. 流式模式下的工具调用(tool_use)累积正确
//
// 与 stage1-e2e.test.ts 的 OpenAI 流式测试对称,但走 Claude 协议。
// 凭证通过环境变量显式开启:
//   PICO_CLAUDE_E2E_BASE_URL / PICO_CLAUDE_E2E_API_KEY / PICO_CLAUDE_E2E_MODEL
// 未设置时自动 skip。
//
// 用法: npm run test:e2e -- tests/e2e/stage1-claude-e2e.test.ts

import { describe, it, expect } from "vitest";
import { ClaudeProvider } from "../../src/provider/claude.js";
import type { Message } from "../../src/schema/message.js";

// 注意:ClaudeProvider 内部 fetch 拼的是 `${baseURL}/messages`。
const BASE_URL = process.env.PICO_CLAUDE_E2E_BASE_URL;
const API_KEY = process.env.PICO_CLAUDE_E2E_API_KEY;
const MODEL = process.env.PICO_CLAUDE_E2E_MODEL ?? "kimi-k2.7-code";
const RUN_LLM_E2E = process.env.RUN_LLM_E2E === "1";

let endpointAvailable = false;
if (RUN_LLM_E2E && BASE_URL && API_KEY) {
  try {
    const probe = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    endpointAvailable = probe.ok;
  } catch {
    // 连接失败
  }
}

const describeOrSkip = endpointAvailable ? describe : describe.skip;

describeOrSkip("阶段 1 Claude 流式真实 API 测试", { timeout: 60000 }, () => {
  // ──────────────────────────────────────────────
  // 测试 1: 真实流式输出
  // ──────────────────────────────────────────────
  describe("流式输出 (真实 Claude 兼容 API)", () => {
    it("generateStream 回调被多次触发,delta 拼接等于最终 content", async () => {
      const provider = new ClaudeProvider({ baseURL: BASE_URL!, apiKey: API_KEY!, model: MODEL });

      const deltas: string[] = [];
      const messages: Message[] = [{ role: "user", content: "用一句话介绍你自己,不超过30个字" }];

      const result = await provider.generateStream(messages, [], (delta) => {
        deltas.push(delta);
      });

      // 验证 delta 被调用了多次
      expect(deltas.length).toBeGreaterThan(1);
      console.log(`[E2E Claude] 流式收到 ${deltas.length} 个 delta`);

      // 验证 delta 拼接等于最终 content
      const combined = deltas.join("");
      expect(combined).toBe(result.content);
      expect(result.content.length).toBeGreaterThan(0);
      console.log(`[E2E Claude] 最终内容: ${result.content.slice(0, 80)}...`);
    });
  });

  // ──────────────────────────────────────────────
  // 测试 2: 流式模式下的工具调用累积
  // ──────────────────────────────────────────────
  describe("流式模式下的工具调用累积 (真实 Claude 兼容 API)", () => {
    it("模型发出 tool_use,arguments 完整可解析", async () => {
      const provider = new ClaudeProvider({ baseURL: BASE_URL!, apiKey: API_KEY!, model: MODEL });

      const deltas: string[] = [];
      const messages: Message[] = [
        {
          role: "system",
          content: "你是 pico,一个有文件系统访问权限的编码助手。请使用 read_file 工具读取文件。",
        },
        {
          role: "user",
          content: "请读取 hello.txt 文件的内容",
        },
      ];

      const tools = [
        {
          name: "read_file",
          description: "读取文件内容",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ];

      const result = await provider.generateStream(messages, tools, (delta) => {
        deltas.push(delta);
      });

      // 验证模型发出了工具调用
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls!.length).toBeGreaterThan(0);
      expect(result.toolCalls![0].name).toBe("read_file");

      // 验证 toolCall 的 arguments 是完整可解析的 JSON,含 path 字段
      const args = JSON.parse(result.toolCalls![0].arguments);
      expect(args.path).toBeDefined();
      console.log(`[E2E Claude] 工具调用: ${result.toolCalls![0].name}(${args.path})`);
    });
  });
});
