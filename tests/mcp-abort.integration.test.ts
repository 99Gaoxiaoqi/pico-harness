import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/engine/loop.js";
import { SilentReporter } from "../src/engine/reporter.js";
import { Session } from "../src/engine/session.js";
import { HttpMcpClient } from "../src/mcp/http-client.js";
import { McpConnectionManager } from "../src/mcp/manager.js";
import { McpToolBridge } from "../src/mcp/mcp-tool.js";
import { StdioMcpClient } from "../src/mcp/stdio-client.js";
import type { McpClient } from "../src/mcp/types.js";
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

class RefusingCloseMcpClient implements McpClient {
  readonly toolCancellationScope = "process_tree" as const;
  closeCalls = 0;
  private closeHandler: ((err?: Error) => void) | undefined;

  async connect(): Promise<void> {}

  async listTools() {
    return [{ name: "write", description: "write", inputSchema: { type: "object" } }];
  }

  async callTool() {
    return { content: [], isError: false };
  }

  async listResources() {
    return { resources: [] };
  }

  async readResource() {
    return { contents: [] };
  }

  async listPrompts() {
    return { prompts: [] };
  }

  async getPrompt() {
    return { messages: [] };
  }

  onClose(handler: (err?: Error) => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.closeHandler?.(new Error("根进程 close 事件"));
    throw new Error("进程树未能物理收口");
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

      // POSIX 先 flush cancellation 再杀进程组；Windows 为避免根进程逃逸只做 best-effort 并行通知。
      if (process.platform !== "win32") expect(await pathExists(paths.cancelled)).toBe(true);
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
      await Promise.allSettled([manager.closeAll(), session.close()]);
      await Promise.allSettled([
        killPidFromFile(paths.workerPid),
        killPidFromFile(paths.serverPid),
      ]);
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("stdio server 关闭请求 pipe 后的 EPIPE 会安全收口并让 manager 进入 failed", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-mcp-stdin-error-"));
    const config = join(workDir, "mcp.json");
    const stdinClosed = join(workDir, "stdin-closed");
    const serverPid = join(workDir, "server.pid");
    const registry = new ToolRegistry();
    const manager = new McpConnectionManager(registry, { stdioCwd: workDir });

    try {
      await writeFile(
        config,
        JSON.stringify({
          mcpServers: {
            pipe: {
              transport: "stdio",
              command: process.execPath,
              args: [FIXTURE, "--stdin-closed-file", stdinClosed, "--server-pid-file", serverPid],
              toolTimeoutMs: 2_000,
            },
          },
        }),
      );
      await manager.loadConfig(config);
      await manager.connectAll();
      const toolName = "mcp__pipe__close_stdin";
      expect(manager.getStatus().get("pipe")?.status).toBe("connected");

      const first = await registry.execute({ id: "close-pipe", name: toolName, arguments: "{}" });
      expect(first.isError).toBe(false);
      await waitForFile(stdinClosed);

      const brokenWrite = await registry.execute({
        id: "write-after-close",
        name: toolName,
        arguments: JSON.stringify({ payload: "x".repeat(256 * 1024) }),
      });
      expect(brokenWrite).toMatchObject({ isError: true });
      expect(brokenWrite.output).toMatch(/stdin (?:错误|失败)|写入 stdin/u);
      await waitUntil(() => manager.getStatus().get("pipe")?.status === "failed");
      expect(manager.getStatus().get("pipe")?.error).toMatch(/stdin (?:错误|失败)|写入 stdin/u);
      expect(registry.getAvailableTools().some((tool) => tool.name.startsWith("mcp__"))).toBe(
        false,
      );
    } finally {
      await Promise.allSettled([manager.closeAll()]);
      await Promise.allSettled([killPidFromFile(serverPid)]);
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("HTTP close 共享同一收口 Promise，等待工具与非工具 transport 并拒绝新请求", async () => {
    const originalFetch = globalThis.fetch;
    const methods: string[] = [];
    const held = new Map<string, { id: number | string; resolve: (response: Response) => void }>();
    const client = new HttpMcpClient({
      name: "http-close",
      transport: "http",
      url: "https://mcp.example.test/rpc",
      toolTimeoutMs: 5_000,
    });

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const message = JSON.parse(String(init?.body ?? "{}")) as {
        id?: number | string;
        method?: string;
      };
      const method = message.method ?? "unknown";
      methods.push(method);
      if (method === "initialize") {
        return rpcResponse(message.id!, {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "http-close", version: "1" },
        });
      }
      if (method === "resources/list" || method === "tools/call") {
        return new Promise<Response>((resolveResponse) => {
          held.set(method, { id: message.id!, resolve: resolveResponse });
        });
      }
      return notificationResponse();
    }) as typeof fetch;

    try {
      await client.connect();
      const resources = client.listResources();
      const resourceOutcome = resources.catch((err: unknown) => err);
      const toolCall = client.callTool("write", {});
      const toolOutcome = toolCall.catch((err: unknown) => err);
      await waitUntil(() => held.size === 2);

      const closing = client.close();
      const concurrentClose = client.close();
      expect(concurrentClose).toBe(closing);
      let closeSettled = false;
      void closing.then(
        () => {
          closeSettled = true;
        },
        () => {
          closeSettled = true;
        },
      );

      const requestCountAfterClose = methods.length;
      await expect(client.listTools()).rejects.toThrow(/已关闭/);
      expect(methods).toHaveLength(requestCountAfterClose);
      await flushMicrotasks();
      expect(closeSettled).toBe(false);

      const heldResources = held.get("resources/list");
      const heldTool = held.get("tools/call");
      if (!heldResources || !heldTool) throw new Error("未捕获并发 HTTP 请求");
      heldTool.resolve(
        rpcResponse(heldTool.id, {
          content: [{ type: "text", text: "too late" }],
          isError: false,
        }),
      );
      await flushMicrotasks();
      expect(closeSettled).toBe(false);
      heldResources.resolve(rpcResponse(heldResources.id, { resources: [] }));

      await closing;
      expect(await resourceOutcome).toBeInstanceOf(Error);
      expect(await toolOutcome).toBeInstanceOf(Error);
      expect(client.close()).toBe(closing);
    } finally {
      for (const request of held.values()) request.resolve(rpcResponse(request.id, {}));
      await client.close().catch(() => {});
      globalThis.fetch = originalFetch;
    }
  });

  it("Registry/Bridge 显式 AbortSignal 等原 HTTP transport 与 cancellation POST 都 settle 后才拒绝", async () => {
    const originalFetch = globalThis.fetch;
    type HeldRequest = {
      id: number | string;
      signal?: AbortSignal;
      resolve: (response: Response) => void;
    };
    const originals = new Map<string, HeldRequest>();
    const cancellations = new Map<string, HeldRequest>();
    const requestCases = new Map<number | string, string>();
    let cleaningUp = false;
    const client = new HttpMcpClient({
      name: "abort-http",
      transport: "http",
      url: "https://mcp.example.test/rpc",
      toolTimeoutMs: 5_000,
    });
    const registry = new ToolRegistry();

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const message = JSON.parse(String(init?.body ?? "{}")) as {
        id?: number | string;
        method?: string;
        params?: {
          arguments?: { caseId?: string };
          requestId?: number | string;
        };
      };
      if (message.method === "initialize") {
        return rpcResponse(message.id!, {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "abort-http", version: "1" },
        });
      }
      if (message.method === "tools/list") {
        return rpcResponse(message.id!, {
          tools: [{ name: "write", description: "write", inputSchema: { type: "object" } }],
        });
      }
      if (message.method === "tools/call") {
        if (cleaningUp) {
          return rpcResponse(message.id!, { content: [], isError: false });
        }
        const caseId = message.params?.arguments?.caseId;
        if (!caseId || message.id === undefined) throw new Error("缺少 HTTP tool caseId/id");
        requestCases.set(message.id, caseId);
        return new Promise<Response>((resolveResponse) => {
          originals.set(caseId, {
            id: message.id!,
            ...(init?.signal ? { signal: init.signal } : {}),
            resolve: resolveResponse,
          });
        });
      }
      if (message.method === "notifications/cancelled") {
        if (cleaningUp) return notificationResponse();
        const requestId = message.params?.requestId;
        const caseId = requestId === undefined ? undefined : requestCases.get(requestId);
        if (!caseId || requestId === undefined) throw new Error("缺少 HTTP cancellation requestId");
        return new Promise<Response>((resolveResponse) => {
          cancellations.set(caseId, { id: requestId, resolve: resolveResponse });
        });
      }
      return notificationResponse();
    }) as typeof fetch;

    try {
      await client.connect();
      const [tool] = await client.listTools();
      if (!tool) throw new Error("HTTP MCP 未返回测试工具");
      const bridge = new McpToolBridge(client, "abort-http", tool);
      registry.register(bridge);
      expect(client.toolCancellationScope).toBe("transport");
      expect(registry.handlesAbortSignal(bridge.name())).toBe(false);

      const runScenario = async (
        caseId: string,
        releaseFirst: "original" | "cancellation",
      ): Promise<void> => {
        const controller = new AbortController();
        let settled = false;
        const execution = registry.execute(
          { id: `call-${caseId}`, name: bridge.name(), arguments: JSON.stringify({ caseId }) },
          { signal: controller.signal },
        );
        const outcome = execution.then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
        void outcome.then(() => {
          settled = true;
        });

        await waitUntil(() => originals.has(caseId));
        controller.abort(new DOMException(`abort-${caseId}`, "AbortError"));
        await waitUntil(() => cancellations.has(caseId));
        const original = originals.get(caseId);
        const cancellation = cancellations.get(caseId);
        if (!original || !cancellation) throw new Error("未捕获 HTTP abort 双 transport");
        expect(original.signal?.aborted).toBe(true);

        if (releaseFirst === "original") {
          original.resolve(rpcResponse(original.id, { content: [], isError: false }));
        } else {
          cancellation.resolve(notificationResponse());
        }
        await nextEventLoopTurn();
        expect(settled).toBe(false);

        if (releaseFirst === "original") {
          cancellation.resolve(notificationResponse());
        } else {
          original.resolve(rpcResponse(original.id, { content: [], isError: false }));
        }
        expect((await outcome).error).toMatchObject({ name: "AbortError" });
      };

      await runScenario("original-first", "original");
      await runScenario("cancellation-first", "cancellation");
    } finally {
      cleaningUp = true;
      for (const request of originals.values()) {
        request.resolve(rpcResponse(request.id, { content: [], isError: false }));
      }
      for (const request of cancellations.values()) request.resolve(notificationResponse());
      await client.close().catch(() => {});
      globalThis.fetch = originalFetch;
    }
  });

  it("legacy SSE close 等待已就绪的后台流真正结束", async () => {
    const originalFetch = globalThis.fetch;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamClosed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode("event: endpoint\ndata: /messages\n\n"));
      },
    });
    const client = new HttpMcpClient({
      name: "legacy-sse",
      transport: "sse",
      url: "https://mcp.example.test/events",
    });

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }
      const message = JSON.parse(String(init?.body ?? "{}")) as {
        id?: number | string;
        method?: string;
      };
      if (message.method === "initialize") {
        return rpcResponse(message.id!, {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "legacy-sse", version: "1" },
        });
      }
      return notificationResponse();
    }) as typeof fetch;

    try {
      await client.connect();
      const closing = client.close();
      expect(client.close()).toBe(closing);
      let closeSettled = false;
      void closing.then(
        () => {
          closeSettled = true;
        },
        () => {
          closeSettled = true;
        },
      );
      await flushMicrotasks();
      expect(closeSettled).toBe(false);

      streamController?.close();
      streamClosed = true;
      await closing;
    } finally {
      if (!streamClosed) streamController?.close();
      await client.close().catch(() => {});
      globalThis.fetch = originalFetch;
    }
  });

  it("legacy SSE 在 endpoint 就绪前 close 也会结束 connect", async () => {
    const originalFetch = globalThis.fetch;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamClosed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const client = new HttpMcpClient({
      name: "starting-sse",
      transport: "sse",
      url: "https://mcp.example.test/events",
    });
    globalThis.fetch = (async () =>
      new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      })) as typeof fetch;

    try {
      const connecting = client.connect();
      const connectionOutcome = connecting.catch((err: unknown) => err);
      await waitUntil(() => streamController !== undefined);
      const closing = client.close();

      streamController?.close();
      streamClosed = true;
      await closing;
      expect(await connectionOutcome).toBeInstanceOf(Error);
    } finally {
      if (!streamClosed) streamController?.close();
      await client.close().catch(() => {});
      globalThis.fetch = originalFetch;
    }
  });

  it("manager 关闭失败时保留旧 client 并拒绝 reconnect/enable/load 创建新实例", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-mcp-close-failure-"));
    const config = join(workDir, "mcp.json");
    const replacementConfig = join(workDir, "replacement.json");
    const clients: RefusingCloseMcpClient[] = [];
    const registry = new ToolRegistry();
    const manager = new McpConnectionManager(registry, {
      clientFactory: () => {
        const client = new RefusingCloseMcpClient();
        clients.push(client);
        return client;
      },
    });

    try {
      await writeFile(
        config,
        JSON.stringify({
          mcpServers: { stubborn: { transport: "stdio", command: "unused" } },
        }),
      );
      await writeFile(
        replacementConfig,
        JSON.stringify({
          mcpServers: { replacement: { transport: "stdio", command: "unused" } },
        }),
      );
      await manager.loadConfig(config);
      await manager.connectAll();
      expect(clients).toHaveLength(1);
      expect(manager.getStatus().get("stubborn")?.status).toBe("connected");

      await expect(manager.reconnect("stubborn")).rejects.toThrow(/物理收口/);
      expect(clients).toHaveLength(1);
      expect(manager.getStatus().get("stubborn")).toMatchObject({
        status: "failed",
        toolCount: 1,
        error: expect.stringMatching(/物理收口/),
      });
      expect(registry.getAvailableTools()).toHaveLength(0);

      await expect(manager.disable("stubborn")).rejects.toThrow(/物理收口/);
      await expect(manager.enable("stubborn")).rejects.toThrow(/物理收口/);
      expect(clients).toHaveLength(1);

      await expect(manager.loadConfig(replacementConfig)).rejects.toBeInstanceOf(AggregateError);
      expect(manager.getStatus().has("stubborn")).toBe(true);
      expect(manager.getStatus().has("replacement")).toBe(false);
      await expect(manager.closeAll()).rejects.toBeInstanceOf(AggregateError);
      expect(clients[0]?.closeCalls).toBe(5);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "Windows 根进程先退出且 taskkill 无法证明整树时，tools/call 保持 fail-closed",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "pico-mcp-windows-proof-"));
      const started = join(workDir, "started");
      const serverPidFile = join(workDir, "server.pid");
      const workerPidFile = join(workDir, "worker.pid");
      let workerPid: number | undefined;
      const client = new StdioMcpClient({
        name: "windows-proof",
        transport: "stdio",
        command: process.execPath,
        args: [
          FIXTURE,
          "--started-file",
          started,
          "--server-pid-file",
          serverPidFile,
          "--worker-pid-file",
          workerPidFile,
        ],
        toolTimeoutMs: 100,
      });

      try {
        await client.connect();
        expect(client.toolCancellationScope).toBe("transport");
        let settled = false;
        void client.callTool("exit_with_worker", {}).then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await waitForFile(started);
        await waitForFile(workerPidFile);
        workerPid = Number(await readFile(workerPidFile, "utf8"));
        const serverPid = Number(await readFile(serverPidFile, "utf8"));
        await waitUntil(() => !isProcessAlive(serverPid));
        await nextEventLoopTurn();

        expect(settled).toBe(false);
        expect(isProcessAlive(workerPid)).toBe(true);
      } finally {
        if (workerPid !== undefined && isProcessAlive(workerPid)) {
          process.kill(workerPid, "SIGKILL");
        }
        await client.close().catch(() => {});
        await rm(workDir, { recursive: true, force: true });
      }
    },
  );
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

async function killPidFromFile(path: string): Promise<void> {
  if (!(await pathExists(path))) return;
  const pid = Number(await readFile(path, "utf8"));
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 进程可能在读 PID 后、发信号前已退出。
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await delay(10);
  }
}

function rpcResponse(id: number | string, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "Content-Type": "application/json" },
  });
}

function notificationResponse(): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), {
    headers: { "Content-Type": "application/json" },
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolveTurn) => setImmediate(resolveTurn));
}
