import assert from "node:assert/strict";
import { test } from "node:test";
import { McpConnectionManager } from "../../src/mcp/manager.js";
import {
  mcpToolNameMayBelongToServer,
  qualifyMcpToolName,
  type McpClient,
} from "../../src/mcp/types.js";
import type { BaseTool } from "../../src/tools/registry.js";
import { createToolRegistrationOwner, ToolRegistry } from "../../src/tools/registry-impl.js";

function fixtureTool(name: string): BaseTool {
  return {
    name: () => name,
    definition: () => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    }),
    async execute() {
      return "ok";
    },
  };
}

test("owned tool registrations reject overwrite and only their owner may remove them", () => {
  const registry = new ToolRegistry();
  const pluginOwner = createToolRegistrationOwner("plugin", "fixture@1");
  const otherOwner = createToolRegistrationOwner("mcp", "fixture");
  const pluginTool = fixtureTool("shared_tool");

  registry.registerOwned(pluginTool, pluginOwner);
  assert.throws(() => registry.register(fixtureTool("shared_tool")), /cannot be overwritten/u);
  assert.throws(() => registry.registerOwned(fixtureTool("shared_tool"), otherOwner), /conflicts/u);
  assert.equal(registry.unregister("shared_tool"), false);
  assert.strictEqual(registry.getTool("shared_tool"), pluginTool);
  assert.equal(registry.unregisterOwned("shared_tool", otherOwner), false);
  assert.strictEqual(registry.getTool("shared_tool"), pluginTool);
  assert.equal(registry.unregisterOwned("shared_tool", pluginOwner), true);
  assert.equal(registry.getTool("shared_tool"), undefined);
});

test("MCP foreground policy recognizes and fails closed across truncated server prefixes", () => {
  for (const serverLength of [48, 49, 50, 57, 58]) {
    const serverName = "s".repeat(serverLength);
    const qualified = qualifyMcpToolName(serverName, "echo-tool");
    assert.equal(qualified.length, 64);
    assert.equal(mcpToolNameMayBelongToServer(qualified, serverName), true);
  }
  assert.equal(mcpToolNameMayBelongToServer(qualifyMcpToolName("short", "echo"), "another"), false);

  const sharedHead = "s".repeat(50);
  assert.equal(
    mcpToolNameMayBelongToServer(
      qualifyMcpToolName(`${sharedHead}B`, "echo-tool"),
      `${sharedHead}A`,
    ),
    true,
    "source-less truncated names with an indistinguishable server prefix must fail closed",
  );
});

test("MCP source replacement validates the complete snapshot before discarding the old one", async () => {
  const manager = new McpConnectionManager();
  await manager.replaceSources([
    {
      id: "old",
      config: {
        mcpServers: {
          old: { name: "old", transport: "http", url: "http://old.invalid" },
        },
      },
    },
  ]);
  const before = manager.getStatusSnapshot();

  await assert.rejects(
    manager.replaceSources([
      {
        id: "new-ok",
        config: {
          mcpServers: {
            partial: { name: "partial", transport: "http", url: "http://partial.invalid" },
          },
        },
      },
      {
        id: "bad",
        config: {
          mcpServers: {
            partial: { name: "partial", transport: "http", url: "http://duplicate.invalid" },
          },
        },
      },
    ]),
  );

  assert.deepEqual(manager.getStatusSnapshot(), before);
});

test("MCP source replacement fails closed and clears stale tools when client close fails", async () => {
  const registry = new ToolRegistry();
  let closeFails = true;
  const client = {
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
    async close() {
      if (closeFails) throw new Error("fixture close failed");
    },
  } satisfies McpClient;
  const manager = new McpConnectionManager(registry, { clientFactory: () => client });
  const qualifiedName = qualifyMcpToolName("old", "echo");
  await manager.replaceSources([
    {
      id: "old-source",
      config: {
        mcpServers: {
          old: { name: "old", transport: "http", url: "http://old.invalid" },
        },
      },
    },
  ]);
  await manager.connectAll();
  assert.ok(registry.getTool(qualifiedName));

  await assert.rejects(
    manager.replaceSources([
      {
        id: "new-source",
        config: {
          mcpServers: {
            next: { name: "next", transport: "http", url: "http://next.invalid" },
          },
        },
      },
    ]),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some(
        (failure) => failure instanceof Error && failure.message === "fixture close failed",
      ),
  );
  const failed = manager.getStatusSnapshot();
  assert.deepEqual(failed.configSources, ["old-source"]);
  assert.equal(failed.servers[0]?.status, "failed");
  assert.equal(failed.servers[0]?.toolCount, 0);
  assert.deepEqual(failed.servers[0]?.toolNames, []);
  assert.equal(registry.getTool(qualifiedName), undefined);

  closeFails = false;
  await manager.closeAll();
});

test("MCP connection fails closed when a plugin owns the qualified tool name", async () => {
  const registry = new ToolRegistry();
  const qualifiedName = qualifyMcpToolName("fixture", "echo");
  const pluginTool = fixtureTool(qualifiedName);
  registry.registerOwned(pluginTool, createToolRegistrationOwner("plugin", "fixture@1"));
  const client = {
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
  } satisfies McpClient;
  const manager = new McpConnectionManager(registry, { clientFactory: () => client });
  try {
    await manager.replaceSources([
      {
        id: "fixture",
        config: {
          mcpServers: {
            fixture: {
              name: "fixture",
              transport: "http",
              url: "http://fixture.invalid",
            },
          },
        },
      },
    ]);
    await manager.connectAll();

    assert.equal(manager.getStatusSnapshot().servers[0]?.status, "failed");
    assert.strictEqual(registry.getTool(qualifiedName), pluginTool);
  } finally {
    await manager.closeAll();
  }
});

test("MCP registry switch preserves the previous bridge when the target conflicts", async () => {
  const firstRegistry = new ToolRegistry();
  const secondRegistry = new ToolRegistry();
  const qualifiedName = qualifyMcpToolName("fixture", "echo");
  const pluginTool = fixtureTool(qualifiedName);
  secondRegistry.registerOwned(pluginTool, createToolRegistrationOwner("plugin", "fixture@1"));
  const client = {
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
  } satisfies McpClient;
  const manager = new McpConnectionManager(firstRegistry, { clientFactory: () => client });
  try {
    await manager.replaceSources([
      {
        id: "fixture",
        config: {
          mcpServers: {
            fixture: {
              name: "fixture",
              transport: "http",
              url: "http://fixture.invalid",
            },
          },
        },
      },
    ]);
    await manager.connectAll();
    const originalBridge = firstRegistry.getTool(qualifiedName);
    assert.ok(originalBridge);

    assert.throws(() => manager.attachRegistry(secondRegistry), /conflicts/u);
    assert.strictEqual(firstRegistry.getTool(qualifiedName), originalBridge);
    assert.strictEqual(secondRegistry.getTool(qualifiedName), pluginTool);
    assert.equal(manager.getStatusSnapshot().servers[0]?.status, "connected");
  } finally {
    await manager.closeAll();
  }
  assert.equal(firstRegistry.getTool(qualifiedName), undefined);
  assert.strictEqual(secondRegistry.getTool(qualifiedName), pluginTool);
});
