/**
 * 真实模型 E2E 测试：验证 Goal 停滞检测、延续协调器、评估器完整链路。
 *
 * 使用 mock provider 模拟真实多轮交互行为：
 * 1. 模型连续不调工具 → 延续协调器注入续行 → 评估器判断
 * 2. 模型连续相同工具调用 → 停滞检测递增 → 软提醒 → 硬终止
 * 3. turnTail 每轮反映最新 Goal 状态（预算消耗 + 停滞计数）
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GoalManager } from "../../src/engine/goal-manager.js";
import { PromptComposer } from "../../src/context/composer.js";
import { TodoStore } from "../../src/context/todo-store.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { Session } from "../../src/engine/session.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";
import type { LLMProvider } from "../../src/provider/interface.js";

/**
 * 场景 1：模型连续不调工具 + Goal active → 延续协调器应注入续行指令。
 * 评估器使用 mock（直接返回 met=true 让 Agent 退出）。
 */
test("real e2e: continuation coordinator injects when model stops without tools", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-goal-continue-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const goalManager = new GoalManager();
  const todoStore = new TodoStore(workDir, { picoHome });

  // 预创建一个 active goal
  goalManager.create("测试目标", "完成某项任务", { maxTurns: 10 });

  let turnCount = 0;
  const capturedUserMessages: string[] = [];

  const provider: LLMProvider = {
    modelName: "test-model",
    async generate(messages) {
      turnCount++;
      const lastUser = [...messages]
        .reverse()
        .find((m) => m.role === "user" && m.toolCallId === undefined);
      if (lastUser) capturedUserMessages.push(lastUser.content);

      // 模型始终不调工具，只输出文字（触发延续协调器）
      return { role: "assistant", content: `第 ${turnCount} 轮：我在思考中...` };
    },
  };

  const registry = new ToolRegistry();

  const promptLayersFactory = async ({
    currentUserPrompt: _currentUserPrompt,
  }: {
    currentUserPrompt: string;
  }) => {
    const composer = new PromptComposer(workDir, false, { goalManager, todoStore, picoHome });
    return composer.buildLayers();
  };

  const engine = new AgentEngine({
    provider,
    registry,
    workDir,
    promptLayersFactory,
    goalManager,
    reporter: new SilentReporter(),
    maxTurns: 5,
  });

  const session = new Session("goal-continue-test", workDir, { persistence: false, picoHome });
  context.after(() => session.close());
  await session.commitMessages({ role: "user", content: "帮我完成任务" });

  await engine.run(session);

  // 验证：模型连续不调工具时，应该看到 [Goal continuation] 续行指令被注入
  const continuationMessages = capturedUserMessages.filter((m) => m.includes("Goal continuation"));
  console.log(`[场景 1] 总轮次: ${turnCount}, 续行注入次数: ${continuationMessages.length}`);
  console.log("[场景 1] 续行消息示例:", continuationMessages[0]?.slice(0, 120));

  assert.ok(continuationMessages.length > 0, "模型不调工具时应注入 [Goal continuation] 续行指令");
});

/**
 * 场景 2：模型连续调相同工具 → 停滞检测递增 → 预算决策阻止。
 */
test("real e2e: stall detection increments on repeated identical tool calls", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-goal-stall-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const goalManager = new GoalManager();
  const todoStore = new TodoStore(workDir, { picoHome });

  // 预创建 goal，设 maxTurns=20 避免轮次预算先耗尽
  goalManager.create("停滞测试", "重复调同一个工具", { maxTurns: 20 });

  let turnCount = 0;

  const provider: LLMProvider = {
    modelName: "test-model",
    async generate() {
      turnCount++;
      // 模型每轮调相同的工具（模拟停滞）
      return {
        role: "assistant",
        content: "",
        toolCalls: [{ id: `call-${turnCount}`, name: "noop", arguments: '{"x":1}' }],
      };
    },
  };

  const registry = new ToolRegistry();
  registry.register({
    name: () => "noop",
    definition: () => ({
      name: "noop",
      description: "no-op",
      inputSchema: { type: "object", properties: {} },
    }),
    readOnly: true,
    async execute() {
      return "ok";
    },
  });

  const promptLayersFactory = async () => {
    const composer = new PromptComposer(workDir, false, { goalManager, todoStore, picoHome });
    return composer.buildLayers();
  };

  const engine = new AgentEngine({
    provider,
    registry,
    workDir,
    promptLayersFactory,
    goalManager,
    reporter: new SilentReporter(),
    maxTurns: 20,
  });

  const session = new Session("goal-stall-test", workDir, { persistence: false, picoHome });
  context.after(() => session.close());
  await session.commitMessages({ role: "user", content: "测试停滞" });

  await engine.run(session);

  const active = goalManager.getActive();
  console.log(`[场景 2] 总轮次: ${turnCount}`);
  console.log(`[场景 2] 停滞计数: ${active?.consecutiveNoProgress}`);
  console.log(`[场景 2] Goal 状态: ${active?.status}`);

  // 验证：停滞计数应递增（达到 8 轮后 currentBudgetDecision 阻止继续）
  assert.ok(
    (active?.consecutiveNoProgress ?? 0) >= 7,
    `停滞计数应 ≥7（8 轮硬终止），实际: ${active?.consecutiveNoProgress}`,
  );
});

/**
 * 场景 3：预算软提醒 — buildGoalContext 在接近预算上限时显示 ⚠ 预警。
 */
test("real e2e: budget reminder shows warning at 80% consumption", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-goal-budget-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const goalManager = new GoalManager();
  goalManager.create("预算测试", "验证预算提醒", {
    maxTurns: 10,
    maxTokens: 10000,
    maxCostCNY: 1.0,
  });

  // 模拟消耗 80%
  const active = goalManager.getActive()!;
  active.budgetUsage.turns = 8;
  active.budgetUsage.tokens = 8000;
  active.budgetUsage.costCNY = 0.8;

  const ctx = goalManager.buildGoalContext();
  console.log("[场景 3] Goal context:\n", ctx);

  assert.match(ctx, /剩余 2 轮 ⚠/u, "剩余 ≤20% 轮次应显示 ⚠");
  assert.match(ctx, /剩余 2000 tokens ⚠/u, "剩余 ≤20% token 应显示 ⚠");
  assert.match(ctx, /剩余 ¥0.2000 ⚠/u, "剩余 ≤20% 成本应显示 ⚠");
  assert.match(ctx, /已消耗: 8 轮/u, "应显示已消耗轮次");
});

/**
 * 场景 4：Goal 工具返回值（formatGoal）包含 budgetUsage 和停滞状态。
 */
test("real e2e: formatGoal includes budgetUsage and stall status", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-goal-format-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const goalManager = new GoalManager();
  goalManager.create("格式测试", "验证 formatGoal", { maxTurns: 10 });

  const active = goalManager.getActive()!;
  active.budgetUsage.turns = 5;
  active.budgetUsage.tokens = 5000;
  active.budgetUsage.costCNY = 0.5;
  active.consecutiveNoProgress = 4;

  const { GetGoalTool } = await import("../../src/tools/goal.js");
  const tool = new GetGoalTool(goalManager);
  const result = await tool.execute(JSON.stringify({}));

  console.log("[场景 4] get_goal 返回值:\n", result);

  assert.match(result, /已消耗: 5 轮/u, "formatGoal 应包含 budgetUsage");
  assert.match(result, /连续无进展: 4 轮/u, "formatGoal 应包含停滞状态（≥3）");
});
