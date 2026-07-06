import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
