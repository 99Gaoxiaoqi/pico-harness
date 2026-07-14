import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRuntime } from "../src/runtime/session-runtime.js";

const captured = vi.hoisted(() => ({
  runtime: undefined as SessionRuntime | undefined,
  mcpCloseAttempted: false,
}));

vi.mock("../src/runtime/session-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/session-runtime.js")>();
  return {
    ...actual,
    async createSessionRuntime(...args: Parameters<typeof actual.createSessionRuntime>) {
      const runtime = await actual.createSessionRuntime(...args);
      captured.runtime = runtime;
      return runtime;
    },
  };
});

vi.mock("../src/mcp/manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mcp/manager.js")>();
  return {
    ...actual,
    McpConnectionManager: class extends actual.McpConnectionManager {
      override async loadConfig(): Promise<void> {
        throw new Error("MCP initialization failed");
      }

      override async closeAll(): Promise<void> {
        captured.mcpCloseAttempted = true;
        throw new Error("MCP cleanup failed");
      }
    },
  };
});

import { runAgentFromCli } from "../src/cli/run-agent.js";
import { globalSessionManager } from "../src/engine/session.js";
import type { LLMProvider } from "../src/provider/interface.js";

describe("AgentRuntime 初始化失败清理", () => {
  afterEach(() => {
    captured.runtime = undefined;
    captured.mcpCloseAttempted = false;
    globalSessionManager.clear();
  });

  it("MCP 配置加载失败时仍释放已创建的 SessionRuntime", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-runtime-cleanup-"));
    const configPath = join(workDir, "invalid-mcp.json");
    const provider: LLMProvider = {
      async generate() {
        throw new Error("MCP 失败前不应调用 Provider");
      },
    };

    await expect(
      runAgentFromCli(
        {
          prompt: "hello",
          dir: workDir,
          session: "mcp-init-cleanup",
          provider: "openai",
          mcpConfigPath: configPath,
        },
        { provider },
      ),
    ).rejects.toThrow("MCP initialization failed");

    expect(captured.mcpCloseAttempted).toBe(true);
    expect(captured.runtime).toBeDefined();
    const dispatch = captured.runtime!.delegationManager.dispatch(async () => ({
      summary: "should not run",
      results: [],
    }));
    expect(dispatch).toMatchObject({ status: "rejected", error: "委派运行时已关闭" });
  });
});
