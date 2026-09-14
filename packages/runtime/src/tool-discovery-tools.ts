import type { ToolDefinition } from "@pico/core";
import {
  isDirectTool,
  ToolDisclosure,
  TOOL_SEARCH_DEFAULT_LIMIT,
  TOOL_SEARCH_MAX_LIMIT,
} from "./tool-disclosure.js";
import { searchTools } from "./tool-search-index.js";
import { findGroupForTool, PICO_TOOL_GROUPS, type ToolGroupDef } from "./tool-surface.js";
import { ToolAccesses, type ToolAccesses as ToolAccessSet } from "./tool-access.js";

export interface LoadToolsOptions {
  /** 组加载成功后写入审计事件；恢复时不继承工具激活。 */
  onGroupLoaded?: (groupId: string, toolNames: readonly string[]) => void;
}

/** 可选实时注册校验，只能进一步缩小 Run 绑定集。 */
export type RegisteredToolNamesSource = () => readonly string[];

/** 渲染组目录为 load_tools 的 description（模型通过阅读它选择 group id）。 */
export function renderGroupCatalog(groups: readonly ToolGroupDef[]): string {
  const lines = groups.map((group) => `- ${group.id}: ${group.description}`);
  return [
    "按需加载工具组。这些能力存在但完整 schema 被隐藏以保持每轮精简。",
    "兼容入口：传入 group id；在同一发现预算内激活成员，下一个 Step 可调用。也可用 search_tools 按能力检索。",
    "",
    "可用组：",
    ...lines,
  ].join("\n");
}

/**
 * 元工具：模型用它按组激活 deferred 工具。
 *
 * 目录是静态声明，注册是运行现实；两者脱节时宁可拒绝，避免“已加载”后下一步
 * 撞 unknown tool。Run 绑定始终是能力上限。
 */
export class LoadToolsTool {
  readonly readOnly = true;

  constructor(
    private readonly groups: readonly ToolGroupDef[],
    private readonly disclosure: ToolDisclosure,
    private readonly registeredToolNames?: RegisteredToolNamesSource,
    private readonly options: LoadToolsOptions = {},
  ) {}

  name(): string {
    return "load_tools";
  }

  definition(): ToolDefinition {
    return {
      name: "load_tools",
      description: renderGroupCatalog(this.groups),
      inputSchema: {
        type: "object",
        properties: {
          group: {
            type: "string",
            enum: this.groups.map((group) => group.id),
            description: "要加载的工具组 id（见可用组列表）",
          },
        },
        required: ["group"],
      },
    };
  }

  accesses(_args: string): ToolAccessSet {
    return ToolAccesses.none();
  }

  async execute(args: string): Promise<string> {
    let group: string;
    try {
      const input = JSON.parse(args) as { group?: string };
      group = (input.group ?? "").trim();
    } catch {
      throw new Error("参数解析失败:期望 JSON 含 group 字段");
    }
    if (typeof group !== "string" || group === "") {
      throw new Error("参数解析失败:group 必须是非空字符串");
    }

    const found = this.groups.find((candidate) => candidate.id === group);
    if (!found) {
      const available = this.groups.map((candidate) => candidate.id).join(", ");
      throw new Error(`未知工具组 "${group}"。可用组: ${available}`);
    }

    const turn = this.disclosure.currentTurn();
    const bound = new Set(turn.getBoundTools().map((tool) => tool.name));
    const registered = this.registeredToolNames ? new Set(this.registeredToolNames()) : undefined;
    const loadable = registered
      ? found.toolNames.filter((name) => bound.has(name) && registered.has(name))
      : found.toolNames.filter((name) => bound.has(name));
    if (loadable.length === 0) {
      throw new Error(
        `工具组 "${group}" 在当前环境不可用（其工具均未注册）。可尝试其他组: ${this.groups
          .map((candidate) => candidate.id)
          .join(", ")}`,
      );
    }

    const result = this.disclosure.discloseGroup(found.id, loadable);
    if (result.activated.length > 0) this.options.onGroupLoaded?.(found.id, result.activated);
    return JSON.stringify(result);
  }
}

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

/** 以组信息增强排名，但返回始终保留未改写的原始 schema。 */
export function findMatchingTools(
  candidates: readonly ToolDefinition[],
  query: string,
  limit = TOOL_SEARCH_DEFAULT_LIMIT,
): ToolDefinition[] {
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

/** 按能力关键词发现并激活当前 Run 已绑定的延迟工具。 */
export class SearchToolsTool {
  readonly readOnly = true;

  constructor(
    _toolSource: ToolDefinitionSource,
    private readonly disclosure: ToolDisclosure,
  ) {}

  name(): string {
    return "search_tools";
  }

  definition(): ToolDefinition {
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

  accesses(_args: string): ToolAccessSet {
    return ToolAccesses.none();
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
