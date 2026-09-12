import assert from "node:assert/strict";
import { test } from "node:test";

import { DefaultHookExecutor } from "../../../src/hooks/executors/index.js";
import type { HookHandler, HookInput, ResolvedHookHandler } from "../../../src/hooks/types.js";
import { McpConnectionManager, type McpRemoteNetworkRequest } from "../../../src/mcp/manager.js";
import type { McpClient } from "../../../src/mcp/types.js";
import { qualifyMcpToolName } from "../../../src/mcp/types.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";

test("remote MCP config alone cannot construct an HTTP/SSE client", async () => {
  for (const transport of ["http", "sse"] as const) {
    let factoryCalls = 0;
    const manager = new McpConnectionManager(undefined, {
      clientFactory: () => {
        factoryCalls++;
        return fakeMcpClient();
      },
    });
    await manager.replaceSources([
      {
        id: `remote-${transport}`,
        config: {
          mcpServers: {
            remote: {
              name: "remote",
              transport,
              url: `https://${transport}.invalid/mcp`,
            },
          },
        },
      },
    ]);

    await manager.connectAll();

    assert.equal(factoryCalls, 0, `${transport} client factory must stay behind the gate`);
    const status = manager.getStatusSnapshot().servers[0];
    assert.equal(status?.status, "failed");
    assert.match(status?.error ?? "", /缺少宿主显式授权/u);
    await manager.closeAll();
  }
});

test("remote MCP calls remain behind the host gate after discovery", async (context) => {
  const registry = new ToolRegistry();
  const requests: McpRemoteNetworkRequest[] = [];
  let allowCalls = false;
  let toolCalls = 0;
  let resourceCalls = 0;
  const client = fakeMcpClient({
    async callTool() {
      toolCalls++;
      return { content: [{ type: "text", text: "remote-ok" }], isError: false };
    },
    async listResources() {
      resourceCalls++;
      return { resources: [] };
    },
  });
  const manager = new McpConnectionManager(registry, {
    clientFactory: () => client,
    remoteNetworkGate(request) {
      requests.push(request);
      return request.operation === "initialize_and_list_tools" || allowCalls;
    },
  });
  context.after(() => manager.closeAll());
  await manager.replaceSources([
    {
      id: "remote",
      config: {
        mcpServers: {
          remote: {
            name: "remote",
            transport: "http",
            url: "https://remote.invalid/mcp",
          },
        },
      },
    },
  ]);
  await manager.connectAll();
  assert.equal(manager.getStatusSnapshot().servers[0]?.status, "connected");

  const denied = await registry.execute({
    id: "mcp-denied",
    name: qualifyMcpToolName("remote", "echo"),
    arguments: "{}",
  });
  assert.equal(denied.isError, true);
  assert.match(denied.output, /缺少宿主显式授权/u);
  assert.equal(toolCalls, 0);
  await assert.rejects(manager.listResources("remote"), /缺少宿主显式授权/u);
  assert.equal(resourceCalls, 0);
  await assert.rejects(manager.invokeConnectedTool("remote", "echo", {}), /缺少宿主显式授权/u);
  assert.equal(toolCalls, 0);

  allowCalls = true;
  const allowed = await registry.execute({
    id: "mcp-allowed",
    name: qualifyMcpToolName("remote", "echo"),
    arguments: "{}",
  });
  assert.equal(allowed.isError, false);
  assert.equal(allowed.output, "remote-ok");
  assert.equal(toolCalls, 1);
  assert.deepEqual(
    requests.map((request) => request.operation),
    ["initialize_and_list_tools", "tools/call", "resources/list", "tools/call", "tools/call"],
  );
  assert.deepEqual(
    requests
      .filter((request) => request.toolCallId !== undefined)
      .map((request) => request.toolCallId),
    ["mcp-denied", "mcp-allowed"],
  );
});

test("HTTP and MCP Hook handlers default to no Host network authority", async (context) => {
  let fetchCalls = 0;
  let mcpCalls = 0;
  const executor = new DefaultHookExecutor({
    workDir: "/workspace",
    async fetch() {
      fetchCalls++;
      return hookResponse("allow");
    },
    mcpInvoker: {
      async invokeConnectedTool() {
        mcpCalls++;
        return { content: [{ type: "text", text: '{"decision":"allow"}' }], isError: false };
      },
    },
  });
  context.after(() => executor.dispose());

  const httpResult = await executor.execute(
    resolvedHook({ type: "http", url: "https://hook.invalid/check" }, "http-hook"),
    hookInput(),
    {},
  );
  const mcpResult = await executor.execute(
    resolvedHook({ type: "mcp_tool", server: "remote", tool: "check" }, "mcp-hook"),
    hookInput(),
    {},
  );

  assert.equal(
    httpResult.decision,
    "allow",
    "handler denial keeps the existing fail-open contract",
  );
  assert.match(httpResult.diagnostics?.[0]?.message ?? "", /缺少宿主网络授权/u);
  assert.equal(mcpResult.decision, "allow");
  assert.match(mcpResult.diagnostics?.[0]?.message ?? "", /缺少宿主网络授权/u);
  assert.equal(fetchCalls, 0);
  assert.equal(mcpCalls, 0);
});

test("HTTP Hook rechecks Host authority before following a redirect", async (context) => {
  const gateUrls: string[] = [];
  let fetchCalls = 0;
  const executor = new DefaultHookExecutor({
    workDir: "/workspace",
    hostNetworkGate(request) {
      assert.equal(request.operation, "http_request");
      gateUrls.push(request.url);
      return request.redirect === 0;
    },
    async fetch() {
      fetchCalls++;
      return new Response(null, {
        status: 302,
        headers: { location: "https://redirect.invalid/check" },
      });
    },
  });
  context.after(() => executor.dispose());

  const result = await executor.execute(
    resolvedHook({ type: "http", url: "https://hook.invalid/check" }, "redirect-hook"),
    hookInput(),
    {},
  );

  assert.equal(result.decision, "allow");
  assert.match(result.diagnostics?.[0]?.message ?? "", /缺少宿主网络授权/u);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(gateUrls, ["https://hook.invalid/check", "https://redirect.invalid/check"]);
});

test("an explicitly admitted MCP Hook reaches its invoker", async (context) => {
  let mcpCalls = 0;
  const executor = new DefaultHookExecutor({
    workDir: "/workspace",
    mcpInvoker: {
      async invokeConnectedTool() {
        mcpCalls++;
        return {
          content: [{ type: "text", text: '{"decision":"deny","reason":"checked"}' }],
          isError: false,
        };
      },
    },
  });
  executor.bind({ hostNetworkGate: () => true });
  context.after(() => executor.dispose());

  const result = await executor.execute(
    resolvedHook({ type: "mcp_tool", server: "remote", tool: "check" }, "mcp-hook"),
    hookInput(),
    {},
  );

  assert.deepEqual(result, { decision: "deny", reason: "checked" });
  assert.equal(mcpCalls, 1);
});

function fakeMcpClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    toolCancellationScope: "transport",
    async connect() {},
    async listTools() {
      return [{ name: "echo", description: "echo", inputSchema: { type: "object" } }];
    },
    async callTool() {
      return { content: [], isError: false };
    },
    async listResources() {
      return { resources: [] };
    },
    async readResource() {
      return { contents: [] };
    },
    async listPrompts() {
      return { prompts: [] };
    },
    async getPrompt() {
      return { messages: [] };
    },
    async close() {},
    ...overrides,
  };
}

function resolvedHook(handler: HookHandler, id: string): ResolvedHookHandler {
  return {
    id,
    event: "PreToolUse",
    source: { kind: "project", path: "/workspace/.pico/hooks.json", version: 1 },
    order: 0,
    handler,
    trusted: true,
  };
}

function hookInput(): HookInput<"PreToolUse"> {
  return {
    session_id: "host-network-gate",
    cwd: "/workspace",
    hook_event_name: "PreToolUse",
    payload: { tool_name: "read_file", tool_input: { path: "README.md" } },
  };
}

function hookResponse(decision: "allow" | "deny"): Response {
  return new Response(JSON.stringify({ decision }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
