import assert from "node:assert/strict";
import test from "node:test";
import { GoalManager } from "@pico/runtime/goal-manager";
import { CreateGoalTool, GetGoalTool, UpdateGoalTool } from "@pico/pico-host/goal-tools";

test("goal tools require verifiable criteria and completion requests need independent acceptance", async () => {
  const manager = new GoalManager({ now: () => 1_700_000_000_000 });
  const create = new CreateGoalTool(manager);
  const get = new GetGoalTool(manager);
  const update = new UpdateGoalTool(manager);
  manager.beginRun("user");

  const created = await create.execute(
    JSON.stringify({
      title: "迁移包边界",
      description: "保持兼容入口与运行时契约",
      completionCriteria: ["所有入口已迁移", "集成检查通过"],
      budget: { maxTurns: 8, maxTokens: 4096 },
    }),
  );
  assert.match(created, /已创建并激活目标 goal-1/u);
  assert.equal(manager.getActive()?.id, "goal-1");

  const projected = await get.execute("");
  assert.match(projected, /当前激活目标/u);
  assert.match(projected, /8 轮/u);

  const updated = await update.execute(
    JSON.stringify({ id: "goal-1", progress: "Runtime 工具已下沉", status: "complete" }),
  );
  assert.match(updated, /请求 Goal goal-1 验收/u);
  assert.equal(manager.get("goal-1")?.status, "active");
  assert.equal(manager.get("goal-1")?.completionRequested, true);
  assert.equal(manager.get("goal-1")?.progress, "Runtime 工具已下沉");
  await update.execute(
    JSON.stringify({ id: "goal-1", status: "paused", title: "暂停时保留字段", progress: "待人工确认" }),
  );
  assert.equal(manager.get("goal-1")?.status, "paused");
  assert.equal(manager.get("goal-1")?.title, "暂停时保留字段");
  assert.equal(manager.get("goal-1")?.progress, "待人工确认");
  await update.execute(
    JSON.stringify({ id: "goal-1", status: "active", title: "迁移包边界" }),
  );
  assert.equal(manager.get("goal-1")?.status, "active");
  assert.equal(manager.get("goal-1")?.title, "迁移包边界");
  manager.settle({
    outcome: "progress",
    progress: true,
    reason: "第一项已完成",
    evidence: ["集成测试通过"],
  });
  manager.endRun();
  assert.equal(manager.get("goal-1")?.status, "active");
  assert.equal(manager.get("goal-1")?.pendingContinuation, true);
  manager.beginRun("goal");
  manager.settle({
    outcome: "met",
    progress: true,
    reason: "所有标准满足",
    evidence: ["所有入口已迁移", "集成检查通过"],
  });
  manager.endRun();
  assert.equal(manager.get("goal-1")?.status, "achieved");
  assert.equal(manager.getActive(), undefined);

  const evidenceGuard = manager.create({
    title: "证据不完整",
    description: "缺少一项证据时不能验收",
    completionCriteria: ["检查 A 通过", "检查 B 通过"],
  });
  manager.beginRun("user");
  manager.settle({
    outcome: "met",
    progress: true,
    reason: "模型声称两项完成",
    evidence: ["检查 A 通过"],
  });
  assert.equal(manager.get(evidenceGuard.id)?.status, "active");
  assert.equal(manager.get(evidenceGuard.id)?.pendingContinuation, true);
  assert.equal(manager.get(evidenceGuard.id)?.lastEvaluation?.outcome, "progress");

  await assert.rejects(
    create.execute(JSON.stringify({ title: "缺少标准", description: "不能创建" })),
    /completionCriteria 必须/u,
  );

  await assert.rejects(
    create.execute(
      JSON.stringify({
        title: "无效预算",
        description: "应失败",
        completionCriteria: ["完成"],
        budget: {},
      }),
    ),
    /至少需含一个预算字段/u,
  );
  await assert.rejects(
    update.execute(JSON.stringify({ id: "goal-1", status: "unknown" })),
    /合法值:active\/paused\/complete/u,
  );
});

test("Goal continuation persists arm, waiting backoff, and the eight-run stall limit", () => {
  let now = 1_000;
  const manager = new GoalManager({ now: () => now });
  const goal = manager.create({
    title: "等待外部验证",
    description: "等 CI 到达后完成检查",
    completionCriteria: ["CI run is green"],
    awaitingUserTurn: true,
  });
  assert.equal(goal.awaitingUserTurn, true);
  assert.equal(manager.beginRun("user").allowed, true);
  assert.equal(manager.get(goal.id)?.budgetUsage.turns, 1);
  manager.settle({ outcome: "waiting", progress: false, reason: "等待 CI", evidence: [] });
  assert.equal(manager.get(goal.id)?.status, "waiting");
  assert.equal(manager.get(goal.id)?.nextCheckAt, 6_000);
  assert.equal(manager.get(goal.id)?.pendingContinuation, false);

  const persisted = manager.snapshot();
  assert.equal(persisted.stateVersion, 2);
  const restored = new GoalManager({ now: () => now });
  restored.restore(persisted);
  now = 5_999;
  assert.equal(restored.wakeWaiting(goal.id, now), false);
  now = 6_000;
  assert.equal(restored.wakeWaiting(goal.id, now), true);
  assert.equal(restored.get(goal.id)?.pendingContinuation, true);

  assert.throws(() => restored.restore({ ...persisted, stateVersion: 1 } as never), /schema v2/u);

  const stalled = new GoalManager({ now: () => now });
  const looping = stalled.create({
    title: "停止原地打转",
    description: "没有实际进展时停止",
    completionCriteria: ["结果可验证"],
  });
  for (let iteration = 1; iteration <= 8; iteration++) {
    stalled.beginRun("user");
    stalled.settle({
      outcome: "progress",
      progress: false,
      reason: "仍未达到完成标准",
      evidence: [],
    });
    stalled.endRun();
  }
  assert.equal(stalled.get(looping.id)?.status, "stalled");
  assert.equal(stalled.get(looping.id)?.consecutiveNoProgress, 8);
  assert.equal(stalled.get(looping.id)?.pendingContinuation, false);
});

test("Goal settlement enforces max iterations and charges evaluator usage", () => {
  const manager = new GoalManager({ now: () => 2_000 });
  const goal = manager.create({
    title: "有限轮次 Goal",
    description: "完成前最多执行一轮",
    completionCriteria: ["结果已验证"],
    maxIterations: 1,
    awaitingUserTurn: true,
  });
  manager.beginRun("user");
  manager.settle({
    outcome: "progress",
    progress: true,
    reason: "还有一项待验证",
    evidence: ["构建完成"],
    usage: { promptTokens: 12, completionTokens: 3 },
    costCNY: 0.02,
  });
  const settled = manager.get(goal.id)!;
  assert.equal(settled.status, "max_iterations");
  assert.equal(settled.pendingContinuation, false);
  assert.equal(settled.budgetUsage.tokens, 15);
  assert.equal(settled.budgetUsage.costCNY, 0.02);
  assert.deepEqual(settled.lastEvaluation?.evidence, ["构建完成"]);
});

test("Goal resume terminalizes an exhausted paused Goal before continuation admission", () => {
  const manager = new GoalManager({ now: () => 3_000 });
  const goal = manager.create({
    title: "需审批的最后一轮",
    description: "最后一轮因权限等待而暂停",
    completionCriteria: ["改动已验证"],
    maxIterations: 1,
    awaitingUserTurn: true,
  });
  manager.beginRun("user");
  manager.pause(goal.id, "等待工具审批");

  const resumed = manager.resume(goal.id);
  assert.equal(resumed?.status, "max_iterations");
  assert.equal(resumed?.pendingContinuation, false);
  assert.equal(manager.getActive(), undefined);
});

test("Goal retains the current Run identity and reconciles a terminal Run after restart", () => {
  const manager = new GoalManager({ now: () => 4_000 });
  const goal = manager.create({
    title: "恢复当前 Run",
    description: "Host 重启后按原 RuntimeRun 身份对账",
    completionCriteria: ["最终结果有证据"],
    awaitingUserTurn: true,
  });

  manager.beginRun("user", "run-1");
  assert.equal(manager.get(goal.id)?.targetRunId, "run-1");
  assert.equal(manager.recoverAdmittedRun(goal.id, "run-1", "succeeded"), "continued");
  assert.equal(manager.get(goal.id)?.pendingContinuation, true);
  assert.equal(manager.get(goal.id)?.targetRunId, undefined);

  const admissionKey = `goal:${goal.id}:revision:${manager.get(goal.id)?.controlRevision}`;
  manager.claimContinuation(goal.id, admissionKey);
  manager.recordAdmittedRun(goal.id, admissionKey, "run-2");
  manager.beginRun("goal", "run-2");
  assert.equal(manager.get(goal.id)?.targetRunId, "run-2");
  assert.equal(manager.recoverAdmittedRun(goal.id, "run-2", "cancelled"), "paused");
  assert.equal(manager.get(goal.id)?.status, "paused");
  assert.equal(manager.get(goal.id)?.pendingContinuation, false);
});
