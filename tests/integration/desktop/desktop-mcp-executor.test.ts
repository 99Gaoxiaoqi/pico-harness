import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  DesktopMcpExecutor,
  type DesktopMcpExecutorOptions,
} from "../../../apps/desktop/src/main/desktop-mcp-executor.js";
import { DesktopMcpCallTool } from "../../../packages/pico-host/src/desktop-mcp-call-tool.js";
import type { McpClient, McpServerConfig } from "@pico/pico-host/mcp-client-types";
import { createSandboxPolicy } from "@pico/pico-host/process-sandbox";

const echoTool = { name: "echo", description: "echo", inputSchema: { type: "object" } };
const echoResult = { content: [{ type: "text", text: "ok" }], isError: false };

test("Desktop MCP 仅在用户级显式启用、工作区可信、发现真实工具且再次授权后调用", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pico-desktop-mcp-test-"));
  const events: string[] = [];
  let trusted = false;
  let revision = "v1";
  let desktopExecution = true;
  const options = fixtureOptions(workspace, {
    readConfig: () => ({
      config: {
        mcpServers: {
          echo: {
            name: "echo",
            transport: "stdio",
            command: "unused",
            desktopExecution,
          } as McpServerConfig & { desktopExecution: boolean },
        },
      },
      revision,
    }),
    isTrusted: () => trusted,
    authorize: async (phase) => {
      events.push(phase);
      return true;
    },
    clientFactory: () => fakeClient(events),
  });
  const executor = new DesktopMcpExecutor(options);
  try {
    await assert.rejects(
      executor.call({
        commandId: "c",
        sessionId: "s",
        authorityEpoch: "e1",
        workspacePath: workspace,
        server: "echo",
        tool: "echo",
        args: {},
      }),
      /尚未信任/,
    );
    assert.equal(events.length, 0);

    trusted = true;
    desktopExecution = false;
    await assert.rejects(
      executor.call({
        commandId: "c",
        sessionId: "s",
        authorityEpoch: "e1",
        workspacePath: workspace,
        server: "echo",
        tool: "echo",
        args: {},
      }),
      /未启用 Desktop/,
    );
    assert.equal(events.length, 0);

    desktopExecution = true;
    await assert.rejects(
      executor.call({
        commandId: "c",
        sessionId: "s",
        authorityEpoch: "e1",
        workspacePath: workspace,
        server: "echo",
        tool: "missing",
        args: {},
      }),
      /未发现工具/,
    );
    assert.equal(events.includes("tool-call"), false);
    events.length = 0;

    assert.deepEqual(
      await executor.call({
        commandId: "c",
        sessionId: "s",
        authorityEpoch: "e1",
        workspacePath: workspace,
        server: "echo",
        tool: "echo",
        args: {},
      }),
      echoResult,
    );
    assert.equal(
      events.join(","),
      "server-connect,server-connect,connect,list,tool-call,call,close",
    );
    events.length = 0;

    const revoking = new DesktopMcpExecutor(
      fixtureOptions(workspace, {
        readConfig: () => ({
          config: {
            mcpServers: {
              echo: {
                name: "echo",
                transport: "stdio",
                command: "unused",
                desktopExecution: true,
              } as McpServerConfig & { desktopExecution: boolean },
            },
          },
          revision,
        }),
        isTrusted: () => trusted,
        authorize: async (phase) => {
          events.push(phase);
          return true;
        },
        clientFactory: () =>
          fakeClient(events, () => {
            revision = "v2";
          }),
      }),
    );
    await assert.rejects(
      revoking.call({
        commandId: "c",
        sessionId: "s",
        authorityEpoch: "e1",
        workspacePath: workspace,
        server: "echo",
        tool: "echo",
        args: {},
      }),
      /配置已变化/,
    );
    assert.equal(events.includes("call"), false);
    await revoking.close();
  } finally {
    await executor.close();
    await cleanupWorkspace(workspace);
  }
});

test("Desktop MCP 远程连接有独立网络准入，拒绝后不会构造客户端", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pico-desktop-mcp-network-"));
  let created = 0;
  const events: string[] = [];
  const executor = new DesktopMcpExecutor(
    fixtureOptions(workspace, {
      readConfig: () => ({
        config: {
          mcpServers: {
            remote: {
              name: "remote",
              transport: "http",
              url: "https://example.invalid/mcp",
              desktopExecution: true,
            } as McpServerConfig & { desktopExecution: boolean },
          },
        },
        revision: "v1",
      }),
      isTrusted: () => true,
      authorize: async (phase) => {
        events.push(phase);
        return phase !== "remote-network";
      },
      clientFactory: () => {
        created++;
        return fakeClient(events);
      },
    }),
  );
  try {
    await assert.rejects(
      executor.call({
        commandId: "c",
        sessionId: "s",
        authorityEpoch: "e1",
        workspacePath: workspace,
        server: "remote",
        tool: "echo",
        args: {},
      }),
      /未连接或未发现工具/,
    );
    assert.equal(created, 0);
    assert.equal(events.join(","), "server-connect,server-connect,remote-network");
  } finally {
    await executor.close();
    await cleanupWorkspace(workspace);
  }
});

test("desktop_mcp_call 固定工具校验输入，未知结果不能自动重试", async () => {
  const received: unknown[] = [];
  const tool = new DesktopMcpCallTool(async (input) => {
    received.push(input);
    return echoResult;
  });
  assert.equal(tool.name(), "desktop_mcp_call");
  assert.equal(tool.recoveryMode, "never_auto_retry");
  await assert.rejects(
    tool.execute('{"server":"x","tool":"y","args":[]}'),
    /args 必须是 JSON 对象/,
  );
  assert.deepEqual(
    JSON.parse(await tool.execute('{"server":"x","tool":"y","args":{"v":1}}')),
    echoResult,
  );
  assert.deepEqual(received, [{ server: "x", tool: "y", args: { v: 1 } }]);
});

function fixtureOptions(
  workspace: string,
  input: {
    readConfig: () => Promise<unknown> | unknown;
    isTrusted: () => boolean;
    authorize: (phase: string) => Promise<boolean>;
    clientFactory: () => McpClient;
  },
): DesktopMcpExecutorOptions {
  return {
    userConfigStore: { read: input.readConfig } as DesktopMcpExecutorOptions["userConfigStore"],
    isTrustedWorkspace: async () => input.isTrusted(),
    createSandboxPolicy: () =>
      createSandboxPolicy({
        profile: "read-only",
        workspaceRoots: [workspace],
        scratchRoot: join(tmpdir(), "pico-desktop-mcp-scratch", basename(workspace)),
        config: { network: "deny" },
      }),
    authorize: async (request) => input.authorize(request.phase),
    clientFactory: input.clientFactory,
  };
}

function fakeClient(events: string[], afterList?: () => void): McpClient {
  return {
    toolCancellationScope: "transport",
    connect: async () => {
      events.push("connect");
    },
    listTools: async () => {
      events.push("list");
      afterList?.();
      return [echoTool];
    },
    callTool: async () => {
      events.push("call");
      return echoResult;
    },
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
    listPrompts: async () => ({ prompts: [] }),
    getPrompt: async () => ({ messages: [] }),
    close: async () => {
      events.push("close");
    },
  };
}

async function cleanupWorkspace(workspace: string): Promise<void> {
  await Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(join(tmpdir(), "pico-desktop-mcp-scratch", basename(workspace)), {
      recursive: true,
      force: true,
    }),
  ]);
}
