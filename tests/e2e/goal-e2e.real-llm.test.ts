/**
 * Goal v2 lifecycle checks. Session admission and evaluator settlement belong to
 * the Host boundary; AgentEngine does not hide continuation turns inside a Run.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GoalManager } from "@pico/runtime/goal-manager";

test("Goal arms for a user turn and settlement creates one idempotent continuation intent", () => {
  const manager = new GoalManager({ now: () => 1_700_000_000_000 });
  const goal = manager.create({
    title: "验证续跑",
    description: "一个正常结束的 Run 应产生可恢复续跑意图",
    completionCriteria: ["有可检查的结果"],
  });

  assert.equal(goal.awaitingUserTurn, true);
  assert.equal(goal.pendingContinuation, false);
  assert.equal(manager.beginRun("user").allowed, true);
  assert.equal(manager.get(goal.id)?.awaitingUserTurn, false);

  manager.settle({
    outcome: "progress",
    progress: true,
    reason: "已完成第一步",
    evidence: ["第一步结果已记录"],
  });
  assert.equal(manager.get(goal.id)?.pendingContinuation, true);
  assert.equal(manager.get(goal.id)?.consecutiveNoProgress, 0);

  assert.ok(manager.claimContinuation(goal.id, "admission-1"));
  assert.equal(manager.claimContinuation(goal.id, "admission-1"), undefined);
  manager.recordAdmittedRun(goal.id, "admission-1", "run-2");
  assert.equal(manager.get(goal.id)?.targetRunId, "run-2");
});

test("Goal evaluator settlement stops only at the configured no-progress cap", () => {
  const manager = new GoalManager({ now: () => 1_700_000_000_000 });
  const goal = manager.create({
    title: "检测停滞",
    description: "无进展由 evaluator 逐 Run 结算",
    completionCriteria: ["获得可验证结果"],
    blockCap: 8,
  });

  for (let iteration = 0; iteration < 8; iteration++) {
    if (iteration === 0) {
      assert.equal(manager.beginRun("user").allowed, true);
    } else {
      assert.ok(manager.claimContinuation(goal.id, `admission-${iteration}`));
      assert.equal(manager.beginRun("goal").allowed, true);
    }
    manager.settle({
      outcome: "progress",
      progress: false,
      reason: "本轮没有可观察进展",
      evidence: [],
    });
  }

  assert.equal(manager.get(goal.id)?.consecutiveNoProgress, 8);
  assert.equal(manager.get(goal.id)?.status, "stalled");
  assert.equal(manager.get(goal.id)?.pendingContinuation, false);
});

test("waiting Goals wake at their persisted backoff deadline and accept success evidence", () => {
  let now = 1_700_000_000_000;
  const manager = new GoalManager({ now: () => now });
  const waiting = manager.create({
    title: "等待外部构建",
    description: "构建服务稍后完成",
    completionCriteria: ["构建检查成功"],
  });
  manager.beginRun("user");
  manager.settle({
    outcome: "waiting",
    progress: false,
    reason: "等待 CI 完成",
    evidence: ["CI 正在运行"],
  });

  assert.equal(manager.get(waiting.id)?.status, "waiting");
  assert.equal(manager.wakeWaiting(waiting.id), false);
  now += 5_000;
  assert.equal(manager.wakeWaiting(waiting.id), true);
  assert.equal(manager.get(waiting.id)?.pendingContinuation, true);

  const achieved = manager.create({
    title: "验收完成",
    description: "全部标准均由 evaluator 核验",
    completionCriteria: ["集成检查通过", "结果文件存在"],
  });
  manager.beginRun("user");
  manager.settle({
    outcome: "met",
    progress: true,
    reason: "所有标准均有直接证据",
    evidence: ["集成检查通过", "结果文件存在"],
  });
  assert.equal(manager.get(achieved.id)?.status, "achieved");
});
