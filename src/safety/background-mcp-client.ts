import { resolve } from "node:path";
import { HttpMcpClient } from "../mcp/http-client.js";
import { StdioMcpClient } from "../mcp/stdio-client.js";
import type { McpClient, McpServerConfig } from "../mcp/types.js";
import {
  normalizeExactHostname,
  type ToolNetworkPolicy,
} from "./background-yolo-policy-schema.js";
import { buildSandboxSpawnPlan } from "./yolo-sandbox.js";

export function createBackgroundMcpClient(
  config: McpServerConfig,
  workspacePath: string,
  networkPolicy: ToolNetworkPolicy,
  allowedHosts: ReadonlySet<string>,
): McpClient {
  const secured = secureBackgroundMcpServerConfig(
    config,
    workspacePath,
    process.platform,
    networkPolicy,
    allowedHosts,
  );
  return secured.transport === "stdio" ? new StdioMcpClient(secured) : new HttpMcpClient(secured);
}

/**
 * Remote transports keep their protocol config. Stdio servers are always
 * wrapped in the same OS sandbox as background Bash and may not choose a cwd.
 */
export function secureBackgroundMcpServerConfig(
  config: McpServerConfig,
  workspacePath: string,
  platform: NodeJS.Platform = process.platform,
  networkPolicy: ToolNetworkPolicy = "allow",
  allowedHosts: ReadonlySet<string> = new Set(),
): McpServerConfig {
  if (config.transport !== "stdio") {
    assertRemoteMcpNetworkAllowed(config, networkPolicy, allowedHosts);
    return config;
  }
  if (!config.command) throw new Error(`MCP server "${config.name}" 缺少 command`);
  if (config.cwd !== undefined) {
    throw new Error(`后台 stdio MCP server "${config.name}" 不允许覆盖工作目录`);
  }
  const workspace = resolve(workspacePath);
  const plan = buildSandboxSpawnPlan({
    command: config.command,
    shell: config.command,
    shellArgs: config.args ?? [],
    cwd: workspace,
    writableRoots: [workspace],
    config: { network: networkPolicy === "allow" ? "allow" : "deny" },
    platform,
  });
  return {
    ...config,
    command: plan.command,
    args: plan.args,
    cwd: workspace,
  };
}

function assertRemoteMcpNetworkAllowed(
  config: McpServerConfig,
  networkPolicy: ToolNetworkPolicy,
  allowedHosts: ReadonlySet<string>,
): void {
  if (networkPolicy === "disabled") {
    throw new Error(`后台 MCP server "${config.name}" 被当前 Job 的网络策略禁止`);
  }
  if (networkPolicy !== "allowlist") return;
  if (!config.url) throw new Error(`MCP server "${config.name}" 缺少 url`);
  let hostname: string;
  try {
    hostname = normalizeExactHostname(new URL(config.url).hostname);
  } catch (error) {
    throw new Error(`后台 MCP server "${config.name}" 的 URL 无效`, { cause: error });
  }
  if (!allowedHosts.has(hostname)) {
    throw new Error(`后台 MCP server "${config.name}" 的主机 ${hostname} 不在网络 allowlist`);
  }
}
