import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { OpenAIProvider } from "../../src/provider/openai.js";
import { CostTracker } from "../../src/observability/tracker.js";
import type { LLMProvider, Message } from "../../src/provider/interface.js";
import { CheckpointManager } from "../../src/safety/checkpoint-manager.js";
import { PermissionManager, type PolicyContext } from "../../src/approval/policy.js";
import {
  ToolRegistry,
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
} from "../../src/tools/registry-impl.js";
import type { ToolCall } from "../../src/schema/message.js";

function readDotEnv(): Record<string, string> {
  try {
    const envContent = readFileSync(".env", "utf8");
    return Object.fromEntries(
      envContent
        .split("\n")
        .map((line) => line.match(/^([^#=]+)=(.*)$/))
        .filter((m): m is RegExpMatchArray => !!m)
        .map((m) => [m[1]!.trim(), m[2]!.trim()]),
    );
  } catch {
    return {};
  }
}

const dotEnv = readDotEnv();
const BASE_URL = process.env.LLM_BASE_URL ?? dotEnv.LLM_BASE_URL;
const API_KEY = process.env.LLM_API_KEY ?? dotEnv.LLM_API_KEY;
const MODEL = process.env.LLM_MODEL ?? dotEnv.LLM_MODEL;
const RUN_LLM_E2E = process.env.RUN_LLM_E2E === "1" || process.env.PICO_LLM_E2E === "1";
const describeRealLLM = RUN_LLM_E2E && BASE_URL && API_KEY && MODEL ? describe : describe.skip;

describe("阶段 1 端到端测试", { timeout: 240_000 }, () => {
  // ──────────────────────────────────────────────
  // 测试 1: 真实流式输出
  // ──────────────────────────────────────────────
  describeRealLLM("流式输出 (真实 API)", () => {
    it("generateStream 回调被多次触发，delta 拼接等于最终 content", async () => {
      const provider = new OpenAIProvider({
        baseURL: BASE_URL!,
        apiKey: API_KEY!,
        model: MODEL!,
      });

      const deltas: string[] = [];
      const messages: Message[] = [{ role: "user", content: "用一句话介绍你自己，不超过30个字" }];

      const result = await provider.generateStream!(messages, [], (delta) => {
        deltas.push(delta);
      });

      // 验证 delta 回调至少被触发一次
      expect(deltas.length).toBeGreaterThan(0);
      console.log(`[E2E] 流式收到 ${deltas.length} 个 delta`);

      // 验证 delta 拼接等于最终 content
      const combined = deltas.join("");
      expect(combined).toBe(result.content);
      expect(result.content.length).toBeGreaterThan(0);
      console.log(`[E2E] 最终内容: ${result.content.slice(0, 80)}...`);
    });

    it("流式模式下的工具调用累积正确", async () => {
      const provider = new OpenAIProvider({
        baseURL: BASE_URL!,
        apiKey: API_KEY!,
        model: MODEL!,
      });

      const deltas: string[] = [];
      const messages: Message[] = [
        {
          role: "system",
          content: "你是 pico，一个有文件系统访问权限的编码助手。请使用 read_file 工具读取文件。",
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

      const result = await provider.generateStream!(messages, tools, (delta) => {
        deltas.push(delta);
      });

      // 验证模型发出了工具调用
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls!.length).toBeGreaterThan(0);
      expect(result.toolCalls![0].name).toBe("read_file");

      // 验证 toolCall 的 arguments 是完整可解析的 JSON
      const args = JSON.parse(result.toolCalls![0].arguments);
      expect(args.path).toBeDefined();
      console.log(`[E2E] 工具调用: ${result.toolCalls![0].name}(${args.path})`);
    });
  });

  // ──────────────────────────────────────────────
  // 测试 2: 非流式降级
  // ──────────────────────────────────────────────
  describe("非流式降级", () => {
    it("CostTracker 包装无 generateStream 的 provider 时降级到 generate", async () => {
      const mockProvider: LLMProvider = {
        async generate() {
          return { role: "assistant", content: "mock response" };
        },
        modelName: "mock",
      };

      const tracker = new CostTracker(mockProvider, "mock-model");

      const deltas: string[] = [];
      const result = await tracker.generateStream([], [], (delta) => deltas.push(delta));

      // 降级到 generate，不会调 onDelta
      expect(deltas.length).toBe(0);
      expect(result.content).toBe("mock response");
    });
  });

  // ──────────────────────────────────────────────
  // 测试 3: Permission Policy 链
  // ──────────────────────────────────────────────
  describe("Permission Policy 链", () => {
    const manager = new PermissionManager();

    function makeCall(name: string, args: Record<string, unknown>): ToolCall {
      return { id: "c1", name, arguments: JSON.stringify(args) };
    }
    function makeCtx(call: ToolCall, overrides: Partial<PolicyContext> = {}): PolicyContext {
      return {
        toolCall: call,
        workDir: "/project",
        planMode: false,
        sessionApprovals: new Set(),
        ...overrides,
      };
    }

    it("敏感文件 .env → ask", () => {
      const result = manager.evaluate(
        makeCtx(makeCall("write_file", { path: ".env", content: "KEY=val" })),
      );
      expect(result.decision).toBe("ask");
    });

    it("Plan Mode + 写 src/a.ts → deny", () => {
      const result = manager.evaluate(
        makeCtx(makeCall("write_file", { path: "src/a.ts", content: "x" }), { planMode: true }),
      );
      expect(result.decision).toBe("deny");
    });

    it("高危命令 rm -rf / → deny", () => {
      const result = manager.evaluate(makeCtx(makeCall("bash", { command: "rm -rf /" })));
      expect(result.decision).toBe("deny");
    });

    it("Session 审批记忆短路", () => {
      const call = makeCall("write_file", { path: "src/a.ts", content: "x" });
      manager.rememberApproval(call);
      const result = manager.evaluate(
        makeCtx(call, { sessionApprovals: manager.sessionApprovals }),
      );
      expect(result.decision).toBe("allow");
    });
  });

  // ──────────────────────────────────────────────
  // 测试 4: Checkpoint git 快照
  // ──────────────────────────────────────────────
  describe("Checkpoint git 快照", () => {
    let workDir: string;

    beforeAll(() => {
      workDir = mkdtempSync(join(tmpdir(), "pico-e2e-cp-"));
      execSync("git init", { cwd: workDir });
      execSync('git config user.email "test@test.com"', { cwd: workDir });
      execSync('git config user.name "Test"', { cwd: workDir });
      writeFileSync(join(workDir, "file.txt"), "original\n");
      execSync("git add -A", { cwd: workDir });
      execSync("git commit -m initial", { cwd: workDir });
    });

    it("创建快照 → 修改文件 → 回滚 → 验证恢复", async () => {
      const manager = new CheckpointManager(workDir);

      // 修改文件
      writeFileSync(join(workDir, "file.txt"), "modified\n");
      expect(readFileSync(join(workDir, "file.txt"), "utf8")).toBe("modified\n");

      // 创建快照
      const cpId = await manager.createCheckpoint("test write");
      expect(cpId).not.toBeNull();
      console.log(`[E2E] Checkpoint ID: ${cpId}`);

      // 继续修改
      writeFileSync(join(workDir, "file.txt"), "more changes\n");

      // 回滚
      const ok = await manager.rollback(cpId!);
      expect(ok).toBe(true);

      // 验证恢复到快照时的状态
      const content = readFileSync(join(workDir, "file.txt"), "utf8");
      expect(content).toBe("modified\n");
    });
  });

  // ──────────────────────────────────────────────
  // 测试 5: Diff 预览
  // ──────────────────────────────────────────────
  describe("Diff 预览", () => {
    let workDir: string;
    let registry: ToolRegistry;

    beforeAll(() => {
      workDir = mkdtempSync(join(tmpdir(), "pico-e2e-diff-"));
      registry = new ToolRegistry();
      registry.register(new ReadFileTool(workDir));
      registry.register(new WriteFileTool(workDir));
      registry.register(new EditFileTool(workDir));
    });

    it("edit_file 返回 diff 预览", async () => {
      writeFileSync(join(workDir, "app.ts"), "function hello() {\n  return 1;\n}\n");

      const result = await registry.execute({
        id: "c1",
        name: "edit_file",
        arguments: JSON.stringify({
          path: "app.ts",
          old_text: "return 1;",
          new_text: "return 42;",
        }),
      });

      expect(result.output).toContain("修改前");
      expect(result.output).toContain("修改后");
      expect(result.output).toContain("- return 1;");
      expect(result.output).toContain("+ return 42;");
      console.log(`[E2E] Diff:\n${result.output}`);
    });

    it("write_file 新建标记", async () => {
      const result = await registry.execute({
        id: "c2",
        name: "write_file",
        arguments: JSON.stringify({ path: "new.ts", content: "export const x = 1;\n" }),
      });
      expect(result.output).toContain("新建");
    });
  });
});
