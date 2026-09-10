import assert from "node:assert/strict";
import { test } from "node:test";
import { CodeCellAdmission } from "../../../src/tools/code-cell-admission.js";
import { createCodeModeTool } from "../../../src/tools/code-mode-tool.js";
import type { CodeModeExecutionResult } from "../../../src/tools/code-mode.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";
import type { ToolExecutionContext } from "../../../src/tools/registry.js";
import { ToolAccesses } from "../../../src/tools/tool-access.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(admission?: CodeCellAdmission) {
  const registry = new ToolRegistry();
  const started = deferred();
  const releaseHost = deferred();
  const aborted = deferred();
  const calls: string[] = [];
  let hostFinished = false;
  registry.register({
    name: () => "controlled_read",
    nesting: "nestable",
    readOnly: true,
    accesses: () => ToolAccesses.none(),
    definition: () => ({
      name: "controlled_read",
      description: "Read a controlled local fixture.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    }),
    async execute(args, context) {
      const { id } = JSON.parse(args) as { id: string };
      assert.equal(context?.recoveryPolicy?.mode, "never_auto_retry");
      assert.deepEqual(context?.argumentRedactionSecrets, ["fixture-secret"]);
      calls.push(id);
      if (id === "held") {
        context?.signal?.addEventListener("abort", aborted.resolve, { once: true });
        started.resolve();
        // Deliberately ignore cancellation until physical I/O completes.
        await releaseHost.promise;
        hostFinished = true;
      }
      return id;
    },
  });
  const tool = createCodeModeTool({ registry, admission, redactionSecrets: ["fixture-secret"] });
  registry.register(tool);
  return {
    tool,
    calls,
    started,
    releaseHost,
    aborted,
    get hostFinished() {
      return hostFinished;
    },
    async run(id: string, signal?: AbortSignal): Promise<CodeModeExecutionResult> {
      // Exercise the adapter directly so outer Step scheduling cannot hide admission defects.
      const step = registry.captureStep(`step-${id}`, ["exec", "controlled_read"]);
      const context: ToolExecutionContext = { step, toolCallId: `parent-${id}`, signal };
      return JSON.parse(
        await tool.execute(
          JSON.stringify({
            code: `return await tools.controlled_read(${JSON.stringify({ id })});`,
          }),
          context,
        ),
      ) as CodeModeExecutionResult;
    },
  };
}

function assertFull(result: CodeModeExecutionResult) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "limit_exceeded");
  assert.deepEqual(result.toolCalls, []);
}

test(
  "Code Mode shares one active cell and one waiter across default registries",
  { timeout: 10_000 },
  async (t) => {
    const first = fixture();
    const second = fixture();
    t.after(() => first.releaseHost.resolve());
    assert.equal(first.tool.executionMode, "orchestrator");
    assert.equal(first.tool.executionSemantics, "exclusive_step");
    assert.equal(first.tool.recoveryMode, "never_auto_retry");
    const active = first.run("held");
    await first.started.promise;
    const waiting = second.run("queued");
    assertFull(await second.run("overflow"));
    assert.deepEqual(second.calls, [], "queued/overflow cells cannot dispatch host work");
    first.releaseHost.resolve();
    assert.equal((await active).ok, true);
    assert.deepEqual(await waiting, {
      ok: true,
      value: "queued",
      toolCalls: [{ index: 1, name: "controlled_read" }],
    });
    assert.deepEqual(second.calls, ["queued"]);
  },
);

test(
  "Code Mode keeps cancelled active capacity until physical host work drains",
  { timeout: 10_000 },
  async (t) => {
    const current = fixture(new CodeCellAdmission());
    const controller = new AbortController();
    t.after(() => current.releaseHost.resolve());
    const active = current.run("held", controller.signal);
    const cancellation = assert.rejects(active, /stop active/);
    await current.started.promise;
    const waiting = current.run("queued");
    controller.abort(new Error("stop active"));
    await current.aborted.promise;
    assertFull(await current.run("overflow"));
    assert.deepEqual(current.calls, ["held"]);
    assert.equal(current.hostFinished, false);
    current.releaseHost.resolve();
    await cancellation;
    assert.equal((await waiting).ok, true);
    assert.equal(current.hostFinished, true);
    assert.deepEqual(current.calls, ["held", "queued"]);
  },
);

test(
  "Code Mode removes a cancelled waiter without starting it and reuses the queue slot",
  { timeout: 10_000 },
  async (t) => {
    const current = fixture(new CodeCellAdmission());
    const controller = new AbortController();
    t.after(() => current.releaseHost.resolve());
    const active = current.run("held");
    await current.started.promise;
    const waiting = current.run("cancelled", controller.signal);
    const cancellation = assert.rejects(waiting, /stop waiting/);
    controller.abort(new Error("stop waiting"));
    await cancellation;
    const replacement = current.run("replacement");
    assertFull(await current.run("overflow"));
    assert.deepEqual(current.calls, ["held"]);
    current.releaseHost.resolve();
    assert.equal((await active).ok, true);
    assert.equal((await replacement).ok, true);
    assert.deepEqual(current.calls, ["held", "replacement"]);
    assert.equal((await current.run("after-release")).ok, true);
  },
);
