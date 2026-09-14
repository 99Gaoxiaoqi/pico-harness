export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpConnectionStatus = "pending" | "connected" | "failed" | "disabled" | "needs_auth";

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpResourceListResult {
  resources: McpResource[];
  nextCursor?: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  [key: string]: unknown;
}

export interface McpResourceReadResult {
  contents: McpResourceContents[];
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpPromptListResult {
  prompts: McpPrompt[];
  nextCursor?: string;
}

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: McpContentBlock;
}

export interface McpPromptGetResult {
  description?: string;
  messages: McpPromptMessage[];
}

export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  [key: string]: unknown;
}

export interface McpToolResult {
  content: McpContentBlock[];
  isError: boolean;
}

export interface McpElicitationRequest {
  mode?: "form";
  message: string;
  requestedSchema: Record<string, unknown>;
}

export interface McpElicitationResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface McpElicitationContext {
  server: string;
  signal: AbortSignal;
}

export type McpElicitationHandler = (
  request: McpElicitationRequest,
  context: McpElicitationContext,
) => Promise<McpElicitationResult>;

export type McpToolCancellationScope = "process_tree" | "transport";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_STREAMABLE_HTTP_PROTOCOL_VERSION = "2025-03-26";
export const MCP_ELICITATION_PROTOCOL_VERSION = "2025-06-18";

export const PICO_MCP_CLIENT_INFO = {
  name: "pico-harness",
  version: "0.1.0",
} as const;

export function assertMcpInputSchema(
  toolName: string,
  inputSchema: unknown,
): Record<string, unknown> {
  if (typeof inputSchema === "object" && inputSchema !== null && !Array.isArray(inputSchema)) {
    return inputSchema as Record<string, unknown>;
  }
  throw new Error(`MCP 工具 "${toolName}" 的 inputSchema 非法:必须是 JSON 对象`);
}

export function mcpResultToText(result: McpToolResult): string {
  if (result.content.length === 0) return "";
  return result.content
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") return block.text;
      const { type: _type, ...rest } = block;
      return JSON.stringify(rest);
    })
    .join("\n");
}

const MCP_NAME_PREFIX = "mcp__";
const MCP_NAME_SEPARATOR = "__";
const MAX_QUALIFIED_LENGTH = 64;
const QUALIFIED_HASH_SUFFIX_LENGTH = 9;

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_NAME_PREFIX);
}

function sanitizeMcpNamePart(part: string): string {
  return part.replaceAll(/[^a-zA-Z0-9_-]/g, "_").replaceAll(/_+/g, "_");
}

export function qualifyMcpToolName(serverName: string, toolName: string): string {
  const full = `${MCP_NAME_PREFIX}${sanitizeMcpNamePart(serverName)}${MCP_NAME_SEPARATOR}${sanitizeMcpNamePart(toolName)}`;
  if (full.length <= MAX_QUALIFIED_LENGTH) return full;
  const hash = stableHash8(full);
  const head = full.slice(0, MAX_QUALIFIED_LENGTH - QUALIFIED_HASH_SUFFIX_LENGTH);
  return `${head}_${hash}`;
}

export function mcpToolNameMayBelongToServer(name: string, serverName: string): boolean {
  if (!isMcpToolName(name)) return false;
  const prefix = `${MCP_NAME_PREFIX}${sanitizeMcpNamePart(serverName)}${MCP_NAME_SEPARATOR}`;
  const retainedHeadLength = MAX_QUALIFIED_LENGTH - QUALIFIED_HASH_SUFFIX_LENGTH;
  if (prefix.length <= retainedHeadLength) return name.startsWith(prefix);
  return (
    name.length === MAX_QUALIFIED_LENGTH && name.startsWith(prefix.slice(0, retainedHeadLength))
  );
}

function stableHash8(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.codePointAt(index) ?? 0;
    hash = Math.trunc(Math.imul(hash, 0x01000193));
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
