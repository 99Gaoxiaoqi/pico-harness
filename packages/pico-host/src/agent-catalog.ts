import { homedir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolNames } from "@pico/core/claude-tool-compat";
import {
  canonicalResourceName,
  resolveResourceCatalog,
  type ExternalResourceCatalogSource,
  type ResourceCatalogCandidate,
  type ResourceCatalogSource,
} from "@pico/core/resource-catalog";
import { AgentProfileLoader, KNOWN_TOOL_NAMES, type AgentProfile } from "./agent-profile-loader.js";
import { loadClaudeAgentsFromDir, type ClaudeAgent } from "./claude-agent-loader.js";
import { resolvePicoPaths } from "./pico-paths.js";

export type AgentCatalogSource =
  | "builtin"
  | "user-claude"
  | "project-claude"
  | "project-native"
  | "user-native"
  | "external";

export interface AgentCatalogLogger {
  warn(bindings: object, message: string): void;
}

export interface CatalogAgentProfile<
  TrustAuthority = unknown,
> extends AgentProfile<TrustAuthority> {
  readonly source: AgentCatalogSource;
  readonly sourcePath: string;
  readonly hooks?: unknown;
  readonly catalogSource?: ResourceCatalogSource<TrustAuthority>;
}

export interface AgentProfileSummary {
  readonly name: string;
  readonly description: string;
  readonly source: AgentCatalogSource;
  readonly sourcePath: string;
  readonly tools: string[];
  readonly modelRouteId?: string | "inherit";
}

export interface LoadAgentCatalogOptions<TrustAuthority = unknown> {
  readonly workDir: string;
  readonly homeDir?: string;
  readonly includeBuiltins?: boolean;
  readonly picoHome?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly externalSources?: readonly AgentExternalCatalogSource<TrustAuthority>[];
  readonly includeClaudeProjectResources?: boolean;
  readonly includeClaudeUserResources?: boolean;
  readonly logger?: AgentCatalogLogger;
}

export interface AgentExternalCatalogSource<
  TrustAuthority = unknown,
> extends ExternalResourceCatalogSource<TrustAuthority> {
  readonly adapter: "pico-agent-yaml" | "claude-agent-directory";
}

const NOOP_LOGGER: AgentCatalogLogger = { warn: () => undefined };
const DEFAULT_CLAUDE_TOOLS = Object.freeze(["read_file", "glob", "grep"]);

type BuiltinAgentProfile = Pick<
  CatalogAgentProfile,
  | "name"
  | "description"
  | "systemPrompt"
  | "systemPromptOverride"
  | "tools"
  | "source"
  | "sourcePath"
>;

const BUILTIN_PROFILES: readonly BuiltinAgentProfile[] = Object.freeze([
  builtinProfile(
    "Explore",
    "Search and understand codebases without making edits.",
    "Explore the codebase and report findings without changing files.",
    [
      "read_file",
      "bash",
      "skill_view",
      "glob",
      "grep",
      "fetch_url",
      "web_search",
      "explore_repo",
      "repo_map",
      "code_definition",
      "code_references",
      "code_symbols",
      "code_diagnostics",
      "code_call_hierarchy",
    ],
  ),
  builtinProfile(
    "Plan",
    "Break down implementation work into a clear plan before edits.",
    "Create a concise implementation plan without changing files.",
    [
      "read_file",
      "bash",
      "skill_view",
      "glob",
      "grep",
      "explore_repo",
      "repo_map",
      "code_definition",
      "code_references",
      "code_symbols",
      "code_diagnostics",
      "code_call_hierarchy",
    ],
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

/** Load and resolve native, Claude-compatible, builtin, and external Agent resources. */
export async function loadAgentCatalog<TrustAuthority = unknown>(
  options: LoadAgentCatalogOptions<TrustAuthority>,
): Promise<CatalogAgentProfile<TrustAuthority>[]> {
  const logger = options.logger ?? NOOP_LOGGER;
  const homeDir = options.homeDir ?? homedir();
  const paths = resolvePicoPaths(options.workDir, {
    homeDir,
    env: options.env ?? process.env,
    ...(options.picoHome
      ? { picoHome: options.picoHome }
      : options.homeDir
        ? { picoHome: join(homeDir, ".pico") }
        : {}),
  });
  const sources: ResourceCatalogSource<TrustAuthority>[] = [
    agentSource<TrustAuthority>("project-pico", "project", "pico-native", paths.project.agents, 50),
    ...(options.includeClaudeProjectResources === false
      ? []
      : [
          agentSource<TrustAuthority>(
            "project-claude",
            "project",
            "claude-compat",
            join(options.workDir, ".claude", "agents"),
            40,
          ),
        ]),
    agentSource<TrustAuthority>("user-pico", "user", "pico-native", paths.home.agents, 30),
    ...(options.includeClaudeUserResources === false
      ? []
      : [
          agentSource<TrustAuthority>(
            "user-claude",
            "user",
            "claude-compat",
            join(homeDir, ".claude", "agents"),
            20,
          ),
        ]),
  ];
  const loaded = await Promise.all(sources.map((source) => loadAgentSource(source, logger)));
  const candidates: ResourceCatalogCandidate<
    CatalogAgentProfile<TrustAuthority>,
    TrustAuthority
  >[] = loaded.flat();
  if (options.includeBuiltins !== false) {
    const builtinSource = agentSource<TrustAuthority>(
      "builtin",
      "builtin",
      "builtin",
      "builtin:agents",
      0,
    );
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
    candidates.push(...(await loadExternalAgentSource(source, logger)));
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
  const canonicalName = canonicalResourceName(name.trim());
  return profiles.find((profile) => canonicalResourceName(profile.name) === canonicalName);
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

function adaptClaudeAgent<TrustAuthority>(
  agent: ClaudeAgent,
  source: ResourceCatalogSource<TrustAuthority>,
  logger: AgentCatalogLogger,
): CatalogAgentProfile<TrustAuthority> {
  return {
    name: agent.name,
    description: agent.description || agent.name,
    systemPrompt: agent.prompt || `You are the ${agent.name} subagent.`,
    systemPromptOverride: true,
    tools: mapClaudeTools(agent, logger),
    ...(agent.model ? { modelRouteId: agent.model } : {}),
    ...(agent.hooks === undefined ? {} : { hooks: agent.hooks }),
    source:
      source.scope === "project"
        ? "project-claude"
        : source.scope === "user"
          ? "user-claude"
          : "external",
    sourcePath: agent.sourcePath,
    ...(source.hookTrustAuthority ? { hookTrustAuthority: source.hookTrustAuthority } : {}),
    catalogSource: source,
  };
}

function mapClaudeTools(agent: ClaudeAgent, logger: AgentCatalogLogger): string[] {
  if (agent.tools === undefined) return [...DEFAULT_CLAUDE_TOOLS];
  const mapped = mapClaudeToolNames(agent.tools);
  if (mapped.unknown.length > 0) {
    logger.warn(
      { resource: agent.name, sourcePath: agent.sourcePath, tools: mapped.unknown },
      "[catalog] Claude 资源声明了未知工具，已按 fail-closed 处理",
    );
  }
  return mapped.tools.filter((tool) => KNOWN_TOOL_NAMES.has(tool));
}

async function loadAgentSource<TrustAuthority>(
  source: ResourceCatalogSource<TrustAuthority>,
  logger: AgentCatalogLogger,
): Promise<ResourceCatalogCandidate<CatalogAgentProfile<TrustAuthority>, TrustAuthority>[]> {
  if (source.format === "claude-compat") {
    const agents = await loadClaudeAgentsFromDir(
      source.root,
      source.scope === "user" ? "user" : "project",
    );
    return agents.map((agent) => ({
      name: agent.name,
      source,
      sourcePath: agent.sourcePath,
      value: adaptClaudeAgent(agent, source, logger),
    }));
  }
  const result = await new AgentProfileLoader<TrustAuthority>(".", {
    filePath: source.root,
    logger,
  }).loadWithTombstones();
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
        ...(source.hookTrustAuthority ? { hookTrustAuthority: source.hookTrustAuthority } : {}),
        catalogSource: source,
      } satisfies CatalogAgentProfile<TrustAuthority>,
    })),
    ...result.tombstoneNames.map((name) => ({
      name,
      source,
      sourcePath: source.root,
      tombstone: true as const,
    })),
  ];
}

async function loadExternalAgentSource<TrustAuthority>(
  source: AgentExternalCatalogSource<TrustAuthority>,
  logger: AgentCatalogLogger,
): Promise<ResourceCatalogCandidate<CatalogAgentProfile<TrustAuthority>, TrustAuthority>[]> {
  if (source.adapter === "claude-agent-directory") {
    const agents = await loadClaudeAgentsFromDir(source.root, "project");
    return agents.map((agent) => {
      const name = `${source.namespace ?? ""}${agent.name}`;
      return {
        name,
        source,
        sourcePath: agent.sourcePath,
        value: adaptClaudeAgent({ ...agent, name }, source, logger),
      };
    });
  }
  return (await loadAgentSource(source, logger)).map((candidate) => {
    const name = `${source.namespace ?? ""}${candidate.name}`;
    return {
      ...candidate,
      name,
      ...(candidate.value ? { value: { ...candidate.value, name } } : {}),
    };
  });
}

function agentSource<TrustAuthority = unknown>(
  id: string,
  scope: ResourceCatalogSource["scope"],
  format: ResourceCatalogSource["format"],
  root: string,
  priority: number,
): ResourceCatalogSource<TrustAuthority> {
  return { id, scope, format, root, priority };
}

function builtinProfile(
  name: string,
  description: string,
  systemPrompt: string,
  tools: string[],
): BuiltinAgentProfile {
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
