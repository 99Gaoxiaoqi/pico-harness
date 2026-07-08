// SearchToolsTool:工具渐进披露的元工具(ROADMAP 5.4)。
//
// 对齐 GlobTool / TodoTool 的跨文件 BaseTool 定义模式:独立文件实现,
// 不进 registry-impl.ts,由 default-registry.ts 在合并阶段统一挂载。
//
// 作用:模型用关键词检索扩展工具,命中后调 disclosure.disclose() 把它们
// 加入已披露集合,pickForLLM 下一轮即把这些扩展工具喂给 LLM。
//
// 纯只读、不触碰任何资源:只更新内存里的 disclosed 集合,与一切工具不冲突。

import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import type { ToolAccesses } from "./tool-access.js";
import { ToolAccesses as ToolAccessesNs } from "./tool-access.js";
import { ToolDisclosure } from "./tool-disclosure.js";

/**
 * 元工具:模型用它检索并激活扩展工具。
 *
 * 构造时注入扩展工具定义列表(待检索池)与 ToolDisclosure(状态机)。
 * execute 在扩展工具的 name/description 里做关键词匹配,命中即 disclose。
 */
export class SearchToolsTool implements BaseTool {
  /** 纯只读:只更新内存 disclosed 集合,不触碰文件/网络等资源。 */
  readonly readOnly = true;

  constructor(
    private readonly extendedTools: ToolDefinition[],
    private readonly disclosure: ToolDisclosure,
  ) {}

  name(): string {
    return "search_tools";
  }

  definition(): ToolDefinition {
    return {
      name: "search_tools",
      description:
        "搜索并激活扩展工具。当你需要的工具不在当前列表时(如搜索网络、抓取网页、查看后台任务、管理长程目标),用关键词检索,命中的工具下一轮自动可用。",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "要找什么工具,用关键词描述(如'搜索网络''抓取网页''后台任务')",
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

    // 2. 切分为分词,任意分词命中即纳入(name 或 description 含分词,不分大小写)
    const tokens = query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);

    const hits: ToolDefinition[] = [];
    for (const tool of this.extendedTools) {
      const haystack = `${tool.name} ${tool.description}`.toLowerCase();
      if (tokens.some((tok) => haystack.includes(tok))) {
        hits.push(tool);
      }
    }

    // 3. 无命中提示
    if (hits.length === 0) {
      return "未找到匹配工具,试试其他关键词。";
    }

    // 4. 命中即 disclose(扩展工具下一轮生效),返回激活说明
    this.disclosure.disclose(hits.map((t) => t.name));
    const lines = hits.map((t) => `- ${t.name}: ${t.description}`);
    return `已激活 ${hits.length} 个工具,下一轮可直接调用:\n${lines.join("\n")}`;
  }
}
