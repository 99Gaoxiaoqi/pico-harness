import assert from "node:assert/strict";
import test from "node:test";
import { GoalManager } from "@pico/runtime/goal-manager";
import {
  ClearGoalTool,
  CreateGoalTool,
  GetGoalTool,
  PauseGoalTool,
  ResumeGoalTool,
} from "@pico/runtime/goal-tools";

test("Goal tools bind model-created Goals to the active Run and expose five narrow controls", async () => {
  const manager = new GoalManager({ now: () => 1_700_000_000_000 });
  const observed: string[] = [];
  manager.subscribe((snapshot) => {
    if (snapshot.currentGoal?.status === "active") {
      observed.push(snapshot.coordinator.currentExecution?.runId ?? "unbound");
    }
  });
  manager.beginRun("canonical-run", "turn-7", "user", "daemon-run", {
    prompt: "long task",
    createdAt: 1_700_000_000_000,
    triggeringRunId: "trigger-run",
    invocationId: "invocation-7",
    runStartedEventId: "started-7",
    runStartedAt: 1_700_000_000_000,
  });

  const create = new CreateGoalTool(manager);
  const get = new GetGoalTool(manager);
  const pause = new PauseGoalTool(manager);
  const resume = new ResumeGoalTool(manager);
  const clear = new ClearGoalTool(manager);
  assert.deepEqual(
    [create.name(), get.name(), pause.name(), resume.name(), clear.name()],
    ["create_goal", "get_goal", "pause_goal", "resume_goal", "clear_goal"],
  );

  const created = await create.execute(JSON.stringify({ condition: "完成可验证的长任务" }));
  assert.match(created, /Goal 已创建并激活/u);
  const goal = manager.getCurrent()!;
  assert.equal(goal.condition, "完成可验证的长任务");
  assert.equal(goal.maxIterations, 50);
  assert.equal(goal.blockCap, 8);
  assert.equal(goal.tokenBudget, undefined);
  assert.equal(goal.armedAt, undefined);
  assert.deepEqual(observed, ["canonical-run"]);
  assert.deepEqual(manager.snapshot().coordinator.currentExecution, {
    goalId: goal.id,
    revision: goal.revision,
    generation: manager.snapshot().controlLease?.generation,
    prompt: "long task",
    createdAt: 1_700_000_000_000,
    triggeringRunId: "trigger-run",
    runId: "canonical-run",
    daemonRunId: "daemon-run",
    turnId: "turn-7",
    invocationId: "invocation-7",
    runStartedEventId: "started-7",
    runStartedAt: 1_700_000_000_000,
    origin: "user",
    started: true,
  });
  assert.match(await get.execute("{}"), /完成可验证的长任务/u);

  await pause.execute(JSON.stringify({ id: goal.id, expectedRevision: goal.revision }));
  assert.equal(manager.get(goal.id)?.status, "paused");
  assert.ok(
    manager.snapshot().coordinator.currentExecution,
    "pause does not terminate the in-flight Run",
  );
  await resume.execute(
    JSON.stringify({ id: goal.id, expectedRevision: manager.get(goal.id)!.revision }),
  );
  assert.equal(manager.get(goal.id)?.status, "active");
  assert.equal(
    manager.snapshot().coordinator.currentExecution?.revision,
    manager.get(goal.id)?.revision,
  );

  await clear.execute(
    JSON.stringify({ id: goal.id, expectedRevision: manager.get(goal.id)!.revision }),
  );
  assert.equal(manager.getCurrent()?.status, "cleared");
  assert.equal(manager.snapshot().controlLease, null);
  assert.equal(manager.snapshot().coordinator.currentExecution, null);
});

test("Goal settlement uses a baseline after the first nonterminal Run and prioritizes terminal/budget limits", () => {
  const manager = new GoalManager({ now: () => 3_000 });
  const goal = manager.create({ condition: "达到结果", maxIterations: 3, tokenBudget: 1_000 });
  manager.setCoordinator({ workTokens: 100, accountedRunIds: ["old-run"] });
  manager.beginRun("first-run", "turn-1", "user", "daemon-1");
  const first = manager.settle({
    checkpoint: { goalId: goal.id, revision: goal.revision },
    evaluation: { met: false, impossible: false, progress: true, waiting: false, reason: "有进展" },
    tokensNow: 600,
  });
  assert.equal(first?.status, "active");
  assert.equal(first?.iterations, 1);
  assert.equal(
    first?.tokensAtStart,
    600,
    "the first nonterminal settlement establishes the baseline",
  );
  assert.equal(first?.tokensNow, 600);
  assert.equal(first?.tokensBaselinePending, false);
  assert.deepEqual(manager.snapshot().coordinator.accountedRunIds, ["old-run", "daemon-1"]);

  manager.beginRun("second-run", "turn-2", "goal", "daemon-2");
  const limited = manager.settle({
    checkpoint: { goalId: goal.id, revision: first!.revision },
    evaluation: {
      met: false,
      impossible: false,
      progress: true,
      waiting: false,
      reason: "继续有进展",
    },
    tokensNow: 1_600,
  });
  assert.equal(limited?.status, "budget_limited");
  assert.equal(limited?.iterations, 1, "budget is checked before incrementing iterations");

  const terminalManager = new GoalManager({ now: () => 4_000 });
  const terminalGoal = terminalManager.create({ condition: "已经满足" });
  terminalManager.beginRun("terminal-run", "turn", "user", "daemon-terminal");
  const achieved = terminalManager.settle({
    checkpoint: { goalId: terminalGoal.id, revision: terminalGoal.revision },
    evaluation: {
      met: true,
      impossible: false,
      progress: false,
      waiting: false,
      reason: "证据已核实",
    },
    tokensNow: 999,
  });
  assert.equal(achieved?.status, "achieved");
  assert.equal(achieved?.iterations, 0);
  assert.equal(achieved?.tokensNow, 0);
  assert.equal(achieved?.tokensBaselinePending, true);
});

test("waiting does not count or clear no-progress; eight genuine no-progress turns stall", () => {
  const manager = new GoalManager({ now: () => 5_000 });
  const goal = manager.create({ condition: "通过外部检查", blockCap: 8 });
  let current = goal;
  for (let turn = 1; turn <= 9; turn++) {
    if (manager.getCurrent()?.status === "waiting") {
      assert.equal(manager.wakeWaiting(goal.id), true);
      current = manager.getCurrent()!;
    }
    manager.beginRun(`run-${turn}`, `turn-${turn}`, turn === 1 ? "user" : "goal", `daemon-${turn}`);
    current = manager.getCurrent()!;
    const result = manager.settle({
      checkpoint: { goalId: current.id, revision: current.revision },
      evaluation: {
        met: false,
        impossible: false,
        progress: turn === 1,
        waiting: turn === 1,
        reason: turn === 1 ? "等待外部检查" : "仍无进展",
      },
      tokensNow: 0,
    })!;
    current = result;
    if (turn === 1) assert.equal(result.consecutiveNoProgress, 0);
  }
  assert.equal(current.status, "stalled");
  assert.equal(current.consecutiveNoProgress, 8);
});
