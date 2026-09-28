/** Goal v2 evaluator outcomes, budgets, and durable context projection. */
import assert from "node:assert/strict";
import test from "node:test";
import { GoalManager } from "@pico/runtime/goal-manager";

function createManager(blockCap = 8) {
  const manager = new GoalManager({ now: () => 1_700_000_000_000 });
  const goal = manager.create({
    title: "测试目标",
    description: "按 evaluator 的 Run 级结果结算进展",
    completionCriteria: ["结果可验证"],
    blockCap,
  });
  return { manager, goal };
}

test("Goal progress evidence resets consecutive no-progress count", () => {
  const { manager, goal } = createManager();
  manager.settle({ outcome: "progress", progress: false, reason: "暂无变化", evidence: [] });
  manager.settle({ outcome: "progress", progress: false, reason: "仍无变化", evidence: [] });
  assert.equal(manager.get(goal.id)?.consecutiveNoProgress, 2);

  manager.settle({
    outcome: "progress",
    progress: true,
    reason: "已验证一个子结果",
    evidence: ["测试结果通过"],
  });
  assert.equal(manager.get(goal.id)?.consecutiveNoProgress, 0);
  assert.deepEqual(manager.get(goal.id)?.evidence, ["测试结果通过"]);
});

test("an unavailable evaluator preserves the no-progress count and keeps a continuation intent", () => {
  const { manager, goal } = createManager();
  manager.settle({ outcome: "progress", progress: false, reason: "无进展", evidence: [] });
  manager.settle({
    outcome: "progress",
    progress: false,
    reason: "",
    evidence: [],
    evaluatorFailed: true,
  });

  assert.equal(manager.get(goal.id)?.consecutiveNoProgress, 1);
  assert.equal(manager.get(goal.id)?.pendingContinuation, true);
  assert.equal(manager.get(goal.id)?.lastEvaluation?.outcome, "unknown");
});

test("the warning precedes the eight-Run stalled terminal state", () => {
  const { manager, goal } = createManager(8);
  for (let index = 0; index < 5; index++) {
    manager.settle({ outcome: "progress", progress: false, reason: "无进展", evidence: [] });
  }
  assert.match(manager.getStallWarning() ?? "", /连续 5 轮无进展/u);

  for (let index = 5; index < 8; index++) {
    manager.settle({ outcome: "progress", progress: false, reason: "无进展", evidence: [] });
  }
  assert.equal(manager.get(goal.id)?.status, "stalled");
  assert.equal(manager.get(goal.id)?.consecutiveNoProgress, 8);
  assert.equal(manager.currentBudgetDecision().allowed, true);
});

test("budget and context expose current criteria, usage, and remaining limits", () => {
  const { manager } = createManager();
  const goal = manager.create({
    title: "预算测试",
    description: "验证 Goal 预算投影",
    completionCriteria: ["所有验收通过"],
    budgetConfig: { maxTurns: 10, maxTokens: 10_000, maxCostCNY: 1 },
  });
  goal.budgetUsage.turns = 8;
  goal.budgetUsage.tokens = 8_000;
  goal.budgetUsage.costCNY = 0.8;

  assert.equal(manager.formatRemainingBudget(goal), "剩余 2 轮 + 剩余 2000 tokens + 剩余 ¥0.2000");
  const context = manager.buildGoalContext();
  assert.match(context, /所有验收通过/u);
  assert.match(context, /迭代: 8\/50/u);
  assert.match(context, /已消耗: 8000 tokens \+ ¥0\.8000/u);
});
