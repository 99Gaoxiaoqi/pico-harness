import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundManager } from "../../src/tools/background-manager.js";
import { buildDefaultToolRegistry } from "../../src/tools/default-registry.js";
import type { BaseTool } from "../../src/tools/registry.js";
import { ToolDisclosure } from "../../src/tools/tool-disclosure.js";

function extensionTool(name: string, description: string): BaseTool {
  return {
    readOnly: true,
    name: () => name,
    definition: () => ({
      name,
      description,
      inputSchema: { type: "object", properties: {} },
    }),
    execute: async () => "ok",
  };
}

describe("buildDefaultToolRegistry", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-registry-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("注册 bash 与 task_* 工具并共享同一个 BackgroundManager", async () => {
    const registry = buildDefaultToolRegistry(workDir);
    const tools = registry.getAvailableTools().map((tool) => tool.name);

    expect(tools).toEqual(
      expect.arrayContaining(["bash", "task_list", "task_output", "task_stop"]),
    );

    const started = await registry.execute({
      id: "call_bg",
      name: "bash",
      arguments: JSON.stringify({
        command: 'node -e "setTimeout(() => {}, 1000)"',
        background: true,
      }),
    });
    const taskId = (JSON.parse(started.output) as { taskId: string }).taskId;

    const listed = await registry.execute({
      id: "call_list",
      name: "task_list",
      arguments: "{}",
    });
    const tasks = JSON.parse(listed.output) as Array<{ taskId: string; status: string }>;
    expect(tasks).toContainEqual(expect.objectContaining({ taskId, status: "running" }));

    await registry.execute({
      id: "call_stop",
      name: "task_stop",
      arguments: JSON.stringify({ taskId }),
    });
  });

  it("默认不暴露验证工具和运行时委派入口", () => {
    const registry = buildDefaultToolRegistry(workDir);
    const tools = registry.getAvailableTools().map((tool) => tool.name);

    expect(tools).not.toContain("echo");
    expect(tools).not.toContain("delegate_task");
    expect(tools).not.toContain("spawn_subagent");
  });

  it("创建 registry 后动态注册的委派和 MCP 工具可被搜索并披露", async () => {
    const disclosure = new ToolDisclosure();
    const registry = buildDefaultToolRegistry(workDir, { toolDisclosure: disclosure });
    registry.register(extensionTool("delegate_task", "dispatch a worker subagent"));
    registry.register(extensionTool("mcp__database__query", "query the production database"));

    const result = await registry.execute({
      id: "call_search_late_tools",
      name: "search_tools",
      arguments: JSON.stringify({ query: "worker database" }),
    });

    expect(result.output).toContain("delegate_task");
    expect(result.output).toContain("mcp__database__query");
    expect(disclosure.getDisclosed()).toEqual(
      expect.arrayContaining(["delegate_task", "mcp__database__query"]),
    );
    expect(disclosure.pickForLLM(registry.getAvailableTools()).map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["delegate_task", "mcp__database__query"]),
    );
  });

  it("search_tools 不会把自己列为搜索结果", async () => {
    const disclosure = new ToolDisclosure();
    const registry = buildDefaultToolRegistry(workDir, { toolDisclosure: disclosure });

    const result = await registry.execute({
      id: "call_search_self",
      name: "search_tools",
      arguments: JSON.stringify({ query: "search_tools" }),
    });

    expect(result.output).toContain("未找到匹配工具");
    expect(result.output).not.toContain("- search_tools:");
    expect(disclosure.getDisclosed()).not.toContain("search_tools");
  });

  it("显式传入同一个 BackgroundManager 时多个 registry 共享任务", async () => {
    const manager = new BackgroundManager();
    const firstRegistry = buildDefaultToolRegistry(workDir, { backgroundManager: manager });
    const secondRegistry = buildDefaultToolRegistry(workDir, { backgroundManager: manager });

    const started = await firstRegistry.execute({
      id: "call_bg",
      name: "bash",
      arguments: JSON.stringify({
        command: 'node -e "setTimeout(() => {}, 1000)"',
        background: true,
      }),
    });
    const taskId = (JSON.parse(started.output) as { taskId: string }).taskId;

    const listed = await secondRegistry.execute({
      id: "call_list",
      name: "task_list",
      arguments: "{}",
    });
    const tasks = JSON.parse(listed.output) as Array<{ taskId: string; status: string }>;
    expect(tasks).toContainEqual(expect.objectContaining({ taskId, status: "running" }));

    await secondRegistry.execute({
      id: "call_stop",
      name: "task_stop",
      arguments: JSON.stringify({ taskId }),
    });
  });
});
