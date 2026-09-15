import assert from "node:assert/strict";
import test from "node:test";
import {
  TaskListTool,
  TaskOutputTool,
  TaskStopTool,
  type BackgroundTaskPort,
  type BackgroundTaskRecord,
} from "@pico/runtime/background-task-tools";
import { TaskRegistry, type TaskSnapshot } from "@pico/runtime/task-registry";

test("Runtime TaskRegistry preserves lifecycle, snapshot isolation and restart reconciliation", () => {
  let now = 100;
  let nextId = 0;
  const registry = new TaskRegistry({
    generateId: (type) => `${type}-${++nextId}`,
    now: () => now,
  });
  const emitted: TaskSnapshot[] = [];
  registry.subscribe((snapshot) => emitted.push(snapshot));

  const created = registry.create("local_bash", {
    description: "build",
    data: { nested: { attempt: 1 } },
  });
  assert.equal(created.taskId, "local_bash-1");
  assert.equal(created.status, "pending");
  (created.data!.nested as { attempt: number }).attempt = 9;
  assert.deepEqual(registry.get(created.taskId)?.data, { nested: { attempt: 1 } });

  now = 110;
  registry.start(created.taskId, { data: { pid: 42 } });
  now = 120;
  const completed = registry.complete(created.taskId, { data: { exitCode: 0 } });
  assert.deepEqual(completed, {
    taskId: "local_bash-1",
    type: "local_bash",
    status: "completed",
    description: "build",
    startTime: 100,
    endTime: 120,
    outputOffset: 0,
    notified: false,
    data: { nested: { attempt: 1 }, pid: 42, exitCode: 0 },
  });
  assert.equal(emitted.length, 3);

  const restored = new TaskRegistry({ now: () => 200 });
  const pending: TaskSnapshot = {
    taskId: "a_pending",
    type: "local_agent",
    status: "running",
    description: "interrupted",
    startTime: 90,
    outputOffset: 0,
    notified: false,
  };
  assert.deepEqual(restored.restore([pending, pending]), {
    restored: 1,
    interrupted: 1,
    duplicateTaskIds: ["a_pending"],
  });
  const interrupted = restored.get("a_pending")!;
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.endTime, 200);
  assert.equal(interrupted.error, "host restarted");
  assert.equal(restored.replaceFromAuthority(interrupted), false);
  assert.equal(restored.replaceFromAuthority({ ...interrupted, notified: true }), true);
});

test("Runtime background task tools validate scopes and preserve wire projections", async () => {
  const record: BackgroundTaskRecord = {
    taskId: "b_1",
    command: "printf ok",
    cwd: "/workspace",
    pid: 42,
    status: "running",
    exitCode: null,
    signal: null,
    startedAt: new Date("2026-09-14T00:00:00.000Z"),
    endedAt: null,
  };
  const calls: string[] = [];
  const backgroundTasks: BackgroundTaskPort = {
    list: () => [record],
    output: (taskId, tail) => {
      calls.push(`output:${taskId}:${tail}`);
      return { taskId, stdout: "ok", stderr: "" };
    },
    stop: async (taskId) => {
      calls.push(`stop:${taskId}`);
      return {
        ...record,
        status: "stopped",
        signal: "SIGTERM",
        endedAt: new Date("2026-09-14T00:00:01.000Z"),
      };
    },
  };

  assert.deepEqual(
    JSON.parse(await new TaskListTool(backgroundTasks).execute('{"scope":"background"}')),
    [
      {
        ...record,
        startedAt: "2026-09-14T00:00:00.000Z",
        endedAt: null,
      },
    ],
  );
  assert.deepEqual(
    JSON.parse(await new TaskOutputTool(backgroundTasks).execute('{"taskId":"b_1","tail":2}')),
    { taskId: "b_1", stdout: "ok", stderr: "" },
  );
  const stopped = JSON.parse(await new TaskStopTool(backgroundTasks).execute('{"taskId":"b_1"}'));
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.endedAt, "2026-09-14T00:00:01.000Z");
  assert.deepEqual(calls, ["output:b_1:2", "stop:b_1"]);

  await assert.rejects(
    () => new TaskListTool(backgroundTasks).execute('{"scope":"background","extra":true}'),
    /task_list 只接受 scope 字段/,
  );
});
