import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Message, PersistedGoalManagerSnapshot } from "@pico/core";
import { createRuntimeRequest, type RuntimeNotification } from "@pico/protocol";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { CostTracker } from "@pico/pico-host/cost-tracker";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { CreateGoalTool } from "@pico/pico-host/goal-tools";
import { RuntimeRunExecutor } from "@pico/pico-host/runtime-run-executor";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { resolvePicoPaths } from "@pico/pico-host/pico-paths";
import { globalSessionManager } from "@pico/pico-host/session";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import type { StartDaemonRunInput } from "@pico/pico-host/workspace-runtime-service";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";
import { reportFixtureAttempt } from "../../fixtures/native-accounting.js";
import type { GoalEvidenceContext } from "@pico/runtime/goal-evaluator";

type Evaluation = {
  met: boolean;
  impossible: boolean;
  progress: boolean;
  waiting: boolean;
  reason: string;
};

type Work = (
  call: number,
  sessionId: string,
  messages: Message[],
  signal?: AbortSignal,
) => Promise<Message>;

interface RecoveryFixtureOptions {
  evaluations?: Evaluation[];
  work?: Work;
}

interface RecoveryFixture {
  readonly workspacePath: string;
  readonly picoHome: string;
  readonly runs: { runId: string; sessionId: string; origin: string }[];
  readonly evaluationCalls: () => number;
  readonly engineCalls: () => number;
  readonly createSession: () => Promise<string>;
  readonly state: (sessionId: string) => Promise<PersistedGoalManagerSnapshot>;
  readonly arm: (sessionId: string) => Promise<void>;
  readonly send: (sessionId: string, text?: string) => Promise<unknown>;
  readonly waitFor: (
    sessionId: string,
    predicate: (snapshot: PersistedGoalManagerSnapshot) => boolean,
    label: string,
  ) => Promise<PersistedGoalManagerSnapshot>;
  readonly interceptNextGoalAdmission: (
    handler: (input: StartDaemonRunInput) => Promise<void>,
  ) => void;
  readonly suppressFinishedForSession: (
    sessionId: string,
    onSuppressed: (event: RuntimeNotification) => void,
  ) => void;
  readonly observeRunFinished: (onFinished: (event: RuntimeNotification) => void) => void;
  readonly restart: () => Promise<void>;
  readonly close: () => Promise<void>;
}

async function createRecoveryFixture(
  context: TestContext,
  options: RecoveryFixtureOptions = {},
): Promise<RecoveryFixture> {
  const root = await mkdtemp(join(tmpdir(), "pico-goal-recovery-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await writeDesktopModelRouting(picoHome);
  const workspacePath = await realpath(workspace);
  const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "fixture-token" };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(workspacePath);
  const runs: RecoveryFixture["runs"] = [];
  const evaluations = [...(options.evaluations ?? [])];
  const sessionIds = new Set<string>();
  let workCalls = 0;
  let evaluationCalls = 0;
  let desktop: DesktopRuntimeService | undefined;
  let runtime: WorkspaceRuntimeService | undefined;
  let nextGoalAdmission: ((input: StartDaemonRunInput) => Promise<void>) | undefined;
  let suppressedSessionId: string | undefined;
  let onSuppressedFinished: ((event: RuntimeNotification) => void) | undefined;
  let onRunFinished: ((event: RuntimeNotification) => void) | undefined;

  const removeManagedSessions = async (): Promise<void> => {
    for (const sessionId of sessionIds) {
      await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
    }
  };

  const install = async (): Promise<void> => {
    runtime = new WorkspaceRuntimeService({
      env,
      execute: async ({ sessionId, execution, context: runContext }) => {
        runs.push({
          runId: runContext.run.runId,
          sessionId: sessionId!,
          origin: execution?.origin ?? "user",
        });
        const lease = await globalSessionManager.getOrCreatePinned(sessionId!, workspacePath, {
          persistence: true,
          picoHome,
          runtimePort: createEngineRuntimePort(),
        });
        const session = lease.session;
        const manager = session.getGoalManager();
        const ledger = new SqliteRuntimeControlStore({
          storageRoot: resolvePicoPaths(workspacePath, { picoHome }).workspace.root,
        });
        try {
          const registry = new ToolRegistry();
          registry.register(new CreateGoalTool(manager));
          const provider = new CostTracker(
            {
              generate: async (messages, _tools, request) => {
                const call = ++workCalls;
                const response = options.work
                  ? await options.work(call, session.id, messages, request?.signal)
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
            provider,
            registry,
            goalManager: manager,
            runtimePort: createEngineRuntimePort(),
          });
          engineCalls++;
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
    const rawRuntime = runtime;
    const desktopRuntime = new Proxy(rawRuntime, {
      get(target, property) {
        if (property === "subscribe")
          return (listener: (event: RuntimeNotification) => void) =>
            target.subscribe((event) => {
              if (event.topic === "run.finished") onRunFinished?.(event);
              if (
                event.topic === "run.finished" &&
                suppressedSessionId !== undefined &&
                event.scope.sessionId === suppressedSessionId
              ) {
                onSuppressedFinished?.(event);
                return;
              }
              listener(event);
            });
        if (property === "startForegroundRun")
          return async (input: StartDaemonRunInput) => {
            if (input.execution?.origin === "goal" && nextGoalAdmission) {
              const intercept = nextGoalAdmission;
              nextGoalAdmission = undefined;
              await intercept(input);
            }
            return rawRuntime.startForegroundRun(input);
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkspaceRuntimeService;
    desktop = new DesktopRuntimeService({
      runtimeService: desktopRuntime,
      trustStore,
      env,
      providerFactory: () => ({
        generate: async (messages, tools, request) => {
          evaluationCalls++;
          assert.equal(tools.length, 0);
          assert.equal(request?.maxOutputTokens, 1024);
          const verdict = evaluations.shift() ?? {
            met: true,
            impossible: false,
            progress: false,
            waiting: false,
            reason: "已完成",
          };
          const usage = { promptTokens: 30, completionTokens: 10 };
          await reportFixtureAttempt(request, "openai", "coder", usage);
          const evidenceLine = messages[1]!.content
            .split("\n")
            .find((line) => line.startsWith('{"identity":'))!;
          const evidence = JSON.parse(evidenceLine) as GoalEvidenceContext;
          if (verdict.met) {
            assert.ok(evidence.finalReplyEventId);
            assert.match(evidence.finalReply!.content, /完成/u);
          }
          return {
            role: "assistant",
            content: JSON.stringify({
              ...verdict,
              ...(verdict.met
                ? { acceptanceBasis: "delivery", citedEvidenceIds: [evidence.finalReplyEventId] }
                : {}),
            }),
            usage,
          };
        },
      }),
    });
    await desktop.handle(createRuntimeRequest("workspace.register", { workspacePath }));
  };

  const shutdown = async (): Promise<void> => {
    const closing = desktop;
    desktop = undefined;
    runtime = undefined;
    if (closing) await closing.close();
    await removeManagedSessions();
  };

  const requireDesktop = (): DesktopRuntimeService => {
    assert.ok(desktop, "Desktop Runtime is installed");
    return desktop;
  };
  let engineCalls = 0;
  await install();
  context.after(async () => {
    await shutdown();
    await rm(root, { recursive: true, force: true });
  });

  return {
    workspacePath,
    picoHome,
    runs,
    evaluationCalls: () => evaluationCalls,
    engineCalls: () => engineCalls,
    createSession: async () => {
      const result = (await requireDesktop().handle(
        createRuntimeRequest("session.create", { workspacePath }),
      )) as { session: { sessionId: string } };
      sessionIds.add(result.session.sessionId);
      return result.session.sessionId;
    },
    state: async (sessionId) =>
      (
        (await requireDesktop().handle(
          createRuntimeRequest("goal.get", { workspacePath, sessionId }),
        )) as unknown as { goal: PersistedGoalManagerSnapshot }
      ).goal,
    arm: async (sessionId) => {
      const snapshot = await (
        (await requireDesktop().handle(
          createRuntimeRequest("goal.get", { workspacePath, sessionId }),
        )) as unknown as { goal: PersistedGoalManagerSnapshot }
      ).goal;
      await requireDesktop().handle(
        createRuntimeRequest("goal.control", {
          workspacePath,
          sessionId,
          action: "arm",
          condition: "最终回复包含“完成”两个字。",
          expectedRevision: snapshot.currentGoal?.revision ?? 0,
        }),
      );
    },
    send: (sessionId, text = "开始工作") =>
      requireDesktop().handle(
        createRuntimeRequest("session.send", {
          workspacePath,
          sessionId,
          input: { kind: "text", text },
          idempotencyKey: `recovery-${sessionId}-${text}`,
        }),
      ),
    waitFor: async (sessionId, predicate, label) => {
      for (let attempt = 0; attempt < 500; attempt++) {
        const snapshot = await (
          (await requireDesktop().handle(
            createRuntimeRequest("goal.get", { workspacePath, sessionId }),
          )) as unknown as { goal: PersistedGoalManagerSnapshot }
        ).goal;
        if (predicate(snapshot)) return snapshot;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const last = await (
        (await requireDesktop().handle(
          createRuntimeRequest("goal.get", { workspacePath, sessionId }),
        )) as unknown as { goal: PersistedGoalManagerSnapshot }
      ).goal;
      assert.fail(`等待 ${label} 超时：${JSON.stringify(last)}`);
    },
    interceptNextGoalAdmission: (handler) => {
      nextGoalAdmission = handler;
    },
    suppressFinishedForSession: (sessionId, onSuppressed) => {
      suppressedSessionId = sessionId;
      onSuppressedFinished = onSuppressed;
    },
    observeRunFinished: (onFinished) => {
      onRunFinished = onFinished;
    },
    restart: async () => {
      await shutdown();
      await install();
    },
    close: shutdown,
  };
}

test("pending Goal continuation survives Host restart with the same Run identity", async (t) => {
  let goalSession = "";
  let blockerSession = "";
  let releaseGoal!: () => void;
  let releaseBlocker!: () => void;
  const goalGate = new Promise<void>((resolve) => {
    releaseGoal = resolve;
  });
  const blockerGate = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const f = await createRecoveryFixture(t, {
    evaluations: [
      {
        met: false,
        impossible: false,
        progress: true,
        waiting: false,
        reason: "本轮有进展",
      },
      {
        met: true,
        impossible: false,
        progress: false,
        waiting: false,
        reason: "全部完成",
      },
    ],
    work: async (_call, sessionId, _messages, signal) => {
      const gate =
        sessionId === goalSession
          ? goalGate
          : sessionId === blockerSession
            ? blockerGate
            : undefined;
      if (gate) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
          void gate.then(resolve);
        });
      }
      return { role: "assistant", content: "完成当前工作步骤。" };
    },
  });
  t.after(() => {
    releaseGoal();
    releaseBlocker();
  });
  goalSession = await f.createSession();
  blockerSession = await f.createSession();
  await f.arm(goalSession);
  await f.send(goalSession);
  await waitForEngineCall(f, goalSession);
  const queued = await f.send(blockerSession, "等待 Goal 期间到达的用户输入");
  assert.equal((queued as { disposition?: string }).disposition, "queued");
  releaseGoal();

  const pending = await f.waitFor(
    goalSession,
    (snapshot) => snapshot.coordinator.pendingContinuation !== null,
    "持久化 pending continuation",
  );
  const originalRunId = pending.coordinator.pendingContinuation!.runId;
  await waitForEngineCall(f, blockerSession);
  assert.ok(
    f.runs.some((run) => run.sessionId === blockerSession),
    "排队的用户 Run 已优先启动",
  );
  assert.equal(
    f.runs.some((run) => run.origin === "goal"),
    false,
  );

  await f.restart();
  const achieved = await f.waitFor(
    goalSession,
    (snapshot) => snapshot.currentGoal?.status === "achieved",
    "重启后的 Goal 验收",
  );
  const resumed = f.runs.filter((run) => run.origin === "goal");
  assert.deepEqual(
    resumed.map((run) => run.runId),
    [originalRunId],
  );
  assert.equal(achieved.coordinator.lastSettledRunId, originalRunId);
});

test("prepared Goal admission after daemon registration reuses its identity once", async (t) => {
  const f = await createRecoveryFixture(t, {
    evaluations: [
      {
        met: false,
        impossible: false,
        progress: true,
        waiting: false,
        reason: "继续",
      },
      {
        met: true,
        impossible: false,
        progress: false,
        waiting: false,
        reason: "完成",
      },
    ],
  });
  const sessionId = await f.createSession();
  await f.arm(sessionId);
  let captured: PersistedGoalManagerSnapshot | undefined;
  let preparedRunId = "";
  let interruptedRunFinished: RuntimeNotification | undefined;
  let intercepted!: () => void;
  const crashCutReached = new Promise<void>((resolve) => {
    intercepted = resolve;
  });
  f.interceptNextGoalAdmission(async (input) => {
    const lease = await globalSessionManager.getOrCreatePinned(sessionId, f.workspacePath, {
      persistence: true,
      picoHome: f.picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    try {
      const session = lease.session;
      captured = session.getGoalManager().snapshot();
      const execution = captured.coordinator.currentExecution;
      assert.ok(execution, "Host 已持久化 currentExecution");
      assert.equal(execution.started, false);
      assert.equal(execution.origin, "goal");
      assert.equal(execution.runId, input.execution?.goalPreparedRun?.runId);
      preparedRunId = execution.runId;
      const canonical = await session.runtimeEventStore!.readRun(sessionId, execution.runId);
      assert.equal(canonical.filter((event) => event.kind === "run.started").length, 1);
      assert.equal(
        canonical.some((event) => event.kind === "run.terminal"),
        false,
      );
      const ledger = new SqliteRuntimeControlStore({
        storageRoot: resolvePicoPaths(f.workspacePath, { picoHome: f.picoHome }).workspace.root,
      });
      try {
        ledger.upsertDaemonRun({
          runId: execution.daemonRunId,
          workspacePath: f.workspacePath,
          sessionId,
          description: `🎯 Goal continuation · ${captured.currentGoal!.condition}`,
          status: "running",
          startedAt: execution.runStartedAt,
          updatedAt: execution.runStartedAt,
          version: 1,
        });
        assert.equal(
          ledger.getDaemonRun(f.workspacePath, execution.daemonRunId)?.status,
          "running",
        );
      } finally {
        ledger.close();
      }
    } finally {
      lease.release();
    }
    intercepted();
    throw new Error("simulated crash after canonical prestart and daemon registration");
  });

  await f.send(sessionId);
  await crashCutReached;
  await f.waitFor(
    sessionId,
    (snapshot) => snapshot.currentGoal?.status === "paused",
    "failed simulated admission",
  );
  assert.ok(captured);
  const failedAttempt = await f.state(sessionId);
  assert.equal(failedAttempt.currentGoal?.status, "paused");
  assert.equal(failedAttempt.coordinator.currentExecution?.started, false);
  const lease = await globalSessionManager.getOrCreatePinned(sessionId, f.workspacePath, {
    persistence: true,
    picoHome: f.picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  try {
    lease.session.getGoalManager().restore(captured);
    lease.session.updateRuntimeState({ goal: captured });
    await lease.session.flushPersistence();
    assert.equal(
      lease.session.getGoalManager().snapshot().coordinator.currentExecution?.started,
      false,
    );
  } finally {
    lease.release();
  }
  const beforeRestart = await f.state(sessionId);
  assert.equal(beforeRestart.coordinator.currentExecution?.started, false);
  assert.equal(beforeRestart.coordinator.currentExecution?.runId, preparedRunId);

  f.observeRunFinished((event) => {
    if (event.scope.runId === preparedRunId && interruptedRunFinished === undefined)
      interruptedRunFinished = event;
  });
  await f.restart();
  const final = await f.waitFor(
    sessionId,
    (snapshot) => snapshot.currentGoal?.status === "achieved",
    "恢复 prepared admission 并验收",
  );
  const goalRuns = f.runs.filter((run) => run.origin === "goal");
  assert.deepEqual(
    goalRuns.map((run) => run.runId),
    [preparedRunId],
  );
  assert.equal(f.engineCalls(), 2, "一个用户 Run 加一次同身份 Goal Engine execution");
  assert.equal(final.coordinator.lastSettledRunId, preparedRunId);
  assert.ok(interruptedRunFinished, "重启时 daemon ledger 发布了 Run interrupted 终态");
  const recoveredRun = (
    interruptedRunFinished.payload as { run?: { runId?: string; status?: string; error?: string } }
  ).run;
  assert.equal(recoveredRun?.runId, preparedRunId);
  assert.equal(recoveredRun?.status, "failed");
  assert.match(recoveredRun?.error ?? "", /daemon 重启前 Run 未进入终态/u);
});

test("canonical Run completion is evaluated after restart without rerunning the Engine", async (t) => {
  const f = await createRecoveryFixture(t, {
    evaluations: [
      {
        met: true,
        impossible: false,
        progress: false,
        waiting: false,
        reason: "从持久化 Run 证据验收完成",
      },
    ],
  });
  const sessionId = await f.createSession();
  await f.arm(sessionId);
  let runId = "";
  let canonicalRunId: string;
  let completionObserved!: () => void;
  const completion = new Promise<void>((resolve) => {
    completionObserved = resolve;
  });
  f.suppressFinishedForSession(sessionId, (event) => {
    runId = event.scope.runId!;
    completionObserved();
  });

  await f.send(sessionId);
  await completion;
  const durable = new SqliteRuntimeControlStore({
    storageRoot: resolvePicoPaths(f.workspacePath, { picoHome: f.picoHome }).workspace.root,
  });
  try {
    const daemonRun = durable.getDaemonRun(f.workspacePath, runId);
    assert.equal(daemonRun?.status, "succeeded");
  } finally {
    durable.close();
  }
  const lease = await globalSessionManager.getOrCreatePinned(sessionId, f.workspacePath, {
    persistence: true,
    picoHome: f.picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  try {
    const goal = lease.session.getGoalManager().snapshot();
    assert.equal(goal.currentGoal?.status, "active");
    assert.equal(goal.coordinator.currentExecution?.daemonRunId, runId);
    assert.equal(goal.coordinator.currentExecution?.started, true);
    canonicalRunId = goal.coordinator.currentExecution!.runId;
    const canonical = await lease.session.runtimeEventStore!.readRun(sessionId, canonicalRunId);
    assert.ok(canonical.some((event) => event.kind === "run.terminal"));
  } finally {
    lease.release();
  }
  assert.equal(f.evaluationCalls(), 0, "Host 尚未收到被抑制的 run.finished");
  assert.equal(f.engineCalls(), 1);

  await f.restart();
  const final = await f.waitFor(
    sessionId,
    (snapshot) => snapshot.currentGoal?.status === "achieved",
    "使用 canonical Run 结果补做验收",
  );
  assert.equal(f.engineCalls(), 1, "恢复只验收，不重复执行 Engine");
  assert.equal(f.evaluationCalls(), 1);
  assert.equal(final.coordinator.lastSettledRunId, runId);
  assert.equal(final.currentGoal!.lastEvaluation!.evidenceTrace!.sourceRunId, canonicalRunId);
});

test("armed Goal survives restart without automatic admission", async (t) => {
  const f = await createRecoveryFixture(t);
  const sessionId = await f.createSession();
  await f.arm(sessionId);
  const armed = await f.state(sessionId);
  assert.ok(armed.currentGoal?.armedAt);
  await f.restart();
  const restored = await f.state(sessionId);
  assert.ok(restored.currentGoal?.armedAt);
  assert.equal(restored.coordinator.pendingContinuation, null);
  assert.equal(restored.coordinator.currentExecution, null);
  assert.equal(f.runs.length, 0);
  assert.equal(f.engineCalls(), 0);
});

async function waitForEngineCall(f: RecoveryFixture, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (f.runs.some((run) => run.sessionId === sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Session ${sessionId} 未进入 Engine`);
}
