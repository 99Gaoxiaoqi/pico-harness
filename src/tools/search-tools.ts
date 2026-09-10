// search_tools 是 Pico 已有的 provider 安全名称（OpenAI 保留 tool_search）。
// 分组是检索元数据；全部 deferred 工具共用同一有界激活入口。
import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import type { ToolAccesses } from "./tool-access.js";
import { ToolAccesses as ToolAccessesNs } from "./tool-access.js";
import {
  type ToolDisclosure,
  isDirectTool,
  TOOL_SEARCH_DEFAULT_LIMIT,
  TOOL_SEARCH_MAX_LIMIT,
} from "./tool-disclosure.js";
import { findGroupForTool, PICO_TOOL_GROUPS } from "./tool-surface.js";
import { searchTools } from "./tool-search-index.js";

export type ToolDefinitionSource = readonly ToolDefinition[] | (() => readonly ToolDefinition[]);

const CANDIDATE_EXCLUDED_NAMES = new Set([
  "search_tools",
  "load_tools",
  "submit_plan",
  "update_plan",
  "cancel_plan",
]);

function isSearchable(tool: ToolDefinition): boolean {
  return !CANDIDATE_EXCLUDED_NAMES.has(tool.name) && !isDirectTool(tool.name);
}

export function findMatchingTools(
  candidates: readonly ToolDefinition[],
  query: string,
  limit = TOOL_SEARCH_DEFAULT_LIMIT,
): ToolDefinition[] {
  // 保留原始 schema；组元数据仅用于排名，不进入模型结果。
  const originals = new Map(candidates.map((tool) => [tool.name, tool]));
  const indexed = candidates.map((tool) => {
    const group = findGroupForTool(tool.name);
    return group
      ? {
          ...tool,
          description: `${tool.description} ${group.id} ${group.label} ${group.description}`,
        }
      : tool;
  });
  return searchTools(indexed, query, limit).map((result) => originals.get(result.tool.name)!);
}

export class SearchToolsTool implements BaseTool {
  readonly readOnly = true;

  constructor(
    _toolSource: ToolDefinitionSource,
    private readonly disclosure: ToolDisclosure,
  ) {}

  name(): string {
    return "search_tools";
  }

  definition(): ToolDefinition {
    // 不反查 registry.getAvailableTools：该方法本身正在调用 definition。
    // 这里提供分组检索提示，候选上限始终由 execute 的 Run 绑定快照决定。
    const inventory = PICO_TOOL_GROUPS.filter((group) => group.economy === "deferred").map(
      (group) => `- ${group.id}: ${group.label}`,
    );
    return {
      name: "search_tools",
      description: [
        "检索本 Run 绑定的延迟工具。成功后激活有界匹配结果，完整定义在下一个 Step 可调用。",
        "激活在本 Turn 累积，下个 Turn 重新发现。支持 select:工具名 精确选择。",
        "分组关键词提示（实际可用工具由当前 Run 决定）；另支持 MCP/Plugin 动态工具：",
        ...inventory,
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "能力关键词，或 select:工具名 精确选择" },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: TOOL_SEARCH_MAX_LIMIT,
            description: `本次最多激活工具数，默认 ${TOOL_SEARCH_DEFAULT_LIMIT}`,
          },
        },
        required: ["query"],
      },
    };
  }

  accesses(_args: string): ToolAccesses {
    return ToolAccessesNs.none();
  }

  async execute(args: string): Promise<string> {
    let input: { query?: unknown; limit?: unknown };
    try {
      input = JSON.parse(args) as typeof input;
      if (!input || typeof input !== "object") throw new Error("object required");
    } catch {
      throw new Error("参数解析失败:期望 JSON 含 query 字段");
    }
    if (typeof input.query !== "string" || input.query.trim() === "") {
      throw new Error("参数解析失败:query 必须是非空字符串");
    }
    const limit = input.limit ?? TOOL_SEARCH_DEFAULT_LIMIT;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > TOOL_SEARCH_MAX_LIMIT
    ) {
      throw new Error(`参数解析失败:limit 必须是 1 到 ${TOOL_SEARCH_MAX_LIMIT} 之间的整数`);
    }
    const turn = this.disclosure.currentTurn();
    // 只使用 Turn 所属 Run 绑定的快照；实时新增/替换工具不能通过搜索扩权。
    const candidates = turn
      .getBoundTools()
      .filter((tool) => isSearchable(tool) && !turn.isToolVisible(tool.name));
    const hits = findMatchingTools(candidates, input.query, TOOL_SEARCH_MAX_LIMIT);
    return JSON.stringify(
      turn.discloseTools(
        hits.map((tool) => tool.name),
        limit,
      ),
    );
  }
}
