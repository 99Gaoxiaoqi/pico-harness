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
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import {
  AgentRuntime,
  buildForegroundSafetyMiddleware,
  executeAgentRuntime,
} from "../../src/runtime/agent-runtime.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { createSessionRuntime } from "../../src/runtime/session-runtime.js";
import { RuntimeEventStorePlanOperationConflictError } from "../../src/storage/runtime-event-store-contracts.js";
import { SubmitPlanTool } from "../../src/tools/plan-exit.js";
import { buildDefaultToolRegistry } from "../../src/tools/default-registry.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";

/** Windows:分离的后台任务(memory recovery 等)可能短暂持有 pico.sqlite 句柄,
 * 删除临时目录按 EBUSY 有界重试,等待分离 drain 归还 lease。 */
async function rmRetry(target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 50 || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test("submit_plan persists a proposal and marks a machine-readable handoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-submit-plan-"));
  const workDir = join(root, "work");
  await mkdir(workDir);
  t.after(() => {
    store.close();
    return rmRetry(root);
  });
  const store = new SqliteRuntimeEventStore({ storageRoot: join(root, "state") });
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
  t.after(async () => {
    const released = globalSessionManager.delete("plan-disclosure", workDir, { picoHome });
    await released?.close();
    await rmRetry(root);
  });
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

test("Plan runtime records a verified proposal before an atomic handoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-discovery-auto-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "plan-discovery-auto";
  await mkdir(workDir);
  await writeFile(join(workDir, "target.ts"), "export const canary = 'verified';\n", "utf8");
  t.after(async () => {
    const released = globalSessionManager.delete(sessionId, workDir, { picoHome });
    await released?.close();
    await rmRetry(root);
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

  const store = new SqliteRuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
  const events = await store.readSession(sessionId);
  store.close();
  assert.ok(events.some((event) => event.kind === "plan.proposed"));
});

test("Plan accepts a workspace-local absolute read_file path when planning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-absolute-discovery-read-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "plan-absolute-discovery-read";
  const targetPath = join(workDir, "src", "target.ts");
  await mkdir(join(workDir, "src"), { recursive: true });
  await writeFile(targetPath, "export const target = true;\n", "utf8");
  t.after(async () => {
    globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    await rmRetry(root);
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

test("a failed Plan Run rejects and never proposes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-discovery-failure-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "plan-discovery-failure";
  await mkdir(workDir);
  await writeFile(join(workDir, "target.ts"), "export const value = 1;\n", "utf8");
  t.after(async () => {
    const released = globalSessionManager.delete(sessionId, workDir, { picoHome });
    await released?.close();
    await rmRetry(root);
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
  const store = new SqliteRuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
  const events = await store.readSession(sessionId);
  store.close();
  assert.equal(
    events.some((event) => event.kind === "plan.proposed"),
    false,
    "a failed Plan Run never records a proposal",
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
    await rmRetry(root);
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
    await rmRetry(root);
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
    async generate(messages) {
      assert.doesNotMatch(manager.status().reason, /运行时策略禁用/u);
      const prompt = messages.map((message) => message.content).join("\n");
      assert.match(prompt, /先调用 update_plan 将它标记为 in_progress/u);
      assert.match(prompt, /直到 update_plan 返回 execution 已 completed/u);
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
  t.after(async () => {
    const released = globalSessionManager.delete("plan-hook-isolation", workDir, { picoHome });
    await released?.close();
    await rmRetry(root);
  });
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

test("approval recovers its crash gap and replay never starts a second execution Run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-approval-replay-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "plan-approval-replay";
  await mkdir(workDir);
  t.after(async () => {
    const released = globalSessionManager.delete(sessionId, workDir, { picoHome });
    await released?.close();
    store.close();
    resumeStore.close();
    crashedResumeStore.close();
    await rmRetry(root);
  });
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

  const store = new SqliteRuntimeEventStore({
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

  const resumeStore = new SqliteRuntimeEventStore({
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

  const crashedResumeStore = new SqliteRuntimeEventStore({
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
  t.after(async () => {
    const released = globalSessionManager.delete(sessionId, workDir, { picoHome });
    await released?.close();
    await rmRetry(root);
  });
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
