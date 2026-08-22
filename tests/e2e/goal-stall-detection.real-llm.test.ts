/**
 * 验证 Goal 停滞检测和预算软提醒
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GoalManager } from "../../src/engine/goal-manager.js";
import {
  STALL_EVALUATOR_THRESHOLD,
  STALL_WARN_THRESHOLD,
  STALL_BLOCK_THRESHOLD,
} from "../../src/engine/goal-manager.js";
import type { ToolCall } from "../../src/schema/message.js";

test("goal stall detection: fingerprint reset on different tool calls", () => {
  const manager = new GoalManager();
  manager.create("测试目标", "描述", undefined);

  // 第一次工具调用
  const calls1: ToolCall[] = [{ id: "c1", name: "bash", arguments: '{"command":"ls"}' }];
  manager.recordToolCallProgress(calls1);
  assert.equal(manager.getActive()?.consecutiveNoProgress, 0, "首次调用应重置为 0");

  // 相同工具调用 → 递增
  manager.recordToolCallProgress(calls1);
  assert.equal(manager.getActive()?.consecutiveNoProgress, 1, "相同指纹应递增");

  // 不同工具调用 → 重置
  const calls2: ToolCall[] = [{ id: "c2", name: "bash", arguments: '{"command":"pwd"}' }];
  manager.recordToolCallProgress(calls2);
  assert.equal(manager.getActive()?.consecutiveNoProgress, 0, "不同指纹应重置为 0");
});

test("goal stall detection: no tool calls increments counter", () => {
  const manager = new GoalManager();
  manager.create("测试目标", "描述", undefined);

  manager.recordToolCallProgress([]);
  assert.equal(manager.getActive()?.consecutiveNoProgress, 1, "无工具调用应递增");

  manager.recordToolCallProgress([]);
  assert.equal(manager.getActive()?.consecutiveNoProgress, 2, "无工具调用应继续递增");
});

test("goal stall detection: warn threshold triggers warning", () => {
  const manager = new GoalManager();
  manager.create("测试目标", "描述", undefined);

  // 第一次调用建立基线指纹（consecutiveNoProgress=0），后续 STALL_WARN_THRESHOLD 次相同调用递增
  const calls: ToolCall[] = [{ id: "c1", name: "bash", arguments: "{}" }];
  for (let i = 0; i <= STALL_WARN_THRESHOLD; i++) {
    manager.recordToolCallProgress(calls);
  }

  const warning = manager.getStallWarning();
  assert.ok(warning, `连续 ${STALL_WARN_THRESHOLD} 轮相同调用应产生警告`);
  assert.match(warning!, /疑似停滞/u);
});

test("goal stall detection: block threshold triggers budget decision", () => {
  const manager = new GoalManager();
  manager.create("测试目标", "描述", undefined);

  // 第一次建立基线，后续 STALL_BLOCK_THRESHOLD 次递增
  const calls: ToolCall[] = [{ id: "c1", name: "bash", arguments: "{}" }];
  for (let i = 0; i <= STALL_BLOCK_THRESHOLD; i++) {
    manager.recordToolCallProgress(calls);
  }

  const decision = manager.currentBudgetDecision();
  assert.ok(!decision.allowed, `连续 ${STALL_BLOCK_THRESHOLD} 轮应被阻止`);
  assert.match(decision.reason!, /停滞/u);
});

test("goal budget reminder: formatRemainingBudget shows remaining with warning", () => {
  const manager = new GoalManager();
  manager.create("测试目标", "描述", { maxTurns: 10, maxTokens: 1000, maxCostCNY: 1.0 });

  // 消耗 8 轮（80%）→ 剩余 2 轮 ≤ 20% → 应显示 ⚠
  const active = manager.getActive()!;
  active.budgetUsage.turns = 8;
  active.budgetUsage.tokens = 800;
  active.budgetUsage.costCNY = 0.8;

  const remaining = manager.formatRemainingBudget(active);
  assert.ok(remaining, "应有剩余预算");
  assert.match(remaining!, /剩余 2 轮 ⚠/u, "剩余 ≤20% 应显示 ⚠");
  assert.match(remaining!, /剩余 200 tokens ⚠/u);
  assert.match(remaining!, /剩余 ¥0.2000 ⚠/u);
});

test("goal buildGoalContext includes remaining budget and stall status", () => {
  const manager = new GoalManager();
  manager.create("测试目标", "描述", { maxTurns: 10 });

  const active = manager.getActive()!;
  active.budgetUsage.turns = 8;
  active.consecutiveNoProgress = STALL_EVALUATOR_THRESHOLD;

  const ctx = manager.buildGoalContext();
  assert.match(ctx, /剩余 2 轮 ⚠/u, "应包含剩余预算预警");
  assert.match(ctx, /连续无进展/u, "应包含停滞状态");
});
