import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/engine/loop.js";
import { SilentReporter } from "../src/engine/reporter.js";
import { Session } from "../src/engine/session.js";
import { McpConnectionManager } from "../src/mcp/manager.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message } from "../src/schema/message.js";
import { ToolRegistry } from "../src/tools/registry-impl.js";

const FIXTURE = resolve("tests/mcp/fixtures/abort-stdio-server.mjs");

class RecordingReporter extends SilentReporter {
  readonly results: string[] = [];
  readonly output: string[] = [];

  override onToolResult(_name: string, result: string): void {
    this.results.push(result);
  }

  override onToolOutput(_name: string, _stream: "stdout" | "stderr", chunk: string): void {
    this.output.push(chunk);
  }
}

describe("MCP abort integration", () => {
  it("Ctrl+C 终止正在运行的 stdio 进程树，不启动排队调用也不产生延迟副作", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-mcp-abort-"));
    const paths = {
      config: join(workDir, "mcp.json"),
      started: join(workDir, "started"),
      cancelled: join(workDir, "cancelled"),
      queued: join(workDir, "queued"),
      late: join(workDir, "late"),
      serverPid: join(workDir, "server.pid"),
      workerPid: join(workDir, "worker.pid"),
    };
    const registry = new ToolRegistry();
    const manager = new McpConnectionManager(registry, { stdioCwd: workDir });
    const reporter = new RecordingReporter();
    const session = new Session(`mcp-abort-${Date.now()}`, workDir, { persistence: false });

    try {
      await writeFile(
        paths.config,
        JSON.stringify({
          mcpServers: {
            aborter: {
              transport: "stdio",
              command: process.execPath,
              args: [
                FIXTURE,
                "--started-file",
                paths.started,
                "--cancelled-file",
                paths.cancelled,
                "--queued-file",
                paths.queued,
                "--late-file",
                paths.late,
                "--server-pid-file",
                paths.serverPid,
                "--worker-pid-file",
                paths.workerPid,
              ],
              toolTimeoutMs: 5_000,
            },
          },
        }),
        "utf8",
      );
      await manager.loadConfig(paths.config);
      await manager.connectAll();
      expect(manager.getStatus().get("aborter")?.status).toBe("connected");

      let providerCalls = 0;
      const provider: LLMProvider = {
        async generate(): Promise<Message> {
          providerCalls++;
          return {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "hang-1", name: "mcp__aborter__hang", arguments: "{}" },
              { id: "queued-1", name: "mcp__aborter__queued", arguments: "{}" },
            ],
          };
        },
      };
      await session.commitMessages({ role: "user", content: "run both tools" });
      const controller = new AbortController();
      const running = new AgentEngine({ provider, registry, reporter, workDir }).run(
        session,
        undefined,
        undefined,
        controller.signal,
      );

      await waitForFile(paths.started);
      const interruptedAt = Date.now();
      controller.abort(new DOMException("Interrupted by integration test", "AbortError"));
      await expect(running).rejects.toMatchObject({ name: "AbortError" });
      expect(Date.now() - interruptedAt).toBeLessThan(2_000);

      expect(await pathExists(paths.cancelled)).toBe(true);
      expect(await pathExists(paths.queued)).toBe(false);
      expect(manager.getStatus().get("aborter")?.status).toBe("failed");
      expect(registry.getAvailableTools().some((tool) => tool.name.startsWith("mcp__"))).toBe(
        false,
      );
      expect(providerCalls).toBe(1);
      expect(reporter.output).toEqual([]);
      expect(reporter.results).toHaveLength(2);

      const serverPid = Number(await readFile(paths.serverPid, "utf8"));
      const workerPid = Number(await readFile(paths.workerPid, "utf8"));
      expect(isProcessAlive(serverPid)).toBe(false);
      expect(isProcessAlive(workerPid)).toBe(false);

      await delay(950);
      expect(await pathExists(paths.late)).toBe(false);
      expect(reporter.results.join("\n")).not.toContain("late-output");
      expect(
        session
          .getHistory()
          .map((message) => message.content)
          .join("\n"),
      ).not.toContain("late-output");
    } finally {
      await manager.closeAll();
      await session.close();
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await pathExists(path))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(10);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
