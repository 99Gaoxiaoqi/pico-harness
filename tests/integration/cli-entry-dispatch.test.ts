import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli, type CliRuntime } from "../../src/cli/main.js";
import type { ClientReplOptions } from "../../src/tui/client-repl.js";
import type { CliStartupSession } from "../../src/cli/session-args.js";

/**
 * 3-D Phase 4/5：CLI 入口分派。交互进程内路径已退役（Phase 5），TUI 唯一
 * 形态是 daemon 瘦客户端；会话旗标三式（-S/--continue/--fork）与 --graph
 * 传递到 ClientReplOptions；缺口旗标（--mcp-config/--add-dir）显式提示不
 * 静默丢弃；--local 已入 RETIRED_OPTIONS（明确报错）。
 */

interface DispatchHarness {
  readonly stderr: string[];
  readonly stdout: string[];
  clientCalls: ClientReplOptions[];
  setSessionSelection(selection: CliStartupSession["sessionSelection"]): void;
  run(args: string[]): Promise<number>;
}

function harnessWithRuntime(): DispatchHarness {
  const stderr: string[] = [];
  const stdout: string[] = [];
  const clientCalls: ClientReplOptions[] = [];
  let sessionSelection: CliStartupSession["sessionSelection"] = { mode: "new", sessionId: "console:x" };
  const runtime: CliRuntime = {
    env: {},
    version: "test",
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
    primeTokenizer: async () => undefined,
    resolveCliWorkDir: async () => "C:\\ws",
    ensureWorkspaceTrusted: async () => undefined,
    resolveCliStartupSession: async () => ({ workDir: "C:\\ws", sessionSelection }),
    startClientRepl: async (options) => {
      clientCalls.push(options);
    },
  };
  return {
    stderr,
    stdout,
    clientCalls,
    setSessionSelection: (selection) => {
      sessionSelection = selection;
    },
    run: (args) => runCli(args, runtime),
  };
}

test("cli dispatch: 默认（无旗标）走客户端瘦 TUI", async () => {
  const harness = harnessWithRuntime();
  assert.equal(await harness.run([]), 0);
  assert.equal(harness.clientCalls.length, 1, "默认分派客户端");
  assert.equal(harness.clientCalls[0]!.workDir, "C:\\ws");
  assert.equal(harness.clientCalls[0]!.sessionId, undefined, "新会话不带 sessionId");
});

test("cli dispatch: --local 已退役明确报错；--client 兼容仍是客户端", async () => {
  const harness = harnessWithRuntime();
  assert.equal(await harness.run(["--local"]), 1, "--local 退役后是使用错误");
  assert.equal(harness.clientCalls.length, 0, "不触达任何 TUI");
  assert.ok(
    harness.stderr.some((line) => line.includes("--local")),
    "报错应点名 --local",
  );

  assert.equal(await harness.run(["--client"]), 0);
  assert.equal(harness.clientCalls.length, 1, "--client 兼容保留（已是默认）");
});

test("cli dispatch: 会话旗标三式传递（-S resume / --continue / --fork）", async () => {
  const harness = harnessWithRuntime();
  harness.setSessionSelection({ mode: "resume", sessionId: "s9" });
  await harness.run([]);
  assert.equal(harness.clientCalls.at(-1)!.sessionId, "s9");

  harness.setSessionSelection({ mode: "continue", sessionId: "latest" });
  await harness.run([]);
  assert.equal(harness.clientCalls.at(-1)!.sessionId, "latest", "--continue 解析出的 sessionId 直接采纳");

  harness.setSessionSelection({ mode: "fork", sessionId: "src1" });
  await harness.run([]);
  assert.equal(harness.clientCalls.at(-1)!.forkFrom, "src1", "--fork 传 forkFrom（连接后 session.fork）");
  assert.equal(harness.clientCalls.at(-1)!.sessionId, undefined, "fork 启动不带原会话（新会话 fork）");
});

test("cli dispatch: BYOK/Graph 旗标传递与缺口旗标提示", async () => {
  const harness = harnessWithRuntime();
  await harness.run(["--model", "p1/m1", "--thinking", "high", "--graph"]);
  const call = harness.clientCalls.at(-1)!;
  assert.equal(call.model, "p1/m1");
  assert.equal(call.thinkingEffort, "high");
  assert.equal(call.graphMode, true);

  await harness.run(["--mcp-config", "mcp.json", "--add-dir", "D:\\extra"]);
  assert.ok(
    harness.stderr.some((line) => line.includes("--mcp-config")),
    "缺口旗标显式提示（不静默丢弃）",
  );
  const mcpCall = harness.clientCalls.at(-1)!;
  assert.equal(mcpCall.graphMode, undefined);
});

test("cli dispatch: help/version 快速路径不起 TUI", async () => {
  const harness = harnessWithRuntime();
  assert.equal(await harness.run(["--help"]), 0);
  assert.ok(!harness.stdout.join("").includes("--local"), "help 不再列出 --local");
  assert.equal(harness.clientCalls.length, 0);
  assert.equal(await harness.run(["--version"]), 0);
  assert.equal(harness.clientCalls.length, 0);
});
