// McpToolBridge:把 MCP server 暴露的工具适配成 pico 的 BaseTool 接口。
//
// 设计思路:MCP 工具是"黑盒"——它的副作用由 server 内部决定,
// pico 无法静态分析(不像 read_file 能知道访问哪个文件)。
// 因此默认按未知副作用处理：全局串行，并让文件历史保守地记录工作区变化。
//
// 工具名限定:mcp__<server>__<tool>,防止多 server 工具名冲突。
// execute() 接收 JSON 字符串(与所有 BaseTool 一致),解析后转发给 McpClient。

import {
  WORKSPACE_FILE_SIDE_EFFECTS,
  type BaseTool,
  type ToolExecutionContext,
} from "../tools/registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "../tools/tool-access.js";
import { logger } from "../observability/logger.js";
import {
  assertMcpInputSchema,
  mcpResultToText,
  qualifyMcpToolName,
  type McpClient,
  type McpTool,
} from "./types.js";

export interface McpToolBridgeOptions {
  /**
   * 可选的 MCP 本地硬截断上限。默认不截断，将完整结果交给
   * observation（>50,000 chars 落盘）。仅在宿主明确需要更小上限时设置。
   */
  maxResultSizeChars?: number;
}

/**
 * McpToolBridge:一个 MCP 工具的 BaseTool 适配器。
 *
 * 每个 server 的每个工具实例化一个 McpToolBridge,
 * 持有 McpClient 引用以便运行时转发调用。
 */
export class McpToolBridge implements BaseTool {
  readonly readOnly = false;
  readonly fileSideEffects = WORKSPACE_FILE_SIDE_EFFECTS;
  readonly toolset = "mcp";
  readonly maxResultSizeChars: number;

  /** 只有本地 stdio 进程树可对“物理已停止”做强承诺。 */
  get handlesAbortSignal(): boolean {
    return this.client.toolCancellationScope === "process_tree";
  }

  private readonly qualifiedName: string;
  private readonly toolDefinition: ToolDefinition;

  constructor(
    private readonly client: McpClient,
    private readonly serverName: string,
    private readonly tool: McpTool,
    options: McpToolBridgeOptions = {},
  ) {
    this.qualifiedName = qualifyMcpToolName(serverName, tool.name);
    this.maxResultSizeChars = options.maxResultSizeChars ?? Number.POSITIVE_INFINITY;
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

  /** MCP 工具默认副作用未知，必须与其他工具全局互斥。 */
  accesses(_args: string): ToolAccesses {
    return ToolAccesses.all();
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    context?.signal?.throwIfAborted();
    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = args.trim() === "" ? {} : (JSON.parse(args) as Record<string, unknown>);
    } catch {
      // 参数解析失败不抛异常,返回明确错误让模型自纠
      return `Error: 参数不是合法 JSON。期望: ${JSON.stringify(this.tool.inputSchema)}`;
    }

    try {
      const result = await this.client.callTool(this.tool.name, parsedArgs, context);
      context?.signal?.throwIfAborted();
      if (result.isError) {
        // server 报 isError:把内容拼成错误信息返回(不抛异常,保持 BaseTool 契约)
        const text = mcpResultToText(result);
        return text.length > 0
          ? `MCP 工具 ${this.tool.name} 返回错误: ${text}`
          : `MCP 工具 ${this.tool.name} 返回错误(无详情)`;
      }
      const text = mcpResultToText(result);
      return this.truncate(text);
    } catch (err) {
      context?.signal?.throwIfAborted();
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { server: this.serverName, tool: this.tool.name, err: msg },
        `[MCP] 工具调用失败: ${msg}`,
      );
      // 抛异常由 Registry 封装成 isError ToolResult
      throw new Error(`MCP 工具 ${this.qualifiedName} 调用失败: ${msg}`, { cause: err });
    }
  }

  /** 描述里附 server 来源,帮模型理解工具出处 */
  private buildDescription(): string {
    const base = this.tool.description || `(无描述,来自 MCP server "${this.serverName}")`;
    return `${base} [MCP: ${this.serverName}/${this.tool.name}]`;
  }

  private truncate(text: string): string {
    if (text.length <= this.maxResultSizeChars) return text;
    return (
      text.slice(0, this.maxResultSizeChars) +
      `\n\n...[MCP 工具输出过长,已截断至前 ${this.maxResultSizeChars} 字符]...`
    );
  }
}
