import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Reporter } from "@pico/core";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { logger } from "@pico/pico-host/logger";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { Session } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import type { SessionRuntime } from "@pico/pico-host/session-runtime";
import { RuntimeRunExecutor } from "@pico/pico-host/product-runtime-run-executor";
import { currentRuntimeRun, RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { createCodeModeTool } from "@pico/pico-host/code-mode-tool";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";
import {
  NO_FILE_SIDE_EFFECTS,
  ToolCommitBoundaryError,
  type BaseTool,
} from "@pico/pico-host/tool-registry-contract";
import { ToolAccesses } from "@pico/runtime/tool-access";

async function scene(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-nested-cancellation-"));
  const runtimePort = createEngineRuntimePort();
  const session = new Session("nested-cancellation", root, {
    persistence: true,
    picoHome: join(root, "home"),
    runtimePort,
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  return { root, runtimePort, session, store: session.runtimeEventStore! };
}

function capturingReporter(messages: string[]): Reporter {
  const reporter: Reporter = new SilentReporter();
  reporter.onMessage = (content) => {
    messages.push(content);
  };
  return reporter;
}

function fixture(name: string, execute: BaseTool["execute"]): BaseTool {
  return {
    name: () => name,
    nesting: "nestable",
    fileSideEffects: NO_FILE_SIDE_EFFECTS,
    accesses: () => ToolAccesses.none(),
    definition: () => ({ name, description: "fixture", inputSchema: { type: "object" } }),
    execute,
  };
}

test("Code Mode 在 T1 后取消子调用时中止模型推理，恢复保持副作用未决", async (t) => {
  const { root, runtimePort, session, store } = await scene(t);
  const registry = new ToolRegistry();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let physicalCalls = 0;
  registry.register(
    fixture("pending_effect", async (_args, context) => {
      physicalCalls++;
      await new Promise<void>((_resolve, reject) => {
        context!.signal!.addEventListener("abort", () => reject(context!.signal!.reason), {
          once: true,
        });
        markStarted();
      });
      return "unreachable";
    }),
  );
  registry.register(
    fixture("fail_after_start", async () => {
      await started;
      throw new Error("Finish the cell while the sibling's effect is unresolved");
    }),
  );
  registry.register(createCodeModeTool({ registry, getRuntimeRun: currentRuntimeRun }));
  let modelCalls = 0;
  const engine = new AgentEngine({
    registry,
    workDir: root,
    runtimePort,
    reporter: new SilentReporter(),
    maxTurns: 2,
    provider: {
      async generate() {
        modelCalls++;
        if (modelCalls > 1) return { role: "assistant", content: "unsafe continuation" };
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "parent-exec",
              name: "exec",
              arguments: JSON.stringify({
                code: 'try { await Promise.all([tools.pending_effect({}), tools.fail_after_start({})]); } catch {} return "caught";',
              }),
            },
          ],
        };
      },
    },
  });
  await session.commitMessages({ role: "user", content: "Run the cancellation fixture." });
  await assert.rejects(engine.run(session));
  assert.equal(physicalCalls, 1);
  assert.equal(modelCalls, 1, "Unsettled child effects must stop the next model dispatch");
  const events = await store.readSession(session.id);
  const childStart = events.find(
    (event) => event.kind === "tool.started" && event.data.toolName === "pending_effect",
  );
  assert.ok(childStart?.kind === "tool.started" && childStart.refs?.toolCallId);
  assert.equal(
    (await store.readToolOperation(session.id, childStart.runId, childStart.refs.toolCallId))
      ?.state,
    "prepared",
  );
  await RuntimeRun.reconcileIncompleteRuns({ capability: session.runtimeEventCapability! });
  const recovery = (await store.readSession(session.id)).find(
    (event) =>
      event.kind === "tool.result.recorded" &&
      event.refs.toolCallId === childStart.refs!.toolCallId,
  );
  assert.ok(recovery?.kind === "tool.result.recorded");
  assert.equal(recovery.visibility, "internal");
  assert.equal(recovery.data.recovery?.classification, "indeterminate");
  await assert.rejects(engine.run(session), /Unresolved tool effects/);
  assert.equal(modelCalls, 1);
  assert.equal(physicalCalls, 1, "Recovery must never replay the child operation");
});

test("嵌套结果通知只在 T2 后运行，使用最终参数且通知失败不撤销已提交事实", async (t) => {
  const { session, store } = await scene(t);
  const registry = new ToolRegistry();
  registry.register(fixture("lookup", async () => "committed result"));
  registry.useRequest(async (call) => ({
    allowed: true,
    call: { ...call, arguments: '{"value":2}' },
  }));
  const run = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  const call = { id: "notified", name: "lookup", arguments: '{"value":1}' };
  const context = {
    parentToolCallId: "exec-parent",
    step: registry.captureStep("step", [call.name]),
  };
  let notifications = 0;
  const result = await run.executeNestedTool(call, registry, {
    ...context,
    onCommittedResult: async (finalCall, envelope) => {
      notifications++;
      assert.equal(finalCall.arguments, '{"value":2}');
      assert.equal(envelope.status, "succeeded");
      assert.equal(
        (await store.readToolOperation(session.id, run.runId, finalCall.id))?.state,
        "settled",
      );
    },
  });
  assert.equal(result.output, "committed result");
  assert.equal(notifications, 1);
  const settle = store.settleToolOperation.bind(store);
  store.settleToolOperation = async () => {
    throw new Error("T2 failpoint");
  };
  await assert.rejects(
    run.executeNestedTool({ ...call, id: "uncommitted" }, registry, {
      ...context,
      onCommittedResult: async () => {
        notifications++;
      },
    }),
    (error) => error instanceof ToolCommitBoundaryError && error.phase === "T2",
  );
  store.settleToolOperation = settle;
  assert.equal(notifications, 1);
  await assert.rejects(
    run.executeNestedTool({ ...call, id: "notification-failed" }, registry, {
      ...context,
      onCommittedResult: async () => {
        throw new Error("Post-commit notification failed");
      },
    }),
    (error) => error instanceof ToolCommitBoundaryError && error.phase === "T2",
  );
  assert.equal(
    (await store.readToolOperation(session.id, run.runId, "notification-failed"))?.state,
    "settled",
  );
});

test("取消期限可达并告警，但未收口的工作区写工具继续隔离后续 Run", async (t) => {
  const { root, runtimePort, session } = await scene(t);
  const registry = new ToolRegistry();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let releaseTool!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  registry.register({
    name: () => "pending_write_fixture",
    definition: () => ({
      name: "pending_write_fixture",
      description: "fixture",
      inputSchema: { type: "object", properties: {} },
    }),
    fileSideEffects: { kind: "workspace" },
    accesses: () => ToolAccesses.all(),
    execute: async () => {
      markStarted();
      await release;
      return "settled after cancellation";
    },
  });
  let providerCalls = 0;
  const visibleMessages: string[] = [];
  const reporter = capturingReporter(visibleMessages);
  const engine = new AgentEngine({
    registry,
    workDir: root,
    runtimePort,
    reporter,
    maxTurns: 2,
    provider: {
      async generate() {
        providerCalls++;
        return providerCalls === 1
          ? {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "pending-write", name: "pending_write_fixture", arguments: "{}" }],
            }
          : { role: "assistant", content: "retry completed after isolation" };
      },
    },
  });
  const controller = new AbortController();
  await session.commitMessages({ role: "user", content: "Run the pending write fixture." });
  const warnings: string[] = [];
  const originalWarn = logger.warn;
  logger.warn = ((...args: Parameters<typeof logger.warn>) => {
    const message = args[1];
    if (typeof message === "string" && message.includes("取消期限已到")) warnings.push(message);
    return originalWarn.apply(logger, args);
  }) as typeof logger.warn;
  let runSettled = false;
  const firstRun = engine.run(session, undefined, undefined, controller.signal);
  const firstRunObserved = firstRun.then(
    () => {
      runSettled = true;
    },
    () => {
      runSettled = true;
    },
  );
  let retry: Promise<unknown> | undefined;
  try {
    const toolStarted = await Promise.race([
      started.then(() => true),
      firstRun.then(
        () => false,
        () => false,
      ),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    assert.equal(toolStarted, true, "The fixture write tool must start before cancellation");
    controller.abort(new DOMException("fixture cancellation", "AbortError"));
    await new Promise((resolve) => setTimeout(resolve, 10_100));
    assert.equal(
      warnings.length,
      1,
      "The reachable cancellation deadline reports unsettled writes",
    );
    assert.match(visibleMessages.join("\n"), /取消尚未完成.*工作区隔离/u);
    assert.equal(runSettled, false, "The cancelled Run retains ownership until the write settles");

    retry = engine.run(session);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(providerCalls, 1, "A same-Session retry cannot overlap the unresolved write");

    releaseTool();
    await assert.rejects(firstRun, /fixture cancellation/u);
    await retry;
    assert.equal(providerCalls, 2, "The retry starts after the original side effect settles");
  } finally {
    releaseTool();
    logger.warn = originalWarn;
    await firstRunObserved;
    await retry?.catch(() => undefined);
  }
});

test("模型 length 响应保留部分输出与 usage，并作为 output_limit 收口", async (t) => {
  const { root, runtimePort, session } = await scene(t);
  const visibleMessages: string[] = [];
  const reporter = capturingReporter(visibleMessages);
  const engine = new AgentEngine({
    registry: new ToolRegistry(),
    workDir: root,
    runtimePort,
    reporter,
    provider: {
      async generate() {
        return {
          role: "assistant",
          content: "部分生成的回答",
          usage: { promptTokens: 7, completionTokens: 11 },
          providerData: { finishReason: "length" },
        };
      },
    },
  });

  const runtimeState = {
    dispatchHook: async () => ({ decision: "allow" as const }),
  } as unknown as SessionRuntime;
  const result = await new RuntimeRunExecutor({
    session,
    runtimeState,
    engine,
    sessionSelection: { mode: "new", sessionId: session.id },
    workDir: root,
    picoHome: join(root, "home"),
    prompt: "Summarize the result.",
    resumeExistingSession: false,
    agentSwarmAuthorization: "none",
    traceEnabled: false,
    options: {},
  }).execute();

  assert.equal(result.finalMessage, "部分生成的回答");
  assert.equal(result.messages.at(-1)?.usage?.completionTokens, 11);
  assert.equal(result.outcome?.stopReason, "output_limit");
  assert.equal(result.outcome?.primaryUsage.promptTokens, 7);
  assert.equal(result.outcome?.primaryUsage.completionTokens, 11);
  assert.match(visibleMessages.join("\n"), /部分生成的回答[\s\S]*模型输出达到长度上限/u);
});
