import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import { McpConnectionManager } from "../../src/mcp/manager.js";
import { TaskHostRuntime } from "../../src/tasks/task-runtime.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

const exec = promisify(execFile);

describe("stage 13 task and MCP host integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("persists, steers and merges a worktree task while MCP survives registry switches", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-stage13-"));
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    await git(["init", "-b", "main", repo], root);
    await git(["config", "user.name", "Pico Integration"], repo);
    await git(["config", "user.email", "pico@example.test"], repo);
    await writeFile(join(repo, ".gitignore"), ".claw/\n.worktrees/\n", "utf8");
    await writeFile(join(repo, "README.md"), "stage 13\n", "utf8");
    await git(["add", "."], repo);
    await git(["commit", "-m", "initial"], repo);
    await git(["init", "--bare", remote], root);
    await git(["remote", "add", "origin", remote], repo);
    await git(["push", "-u", "origin", "main"], repo);

    const taskRuntime = await TaskHostRuntime.create({ workDir: repo });
    const gate = deferred();
    const started = taskRuntime.start(
      { description: "add worker result", branchSlug: "integration" },
      async (context) => {
        await gate.promise;
        const messages = context.drainMessages();
        await writeFile(join(context.worktreePath, "worker.txt"), messages.join("\n"), "utf8");
        context.appendOutput(`received: ${messages.join(", ")}`);
        return { summary: "worker changes ready" };
      },
    );
    taskRuntime.sendMessage(started.taskId, "include host feedback");
    gate.resolve();

    const completed = await taskRuntime.supervisor.wait(started.taskId);
    expect(completed).toMatchObject({ status: "completed", dirty: false });
    expect(taskRuntime.tail(started.taskId)).toContain("include host feedback");
    await taskRuntime.merge(started.taskId);
    await taskRuntime.mergeQueue.waitForIdle();
    expect(taskRuntime.mergeQueue.get(started.taskId)?.status).toBe("merged");
    await taskRuntime.cleanupMerged(started.taskId);
    expect(await readFile(join(repo, "worker.txt"), "utf8")).toBe("include host feedback");

    const runnerEntered = deferred();
    const stoppable = taskRuntime.start(
      { description: "verify physical stop", branchSlug: "stoppable" },
      async (context) => {
        runnerEntered.resolve();
        await new Promise<void>((resolveStop) => {
          context.signal.addEventListener(
            "abort",
            () => setTimeout(resolveStop, 25),
            { once: true },
          );
        });
      },
    );
    await runnerEntered.promise;
    const stopPromise = taskRuntime.stop(stoppable.taskId);
    expect(taskRuntime.supervisor.get(stoppable.taskId)?.status).toBe("stopping");
    await expect(stopPromise).resolves.toMatchObject({ status: "stopped" });

    const { url, close } = await startMcpServer();
    cleanups.push(close);
    const mcpConfig = join(root, "mcp.json");
    await writeFile(
      mcpConfig,
      JSON.stringify({ mcpServers: { demo: { transport: "http", url } } }),
      "utf8",
    );
    const firstRegistry = new ToolRegistry();
    const manager = new McpConnectionManager(firstRegistry, {
      stdioCwd: repo,
      oauthHandler: async () => ({ headers: { Authorization: "Bearer stage13" } }),
    });
    cleanups.push(() => manager.closeAll());
    await manager.loadConfig(mcpConfig);
    await manager.connectAll();
    expect(manager.getStatusSnapshot().summary.needsAuth).toBe(1);
    await manager.authenticate("demo");
    expect(firstRegistry.getTool("mcp__demo__echo")).toBeDefined();
    expect(await manager.listResources("demo")).toEqual({
      resources: [{ uri: "pico://stage13", name: "Stage 13" }],
    });
    expect(await manager.readResource("demo", "pico://stage13")).toEqual({
      contents: [{ uri: "pico://stage13", text: "durable host" }],
    });
    expect(await manager.listPrompts("demo")).toEqual({
      prompts: [{ name: "review", description: "Review task" }],
    });
    expect(await manager.getPrompt("demo", "review", { focus: "merge" })).toMatchObject({
      description: "Review task",
      messages: [{ role: "user", content: { type: "text", text: "review merge" } }],
    });

    const secondRegistry = new ToolRegistry();
    manager.attachRegistry(secondRegistry);
    expect(firstRegistry.getTool("mcp__demo__echo")).toBeUndefined();
    expect(secondRegistry.getTool("mcp__demo__echo")).toBeDefined();
    await manager.disable("demo");
    expect(secondRegistry.getTool("mcp__demo__echo")).toBeUndefined();
    await manager.enable("demo");
    await manager.reconnect("demo");
    await manager.reload();
    expect(manager.getStatusSnapshot().summary.needsAuth).toBe(1);
    await manager.authenticate("demo");

    const commands = await createPicoCommandRegistry({
      workDir: repo,
      taskRuntime,
      mcpControl: manager,
      mcpStatus: () => manager.getStatusSnapshot(),
    });
    const tasksResult = await processUserInput("/tasks", { registry: commands });
    const mcpResult = await processUserInput("/mcp", { registry: commands });
    expect(tasksResult.type === "local-command" ? tasksResult.result.message : "").toContain(
      started.taskId,
    );
    expect(mcpResult.type === "local-command" ? mcpResult.result.message : "").toContain(
      "connected",
    );

    await taskRuntime.close();
    const restoredRuntime = await TaskHostRuntime.create({ workDir: repo });
    cleanups.push(() => restoredRuntime.close());
    expect(restoredRuntime.get(started.taskId)?.status).toBe("completed");
  });
});

async function git(args: string[], cwd: string): Promise<void> {
  await exec("git", args, { cwd });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function startMcpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    if (request.headers.authorization !== "Bearer stage13") {
      response.writeHead(401).end("authentication required");
      return;
    }
    if (body.id === undefined) {
      response.writeHead(204).end();
      return;
    }
    const result = mcpResult(body.method, body.params ?? {});
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP test server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function mcpResult(method: string, params: Record<string, unknown>): unknown {
  if (method === "initialize") {
    return {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "stage13", version: "1.0.0" },
    };
  }
  if (method === "tools/list") {
    return { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  }
  if (method === "resources/list") {
    return { resources: [{ uri: "pico://stage13", name: "Stage 13" }] };
  }
  if (method === "resources/read") {
    return { contents: [{ uri: params.uri, text: "durable host" }] };
  }
  if (method === "prompts/list") {
    return { prompts: [{ name: "review", description: "Review task" }] };
  }
  if (method === "prompts/get") {
    const args = params.arguments as Record<string, string> | undefined;
    return {
      description: "Review task",
      messages: [
        { role: "user", content: { type: "text", text: `review ${args?.focus ?? "task"}` } },
      ],
    };
  }
  return {};
}
