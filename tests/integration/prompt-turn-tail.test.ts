import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PromptComposer } from "../../src/context/composer.js";
import { FullCompactor } from "../../src/context/full-compactor.js";
import { TodoStore } from "../../src/context/todo-store.js";
import { GoalManager } from "../../src/engine/goal-manager.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { Session } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { ContextOverflowError } from "../../src/provider/errors.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { executeAgentRuntime } from "../../src/runtime/agent-runtime.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";
import type { Message } from "../../src/schema/message.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

test("dynamic prompt state stays in the current user request copy across runs and tool steps", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-turn-tail-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(workDir, "AGENTS.md"), "stable-agent-instruction", "utf8");
  await writeFile(join(workDir, "PLAN.md"), "plan-alpha", "utf8");
  await writeFile(join(workDir, "TODO.md"), "- [ ] file-todo-alpha", "utf8");

  const todoStore = new TodoStore(workDir, { picoHome });
  const todo = await todoStore.add("structured-todo-alpha", "high");
  const goalManager = new GoalManager();
  const goal = goalManager.create("goal-alpha", "finish alpha");
  const composer = new PromptComposer(workDir, true, { todoStore, goalManager });

  const requests: Message[][] = [];
  const provider: LLMProvider = {
    async generate(messages) {
      requests.push(structuredClone(messages));
      if (requests.length === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "read_marker", arguments: "{}" }],
        };
      }
      return {
        role: "assistant",
        content: requests.length === 2 ? "first done" : "second done",
      };
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: () => "read_marker",
    definition: () => ({
      name: "read_marker",
      description: "returns a deterministic marker",
      inputSchema: { type: "object", properties: {} },
    }),
    readOnly: true,
    async execute() {
      return "marker";
    },
  });

  const factoryInputs: string[] = [];
  const engine = new AgentEngine({
    provider,
    registry,
    workDir,
    promptLayersFactory: async ({ currentUserPrompt }) => {
      factoryInputs.push(currentUserPrompt);
      return composer.buildLayers();
    },
  });
  const session = new Session("turn-tail", workDir, { persistence: false, picoHome });
  context.after(() => session.close());

  await session.commitMessages({ role: "user", content: "user-alpha" });
  await engine.run(session);

  await writeFile(join(workDir, "PLAN.md"), "plan-beta", "utf8");
  await writeFile(join(workDir, "TODO.md"), "- [x] file-todo-beta", "utf8");
  await todoStore.update(todo.id, { content: "structured-todo-beta", status: "completed" });
  goalManager.update(goal.id, { progress: "goal-beta" });
  await session.commitMessages({ role: "user", content: "user-beta" });
  await engine.run(session);

  assert.deepEqual(factoryInputs, ["user-alpha", "user-beta"], "factory must run once per run");
  assert.equal(requests.length, 3);
  const systems = requests.map((messages) => messages[0]?.content);
  assert.equal(systems[0], systems[1]);
  assert.equal(systems[1], systems[2]);
  assert.match(systems[0] ?? "", /stable-agent-instruction/u);
  assert.match(systems[0] ?? "", /长程任务与状态外部化强制规范/u);
  assert.doesNotMatch(systems[0] ?? "", /plan-alpha|plan-beta|structured-todo|goal-alpha/u);

  for (const firstRunRequest of requests.slice(0, 2)) {
    const currentUser = visibleUsers(firstRunRequest).at(-1);
    assert.match(currentUser?.content ?? "", /^user-alpha\n\n<current-turn-context>/u);
    assert.match(currentUser?.content ?? "", /plan-alpha/u);
    assert.match(currentUser?.content ?? "", /structured-todo-alpha/u);
    assert.match(currentUser?.content ?? "", /goal-alpha/u);
    assert.equal(countOccurrences(currentUser?.content ?? "", "<current-turn-context>"), 1);
  }

  const secondRunUsers = visibleUsers(requests[2]!);
  assert.equal(secondRunUsers.length, 2);
  assert.equal(secondRunUsers[0]?.content, "user-alpha", "old user must not retain the old tail");
  assert.match(secondRunUsers[1]?.content ?? "", /^user-beta\n\n<current-turn-context>/u);
  assert.match(secondRunUsers[1]?.content ?? "", /plan-beta/u);
  assert.match(secondRunUsers[1]?.content ?? "", /structured-todo-beta/u);
  assert.match(secondRunUsers[1]?.content ?? "", /goal-beta/u);
  assert.doesNotMatch(secondRunUsers[1]?.content ?? "", /plan-alpha|structured-todo-alpha/u);

  const persistedHistory = await session.getModelContext();
  assert.deepEqual(
    visibleUsers(persistedHistory).map((message) => message.content),
    ["user-alpha", "user-beta"],
  );
  assert.doesNotMatch(
    JSON.stringify(persistedHistory),
    /current-turn-context|plan-alpha|plan-beta|structured-todo|goal-alpha|goal-beta/u,
  );
});

test("grace call receives the frozen turn tail without persisting it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-turn-tail-grace-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const requests: Message[][] = [];
  const provider: LLMProvider = {
    async generate(messages) {
      requests.push(structuredClone(messages));
      return requests.length === 1
        ? {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "grace-call-1", name: "read_marker", arguments: "{}" }],
          }
        : { role: "assistant", content: "grace done" };
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: () => "read_marker",
    definition: () => ({
      name: "read_marker",
      description: "returns a deterministic marker",
      inputSchema: { type: "object", properties: {} },
    }),
    readOnly: true,
    async execute() {
      return "marker";
    },
  });
  const engine = new AgentEngine({
    provider,
    registry,
    workDir: root,
    maxTurns: 1,
    promptLayersFactory: async () => ({
      systemPrompt: "stable-system",
      turnTail: "grace-tail-marker",
    }),
  });
  const session = new Session("turn-tail-grace", root, {
    persistence: false,
    picoHome: join(root, "pico-home"),
  });
  context.after(() => session.close());
  await session.commitMessages({ role: "user", content: "grace-user" });

  await engine.run(session);

  assert.equal(requests.length, 2);
  for (const request of requests) {
    const currentUser = visibleUsers(request).at(-1);
    assert.match(currentUser?.content ?? "", /grace-tail-marker/u);
    assert.equal(countOccurrences(currentUser?.content ?? "", "<current-turn-context>"), 1);
  }
  const persistedHistory = await session.getModelContext();
  assert.doesNotMatch(JSON.stringify(persistedHistory), /grace-tail-marker|current-turn-context/u);
  assert.ok(
    persistedHistory.some((message) => message.providerData?.["picoKind"] === "grace"),
    "grace control message itself should remain durable",
  );
});

test("provider overflow compaction retry preserves one frozen turn tail", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-turn-tail-overflow-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const requests: Message[][] = [];
  const compactionRequests: Message[][] = [];
  let mainCalls = 0;
  let layerCalls = 0;
  const turnTail = "overflow-tail-marker";
  const provider: LLMProvider = {
    async generate(messages) {
      requests.push(structuredClone(messages));
      mainCalls++;
      if (mainCalls === 1) throw new ContextOverflowError("fixture context overflow");
      return { role: "assistant", content: "overflow recovered" };
    },
  };
  const compactionProvider: LLMProvider = {
    async generate(messages) {
      compactionRequests.push(structuredClone(messages));
      return { role: "assistant", content: "fixture compacted history" };
    },
  };
  const engine = new AgentEngine({
    provider,
    registry: new ToolRegistry(),
    workDir: root,
    reporter: new SilentReporter(),
    fullCompactor: new FullCompactor({ provider: compactionProvider, maxAttempts: 1 }),
    promptLayersFactory: async ({ currentUserPrompt }) => {
      layerCalls++;
      assert.equal(currentUserPrompt, "overflow-current-user");
      return { systemPrompt: "stable-overflow-system", turnTail };
    },
  });
  const session = new Session("turn-tail-overflow", root, {
    persistence: false,
    picoHome: join(root, "pico-home"),
  });
  context.after(() => session.close());
  const oldContext = "old context ".repeat(180);
  for (let index = 0; index < 3; index++) {
    await session.commitMessages(
      { role: "user", content: `old-user-${index} ${oldContext}` },
      { role: "assistant", content: `old-assistant-${index} ${oldContext}` },
    );
  }
  await session.commitMessages({ role: "user", content: "overflow-current-user" });

  await engine.run(session);

  assert.equal(layerCalls, 1);
  assert.equal(mainCalls, 2);
  assert.equal(compactionRequests.length, 1);
  assert.doesNotMatch(JSON.stringify(compactionRequests), new RegExp(turnTail, "u"));
  for (const request of requests) {
    const currentUser = visibleUsers(request).at(-1);
    assert.match(currentUser?.content ?? "", /^overflow-current-user/u);
    assert.match(currentUser?.content ?? "", new RegExp(turnTail, "u"));
    assert.equal(countOccurrences(currentUser?.content ?? "", "<current-turn-context>"), 1);
  }
  const persistedHistory = await session.getModelContext();
  assert.doesNotMatch(JSON.stringify(persistedHistory), new RegExp(turnTail, "u"));
  assert.doesNotMatch(JSON.stringify(persistedHistory), /current-turn-context/u);
});

test("AgentRuntime puts schedule intent in the current turn tail, not durable events", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-turn-tail-runtime-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const sessionId = "turn-tail-runtime";
  await mkdir(workDir, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const requests: Message[][] = [];
  const provider: LLMProvider = {
    async generate(messages) {
      requests.push(structuredClone(messages));
      return { role: "assistant", content: "done" };
    },
  };
  const userPrompt = "请创建一个每天早上九点运行的提醒任务";
  await executeAgentRuntime(
    {
      prompt: userPrompt,
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
    },
    {
      provider,
      picoHome,
      reporter: new SilentReporter(),
      scheduleDraftCoordinator: {
        async propose() {
          return { kind: "cancelled" };
        },
      },
    },
  );

  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0]?.[0]?.content ?? "", /schedule-task-intent/u);
  const currentUser = visibleUsers(requests[0] ?? []).at(-1);
  assert.match(currentUser?.content ?? "", new RegExp(`^${userPrompt}`, "u"));
  assert.match(currentUser?.content ?? "", /schedule-task-intent/u);

  const runtimeEvents = await new RuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  }).readSession(sessionId);
  assert.doesNotMatch(JSON.stringify(runtimeEvents), /schedule-task-intent|current-turn-context/u);
});

test("isolated headless runtime adds the autonomous completion contract only to its system prompt", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-isolated-headless-contract-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const systemPrompts: string[] = [];
  const userPrompts: string[] = [];
  const provider: LLMProvider = {
    async generate(messages) {
      systemPrompts.push(messages[0]?.content ?? "");
      userPrompts.push(visibleUsers(messages).at(-1)?.content ?? "");
      return { role: "assistant", content: "done" };
    },
  };
  const run = async (sessionId: string, isolatedHeadless: boolean) =>
    executeAgentRuntime(
      {
        prompt: "完成当前任务",
        dir: workDir,
        sessionSelection: { mode: "new", sessionId },
        provider: "openai",
        modelRouteId: "test/test",
        interactionMode: "auto",
      },
      {
        provider,
        picoHome,
        reporter: new SilentReporter(),
        isolatedHeadless,
      },
    );

  await run("ordinary-runtime", false);
  await run("isolated-runtime", true);

  assert.equal(systemPrompts.length, 2);
  assert.doesNotMatch(systemPrompts[0] ?? "", /无人值守完成契约/u);
  assert.match(systemPrompts[1] ?? "", /无人值守完成契约/u);
  assert.match(systemPrompts[1] ?? "", /仅创建脚本、给出说明或让用户稍后运行命令都不算完成/u);
  assert.match(systemPrompts[1] ?? "", /结束前运行 1–3 个/u);
  assert.deepEqual(userPrompts, ["完成当前任务", "完成当前任务"]);
});

function visibleUsers(messages: readonly Message[]): Message[] {
  return messages.filter(
    (message) =>
      message.role === "user" &&
      message.toolCallId === undefined &&
      message.providerData?.["picoHiddenFromTranscript"] !== true,
  );
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
