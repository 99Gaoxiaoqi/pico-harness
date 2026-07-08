import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import * as yaml from "js-yaml";
import { SkillLoader } from "../context/skill.js";
import { parseCommandArgs } from "./slash-parser.js";

export type MarkdownCommandSource = "project" | "user" | "skill" | "builtin";

export interface MarkdownPromptCommand {
  name: string;
  description: string;
  prompt: string;
  source: MarkdownCommandSource;
  priority: number;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  sourcePath?: string;
}

export interface LoadMarkdownCommandsOptions {
  workDir: string;
  userCommandsDir?: string;
  homeDir?: string;
  includeSkillCommands?: boolean;
  skillLoader?: SkillLoader;
  builtinNames?: Iterable<string>;
}

const COMMAND_PRIORITIES: Record<MarkdownCommandSource, number> = {
  builtin: 0,
  skill: 10,
  user: 20,
  project: 30,
};

const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const COMMAND_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

export async function loadMarkdownCommands(
  options: LoadMarkdownCommandsOptions,
): Promise<MarkdownPromptCommand[]> {
  const home = options.homeDir ?? homedir();
  const projectCommandsDirs = [
    join(options.workDir, ".pico", "commands"),
    join(options.workDir, ".claude", "commands"),
  ];
  const userCommandsDirs = options.userCommandsDir
    ? [options.userCommandsDir, ...(options.homeDir ? [join(home, ".claude", "commands")] : [])]
    : [join(home, ".pico", "commands"), join(home, ".claude", "commands")];

  const commandGroups = await Promise.all([
    loadCommandsFromDirs(projectCommandsDirs, "project"),
    loadCommandsFromDirs(userCommandsDirs, "user"),
    options.includeSkillCommands ? loadSkillProjectionCommands(options) : Promise.resolve([]),
  ]);

  const builtinCommands = Array.from(options.builtinNames ?? [], (name) =>
    makeBuiltinPlaceholder(name),
  );
  return resolveMarkdownCommandConflicts([
    ...builtinCommands,
    ...commandGroups[2],
    ...commandGroups[1],
    ...commandGroups[0],
  ]);
}

export function parseMarkdownCommand(
  content: string,
  name: string,
  source: MarkdownCommandSource,
  sourcePath?: string,
): MarkdownPromptCommand {
  const stripped = content.replace(/^\uFEFF/, "");
  const match = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  const frontmatterText = match?.[1] ?? "";
  const prompt = (match ? (match[2] ?? "") : stripped).trim();
  const frontmatter = parseFrontmatter(frontmatterText);

  return {
    description: normalizeString(frontmatter.description),
    name,
    priority: COMMAND_PRIORITIES[source],
    prompt,
    source,
    ...(sourcePath ? { sourcePath } : {}),
    ...optionalString("argumentHint", frontmatter["argument-hint"]),
    ...optionalString("model", frontmatter.model),
    ...optionalAllowedTools(frontmatter["allowed-tools"]),
  };
}

export function renderMarkdownCommandPrompt(
  command: Pick<MarkdownPromptCommand, "prompt">,
  args: string,
): string {
  const trimmedArgs = args.trim();
  const argv = parseCommandArgs(trimmedArgs);
  return command.prompt
    .replace(/\$(\d+)/g, (_match, rawIndex: string) => argv[Number(rawIndex) - 1] ?? "")
    .replaceAll("$ARGUMENTS", trimmedArgs);
}

export function resolveMarkdownCommandConflicts(
  commands: MarkdownPromptCommand[],
): MarkdownPromptCommand[] {
  const byName = new Map<string, MarkdownPromptCommand>();
  for (const command of commands) {
    const current = byName.get(command.name);
    if (!current || command.priority > current.priority) {
      byName.set(command.name, command);
    }
  }

  return Array.from(byName.values())
    .filter((command) => command.source !== "builtin")
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function loadCommandsFromDirs(
  commandsDirs: string[],
  source: MarkdownCommandSource,
): Promise<MarkdownPromptCommand[]> {
  const groups = await Promise.all(commandsDirs.map((dir) => loadCommandsFromDir(dir, source)));
  return groups.flat();
}

async function loadCommandsFromDir(
  commandsDir: string,
  source: MarkdownCommandSource,
): Promise<MarkdownPromptCommand[]> {
  const files = await walkMarkdownFiles(commandsDir);
  const commands: MarkdownPromptCommand[] = [];
  for (const sourcePath of files) {
    const name = commandNameFromPath(commandsDir, sourcePath);
    if (!COMMAND_PATH_PATTERN.test(name)) continue;
    const content = await readFile(sourcePath, "utf8");
    commands.push(parseMarkdownCommand(content, name, source, sourcePath));
  }
  return commands;
}

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isErrnoException(err, "ENOENT")) return [];
    throw err;
  }

  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

function commandNameFromPath(commandsDir: string, sourcePath: string): string {
  const rel = relative(commandsDir, sourcePath);
  const withoutExt = rel.slice(0, -".md".length);
  return withoutExt.split(sep).join(":");
}

async function loadSkillProjectionCommands(
  options: LoadMarkdownCommandsOptions,
): Promise<MarkdownPromptCommand[]> {
  const loader = options.skillLoader ?? new SkillLoader(options.workDir);
  const summaries = await loader.listSummaries();
  const commands: MarkdownPromptCommand[] = [];

  for (const summary of summaries) {
    if (!COMMAND_NAME_PATTERN.test(summary.name)) continue;
    const body = await loader.viewBody(summary.name);
    if (body === undefined) continue;
    const sourcePath = await loader.viewSourcePath(summary.name);
    commands.push({
      description: summary.description,
      name: summary.name,
      priority: COMMAND_PRIORITIES.skill,
      prompt: body,
      source: "skill",
      ...(sourcePath ? { sourcePath } : {}),
    });
  }

  return commands;
}

function makeBuiltinPlaceholder(name: string): MarkdownPromptCommand {
  return {
    description: "",
    name,
    priority: COMMAND_PRIORITIES.builtin,
    prompt: "",
    source: "builtin",
  };
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

function normalizeString(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function optionalString(key: "argumentHint" | "model", value: unknown): Partial<MarkdownPromptCommand> {
  const normalized = normalizeString(value);
  return normalized ? { [key]: normalized } : {};
}

function optionalAllowedTools(value: unknown): Partial<MarkdownPromptCommand> {
  if (Array.isArray(value)) {
    const allowedTools = value.map(normalizeString).filter(Boolean);
    return allowedTools.length > 0 ? { allowedTools } : {};
  }
  const normalized = normalizeString(value);
  if (!normalized) return {};
  return {
    allowedTools: normalized
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean),
  };
}

function isErrnoException(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}
