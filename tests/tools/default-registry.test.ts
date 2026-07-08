import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundManager } from "../../src/tools/background-manager.js";
import { buildDefaultToolRegistry } from "../../src/tools/default-registry.js";

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
        command: "node -e \"setTimeout(() => {}, 1000)\"",
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

  it("注册 delegate_task 工具名供 /agent 分派提示使用", () => {
    const registry = buildDefaultToolRegistry(workDir);
    const tool = registry.getAvailableTools().find((item) => item.name === "delegate_task");

    expect(tool).toBeDefined();
    expect(tool?.description).toContain("delegate_task");
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        goal: { type: "string" },
        agent_name: { type: "string" },
      },
    });
  });

  it("显式传入同一个 BackgroundManager 时多个 registry 共享任务", async () => {
    const manager = new BackgroundManager();
    const firstRegistry = buildDefaultToolRegistry(workDir, { backgroundManager: manager });
    const secondRegistry = buildDefaultToolRegistry(workDir, { backgroundManager: manager });

    const started = await firstRegistry.execute({
      id: "call_bg",
      name: "bash",
      arguments: JSON.stringify({
        command: "node -e \"setTimeout(() => {}, 1000)\"",
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
