/** @deprecated 后台 MCP 装配已归属 Pico Host；本入口只注入日志。 */
import { createBackgroundMcpClient as createHostClient } from "@pico/pico-host/background-mcp-client";
import { logger } from "../observability/logger.js";
export * from "@pico/pico-host/background-mcp-client";
export function createBackgroundMcpClient(...args: Parameters<typeof createHostClient>) {
  return createHostClient(args[0], args[1], args[2], args[3], args[4], args[5] ?? logger);
}
