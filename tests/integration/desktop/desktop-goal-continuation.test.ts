import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { LLMProvider, Message, PersistedGoalManagerSnapshot } from "@pico/core";
import { createRuntimeRequest } from "@pico/protocol";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { CostTracker } from "@pico/pico-host/cost-tracker";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";
import { CreateGoalTool } from "@pico/pico-host/goal-tools";
import { SubmitPlanTool } from "@pico/pico-host/plan-tools";
import { PlanHandoffController } from "@pico/runtime/plan-handoff";
import { PlanCoordinator } from "@pico/runtime/plan-coordinator";
import { currentRuntimeRun } from "@pico/runtime/runtime-run";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { RuntimeRunExecutor } from "@pico/pico-host/runtime-run-executor";
import { globalSessionManager } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { resolvePicoPaths } from "@pico/pico-host/pico-paths";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";
import { reportFixtureAttempt } from "../../fixtures/native-accounting.js";

type Evaluation = {
  met?: boolean;
  impossible?: boolean;
  progress?: boolean;
  waiting?: boolean;
  reason: string;
};
const verdictContent = (value: Evaluation) =>
  JSON.stringify({ met: false, impossible: false, progress: false, waiting: false, ...value });

async function fixture(
  context: TestContext,
  options: {
    evaluations?: Evaluation[];
    evaluator?: LLMProvider["generate"];
    work?: (call: number, sessionId: string, messages: Message[]) => Promise<Message>;
    maxTurns?: number;
    plan?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pico-goal-host-engine-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await writeDesktopModelRouting(picoHome);
  const workspacePath = await realpath(workspace);
  const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "fixture-token" };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(workspacePath);
  const runs: { runId: string; sessionId: string; origin?: string }[] = [];
  const evaluations = [...(options.evaluations ?? [{ met: true, reason: "已完成" }])];
  const sessions: string[] = [];
  let workCalls = 0;
  let evaluationCalls = 0;
  const runtime = new WorkspaceRuntimeService({
    env,
    execute: async ({ sessionId, execution, context: runContext }) => {
      runs.push({
        runId: runContext.run.runId,
        sessionId: sessionId!,
        ...(execution?.origin ? { origin: execution.origin } : {}),
      });
      const lease = await globalSessionManager.getOrCreatePinned(sessionId!, workspacePath, {
        persistence: true,
        picoHome,
        runtimePort: createEngineRuntimePort(),
      });
      const session = lease.session;
      const manager = session.getGoalManager();
      const ledger = new SqliteRuntimeControlStore({ storageRoot: session.runtimeStorageRoot });
      try {
        const registry = new ToolRegistry();
        registry.register(new CreateGoalTool(manager));
        const handoff = new PlanHandoffController();
        const coordinator = () => {
          const run = currentRuntimeRun()!;
          return new PlanCoordinator(session.runtimeEventStore!, {
            sessionId: session.id,
            runId: run.runId,
            turnId: run.currentTurnId,
            invocationId: run.invocationId,
            writeGuard: session,
          });
        };
        if (options.plan)
          registry.register(
            new SubmitPlanTool(coordinator, handoff, session.id, () => currentRuntimeRun()!.runId),
          );
        const provider = new CostTracker(
          {
            generate: async (messages, _tools, request) => {
              const call = ++workCalls;
              const response = options.work
                ? await options.work(call, session.id, messages)
                : { role: "assistant" as const, content: `工作轮 ${call}，已完成本轮工作。` };
              const usage = { promptTokens: 500, completionTokens: 100 };
              await reportFixtureAttempt(request, "openai", "coder", usage);
              return { ...response, usage };
            },
          },
          { provider: "openai", model: "coder" },
          session,
          { ledger, context: { purpose: "main", sessionId: session.id } },
        );
        const engine = new AgentEngine({
          workDir: workspacePath,
          runtimePort: createEngineRuntimePort(),
          provider,
          registry,
          goalManager: manager,
          ...(options.plan
            ? { planHandoff: handoff, stopAfterSuccessfulToolNames: ["submit_plan"] }
            : {}),
          ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
        });
        const result = await new RuntimeRunExecutor({
          session,
          goalManager: manager,
          hostRunId: runContext.run.runId,
          goalRunOrigin: execution?.origin ?? "user",
          readModelOutcome: () => engine.getLastOutcome(),
          executeModel: (signal) => engine.run(session, undefined, undefined, signal),
          promptHooks: {
            submit: async () => ({ decision: "allow" }),
            expand: async () => ({ decision: "allow" }),
          },
          sessionSelection: { mode: "resume", sessionId: session.id },
          workDir: workspacePath,
          picoHome,
          prompt: "测试输入",
          resumeExistingSession: true,
          agentSwarmAuthorization: "none",
          traceEnabled: false,
          options: {},
          signal: runContext.signal,
          ...(execution?.goalPreparedRun ? { prestartedRun: execution.goalPreparedRun } : {}),
        }).execute();
        return { sessionId, outcome: result.outcome, finalMessage: result.finalMessage };
      } finally {
        ledger.close();
        lease.release();
      }
    },
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    env,
    providerFactory: () => ({
      generate: async (messages, tools, request) => {
        evaluationCalls++;
        assert.equal(tools.length, 0);
        assert.equal(request?.maxOutputTokens, 1024);
        if (options.evaluator) return options.evaluator(messages, tools, request);
        const verdict = evaluations.shift() ?? { met: true, reason: "已完成" };
        const usage = { promptTokens: 30, completionTokens: 10 };
        await reportFixtureAttempt(request, "openai", "coder", usage);
        return { role: "assistant", content: verdictContent(verdict), usage };
      },
    }),
  });
  await desktop.handle(createRuntimeRequest("workspace.register", { workspacePath }));
  context.after(async () => {
    await desktop.close();
    for (const sessionId of sessions)
      await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });
  const create = async () => {
    const result = (await desktop.handle(
      createRuntimeRequest("session.create", { workspacePath }),
    )) as { session: { sessionId: string } };
    sessions.push(result.session.sessionId);
    return result.session.sessionId;
  };
  const state = async (sessionId: string) =>
    (
      (await desktop.handle(
        createRuntimeRequest("goal.get", { workspacePath, sessionId }),
      )) as unknown as { goal: PersistedGoalManagerSnapshot }
    ).goal;
  const arm = async (sessionId: string, extra = {}) =>
    desktop.handle(
      createRuntimeRequest("goal.control", {
        workspacePath,
        sessionId,
        action: "arm",
        condition: "工作完成",
        expectedRevision: (await state(sessionId)).currentGoal?.revision ?? 0,
        ...extra,
      }),
    );
  const send = (sessionId: string, text = "开始工作") =>
    desktop.handle(
      createRuntimeRequest("session.send", {
        workspacePath,
        sessionId,
        behavior: "queue",
        input: { kind: "text", text },
        idempotencyKey: `input-${sessionId}-${text}`,
      }),
    );
  const wait = async (sessionId: string, status: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await state(sessionId);
      if (value.currentGoal?.status === status) return value;
      if (value.currentGoal && !["active", "waiting"].includes(value.currentGoal.status))
        assert.fail(`Goal提前结束，期望${status}: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Goal未进入${status}: ${JSON.stringify(await state(sessionId))}`);
  };
  return {
    desktop,
    runtime,
    workspacePath,
    picoHome,
    create,
    state,
    arm,
    send,
    wait,
    runs,
    evaluationCalls: () => evaluationCalls,
  };
}

test("Goal arm → actual Engine → Host evaluator → two continuations, with separate metering", async (t) => {
  const f = await fixture(t, {
    evaluations: [
      { progress: true, reason: "步骤一完成" },
      { progress: true, reason: "步骤二完成" },
      { met: true, reason: "全部完成" },
    ],
  });
  const id = await f.create();
  await f.arm(id, { tokenBudget: 1000 });
  assert.ok((await f.state(id)).currentGoal?.armedAt);
  assert.equal(f.runs.length, 0, "arm must not start a Run");
  await f.send(id);
  const state = await f.wait(id, "achieved");
  assert.deepEqual(
    f.runs.map((run) => run.origin),
    [undefined, "goal", "goal"],
  );
  assert.equal(
    state.currentGoal!.iterations,
    2,
    "terminal verdict does not increase goal iterations",
  );
  assert.equal(state.currentGoal!.tokensAtStart, 600);
  assert.equal(state.currentGoal!.tokensNow, 1200);
  assert.equal(state.coordinator.workTokens, 1800);
  const usage = (await f.desktop.handle(
    createRuntimeRequest("usage.get", {
      workspacePath: f.workspacePath,
      sessionId: id,
    }),
  )) as unknown as { usage: { details: { activities: { purpose?: string; goalId?: string }[] } } };
  const evaluationRows = usage.usage.details.activities.filter(
    (row) => row.purpose === "goal_evaluation",
  );
  assert.equal(evaluationRows.length, 3);
  assert.ok(evaluationRows.every((row) => row.goalId === state.currentGoal!.id));
  const ledger = new SqliteRuntimeControlStore({
    storageRoot: resolvePicoPaths(f.workspacePath, { picoHome: f.picoHome }).workspace.root,
  });
  try {
    const calls = ledger.listPhysicalAttempts({ sessionId: id });
    const evaluator = calls.filter((call) => call.purpose === "goal_evaluation");
    assert.equal(evaluator.length, 3);
    assert.ok(
      evaluator.every((call) => call.goalId === state.currentGoal!.id && call.runId && call.turnId),
    );
    assert.equal(calls.filter((call) => call.purpose === "main").length, 3);
    assert.ok(evaluator.every((call) => call.usage?.promptTokens === 30));
  } finally {
    ledger.close();
  }
});

test("model-created Goal is settled from its creating Run", async (t) => {
  const f = await fixture(t, {
    work: async (call) =>
      call === 1
        ? {
            role: "assistant",
            content: "设置目标",
            toolCalls: [
              {
                id: "create-goal",
                name: "create_goal",
                arguments: JSON.stringify({ condition: "工作完成" }),
              },
            ],
          }
        : { role: "assistant", content: "工作完成。" },
  });
  const id = await f.create();
  await f.send(id);
  const state = await f.wait(id, "achieved");
  assert.equal(f.runs.length, 1);
  assert.equal(f.evaluationCalls(), 1);
  assert.equal(state.currentGoal!.iterations, 0);
});

test("Goal control remains responsive during evaluator and rejects stale control/results", async (t) => {
  let entered!: () => void;
  const evaluating = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let aborted = false;
  const f = await fixture(t, {
    evaluator: async (_messages, _tools, options) => {
      entered();
      options?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          release();
        },
        { once: true },
      );
      await held;
      const usage = { promptTokens: 17, completionTokens: 5 };
      await reportFixtureAttempt(options, "openai", "coder", usage);
      return {
        role: "assistant",
        content: verdictContent({ met: true, reason: "过期结果" }),
        usage,
      };
    },
  });
  t.after(release);
  const id = await f.create();
  await f.arm(id);
  await f.send(id);
  await evaluating;
  const goal = (await f.state(id)).currentGoal!;
  const pause = createRuntimeRequest("goal.control", {
    workspacePath: f.workspacePath,
    sessionId: id,
    action: "pause",
    goalId: goal.id,
    expectedRevision: goal.revision,
  });
  await f.desktop.handle(pause);
  await assert.rejects(f.desktop.handle(pause), /Goal 已变化/);
  const state = await f.wait(id, "paused");
  assert.equal(aborted, true);
  assert.equal(state.currentGoal!.status, "paused");
  assert.equal(f.runs.length, 1);
  await f.desktop.close();
  const ledger = new SqliteRuntimeControlStore({
    storageRoot: resolvePicoPaths(f.workspacePath, { picoHome: f.picoHome }).workspace.root,
  });
  try {
    const attempts = ledger
      .listPhysicalAttempts({ sessionId: id })
      .filter((call) => call.purpose === "goal_evaluation");
    assert.equal(attempts.length, 1);
    assert.equal(
      attempts[0]!.usage?.promptTokens,
      17,
      "late cancelled calls retain actual metering",
    );
  } finally {
    ledger.close();
  }
});

test("workspace busy and queued user input take priority without pausing a Goal", async (t) => {
  let started!: () => void;
  let release!: () => void;
  const busy = new Promise<void>((resolve) => {
    started = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    work: async (call) => {
      if (call === 1) {
        started();
        await hold;
      }
      return { role: "assistant", content: `工作${call}` };
    },
  });
  t.after(release);
  const first = await f.create();
  const second = await f.create();
  await f.arm(second);
  let goal = (await f.state(second)).currentGoal!;
  await f.desktop.handle(
    createRuntimeRequest("goal.control", {
      workspacePath: f.workspacePath,
      sessionId: second,
      action: "pause",
      goalId: goal.id,
      expectedRevision: goal.revision,
    }),
  );
  await f.send(first);
  await busy;
  goal = (await f.state(second)).currentGoal!;
  await f.desktop.handle(
    createRuntimeRequest("goal.control", {
      workspacePath: f.workspacePath,
      sessionId: second,
      action: "resume",
      goalId: goal.id,
      expectedRevision: goal.revision,
    }),
  );
  await f.send(first, "排队用户输入");
  assert.equal((await f.state(second)).currentGoal!.status, "active");
  release();
  await f.wait(second, "achieved");
  assert.deepEqual(
    f.runs.map((run) => run.sessionId),
    [first, first, second],
  );
  assert.equal(f.runs[2]!.origin, "goal");
});

for (const [name, verdict, limits, terminal, count] of [
  [
    "iteration limit",
    { progress: true, reason: "继续" },
    { maxIterations: 2 },
    "max_iterations",
    2,
  ],
  ["stall", { progress: false, reason: "没有进展" }, { blockCap: 2 }, "stalled", 2],
  ["tokens", { progress: true, reason: "继续" }, { tokenBudget: 1000 }, "budget_limited", 3],
  ["impossible", { impossible: true, reason: "不可达" }, {}, "impossible", 1],
  ["default eight stalled turns", { progress: false, reason: "没有进展" }, {}, "stalled", 8],
  ["default fifty iterations", { progress: true, reason: "继续" }, {}, "max_iterations", 50],
] as const)
  test(`Host Goal settles ${name} without hidden Engine continuation`, async (t) => {
    const f = await fixture(t, { evaluations: Array.from({ length: count + 1 }, () => verdict) });
    const id = await f.create();
    await f.arm(id, limits);
    await f.send(id);
    // 每轮包含真实持久化；Windows 的 8 轮也可能超过 20s，按轮数分配夹具观察预算。
    const state = await f.wait(id, terminal, Math.max(20_000, count * 5_000));
    assert.equal(f.runs.length, count);
    assert.equal(state.coordinator.currentExecution, null);
    assert.equal(state.coordinator.pendingContinuation, null);
  });

test("waiting consumes one iteration, preserves stall count and yields immediately to user input", async (t) => {
  const f = await fixture(t, {
    evaluations: [
      { progress: false, reason: "尚无进展" },
      { waiting: true, progress: true, reason: "等待外部任务" },
      { met: true, reason: "用户带来完成结果" },
    ],
  });
  const id = await f.create();
  await f.arm(id);
  await f.send(id);
  const waiting = await f.wait(id, "waiting");
  assert.equal(waiting.currentGoal!.iterations, 2);
  assert.equal(waiting.currentGoal!.consecutiveNoProgress, 1);
  await f.send(id, "外部任务已完成");
  const final = await f.wait(id, "achieved");
  assert.equal(final.currentGoal!.iterations, 2);
  assert.deepEqual(
    f.runs.map((run) => run.origin),
    [undefined, "goal", undefined],
  );
});

test("invalid evaluator JSON neither resets nor increases the no-progress streak", async (t) => {
  let call = 0;
  const f = await fixture(t, {
    evaluator: async () => ({
      role: "assistant",
      content: ++call === 2 ? "not-json" : verdictContent({ progress: false, reason: "无进展" }),
    }),
  });
  const id = await f.create();
  await f.arm(id, { blockCap: 2 });
  await f.send(id);
  const final = await f.wait(id, "stalled");
  assert.equal(f.runs.length, 3);
  assert.equal(final.currentGoal!.iterations, 3);
  assert.equal(final.currentGoal!.consecutiveNoProgress, 2);
});

test("unfinished Goal cannot be replaced; clear is a durable terminal and permits a new Goal", async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  await f.arm(id);
  await assert.rejects(f.arm(id), /尚未|清除|未结束/);
  const goal = (await f.state(id)).currentGoal!;
  await f.desktop.handle(
    createRuntimeRequest("goal.control", {
      workspacePath: f.workspacePath,
      sessionId: id,
      action: "clear",
      goalId: goal.id,
      expectedRevision: goal.revision,
    }),
  );
  assert.equal((await f.state(id)).currentGoal!.status, "cleared");
  await f.arm(id);
  assert.notEqual((await f.state(id)).currentGoal!.id, goal.id);
  assert.equal(f.runs.length, 0);
});

test("Engine step limit pauses the Goal without invoking evaluator", async (t) => {
  const f = await fixture(t, {
    maxTurns: 1,
    work: async () => ({
      role: "assistant",
      content: "继续调用工具",
      toolCalls: [
        {
          id: "duplicate-create",
          name: "create_goal",
          arguments: JSON.stringify({ condition: "重复目标" }),
        },
      ],
    }),
  });
  const id = await f.create();
  await f.arm(id);
  await f.send(id);
  const final = await f.wait(id, "paused");
  assert.match(final.currentGoal!.lastReason!, /step_limit/);
  assert.equal(f.evaluationCalls(), 0);
  assert.equal(f.runs.length, 1);
});

test("external waiting wakes after the initial backoff and finishes through a new Host Run", async (t) => {
  const f = await fixture(t, {
    evaluations: [
      { waiting: true, reason: "外部状态稍后就绪" },
      { met: true, reason: "外部状态已就绪" },
    ],
  });
  const id = await f.create();
  await f.arm(id);
  await f.send(id);
  const waiting = await f.wait(id, "waiting");
  const final = await f.wait(id, "achieved");
  assert.ok(
    final.currentGoal!.lastEvaluation!.at - waiting.currentGoal!.lastEvaluation!.at >= 4900,
  );
  assert.equal(f.runs.length, 2);
  assert.equal(f.runs[1]!.origin, "goal");
  assert.equal(final.currentGoal!.iterations, 1);
});

test("real submit_plan handoff is evaluated while pending approval blocks Goal admission", async (t) => {
  const f = await fixture(t, {
    plan: true,
    evaluations: [{ progress: true, reason: "计划已提交，等待审批" }],
    work: async () => ({
      role: "assistant",
      content: "已准备计划",
      toolCalls: [
        {
          id: "plan-submit",
          name: "submit_plan",
          arguments: JSON.stringify({
            title: "测试计划",
            steps: [{ title: "实施", description: "审批后实施" }],
          }),
        },
      ],
    }),
  });
  const id = await f.create();
  await f.arm(id);
  await f.send(id);
  let state = await f.state(id);
  for (let n = 0; n < 200 && !state.coordinator.pendingContinuation; n++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    state = await f.state(id);
  }
  assert.equal(state.currentGoal!.status, "active");
  assert.equal(state.currentGoal!.iterations, 1);
  assert.ok(state.coordinator.pendingContinuation);
  assert.equal(f.evaluationCalls(), 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(f.runs.length, 1, "pending plan must not be automatically approved or continued");
});

test(
  "Host evaluator deadline cancels the request and ignores a late met verdict",
  { timeout: 45_000 },
  async (t) => {
    let aborted = false;
    const f = await fixture(t, {
      evaluator: async (_messages, _tools, options) => {
        await new Promise<void>((resolve) =>
          options!.signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        const usage = { promptTokens: 19, completionTokens: 7 };
        await reportFixtureAttempt(options, "openai", "coder", usage);
        return {
          role: "assistant",
          content: verdictContent({ met: true, reason: "超时后的迟到结果" }),
          usage,
        };
      },
    });
    const id = await f.create();
    await f.arm(id, { maxIterations: 1 });
    await f.send(id);
    const final = await f.wait(id, "max_iterations", 40_000);
    assert.equal(aborted, true);
    assert.equal(final.currentGoal!.lastEvaluation!.evaluatorFailed, true);
    assert.match(final.currentGoal!.lastEvaluation!.reason, /超时/);
    assert.equal(final.currentGoal!.consecutiveNoProgress, 0);
    assert.equal(f.runs.length, 1);
    await f.desktop.close();
    const ledger = new SqliteRuntimeControlStore({
      storageRoot: resolvePicoPaths(f.workspacePath, { picoHome: f.picoHome }).workspace.root,
    });
    try {
      const evaluation = ledger
        .listPhysicalAttempts({ sessionId: id })
        .filter((call) => call.purpose === "goal_evaluation");
      assert.equal(evaluation.length, 1);
      assert.equal(evaluation[0]!.usage!.promptTokens, 19);
    } finally {
      ledger.close();
    }
  },
);
