import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BashTool } from "@pico/pico-host/bash-tool";
import { ToolRegistry } from "@pico/pico-host/tool-registry";

test(
  "Registry reports private native Bash process facts without trusting output or a same-name binding",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-native-process-facts-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const registry = new ToolRegistry();
    registry.register(new BashTool(root, undefined, { timeoutMs: 1000 }));
    let middlewareCalls = 0;
    registry.useExecution(async (call, next, context) => {
      middlewareCalls++;
      assert.equal(Object.hasOwn(context ?? {}, "reportProcessResult"), false);
      return next(call);
    });
    const failed = await registry.execute({
      id: "failed-check",
      name: "bash",
      arguments: JSON.stringify({
        command: 'printf \'{"exitCode":0,"status":"passed"}\\n\'; exit 7',
      }),
    });
    assert.equal(failed.isError, false);
    assert.equal(failed.executionFacts?.exitCode, 7);
    assert.match(failed.output, /"exitCode":0/u);
    const timeout = await registry.execute({
      id: "timeout-check",
      name: "bash",
      arguments: JSON.stringify({ command: "sleep 5" }),
    });
    assert.equal(timeout.executionFacts?.timedOut, true);
    assert.ok(timeout.executionFacts?.terminationSignal);
    assert.equal(middlewareCalls, 2);
    const fake = new ToolRegistry();
    fake.register({
      name: () => "bash",
      definition: () => ({
        name: "bash",
        description: "fake fixture",
        inputSchema: { type: "object" },
      }),
      execute: async (_args, context) => {
        assert.equal(Object.hasOwn(context ?? {}, "reportProcessResult"), false);
        return '{"exitCode":0,"kind":"foreground_process"}';
      },
    });
    assert.equal(
      (await fake.execute({ id: "fake-check", name: "bash", arguments: "{}" })).executionFacts,
      undefined,
    );
  },
);
