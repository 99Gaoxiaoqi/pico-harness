import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PromptComposer } from "../../src/context/composer.js";
import { PlanHandoffController } from "../../src/engine/plan-handoff.js";
import { isPlanProviderTool } from "../../src/engine/loop.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { projectRuntimeSessionState } from "../../src/engine/session-runtime-projection.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { HookService } from "../../src/hooks/service.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { PlanCoordinator } from "../../src/plan/coordinator.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import {
  AgentRuntime,
  buildForegroundSafetyMiddleware,
  executeAgentRuntime,
} from "../../src/runtime/agent-runtime.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { createSessionRuntime } from "../../src/runtime/session-runtime.js";
import {
  RuntimeEventStore,
  RuntimeEventStorePlanOperationConflictError,
} from "../../src/storage/runtime-event-store.js";
import { SubmitPlanTool } from "../../src/tools/plan-exit.js";
import { buildDefaultToolRegistry } from "../../src/tools/default-registry.js";

test("submit_plan persists a proposal and marks a machine-readable handoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-submit-plan-"));
  const workDir = join(root, "work");
  await mkdir(workDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RuntimeEventStore({ storageRoot: join(root, "state") });
  await store.initializeSession({ sessionId: "session-1", workDir });
  const coordinator = new PlanCoordinator(store, {
    sessionId: "session-1",
    invocationId: "inv-1",
    runId: "run-1",
    turnId: "turn-1",
  });
  const handoff = new PlanHandoffController();
  const tool = new SubmitPlanTool(
    () => coordinator,
    handoff,
    "session-1",
    () => "run-1",
  );
  const output = JSON.parse(
    await tool.execute(
      JSON.stringify({
        title: "Ship plan mode",
        overview: "Keep planning read-only",
        steps: [{ id: "step-1", title: "Implement", description: "Implement the approved change" }],
        risks: ["stale approval"],
        operationId: "submit-1",
      }),
    ),
  ) as { kind: string; planId: string; revision: number };
  assert.equal(output.kind, "plan_handoff");
  assert.equal(output.revision, 1);
  assert.equal(handoff.hasPending(), true);
  assert.equal((await coordinator.project()).pendingProposal?.planId, output.planId);
});

test("plan tool projection and registry safety are the same deny-by-default boundary", async () => {
  const allowed = ["read_file", "grep", "skill_view", "repo_map", "ask_user", "submit_plan"];
  for (const name of allowed) assert.equal(isPlanProviderTool(name), true, name);
  const denied = ["bash", "write_file", "edit_file", "web_search", "delegate_task", "mcp__x__y"];
  const safety = buildForegroundSafetyMiddleware(
    process.cwd(),
    { mode: "plan" },
    undefined,
    undefined,
    () => "plan",
  );
  for (const name of denied) {
    assert.equal(isPlanProviderTool(name), false, name);
    assert.equal(
      (await safety({ id: `call-${name}`, name, arguments: "{}" })).allowed,
      false,
      name,
    );
  }
});

test("plan prompt is investigation-only and has no PLAN/TODO authority", async () => {
  const prompt = await new PromptComposer(process.cwd(), true).build();
  assert.match(prompt, /只能调查、澄清需求并提交实施计划/u);
  assert.match(prompt, /submit_plan/u);
  assert.doesNotMatch(prompt, /使用 write_file 创建 PLAN\.md|开始执行 TODO\.md/u);
});

test("approved execution registry exposes update and cancel but not submit", () => {
  const registry = buildDefaultToolRegistry(process.cwd(), {
    plan: {
      coordinator: () => null as never,
      handoff: new PlanHandoffController(),
      sessionId: "session-1",
      runId: () => "run-1",
      mode: "execution",
      planId: "plan-1",
    },
  });
  assert.ok(registry.getTool("update_plan"));
  assert.ok(registry.getTool("cancel_plan"));
  assert.equal(registry.getTool("submit_plan"), undefined);
});

test("Plan provider projection always exposes submit_plan through tool disclosure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-disclosure-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  let providerCalls = 0;
  const provider: LLMProvider = {
    async generate(_messages, tools) {
      providerCalls++;
      assert.ok(tools.some((tool) => tool.name === "submit_plan"));
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "submit-after-disclosure",
            name: "submit_plan",
            arguments: JSON.stringify({
              title: "可提交计划",
              steps: [{ title: "实施", description: "审批后执行" }],
              operationId: "plan-disclosure-submit",
            }),
          },
        ],
      };
    },
  };
  const result = await executeAgentRuntime(
    {
      prompt: "调查并提交计划",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId: "plan-disclosure" },
      provider: "openai",
      modelRouteId: "test/test",
      interactionMode: "plan",
      allowedTools: ["read_file", "submit_plan"],
    },
    { provider, picoHome, reporter: new SilentReporter() },
  );

  assert.equal(providerCalls, 1);
  assert.equal(result.handoff?.kind, "plan_handoff");
});

test("Plan Run isolates and restores code intelligence owned by an injected SessionRuntime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-injected-lsp-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "plan-injected-lsp";
  await mkdir(workDir);
  const sessionLease = await globalSessionManager.getOrCreatePinned(sessionId, workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  const runtimeState = await createSessionRuntime({
    session: sessionLease.session,
    sessionLease,
    hooks: false,
    lspServers: [],
  });
  t.after(async () => {
    await runtimeState.dispose();
    const released = globalSessionManager.delete(sessionId, workDir, { picoHome });
    await released?.close();
    await rm(root, { recursive: true, force: true });
  });
  const manager = runtimeState.codeIntelligenceManager;
  const originalClose = manager.close.bind(manager);
  const originalStart = manager.start.bind(manager);
  let closes = 0;
  let starts = 0;
  manager.close = async () => {
    closes++;
    await originalClose();
  };
  manager.start = async () => {
    starts++;
    return await originalStart();
  };
  const provider: LLMProvider = {
    async generate(_messages, tools) {
      assert.match(manager.status().reason, /运行时策略禁用/u);
      assert.equal(manager.lspClient(), undefined, "injected LSP is closed before Run");
      assert.equal(
        tools.some(({ name }) => name.startsWith("code_")),
        false,
      );
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "submit-injected-lsp",
            name: "submit_plan",
            arguments: JSON.stringify({
              title: "隔离注入 LSP",
              steps: [{ title: "实施", description: "审批后实施" }],
              operationId: "submit-injected-lsp",
            }),
          },
        ],
      };
    },
  };

  const result = await executeAgentRuntime(
    {
      prompt: "只提交计划",
      dir: workDir,
      sessionSelection: { mode: "resume", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      interactionMode: "plan",
    },
    { provider, picoHome, runtimeState, reporter: new SilentReporter() },
  );

  assert.equal(result.handoff?.kind, "plan_handoff");
  assert.equal(closes, 1);
  assert.equal(starts, 1, "Plan keeps only the process-free Repo Map backend active");
  assert.match(manager.status().reason, /运行时策略禁用/u);
  const handoff = result.handoff;
  assert.ok(handoff);
  const executionProvider: LLMProvider = {
    async generate() {
      assert.doesNotMatch(manager.status().reason, /运行时策略禁用/u);
      return { role: "assistant", content: "execution paused" };
    },
  };
  await new AgentRuntime().approvePlanAndExecute(
    {
      approval: {
        sessionId,
        dir: workDir,
        planId: handoff.planId,
        expectedRevision: handoff.revision,
        expectedSessionSequence: handoff.expectedSessionSequence,
        operationId: "approve-injected-lsp",
      },
      execution: {
        provider: "openai",
        modelRouteId: "test/test",
        sessionSelection: { mode: "resume", sessionId },
        interactionMode: "yolo",
      },
    },
    { provider: executionProvider, picoHome, runtimeState, reporter: new SilentReporter() },
  );
  assert.equal(closes, 2);
  assert.equal(starts, 2);
  assert.equal(runtimeState.codeIntelligence.backend, "repo-map");
});

test("Plan runtime suppresses injected hooks and their filesystem side effects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-hook-isolation-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const hookOutput = join(workDir, "malicious-hook-output");
  await mkdir(workDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  let hookCalls = 0;
  const hookService = new HookService({
    workDir,
    sessionId: "plan-hook-isolation",
    executor: { execute: async () => ({ decision: "allow" }) },
    decisionProviders: [
      {
        async evaluate() {
          hookCalls++;
          await writeFile(hookOutput, "hook escaped plan mode", "utf8");
          return { decision: "allow" };
        },
      },
    ],
  });
  const provider: LLMProvider = {
    async generate(_messages, tools) {
      assert.equal(
        tools.some(({ name }) => name.startsWith("code_")),
        false,
      );
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "submit-hook-isolation",
            name: "submit_plan",
            arguments: JSON.stringify({
              title: "隔离 Hook",
              steps: [{ title: "实施", description: "审批后实施" }],
              operationId: "submit-hook-isolation",
            }),
          },
        ],
      };
    },
  };

  const planned = await executeAgentRuntime(
    {
      prompt: "只调研并提交计划",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId: "plan-hook-isolation" },
      provider: "openai",
      modelRouteId: "test/test",
      interactionMode: "plan",
    },
    { provider, picoHome, hookService, reporter: new SilentReporter() },
  );

  assert.equal(hookCalls, 0);
  await assert.rejects(access(hookOutput));
  const handoff = planned.handoff;
  assert.ok(handoff);
  const runtime = new AgentRuntime();
  const revisionRequest = {
    sessionId: "plan-hook-isolation",
    dir: workDir,
    picoHome,
    planId: handoff.planId,
    expectedRevision: handoff.revision,
    expectedSessionSequence: handoff.expectedSessionSequence,
    operationId: "request-hook-isolation-revision",
    feedback: "补充隔离验证",
  };
  assert.equal((await runtime.requestPlanRevision(revisionRequest)).replayed, false);
  assert.equal((await runtime.requestPlanRevision(revisionRequest)).replayed, true);
  assert.equal(
    (await runtime.readPlanProjection({ sessionId: "plan-hook-isolation", dir: workDir, picoHome }))
      .revisionRequest?.feedback,
    "补充隔离验证",
  );
});

test("approval recovers its crash gap and replay never starts a second execution Run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-approval-replay-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "plan-approval-replay";
  await mkdir(workDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const planningProvider: LLMProvider = {
    async generate() {
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "submit-approval-replay",
            name: "submit_plan",
            arguments: JSON.stringify({
              planId: "approval-replay-plan",
              title: "Approval replay",
              steps: [{ id: "one", title: "One", description: "Do one" }],
              operationId: "submit-approval-replay",
            }),
          },
        ],
      };
    },
  };
  const runtime = new AgentRuntime();
  const planned = await runtime.execute(
    {
      prompt: "提交一个计划",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      interactionMode: "plan",
    },
    { provider: planningProvider, picoHome, reporter: new SilentReporter() },
  );
  const handoff = planned.handoff;
  assert.ok(handoff);
  assert.equal(
    (await runtime.readPlanProjection({ sessionId, dir: workDir, picoHome })).pendingProposal
      ?.planId,
    handoff.planId,
  );

  const store = new RuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
  const settings = projectRuntimeSessionState(await store.readSession(sessionId)).settings;
  assert.ok(settings);
  const coordinator = new PlanCoordinator(store, {
    sessionId,
    invocationId: "approval-crash",
    runId: "approval-crash",
    turnId: "approval-crash",
  });
  await coordinator.approve({
    operationId: "approve-crash-gap",
    expectedSessionSequence: handoff.expectedSessionSequence,
    planId: handoff.planId,
    expectedRevision: handoff.revision,
    reviewedBy: "user",
    settings,
  });
  store.close();

  let executionProviderCalls = 0;
  const executionProvider: LLMProvider = {
    async generate() {
      executionProviderCalls++;
      return { role: "assistant", content: "execution stopped before completing the plan" };
    },
  };
  const request = {
    approval: {
      sessionId,
      dir: workDir,
      planId: handoff.planId,
      expectedRevision: handoff.revision,
      expectedSessionSequence: handoff.expectedSessionSequence,
      operationId: "approve-crash-gap",
    },
    execution: {
      provider: "openai" as const,
      modelRouteId: "test/test",
      sessionSelection: { mode: "resume" as const, sessionId },
      interactionMode: "yolo" as const,
    },
  };
  await runtime.approvePlanAndExecute(request, {
    provider: executionProvider,
    picoHome,
    reporter: new SilentReporter(),
  });
  assert.equal(executionProviderCalls, 1, "approved-but-not-started recovers by executing once");
  const replayed = await runtime.approvePlanAndExecute(request, {
    provider: executionProvider,
    picoHome,
    reporter: new SilentReporter(),
  });
  assert.equal(replayed.replayedOperationId, "approve-crash-gap");
  assert.equal(executionProviderCalls, 1, "approval replay does not call the provider again");
  await assert.rejects(
    runtime.approvePlanAndExecute(
      {
        ...request,
        approval: { ...request.approval, expectedRevision: handoff.revision + 1 },
      },
      { provider: executionProvider, picoHome, reporter: new SilentReporter() },
    ),
    RuntimeEventStorePlanOperationConflictError,
  );
});
