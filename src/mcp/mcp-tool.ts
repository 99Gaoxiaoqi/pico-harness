import { logger } from "../observability/logger.js";
import { McpToolBridge as HostMcpToolBridge } from "@pico/pico-host/mcp-tool";
import type { ToolExecutionContext } from "@pico/pico-host/tool-registry-contract";
import type { McpClient, McpTool } from "@pico/pico-host/mcp-client-types";

export * from "@pico/pico-host/mcp-tool";

/** @deprecated Use @pico/pico-host/mcp-tool and inject diagnostics explicitly. */
export class McpToolBridge extends HostMcpToolBridge {
  constructor(
    client: McpClient | (() => McpClient | undefined),
    serverName: string,
    tool: McpTool,
    authorizeCall?: (context?: ToolExecutionContext) => Promise<void>,
  ) {
    super(client, serverName, tool, authorizeCall, logger);
  }
}
