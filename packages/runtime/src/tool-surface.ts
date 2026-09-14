/** 宿主类型——当前连接/执行环境的身份标识。 */
export type ToolHostKind = "desktop" | "cli" | "background" | "headless";

/** 工具对宿主的可用性声明。 */
export type ToolHostSupport = "supported" | "unsupported";

/** 工具组定义——economy 模式下延迟加载的最小单元。 */
export interface ToolGroupDef {
  readonly id: string;
  readonly label: string;
  /** 给模型看的组描述（load_tools description 渲染用）。 */
  readonly description: string;
  readonly toolNames: readonly string[];
  /** economy 标记：always = 每轮可见；deferred = 需 load_tools 激活。 */
  readonly economy: "always" | "deferred";
}

/**
 * 工具 Surface 目录：工具发现经济分层、宿主亲和性和 Plan 模式的单一策略来源。
 * 动态 MCP/Plugin 工具不在该目录内，由调用方作为 extended 层补充。
 */
export const PICO_TOOL_GROUPS: readonly ToolGroupDef[] = [
  {
    id: "core",
    label: "Core",
    description: "基本文件操作、搜索、执行、交互与编排",
    toolNames: [
      "read_file",
      "write_file",
      "edit_file",
      "bash",
      "glob",
      "grep",
      "todo",
      "ask_user",
      "schedule_task",
      "request_sandbox_boundary",
    ],
    economy: "always",
  },
  {
    id: "background-task",
    label: "Tasks",
    description: "管理 Session 任务账本与后台进程",
    toolNames: ["task_list", "task_create", "task_update", "task_get", "task_output", "task_stop"],
    economy: "deferred",
  },
  {
    id: "code-intelligence",
    label: "Code Intelligence",
    description: "LSP 代码智能：定义跳转、引用查找、符号搜索、诊断、调用层次、仓库地图、仓库探索",
    toolNames: [
      "code_definition",
      "code_references",
      "code_symbols",
      "code_diagnostics",
      "code_call_hierarchy",
      "repo_map",
      "explore_repo",
    ],
    economy: "deferred",
  },
  {
    id: "web",
    label: "Web",
    description: "网络能力：抓取网页内容、网络搜索",
    toolNames: ["fetch_url", "web_search"],
    economy: "deferred",
  },
  {
    id: "goal",
    label: "Goal",
    description: "长程目标管理：创建、查询、更新",
    toolNames: ["create_goal", "get_goal", "update_goal"],
    economy: "deferred",
  },
  {
    id: "agents",
    label: "Agents",
    description: "运行已配置的持久子代理",
    toolNames: ["agent_spawn"],
    economy: "deferred",
  },
  {
    id: "memory",
    label: "Memory",
    description: "记忆触发器：显式记住（前台同步）与自动提取（turn 后异步）",
    toolNames: ["memory_remember", "memory_extract"],
    economy: "deferred",
  },
  {
    id: "skill",
    label: "Skill",
    description: "查看 Skill 具体执行指南",
    toolNames: ["skill_view"],
    economy: "deferred",
  },
  {
    id: "graph",
    label: "Graph",
    description: "Graph Mode 的持久调度：原子更新、查看投影、持久让出",
    toolNames: ["update_agent_graph", "view_agent_graph", "yield_agent_graph"],
    economy: "deferred",
  },
];

const TOOL_HOST_AFFINITY: Readonly<Record<string, Partial<Record<ToolHostKind, ToolHostSupport>>>> =
  {
    ask_user: { background: "unsupported" },
    schedule_task: { background: "unsupported" },
    agent_spawn: { background: "unsupported" },
    request_sandbox_boundary: { background: "unsupported" },
    // headless 是 fail-closed 白名单；新工具必须显式加入。
    read_file: { headless: "supported" },
    write_file: { headless: "supported" },
    edit_file: { headless: "supported" },
    bash: { headless: "supported" },
    glob: { headless: "supported" },
    grep: { headless: "supported" },
    todo: { headless: "supported" },
    task_list: { headless: "supported" },
    task_output: { headless: "supported" },
    task_stop: { headless: "supported" },
    fetch_url: { headless: "supported" },
    web_search: { headless: "supported" },
  };

const TOOL_TO_GROUP = new Map<string, ToolGroupDef>();
const GROUP_IDS = new Set<string>();
for (const group of PICO_TOOL_GROUPS) {
  if (GROUP_IDS.has(group.id)) throw new Error(`Tool group id "${group.id}" declared twice`);
  GROUP_IDS.add(group.id);
  for (const name of group.toolNames) {
    if (TOOL_TO_GROUP.has(name)) {
      throw new Error(
        `Tool "${name}" declared in both "${TOOL_TO_GROUP.get(name)!.id}" and "${group.id}"`,
      );
    }
    TOOL_TO_GROUP.set(name, group);
  }
}
for (const key of Object.keys(TOOL_HOST_AFFINITY)) {
  if (!TOOL_TO_GROUP.has(key)) {
    throw new Error(
      `TOOL_HOST_AFFINITY key "${key}" is not a member of any PICO_TOOL_GROUPS group (typo?)`,
    );
  }
}

/** 查找工具所属的组。不属于任何组返回 undefined（视为 extended 兜底层）。 */
export function findGroupForTool(toolName: string): ToolGroupDef | undefined {
  return TOOL_TO_GROUP.get(toolName);
}

/** headless fail-closed；其余宿主仅显式 unsupported 时拒绝。 */
export function isToolSupportedForHost(toolName: string, host: ToolHostKind): boolean {
  if (host === "headless") return TOOL_HOST_AFFINITY[toolName]?.headless === "supported";
  return TOOL_HOST_AFFINITY[toolName]?.[host] !== "unsupported";
}

/** 获取指定宿主上可用的 deferred 工具组。 */
export function getAvailableDeferredGroups(host: ToolHostKind): ToolGroupDef[] {
  return PICO_TOOL_GROUPS.filter(
    (group) =>
      group.economy === "deferred" &&
      group.toolNames.some((name) => isToolSupportedForHost(name, host)),
  );
}

/** 获取指定宿主上目录内的可用工具名。 */
export function getSupportedToolNames(host: ToolHostKind): Set<string> {
  const names = new Set<string>();
  for (const group of PICO_TOOL_GROUPS) {
    for (const name of group.toolNames) {
      if (isToolSupportedForHost(name, host)) names.add(name);
    }
  }
  return names;
}

/** Plan 模式下允许进入 provider tools 数组的工具面。 */
export const PLAN_MODE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "glob",
  "grep",
  "skill_view",
  "repo_map",
  "code_definition",
  "code_references",
  "code_symbols",
  "code_diagnostics",
  "code_call_hierarchy",
  "ask_user",
  "submit_plan",
]);

export function isPlanModeTool(name: string): boolean {
  return PLAN_MODE_TOOL_NAMES.has(name);
}
