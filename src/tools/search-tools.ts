// SearchToolsTool：单工具兜底检索（MCP/Plugin 动态工具激活路径）。
//
// 组级激活的主路径是 load_tools（枚举选择，零歧义）；本工具职责缩小为
// 检索不属于预定义组的动态工具（MCP server 工具、Plugin 能力工具），
// 使用 TF-IDF + 中文 bigram 混合检索（升级自纯子串匹配）。
//
// 纯只读、不触碰任何资源:只更新内存里的 disclosed 集合,与一切工具不冲突。

import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import type { ToolAccesses } from "./tool-access.js";
import { ToolAccesses as ToolAccessesNs } from "./tool-access.js";
import type { ToolDisclosure } from "./tool-disclosure.js";
import { findGroupForTool } from "./tool-surface.js";
import { searchTools } from "./tool-search-index.js";

export type ToolDefinitionSource = readonly ToolDefinition[] | (() => readonly ToolDefinition[]);

export function findMatchingTools(
  candidates: readonly ToolDefinition[],
  query: string,
): ToolDefinition[] {
  return searchTools(candidates, query).map((r) => r.tool);
}

/**
 * 元工具:模型用它检索并激活动态扩展工具（MCP/Plugin）。
 *
 * 构造时注入工具定义数组或实时数据源,与 ToolDisclosure(状态机)。
 * 实时数据源使 registry 创建后动态注册的 MCP/Plugin 工具也可检索;
 * 只检索不属于预定义组的工具（组内工具走 load_tools 组级激活）。
 */
export class SearchToolsTool implements BaseTool {
  /** 纯只读:只更新内存 disclosed 集合,不触碰文件/网络等资源。 */
  readonly readOnly = true;

  constructor(
    private readonly toolSource: ToolDefinitionSource,
    private readonly disclosure: ToolDisclosure,
  ) {}

  name(): string {
    return "search_tools";
  }

  definition(): ToolDefinition {
    return {
      name: "search_tools",
      description:
        "检索并激活动态扩展工具(MCP/Plugin 工具)。已知分组的工具(代码智能、网络、目标等)请优先用 load_tools;此工具用于查找不属于预定义组的动态工具。支持 select:工具名 精确选择。",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "要找什么工具,用关键词描述(如 'browser_navigate' 或 '数据库查询');select:前缀精确选择",
          },
        },
        required: ["query"],
      },
    };
  }

  /** 纯只读、不触碰资源:与一切工具都不冲突。 */
  accesses(_args: string): ToolAccesses {
    return ToolAccessesNs.none();
  }

  async execute(args: string): Promise<string> {
    // 1. 延迟解析 JSON 参数,解析失败给模型明确的中文报错
    let query: string;
    try {
      const input = JSON.parse(args) as { query?: string };
      query = input.query ?? "";
    } catch {
      throw new Error("参数解析失败:期望 JSON 含 query 字段");
    }
    if (typeof query !== "string" || query.trim() === "") {
      throw new Error("参数解析失败:query 必须是非空字符串");
    }

    // 2. 每次执行都取实时工具列表,只检索无预定义组的动态工具
    //    （组内工具经 load_tools 激活;search_tools 本身排除避免自激活）。
    const candidates = this.resolveTools().filter(
      (tool) => tool.name !== this.name() && findGroupForTool(tool.name) === undefined,
    );
    const hits = findMatchingTools(candidates, query);

    // 3. 无命中提示
    if (hits.length === 0) {
      return "未找到匹配工具,试试其他关键词;已知分组的工具请用 load_tools。";
    }

    // 4. 命中即 disclose(下一轮生效),返回激活说明
    this.disclosure.discloseTools(hits.map((t) => t.name));
    const lines = hits.map((t) => `- ${t.name}: ${t.description}`);
    return `已激活 ${hits.length} 个工具,下一轮可直接调用:\n${lines.join("\n")}`;
  }

  private resolveTools(): readonly ToolDefinition[] {
    return typeof this.toolSource === "function" ? this.toolSource() : this.toolSource;
  }
}
