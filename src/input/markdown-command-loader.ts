import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import * as yaml from "js-yaml";
import type { SkillLoader } from "../context/skill.js";
import { parseCommandArgs } from "./slash-parser.js";
import { renderSkillActivation } from "./skill-activation.js";

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
const NON_COMMAND_DIRS = new Set([
  "README",
  "readme",
  "resources",
  "references",
  "workflows",
  "templates",
  "agents",
  "node_modules",
]);

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
  const { frontmatter, prompt } = parseMarkdownContent(content);

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
  command: Pick<MarkdownPromptCommand, "prompt"> &
    Partial<Pick<MarkdownPromptCommand, "name" | "source" | "sourcePath">>,
  args: string,
): string {
  if (command.source === "skill" && command.name) {
    return renderSkillActivation({
      name: command.name,
      args,
      body: command.prompt,
      sourcePath: command.sourcePath,
      trigger: "user-slash",
    }).prompt;
  }

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
  let entries;
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
      if (NON_COMMAND_DIRS.has(entry.name)) continue;
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
  const skillBaseDirs = [
    join(options.workDir, ".claude", "skills"),
    join(options.workDir, ".claw", "skills"),
  ];
  const skillFiles = (await Promise.all(skillBaseDirs.map(walkSkillMarkdownFiles))).flat();
  const commands: MarkdownPromptCommand[] = [];

  for (const sourcePath of skillFiles) {
    const content = await readFile(sourcePath, "utf8");
    const fallbackName = basename(dirname(sourcePath));
    const command = parseSkillProjectionCommand(content, fallbackName, sourcePath);
    if (command) commands.push(command);
  }

  return commands;
}

async function walkSkillMarkdownFiles(dir: string): Promise<string[]> {
  let entries;
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
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      files.push(...(await walkSkillMarkdownFiles(path)));
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(path);
    }
  }
  return files;
}

function parseSkillProjectionCommand(
  content: string,
  fallbackName: string,
  sourcePath: string,
): MarkdownPromptCommand | undefined {
  const { frontmatter, prompt } = parseMarkdownContent(content);
  const name = normalizeString(frontmatter.name) || fallbackName;
  if (!COMMAND_NAME_PATTERN.test(name)) return undefined;

  return {
    description: normalizeString(frontmatter.description),
    name,
    priority: COMMAND_PRIORITIES.skill,
    prompt,
    source: "skill",
    sourcePath,
    ...optionalString("argumentHint", frontmatter["argument-hint"]),
    ...optionalString("model", frontmatter.model),
    ...optionalAllowedTools(frontmatter["allowed-tools"]),
  };
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

function parseMarkdownContent(content: string): {
  frontmatter: Record<string, unknown>;
  prompt: string;
} {
  const stripped = content.replace(/^\uFEFF/, "");
  const match = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  const frontmatterText = match?.[1] ?? "";
  return {
    frontmatter: parseFrontmatter(frontmatterText),
    prompt: (match ? (match[2] ?? "") : stripped).trim(),
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
