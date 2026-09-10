import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentEngine } from "../../../src/engine/loop.js";
import { SilentReporter } from "../../../src/engine/reporter.js";
import { Session } from "../../../src/engine/session.js";
import { HookService } from "../../../src/hooks/service.js";
import { createEngineRuntimePort } from "../../../src/runtime/engine-runtime-port-adapter.js";
import { currentRuntimeRun, RuntimeRun } from "../../../src/runtime/runtime-run.js";
import { createCodeModeTool } from "../../../src/tools/code-mode-tool.js";
import { ToolCommitBoundaryError } from "../../../src/tools/registry.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";
import {
  buildToolArgumentAudit,
  MAX_TOOL_ARGUMENT_AUDIT_BYTES,
} from "../../../src/tools/tool-argument-audit.js";
import { WriteFileTool } from "../../../src/tools/write-file.js";

async function scene(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-audit-refusal-"));
  const runtimePort = createEngineRuntimePort();
  const open = () =>
    new Session("audit-refusal", root, {
      persistence: true,
      picoHome: join(root, "home"),
      runtimePort,
    });
  let session = open();
  await session.recover();
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  const registry = new ToolRegistry();
  registry.register(new WriteFileTool(root));
  return {
    root,
    registry,
    runtimePort,
    get session() {
      return session;
    },
    async reopen() {
      await session.close();
      session = open();
      await session.recover();
      return session;
    },
  };
}

for (const mode of ["nested", "hook-final", "after-success"] as const) {
  test(`真实父 exec 的审计拒绝可结账且不伪造整个 Cell 未执行 (${mode})`, async (t) => {
    const state = await scene(t);
    const { registry, session, root, runtimePort } = state;
    const duplicated = '{"key":"first","key":"second"}';
    if (mode === "hook-final")
      registry.setHookService(
        new HookService({
          workDir: root,
          sessionId: session.id,
          executor: {
            async execute() {
              return { decision: "allow" };
            },
          },
          decisionProviders: [
            {
              evaluate(event, payload) {
                if (
                  event === "PreToolUse" &&
                  "tool_name" in payload &&
                  payload.tool_name === "write_file"
                ) {
                  return {
                    decision: "allow",
                    modifiedInput: { path: "refused.txt", content: duplicated },
                  };
                }
                return { decision: "allow" };
              },
            },
          ],
        }),
      );
    registry.useExecution(async (call, next) => {
      try {
        return await next(call);
      } catch (error) {
        if (call.name === "write_file") return "middleware tried to hide refusal";
        throw error;
      }
    });
    registry.register(createCodeModeTool({ registry, getRuntimeRun: currentRuntimeRun }));
    const prefix =
      mode === "after-success"
        ? 'await tools.write_file({path:"success.txt",content:"already committed"});'
        : "";
    const content = mode === "hook-final" ? "initially safe" : duplicated;
    const code = `${prefix} return await tools.write_file(${JSON.stringify({ path: "refused.txt", content })});`;
    let requests = 0;
    const engine = new AgentEngine({
      workDir: root,
      registry,
      runtimePort,
      reporter: new SilentReporter(),
      maxTurns: 2,
      provider: {
        async generate() {
          if (++requests === 1)
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "parent-exec",
                  name: "exec",
                  arguments: JSON.stringify({ code }),
                },
              ],
            };
          const events = await session.runtimeEventStore!.readSession(session.id);
          assert.ok(
            events.some(
              (event) =>
                event.kind === "tool.result.recorded" && event.refs.toolCallId === "parent-exec",
            ),
          );
          return { role: "assistant", content: "done" };
        },
      },
    });
    await session.commitMessages({ role: "user", content: "Run the bounded cell." });
    await engine.run(session);
    assert.equal(requests, 2);
    await assert.rejects(readFile(join(root, "refused.txt")), { code: "ENOENT" });
    if (mode === "after-success")
      assert.equal(await readFile(join(root, "success.txt"), "utf8"), "already committed");
    const events = await session.runtimeEventStore!.readSession(session.id);
    const refusal = events.find(
      (event) => event.kind === "tool.result.recorded" && event.data.status === "rejected",
    );
    assert.ok(refusal?.kind === "tool.result.recorded");
    assert.equal(refusal.refs.parentToolCallId, "parent-exec");
    assert.match(JSON.stringify(refusal.data.body), /duplicate JSON keys/);
    assert.ok(
      !events.some(
        (event) =>
          event.kind === "tool.started" && event.refs?.toolCallId === refusal.refs.toolCallId,
      ),
    );
    const parent = events.find(
      (event) => event.kind === "tool.result.recorded" && event.refs.toolCallId === "parent-exec",
    );
    assert.ok(parent?.kind === "tool.result.recorded");
    assert.notEqual(parent.data.status, "rejected", "the parent cell crossed T1 and executed");
    assert.equal(parent.data.body.storage, "inline");
    if (parent.data.body.storage !== "inline") throw new Error("expected inline cell result");
    const output = JSON.parse(parent.data.body.content);
    assert.equal(output.ok, false);
    assert.match(output.error.message, /duplicate JSON keys/);
    assert.equal(output.toolCalls.length, mode === "after-success" ? 2 : 1);
    const operations = await session.runtimeEventStore!.listRunToolOperations(
      session.id,
      parent.runId,
    );
    assert.equal(operations.length, mode === "after-success" ? 2 : 1);
    assert.ok(operations.every((operation) => operation.state === "settled"));
    assert.ok(
      events.some((event) => event.kind === "run.terminal" && event.data.status === "completed"),
    );
    const reopened = await state.reopen();
    const recovered = await reopened.runtimeEventStore!.readRun(reopened.id, parent.runId);
    assert.ok(
      !recovered.some((event) => event.kind === "tool.result.recorded" && event.data.recovery),
    );
    const run = await RuntimeRun.start({ capability: reopened.runtimeEventCapability! });
    await run.assertNoUnresolvedToolEffects();
    await run.finish("completed");
  });
}

test("字节和深度审计拒绝不触及存储；伪造拒绝与存储内审计异常仍为 T1 故障", async (t) => {
  const { session, registry, root } = await scene(t);
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const store = session.runtimeEventStore!;
  const prepare = store.prepareToolOperation.bind(store);
  let writes = 0;
  store.prepareToolOperation = async (input) => {
    writes++;
    return prepare(input);
  };
  const context = {
    parentToolCallId: "parent",
    step: registry.captureStep("step", ["write_file"]),
  };
  const contents = [
    "x".repeat(MAX_TOOL_ARGUMENT_AUDIT_BYTES),
    "[".repeat(130) + "0" + "]".repeat(130),
  ];
  for (const [index, content] of contents.entries()) {
    const result = await run.executeNestedTool(
      {
        id: `limit-${index}`,
        name: "write_file",
        arguments: JSON.stringify({ path: "refused.txt", content }),
      },
      registry,
      context,
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /audit.*limit/);
  }
  assert.equal(writes, 0);
  const call = {
    id: "storage-error",
    name: "write_file",
    arguments: '{"path":"refused.txt","content":"safe"}',
  };
  await assert.rejects(
    registry.execute(call, {
      beforeDispatch: async () => {
        const forged = new Error("forged refusal");
        forged.name = "ToolArgumentAuditRefusal";
        throw forged;
      },
    }),
    (error) => error instanceof ToolCommitBoundaryError && error.phase === "T1",
  );
  store.prepareToolOperation = async (input) => {
    await prepare(input);
    buildToolArgumentAudit('{"key":1,"key":2}');
    throw new Error("unreachable");
  };
  await assert.rejects(
    run.executeNestedTool(call, registry, context),
    (error) => error instanceof ToolCommitBoundaryError && error.phase === "T1",
  );
  store.prepareToolOperation = prepare;
  await assert.rejects(readFile(join(root, "refused.txt")), { code: "ENOENT" });
  assert.equal((await store.listRunToolOperations(session.id, run.runId))[0]?.state, "prepared");
  await assert.rejects(run.finish("completed"), /prepared tool operation/);
});
