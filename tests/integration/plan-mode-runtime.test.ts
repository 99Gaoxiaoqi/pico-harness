import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PromptComposer } from "../../src/context/composer.js";
import { DiscoveryCoordinator } from "../../src/discovery/coordinator.js";
import { PlanHandoffController } from "../../src/engine/plan-handoff.js";
import { isPlanProviderTool } from "../../src/engine/loop.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { projectRuntimeSessionState } from "../../src/engine/session-runtime-projection.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { HookService } from "../../src/hooks/service.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { PlanCoordinator } from "../../src/plan/coordinator.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
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
  await coordinator.requestRevision({
    operationId: "request-revision",
    expectedSessionSequence: 1,
    planId: output.planId,
    expectedRevision: 1,
    feedback: "补充恢复步骤",
  });
  const revisedHandoff = new PlanHandoffController();
  const revisedTool = new SubmitPlanTool(
    () => coordinator,
    revisedHandoff,
    "session-1",
    () => "run-2",
  );
  const revised = JSON.parse(
    await revisedTool.execute(
      JSON.stringify({
        title: "Ship plan mode safely",
        steps: [{ title: "Recover", description: "Cover recovery" }],
        operationId: "submit-revision-2",
      }),
    ),
  ) as { revision: number };
  assert.equal(revised.revision, 2);
  assert.equal((await coordinator.project()).revisionRequest, undefined);
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

test("Plan automatically records verified Discovery evidence before atomic handoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-discovery-auto-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "plan-discovery-auto";
  await mkdir(workDir);
  await writeFile(join(workDir, "target.ts"), "export const canary = 'verified';\n", "utf8");
  t.after(async () => {
    const released = globalSessionManager.delete(sessionId, workDir, { picoHome });
    await released?.close();
    await rm(root, { recursive: true, force: true });
  });
  let providerCalls = 0;
  const provider: LLMProvider = {
    async generate() {
      providerCalls++;
      if (providerCalls === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "read-verified-target",
              name: "read_file",
              arguments: JSON.stringify({ path: "target.ts" }),
            },
          ],
        };
      }
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "submit-verified-plan",
            name: "submit_plan",
            arguments: JSON.stringify({
              title: "修改已核验目标",
              overview: "target.ts 已直接读取并形成 Evidence",
              steps: [{ title: "修改 target.ts", description: "仅修改已核验的目标文件" }],
              operationId: "submit-verified-plan",
            }),
          },
        ],
      };
    },
  };

  const result = await executeAgentRuntime(
    {
      prompt: "读取 target.ts 后提交计划",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      interactionMode: "plan",
      allowedTools: ["read_file", "submit_plan"],
    },
    { provider, picoHome, reporter: new SilentReporter() },
  );
  assert.ok(result.handoff);

  const store = new RuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
  const events = await store.readSession(sessionId);
  store.close();
  const startedIndex = events.findIndex((event) => event.kind === "discovery.started");
  const checkpointIndex = events.findIndex((event) => event.kind === "discovery.checkpointed");
  const completedIndex = events.findIndex((event) => event.kind === "discovery.completed");
  const proposedIndex = events.findIndex((event) => event.kind === "plan.proposed");
  assert.ok(startedIndex >= 0 && checkpointIndex > startedIndex);
  assert.equal(completedIndex + 1, proposedIndex);
  const checkpoint = events[checkpointIndex];
  assert.ok(checkpoint?.kind === "discovery.checkpointed");
  assert.equal(checkpoint.data.checkpoint.phase, "verify");
  assert.deepEqual(checkpoint.data.checkpoint.inspectedFiles, ["target.ts"]);
  assert.ok(checkpoint.data.checkpoint.evidenceRefs.length > 0);
  const completed = events[completedIndex];
  const proposed = events[proposedIndex];
  assert.ok(completed?.kind === "discovery.completed");
  assert.ok(proposed?.kind === "plan.proposed");
  assert.equal(completed.data.operationId, proposed.data.operationId);
});

test("Plan accepts a workspace-local absolute read_file path as direct Discovery evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-absolute-discovery-read-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "plan-absolute-discovery-read";
  const targetPath = join(workDir, "src", "target.ts");
  await mkdir(join(workDir, "src"), { recursive: true });
  await writeFile(targetPath, "export const target = true;\n", "utf8");
  t.after(async () => {
    globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });
  let calls = 0;
  const provider: LLMProvider = {
    async generate() {
      calls++;
      if (calls === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "absolute-target-read",
              name: "read_file",
              arguments: JSON.stringify({ path: targetPath }),
            },
          ],
        };
      }
      if (calls === 2)
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "absolute-target-plan",
              name: "submit_plan",
              arguments: JSON.stringify({
                title: "修改已核验目标",
                steps: [{ title: "修改", description: "更新 src/target.ts" }],
                operationId: "absolute-target-plan",
              }),
            },
          ],
        };
      return { role: "assistant", content: "stop after rejected handoff" };
    },
  };

  const result = await executeAgentRuntime(
    {
      prompt: "先调查目标再提交计划",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      interactionMode: "plan",
      allowedTools: ["read_file", "submit_plan"],
    },
    { provider, picoHome, reporter: new SilentReporter() },
  );
  if (!result.handoff) {
    const session = await globalSessionManager.getOrCreate(sessionId, workDir, {
      persistence: true,
      picoHome,
    });
    const failures = (await session.runtimeEventStore!.readSession(sessionId)).flatMap((event) =>
      event.kind === "tool.result.recorded" && event.data.status !== "succeeded"
        ? [event.data.projection.text]
        : [],
    );
    assert.fail(failures.join(" | "));
  }
});

test("Plan Repo Map clamps one scan to the remaining Discovery file budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-discovery-repo-budget-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "plan-discovery-repo-budget";
  await mkdir(workDir);
  for (let index = 0; index < 40; index++) {
    await writeFile(
      join(workDir, `module-${String(index).padStart(2, "0")}.ts`),
      `export const value${index} = ${index};\n`,
      "utf8",
    );
  }
  t.after(async () => {
    const released = globalSessionManager.delete(sessionId, workDir, { picoHome });
    await released?.close();
    await rm(root, { recursive: true, force: true });
  });
  let providerCalls = 0;
  let repoMapOutput = "";
  const provider: LLMProvider = {
    async generate(messages) {
      providerCalls++;
      if (providerCalls === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "scan-over-budget",
              name: "repo_map",
              arguments: JSON.stringify({ max_files: 200 }),
            },
          ],
        };
      }
      repoMapOutput =
        messages.findLast((message) => message.toolCallId === "scan-over-budget")?.content ?? "";
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "submit-after-budget",
            name: "submit_plan",
            arguments: JSON.stringify({
              title: "记录扫描预算",
              steps: [{ title: "后续核验", description: "恢复 Discovery 后直接读取候选源码" }],
              operationId: "submit-after-budget",
            }),
          },
        ],
      };
    },
  };

  const result = await executeAgentRuntime(
    {
      prompt: "扫描仓库并提交计划",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      interactionMode: "plan",
      allowedTools: ["repo_map", "submit_plan"],
    },
    { provider, picoHome, reporter: new SilentReporter() },
  );
  assert.ok(result.handoff);
  assert.match(repoMapOutput, /backend=repo-map indexed=30\/40 cursor=30 complete=false/u);

  const store = new RuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
  const events = await store.readSession(sessionId);
  store.close();
  const checkpoint = events.find(
    (event) =>
      event.kind === "discovery.checkpointed" && event.data.checkpoint.inspectedFiles.length === 30,
  );
  assert.ok(checkpoint?.kind === "discovery.checkpointed");
  assert.equal(checkpoint.data.checkpoint.candidates.length, 20);
  assert.equal(
    events.some(
      (event) =>
        event.kind === "discovery.interrupted" && event.data.limitReason === "budget_exhausted",
    ),
    true,
  );
});

test("a failed Plan Run interrupts its active automatic Discovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-discovery-failure-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "plan-discovery-failure";
  await mkdir(workDir);
  await writeFile(join(workDir, "target.ts"), "export const value = 1;\n", "utf8");
  t.after(async () => {
    const released = globalSessionManager.delete(sessionId, workDir, { picoHome });
    await released?.close();
    await rm(root, { recursive: true, force: true });
  });
  let providerCalls = 0;
  const provider: LLMProvider = {
    async generate() {
      providerCalls++;
      if (providerCalls === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "read-before-failure",
              name: "read_file",
              arguments: JSON.stringify({ path: "target.ts" }),
            },
          ],
        };
      }
      throw new Error("synthetic provider failure");
    },
  };

  await assert.rejects(
    executeAgentRuntime(
      {
        prompt: "读取 target.ts 后提交计划",
        dir: workDir,
        sessionSelection: { mode: "new", sessionId },
        provider: "openai",
        modelRouteId: "test/test",
        interactionMode: "plan",
        allowedTools: ["read_file", "submit_plan"],
      },
      { provider, picoHome, reporter: new SilentReporter() },
    ),
    /synthetic provider failure/u,
  );
  const store = new RuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
  const events = await store.readSession(sessionId);
  store.close();
  assert.equal(
    events.some((event) => event.kind === "discovery.started"),
    true,
  );
  assert.equal(
    events.some((event) => event.kind === "discovery.interrupted"),
    true,
  );
  assert.equal(
    events.some((event) => event.kind === "discovery.completed"),
    false,
  );
});

test("resumeExistingSession injects durable revision feedback into the provider turn tail", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-revision-tail-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "plan-revision-tail";
  await mkdir(workDir);
  const runtime = new AgentRuntime();
  const planned = await runtime.execute(
    {
      prompt: "旧用户消息，不包含新的修订要求",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      interactionMode: "plan",
    },
    {
      provider: submitPlanProvider("submit-revision-tail-v1"),
      picoHome,
      reporter: new SilentReporter(),
    },
  );
  const handoff = planned.handoff;
  assert.ok(handoff);
  const feedbackPrefix = "必须补充冷启动恢复和 operation replay 的验证步骤";
  const feedback = `${feedbackPrefix}${"甲".repeat(4_100)}TAIL_MUST_BE_TRUNCATED`;
  const operationId = "revision-feedback-operation";
  await runtime.requestPlanRevision({
    sessionId,
    dir: workDir,
    picoHome,
    planId: handoff.planId,
    expectedRevision: handoff.revision,
    expectedSessionSequence: handoff.expectedSessionSequence,
    operationId,
    feedback,
  });
  const sessionLease = await globalSessionManager.getOrCreatePinned(sessionId, workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  const runtimeState = await createSessionRuntime({
    session: sessionLease.session,
    sessionLease,
    hooks: false,
    lspEnabled: false,
  });
  t.after(async () => {
    await runtimeState.dispose();
    const released = globalSessionManager.delete(sessionId, workDir, { picoHome });
    await released?.close();
    await rm(root, { recursive: true, force: true });
  });
  let providerCalls = 0;
  const revisionProvider: LLMProvider = {
    async generate(messages) {
      providerCalls++;
      const currentUser =
        messages.findLast((message) => message.role === "user" && message.toolCallId === undefined)
          ?.content ?? "";
      assert.match(currentUser, /<plan-revision-request>/u);
      assert.match(currentUser, new RegExp(feedbackPrefix, "u"));
      assert.match(currentUser, new RegExp(operationId, "u"));
      assert.match(currentUser, /\[truncated \d+ chars\]/u);
      assert.doesNotMatch(currentUser, /TAIL_MUST_BE_TRUNCATED/u);
      assert.doesNotMatch(currentUser, /这个 prompt 不会被提交/u);
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "submit-revision-tail-v2",
            name: "submit_plan",
            arguments: JSON.stringify({
              title: "Revision with recovery",
              steps: [{ title: "Recover", description: "Verify cold recovery and replay" }],
              operationId: "submit-revision-tail-v2",
            }),
          },
        ],
      };
    },
  };
  const revised = await executeAgentRuntime(
    {
      prompt: "这个 prompt 不会被提交",
      dir: workDir,
      sessionSelection: { mode: "resume", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      interactionMode: "plan",
    },
    {
      provider: revisionProvider,
      picoHome,
      runtimeState,
      resumeExistingSession: true,
      reporter: new SilentReporter(),
    },
  );
  assert.equal(providerCalls, 1);
  assert.equal(revised.handoff?.revision, 2);
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
        true,
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
  const mcpOutput = join(workDir, "malicious-mcp-output");
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
        true,
      );
      assert.equal(
        tools.some(({ name }) => name.startsWith("mcp__")),
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
    {
      provider,
      picoHome,
      hookService,
      mcpConfigSources: [
        {
          id: "malicious-plan-mcp",
          config: {
            mcpServers: {
              evil: {
                name: "evil",
                transport: "stdio",
                command: process.execPath,
                args: [
                  "-e",
                  `require("node:fs").writeFileSync(${JSON.stringify(mcpOutput)}, "spawned")`,
                ],
              },
            },
          },
        },
      ],
      reporter: new SilentReporter(),
    },
  );

  assert.equal(hookCalls, 0);
  await assert.rejects(access(hookOutput));
  await assert.rejects(access(mcpOutput));
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

test("explicit Discovery stays isolated when the persisted collaboration mode is Plan", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-discovery-isolation-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  t.after(async () => {
    globalSessionManager.delete("plan-discovery-isolation", workDir, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });

  let hookCalls = 0;
  const hookService = new HookService({
    workDir,
    sessionId: "plan-discovery-isolation",
    executor: { execute: async () => ({ decision: "allow" }) },
    decisionProviders: [
      {
        async evaluate() {
          hookCalls++;
          return { decision: "allow" };
        },
      },
    ],
  });
  const provider: LLMProvider = {
    async generate(messages, tools) {
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      assert.equal(
        tools.some(({ name }) => name === "submit_plan"),
        false,
      );
      assert.equal(
        tools.some(({ name }) => name.startsWith("mcp__")),
        false,
      );
      assert.doesNotMatch(system, /只能调查、澄清需求并提交实施计划/u);
      return { role: "assistant", content: "只读调查报告" };
    },
  };

  const result = await executeAgentRuntime(
    {
      prompt: "执行隔离只读调查",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId: "plan-discovery-isolation" },
      provider: "openai",
      modelRouteId: "test/test",
      interactionMode: "plan",
      discoveryRun: true,
      allowedTools: ["read_file", "repo_map"],
    },
    { provider, picoHome, hookService, reporter: new SilentReporter() },
  );

  assert.equal(result.handoff, undefined);
  assert.equal(hookCalls, 0);
  const session = await globalSessionManager.getOrCreate("plan-discovery-isolation", workDir, {
    persistence: true,
    picoHome,
  });
  assert.equal(
    projectRuntimeSessionState(await session.runtimeEventStore!.readSession(session.id)).settings
      ?.collaborationMode,
    "plan",
  );
});

test("explicit balanced Discovery runs two Explore branches concurrently and records them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-discovery-delegation-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "discovery-delegation";
  await mkdir(join(workDir, "src"), { recursive: true });
  await mkdir(join(workDir, "tests"), { recursive: true });
  await writeFile(join(workDir, "src", "target.ts"), "export const target = 1;\n", "utf8");
  t.after(async () => {
    globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });

  let mainCalls = 0;
  let enteredBranches = 0;
  let releaseBranches!: () => void;
  const branchGate = new Promise<void>((resolve) => (releaseBranches = resolve));
  const provider: LLMProvider = {
    async generate(messages) {
      const history = messages.map((message) => message.content).join("\n");
      if (
        messages[0]?.role === "system" &&
        messages[0].content.includes("Explorer Subagent") &&
        (history.includes("入口调用链分支") || history.includes("符号引用分支"))
      ) {
        if (messages.some((message) => message.toolCallId === "branch-repo-map")) {
          return {
            role: "assistant",
            content:
              "已完成只读检索并形成直接证据。候选实现位于 src/target.ts，后续应由主调查直接读取并交叉核验。".repeat(
                6,
              ),
          };
        }
        enteredBranches++;
        if (enteredBranches === 2) releaseBranches();
        await branchGate;
        if (history.includes("符号引用分支")) {
          throw new Error("模拟互斥检索分支失败");
        }
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "branch-repo-map",
              name: "repo_map",
              arguments: JSON.stringify({ query: "target", max_files: 100 }),
            },
          ],
        };
      }
      mainCalls++;
      if (mainCalls === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "delegate-discovery-branches",
              name: "delegate_task",
              arguments: JSON.stringify({
                completion_policy: "required",
                tasks: [
                  {
                    goal: "入口调用链分支",
                    mode: "explore",
                    role: "leaf",
                    roots: ["src"],
                    max_files: 15,
                    stopping_condition: "找到入口到实现的直接证据",
                  },
                  {
                    goal: "符号引用分支",
                    mode: "explore",
                    role: "leaf",
                    roots: ["tests"],
                    max_files: 15,
                    stopping_condition: "找到定义与引用的直接证据",
                  },
                ],
              }),
            },
          ],
        };
      }
      if (mainCalls === 2) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "verify-discovery-target",
              name: "read_file",
              arguments: JSON.stringify({ path: "src/target.ts" }),
            },
          ],
        };
      }
      return { role: "assistant", content: "调查完成" };
    },
  };

  await executeAgentRuntime(
    {
      prompt: "并发定位 target 的真实实现",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      interactionMode: "default",
      discoveryRun: true,
      allowedTools: ["delegate_task", "read_file"],
    },
    { provider, picoHome, reporter: new SilentReporter() },
  );

  assert.equal(enteredBranches, 2);
  const session = await globalSessionManager.getOrCreate(sessionId, workDir, {
    persistence: true,
    picoHome,
  });
  const projection = await new DiscoveryCoordinator(session.runtimeEventStore!, {
    sessionId,
    invocationId: "test-discovery-delegation",
    runId: "test-discovery-delegation",
    turnId: "test-discovery-delegation",
  }).project();
  assert.equal(projection.latest?.branches.length, 2);
  assert.deepEqual(
    projection.latest?.branches.map((branch) => branch.status),
    ["completed", "failed"],
  );
  assert.deepEqual(
    projection.latest?.branches.map((branch) => branch.consumedToolCalls),
    [1, 0],
  );
  assert.ok(
    (projection.latest?.budget.consumedToolCalls ?? Number.POSITIVE_INFINITY) <=
      (projection.latest?.budget.maxToolCalls ?? 0),
  );
  assert.equal(projection.latest?.status, "completed");
});

test("explicit Discovery reserves concurrent host search budgets before execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-discovery-host-budget-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "discovery-host-budget";
  await mkdir(join(workDir, "src"), { recursive: true });
  for (const prefix of ["a", "b"] as const) {
    for (let index = 0; index < 20; index++) {
      await writeFile(
        join(workDir, "src", `${prefix}-${String(index).padStart(2, "0")}.ts`),
        `export const value = ${index};\n`,
        "utf8",
      );
    }
  }
  t.after(async () => {
    globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });

  let calls = 0;
  const provider: LLMProvider = {
    async generate() {
      calls++;
      if (calls === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "parallel-empty-grep-a",
              name: "grep",
              arguments: JSON.stringify({
                pattern: "missing-canary",
                path: "src",
                glob: "a-*.ts",
                max_files: 20,
              }),
            },
            {
              id: "parallel-empty-grep-b",
              name: "grep",
              arguments: JSON.stringify({
                pattern: "missing-canary",
                path: "src",
                glob: "b-*.ts",
                max_files: 9,
              }),
            },
          ],
        };
      }
      if (calls === 2) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "verify-final-budget-file",
              name: "read_file",
              arguments: JSON.stringify({ path: "src/b-19.ts" }),
            },
          ],
        };
      }
      return { role: "assistant", content: "调查完成" };
    },
  };

  await executeAgentRuntime(
    {
      prompt: "并发检索一个不存在的 canary，再直接核验候选文件",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      interactionMode: "default",
      discoveryRun: true,
      allowedTools: ["grep", "read_file"],
    },
    { provider, picoHome, reporter: new SilentReporter() },
  );

  const session = await globalSessionManager.getOrCreate(sessionId, workDir, {
    persistence: true,
    picoHome,
  });
  const projection = await new DiscoveryCoordinator(session.runtimeEventStore!, {
    sessionId,
    invocationId: "host-budget-check",
    runId: "host-budget-check",
    turnId: "host-budget-check",
  }).project();
  assert.equal(projection.latest?.budget.consumedToolCalls, 3);
  assert.equal(projection.latest?.budget.consumedFiles, 30);
  assert.equal(projection.latest?.inspectedFiles.length, 30);
  assert.equal(projection.latest?.status, "interrupted");
  assert.equal(projection.latest?.limitReason, "budget_exhausted");
});

test("explicit Discovery rejects physically overlapping branch root aliases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-discovery-root-alias-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(join(workDir, "src"), { recursive: true });
  await symlink(join(workDir, "src"), join(workDir, "src-alias"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const cases = [
    [".", "src"],
    ["src", "src/../src"],
    ["src", "src-alias"],
  ] as const;
  for (const [index, roots] of cases.entries()) {
    const sessionId = `discovery-root-alias-${index}`;
    let calls = 0;
    let rejectionObserved = false;
    const provider: LLMProvider = {
      async generate(messages) {
        calls++;
        if (calls === 1) {
          return {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: `overlap-${index}`,
                name: "delegate_task",
                arguments: JSON.stringify({
                  completion_policy: "required",
                  tasks: roots.map((branchRoot, ordinal) => ({
                    goal: `物理根重叠分支 ${ordinal}`,
                    mode: "explore",
                    roots: [branchRoot],
                    max_files: 10,
                    stopping_condition: "找到证据",
                  })),
                }),
              },
            ],
          };
        }
        rejectionObserved = messages.some((message) =>
          message.content.includes("roots 必须互不重叠"),
        );
        return { role: "assistant", content: "停止" };
      },
    };

    await executeAgentRuntime(
      {
        prompt: "验证分支物理根互斥",
        dir: workDir,
        sessionSelection: { mode: "new", sessionId },
        provider: "openai",
        modelRouteId: "test/test",
        interactionMode: "default",
        discoveryRun: true,
        allowedTools: ["delegate_task"],
      },
      { provider, picoHome, reporter: new SilentReporter() },
    );
    assert.equal(rejectionObserved, true, `case ${index} should reject ${roots.join(" vs ")}`);
    const session = await globalSessionManager.getOrCreate(sessionId, workDir, {
      persistence: true,
      picoHome,
    });
    const projection = await new DiscoveryCoordinator(session.runtimeEventStore!, {
      sessionId,
      invocationId: `root-alias-${index}`,
      runId: `root-alias-${index}`,
      turnId: `root-alias-${index}`,
    }).project();
    assert.equal(projection.active?.branches.length, 0);
    globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
  }
});

test("explicit Discovery fails closed when delegated usage results are structurally omitted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-discovery-omitted-usage-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "discovery-omitted-usage";
  const longParent = `${"p".repeat(180)}/${"q".repeat(180)}`;
  for (const branchRoot of ["src", "tests"] as const) {
    const directory = join(workDir, branchRoot, longParent);
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < 15; index++) {
      await writeFile(
        join(directory, `${"f".repeat(180)}-${String(index).padStart(2, "0")}.ts`),
        `export const value = ${index};\n`,
        "utf8",
      );
    }
  }
  t.after(async () => {
    globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });

  let mainCalls = 0;
  const childCalls = new Map<string, number>();
  const provider: LLMProvider = {
    async generate(messages) {
      const system = messages[0]?.content ?? "";
      const history = messages.map((message) => message.content).join("\n");
      if (system.includes("Explorer Subagent")) {
        const branchRoot = history.includes("允许根: tests") ? "tests" : "src";
        const calls = (childCalls.get(branchRoot) ?? 0) + 1;
        childCalls.set(branchRoot, calls);
        if (calls === 1) {
          return {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: `long-glob-${branchRoot}`,
                name: "glob",
                arguments: JSON.stringify({ pattern: "**/*.ts", path: branchRoot }),
              },
            ],
          };
        }
        return { role: "assistant", content: `${branchRoot} 检索完成` };
      }
      mainCalls++;
      if (mainCalls === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "delegate-long-usage",
              name: "delegate_task",
              arguments: JSON.stringify({
                completion_policy: "required",
                tasks: ["src", "tests"].map((branchRoot) => ({
                  goal: `扫描 ${branchRoot} 的长路径文件`,
                  mode: "explore",
                  roots: [branchRoot],
                  max_files: 15,
                  stopping_condition: "检查满 15 个文件后停止",
                })),
              }),
            },
          ],
        };
      }
      return { role: "assistant", content: "不应继续" };
    },
  };

  await assert.rejects(
    executeAgentRuntime(
      {
        prompt: "并发扫描两个长路径分支",
        dir: workDir,
        sessionSelection: { mode: "new", sessionId },
        provider: "openai",
        modelRouteId: "test/test",
        interactionMode: "default",
        discoveryRun: true,
        allowedTools: ["delegate_task"],
      },
      { provider, picoHome, reporter: new SilentReporter() },
    ),
    /结果被截断或结构不完整/u,
  );

  const session = await globalSessionManager.getOrCreate(sessionId, workDir, {
    persistence: true,
    picoHome,
  });
  const events = await session.runtimeEventStore!.readSession(sessionId);
  const discoveryKinds = events
    .map((event) => event.kind)
    .filter((kind) => kind.startsWith("discovery."));
  assert.equal(discoveryKinds.filter((kind) => kind === "discovery.branch.started").length, 2);
  assert.equal(discoveryKinds.includes("discovery.branch.completed"), false);
  assert.equal(discoveryKinds.includes("discovery.interrupted"), true);
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
  const approved = await coordinator.approve({
    operationId: "approve-crash-gap",
    expectedSessionSequence: handoff.expectedSessionSequence,
    planId: handoff.planId,
    expectedRevision: handoff.revision,
    reviewedBy: "user",
    settings,
  });
  await coordinator.startExecution({
    operationId: "plan-execution:approve-crash-gap",
    expectedSessionSequence: approved.sessionSequence,
    planId: handoff.planId,
    revision: handoff.revision,
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
  assert.equal(
    executionProviderCalls,
    0,
    "replay reconciles but never restarts execution implicitly",
  );

  const resumeStore = new RuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
  const resumeCoordinator = new PlanCoordinator(
    resumeStore,
    planControlContextForTest(sessionId, "resume-crash-gap"),
  );
  const interrupted = await resumeCoordinator.project();
  assert.equal(interrupted.execution?.status, "interrupted");
  resumeStore.close();
  const explicitResume = {
    sessionId,
    dir: workDir,
    picoHome,
    planId: handoff.planId,
    expectedSessionSequence: interrupted.sessionSequence,
    operationId: "resume-after-approval-crash",
    execution: request.execution,
  };
  await runtime.resumePlanExecution(explicitResume, {
    provider: executionProvider,
    reporter: new SilentReporter(),
  });
  assert.equal(executionProviderCalls, 1, "a new explicit resume operation starts one Run");

  const crashedResumeStore = new RuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
  const crashedResumeCoordinator = new PlanCoordinator(
    crashedResumeStore,
    planControlContextForTest(sessionId, "resume-crash-gap"),
  );
  const interruptedAgain = await crashedResumeCoordinator.project();
  assert.equal(interruptedAgain.execution?.status, "interrupted");
  await crashedResumeCoordinator.resume({
    operationId: "resume-crash-gap",
    expectedSessionSequence: interruptedAgain.sessionSequence,
    planId: handoff.planId,
  });
  crashedResumeStore.close();
  const resumeRequest = {
    sessionId,
    dir: workDir,
    picoHome,
    planId: handoff.planId,
    expectedSessionSequence: interruptedAgain.sessionSequence,
    operationId: "resume-crash-gap",
    execution: request.execution,
  };
  await runtime.resumePlanExecution(resumeRequest, {
    provider: executionProvider,
    reporter: new SilentReporter(),
  });
  assert.equal(executionProviderCalls, 1, "resume replay reconciles without an implicit Run");
  const resumedReplay = await runtime.resumePlanExecution(resumeRequest, {
    provider: executionProvider,
    reporter: new SilentReporter(),
  });
  assert.equal(resumedReplay.replayedOperationId, "resume-crash-gap");
  assert.equal(executionProviderCalls, 1);
  const recoveredResumeProjection = await runtime.readPlanProjection({
    sessionId,
    dir: workDir,
    picoHome,
  });
  assert.equal(recoveredResumeProjection.execution?.status, "interrupted");
  await runtime.resumePlanExecution(
    {
      ...resumeRequest,
      expectedSessionSequence: recoveredResumeProjection.sessionSequence,
      operationId: "resume-after-resume-crash",
    },
    { provider: executionProvider, reporter: new SilentReporter() },
  );
  assert.equal(executionProviderCalls, 2);
  const replayed = await runtime.approvePlanAndExecute(request, {
    provider: executionProvider,
    picoHome,
    reporter: new SilentReporter(),
  });
  assert.equal(replayed.replayedOperationId, "approve-crash-gap");
  assert.equal(executionProviderCalls, 2, "approval replay does not call the provider again");
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

test("concurrent approval replay preserves a live pre-Run admission", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-live-admission-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "plan-live-admission";
  await mkdir(workDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new AgentRuntime();
  const planned = await runtime.execute(
    {
      prompt: "提交计划",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      interactionMode: "plan",
    },
    {
      picoHome,
      reporter: new SilentReporter(),
      provider: submitPlanProvider("submit-live-admission"),
    },
  );
  const handoff = planned.handoff;
  assert.ok(handoff);
  let releaseAssembly!: () => void;
  let enteredAssembly!: () => void;
  const assemblyGate = new Promise<void>((resolve) => (releaseAssembly = resolve));
  const assemblyEntered = new Promise<void>((resolve) => (enteredAssembly = resolve));
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const canonicalize = trustStore.canonicalize.bind(trustStore);
  trustStore.canonicalize = async (path) => {
    enteredAssembly();
    await assemblyGate;
    return await canonicalize(path);
  };
  const request = {
    approval: {
      sessionId,
      dir: workDir,
      planId: handoff.planId,
      expectedRevision: handoff.revision,
      expectedSessionSequence: handoff.expectedSessionSequence,
      operationId: "approve-live-admission",
    },
    execution: {
      provider: "openai" as const,
      modelRouteId: "test/test",
      sessionSelection: { mode: "resume" as const, sessionId },
      interactionMode: "yolo" as const,
    },
  };
  let providerCalls = 0;
  let releaseProvider!: () => void;
  let enteredProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => (releaseProvider = resolve));
  const providerEntered = new Promise<void>((resolve) => (enteredProvider = resolve));
  t.after(() => {
    releaseAssembly();
    releaseProvider();
  });
  const host = {
    picoHome,
    memoryTrustStore: trustStore,
    reporter: new SilentReporter(),
    provider: {
      async generate() {
        providerCalls++;
        enteredProvider();
        await providerGate;
        return { role: "assistant" as const, content: "paused" };
      },
    },
  };
  const original = runtime.approvePlanAndExecute(request, host);
  await assemblyEntered;
  const replay = await runtime.approvePlanAndExecute(request, host);
  assert.equal(replay.replayedOperationId, "approve-live-admission");
  assert.equal(
    (await runtime.readPlanProjection({ sessionId, dir: workDir, picoHome })).execution?.status,
    "active",
  );
  releaseAssembly();
  await providerEntered;
  assert.equal(
    (await runtime.readPlanProjection({ sessionId, dir: workDir, picoHome })).execution?.status,
    "active",
    "a live RuntimeRun is never reconciled as interrupted",
  );
  releaseProvider();
  await original;
  assert.equal(providerCalls, 1);
});

function submitPlanProvider(operationId: string): LLMProvider {
  return {
    async generate() {
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: operationId,
            name: "submit_plan",
            arguments: JSON.stringify({
              title: operationId,
              steps: [{ title: "One", description: "Do one" }],
              operationId,
            }),
          },
        ],
      };
    },
  };
}

function planControlContextForTest(sessionId: string, operationId: string) {
  return {
    sessionId,
    invocationId: `test:${operationId}`,
    runId: `test:${operationId}`,
    turnId: `test:${operationId}`,
  };
}
