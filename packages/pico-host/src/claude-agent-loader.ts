import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as yaml from "js-yaml";
import { canonicalResourceName } from "@pico/core/resource-catalog";

export type ClaudeAgentSource = "builtin" | "project" | "user";

export interface ClaudeAgent {
  name: string;
  description: string;
  prompt: string;
  sourcePath: string;
  source: ClaudeAgentSource;
  tools?: string[];
  hooks?: unknown;
  model?: string;
}

export interface ClaudeAgentSummary {
  name: string;
  description: string;
  sourcePath: string;
  source?: ClaudeAgentSource;
  tools?: string[];
  model?: string;
}

export interface LoadClaudeAgentsOptions {
  workDir: string;
  homeDir?: string;
  includeBuiltins?: boolean;
}

export interface SummarizeClaudeAgentsOptions {
  includeSource?: boolean;
}

const AGENT_PRIORITIES: Record<ClaudeAgentSource, number> = {
  builtin: 0,
  user: 10,
  project: 20,
};
const MAX_AGENT_FILE_BYTES = 256 * 1024;
const MAX_AGENT_FILES = 500;

const BUILTIN_AGENTS: readonly ClaudeAgent[] = [
  {
    name: "Explore",
    description: "Search and understand codebases without making edits.",
    prompt: "Explore the codebase and report findings without changing files.",
    source: "builtin",
    sourcePath: "builtin:Explore",
    tools: ["Read", "Grep", "Glob"],
  },
  {
    name: "Plan",
    description: "Break down implementation work into a clear plan before edits.",
    prompt: "Create a concise implementation plan without changing files.",
    source: "builtin",
    sourcePath: "builtin:Plan",
    tools: ["Read", "Grep", "Glob"],
  },
  {
    name: "general-purpose",
    description: "Handle complex multi-step tasks that need exploration and action.",
    prompt: "Complete a complex multi-step task and summarize the result.",
    source: "builtin",
    sourcePath: "builtin:general-purpose",
    tools: ["*"],
  },
];

export async function loadClaudeAgents(options: LoadClaudeAgentsOptions): Promise<ClaudeAgent[]> {
  const userDirectory = join(options.homeDir ?? homedir(), ".claude", "agents");
  const groups = await Promise.all([
    loadClaudeAgentsFromDir(join(options.workDir, ".claude", "agents"), "project"),
    loadClaudeAgentsFromDir(userDirectory, "user"),
  ]);
  return resolveAgentConflicts([
    ...(options.includeBuiltins ? BUILTIN_AGENTS : []),
    ...groups.flat(),
  ]);
}

export function parseClaudeAgent(
  content: string,
  fallbackName: string,
  sourcePath: string,
  source: ClaudeAgentSource = "project",
): ClaudeAgent {
  const stripped = content.replace(/^\uFEFF/, "");
  const match = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  const frontmatter = parseFrontmatter(match?.[1] ?? "");
  const prompt = (match ? (match[2] ?? "") : stripped).trim();
  const name = normalizeString(frontmatter.name) || fallbackName;
  return {
    description: normalizeString(frontmatter.description),
    name,
    prompt,
    source,
    sourcePath,
    ...optionalString("model", frontmatter.model),
    ...optionalTools(frontmatter.tools),
    ...(frontmatter.hooks === undefined ? {} : { hooks: frontmatter.hooks }),
  };
}

export function summarizeClaudeAgents(
  agents: ClaudeAgent[],
  options: SummarizeClaudeAgentsOptions = {},
): ClaudeAgentSummary[] {
  return agents.map(({ description, model, name, source, sourcePath, tools }) => ({
    description,
    name,
    sourcePath,
    ...(options.includeSource ? { source } : {}),
    ...(tools === undefined ? {} : { tools }),
    ...(model === undefined ? {} : { model }),
  }));
}

export async function loadClaudeAgentsFromDir(
  agentsDirectory: string,
  source: ClaudeAgentSource,
): Promise<ClaudeAgent[]> {
  const rootStat = await stat(agentsDirectory).catch((error: unknown) => {
    if (isErrnoException(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!rootStat) return [];
  if (rootStat.isFile()) {
    if (!agentsDirectory.endsWith(".md") || rootStat.size > MAX_AGENT_FILE_BYTES) return [];
    const content = await readFile(agentsDirectory, "utf8");
    return [
      parseClaudeAgent(
        content,
        basename(agentsDirectory, ".md"),
        agentsDirectory,
        source,
      ),
    ];
  }

  let entries;
  try {
    entries = await readdir(agentsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return [];
    throw error;
  }
  const agents: ClaudeAgent[] = [];
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_AGENT_FILES);
  for (const entry of files) {
    const sourcePath = join(agentsDirectory, entry.name);
    const fileStat = await stat(sourcePath);
    if (fileStat.size > MAX_AGENT_FILE_BYTES) continue;
    const content = await readFile(sourcePath, "utf8");
    agents.push(parseClaudeAgent(content, basename(entry.name, ".md"), sourcePath, source));
  }
  return agents;
}

function resolveAgentConflicts(agents: ClaudeAgent[]): ClaudeAgent[] {
  const byName = new Map<string, ClaudeAgent>();
  for (const agent of agents) {
    const key = canonicalResourceName(agent.name);
    const current = byName.get(key);
    if (!current || AGENT_PRIORITIES[agent.source] > AGENT_PRIORITIES[current.source]) {
      byName.set(key, agent);
    }
  }
  return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const parsed = yaml.load(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function optionalTools(value: unknown): Partial<ClaudeAgent> {
  if (Array.isArray(value)) return { tools: value.map(normalizeString).filter(Boolean) };
  if (value === undefined) return {};
  const normalized = normalizeString(value);
  if (!normalized) return { tools: [] };
  return { tools: normalized.split(",").map((tool) => tool.trim()).filter(Boolean) };
}

function optionalString<Key extends keyof ClaudeAgent>(
  key: Key,
  value: unknown,
): Partial<Pick<ClaudeAgent, Key>> {
  const normalized = normalizeString(value);
  return normalized ? ({ [key]: normalized } as Partial<Pick<ClaudeAgent, Key>>) : {};
}

function normalizeString(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function isErrnoException(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}
