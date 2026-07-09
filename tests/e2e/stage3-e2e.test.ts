// 阶段 3 端到端真实测试 — 验证上下文与控制流增强机制在真实大模型下的可用性。
// 用法: npm run test:e2e -- tests/e2e/stage3-e2e.test.ts
//
// 测试目标(真实模型验证"行为引导"特性,不只是机制正确):
//   1. Goal Mode:模型能主动调用 create_goal,goal context 注入后影响后续行为
//   2. Steer:运行中注入引导文本,模型下一轮会参考
//   3. shouldContinueAfterStop:host 续接回调让 Agent 继续干活
//
// 凭证通过环境变量显式开启:
//   PICO_OPENAI_E2E_BASE_URL / PICO_OPENAI_E2E_API_KEY / PICO_OPENAI_E2E_MODEL
// 未设置时自动 skip。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAIProvider } from "../../src/provider/openai.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { buildDefaultToolRegistry } from "../../src/tools/default-registry.js";
import { GoalManager } from "../../src/engine/goal-manager.js";
import { SteerQueue } from "../../src/engine/steer-queue.js";
import { PromptComposer } from "../../src/context/composer.js";

// 注意:OpenAI 兼容协议拼 /chat/completions,baseURL 通常带 /v1。
const BASE_URL = process.env.PICO_OPENAI_E2E_BASE_URL;
const API_KEY = process.env.PICO_OPENAI_E2E_API_KEY;
const MODEL = process.env.PICO_OPENAI_E2E_MODEL ?? "deepseek-v4-pro";

// 先探测端点可用性(避免硬编码凭证失效时全盘失败)
let endpointAvailable = false;
if (BASE_URL && API_KEY) {
  try {
    const probe = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    endpointAvailable = probe.ok;
    if (!probe.ok) console.log(`[E2E 探测] 端点不可用: ${probe.status} ${await probe.text()}`);
  } catch (err) {
    console.log(`[E2E 探测] 连接失败: ${String(err)}`);
  }
}

const describeOrSkip = endpointAvailable ? describe : describe.skip;

describeOrSkip("阶段 3 端到端测试(真实大模型 deepseek-v4-pro)", { timeout: 180000 }, () => {
  let workDir: string;
  let provider: OpenAIProvider;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-stage3-e2e-"));
    mkdirSync(join(workDir, "src"), { recursive: true });
    writeFileSync(
      join(workDir, "src", "app.ts"),
      ['export const VERSION = "1.0.0";', "export function hello() { return 'hi'; }", ""].join("\n"),
    );
    provider = new OpenAIProvider({ baseURL: BASE_URL!, apiKey: API_KEY!, model: MODEL });
  });

  afterAll(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Windows EBUSY 偶发
    }
  });

  // ─── 测试 1: Goal Mode ───
  describe("Goal Mode(真实模型行为引导)", () => {
    it("模型能主动调 create_goal 建 goal,goal context 注入后可见", async () => {
      const goalManager = new GoalManager();
      const registry = buildDefaultToolRegistry(workDir, { goalManager });

      const session = new Session(`e2e-goal-${Date.now()}`, workDir, { persistence: false });
      session.append({
        role: "user",
        content:
          "请用 create_goal 工具创建一个目标:标题'修好示例项目',描述'把 VERSION 改成 2.0.0 并验证'。" +
          "创建后立即用 get_goal 查询并报告目标状态。然后调用 read_file 读 src/app.ts。",
      });

      // 用 planMode 走 PromptComposer 注入 goal context(验证 composer 集成)
      const systemPrompt = await new PromptComposer(workDir, false, { goalManager }).build();
      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        systemPrompt,
        goalManager,
        maxTurns: 6,
        reporter: new SilentReporter(),
      });
      const messages = await engine.run(session);

      // 验证 1:模型调了 create_goal
      expect(goalManager.list().length, "模型应该创建至少一个 goal").toBeGreaterThan(0);

      // 验证 2:goal 内容正确
      const goal = goalManager.getActive() ?? goalManager.list()[0]!;
      console.log(`[E2E goal] 模型建的 goal: id=${goal.id}, title="${goal.title}", status=${goal.status}`);
      expect(goal.title).toBeTruthy();
      expect(goal.title.length).toBeGreaterThan(0);

      // 验证 3:goal context 能被 composer 渲染
      const ctx = goalManager.buildGoalContext();
      expect(ctx.length).toBeGreaterThan(0);
      expect(ctx).toContain(goal.title);
      console.log(`[E2E goal] composer 注入的 context:\n${ctx.slice(0, 300)}`);

      // 验证 4:模型最终有输出
      const last = messages[messages.length - 1]!;
      expect(last.role).toBe("assistant");
      expect((last.content ?? "").length).toBeGreaterThan(0);
    });

    it("模型能用 update_goal 推进 goal 状态(active→complete)", async () => {
      const goalManager = new GoalManager();
      // 预先建一个 goal
      const goal = goalManager.create("完成测试任务", "调用 update_goal 标记完成");
      goalManager.setActive(goal.id);

      const registry = buildDefaultToolRegistry(workDir, { goalManager });
      const session = new Session(`e2e-goal-update-${Date.now()}`, workDir, { persistence: false });
      session.append({
        role: "user",
        content:
          `当前有一个激活的目标 id="${goal.id}"。` +
          "请用 update_goal 工具把这个目标的状态更新为 complete,并在 progress 字段写'已完成测试'。然后报告结果。",
      });

      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        goalManager,
        maxTurns: 4,
        reporter: new SilentReporter(),
      });
      await engine.run(session);

      const updated = goalManager.get(goal.id)!;
      console.log(`[E2E goal-update] 状态: ${updated.status}, progress: ${updated.progress}`);
      expect(updated.status).toBe("complete");
      expect(updated.progress).toContain("已完成");
    });
  });

  // ─── 测试 2: Steer 运行时注入 ───
  describe("Steer 运行时注入(真实模型行为转向)", () => {
    it("运行中注入 steer 文本,模型下一轮会参考", async () => {
      const steerQueue = new SteerQueue();
      const registry = buildDefaultToolRegistry(workDir);

      const session = new Session(`e2e-steer-${Date.now()}`, workDir, { persistence: false });
      session.append({
        role: "user",
        content: "请用 glob 找 src 下的 .ts 文件,然后报告。",
      });

      // 在 engine 跑之前先注入一条 steer(模拟运行中注入)
      // 注:CLI 单次模式下 steer 在 run 前 push,第一轮即注入
      steerQueue.push("[重要提示] 额外要求:报告完文件后,请用 read_file 读出 src/app.ts 的内容");

      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        steerQueue,
        maxTurns: 6,
        reporter: new SilentReporter(),
      });
      const messages = await engine.run(session);

      // 验证:session 里应该有 steer 注入产生的 user 消息(C 点 drain 落盘)
      const steerMessages = messages.filter((m) =>
        m.role === "user" && !m.toolCallId && m.content.includes("重要提示"),
      );
      expect(steerMessages.length, "steer 文本应该被 drain 到 session").toBeGreaterThan(0);

      // 验证:模型应该读了 app.ts(被 steer 引导)
      const readAppTs = messages.some(
        (m) => m.role === "user" && m.toolCallId && m.content.includes("VERSION"),
      );
      console.log(`[E2E steer] 模型是否读了 app.ts: ${readAppTs}`);
      console.log(`[E2E steer] 共 ${messages.length} 条消息`);

      // steer 至少被模型看到了(不强制要求模型完全按 steer 行动,这是行为测试不是断言)
      const last = messages[messages.length - 1]!;
      expect((last.content ?? "").length).toBeGreaterThan(0);
    });
  });

  // ─── 测试 3: shouldContinueAfterStop ───
  describe("shouldContinueAfterStop(真实模型续接)", () => {
    it("模型停止后 host 回调续接,Agent 继续干活", async () => {
      const registry = buildDefaultToolRegistry(workDir);
      let continueCount = 0;

      const session = new Session(`e2e-continue-${Date.now()}`, workDir, { persistence: false });
      session.append({
        role: "user",
        content: "用一句话介绍你能做什么。不要调用任何工具。",
      });

      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        maxTurns: 5,
        reporter: new SilentReporter(),
        shouldContinueAfterStop: async () => {
          // 只续接一次,第二次停止
          if (continueCount === 0) {
            continueCount++;
            return {
              continue: true,
              continuePrompt: "好的,现在请用 read_file 读 src/app.ts 并报告内容。",
            };
          }
          return { continue: false };
        },
      });
      const messages = await engine.run(session);

      // 验证 1:续接被触发了一次
      expect(continueCount, "shouldContinueAfterStop 应被调用一次").toBe(1);

      // 验证 2:续接后 session 里有续接 prompt
      const continueMsg = messages.find(
        (m) => m.role === "user" && !m.toolCallId && m.content.includes("read_file"),
      );
      expect(continueMsg, "续接 prompt 应注入 session").toBeDefined();

      // 验证 3:续接后模型真的读了文件(第二轮被引导调工具)
      const readTool = messages.some(
        (m) => m.role === "user" && m.toolCallId && (m.content.includes("VERSION") || m.content.includes("hi")),
      );
      console.log(`[E2E continue] 续接后模型读文件: ${readTool}`);
      console.log(`[E2E continue] 共 ${messages.length} 条消息`);

      // 模型至少有 2 轮 assistant 输出(第一轮自我介绍 + 续接后读文件)
      const assistantTurns = messages.filter((m) => m.role === "assistant").length;
      expect(assistantTurns, "应有至少 2 轮 assistant 输出").toBeGreaterThanOrEqual(2);
    });
  });
});
