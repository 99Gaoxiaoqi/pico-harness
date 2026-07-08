import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as yaml from "js-yaml";

export type ClaudeAgentSource = "project" | "user";

export interface ClaudeAgent {
  name: string;
  description: string;
  prompt: string;
  sourcePath: string;
  source: ClaudeAgentSource;
  tools?: string[];
}

export interface ClaudeAgentSummary {
  name: string;
  description: string;
  sourcePath: string;
  tools?: string[];
}

export interface LoadClaudeAgentsOptions {
  workDir: string;
  homeDir?: string;
}

const AGENT_PRIORITIES: Record<ClaudeAgentSource, number> = {
  user: 10,
  project: 20,
};

export async function loadClaudeAgents(
  options: LoadClaudeAgentsOptions,
): Promise<ClaudeAgent[]> {
  const userDir = options.homeDir
    ? [join(options.homeDir ?? homedir(), ".claude", "agents")]
    : [];
  const groups = await Promise.all([
    loadAgentsFromDir(join(options.workDir, ".claude", "agents"), "project"),
    ...userDir.map((dir) => loadAgentsFromDir(dir, "user")),
  ]);

  return resolveAgentConflicts(groups.flat());
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
    ...optionalTools(frontmatter.tools),
  };
}

export function summarizeClaudeAgents(agents: ClaudeAgent[]): ClaudeAgentSummary[] {
  return agents.map(({ description, name, sourcePath, tools }) => ({
    description,
    name,
    sourcePath,
    ...(tools !== undefined ? { tools } : {}),
  }));
}

async function loadAgentsFromDir(
  agentsDir: string,
  source: ClaudeAgentSource,
): Promise<ClaudeAgent[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
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
    return parseSimpleFrontmatter(text);
  }
  return {};
}

function parseSimpleFrontmatter(text: string): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return frontmatter;
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
