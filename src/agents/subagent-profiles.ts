import type {
  RuntimeConfiguredSubagent,
  RuntimeSubagentPreset,
  SubagentProfile,
} from "@pico/protocol";

/** The same live host catalog is consumed by foreground tools and Graph admission. */
export interface ConfiguredSubagentCatalogPort {
  list(): Promise<RuntimeConfiguredSubagent[]>;
  resolve(id: string): Promise<RuntimeSubagentPreset & { modelRouteId: string }>;
}
export interface SubagentCapabilityDefinition {
  readonly id: string;
  readonly profile: SubagentProfile;
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly workspace: "shared" | "isolated-worktree";
  readonly writeBack: "summary" | "patch";
  readonly systemPrompt: string;
}
export const SUBAGENT_CAPABILITIES: readonly SubagentCapabilityDefinition[] = [
  {
    id: "local-read",
    profile: "local_read",
    name: "Local Read",
    description: "只读本地文件与文本检索。",
    tools: ["read_file", "glob", "grep"],
    workspace: "shared",
    writeBack: "summary",
    systemPrompt:
      "只用提供的文件读取和检索工具完成有边界的探索。不得使用 shell、网络、写入或启动嵌套 Agent。返回简洁结论与具体文件证据。",
  },
  {
    id: "web-research",
    profile: "web_research",
    name: "Web Research",
    description: "网络搜索与来源核验。",
    tools: ["web_search"],
    workspace: "shared",
    writeBack: "summary",
    systemPrompt:
      "只使用 web_search 查证任务，返回有来源链接的结论，区分事实与推断，不声称读取了本地文件。",
  },
  {
    id: "implementation",
    profile: "implementation",
    name: "Implementation",
    description: "在独立 worktree 内实现修改并返回补丁。",
    tools: ["read_file", "glob", "grep", "write_file", "edit_file", "bash"],
    workspace: "isolated-worktree",
    writeBack: "patch",
    systemPrompt:
      "只在分配的独立 worktree 内实现任务。修改前读取文件，保留无关变更，运行针对性验证。不得合并、推送或修改宿主工作区。返回修改摘要和验证结果；宿主收集补丁。",
  },
];
export function requireSubagentCapability(profile: string): SubagentCapabilityDefinition {
  const definition = SUBAGENT_CAPABILITIES.find((entry) => entry.profile === profile);
  if (!definition) throw new Error(`Unknown subagent profile: ${profile}`);
  return definition;
}
