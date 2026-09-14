import { logger } from "../observability/logger.js";
import { HttpMcpClient as HostHttpMcpClient } from "@pico/pico-host/http-mcp-client";
import type { McpClientOptions, McpServerConfig } from "@pico/pico-host/mcp-client-types";

export * from "@pico/pico-host/http-mcp-client";

/** @deprecated Use @pico/pico-host/http-mcp-client and inject diagnostics explicitly. */
export class HttpMcpClient extends HostHttpMcpClient {
  constructor(config: McpServerConfig, options: McpClientOptions = {}) {
    super(config, { ...options, diagnostics: options.diagnostics ?? logger });
  }
}
