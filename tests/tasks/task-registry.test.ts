import { describe, expect, it } from "vitest";
import {
  TaskRegistry,
  generateTaskId,
  isTerminalTaskStatus,
} from "../../src/tasks/task-registry.js";

describe("TaskRegistry", () => {
  it("create 为不同任务类型生成 Claude Code 风格前缀 ID 并保持 pending 初始状态", () => {
    expect(generateTaskId("local_bash")).toMatch(/^b_[0-9a-z]{8}$/);
    expect(generateTaskId("local_agent")).toMatch(/^a_[0-9a-z]{8}$/);
    expect(generateTaskId("remote_agent")).toMatch(/^r_[0-9a-z]{8}$/);
    expect(generateTaskId("local_workflow")).toMatch(/^w_[0-9a-z]{8}$/);
    expect(generateTaskId("monitor_mcp")).toMatch(/^m_[0-9a-z]{8}$/);

    const registry = new TaskRegistry({ generateId: () => "b_test0001", now: () => 1000 });
    const task = registry.create("local_bash", { description: "run tests" });

    expect(task).toMatchObject({
      taskId: "b_test0001",
      type: "local_bash",
      status: "pending",
      description: "run tests",
      startTime: 1000,
      outputOffset: 0,
      notified: false,
    });
    expect(task.endTime).toBeUndefined();
  });

  it("start/complete/fail/kill 更新状态、时间和 snapshot 元数据", () => {
    let now = 1000;
    const registry = new TaskRegistry({
      generateId: (type) => `${type}_id`,
      now: () => now,
    });

    const completed = registry.create("local_bash", {
      description: "build",
      toolUseId: "tool-1",
      outputFile: ".pico/tasks/build.log",
      data: { command: "npm test" },
    });
    now = 1100;
    registry.start(completed.taskId, { data: { pid: 123 } });
    now = 1500;
    registry.complete(completed.taskId, { outputOffset: 42, data: { exitCode: 0 } });

    expect(registry.get(completed.taskId)).toMatchObject({
      taskId: completed.taskId,
      type: "local_bash",
      status: "completed",
      description: "build",
      toolUseId: "tool-1",
      startTime: 1000,
      endTime: 1500,
      outputFile: ".pico/tasks/build.log",
      outputOffset: 42,
      data: {
        command: "npm test",
        pid: 123,
        exitCode: 0,
      },
    });

    const failed = registry.create("local_agent", { description: "worker" });
    now = 2000;
    registry.fail(failed.taskId, new Error("boom"));
    expect(registry.get(failed.taskId)).toMatchObject({
      status: "failed",
      endTime: 2000,
      error: "boom",
    });

    const killed = registry.create("monitor_mcp", { description: "watch" });
    now = 2500;
    registry.kill(killed.taskId, "user stopped");
    expect(registry.get(killed.taskId)).toMatchObject({
      status: "killed",
      endTime: 2500,
      error: "user stopped",
    });
  });

  it("list 按 startTime 稳定排序并返回不可变 snapshot", () => {
    let now = 10;
    let nextId = 0;
    const registry = new TaskRegistry({
      generateId: () => `b_task${++nextId}`,
      now: () => now,
    });

    const second = registry.create("local_bash", { description: "second" });
    now = 5;
    const first = registry.create("local_bash", { description: "first" });
    now = 10;
    const third = registry.create("local_bash", { description: "third" });

    expect(registry.list().map((task) => task.taskId)).toEqual([
      first.taskId,
      second.taskId,
      third.taskId,
    ]);

    const snapshot = registry.get(first.taskId);
    expect(snapshot).toBeDefined();
    snapshot!.status = "completed";
    expect(registry.get(first.taskId)?.status).toBe("pending");
  });

  it("subscribe 在任务创建和状态变更时推送 snapshot,退订后停止推送", () => {
    let now = 100;
    const registry = new TaskRegistry({ generateId: () => "b_sub0001", now: () => now });
    const events: string[] = [];
    const unsubscribe = registry.subscribe((snapshot) => {
      events.push(`${snapshot.taskId}:${snapshot.status}:${snapshot.endTime ?? ""}`);
    });

    const task = registry.create("local_bash", { description: "watch" });
    now = 200;
    registry.start(task.taskId);
    unsubscribe();
    now = 300;
    registry.complete(task.taskId);

    expect(events).toEqual(["b_sub0001:pending:", "b_sub0001:running:"]);
  });

  it("拒绝更新未知任务且可以识别终态", () => {
    const registry = new TaskRegistry();

    expect(() => registry.start("missing")).toThrow(/未知任务/);
    expect(isTerminalTaskStatus("pending")).toBe(false);
    expect(isTerminalTaskStatus("running")).toBe(false);
    expect(isTerminalTaskStatus("completed")).toBe(true);
    expect(isTerminalTaskStatus("failed")).toBe(true);
    expect(isTerminalTaskStatus("killed")).toBe(true);
  });
});
