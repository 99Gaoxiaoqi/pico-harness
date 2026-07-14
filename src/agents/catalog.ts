import { homedir } from "node:os";
import { join } from "node:path";
import { loadClaudeAgents, type ClaudeAgent } from "../input/agent-loader.js";
import { logger } from "../observability/logger.js";
import { AgentProfileLoader, KNOWN_TOOL_NAMES, type AgentProfile } from "../tools/agent-profile.js";

export type AgentCatalogSource = "builtin" | "user-claude" | "project-claude" | "project-native";

export interface CatalogAgentProfile extends AgentProfile {
  readonly source: AgentCatalogSource;
  readonly sourcePath: string;
  readonly hooks?: unknown;
}

export interface AgentProfileSummary {
  readonly name: string;
  readonly description: string;
  readonly source: AgentCatalogSource;
  readonly sourcePath: string;
  readonly tools: string[];
  readonly modelRouteId?: string | "inherit";
}

export interface LoadAgentCatalogOptions {
  readonly workDir: string;
  readonly homeDir?: string;
  readonly includeBuiltins?: boolean;
}

const CLAUDE_TOOL_TO_PICO: Readonly<Record<string, string>> = Object.freeze({
  Bash: "bash",
  Edit: "edit_file",
  Glob: "glob",
  Grep: "grep",
  Read: "read_file",
  Skill: "skill_view",
  TodoWrite: "todo",
  WebFetch: "fetch_url",
  WebSearch: "web_search",
  Write: "write_file",
  bash: "bash",
  edit_file: "edit_file",
  fetch_url: "fetch_url",
  glob: "glob",
  grep: "grep",
  read_file: "read_file",
  skill_view: "skill_view",
  todo: "todo",
  web_search: "web_search",
  write_file: "write_file",
});

const DEFAULT_CLAUDE_TOOLS = Object.freeze(["read_file", "glob", "grep"]);

const BUILTIN_PROFILES: readonly CatalogAgentProfile[] = Object.freeze([
  builtinProfile(
    "Explore",
    "Search and understand codebases without making edits.",
    "Explore the codebase and report findings without changing files.",
    ["read_file", "bash", "skill_view", "glob", "grep", "fetch_url", "web_search"],
  ),
  builtinProfile(
    "Plan",
    "Break down implementation work into a clear plan before edits.",
    "Create a concise implementation plan without changing files.",
    ["read_file", "bash", "skill_view", "glob", "grep"],
  ),
  builtinProfile(
    "general-purpose",
    "Handle complex multi-step tasks that need exploration and action.",
    "Complete a complex multi-step task and summarize the result.",
    [
      "read_file",
      "write_file",
      "edit_file",
      "bash",
      "skill_view",
      "glob",
      "grep",
      "todo",
      "fetch_url",
      "web_search",
    ],
  ),
]);

/**
 * 加载统一 Agent 目录。后加入者整条覆盖同名项，禁止把不同来源的 prompt、工具或模型拼接。
 * 优先级：project native > project Claude > user Claude > builtin。
 */
export async function loadAgentCatalog(
  options: LoadAgentCatalogOptions,
): Promise<CatalogAgentProfile[]> {
  const [nativeProfiles, claudeAgents] = await Promise.all([
    new AgentProfileLoader(options.workDir).load(),
    loadClaudeAgents({
      workDir: options.workDir,
      homeDir: options.homeDir ?? homedir(),
      includeBuiltins: false,
    }),
  ]);

  const byName = new Map<string, CatalogAgentProfile>();
  if (options.includeBuiltins !== false) {
    for (const profile of BUILTIN_PROFILES) byName.set(profile.name, profile);
  }
  for (const agent of claudeAgents.filter((candidate) => candidate.source === "user")) {
    byName.set(agent.name, adaptClaudeAgent(agent));
  }
  for (const agent of claudeAgents.filter((candidate) => candidate.source === "project")) {
    byName.set(agent.name, adaptClaudeAgent(agent));
  }
  for (const profile of nativeProfiles) {
    byName.set(profile.name, {
      ...profile,
      source: "project-native",
      sourcePath: join(options.workDir, ".claw", "agents.yaml"),
    });
  }
  return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export function findAgentProfile<T extends AgentProfile>(
  profiles: readonly T[],
  name: string,
): T | undefined {
  const normalized = name.trim();
  return (
    profiles.find((profile) => profile.name === normalized) ??
    profiles.find((profile) => profile.name.toLowerCase() === normalized.toLowerCase())
  );
}

export function summarizeAgentProfiles(
  profiles: readonly CatalogAgentProfile[],
): AgentProfileSummary[] {
  return profiles.map((profile) => ({
    name: profile.name,
    description: profile.description,
    source: profile.source,
    sourcePath: profile.sourcePath,
    tools: [...profile.tools],
    ...(profile.modelRouteId !== undefined ? { modelRouteId: profile.modelRouteId } : {}),
  }));
}

function adaptClaudeAgent(agent: ClaudeAgent): CatalogAgentProfile {
  return {
    name: agent.name,
    description: agent.description || agent.name,
    systemPrompt: agent.prompt || `You are the ${agent.name} subagent.`,
    systemPromptOverride: true,
    tools: mapClaudeTools(agent),
    ...(agent.model ? { modelRouteId: agent.model } : {}),
    ...(agent.hooks === undefined ? {} : { hooks: agent.hooks }),
    source: agent.source === "project" ? "project-claude" : "user-claude",
    sourcePath: agent.sourcePath,
  };
}

function mapClaudeTools(agent: ClaudeAgent): string[] {
  if (agent.tools === undefined) return [...DEFAULT_CLAUDE_TOOLS];
  const mapped = new Set<string>();
  for (const declared of agent.tools) {
    const picoName = CLAUDE_TOOL_TO_PICO[declared];
    if (!picoName || !KNOWN_TOOL_NAMES.has(picoName)) {
      logger.warn(
        { agent: agent.name, sourcePath: agent.sourcePath, tool: declared },
        "[agent-catalog] Claude Agent 声明了未知工具，已按 fail-closed 忽略",
      );
      continue;
    }
    mapped.add(picoName);
  }
  return Array.from(mapped);
}

function builtinProfile(
  name: string,
  description: string,
  systemPrompt: string,
  tools: string[],
): CatalogAgentProfile {
  return {
    name,
    description,
    systemPrompt,
    systemPromptOverride: true,
    tools,
    source: "builtin",
    sourcePath: `builtin:${name}`,
  };
}
