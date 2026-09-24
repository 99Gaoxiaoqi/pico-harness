import { realpath, stat } from "node:fs/promises";
import { McpConnectionManager, type McpConnectionManagerOptions } from "@pico/pico-host/mcp-connection-manager";
import type { McpToolResult, McpServerConfig } from "@pico/pico-host/mcp-client-types";
import type { UserMcpConfigStore } from "@pico/pico-host/user-mcp-config-store";
import { isWithinRoot, type SandboxPolicy } from "@pico/pico-host/process-sandbox";

export interface DesktopMcpCallInput {
  readonly commandId: string;
  readonly sessionId: string;
  readonly authorityEpoch: string;
  readonly workspacePath: string;
  readonly server: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly toolCallId?: string;
  readonly signal?: AbortSignal;
}

export type DesktopMcpAuthorizationRequest = {
  readonly phase: "server-connect" | "tool-call" | "remote-network" | "stdio-network";
  readonly commandId: string;
  readonly sessionId: string;
  readonly authorityEpoch: string;
  readonly workspacePath: string;
  readonly server: string;
  readonly tool?: string;
  readonly transport: McpServerConfig["transport"];
};

export interface DesktopMcpExecutorOptions {
  /** The saved user-level MCP store. Project and Plugin definitions are never loaded here. */
  readonly userConfigStore: Pick<UserMcpConfigStore, "read">;
  /** Optional caller-owned narrowing of the saved desktopExecution allowlist. */
  readonly allowedServerNames?: () => ReadonlySet<string> | readonly string[];
  readonly isTrustedWorkspace: (canonicalWorkspacePath: string) => Promise<boolean>;
  /** Separate Desktop MCP process policy. It must remain read-only and sandboxed. */
  readonly createSandboxPolicy: (input: {
    readonly workspacePath: string;
    readonly server: string;
  }) => SandboxPolicy;
  /** Session capability admission, separate from Shell's network switch. */
  readonly authorize: (request: DesktopMcpAuthorizationRequest) => Promise<boolean>;
  /** Only for deterministic connector tests; production uses the real transport. */
  readonly clientFactory?: McpConnectionManagerOptions["clientFactory"];
}

/**
 * Electron-main Desktop MCP boundary. Connections are deliberately per call: no server process
 * survives a capability rollback, and the user-level config is re-read on every invocation.
 */
export class DesktopMcpExecutor {
  private readonly activeManagers = new Set<McpConnectionManager>();
  private closed = false;

  constructor(private readonly options: DesktopMcpExecutorOptions) {}

  async call(input: DesktopMcpCallInput): Promise<McpToolResult> {
    this.assertOpen(input.signal);
    const commandId = requireName(input.commandId, "commandId");
    const sessionId = requireName(input.sessionId, "sessionId");
    const authorityEpoch = requireName(input.authorityEpoch, "authorityEpoch");
    const server = requireName(input.server, "server");
    const tool = requireName(input.tool, "tool");
    if (!isRecord(input.args)) throw new Error("Desktop MCP args 必须是 JSON 对象");
    const workspacePath = await canonicalWorkspace(input.workspacePath);
    await this.requireTrust(workspacePath, input.signal);
    this.requireAllowedServer(server);

    const snapshot = await this.options.userConfigStore.read();
    const config = snapshot.config.mcpServers[server];
    if (!config || config.enabled === false || (config as McpServerConfig & { desktopExecution?: boolean }).desktopExecution !== true) {
      throw new Error(`Desktop MCP server "${server}" 未配置、未启用 Desktop 执行或已禁用`);
    }
    await this.requireAuthorization({
      phase: "server-connect", commandId, sessionId, authorityEpoch, workspacePath, server, transport: config.transport,
    }, input.signal);
    await this.requireTrust(workspacePath, input.signal);
    this.requireAllowedServer(server);

    const policy = this.options.createSandboxPolicy({ workspacePath, server });
    assertIsolatedPolicy(policy, workspacePath);
    if (config.transport === "stdio" && policy.network === "allow") {
      await this.requireAuthorization({
        phase: "stdio-network", commandId, sessionId, authorityEpoch, workspacePath, server, transport: config.transport,
      }, input.signal);
    }
    if (config.transport === "stdio" && config.cwd) {
      const cwd = await realpath(config.cwd);
      if (!policy.readRoots.some((root) => isWithinRoot(root, cwd))) {
        throw new Error(`Desktop MCP server "${server}" 的 cwd 超出独立沙箱读取范围`);
      }
    }

    const manager = new McpConnectionManager(undefined, {
      stdioCwd: workspacePath,
      processSandbox: policy,
      ...(this.options.clientFactory ? { clientFactory: this.options.clientFactory } : {}),
      remoteNetworkGate: async (request) => {
        await this.requireTrust(workspacePath, input.signal);
        this.requireAllowedServer(server);
        await this.requireAuthorization({
          phase: "remote-network", commandId, sessionId, authorityEpoch, workspacePath, server,
          transport: request.transport,
          ...(request.tool ? { tool: request.tool } : {}),
        }, input.signal);
        return true;
      },
    });
    this.activeManagers.add(manager);
    try {
      this.assertOpen(input.signal);
      await manager.replaceSources([{ id: "desktop-user", config: { mcpServers: { [server]: config } } }]);
      await this.requireTrust(workspacePath, input.signal);
      this.requireAllowedServer(server);
      await this.requireAuthorization({
        phase: "server-connect", commandId, sessionId, authorityEpoch, workspacePath, server, transport: config.transport,
      }, input.signal);
      const prestart = await this.options.userConfigStore.read();
      if (
        prestart.revision !== snapshot.revision ||
        (prestart.config.mcpServers[server] as McpServerConfig & { desktopExecution?: boolean } | undefined)?.desktopExecution !== true
      ) {
        throw new Error("Desktop MCP 用户级配置已变化，请重新发起操作");
      }
      this.assertOpen(input.signal);
      await manager.connectAll();
      this.assertOpen(input.signal);
      const status = manager.getStatus().get(server);
      if (status?.status !== "connected" || !status.toolNames.includes(tool)) {
        throw new Error(`Desktop MCP server "${server}" 未连接或未发现工具 "${tool}"`);
      }

      // A saved-definition edit, trust revocation or capability rollback during discovery
      // invalidates the pending call before the external tool can run.
      const current = await this.options.userConfigStore.read();
      if (
        current.revision !== snapshot.revision ||
        (current.config.mcpServers[server] as McpServerConfig & { desktopExecution?: boolean } | undefined)?.desktopExecution !== true
      ) {
        throw new Error("Desktop MCP 用户级配置已变化，请重新发起操作");
      }
      await this.requireTrust(workspacePath, input.signal);
      this.requireAllowedServer(server);
      await this.requireAuthorization({
        phase: "tool-call", commandId, sessionId, authorityEpoch, workspacePath, server, tool, transport: config.transport,
      }, input.signal);
      this.assertOpen(input.signal);
      return await manager.invokeConnectedTool(server, tool, input.args, {
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      });
    } finally {
      try {
        await manager.closeAll();
      } finally {
        this.activeManagers.delete(manager);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([...this.activeManagers].map((manager) => manager.closeAll()));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  private requireAllowedServer(server: string): void {
    const allowed = this.options.allowedServerNames?.();
    if (allowed && ![...allowed].includes(server)) {
      throw new Error(`Desktop MCP server "${server}" 未被显式启用`);
    }
  }

  private async requireTrust(workspacePath: string, signal?: AbortSignal): Promise<void> {
    this.assertOpen(signal);
    if (!(await this.options.isTrustedWorkspace(workspacePath))) {
      throw new Error(`Desktop MCP 工作区尚未信任: ${workspacePath}`);
    }
    this.assertOpen(signal);
  }

  private async requireAuthorization(
    request: DesktopMcpAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertOpen(signal);
    if ((await this.options.authorize(request)) !== true) {
      throw new Error(`Desktop MCP ${request.phase} 未获授权: ${request.server}${request.tool ? `/${request.tool}` : ""}`);
    }
    this.assertOpen(signal);
  }

  private assertOpen(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Desktop MCP 执行器已关闭");
  }
}

function assertIsolatedPolicy(policy: SandboxPolicy, workspacePath: string): void {
  if (policy.profile !== "read-only" || policy.writeFiles?.length) {
    throw new Error("Desktop MCP 需要独立的只读进程沙箱");
  }
  if (policy.writeRoots.some((root) => !isWithinRoot(policy.scratchRoot, root))) {
    throw new Error("Desktop MCP 进程沙箱不得获得工作区写权限");
  }
  if (policy.writeRoots.some((root) => isWithinRoot(workspacePath, root))) {
    throw new Error("Desktop MCP scratch 必须位于工作区之外");
  }
}

async function canonicalWorkspace(path: string): Promise<string> {
  if (!path || typeof path !== "string") throw new Error("Desktop MCP 缺少工作区路径");
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error("Desktop MCP 工作区路径不是目录");
  return canonical;
}

function requireName(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256) {
    throw new Error(`Desktop MCP ${field} 名称无效`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
