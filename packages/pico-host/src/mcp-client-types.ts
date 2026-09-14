import type {
  McpElicitationHandler,
  McpPromptGetResult,
  McpPromptListResult,
  McpResourceListResult,
  McpResourceReadResult,
  McpTool,
  McpToolCancellationScope,
  McpToolResult,
} from "@pico/runtime-host/mcp-protocol";
import type { SandboxPolicy } from "./process-sandbox/index.js";
import type { ToolExecutionContext } from "./tool-registry-contract.js";

/** @deprecated MCP wire protocol types now live in @pico/runtime-host. */
export * from "@pico/runtime-host/mcp-protocol";
/** @deprecated MCP configuration types now live in @pico/pico-host. */
export type { McpConfig, McpServerConfig } from "./mcp-config.js";

/** Outer adapter options that bind generic MCP transport to Pico sandbox authority. */
export interface McpClientOptions {
  elicitationHandler?: McpElicitationHandler;
  processSandbox?: SandboxPolicy;
  diagnostics?: McpClientDiagnostics;
}

export interface McpClientDiagnostics {
  info(contextOrMessage: Readonly<Record<string, unknown>> | string, message?: string): void;
  warn(contextOrMessage: Readonly<Record<string, unknown>> | string, message?: string): void;
  error(contextOrMessage: Readonly<Record<string, unknown>> | string, message?: string): void;
  debug(contextOrMessage: Readonly<Record<string, unknown>> | string, message?: string): void;
}

export const NOOP_MCP_CLIENT_DIAGNOSTICS: McpClientDiagnostics = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * Transport-agnostic client interface. The outer adapter carries ToolRegistry's abort context;
 * the underlying wire data remains in @pico/runtime-host.
 */
export interface McpClient {
  readonly toolCancellationScope: McpToolCancellationScope;
  connect(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<McpToolResult>;
  listResources(cursor?: string): Promise<McpResourceListResult>;
  readResource(uri: string): Promise<McpResourceReadResult>;
  listPrompts(cursor?: string): Promise<McpPromptListResult>;
  getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptGetResult>;
  close(): Promise<void>;
  onClose?(handler: (err?: Error) => void): void;
  onError?(handler: (err: Error) => void): void;
}
