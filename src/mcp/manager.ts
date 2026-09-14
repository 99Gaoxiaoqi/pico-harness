import { logger } from "../observability/logger.js";
import {
  McpConnectionManager as HostMcpConnectionManager,
  type McpConnectionManagerOptions,
} from "@pico/pico-host/mcp-connection-manager";
import type { ToolRegistry } from "@pico/pico-host/tool-registry";

export * from "@pico/pico-host/mcp-connection-manager";

/** @deprecated Use @pico/pico-host/mcp-connection-manager and inject diagnostics explicitly. */
export class McpConnectionManager extends HostMcpConnectionManager {
  constructor(registry?: ToolRegistry, options: McpConnectionManagerOptions = {}) {
    super(registry, { ...options, diagnostics: options.diagnostics ?? logger });
  }
}
