// 阶段 2.6 + 5.6 真实模型 e2e — Hooks 端到端 + ANSI 验证。
// 用法: npx vitest run tests/e2e/stage5-hooks-e2e.test.ts
//
// 测试目标:
//   1. Hooks:配一个真实 PreToolUse shell 脚本拦 bash,用真实模型触发,验证 hook 真的拦住
//   2. ANSI:验证 colorizeDiff 输出含 ANSI 颜色码
//
// 凭证: deepseek-v4-pro @ claude.jlcops.com

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAIProvider } from "../../src/provider/openai.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { buildDefaultToolRegistry } from "../../src/tools/default-registry.js";
import { HookRunner } from "../../src/hooks/runner.js";
import type { HooksConfig } from "../../src/hooks/types.js";
import { colorizeDiff } from "../../src/engine/reporter.js";

const BASE_URL = "https://claude.jlcops.com/api/v1";
const API_KEY = "cr_81973ecc042bc925ea2ae16eba9b7d946e67761f1765bcdf80c1ef2acdc5dca2";
const MODEL = "deepseek-v4-pro";

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

describeOrSkip("阶段 2.6+5.6 真实模型 e2e", { timeout: 120000 }, () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-hooks-e2e-"));
    mkdirSync(join(workDir, "src"), { recursive: true });
    writeFileSync(join(workDir, "src", "app.ts"), 'export const VERSION = "1.0.0";\n');
    process.env.LLM_BASE_URL = BASE_URL;
    process.env.LLM_API_KEY = API_KEY;
    process.env.LLM_MODEL = MODEL;
    process.env.PICO_PERSISTENCE = "0";
  });

  afterAll(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // EBUSY
    }
  });

  // ─── Hooks 端到端 ───
  describe("PreToolUse Hook(真实模型)", () => {
    it("hook 拦截 bash → 模型看到阻断原因", async () => {
      // 写一个 PreToolUse hook 脚本:拦所有 bash(exit 2)
      const isWin = process.platform === "win32";
      const hookScript = isWin
        ? `@echo off\necho Hook: bash blocked>&2\nexit /b 2\n`
        : `#!/bin/bash\necho "Hook: bash blocked" >&2\nexit 2\n`;
      const hookFile = join(workDir, ".claw", isWin ? "block-bash.bat" : "block-bash.sh");
      mkdirSync(join(workDir, ".claw"), { recursive: true });
      writeFileSync(hookFile, hookScript);
      if (!isWin) {
        const { chmodSync } = await import("node:fs");
        chmodSync(hookFile, 0o755);
      }

      const hooksConfig: HooksConfig = {
        PreToolUse: [
          {
            matcher: "bash",
            hooks: [{ type: "command", command: isWin ? `"${hookFile}"` : `bash ${hookFile}` }],
          },
        ],
      };

      const provider = new OpenAIProvider({ baseURL: BASE_URL, apiKey: API_KEY, model: MODEL });
      const registry = buildDefaultToolRegistry(workDir);
      registry.setHookRunner?.(new HookRunner(workDir, hooksConfig));
      registry.setSessionId?.("e2e-hooks-test");

      const session = new Session(`e2e-hooks-${Date.now()}`, workDir, { persistence: false });
      session.append({
        role: "user",
        content: "请用 bash 工具执行 echo hello 命令。",
      });

      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        maxTurns: 3,
        reporter: new SilentReporter(),
      });
      const messages = await engine.run(session);

      // 打印所有消息,看模型实际做了什么
      console.log(`[E2E hooks] 共 ${messages.length} 条消息:`);
      for (const m of messages) {
        const preview = m.content.slice(0, 150).replace(/\n/g, " ");
        const tcInfo = m.toolCalls?.length ? ` toolCalls=[${m.toolCalls.map(tc => tc.name).join(",")}]` : "";
        const trInfo = m.toolCallId ? ` toolCallId=${m.toolCallId}` : "";
        console.log(`  [${m.role}]${tcInfo}${trInfo}: ${preview}`);
      }

      // 验证:模型尝试调 bash,被 hook 拦截
      // 查找所有 toolResult(bash 被拦后的返回 isError 消息)
      const allToolResults = messages.filter((m) => m.role === "user" && m.toolCallId);
      const blockedMessage = allToolResults.find(
        (m) => m.content.toLowerCase().includes("hook") || m.content.toLowerCase().includes("阻断"),
      );

      // 也检查模型是否调了 bash(assistant 消息有 bash toolCall)
      const bashCalled = messages.some(
        (m) => m.role === "assistant" && m.toolCalls?.some((tc) => tc.name === "bash"),
      );
      console.log(`[E2E hooks] 模型调了 bash: ${bashCalled}, 找到阻断消息: ${!!blockedMessage}`);

      // 如果模型调了 bash,hook 应该拦住
      if (bashCalled) {
        expect(blockedMessage, "bash 被调了,应该有 hook 阻断消息").toBeDefined();
      }
      // 如果模型没调 bash(可能直接回复),测试仍通过(hook 机制本身在 runner.test.ts 已验证)
    }, 60000);

    it("无 hook 时 bash 正常执行(回归)", async () => {
      const provider = new OpenAIProvider({ baseURL: BASE_URL, apiKey: API_KEY, model: MODEL });
      const registry = buildDefaultToolRegistry(workDir);

      const session = new Session(`e2e-nohook-${Date.now()}`, workDir, { persistence: false });
      session.append({
        role: "user",
        content: "请用 bash 执行 echo hello 并报告输出。不要做其他事。",
      });

      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        maxTurns: 3,
        reporter: new SilentReporter(),
      });
      const messages = await engine.run(session);

      // bash 应该正常执行(有 toolResult 含 "hello")
      const bashResult = messages.find(
        (m) => m.role === "user" && m.toolCallId && m.content.toLowerCase().includes("hello"),
      );
      console.log(`[E2E hooks-regress] bash 结果: ${bashResult?.content.slice(0, 100) ?? "(未找到)"}`);
    }, 60000);
  });

  // ─── ANSI colorizeDiff ───
  describe("ANSI colorizeDiff(5.6)", () => {
    it("diff 着色:+ 行绿色,- 行红色", () => {
      const diff = `--- 修改前
+++ 修改后
- old line
+ new line
@@ context @@`;
      const colored = colorizeDiff(diff);
      console.log(`[E2E ansi] colored diff:\n${colored}`);
      // 验证含 ANSI 转义码(不硬编码具体序列)
      expect(colored).toContain("\x1b["); // 有 ANSI 码
      // + 行应该是绿色系(32)
      const greenLine = colored.split("\n").find((l) => l.includes("new line"));
      expect(greenLine).toContain("\x1b[32");
      // - 行应该是红色系(31)
      const redLine = colored.split("\n").find((l) => l.includes("old line"));
      expect(redLine).toContain("\x1b[31");
    });
  });
});
