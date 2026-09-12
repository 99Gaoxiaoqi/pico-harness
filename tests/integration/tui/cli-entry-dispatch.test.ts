import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli, type CliRuntime } from "../../../src/cli/main.js";
import type { ClientReplOptions } from "../../../src/tui/client-repl.js";
import type { CliStartupSession } from "../../../src/cli/session-args.js";

/**
 * 3-D Phase 4/5：CLI 入口分派。交互进程内路径已退役（Phase 5），TUI 唯一
 * 形态是 daemon 瘦客户端；会话旗标三式（-S/--continue/--fork）与 --graph
 * 传递到 ClientReplOptions；--local 已入 RETIRED_OPTIONS（明确报错）。
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
  let sessionSelection: CliStartupSession["sessionSelection"] = {
    mode: "new",
    sessionId: "console:x",
  };
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

test("cli dispatch: --local 已退役并给出明确诊断", async () => {
  const harness = harnessWithRuntime();
  assert.equal(await harness.run(["--local"]), 1, "--local 退役后是使用错误");
  assert.equal(harness.clientCalls.length, 0, "不触达任何 TUI");
  assert.ok(
    harness.stderr.some((line) => line.includes("--local")),
    "报错应点名 --local",
  );
});

test("cli dispatch: 已删除的兼容旗标按未知参数拒绝", async () => {
  for (const [option, args] of [
    ["--client", ["--client"]],
    ["--provider", ["--provider", "claude"]],
    ["--mcp-config", ["--mcp-config", "mcp.json"]],
    ["--add-dir", ["--add-dir", "D:\\extra"]],
    ["--fork-session", ["--fork-session", "source"]],
  ] as const) {
    const harness = harnessWithRuntime();
    assert.equal(await harness.run([...args]), 1, `${option} 应被拒绝`);
    assert.equal(harness.clientCalls.length, 0, `${option} 不应启动 TUI`);
    assert.match(harness.stderr.join(""), new RegExp(`未知启动参数: ${option}`, "u"));
  }
});

test("cli dispatch: 会话旗标三式传递（-S resume / --continue / --fork）", async () => {
  const harness = harnessWithRuntime();
  harness.setSessionSelection({ mode: "resume", sessionId: "s9" });
  await harness.run([]);
  assert.equal(harness.clientCalls.at(-1)!.sessionId, "s9");

  harness.setSessionSelection({ mode: "continue", sessionId: "latest" });
  await harness.run([]);
  assert.equal(
    harness.clientCalls.at(-1)!.sessionId,
    "latest",
    "--continue 解析出的 sessionId 直接采纳",
  );

  harness.setSessionSelection({ mode: "fork", sessionId: "src1" });
  await harness.run([]);
  assert.equal(
    harness.clientCalls.at(-1)!.forkFrom,
    "src1",
    "--fork 传 forkFrom（连接后 session.fork）",
  );
  assert.equal(
    harness.clientCalls.at(-1)!.sessionId,
    undefined,
    "fork 启动不带原会话（新会话 fork）",
  );
});

test("cli dispatch: BYOK/Graph 旗标传递", async () => {
  const harness = harnessWithRuntime();
  await harness.run(["--model", "p1/m1", "--thinking", "high", "--graph"]);
  const call = harness.clientCalls.at(-1)!;
  assert.equal(call.model, "p1/m1");
  assert.equal(call.thinkingEffort, "high");
  assert.equal(call.graphMode, true);
});

test("cli dispatch: --thinking 拒绝旧布尔值与未知档位", async () => {
  for (const value of ["true", "false", "turbo"]) {
    const harness = harnessWithRuntime();
    assert.equal(await harness.run(["--thinking", value]), 1);
    assert.equal(harness.clientCalls.length, 0);
    assert.match(harness.stderr.join(""), /--thinking 只接受 off、low、medium 或 high/u);
  }
});

test("cli dispatch: help/version 快速路径不起 TUI", async () => {
  const harness = harnessWithRuntime();
  assert.equal(await harness.run(["--help"]), 0);
  const help = harness.stdout.join("");
  assert.ok(!help.includes("--local"), "help 不再列出 --local");
  for (const removed of ["--client", "--provider", "--mcp-config", "--add-dir", "--fork-session"]) {
    assert.ok(!help.includes(removed), `help 不应列出已删除的 ${removed}`);
  }
  assert.equal(harness.clientCalls.length, 0);
  assert.equal(await harness.run(["--version"]), 0);
  assert.equal(harness.clientCalls.length, 0);
});
