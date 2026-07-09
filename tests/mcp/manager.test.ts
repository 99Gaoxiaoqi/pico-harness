// MCP 客户端模块测试。
//
// 覆盖:
//   1. StdioMcpClient: connect → listTools → callTool 完整流程
//   2. 工具名限定: mcp__<server>__<tool>
//   3. McpConnectionManager: 并行连接 + 工具自动注册到 Registry
//   4. per-server 失败隔离: 一个 server 崩溃不影响其他
//   5. 配置加载: 从 JSON 文件加载 + 字段校验
//   6. McpToolBridge: BaseTool 适配(execute 转发 + 错误处理)
//
// Mock server: tests/mcp/fixtures/mock-stdio-server.mjs(一个最小合规的 MCP stdio server)

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry-impl.js";
import { StdioMcpClient } from "../../src/mcp/stdio-client.js";
import { HttpMcpClient } from "../../src/mcp/http-client.js";
import { McpToolBridge } from "../../src/mcp/mcp-tool.js";
import { McpConnectionManager } from "../../src/mcp/manager.js";
import {
  isMcpToolName,
  qualifyMcpToolName,
  type McpServerConfig,
} from "../../src/mcp/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = resolve(__dirname, "fixtures", "mock-stdio-server.mjs");

function stdioConfig(name: string, args: string[] = []): McpServerConfig {
  return {
    name,
    command: process.execPath,
    args: [MOCK_SERVER, ...args],
    transport: "stdio",
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1000,
  intervalMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

describe("StdioMcpClient stdio 通信", () => {
  let client: StdioMcpClient;

  afterEach(async () => {
    if (client) await client.close().catch(() => {});
  });

  it("connect → listTools → callTool 完整流程", async () => {
    client = new StdioMcpClient(stdioConfig("test", ["--tools", "2"]));
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("echo");
    expect(tools[0]!.description).toBe("原样回显输入参数");

    const result = await client.callTool("echo", { message: "hello" });
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain("hello");
  });

  it("调用不存在的工具返回 isError", async () => {
    client = new StdioMcpClient(stdioConfig("test"));
    await client.connect();
    const result = await client.callTool("ghost", {});
    expect(result.isError).toBe(true);
  });

  it("连接失败时 connect 抛异常(子进程启动即退出)", async () => {
    client = new StdioMcpClient(stdioConfig("crash", ["--fail-startup"]));
    await expect(client.connect()).rejects.toThrow();
  });

  it("close 后可安全重复调用", async () => {
    client = new StdioMcpClient(stdioConfig("test"));
    await client.connect();
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("close 会兜底杀掉忽略 SIGTERM 的子进程", async () => {
    const pidFile = join(await mkdtemp(join(tmpdir(), "pico-mcp-pid-")), "server.pid");
    client = new StdioMcpClient(
      stdioConfig("stubborn", ["--ignore-sigterm", "--pid-file", pidFile]),
    );
    let pid: number | undefined;

    try {
      await client.connect();
      pid = Number(await readFile(pidFile, "utf8"));

      await client.close();

      const exited = await waitUntil(() => !isProcessAlive(pid!));
      expect(exited).toBe(true);
    } finally {
      if (pid !== undefined && isProcessAlive(pid)) {
        process.kill(pid, "SIGKILL");
        await waitUntil(() => !isProcessAlive(pid), 500);
      }
    }
  });

  it("stderr 快照捕获子进程诊断输出", async () => {
    client = new StdioMcpClient(stdioConfig("test"));
    await client.connect();
    // mock server 不主动写 stderr,快照为空字符串
    expect(client.stderrSnapshot()).toBe("");
  });
});

describe("工具名限定 qualifyMcpToolName", () => {
  it("生成 mcp__<server>__<tool> 格式", () => {
    expect(qualifyMcpToolName("github", "create_issue")).toBe("mcp__github__create_issue");
  });

  it("特殊字符清洗为下划线", () => {
    expect(qualifyMcpToolName("my-server", "tool.name")).toBe("mcp__my-server__tool_name");
  });

  it("isMcpToolName 识别 MCP 工具", () => {
    expect(isMcpToolName("mcp__github__create_issue")).toBe(true);
    expect(isMcpToolName("bash")).toBe(false);
  });

  it("超长名字截断并附哈希后缀", () => {
    const longTool = "a".repeat(80);
    const qualified = qualifyMcpToolName("srv", longTool);
    expect(qualified.length).toBeLessThanOrEqual(64);
    expect(qualified.startsWith("mcp__srv__")).toBe(true);
    expect(qualified).toMatch(/_[0-9a-f]{8}$/);
  });

  it("连续下划线折叠,保证分隔符不歧义", () => {
    // server 含 __ 会被折叠,避免与分隔符混淆
    const qualified = qualifyMcpToolName("a__b", "c");
    expect(qualified).toBe("mcp__a_b__c");
    expect(isMcpToolName(qualified)).toBe(true);
  });
});

describe("McpConnectionManager 编排", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pico-mcp-"));
  });

  it("加载配置并并行连接所有 server", async () => {
    const configPath = join(tmpDir, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          alpha: stdioConfig("alpha", ["--tools", "1"]),
          beta: stdioConfig("beta", ["--tools", "3"]),
        },
      }),
    );

    const registry = new ToolRegistry({ truncateResults: false });
    const manager = new McpConnectionManager(registry);
    await manager.loadConfig(configPath);
    await manager.connectAll();

    const status = manager.getStatus();
    expect(status.get("alpha")?.status).toBe("connected");
    expect(status.get("alpha")?.toolCount).toBe(1);
    expect(status.get("alpha")?.toolNames).toEqual(["echo"]);
    expect(status.get("beta")?.status).toBe("connected");
    expect(status.get("beta")?.toolCount).toBe(3);
    expect(status.get("beta")?.toolNames).toEqual(["echo", "tool_1", "tool_2"]);
    expect(manager.getConnectedCount()).toBe(2);

    await manager.closeAll();
  });

  it("closeAll 后保留 server 条目并把已连接状态重置为 pending", async () => {
    const configPath = join(tmpDir, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          alpha: stdioConfig("alpha", ["--tools", "1"]),
        },
      }),
    );

    const registry = new ToolRegistry({ truncateResults: false });
    const manager = new McpConnectionManager(registry);
    await manager.loadConfig(configPath);
    await manager.connectAll();
    expect(manager.getStatus().get("alpha")?.status).toBe("connected");

    await manager.closeAll();

    const status = manager.getStatus().get("alpha");
    expect(status).toMatchObject({
      status: "pending",
      toolCount: 0,
      toolNames: [],
    });
    expect(manager.getConnectedCount()).toBe(0);
    expect(manager.getStatusSnapshot().summary).toMatchObject({
      total: 1,
      connected: 0,
      pending: 1,
      toolCount: 0,
    });
  });

  it("自动注册工具到 Registry(名 mcp__<server>__<tool>)", async () => {
    const configPath = join(tmpDir, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          github: stdioConfig("github", ["--tools", "2"]),
        },
      }),
    );

    const registry = new ToolRegistry({ truncateResults: false });
    const manager = new McpConnectionManager(registry);
    await manager.loadConfig(configPath);
    await manager.connectAll();

    const toolDefs = registry.getAvailableTools();
    const mcpTools = toolDefs.filter((t) => t.name.startsWith("mcp__"));
    expect(mcpTools).toHaveLength(2);
    expect(mcpTools.map((t) => t.name)).toContain("mcp__github__echo");

    // 工具可正常执行
    const result = await registry.execute({
      id: "c1",
      name: "mcp__github__echo",
      arguments: '{"message":"hi"}',
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("hi");

    await manager.closeAll();
  });

  it("per-server 失败隔离:一个 server 崩溃不影响其他", async () => {
    const configPath = join(tmpDir, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          good: stdioConfig("good", ["--tools", "2"]),
          bad: stdioConfig("bad", ["--fail-startup"]),
        },
      }),
    );

    const registry = new ToolRegistry({ truncateResults: false });
    const manager = new McpConnectionManager(registry);
    await manager.loadConfig(configPath);
    await manager.connectAll();

    const status = manager.getStatus();
    expect(status.get("good")?.status).toBe("connected");
    expect(status.get("good")?.toolCount).toBe(2);
    expect(status.get("bad")?.status).toBe("failed");
    expect(status.get("bad")?.error).toBeTruthy();
    expect(status.get("bad")?.toolNames).toEqual([]);
    expect(manager.getConnectedCount()).toBe(1);

    // good 的工具仍可用
    const result = await registry.execute({
      id: "c1",
      name: "mcp__good__echo",
      arguments: '{"message":"ok"}',
    });
    expect(result.isError).toBe(false);

    await manager.closeAll();
  });

  it("enabled:false 的 server 标记为 disabled 不连接", async () => {
    const configPath = join(tmpDir, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          off: { ...stdioConfig("off"), enabled: false },
          on: stdioConfig("on", ["--tools", "1"]),
        },
      }),
    );

    const registry = new ToolRegistry({ truncateResults: false });
    const manager = new McpConnectionManager(registry);
    await manager.loadConfig(configPath);
    await manager.connectAll();

    expect(manager.getStatus().get("off")?.status).toBe("disabled");
    expect(manager.getStatus().get("on")?.status).toBe("connected");
    expect(manager.getConnectedCount()).toBe(1);

    await manager.closeAll();
  });

  it("配置文件不存在时静默跳过(不抛异常)", async () => {
    const registry = new ToolRegistry({ truncateResults: false });
    const manager = new McpConnectionManager(registry);
    const missingPath = join(tmpDir, "nonexistent.json");
    await manager.loadConfig(missingPath);
    expect(manager.getStatus().size).toBe(0);
    expect(manager.getStatusSnapshot()).toMatchObject({
      configPath: missingPath,
      loadError: expect.stringContaining("配置文件不存在"),
      servers: [],
    });
  });

  it("相对配置路径按 stdioCwd 解析", async () => {
    await writeFile(
      join(tmpDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: { ...stdioConfig("local"), enabled: false },
        },
      }),
    );

    const registry = new ToolRegistry({ truncateResults: false });
    const manager = new McpConnectionManager(registry, { stdioCwd: tmpDir });
    await manager.loadConfig("mcp.json");

    expect(manager.getStatusSnapshot().configPath).toBe(join(tmpDir, "mcp.json"));
  });

  it("状态快照展示 loaded config path 以及 stdio/http/sse transport", async () => {
    const configPath = join(tmpDir, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          local: { ...stdioConfig("local"), enabled: false },
          remoteHttp: {
            transport: "http",
            url: "https://mcp.example.test/rpc",
            enabled: false,
          },
          remoteSse: {
            transport: "sse",
            url: "https://mcp.example.test/sse",
            enabled: false,
          },
        },
      }),
    );

    const registry = new ToolRegistry({ truncateResults: false });
    const manager = new McpConnectionManager(registry);
    await manager.loadConfig(configPath);

    const snapshot = manager.getStatusSnapshot();
    expect(snapshot.configPath).toBe(configPath);
    expect(snapshot.summary).toMatchObject({
      total: 3,
      connected: 0,
      failed: 0,
      disabled: 3,
      pending: 0,
      toolCount: 0,
    });
    expect(snapshot.servers).toEqual([
      expect.objectContaining({ name: "local", transport: "stdio", status: "disabled" }),
      expect.objectContaining({ name: "remoteHttp", transport: "http", status: "disabled" }),
      expect.objectContaining({ name: "remoteSse", transport: "sse", status: "disabled" }),
    ]);
  });

  it("非法配置抛异常", async () => {
    const configPath = join(tmpDir, "bad.json");
    await writeFile(configPath, "not json {{{");

    const registry = new ToolRegistry({ truncateResults: false });
    const manager = new McpConnectionManager(registry);
    await expect(manager.loadConfig(configPath)).rejects.toThrow(/合法 JSON/);
  });

  it("stdio 模式缺 command 抛异常", async () => {
    const configPath = join(tmpDir, "no-command.json");
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { bad: { transport: "stdio" } } }),
    );

    const registry = new ToolRegistry({ truncateResults: false });
    const manager = new McpConnectionManager(registry);
    await expect(manager.loadConfig(configPath)).rejects.toThrow(/command/);
  });
});

describe("HttpMcpClient SSE 解析", () => {
  it("支持 CRLF 分隔的 text/event-stream 响应", async () => {
    const originalFetch = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push(body);
      if (body.id !== undefined) {
        const sse = `event: message\r\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "echo",
                      description: "echo",
                      inputSchema: { type: "object" },
                    },
                  ],
                }
              : {
                  protocolVersion: "2024-11-05",
                  capabilities: {},
                  serverInfo: { name: "http", version: "1" },
                },
        })}\r\n\r\n`;
        return new Response(sse, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const client = new HttpMcpClient({
        name: "http",
        transport: "http",
        url: "https://mcp.example.test/rpc",
        toolTimeoutMs: 500,
      });
      await client.connect();
      const tools = await client.listTools();

      expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
      expect(calls).toHaveLength(3);
      await client.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("McpToolBridge BaseTool 适配", () => {
  it("execute 转发到 MCP client 并返回文本", async () => {
    const client = new StdioMcpClient(stdioConfig("bridge", ["--tools", "1"]));
    await client.connect();
    const tools = await client.listTools();
    const bridge = new McpToolBridge(client, "bridge", tools[0]!);

    expect(bridge.name()).toBe("mcp__bridge__echo");
    expect(bridge.toolset).toBe("mcp");
    expect(bridge.definition().name).toBe("mcp__bridge__echo");
    expect(bridge.definition().inputSchema).toEqual(tools[0]!.inputSchema);

    const output = await bridge.execute('{"message":"ping"}');
    expect(output).toContain("ping");

    await client.close();
  });

  it("execute 遇到 isError 结果返回错误信息", async () => {
    const client = new StdioMcpClient(stdioConfig("bridge", ["--tools", "1"]));
    await client.connect();

    const failTool = {
      name: "fail_tool",
      description: "故意失败",
      inputSchema: { type: "object" },
    };
    const bridge = new McpToolBridge(client, "bridge", failTool);
    const output = await bridge.execute("{}");
    expect(output).toContain("返回错误");

    await client.close();
  });

  it("execute 参数非 JSON 时返回明确错误", async () => {
    const client = new StdioMcpClient(stdioConfig("bridge", ["--tools", "1"]));
    await client.connect();
    const tools = await client.listTools();
    const bridge = new McpToolBridge(client, "bridge", tools[0]!);
    const output = await bridge.execute("not json");
    expect(output).toContain("Error");

    await client.close();
  });

  it("accesses 返回 none(MCP 工具副作用不可静态分析)", async () => {
    const client = new StdioMcpClient(stdioConfig("bridge", ["--tools", "1"]));
    await client.connect();
    const tools = await client.listTools();
    const bridge = new McpToolBridge(client, "bridge", tools[0]!);
    expect(bridge.accesses("{}")).toHaveLength(0);
    await client.close();
  });

  it("description 附 server 来源标注", async () => {
    const client = new StdioMcpClient(stdioConfig("bridge", ["--tools", "1"]));
    await client.connect();
    const tools = await client.listTools();
    const bridge = new McpToolBridge(client, "bridge", tools[0]!);
    expect(bridge.definition().description).toContain("[MCP: bridge/echo]");
    await client.close();
  });
});
