import { homedir } from "node:os";
import { join } from "node:path";
import { loadClaudeAgentsFromDir, type ClaudeAgent } from "../input/agent-loader.js";
import { logger } from "../observability/logger.js";
import { AgentProfileLoader, KNOWN_TOOL_NAMES, type AgentProfile } from "../tools/agent-profile.js";
import { mapClaudeToolNames } from "../catalog/claude-compat.js";
import {
  canonicalResourceName,
  resolveResourceCatalog,
  type ExternalResourceCatalogSource,
  type ResourceCatalogCandidate,
  type ResourceCatalogSource,
} from "../catalog/resource-catalog.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";

export type AgentCatalogSource =
  | "builtin"
  | "user-claude"
  | "project-claude"
  | "project-native"
  | "user-native"
  | "external";

export interface CatalogAgentProfile extends AgentProfile {
  readonly source: AgentCatalogSource;
  readonly sourcePath: string;
  readonly hooks?: unknown;
  readonly catalogSource?: ResourceCatalogSource;
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
  readonly picoHome?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly externalSources?: readonly AgentExternalCatalogSource[];
}

export interface AgentExternalCatalogSource extends ExternalResourceCatalogSource {
  readonly adapter: "pico-agent-yaml" | "claude-agent-directory";
}

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
 * 优先级：project Pico > project legacy > project Claude > user Pico > user Claude > builtin。
 */
export async function loadAgentCatalog(
  options: LoadAgentCatalogOptions,
): Promise<CatalogAgentProfile[]> {
  const homeDir = options.homeDir ?? homedir();
  const paths = resolvePicoPaths(options.workDir, {
    homeDir,
    env: options.env ?? process.env,
    ...(options.picoHome ? { picoHome: options.picoHome } : {}),
  });
  const sources = [
    agentSource("project-pico", "project", "pico-native", paths.project.agents, 50),
    agentSource(
      "project-claw-legacy",
      "project",
      "pico-legacy",
      join(options.workDir, ".claw", "agents.yaml"),
      45,
    ),
    agentSource(
      "project-claude",
      "project",
      "claude-compat",
      join(options.workDir, ".claude", "agents"),
      40,
    ),
    agentSource("user-pico", "user", "pico-native", paths.home.agents, 30),
    agentSource("user-claude", "user", "claude-compat", join(homeDir, ".claude", "agents"), 20),
  ];
  const loaded = await Promise.all(sources.map(loadAgentSource));
  const candidates: ResourceCatalogCandidate<CatalogAgentProfile>[] = loaded.flat();
  if (options.includeBuiltins !== false) {
    const builtinSource = agentSource("builtin", "builtin", "builtin", "builtin:agents", 0);
    for (const profile of BUILTIN_PROFILES) {
      candidates.push({
        name: profile.name,
        source: builtinSource,
        sourcePath: profile.sourcePath,
        value: { ...profile, catalogSource: builtinSource },
      });
    }
  }
  for (const source of options.externalSources ?? []) {
    candidates.push(...(await loadExternalAgentSource(source)));
  }
  const resolved = resolveResourceCatalog(candidates);
  for (const conflict of resolved.conflicts) {
    logger.warn(conflict, "[agent-catalog] 同级 Agent 名称冲突，已保留第一条");
  }
  return [...resolved.entries];
}

export function findAgentProfile<T extends AgentProfile>(
  profiles: readonly T[],
  name: string,
): T | undefined {
  const normalized = name.trim();
  const canonicalName = canonicalAgentName(normalized);
  return profiles.find((profile) => canonicalAgentName(profile.name) === canonicalName);
}

function canonicalAgentName(name: string): string {
  return canonicalResourceName(name);
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

function adaptClaudeAgent(agent: ClaudeAgent, source: ResourceCatalogSource): CatalogAgentProfile {
  return {
    name: agent.name,
    description: agent.description || agent.name,
    systemPrompt: agent.prompt || `You are the ${agent.name} subagent.`,
    systemPromptOverride: true,
    tools: mapClaudeTools(agent),
    ...(agent.model ? { modelRouteId: agent.model } : {}),
    ...(agent.hooks === undefined ? {} : { hooks: agent.hooks }),
    source:
      source.scope === "project"
        ? "project-claude"
        : source.scope === "user"
          ? "user-claude"
          : "external",
    sourcePath: agent.sourcePath,
    catalogSource: source,
  };
}

function mapClaudeTools(agent: ClaudeAgent): string[] {
  if (agent.tools === undefined) return [...DEFAULT_CLAUDE_TOOLS];
  const mapped = mapClaudeToolNames(agent.tools, {
    resource: agent.name,
    sourcePath: agent.sourcePath,
  });
  return mapped.tools.filter((tool) => KNOWN_TOOL_NAMES.has(tool));
}

async function loadAgentSource(
  source: ResourceCatalogSource,
): Promise<ResourceCatalogCandidate<CatalogAgentProfile>[]> {
  if (source.format === "claude-compat") {
    const agents = await loadClaudeAgentsFromDir(
      source.root,
      source.scope === "user" ? "user" : "project",
    );
    return agents.map((agent) => ({
      name: agent.name,
      source,
      sourcePath: agent.sourcePath,
      value: adaptClaudeAgent(agent, source),
    }));
  }
  const result = await new AgentProfileLoader(".", { filePath: source.root }).loadWithTombstones();
  const profileSource: AgentCatalogSource =
    source.scope === "user"
      ? "user-native"
      : source.scope === "external"
        ? "external"
        : "project-native";
  return [
    ...result.profiles.map((profile) => ({
      name: profile.name,
      source,
      sourcePath: source.root,
      value: {
        ...profile,
        source: profileSource,
        sourcePath: source.root,
        catalogSource: source,
      } satisfies CatalogAgentProfile,
    })),
    ...result.tombstoneNames.map((name) => ({
      name,
      source,
      sourcePath: source.root,
      tombstone: true as const,
    })),
  ];
}

async function loadExternalAgentSource(
  source: AgentExternalCatalogSource,
): Promise<ResourceCatalogCandidate<CatalogAgentProfile>[]> {
  if (source.adapter === "claude-agent-directory") {
    const agents = await loadClaudeAgentsFromDir(source.root, "project");
    return agents.map((agent) => ({
      name: agent.name,
      source,
      sourcePath: agent.sourcePath,
      value: adaptClaudeAgent(agent, source),
    }));
  }
  return await loadAgentSource(source);
}

function agentSource(
  id: string,
  scope: ResourceCatalogSource["scope"],
  format: ResourceCatalogSource["format"],
  root: string,
  priority: number,
): ResourceCatalogSource {
  return { id, scope, format, root, priority };
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
