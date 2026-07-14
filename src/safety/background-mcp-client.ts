import { resolve } from "node:path";
import { HttpMcpClient } from "../mcp/http-client.js";
import { StdioMcpClient } from "../mcp/stdio-client.js";
import type { McpClient, McpServerConfig } from "../mcp/types.js";
import { buildSandboxSpawnPlan } from "./yolo-sandbox.js";

export function createBackgroundMcpClient(
  config: McpServerConfig,
  workspacePath: string,
): McpClient {
  const secured = secureBackgroundMcpServerConfig(config, workspacePath);
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
): McpServerConfig {
  if (config.transport !== "stdio") return config;
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
    config: { network: "allow" },
    platform,
  });
  return {
    ...config,
    command: plan.command,
    args: plan.args,
    cwd: workspace,
  };
}
