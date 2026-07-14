import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as yaml from "js-yaml";

export type ClaudeAgentSource = "builtin" | "project" | "user";

export interface ClaudeAgent {
  name: string;
  description: string;
  prompt: string;
  sourcePath: string;
  source: ClaudeAgentSource;
  tools?: string[];
  hooks?: unknown;
  /** Claude frontmatter 的 model 值；运行时再解析为 Pico model route。 */
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
  const userDir = options.homeDir ? [join(options.homeDir ?? homedir(), ".claude", "agents")] : [];
  const groups = await Promise.all([
    loadAgentsFromDir(join(options.workDir, ".claude", "agents"), "project"),
    ...userDir.map((dir) => loadAgentsFromDir(dir, "user")),
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
    ...(tools !== undefined ? { tools } : {}),
    ...(model !== undefined ? { model } : {}),
  }));
}

async function loadAgentsFromDir(
  agentsDir: string,
  source: ClaudeAgentSource,
): Promise<ClaudeAgent[]> {
  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch (err) {
    if (isErrnoException(err, "ENOENT")) return [];
    throw err;
  }

  const agents: ClaudeAgent[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const sourcePath = join(agentsDir, entry.name);
    const content = await readFile(sourcePath, "utf8");
    agents.push(parseClaudeAgent(content, basename(entry.name, ".md"), sourcePath, source));
  }
  return agents;
}

function resolveAgentConflicts(agents: ClaudeAgent[]): ClaudeAgent[] {
  const byName = new Map<string, ClaudeAgent>();
  for (const agent of agents) {
    const current = byName.get(agent.name);
    if (!current || AGENT_PRIORITIES[agent.source] > AGENT_PRIORITIES[current.source]) {
      byName.set(agent.name, agent);
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
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
  if (Array.isArray(value)) {
    const tools = value.map(normalizeString).filter(Boolean);
    return tools.length > 0 ? { tools } : {};
  }
  const normalized = normalizeString(value);
  if (!normalized) return {};
  return {
    tools: normalized
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean),
  };
}

function optionalString<K extends keyof ClaudeAgent>(
  key: K,
  value: unknown,
): Partial<Pick<ClaudeAgent, K>> {
  const normalized = normalizeString(value);
  return normalized ? ({ [key]: normalized } as Partial<Pick<ClaudeAgent, K>>) : {};
}

function normalizeString(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function isErrnoException(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}
