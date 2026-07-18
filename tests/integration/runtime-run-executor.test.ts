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
import { RuntimeRunExecutor } from "../../src/runtime/runtime-run-executor.js";

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
      runtimeEventStore: session.runtimeEventStore!,
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
