import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import type { HookOutput } from "../../src/hooks/types.js";
import type { SessionRuntime } from "../../src/runtime/session-runtime.js";
import type {
  RuntimeLifecycleEvent,
  RuntimeRunOptions,
} from "../../src/runtime/runtime-contract.js";
import {
  emitRuntimeLifecycleEvent,
  RuntimeRunExecutor,
} from "../../src/runtime/runtime-run-executor.js";

test("RuntimeRunExecutor executes one assembled turn without owning its resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-run-executor-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const session = new Session("runtime-run-executor", workDir, {
    persistence: true,
    picoHome,
  });
  try {
    await session.recover();
    const hookEvents: string[] = [];
    const runtimeState = {
      dispatchHook: async (event: string): Promise<HookOutput> => {
        hookEvents.push(event);
        return { decision: "allow" };
      },
    } as unknown as SessionRuntime;
    const engine = {
      run: async (target: Session) => {
        await target.commitMessages({ role: "assistant", content: "answer" });
        return target.getHistory();
      },
    } as unknown as AgentEngine;
    const lifecycle: string[] = [];
    const runtimeOptions: RuntimeRunOptions = {};
    const lifecycleEvents: RuntimeLifecycleEvent[] = [];
    const result = await new RuntimeRunExecutor({
      session,
      runtimeState,
      engine,
      sessionSelection: { mode: "new", sessionId: session.id },
      workDir,
      picoHome,
      prompt: "hello",
      resumeExistingSession: false,
      traceEnabled: false,
      options: runtimeOptions,
      onEvent: (event) => {
        lifecycleEvents.push(event);
        lifecycle.push(event.type);
      },
    }).execute();

    assert.equal(result.finalMessage, "answer");
    assert.deepEqual(hookEvents, ["UserPromptSubmit", "UserPromptExpansion"]);
    assert.deepEqual(lifecycle, ["run.started", "run.finished"]);
    assert.equal(lifecycleEvents[0]?.sessionId, session.id);
    assert.deepEqual(
      result.messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(session.runtimeEventStore?.databasePath !== undefined, true);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("RuntimeRunExecutor isolates lifecycle observer failures from canonical run success", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-run-observer-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const session = new Session("runtime-run-observer", workDir, { persistence: true, picoHome });
  try {
    await session.recover();
    const runtimeState = {
      dispatchHook: async (): Promise<HookOutput> => ({ decision: "allow" }),
    } as unknown as SessionRuntime;
    const engine = {
      run: async (target: Session) => {
        await target.commitMessages({ role: "assistant", content: "observer-safe" });
        return target.getHistory();
      },
    } as unknown as AgentEngine;

    const result = await new RuntimeRunExecutor({
      session,
      runtimeState,
      engine,
      sessionSelection: { mode: "new", sessionId: session.id },
      workDir,
      picoHome,
      prompt: "hello",
      resumeExistingSession: false,
      traceEnabled: false,
      options: {},
      onEvent: () => {
        throw new Error("observer unavailable");
      },
    }).execute();

    assert.equal(result.finalMessage, "observer-safe");
    const runEvents = await session.runtimeEventStore!.readSession(session.id);
    assert.equal(
      runEvents.some((event) => event.kind === "run.terminal" && event.data.status === "completed"),
      true,
    );
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("run.failed lifecycle observers cannot replace the original Runtime failure", () => {
  assert.doesNotThrow(() =>
    emitRuntimeLifecycleEvent(
      () => {
        throw new Error("observer unavailable");
      },
      {
        type: "run.failed",
        sessionId: "failed-session",
        workDir: "/workspace",
        at: 1,
        detail: "original failure",
      },
    ),
  );
});
