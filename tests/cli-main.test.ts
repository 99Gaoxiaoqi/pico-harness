import { describe, expect, it, vi } from "vitest";
import type { CliStartupSession } from "../src/cli/session-args.js";
import { runCli, type CliRuntime } from "../src/cli/main.js";

function createRuntime(): {
  runtime: CliRuntime;
  stdout: string[];
  stderr: string[];
  primeTokenizer: ReturnType<typeof vi.fn>;
  startTuiRepl: ReturnType<typeof vi.fn>;
  resolveCliStartupSession: ReturnType<typeof vi.fn>;
  migrateLegacyWorkspace: ReturnType<typeof vi.fn>;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const primeTokenizer = vi.fn(async () => {});
  const resolveCliWorkDir = vi.fn(async () => "/workspace");
  const ensureWorkspaceTrusted = vi.fn(async () => {});
  const migrateLegacyWorkspace = vi.fn(async () => {});
  const startTuiRepl = vi.fn(async () => {});
  const startup: CliStartupSession = {
    workDir: "/workspace",
    sessionSelection: { mode: "new", sessionId: "cli-test" },
  };
  const resolveCliStartupSession = vi.fn(async () => startup);

  return {
    runtime: {
      env: {},
      version: "9.8.7",
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
      primeTokenizer,
      resolveCliWorkDir,
      ensureWorkspaceTrusted,
      migrateLegacyWorkspace,
      startTuiRepl,
      resolveCliStartupSession,
    },
    stdout,
    stderr,
    primeTokenizer,
    startTuiRepl,
    resolveCliStartupSession,
    migrateLegacyWorkspace,
  };
}

describe("pico CLI entry", () => {
  it("--help 无需 TTY 或模型初始化就能输出帮助", async () => {
    const fixture = createRuntime();

    await expect(runCli(["--help"], fixture.runtime)).resolves.toBe(0);

    expect(fixture.stdout.join("")).toContain("Usage: pico [options]");
    expect(fixture.stdout.join("")).toContain("--mcp-config <path>");
    expect(fixture.stdout.join("")).toContain("--continue");
    expect(fixture.stderr).toEqual([]);
    expect(fixture.primeTokenizer).not.toHaveBeenCalled();
    expect(fixture.resolveCliStartupSession).not.toHaveBeenCalled();
    expect(fixture.startTuiRepl).not.toHaveBeenCalled();
  });

  it("--version 无需 TTY 或模型初始化就能输出版本", async () => {
    const fixture = createRuntime();

    await expect(runCli(["--version"], fixture.runtime)).resolves.toBe(0);

    expect(fixture.stdout).toEqual(["9.8.7\n"]);
    expect(fixture.primeTokenizer).not.toHaveBeenCalled();
    expect(fixture.startTuiRepl).not.toHaveBeenCalled();
  });

  it("保留 TUI 启动参数并透传给会话解析和 TUI", async () => {
    const fixture = createRuntime();
    const args = [
      "--provider",
      "claude",
      "--thinking",
      "high",
      "--dir",
      "/workspace",
      "--model",
      "claude-test",
      "--mcp-config",
      "mcp.json",
      "--add-dir",
      "../shared-a",
      "--add-dir",
      "../shared-b",
      "--session",
      "saved-session",
    ];

    await expect(runCli(args, fixture.runtime)).resolves.toBe(0);

    expect(fixture.primeTokenizer).toHaveBeenCalledOnce();
    expect(fixture.migrateLegacyWorkspace).toHaveBeenCalledWith("/workspace");
    expect(fixture.resolveCliStartupSession).toHaveBeenCalledWith(args, {
      trustedWorkDir: "/workspace",
    });
    expect(fixture.startTuiRepl).toHaveBeenCalledWith({
      workDir: "/workspace",
      provider: "claude",
      model: "claude-test",
      modelExplicit: true,
      thinkingEffort: "high",
      sessionSelection: { mode: "new", sessionId: "cli-test" },
      mcpConfigPath: "mcp.json",
      addDirs: ["../shared-a", "../shared-b"],
    });
  });

  it.each(["--tui", "--prompt", "--serve", "--acp"])(
    "退役参数 %s 给出 TUI-only 迁移提示",
    async (option) => {
      const fixture = createRuntime();

      await expect(runCli([option], fixture.runtime)).resolves.toBe(1);

      expect(fixture.stderr.join("")).toContain(`启动参数 ${option} 已退役`);
      expect(fixture.stderr.join("")).toContain("Pico 现在只提供交互式 TUI 入口");
      expect(fixture.primeTokenizer).not.toHaveBeenCalled();
      expect(fixture.startTuiRepl).not.toHaveBeenCalled();
    },
  );

  it("未知参数输出参数名和 help 提示", async () => {
    const fixture = createRuntime();

    await expect(runCli(["--wat"], fixture.runtime)).resolves.toBe(1);

    expect(fixture.stderr.join("")).toContain("未知启动参数: --wat");
    expect(fixture.stderr.join("")).toContain("pico --help");
    expect(fixture.primeTokenizer).not.toHaveBeenCalled();
  });
});
