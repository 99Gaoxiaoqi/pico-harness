// 工具 Surface 目录（声明式工具分组 + 宿主亲和性 + economy 分层）。
//
// 三层职责统一在此声明：
// 1. economy 分层：always 组每轮可见；deferred 组需经 load_tools 组级激活。
//    组是"最小可用能力单元"——组内工具互相依赖，拆散了无法形成闭环。
// 2. 宿主亲和性：background/headless 等宿主的能力裁剪收编为声明，
//    替代散落在 background-yolo-policy / headless-runner 的硬编码集合。
//    亲和性是 per-tool 独立声明（与 economy 组正交：core 里的 ask_user
//    也可以声明 background unsupported）。
// 3. Plan 模式工具面：planning 模式下 provider 只喂只读 + 协议工具，
//    替代 loop.ts 的 PLAN_PROVIDER_TOOL_NAMES 硬编码白名单。
//
// 不属于任何组的工具（如 MCP/Plugin 动态工具）视为 extended 兜底层，
// 经 search_tools 按 TF-IDF 检索单工具激活。

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
 * 工具组目录（单源，economy 分层专用）。
 *
 * 声明规则：
 * - 一个工具只能属于一个组（重复声明是编程错误，启动时 fail-fast）。
 * - 不属于任何组的工具对所有宿主可用，且落 extended 兜底层。
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
      "delegate_task",
      "schedule_task",
    ],
    economy: "always",
  },
  {
    id: "background-task",
    label: "Background Tasks",
    description: "管理后台任务：列出、查看输出、停止",
    toolNames: ["task_list", "task_output", "task_stop"],
    economy: "deferred",
  },
  {
    id: "code-intelligence",
    label: "Code Intelligence",
    description:
      "LSP 代码智能：定义跳转、引用查找、符号搜索、诊断、调用层次、仓库地图、仓库探索",
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
    id: "delegation",
    label: "Delegation",
    description: "多代理编排：查询委派状态、派遣探索子代理",
    toolNames: ["delegate_status", "spawn_subagent"],
    economy: "deferred",
  },
  {
    id: "memory",
    label: "Memory",
    description: "记忆触发器：前台同步提取、后台异步提取",
    toolNames: ["memory_remember", "memory_extract"],
    economy: "deferred",
  },
  {
    id: "evidence",
    label: "Evidence",
    description: "回读归档的工具输出和完整子代理报告",
    toolNames: ["read_evidence"],
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
    description: "Graph Mode 的 DAG 编排：添加工作、查看图、收口工作",
    toolNames: ["add_work", "view_graph", "close_graph"],
    economy: "deferred",
  },
];

/**
 * 宿主亲和性声明（per-tool，与 economy 组正交）。
 *
 * 未列出的工具默认所有宿主 supported。
 * 收编原 UNSAFE_BACKGROUND_TOOLS（background-yolo-policy）与
 * HEADLESS_TOOL_NAMES（headless-runner）的语义：
 * - background：交互/委派/记忆工具不可用（无人应答、无编排宿主依赖）。
 * - headless：隔离 one-shot 运行只提供最小工具面（无 LSP 服务、无 Goal
 *   manager、无 Skill catalog、无 Graph 存储）。
 */
const TOOL_HOST_AFFINITY: Readonly<Record<string, Partial<Record<ToolHostKind, ToolHostSupport>>>> = {
  ask_user: { background: "unsupported", headless: "unsupported" },
  schedule_task: { background: "unsupported", headless: "unsupported" },
  delegate_task: { background: "unsupported", headless: "unsupported" },
  delegate_status: { background: "unsupported", headless: "unsupported" },
  spawn_subagent: { background: "unsupported", headless: "unsupported" },
  memory_remember: { background: "unsupported", headless: "unsupported" },
  memory_extract: { background: "unsupported", headless: "unsupported" },
  code_definition: { headless: "unsupported" },
  code_references: { headless: "unsupported" },
  code_symbols: { headless: "unsupported" },
  code_diagnostics: { headless: "unsupported" },
  code_call_hierarchy: { headless: "unsupported" },
  repo_map: { headless: "unsupported" },
  explore_repo: { headless: "unsupported" },
  create_goal: { headless: "unsupported" },
  get_goal: { headless: "unsupported" },
  update_goal: { headless: "unsupported" },
  skill_view: { headless: "unsupported" },
  add_work: { headless: "unsupported" },
  view_graph: { headless: "unsupported" },
  close_graph: { headless: "unsupported" },
};

const TOOL_TO_GROUP = new Map<string, ToolGroupDef>();
for (const group of PICO_TOOL_GROUPS) {
  for (const name of group.toolNames) {
    if (TOOL_TO_GROUP.has(name)) {
      throw new Error(
        `Tool "${name}" declared in both "${TOOL_TO_GROUP.get(name)!.id}" and "${group.id}"`,
      );
    }
    TOOL_TO_GROUP.set(name, group);
  }
}

/** 查找工具所属的组。不属于任何组返回 undefined（视为 extended 兜底层）。 */
export function findGroupForTool(toolName: string): ToolGroupDef | undefined {
  return TOOL_TO_GROUP.get(toolName);
}

/** 判断工具在指定宿主上是否可用。未声明亲和性的工具对所有宿主可用。 */
export function isToolSupportedForHost(toolName: string, host: ToolHostKind): boolean {
  return TOOL_HOST_AFFINITY[toolName]?.[host] !== "unsupported";
}

/** 获取指定宿主上所有可用的 deferred 组（供 load_tools 渲染与校验）。 */
export function getAvailableDeferredGroups(host: ToolHostKind): ToolGroupDef[] {
  return PICO_TOOL_GROUPS.filter(
    (g) =>
      g.economy === "deferred" &&
      g.toolNames.some((name) => isToolSupportedForHost(name, host)),
  );
}

/** 获取指定宿主上所有可用工具名（组成员经亲和性过滤；含未分组动态工具的语义由调用方补充）。 */
export function getSupportedToolNames(host: ToolHostKind): Set<string> {
  const names = new Set<string>();
  for (const group of PICO_TOOL_GROUPS) {
    for (const name of group.toolNames) {
      if (isToolSupportedForHost(name, host)) names.add(name);
    }
  }
  return names;
}

/**
 * Plan（planning）模式下允许进入 provider tools 数组的工具面。
 * 只读侦察 + 协议闭环（ask_user 提问、submit_plan 终态）。
 * 替代 loop.ts 原硬编码 PLAN_PROVIDER_TOOL_NAMES。
 */
export const PLAN_MODE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "read_evidence",
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

/** Plan 模式 provider 工具判定（loop.ts 消费）。 */
export function isPlanModeTool(name: string): boolean {
  return PLAN_MODE_TOOL_NAMES.has(name);
}
