// MCP (Model Context Protocol) 客户端模块导出。
//
// 对外暴露:
//   - McpConnectionManager: 连接编排器(CLI 入口用)
//   - StdioMcpClient / HttpMcpClient: 两种 transport 的客户端
//   - McpToolBridge: BaseTool 适配器
//   - 协议类型与工具函数

export { McpConnectionManager, DEFAULT_CONFIG_RELATIVE } from "./manager.js";
export type {
  McpConnectionManagerOptions,
  McpOAuthCredentials,
  McpOAuthHandler,
  McpOAuthRequest,
  McpServerStatus,
  McpStatusListener,
  McpStatusSnapshot,
  McpStatusSummary,
} from "./manager.js";
export { StdioMcpClient } from "./stdio-client.js";
export { HttpMcpClient } from "./http-client.js";
export { McpToolBridge } from "./mcp-tool.js";
export { McpElicitationUiHandler, createHookedElicitationHandler } from "./elicitation-ui.js";
export type {
  ElicitationField,
  ElicitationRequestId,
  ElicitationUiEvent,
  ElicitationUiRequest,
} from "./elicitation-ui.js";
export type { McpToolBridgeOptions } from "./mcp-tool.js";
export {
  MCP_PROTOCOL_VERSION,
  MCP_STREAMABLE_HTTP_PROTOCOL_VERSION,
  MCP_ELICITATION_PROTOCOL_VERSION,
  PICO_MCP_CLIENT_INFO,
  JsonRpcErrorCode,
  assertMcpInputSchema,
  isMcpToolName,
  qualifyMcpToolName,
  mcpResultToText,
} from "./types.js";
export type {
  McpTool,
  McpServerConfig,
  McpConfig,
  McpConnectionStatus,
  McpContentBlock,
  McpToolResult,
  McpToolCancellationScope,
  McpResource,
  McpResourceContents,
  McpResourceListResult,
  McpResourceReadResult,
  McpPrompt,
  McpPromptListResult,
  McpPromptMessage,
  McpPromptGetResult,
  McpClient,
  McpClientOptions,
  McpElicitationContext,
  McpElicitationHandler,
  McpElicitationRequest,
  McpElicitationResult,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcError,
} from "./types.js";
