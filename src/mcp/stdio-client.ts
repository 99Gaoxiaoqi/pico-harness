import { logger } from "../observability/logger.js";
import { StdioMcpClient as HostStdioMcpClient } from "@pico/pico-host/stdio-mcp-client";
import type { McpClientOptions, McpServerConfig } from "@pico/pico-host/mcp-client-types";

export * from "@pico/pico-host/stdio-mcp-client";

/** @deprecated Use @pico/pico-host/stdio-mcp-client and inject diagnostics explicitly. */
export class StdioMcpClient extends HostStdioMcpClient {
  constructor(config: McpServerConfig, options: McpClientOptions = {}) {
    super(config, { ...options, diagnostics: options.diagnostics ?? logger });
  }
}
