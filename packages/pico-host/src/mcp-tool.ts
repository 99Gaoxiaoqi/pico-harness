import {
  McpToolBridge as RuntimeHostMcpToolBridge,
  type McpToolBridgeLogger,
} from "@pico/runtime-host/mcp-tool-bridge";
import type { ToolExecutionContext } from "./tool-registry-contract.js";
import type { McpClient, McpTool } from "./mcp-client-types.js";

const NOOP_MCP_TOOL_LOGGER: McpToolBridgeLogger = { warn: () => undefined };

/** Pico Host adapter that binds the runtime-host MCP bridge to the full tool context. */
export class McpToolBridge extends RuntimeHostMcpToolBridge<ToolExecutionContext> {
  constructor(
    client: McpClient | (() => McpClient | undefined),
    serverName: string,
    tool: McpTool,
    authorizeCall?: (context?: ToolExecutionContext) => Promise<void>,
    diagnostics: McpToolBridgeLogger = NOOP_MCP_TOOL_LOGGER,
  ) {
    super(client, serverName, tool, authorizeCall, diagnostics);
  }
}
