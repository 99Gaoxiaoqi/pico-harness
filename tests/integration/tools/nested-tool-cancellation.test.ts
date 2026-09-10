import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentEngine } from "../../../src/engine/loop.js";
import { SilentReporter } from "../../../src/engine/reporter.js";
import { Session } from "../../../src/engine/session.js";
import { createEngineRuntimePort } from "../../../src/runtime/engine-runtime-port-adapter.js";
import { currentRuntimeRun, RuntimeRun } from "../../../src/runtime/runtime-run.js";
import { createCodeModeTool } from "../../../src/tools/code-mode-tool.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";
import {
  NO_FILE_SIDE_EFFECTS,
  ToolCommitBoundaryError,
  type BaseTool,
} from "../../../src/tools/registry.js";
import { ToolAccesses } from "../../../src/tools/tool-access.js";

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
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
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
