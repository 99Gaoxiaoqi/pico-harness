import type { ToolDefinition, ToolPermissionCategory } from "@pico/core";
import { ToolAccesses, type ToolAccesses as ToolAccessSet } from "@pico/runtime/tool-access";
import {
  assertMcpInputSchema,
  mcpResultToText,
  qualifyMcpToolName,
  type McpTool,
  type McpToolResult,
} from "./mcp-protocol.js";

/** MCP transport bridge 只依赖调用的取消信号，宿主可以扩展完整执行上下文。 */
export interface McpToolExecutionContext {
  readonly signal?: AbortSignal;
}

/** MCP client 的工具调用窄接口；连接与认证生命周期仍由外层 Host 负责。 */
export interface McpToolClient<TContext extends McpToolExecutionContext> {
  callTool(name: string, args: Record<string, unknown>, context?: TContext): Promise<McpToolResult>;
}

export type McpToolCallAuthorizer<TContext extends McpToolExecutionContext> = (
  context?: TContext,
) => Promise<void>;

export interface McpToolBridgeLogger {
  warn(fields: { server: string; tool: string; err: string }, message: string): void;
}

const NOOP_LOGGER: McpToolBridgeLogger = { warn: () => undefined };

/**
 * 将一个 MCP tool 映射为与具体 Registry 无关的工具对象。
 *
 * MCP 工具的副作用不可静态分析，因此始终声明全局资源互斥；具体 Registry 的注册、
 * sandbox 与网络授权都通过 client/authorizer 注入。
 */
export class McpToolBridge<TContext extends McpToolExecutionContext> {
  readonly readOnly = false;
  readonly permissionCategory: ToolPermissionCategory = "network_send";
  readonly fileSideEffects = { kind: "workspace" } as const;
  readonly toolset = "mcp";

  private readonly qualifiedName: string;
  private toolDefinition: ToolDefinition;
  private tool: McpTool;
  private readonly resolveClient: () => McpToolClient<TContext> | undefined;

  constructor(
    client: McpToolClient<TContext> | (() => McpToolClient<TContext> | undefined),
    private readonly serverName: string,
    tool: McpTool,
    private readonly authorizeCall?: McpToolCallAuthorizer<TContext>,
    private readonly logger: McpToolBridgeLogger = NOOP_LOGGER,
  ) {
    this.resolveClient = typeof client === "function" ? client : () => client;
    this.tool = tool;
    this.qualifiedName = qualifyMcpToolName(serverName, tool.name);
    this.toolDefinition = {
      name: this.qualifiedName,
      description: this.buildDescription(),
      inputSchema: assertMcpInputSchema(tool.name, tool.inputSchema),
    };
  }

  name(): string {
    return this.qualifiedName;
  }

  definition(): ToolDefinition {
    return this.toolDefinition;
  }

  /** 仅当输入契约未变时刷新重连后的工具描述，避免替换已准入的 Registry binding。 */
  rebindCompatibleTool(tool: McpTool): void {
    if (!this.isCompatibleTool(tool)) {
      throw new Error(`MCP tool ${this.qualifiedName} changed its input contract during restart`);
    }
    this.tool = tool;
    this.toolDefinition = {
      name: this.qualifiedName,
      description: this.buildDescription(),
      inputSchema: assertMcpInputSchema(tool.name, tool.inputSchema),
    };
  }

  isCompatibleTool(tool: McpTool): boolean {
    return tool.name === this.tool.name && sameJsonValue(tool.inputSchema, this.tool.inputSchema);
  }

  /** MCP 工具默认副作用未知，必须与其他工具全局互斥。 */
  accesses(_args: string): ToolAccessSet {
    return ToolAccesses.all();
  }

  async execute(args: string, context?: TContext): Promise<string> {
    context?.signal?.throwIfAborted();
    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = args.trim() === "" ? {} : (JSON.parse(args) as Record<string, unknown>);
    } catch {
      return `Error: 参数不是合法 JSON。期望: ${JSON.stringify(this.tool.inputSchema)}`;
    }

    try {
      const client = this.resolveClient();
      if (!client) throw new Error(`MCP server ${this.serverName} is reconnecting`);
      await this.authorizeCall?.(context);
      context?.signal?.throwIfAborted();
      const result = await client.callTool(this.tool.name, parsedArgs, context);
      context?.signal?.throwIfAborted();
      if (result.isError) {
        const text = mcpResultToText(result);
        return text.length > 0
          ? `MCP 工具 ${this.tool.name} 返回错误: ${text}`
          : `MCP 工具 ${this.tool.name} 返回错误(无详情)`;
      }
      return mcpResultToText(result);
    } catch (error) {
      context?.signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { server: this.serverName, tool: this.tool.name, err: message },
        `[MCP] 工具调用失败: ${message}`,
      );
      throw new Error(`MCP 工具 ${this.qualifiedName} 调用失败: ${message}`, { cause: error });
    }
  }

  private buildDescription(): string {
    const base = this.tool.description || `(无描述,来自 MCP server "${this.serverName}")`;
    return `${base} [MCP: ${this.serverName}/${this.tool.name}]`;
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]),
    )
  );
}
