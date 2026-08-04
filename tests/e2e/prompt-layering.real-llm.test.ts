/**
 * 真实模型验证：prompt 分层架构改动
 *
 * 验证三个核心改动：
 * 1. turnTail 每轮重建（Todo 状态在操作后下一轮会刷新）
 * 2. <env> 环境信息块出现在上下文中
 * 3. TodoTool 操作后返回完整列表快照
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TodoStore } from "../../src/context/todo-store.js";

test("real llm: TodoTool returns full snapshot after operation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-layering-snapshot-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  // 预置一条 todo
  const todoStore = new TodoStore(workDir, { picoHome });
  await todoStore.add("初始任务A", "high");
  await todoStore.add("初始任务B", "medium");

  // 用 TodoTool 执行 toggle，验证返回值包含完整列表
  const { TodoTool } = await import("../../src/tools/todo.js");
  const tool = new TodoTool(todoStore);
  const result = await tool.execute(JSON.stringify({ action: "toggle", id: 1 }));

  console.log("[TodoTool toggle 返回值]\n", result);

  // 验证返回值包含操作确认 + 完整列表快照
  assert.match(result, /已切换任务 #1/u, "应包含操作确认");
  assert.match(result, /初始任务A/u, "快照应包含任务A");
  assert.match(result, /初始任务B/u, "快照应包含任务B");
});

test("real llm: <env> block appears in prompt layers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-layering-env-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const { PromptComposer } = await import("../../src/context/composer.js");
  const composer = new PromptComposer(workDir, false, { picoHome });
  const { systemPrompt, turnTail } = await composer.buildLayers();

  console.log("[systemPrompt 片段]\n", systemPrompt.slice(0, 200));
  console.log("[turnTail 片段]\n", turnTail.slice(0, 300));

  // <env> 块应在 turnTail 中
  assert.match(turnTail, /<env>/u, "turnTail 应包含 <env> 块");
  assert.match(turnTail, /Working directory:/u, "<env> 应包含工作目录");
  assert.match(turnTail, /Platform:/u, "<env> 应包含平台信息");
  assert.match(turnTail, /Today's date:/u, "<env> 应包含日期");

  // <env> 块不应在 systemPrompt 中（会破坏缓存）
  assert.doesNotMatch(
    systemPrompt,
    /<env>/u,
    "systemPrompt 不应包含 <env> 块（date 变化会破坏缓存）",
  );
});

test("real llm: PLAN_MODE_SPEC comes after AGENTS.md", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-layering-order-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(workDir, "AGENTS.md"), "project-rule-marker", "utf8");

  const { PromptComposer } = await import("../../src/context/composer.js");
  const composer = new PromptComposer(workDir, true, { picoHome });
  const { systemPrompt } = await composer.buildLayers();

  const projectIndex = systemPrompt.indexOf("project-rule-marker");
  const planModeIndex = systemPrompt.indexOf("长程任务与状态外部化强制规范");

  console.log(`[排序] AGENTS.md 位置: ${projectIndex}, PLAN_MODE_SPEC 位置: ${planModeIndex}`);

  assert.ok(projectIndex > 0, "项目级 AGENTS.md 应被加载");
  assert.ok(planModeIndex > 0, "PLAN_MODE_SPEC 应被加载");
  assert.ok(projectIndex < planModeIndex, "项目级 AGENTS.md 应排在 PLAN_MODE_SPEC 之前");
});
