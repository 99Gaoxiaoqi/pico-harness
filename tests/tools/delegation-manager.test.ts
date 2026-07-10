import { describe, expect, it } from "vitest";
import { TaskRegistry } from "../../src/tasks/task-registry.js";
import {
  DelegationManager,
  type DelegationBatchResult,
} from "../../src/tools/delegation-manager.js";

describe("DelegationManager task runtime adapter", () => {
  it("background delegation 创建 local_agent task 并同步完成状态", async () => {
    const taskRegistry = new TaskRegistry();
    const manager = new DelegationManager({ taskRegistry });
    const result: DelegationBatchResult = {
      results: [{ taskIndex: 0, status: "completed", summary: "done", durationMs: 1 }],
      totalDurationMs: 1,
    };

    const dispatched = manager.dispatch(async () => result, {
      description: "review task runtime",
      toolUseId: "tool-1",
      outputFile: ".pico/tasks/agent.log",
    });

    expect(dispatched.status).toBe("dispatched");
    expect(dispatched.taskId).toMatch(/^a_[0-9a-z]{8}$/);
    expect(taskRegistry.get(dispatched.taskId!)).toMatchObject({
      taskId: dispatched.taskId,
      type: "local_agent",
      status: "running",
      description: "review task runtime",
      toolUseId: "tool-1",
      outputFile: ".pico/tasks/agent.log",
      data: { delegationId: dispatched.delegationId },
    });

    await manager.wait(dispatched.delegationId!);

    expect(taskRegistry.get(dispatched.taskId!)).toMatchObject({
      status: "completed",
      data: expect.objectContaining({
        delegationId: dispatched.delegationId,
        result,
      }),
    });
  });

  it("background delegation 失败时同步 local_agent failed 状态", async () => {
    const taskRegistry = new TaskRegistry();
    const manager = new DelegationManager({ taskRegistry });

    const dispatched = manager.dispatch(
      async () => {
        throw new Error("agent failed");
      },
      { description: "failing worker" },
    );

    await manager.wait(dispatched.delegationId!);

    expect(taskRegistry.get(dispatched.taskId!)).toMatchObject({
      type: "local_agent",
      status: "failed",
      error: "agent failed",
    });
  });
});
