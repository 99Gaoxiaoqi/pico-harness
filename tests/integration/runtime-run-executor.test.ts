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

test("Memory enqueue failure cannot replace completed terminal state or streamed result", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-memory-enqueue-failure-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const session = new Session("runtime-memory-enqueue-failure", workDir, {
    persistence: true,
    picoHome,
  });
  try {
    await session.recover();
    const runtimeState = {
      dispatchHook: async (): Promise<HookOutput> => ({ decision: "allow" }),
    } as unknown as SessionRuntime;
    const engine = {
      run: async (target: Session) => {
        await target.commitMessages({ role: "assistant", content: "streamed answer" });
        return target.getHistory();
      },
    } as unknown as AgentEngine;
    let enqueued = 0;
    const result = await new RuntimeRunExecutor({
      session,
      runtimeState,
      engine,
      sessionSelection: { mode: "new", sessionId: session.id },
      workDir,
      picoHome,
      prompt: "请记住：这个项目固定使用 npm run verify 。",
      resumeExistingSession: false,
      traceEnabled: false,
      options: {},
      memoryReviewScheduler: {
        enqueue(input) {
          enqueued++;
          assert.equal(input.sessionId, session.id);
          assert.match(input.userMessageEventId, /^user-message:/u);
          assert.ok(input.runId);
          assert.ok(input.terminalEventId);
          throw new Error("memory queue unavailable");
        },
      },
    }).execute();
    assert.equal(result.finalMessage, "streamed answer");
    await waitForImmediate();
    assert.equal(enqueued, 1);
    const events = await session.runtimeEventStore!.readSession(session.id);
    assert.equal(
      events.some((event) => event.kind === "run.terminal" && event.data.status === "completed"),
      true,
    );
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary questions never schedule Memory review", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-memory-signal-gate-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const session = new Session("runtime-memory-signal-gate", workDir, {
    persistence: true,
    picoHome,
  });
  try {
    await session.recover();
    let enqueued = 0;
    await new RuntimeRunExecutor({
      session,
      runtimeState: {
        dispatchHook: async (): Promise<HookOutput> => ({ decision: "allow" }),
      } as unknown as SessionRuntime,
      engine: {
        run: async (target: Session) => {
          await target.commitMessages({ role: "assistant", content: "4" });
          return target.getHistory();
        },
      } as unknown as AgentEngine,
      sessionSelection: { mode: "new", sessionId: session.id },
      workDir,
      picoHome,
      prompt: "What is 2 + 2?",
      resumeExistingSession: false,
      traceEnabled: false,
      options: {},
      memoryReviewScheduler: { enqueue: () => void enqueued++ },
    }).execute();

    await waitForImmediate();
    assert.equal(enqueued, 0);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a precommitted Desktop user message schedules once while an idle resume does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-memory-precommitted-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const session = new Session("runtime-memory-precommitted", workDir, {
    persistence: true,
    picoHome,
  });
  const prompt = "请记住：这个项目固定使用 npm run desktop-memory 。";
  try {
    await session.recover();
    const receipt = await session.commitMessageOnce("desktop-user-memory", {
      role: "user",
      content: prompt,
      providerData: { picoKind: "desktop_user_input" },
    });
    const enqueued: Array<{ readonly userMessageEventId: string }> = [];
    const engine = {
      run: async (target: Session) => {
        await target.commitMessages({ role: "assistant", content: "done" });
        return target.getHistory();
      },
    } as unknown as AgentEngine;
    const runtimeState = {
      dispatchHook: async (): Promise<HookOutput> => ({ decision: "allow" }),
    } as unknown as SessionRuntime;
    const execute = (currentPrompt: string) =>
      new RuntimeRunExecutor({
        session,
        runtimeState,
        engine,
        sessionSelection: { mode: "resume", sessionId: session.id },
        workDir,
        picoHome,
        prompt: currentPrompt,
        resumeExistingSession: true,
        traceEnabled: false,
        options: {},
        memoryReviewScheduler: {
          enqueue: (input) => void enqueued.push(input),
        },
      }).execute();

    await execute(prompt);
    await waitForImmediate();
    assert.deepEqual(
      enqueued.map((input) => input.userMessageEventId),
      [receipt.eventId],
    );

    await execute("");
    await waitForImmediate();
    assert.equal(
      enqueued.length,
      1,
      "an idle continuation must not replay the previous user input",
    );
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("RuntimeRunExecutor returns before a synchronously slow and blocked Memory scheduler starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-memory-enqueue-blocked-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const session = new Session("runtime-memory-enqueue-blocked", workDir, {
    persistence: true,
    picoHome,
  });
  let schedulerStarted = false;
  let markSchedulerStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    markSchedulerStarted = resolve;
  });
  const blocked = new Promise<void>(() => undefined);
  try {
    await session.recover();
    const runtimeState = {
      dispatchHook: async (): Promise<HookOutput> => ({ decision: "allow" }),
    } as unknown as SessionRuntime;
    const engine = {
      run: async (target: Session) => {
        await target.commitMessages({ role: "assistant", content: "fast foreground" });
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
      prompt: "请记住：默认使用 npm run verify 。",
      resumeExistingSession: false,
      traceEnabled: false,
      options: {},
      memoryReviewScheduler: {
        enqueue() {
          schedulerStarted = true;
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
            0,
            0,
            50,
          );
          markSchedulerStarted();
          return blocked;
        },
      },
    }).execute();

    assert.equal(result.finalMessage, "fast foreground");
    assert.equal(schedulerStarted, false, "detached observer must not run on the response path");
    await started;
    assert.equal(schedulerStarted, true);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed, cancelled and resumed Runtime executions never enqueue Memory review", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-memory-ineligible-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const runtimeState = {
    dispatchHook: async (): Promise<HookOutput> => ({ decision: "allow" }),
  } as unknown as SessionRuntime;
  let enqueued = 0;
  const scheduler = { enqueue: () => void enqueued++ };
  try {
    const failed = new Session("runtime-memory-failed", workDir, { persistence: true, picoHome });
    await failed.recover();
    await assert.rejects(
      new RuntimeRunExecutor({
        session: failed,
        runtimeState,
        engine: {
          run: async () => Promise.reject(new Error("model failed")),
        } as unknown as AgentEngine,
        sessionSelection: { mode: "new", sessionId: failed.id },
        workDir,
        picoHome,
        prompt: "failure",
        resumeExistingSession: false,
        traceEnabled: false,
        options: {},
        memoryReviewScheduler: scheduler,
      }).execute(),
      /model failed/u,
    );
    assert.equal(enqueued, 0);
    await failed.close();

    const cancelled = new Session("runtime-memory-cancelled", workDir, {
      persistence: true,
      picoHome,
    });
    await cancelled.recover();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      new RuntimeRunExecutor({
        session: cancelled,
        runtimeState,
        engine: { run: async () => [] } as unknown as AgentEngine,
        sessionSelection: { mode: "new", sessionId: cancelled.id },
        workDir,
        picoHome,
        prompt: "cancel",
        resumeExistingSession: false,
        traceEnabled: false,
        options: {},
        signal: controller.signal,
        memoryReviewScheduler: scheduler,
      }).execute(),
      /abort/iu,
    );
    assert.equal(enqueued, 0);
    const cancelledEvents = await cancelled.runtimeEventStore!.readSession(cancelled.id);
    assert.equal(
      cancelledEvents.some(
        (event) => event.kind === "run.terminal" && event.data.status === "cancelled",
      ),
      true,
    );
    await cancelled.close();

    const resumed = new Session("runtime-memory-resumed", workDir, {
      persistence: true,
      picoHome,
    });
    await resumed.recover();
    await new RuntimeRunExecutor({
      session: resumed,
      runtimeState,
      engine: { run: async () => [] } as unknown as AgentEngine,
      sessionSelection: { mode: "resume", sessionId: resumed.id },
      workDir,
      picoHome,
      prompt: "unused",
      resumeExistingSession: true,
      traceEnabled: false,
      options: {},
      memoryReviewScheduler: scheduler,
    }).execute();
    assert.equal(enqueued, 0);
    await resumed.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function waitForImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
