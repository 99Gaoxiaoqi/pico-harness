import assert from "node:assert/strict";
import test from "node:test";
import {
  ChildRunLimiter,
  DEFAULT_MAX_ACTIVE_CHILD_RUNS,
  resolveChildRunCapacity,
} from "../../src/tools/child-run-limiter.js";
import { SpawnSubagentTool, DelegateTaskTool } from "../../src/tools/subagent.js";
import { DelegationManager } from "../../src/tools/delegation-manager.js";
import type { AgentRunner, SubagentResult } from "../../src/tools/subagent.js";
import type { Registry } from "../../src/tools/registry.js";

// 子代理真实执行容量闸（移植自参考宿主的 ChildAgentRunLimiter 语义）：
// 满则 FIFO 排队不拒绝；排队中 abort 干净出队；close 排空等待者。
// 与 session 级准入（3 委派 × 3 子代理）分离——daemon 多 session 叠加时
// 由这道进程级闸兜底（此前 3×N 无界）。

test("FIFO 容量闸：满则排队，按序授予，release 唤醒下一个", async () => {
  const limiter = new ChildRunLimiter(1);
  const first = await limiter.acquire();
  assert.equal(limiter.activeCount, 1);

  let secondGranted = false;
  const secondPromise = limiter.acquire().then((permit) => {
    secondGranted = true;
    return permit;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondGranted, false, "容量满时第二个执行者应排队而非获准");
  assert.equal(limiter.waitingCount, 1);

  first.release();
  const second = await secondPromise;
  assert.equal(secondGranted, true, "释放后应按 FIFO 授予等待者");
  assert.equal(limiter.activeCount, 1);
  assert.equal(limiter.waitingCount, 0);
  second.release();
  assert.equal(limiter.activeCount, 0);
});

test("排队中 abort：干净出队拒绝，不占用名额也不吞后续等待者", async () => {
  const limiter = new ChildRunLimiter(1);
  const active = await limiter.acquire();
  const controller = new AbortController();
  const aborted = limiter.acquire(controller.signal);
  const queued = limiter.acquire();

  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new Error("run cancelled"));
  await assert.rejects(aborted, /run cancelled/);
  assert.equal(limiter.waitingCount, 1, "被取消的等待者应出队，剩下的保留");

  active.release();
  const permit = await queued;
  assert.equal(limiter.activeCount, 1, "取消不应影响后续等待者获得名额");
  permit.release();
});

test("close：拒绝全部等待者并让后续 acquire 立即失败", async () => {
  const limiter = new ChildRunLimiter(1);
  const active = await limiter.acquire();
  const waiter = limiter.acquire();

  limiter.close(new Error("daemon shutting down"));
  await assert.rejects(waiter, /daemon shutting down/);
  await assert.rejects(limiter.acquire(), /daemon shutting down/);
  active.release();
});

test("容量默认 32（≥ 单 session 理论极值 3×3=9），env 可覆盖且非法值回落", () => {
  assert.equal(DEFAULT_MAX_ACTIVE_CHILD_RUNS, 32);
  assert.equal(resolveChildRunCapacity({}), 32);
  assert.equal(resolveChildRunCapacity({ PICO_CHILD_RUN_CAPACITY: "8" }), 8);
  assert.equal(resolveChildRunCapacity({ PICO_CHILD_RUN_CAPACITY: "abc" }), 32);
  assert.equal(resolveChildRunCapacity({ PICO_CHILD_RUN_CAPACITY: "0" }), 32);
  assert.throws(() => new ChildRunLimiter(0), /positive safe integer/);
});

test("SpawnSubagentTool 直跑路径过全局闸：容量 1 时并发执行串行化", async () => {
  const limiter = new ChildRunLimiter(1);
  const events: string[] = [];
  let running = 0;
  let maxObservedRunning = 0;
  const runner: AgentRunner = {
    async runSub(): Promise<SubagentResult> {
      running += 1;
      maxObservedRunning = Math.max(maxObservedRunning, running);
      events.push(`start-${events.length}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      running -= 1;
      return { status: "completed", summary: "done", evidenceRefs: [] };
    },
  };
  const tool = new SpawnSubagentTool(runner, {} as Registry, { childRunLimiter: limiter });

  await Promise.all(
    ["任务甲", "任务乙", "任务丙"].map((prompt) =>
      tool.execute(JSON.stringify({ task_prompt: prompt })),
    ),
  );

  assert.equal(maxObservedRunning, 1, `容量 1 时三个并发子代理应串行执行，实测峰值 ${maxObservedRunning}`);
  assert.equal(limiter.activeCount, 0, "全部结束后名额应归还");
});

test("直跑路径排队中被取消：干净拒绝且名额不泄漏", async () => {
  const limiter = new ChildRunLimiter(1);
  const controller = new AbortController();
  let firstDone = false;
  const runner: AgentRunner = {
    async runSub(): Promise<SubagentResult> {
      await new Promise((resolve) => setTimeout(resolve, 80));
      firstDone = true;
      return { status: "completed", summary: "done", evidenceRefs: [] };
    },
  };
  const tool = new SpawnSubagentTool(runner, {} as Registry, { childRunLimiter: limiter });

  const first = tool.execute(JSON.stringify({ task_prompt: "占用名额" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const queued = tool.execute(JSON.stringify({ task_prompt: "排队后取消" }), {
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new Error("cancelled while queued"));

  const queuedResult = await queued;
  assert.match(queuedResult, /子智能体执行失败/, "排队中被取消应返回失败报告而非悬挂");
  await first;
  assert.ok(firstDone);
  assert.equal(limiter.activeCount, 0, "取消路径不得泄漏名额");
  assert.equal(limiter.waitingCount, 0, "取消的等待者应出队");
});

test("DelegateTaskTool 批内不再限并发：children 全部入全局闸，容量 1 时串行且结果保序", async () => {
  const limiter = new ChildRunLimiter(1);
  let running = 0;
  let maxObservedRunning = 0;
  const prompts: string[] = [];
  const runner: AgentRunner = {
    async runSub(prompt: string): Promise<SubagentResult> {
      prompts.push(prompt);
      running += 1;
      maxObservedRunning = Math.max(maxObservedRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 40));
      running -= 1;
      return { status: "completed", summary: "done", evidenceRefs: [] };
    },
  };
  const tool = new DelegateTaskTool(runner, () => ({}) as Registry, undefined, {
    childRunLimiter: limiter,
  });

  const raw = await tool.execute(
    JSON.stringify({ tasks: [{ goal: "任务甲" }, { goal: "任务乙" }, { goal: "任务丙" }] }),
  );
  const parsed = JSON.parse(raw) as { status: string; results?: Array<{ status: string }> };

  assert.equal(
    maxObservedRunning,
    1,
    `容量 1 时批内三个子代理应由容量闸串行化（实测峰值 ${maxObservedRunning}）`,
  );
  assert.deepEqual(prompts, ["任务甲", "任务乙", "任务丙"], "批内结果应按原顺序结算");
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.results?.length, 3);
  assert.equal(limiter.activeCount, 0, "批次结束名额应全部归还");
});

test("DelegationManager turn 重置：旧排队者被拒、新实例满血、旧 permit 归还无害", async () => {
  const prev = process.env.PICO_CHILD_RUN_CAPACITY;
  process.env.PICO_CHILD_RUN_CAPACITY = "1";
  try {
    const manager = new DelegationManager();
    const first = await manager.childRunLimiter.acquire();
    const queued = manager.childRunLimiter.acquire();
    await new Promise((resolve) => setTimeout(resolve, 10));

    manager.resetTurnState();

    await assert.rejects(queued, /turn ended/, "turn 结束仍在排队的等待者应被拒绝");
    const freshPermit = await manager.childRunLimiter.acquire();
    assert.ok(freshPermit, "新 turn 实例应满血，立即可获得名额");
    first.release();
    freshPermit.release();
  } finally {
    if (prev === undefined) delete process.env.PICO_CHILD_RUN_CAPACITY;
    else process.env.PICO_CHILD_RUN_CAPACITY = prev;
  }
});

test("provider 形式注入：工具按调用时取当前实例（turn 重置后不失效）", async () => {
  let current = new ChildRunLimiter(1);
  let running = 0;
  let maxObservedRunning = 0;
  const runner: AgentRunner = {
    async runSub(): Promise<SubagentResult> {
      running += 1;
      maxObservedRunning = Math.max(maxObservedRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 40));
      running -= 1;
      return { status: "completed", summary: "done", evidenceRefs: [] };
    },
  };
  const tool = new SpawnSubagentTool(runner, {} as Registry, {
    childRunLimiter: () => current,
  });

  const firstWave = tool.execute(JSON.stringify({ task_prompt: "turn1-甲" }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  // 模拟 turn 边界换新实例：之后发起的调用应取到新实例，不被上一代占用卡住。
  current = new ChildRunLimiter(1);
  const nextTurnCall = tool.execute(JSON.stringify({ task_prompt: "turn2-甲" }));
  await Promise.all([firstWave, nextTurnCall]);

  assert.equal(
    maxObservedRunning,
    2,
    "provider 按调用时取实例——换新实例后新调用不被上一代占用卡住",
  );
});
