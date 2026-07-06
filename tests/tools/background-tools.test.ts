import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundManager } from "../../src/tools/background-manager.js";
import {
  TaskListTool,
  TaskOutputTool,
  TaskStopTool,
} from "../../src/tools/registry-impl.js";

function waitFor(
  check: () => boolean,
  timeoutMs = 2000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("等待条件超时"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("后台任务控制工具", () => {
  let workDir: string;
  let manager: BackgroundManager;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-bg-tools-"));
    manager = new BackgroundManager({ maxOutputChars: 200 });
  });

  afterEach(async () => {
    for (const task of manager.list()) {
      if (task.status === "running") {
        await manager.stop(task.taskId);
      }
    }
    await rm(workDir, { recursive: true, force: true });
  });

  it("TaskListTool 列出后台任务并声明只读", async () => {
    const task = manager.start("node -e \"setTimeout(() => {}, 1000)\"", workDir);
    const tool = new TaskListTool(manager);

    const out = await tool.execute("{}");
    const parsed = JSON.parse(out) as Array<{ taskId: string; status: string; pid: number }>;

    expect(tool.name()).toBe("task_list");
    expect(tool.readOnly).toBe(true);
    expect(tool.accesses("{}")).toEqual([]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      taskId: task.taskId,
      status: "running",
      pid: task.pid,
    });
  });

  it("TaskOutputTool 读取指定任务输出 tail 并声明只读", async () => {
    const task = manager.start("printf 'abcdef'; printf 'errline' >&2", workDir);
    const tool = new TaskOutputTool(manager);

    await waitFor(() => manager.list()[0]?.status === "exited");
    const out = await tool.execute(JSON.stringify({ taskId: task.taskId, tail: 3 }));
    const parsed = JSON.parse(out) as { stdout: string; stderr: string };

    expect(tool.name()).toBe("task_output");
    expect(tool.readOnly).toBe(true);
    expect(tool.accesses("{}")).toEqual([]);
    expect(parsed.stdout).toBe("def");
    expect(parsed.stderr).toBe("ine");
  });

  it("TaskStopTool 停止任务并声明全局写访问", async () => {
    const task = manager.start("node -e \"setInterval(() => {}, 1000)\"", workDir);
    const tool = new TaskStopTool(manager);

    const out = await tool.execute(JSON.stringify({ taskId: task.taskId }));
    const parsed = JSON.parse(out) as { taskId: string; status: string };

    expect(tool.name()).toBe("task_stop");
    expect(tool.readOnly).toBe(false);
    expect(tool.accesses("{}")).toEqual([{ kind: "all" }]);
    expect(parsed.taskId).toBe(task.taskId);
    expect(parsed.status).toBe("stopped");
  });

  it("TaskOutputTool 对未知 taskId 返回错误", async () => {
    const tool = new TaskOutputTool(manager);

    await expect(tool.execute(JSON.stringify({ taskId: "missing" }))).rejects.toThrow(
      /未知后台任务/,
    );
  });
});
