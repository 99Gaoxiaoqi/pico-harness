import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEngine } from "../../../src/engine/loop.js";
import { Session } from "../../../src/engine/session.js";
import type { HookOutput } from "../../../src/hooks/types.js";
import { createEngineRuntimePort } from "../../../src/runtime/engine-runtime-port-adapter.js";
import type {
  RuntimeLifecycleEvent,
  RuntimeRunOptions,
} from "../../../src/runtime/runtime-contract.js";
import {
  RuntimeRunExecutor,
  emitRuntimeLifecycleEvent,
} from "../../../src/runtime/runtime-run-executor.js";
import { RuntimeRun } from "../../../src/runtime/runtime-run.js";
import type { SessionRuntime } from "../../../src/runtime/session-runtime.js";

test("RuntimeRunExecutor executes one assembled turn without owning its resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-run-executor-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const session = new Session("runtime-run-executor", workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
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
    assert.equal(session.runtimeEventStore?.storageRoot !== undefined, true);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Run headers persist authorization for small turns without a graph across Session restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-run-authorization-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const openSession = () =>
    new Session("run-authorization", workDir, {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    });
  let session = openSession();
  try {
    await session.recover();
    for (const authorization of [undefined, "session_mode", "turn_override"] as const) {
      await new RuntimeRunExecutor({
        session,
        runtimeState: {
          dispatchHook: async () => ({ decision: "allow" }),
        } as unknown as SessionRuntime,
        engine: {
          run: async (target: Session) => {
            await target.commitMessages({ role: "assistant", content: "small answer" });
            return target.getHistory();
          },
        } as unknown as AgentEngine,
        sessionSelection: { mode: "resume", sessionId: session.id },
        workDir,
        picoHome,
        prompt: "simple question",
        resumeExistingSession: false,
        traceEnabled: false,
        options: {},
        ...(authorization ? { agentSwarmAuthorization: authorization } : {}),
      }).execute();
    }
    await session.close();
    session = openSession();
    await session.recover();
    const events = await session.runtimeEventStore!.readSession(session.id);
    const starts = events.filter((event) => event.kind === "run.started");
    assert.deepEqual(
      starts.map((event) => event.data.agentSwarmAuthorization),
      ["none", "session_mode", "turn_override"],
    );
    assert.equal(events.filter((event) => event.kind === "run.terminal").length, 3);
    assert.equal(
      events.some((event) => event.kind.startsWith("agent.")),
      false,
    );
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("RuntimeRunExecutor fails the canonical Run when its host completion guard rejects", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-run-completion-guard-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const session = new Session("runtime-run-completion-guard", workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  try {
    await session.recover();
    await assert.rejects(
      new RuntimeRunExecutor({
        session,
        runtimeState: {
          dispatchHook: async (): Promise<HookOutput> => ({ decision: "allow" }),
        } as unknown as SessionRuntime,
        engine: {
          run: async (target: Session) => {
            await target.commitMessages({ role: "assistant", content: "premature" });
            return target.getHistory();
          },
        } as unknown as AgentEngine,
        sessionSelection: { mode: "new", sessionId: session.id },
        workDir,
        picoHome,
        prompt: "start graph",
        resumeExistingSession: false,
        traceEnabled: false,
        options: {},
        completionGuard: () => {
          throw new Error("graph remains open");
        },
      }).execute(),
      /graph remains open/u,
    );
    const events = await session.runtimeEventStore!.readSession(session.id);
    assert.equal(
      events.some((event) => event.kind === "run.terminal" && event.data.status === "failed"),
      true,
    );
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("RuntimeRunExecutor isolates lifecycle observer failures from canonical run success", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-run-observer-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const session = new Session("runtime-run-observer", workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
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

test("commitMessageOnce remains idempotent inside an active RuntimeRun", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-message-once-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const session = new Session("runtime-message-once", workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  try {
    await session.recover();
    const idleMessage = { role: "user" as const, content: "precommitted" };
    const idle = await session.commitMessageOnce("message-once:idle", idleMessage);
    const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
    const receipts = await run.run(async () => {
      const idleRetry = await session.commitMessageOnce("message-once:idle", idleMessage);
      const activeMessage = { role: "user" as const, content: "active" };
      const active = await session.commitMessageOnce("message-once:active", activeMessage);
      const activeRetry = await session.commitMessageOnce("message-once:active", activeMessage);
      return { idleRetry, active, activeRetry };
    });
    await run.finish("completed");

    assert.equal(receipts.idleRetry.inserted, false);
    assert.deepEqual(receipts.idleRetry.cursor, idle.cursor);
    assert.equal(receipts.active.inserted, true);
    assert.equal(receipts.activeRetry.inserted, false);
    assert.deepEqual(receipts.activeRetry.cursor, receipts.active.cursor);
    assert.equal(
      (await session.runtimeEventStore!.readSession(session.id)).some(
        (event) =>
          event.kind === "run.terminal" &&
          event.runId === run.runId &&
          event.data.status === "completed",
      ),
      true,
    );
    await session.commitMessages({ role: "assistant", content: "still writable" });
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
