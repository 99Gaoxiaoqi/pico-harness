import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentEngine } from "../../../src/engine/loop.js";
import { SilentReporter } from "../../../src/engine/reporter.js";
import { Session } from "../../../src/engine/session.js";
import { HookService } from "../../../src/hooks/service.js";
import { createEngineRuntimePort } from "../../../src/runtime/engine-runtime-port-adapter.js";
import { RuntimeEventBoundaryInspector } from "../helpers/runtime-event-boundary-inspector.js";
import { RuntimeRun } from "../../../src/runtime/runtime-run.js";
import { ToolCommitBoundaryError } from "../../../src/tools/registry.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";
import { WriteFileTool } from "../../../src/tools/write-file.js";

async function scene(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-commit-"));
  const workDir = join(root, "workspace");
  await mkdir(workDir);
  const runtimePort = createEngineRuntimePort();
  const session = new Session("tool-commit", workDir, {
    persistence: true,
    picoHome: join(root, "home"),
    runtimePort,
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const registry = new ToolRegistry();
  registry.register(new WriteFileTool(workDir));
  return { session, registry, workDir, runtimePort, store: session.runtimeEventStore! };
}

test("最终 Hook 参数与权限先于 T1，拒绝和非法改写不产生派发事实", async (t) => {
  const { session, registry, workDir, store } = await scene(t);
  let rewrite: unknown = { path: "final.txt", content: "validated" };
  registry.setHookService(
    new HookService({
      workDir,
      sessionId: session.id,
      executor: {
        async execute() {
          return { decision: "allow" };
        },
      },
      decisionProviders: [
        {
          evaluate(event) {
            return event === "PreToolUse"
              ? { decision: "allow", modifiedInput: rewrite }
              : { decision: "allow" };
          },
        },
      ],
    }),
  );
  const order: string[] = [];
  registry.usePermission(async (call) => {
    order.push("permission");
    assert.equal(JSON.parse(call.arguments).path, "final.txt");
    return { allowed: true };
  });
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const call = {
    id: "final",
    name: "write_file",
    arguments: '{"path":"initial.txt","content":"initial"}',
  };
  const result = await registry.execute(call, {
    beforeDispatch: async (final) => {
      order.push("T1");
      await run.recordToolStarted(final.id, final.name, final.arguments);
    },
  });
  assert.equal(result.isError, false);
  assert.equal(await readFile(join(workDir, "final.txt"), "utf8"), "validated");
  const started = (await store.readRun(session.id, run.runId)).find(
    (event) => event.kind === "tool.started",
  );
  assert.equal(
    started?.data.argumentsHash,
    createHash("sha256").update(JSON.stringify(rewrite)).digest("hex"),
  );
  assert.deepEqual(order, ["permission", "T1"]);
  rewrite = { path: "bad.txt", content: 42 };
  let dispatched = false;
  const invalid = await registry.execute(
    { ...call, id: "invalid" },
    {
      beforeDispatch: async () => {
        dispatched = true;
      },
    },
  );
  assert.equal(invalid.isError, true);
  assert.match(invalid.output, /Invalid tool arguments/);
  assert.equal(dispatched, false);
  assert.equal(
    (await store.readRun(session.id, run.runId)).filter((event) => event.kind === "tool.started")
      .length,
    1,
  );
});

test("T1 写失败禁止文件副作用；T2 失败不返回沙箱且恢复保留隐藏未决阻断", async (t) => {
  const { session, registry, workDir, store } = await scene(t);
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const context = {
    parentToolCallId: "exec-parent",
    step: registry.captureStep("step", ["write_file"]),
  };
  const call = {
    id: "nested-write",
    name: "write_file",
    arguments: '{"path":"out.txt","content":"once"}',
  };
  const prepare = store.prepareToolOperation.bind(store);
  store.prepareToolOperation = async () => {
    throw new Error("T1 failpoint");
  };
  await assert.rejects(
    run.executeNestedTool(call, registry, context),
    (error) => error instanceof ToolCommitBoundaryError && error.phase === "T1",
  );
  await assert.rejects(readFile(join(workDir, "out.txt")), { code: "ENOENT" });
  store.prepareToolOperation = prepare;
  const settle = store.settleToolOperation.bind(store);
  store.settleToolOperation = async () => {
    throw new Error("T2 failpoint");
  };
  await assert.rejects(
    run.executeNestedTool(call, registry, context),
    (error) => error instanceof ToolCommitBoundaryError && error.phase === "T2",
  );
  assert.equal(await readFile(join(workDir, "out.txt"), "utf8"), "once");
  assert.equal((await store.listRunToolOperations(session.id, run.runId))[0]?.state, "prepared");
  store.settleToolOperation = settle;
  await RuntimeRun.reconcileIncompleteRuns({ capability: session.runtimeEventCapability! });
  await RuntimeRun.reconcileIncompleteRuns({ capability: session.runtimeEventCapability! });
  const events = await store.readRun(session.id, run.runId);
  const recovered = events.find((event) => event.kind === "tool.result.recorded");
  assert.ok(recovered?.kind === "tool.result.recorded");
  assert.equal(recovered.visibility, "internal");
  assert.equal(recovered.data.origin, "code_mode");
  assert.equal(recovered.data.recovery?.classification, "indeterminate");
  assert.equal(recovered.data.projection.mode, "synthetic");
  assert.equal(events.filter((event) => event.kind === "tool.started").length, 1);
  const inspector = new RuntimeEventBoundaryInspector({ store });
  const boundary = await inspector.inspect({
    sessionId: session.id,
    runId: run.runId,
    eventHighWater: 0,
  });
  assert.ok(boundary.status === "available");
  assert.deepEqual(boundary.pendingToolCallIds, [call.id]);
  let modelCalls = 0;
  const engine = new AgentEngine({
    registry,
    workDir,
    runtimePort: createEngineRuntimePort(),
    reporter: new SilentReporter(),
    provider: {
      async generate() {
        modelCalls += 1;
        return { role: "assistant", content: "must not run" };
      },
    },
  });
  await assert.rejects(engine.run(session), /Unresolved tool effects/);
  assert.equal(modelCalls, 0);
  const resumed = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await assert.rejects(resumed.assertNoUnresolvedToolEffects(), /Unresolved tool effects/);
  await resumed.resolveToolRecovery({
    recoveryEventId: recovered.eventId,
    outcome: "effects_verified",
    evidenceUri: "file:///verified/out.txt",
    summary: "宿主已只读核查文件内容为 once，副作用已确认。",
  });
  await resumed.assertNoUnresolvedToolEffects();
  const resolvedBoundary = await inspector.inspect({
    sessionId: session.id,
    runId: run.runId,
    eventHighWater: 0,
  });
  assert.ok(resolvedBoundary.status === "available");
  assert.deepEqual(resolvedBoundary.pendingToolCallIds, []);
  assert.deepEqual(await resumed.readModelHistory(), []);
  assert.equal(await readFile(join(workDir, "out.txt"), "utf8"), "once");
  await resumed.finish("completed");
});

test("真实主循环权限拒绝不跨 T1，结果入账后才继续推理", async (t) => {
  const { session, registry, workDir, store, runtimePort } = await scene(t);
  registry.usePermission(async () => ({ allowed: false, reason: "fixture policy" }));
  await session.commitMessages({ role: "user", content: "write fixture" });
  let turns = 0;
  const engine = new AgentEngine({
    registry,
    workDir,
    runtimePort,
    reporter: new SilentReporter(),
    maxTurns: 2,
    provider: {
      async generate() {
        turns += 1;
        if (turns === 1)
          return {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "denied", name: "write_file", arguments: '{"path":"out.txt","content":"no"}' },
            ],
          };
        const events = await store.readSession(session.id);
        assert.ok(
          events.some(
            (event) => event.kind === "tool.result.recorded" && event.data.status === "rejected",
          ),
        );
        return { role: "assistant", content: "denied" };
      },
    },
  });
  await engine.run(session);
  assert.equal(turns, 2);
  assert.equal(
    (await store.readSession(session.id)).some((event) => event.kind === "tool.started"),
    false,
  );
  await assert.rejects(readFile(join(workDir, "out.txt")), { code: "ENOENT" });
});

test("步骤绑定拒绝同名热替换与新增工具，执行中间件不能改写获批参数", async (t) => {
  const { registry, workDir } = await scene(t);
  const step = registry.captureStep("frozen", ["write_file"]);
  assert.equal("add" in step.visibleToolNames, false);
  const forged = { id: "forged", visibleToolNames: new Set(["write_file"]) };
  assert.match(
    (
      await registry.execute(
        { id: "forged", name: "write_file", arguments: '{"path":"out.txt","content":"no"}' },
        { step: forged },
      )
    ).output,
    /Step snapshot/,
  );
  registry.register(new WriteFileTool(workDir));
  const call = { id: "frozen", name: "write_file", arguments: '{"path":"out.txt","content":"no"}' };
  assert.match((await registry.execute(call, { step })).output, /Step snapshot/);
  registry.useExecution(async (current, next) =>
    next({ ...current, arguments: '{"path":"other.txt","content":"bad"}' }),
  );
  let dispatched = false;
  assert.equal(
    (
      await registry.execute(call, {
        beforeDispatch: async () => {
          dispatched = true;
        },
      })
    ).isError,
    true,
  );
  assert.equal(dispatched, false);
});

test("执行中间件并发 next 只派发一次，捕获 T1 失败仍不能伪装成功", async (t) => {
  const { registry, workDir } = await scene(t);
  const call = {
    id: "once",
    name: "write_file",
    arguments: '{"path":"once.txt","content":"once"}',
  };
  registry.useExecution(async (current, next) => {
    const first = next(current);
    await assert.rejects(next(current), /duplicate dispatch/);
    return first.catch(() => "pretend success");
  });
  let prepares = 0;
  await assert.rejects(
    registry.execute(call, {
      beforeDispatch: async () => {
        prepares += 1;
        throw new Error("T1 failure");
      },
    }),
    (error) => error instanceof ToolCommitBoundaryError && error.phase === "T1",
  );
  assert.equal(prepares, 1);
  await assert.rejects(readFile(join(workDir, "once.txt")), { code: "ENOENT" });
  assert.equal(
    (
      await registry.execute(
        { ...call, id: "success" },
        {
          beforeDispatch: async () => {
            prepares += 1;
          },
        },
      )
    ).isError,
    false,
  );
  assert.equal(prepares, 2);
  assert.equal(await readFile(join(workDir, "once.txt"), "utf8"), "once");
});

test("嵌套结果在 T2 前应用宿主清理，清理失败不能返回普通工具结果", async (t) => {
  const { registry, session, store } = await scene(t);
  registry.register({
    name: () => "secret_fixture",
    nesting: "nestable",
    readOnly: true,
    definition: () => ({
      name: "secret_fixture",
      description: "fixture",
      inputSchema: { type: "object", properties: {} },
    }),
    execute: async () => "private-canary",
  });
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const call = { id: "sanitized", name: "secret_fixture", arguments: "{}" };
  const context = {
    parentToolCallId: "exec-parent",
    step: registry.captureStep("step", [call.name]),
  };
  const result = await run.executeNestedTool(call, registry, {
    ...context,
    sanitizeResult: (raw) => ({ ...raw, output: "[REDACTED]" }),
  });
  assert.equal(result.output, "[REDACTED]");
  assert.equal(
    JSON.stringify(await store.readRun(session.id, run.runId)).includes("private-canary"),
    false,
  );
  await assert.rejects(
    run.executeNestedTool({ ...call, id: "sanitizer-failure" }, registry, {
      ...context,
      sanitizeResult: () => {
        throw new Error("sanitize unavailable");
      },
    }),
    (error) => error instanceof ToolCommitBoundaryError && error.phase === "T2",
  );
});
