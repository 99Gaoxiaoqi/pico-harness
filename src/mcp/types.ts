// MCP (Model Context Protocol) 协议基础类型。
//
// MCP 是 Anthropic 提出的标准协议,让 Agent 能连接外部工具服务器
// (如 GitHub、Linear、数据库等)。协议基于 JSON-RPC 2.0,有三种 transport:
//   - stdio: 启动子进程,通过 stdin/stdout 通信
//   - http:  POST JSON-RPC 请求,读 JSON 响应
//   - sse:   GET 建立 SSE 长连接收响应,POST 发请求
//
// 本文件定义协议层类型 + transport-agnostic 的 McpClient 接口。
// 具体工具桥接(BaseTool 适配)在 mcp-tool.ts,连接编排在 manager.ts。

/**
 * MCP 工具定义:由 server 的 tools/list 方法返回。
 * inputSchema 是 JSON Schema 对象,描述工具参数。
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * MCP server 配置。三种 transport 互斥:
 *   - stdio: 提供 command + args,启动子进程
 *   - http:  提供 url,POST JSON-RPC
 *   - sse:   提供 url,GET 建立 SSE + POST 发请求
 */
export interface McpServerConfig {
  name: string;
  /** stdio 模式:启动命令(如 npx / node / uvx) */
  command?: string;
  /** stdio 模式:命令参数 */
  args?: string[];
  /** http/sse 模式:server URL */
  url?: string;
  transport: "stdio" | "http" | "sse";
  /** stdio 模式:注入子进程的环境变量(会与父进程 env 合并) */
  env?: Record<string, string>;
  /** stdio 模式:子进程工作目录(默认继承父进程) */
  cwd?: string;
  /** http/sse 模式:自定义请求头 */
  headers?: Record<string, string>;
  /** 启动超时(毫秒),默认 30000 */
  startupTimeoutMs?: number;
  /** 单次工具调用超时(毫秒) */
  toolTimeoutMs?: number;
  /** 显式禁用此 server(enabled:false) */
  enabled?: boolean;
}

/** MCP 配置文件根结构(对标 .claw/mcp.json) */
export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/** MCP 连接状态机 */
export type McpConnectionStatus = "pending" | "connected" | "failed" | "disabled";

/**
 * MCP tools/call 返回的内容块。MCP 用 content 数组表达多种返回类型,
 * pico 只消费 text(其它类型降级为 JSON 字符串)。
 */
export interface McpContentBlock {
  /** 已知值:text | image | audio | resource;声明 string 以兼容未来类型 */
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  [key: string]: unknown;
}

/** MCP tools/call 的完整返回 */
export interface McpToolResult {
  content: McpContentBlock[];
  isError: boolean;
}

/**
 * Transport-agnostic 的 MCP 客户端接口。
 * StdioMcpClient / HttpMcpClient 都实现此接口,
 * 让 McpConnectionManager 不关心具体 transport。
 */
export interface McpClient {
  /** 建立连接 + 完成 initialize 握手 */
  connect(): Promise<void>;
  /** 列出 server 暴露的所有工具 */
  listTools(): Promise<McpTool[]>;
  /** 调用指定工具,返回内容块数组 */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /** 优雅关闭:杀子进程 / 关连接 */
  close(): Promise<void>;
}

/**
 * JSON-RPC 2.0 请求消息。
 * 有 id 的才是 request(需要响应);无 id 是 notification(火后不管)。
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 notification(无 id,无需响应) */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 成功响应 */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

/** JSON-RPC 2.0 错误对象 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** 标准 JSON-RPC 错误码 */
export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** MCP 协议版本(pico 客户端声明的版本) */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** pico MCP 客户端在 initialize 握手中声明的身份 */
export const PICO_MCP_CLIENT_INFO = {
  name: "pico-harness",
  version: "0.1.0",
} as const;

/**
 * 校验 MCP 工具的 inputSchema 是合法的 JSON Schema 对象。
 * 拒绝 null / 数组 / 原始类型,确保下游注册到 ToolRegistry 的 Schema 永远是对象。
 */
export function assertMcpInputSchema(
  toolName: string,
  inputSchema: unknown,
): Record<string, unknown> {
  if (typeof inputSchema === "object" && inputSchema !== null && !Array.isArray(inputSchema)) {
    return inputSchema as Record<string, unknown>;
  }
  throw new Error(`MCP 工具 "${toolName}" 的 inputSchema 非法:必须是 JSON 对象`);
}

/**
 * 把 McpToolResult(内容块数组)展平成纯文本字符串。
 * text 块直接拼接;非 text 块降级为 JSON 字符串。供 BaseTool.execute 返回。
 */
export function mcpResultToText(result: McpToolResult): string {
  if (result.content.length === 0) return "";
  const parts = result.content.map((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
    // image/audio/resource 等非文本块:降级为 JSON,保留信息量
    const { type: _t, ...rest } = block;
    return JSON.stringify(rest);
  });
  return parts.join("\n");
}

/** 工具名前缀:所有 MCP 工具在 pico 内部都以 mcp__ 开头 */
const MCP_NAME_PREFIX = "mcp__";
const MCP_NAME_SEPARATOR = "__";
/** 多数 LLM 厂商限制工具名 ≤ 64 字符,给前缀和分隔符留余量 */
const MAX_QUALIFIED_LENGTH = 64;

/** 判断一个工具名是否由 MCP 桥接产生 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_NAME_PREFIX);
}

/**
 * 把任意字符串清洗成 MCP 工具名安全字符:[a-zA-Z0-9_-],
 * 并把连续下划线折叠成一个 —— 保证 server/tool 名都不含 `__` 分隔符,
 * 让 qualifyMcpToolName 产生的名字可被无歧义地拆分回原 server/tool。
 */
function sanitizeMcpNamePart(part: string): string {
  return part.replaceAll(/[^a-zA-Z0-9_-]/g, "_").replaceAll(/_+/g, "_");
}

/**
 * 生成限定后的 MCP 工具名:mcp__<server>__<tool>。
 * 若超过 64 字符,截断并附 8 位 FNV-1a 哈希后缀防冲突,
 * 保留 mcp__ 前缀结构不被破坏。
 */
export function qualifyMcpToolName(serverName: string, toolName: string): string {
  const full = `${MCP_NAME_PREFIX}${sanitizeMcpNamePart(serverName)}${MCP_NAME_SEPARATOR}${sanitizeMcpNamePart(toolName)}`;
  if (full.length <= MAX_QUALIFIED_LENGTH) return full;
  const hash = stableHash8(full);
  const head = full.slice(0, MAX_QUALIFIED_LENGTH - hash.length - 1);
  return `${head}_${hash}`;
}

/** 32-bit FNV-1a 哈希,取低 32 位转 8 位十六进制。非加密,仅用于截断后防冲突。 */
function stableHash8(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.codePointAt(i) ?? 0;
    hash = Math.trunc(Math.imul(hash, 0x01000193));
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
