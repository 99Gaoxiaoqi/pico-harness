import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionRuntimeLifecycle } from "@pico/pico-host/session-runtime-lifecycle";
import { HookRewakeQueue } from "@pico/runtime/hook-rewake";
import { TaskRegistry } from "@pico/runtime/task-registry";

test("Pico Host Session lifecycle preserves Hook order and releases terminal ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-lifecycle-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  await mkdir(picoHome);
  t.after(() => rm(root, { recursive: true, force: true }));

  const taskRegistry = new TaskRegistry({ generateId: () => "a_lifecycle" });
  const events: string[] = [];
  const ownership: string[] = [];
  const lifecycle = new SessionRuntimeLifecycle({
    session: { id: "session-lifecycle", workDir, picoHome },
    taskRegistry,
    backgroundManager: {
      list: () => [],
      output: () => ({ taskId: "unused", stdout: "", stderr: "" }),
      stop: async () => {
        throw new Error("no background task should be stopped");
      },
    },
    hookRewakeQueue: new HookRewakeQueue(async () => undefined),
    codeIntelligenceEnabled: true,
    sessionStartSource: "resume",
    code: {
      setEnabled: async () => undefined,
      applyProcessSandbox: async () => undefined,
      close: async () => ownership.push("code.closed"),
    },
    unbindGoalManager: () => ownership.push("goal.unbound"),
    releaseSessionPin: () => ownership.push("session.released"),
    diagnostics: { warn: () => undefined },
  });
  const hookPort = {
    dispatch: async (event: string) => {
      events.push(event);
    },
  };
  lifecycle.attachHookService(hookPort);

  const task = taskRegistry.create("local_agent", {
    description: "inspect",
    data: { mode: "worker" },
  });
  taskRegistry.start(task.taskId);
  taskRegistry.complete(task.taskId);
  await lifecycle.drainHookEvents();
  await lifecycle.dispose();

  assert.deepEqual(events, [
    "SessionStart",
    "TaskCreated",
    "SubagentStart",
    "TaskCompleted",
    "SubagentStop",
    "SessionEnd",
  ]);
  assert.deepEqual(ownership, ["code.closed", "goal.unbound", "session.released"]);
  await lifecycle.dispose();
  assert.deepEqual(ownership, ["code.closed", "goal.unbound", "session.released"]);
});
