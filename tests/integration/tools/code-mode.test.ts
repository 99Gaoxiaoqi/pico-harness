import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import {
  DEFAULT_CODE_MODE_EXECUTION_POLICY,
  executeCodeCell,
  type CodeModeToolDefinition,
} from "../../../src/tools/code-mode.js";

const activeTools: readonly CodeModeToolDefinition[] = [
  { name: "read", nesting: "nestable" },
  { name: "ask_user", nesting: "direct_only" },
  { name: "exec", nesting: "nestable" },
];

test("Code Mode: real QuickJS aggregates parallel calls and has no ambient host capabilities", async () => {
  const calls: unknown[] = [];
  let inFlight = 0;
  let peak = 0;
  const result = await executeCodeCell({
    code: `
      const values = await Promise.all([1, 2, 3].map(id => tools.read({ id })));
      return {
        total: values.reduce((sum, row) => sum + row.value, 0),
        ambient: [typeof process, typeof require, typeof fetch, typeof WebSocket,
          typeof setTimeout, typeof eval],
      };
    `,
    tools: activeTools,
    callTool: async (name, args, signal) => {
      assert.equal(name, "read");
      assert.equal(signal.aborted, false);
      calls.push(args);
      peak = Math.max(peak, ++inFlight);
      await nextTurn();
      inFlight--;
      return { value: (args as { id: number }).id * 10 };
    },
  });
  assert.deepEqual(result, {
    ok: true,
    value: { total: 60, ambient: Array(6).fill("undefined") },
    toolCalls: [1, 2, 3].map((index) => ({ index, name: "read" })),
  });
  assert.equal(calls.length, 3);
  assert.ok(peak > 1, "independent child operations overlap");
});

test("Code Mode: snapshot access and bounded sandbox failure paths", async (t) => {
  await t.test("unexposed, direct-only and recursive tools never reach the host", async () => {
    for (const name of ["inactive", "ask_user", "exec"]) {
      const result = await executeCodeCell({
        code: `return await tools.${name}({});`,
        tools: activeTools,
        callTool: async () => assert.fail("unauthorized dispatch"),
      });
      assert.equal(result.ok, false);
      assert.deepEqual(result.toolCalls, []);
    }
    // QuickJS exposes a Function stub, but invoking it (including via constructor)
    // cannot generate code. Module loading is unavailable as well.
    for (const code of [
      'return Function("return process")();',
      'return (() => {}).constructor("return process")();',
      'return await import("node:fs");',
    ]) {
      const result = await executeCodeCell({
        code,
        tools: [],
        callTool: async () => assert.fail("ambient host access"),
      });
      assert.equal(result.ok, false, code);
    }
  });

  await t.test("source, result, tool input/output and bridge budgets are hard limits", async () => {
    const scenarios = [
      { code: "return 1;", policy: { maxSourceBytes: 1 } },
      { code: 'return "x".repeat(100);', policy: { maxResultBytes: 32 } },
      { code: 'return tools.read({value:"x".repeat(100)});', policy: { maxToolInputBytes: 32 } },
      { code: "return tools.read({});", policy: { maxToolOutputBytes: 32 } },
      {
        code: "await tools.read({}); return tools.read({});",
        policy: { maxBridgeRequests: 1 },
      },
      {
        code: "return Promise.all([tools.read({}), tools.read({})]);",
        policy: { maxInFlightBridgeRequests: 1 },
      },
      { code: "while (true) {}", policy: { timeoutMs: 50 } },
      {
        code: 'const rows=[]; while(true) rows.push("x".repeat(1024 * 1024));',
        policy: { memoryLimitBytes: 8 * 1024 * 1024 },
      },
      {
        code: "function f() { return f() + 1; } return f();",
        policy: { maxStackSizeBytes: 64 * 1024 },
      },
    ];
    for (const { code, policy } of scenarios) {
      const result = await executeCodeCell({
        code,
        tools: activeTools,
        executionPolicy: policy,
        callTool: async () => {
          await nextTurn();
          return "x".repeat(100);
        },
      });
      assert.equal(result.ok, false, code);
      if (!result.ok) assert.equal(result.error.kind, "limit_exceeded", JSON.stringify(result));
    }
    await assert.rejects(
      executeCodeCell({
        code: "return 1;",
        tools: [],
        callTool: async () => null,
        executionPolicy: {
          maxBridgeRequests: DEFAULT_CODE_MODE_EXECUTION_POLICY.maxBridgeRequests + 1,
        },
      }),
      RangeError,
    );
  });

  await t.test("cancel waits for physical child cleanup and never reruns the cell", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    let calls = 0;
    let settled = false;
    let childSignal: AbortSignal | undefined;
    const operation = executeCodeCell({
      code: "return tools.read({});",
      tools: activeTools,
      signal: controller.signal,
      callTool: async (_name, _args, signal) => {
        calls++;
        childSignal = signal;
        started.resolve();
        await cleanup.promise;
        return "cleaned";
      },
    });
    const rejection = assert.rejects(operation, /cancelled by test/);
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await started.promise;
    controller.abort(new Error("cancelled by test"));
    await nextTurn();
    assert.equal(childSignal?.aborted, true);
    assert.equal(settled, false);
    cleanup.resolve();
    await rejection;
    assert.equal(calls, 1);
  });

  await t.test("durable child failures escape even when generated code catches them", async () => {
    const fatal = new Error("T2 commit failed");
    await assert.rejects(
      executeCodeCell({
        code: 'try { await tools.read({}); } catch {} return "swallowed";',
        tools: activeTools,
        callTool: async () => {
          throw fatal;
        },
        isFatalToolError: (error) => error === fatal,
      }),
      (error) => error === fatal,
    );
  });

  await t.test(
    "deadline aborts and drains started child work before returning diagnostics",
    async () => {
      const aborted = Promise.withResolvers<void>();
      const cleanup = Promise.withResolvers<void>();
      let settled = false;
      const operation = executeCodeCell({
        code: "return tools.read({});",
        tools: activeTools,
        executionPolicy: { timeoutMs: 500 },
        callTool: async (_name, _args, signal) => {
          signal.addEventListener("abort", () => aborted.resolve(), { once: true });
          await cleanup.promise;
          return "cleaned";
        },
      });
      void operation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await aborted.promise;
      await nextTurn();
      assert.equal(settled, false);
      cleanup.resolve();
      const result = await operation;
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.kind, "limit_exceeded");
    },
  );
});
