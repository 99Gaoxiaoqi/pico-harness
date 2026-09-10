import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../../../src/engine/session.js";
import { createEngineRuntimePort } from "../../../src/runtime/engine-runtime-port-adapter.js";
import { RuntimeRun } from "../../../src/runtime/runtime-run.js";
import { createCodeModeTool } from "../../../src/tools/code-mode-tool.js";
import type { CodeModeExecutionResult } from "../../../src/tools/code-mode.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";
import { ToolCommitBoundaryError, type BaseTool } from "../../../src/tools/registry.js";
import { ToolAccesses } from "../../../src/tools/tool-access.js";

function readableTool(name: string, execute: BaseTool["execute"]): BaseTool {
  return {
    name: () => name,
    nesting: "nestable",
    readOnly: true,
    accesses: () => ToolAccesses.none(),
    definition: () => ({
      name,
      description: "Return one number as text.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
    }),
    execute,
  };
}

test("Code Mode host redacts child output before either durable storage or sandbox observation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-code-mode-redaction-"));
  const session = new Session("code-mode-redaction", root, {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort: createEngineRuntimePort(),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const secret = "synthetic-child-secret-never-persist";
  const registry = new ToolRegistry();
  registry.register(readableTool("lookup", async () => secret));
  registry.register(
    createCodeModeTool({ registry, getRuntimeRun: () => run, redactionSecrets: [secret] }),
  );
  await run.run(async () => {
    await run.recordTurnStarted(1);
    const result = await registry.execute(
      {
        id: "parent-redact",
        name: "exec",
        arguments: JSON.stringify({ code: "return await tools.lookup({value:1});" }),
      },
      { step: registry.captureStep("step-redact", ["exec", "lookup"]) },
    );
    assert.equal(result.isError, false, result.output);
    assert.equal(JSON.parse(result.output).value, "[REDACTED]");
  });
  const events = await session.runtimeEventStore!.readRun(session.id, run.runId);
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.match(JSON.stringify(events), /\[REDACTED\]/);
});

test("Code Mode host: nested calls commit hidden T1/T2 and preserve Step and parent identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-code-mode-runtime-"));
  const session = new Session("code-mode-runtime", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort: createEngineRuntimePort(),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const registry = new ToolRegistry();
  const seenIds = new Set<string>();
  registry.register(
    readableTool("lookup", async (args, context) => {
      assert.equal(context?.origin, "code_mode");
      assert.equal(context?.parentToolCallId, "parent-exec");
      assert.equal(context?.step?.id, "step:1");
      assert.ok(context?.toolCallId);
      assert.ok(!seenIds.has(context.toolCallId));
      seenIds.add(context.toolCallId);
      const operation = await session.runtimeEventStore!.readToolOperation(
        session.id,
        run.runId,
        context.toolCallId,
      );
      assert.equal(operation?.state, "prepared", "T1 is durable before physical child work");
      return String((JSON.parse(args) as { value: number }).value);
    }),
  );
  registry.register(createCodeModeTool({ registry, getRuntimeRun: () => run }));
  assert.match(
    registry.getAvailableTools().find((tool) => tool.name === "lookup")!.description,
    /Code Mode: nestable via tools\.lookup\(args\)/,
  );
  const step = registry.captureStep("step:1", ["lookup", "exec"]);
  await run.run(async () => {
    await run.recordTurnStarted(1);
    await session.commitMessages({ role: "user", content: "Aggregate two lookups." });
    const result = await registry.execute(
      {
        id: "parent-exec",
        name: "exec",
        arguments: JSON.stringify({
          code: `
        const values = await Promise.all([2, 3].map(value => tools.lookup({ value })));
        return values.map(Number).reduce((sum, value) => sum + value, 0);
      `,
        }),
      },
      { step, toolCallId: "parent-exec", origin: "model" },
    );
    assert.equal(result.isError, false, result.output);
    const output = JSON.parse(result.output) as CodeModeExecutionResult;
    assert.equal(output.ok, true);
    if (output.ok) assert.equal(output.value, 5);
    for (const id of seenIds) {
      assert.equal(
        (await session.runtimeEventStore!.readToolOperation(session.id, run.runId, id))?.state,
        "settled",
      );
    }
    const history = await run.readModelHistory();
    assert.deepEqual(
      history.map((message) => message.role),
      ["user"],
    );
  });
  const events = await session.runtimeEventStore!.readRun(session.id, run.runId);
  const childEvents = events.filter(
    (event) =>
      (event.kind === "tool.started" || event.kind === "tool.result.recorded") &&
      event.data.origin === "code_mode",
  );
  assert.equal(childEvents.length, 4);
  assert.ok(childEvents.every((event) => event.visibility === "internal"));
  assert.ok(childEvents.every((event) => event.refs?.parentToolCallId === "parent-exec"));
  assert.ok(childEvents.every((event) => event.refs?.stepId === "step:1"));
  assert.equal(seenIds.size, 2);
});

test("Code Mode host: frozen activation, explicit nesting, permission and commit failures stay authoritative", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  const lookup = readableTool("lookup", async () => {
    executions++;
    return "1";
  });
  registry.register(lookup);
  registry.register({
    ...readableTool("readonly_only", async () => assert.fail("readOnly is not nesting authority")),
    nesting: undefined,
  });
  registry.register(readableTool("denied", async () => assert.fail("permission bypass")));
  registry.usePermission(async (call) => ({
    allowed: call.name !== "denied",
    reason: "Permission denied by test",
  }));
  const exec = createCodeModeTool({ registry });
  registry.register(exec);
  const step = registry.captureStep("step:frozen", ["lookup", "readonly_only", "denied", "exec"]);
  registry.register(readableTool("late", async () => assert.fail("late activation bypass")));
  const context = { step, toolCallId: "outer" };
  for (const code of [
    "return tools.late({value:1});",
    "return tools.readonly_only({value:1});",
    "return tools.exec({code:'return 1'});",
    "return tools.denied({value:1});",
    "return tools.lookup({value:'invalid'});",
  ]) {
    const result = JSON.parse(
      await exec.execute(JSON.stringify({ code }), context),
    ) as CodeModeExecutionResult;
    assert.equal(result.ok, false, code);
  }
  assert.equal(executions, 0);
  registry.register(readableTool("lookup", async () => assert.fail("replacement binding bypass")));
  const replaced = JSON.parse(
    await exec.execute(JSON.stringify({ code: "return tools.lookup({value:1});" }), context),
  ) as CodeModeExecutionResult;
  assert.equal(replaced.ok, false);
  await assert.rejects(exec.execute('{"code":"return 1;"}'), /Step snapshot/);
  await assert.rejects(
    createCodeModeTool({ registry, getRuntimeRun: () => undefined }).execute(
      '{"code":"return 1;"}',
      context,
    ),
    /durable RuntimeRun/,
  );

  // A direct embedding's physical bridge may also report a durable failure.
  const fatal = new ToolCommitBoundaryError("T2", new Error("disk failure"));
  registry.register(
    readableTool("fatal", async () => {
      throw fatal;
    }),
  );
  const fatalStep = registry.captureStep("step:fatal", ["fatal", "exec"]);
  await assert.rejects(
    exec.execute(
      JSON.stringify({ code: 'try { await tools.fatal({value:1}); } catch {} return "ignored";' }),
      { step: fatalStep, toolCallId: "fatal-parent" },
    ),
    (error) => error === fatal,
  );
});
