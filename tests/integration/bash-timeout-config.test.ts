import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../../src/engine/session.js";
import { createSessionRuntime } from "../../src/runtime/session-runtime.js";
import {
  BashTool,
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_BASH_TIMEOUT_MS,
  MIN_BASH_TIMEOUT_MS,
  resolveBashTimeoutMs,
} from "../../src/tools/registry-impl.js";

test("Bash timeout keeps the 30s default and accepts bounded trusted overrides", () => {
  assert.equal(resolveBashTimeoutMs(), DEFAULT_BASH_TIMEOUT_MS);
  assert.equal(DEFAULT_BASH_TIMEOUT_MS, 30_000);
  assert.equal(resolveBashTimeoutMs(180_000), 180_000);
  assert.equal(resolveBashTimeoutMs(MIN_BASH_TIMEOUT_MS), MIN_BASH_TIMEOUT_MS);
  assert.equal(resolveBashTimeoutMs(MAX_BASH_TIMEOUT_MS), MAX_BASH_TIMEOUT_MS);
  assert.equal(MAX_BASH_TIMEOUT_MS, 900_000);
  assert.doesNotThrow(() => new BashTool(process.cwd(), undefined, { timeoutMs: 180_000 }));
});

test("Bash timeout rejects malformed and out-of-range trusted overrides", () => {
  for (const value of [
    MIN_BASH_TIMEOUT_MS - 1,
    MAX_BASH_TIMEOUT_MS + 1,
    1_000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "180000",
    null,
  ]) {
    assert.throws(
      () => resolveBashTimeoutMs(value),
      /bashTimeoutMs 必须是 1000\.\.900000 范围内的整数/u,
    );
  }
});

test(
  "Bash timeout override terminates a long-running foreground command",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-bash-timeout-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const tool = new BashTool(root, undefined, { timeoutMs: MIN_BASH_TIMEOUT_MS });

    const output = await tool.execute(
      JSON.stringify({
        command: "sleep 5",
      }),
    );

    assert.match(output, /命令执行超时\(1s\),已终止完整子进程树/u);
  },
);

test(
  "Bash abort immediately terminates a long-running foreground command",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-bash-abort-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const tool = new BashTool(root, undefined, { timeoutMs: 30_000 });
    const controller = new AbortController();
    const startedAt = Date.now();
    const execution = tool.execute(JSON.stringify({ command: "sleep 30" }), {
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(new DOMException("cancelled by Ctrl+C", "AbortError")), 100);

    await assert.rejects(execution, /cancelled by Ctrl\+C/u);
    assert.ok(Date.now() - startedAt < 3_000, "abort 应在 Bash 30s timeout 前快速收口");
  },
);

test(
  "SessionRuntime disposal stops owned background Bash tasks",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-background-dispose-"));
    const session = new Session("background-dispose", root, { persistence: false });
    const runtime = await createSessionRuntime({
      session,
      sessionLease: { session, release() {} },
      hooks: false,
      lspServers: [],
    });
    context.after(async () => {
      await runtime.dispose().catch(() => undefined);
      await session.close();
      await rm(root, { recursive: true, force: true });
    });

    const task = runtime.backgroundManager.start("sleep 30", root);
    assert.equal(task.status, "running");

    await runtime.dispose();

    assert.equal(runtime.backgroundManager.list()[0]?.status, "stopped");
  },
);
