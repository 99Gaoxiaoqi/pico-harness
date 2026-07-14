import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import * as yaml from "js-yaml";
import { SkillLoader, type Skill } from "../context/skill.js";
import { mapClaudeToolNames } from "../catalog/claude-compat.js";
import {
  resolveResourceCatalog,
  type ExternalResourceCatalogSource,
  type ResourceCatalogSource,
} from "../catalog/resource-catalog.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { parseCommandArgs } from "./slash-parser.js";
import { renderSkillActivation } from "./skill-activation.js";

export type MarkdownCommandSource = "project" | "user" | "skill" | "builtin" | "external";

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
  hooks?: unknown;
  catalogSource?: ResourceCatalogSource;
}

export interface LoadMarkdownCommandsOptions {
  workDir: string;
  /** Absolute project command directory loaded from .pico/config.json. */
  projectCommandsDir?: string;
  userCommandsDir?: string;
  homeDir?: string;
  includeSkillCommands?: boolean;
  skillLoader?: SkillLoader;
  builtinNames?: Iterable<string>;
  /** 由 Plugin 管理层预先验证边界后显式注入，Catalog 不自行发现 Plugin。 */
  externalSources?: readonly ExternalResourceCatalogSource[];
}

const COMMAND_PRIORITIES: Record<MarkdownCommandSource, number> = {
  // 内置命令包含权限/会话等安全入口，不允许 Markdown 资源遮蔽。
  builtin: 100,
  skill: 10,
  user: 30,
  project: 50,
  external: 15,
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
  const paths = resolvePicoPaths(options.workDir, { homeDir: home, env: process.env });
  const commandSources: Array<{
    source: MarkdownCommandSource;
    catalogSource: ResourceCatalogSource;
  }> = [
    commandSource(
      "project-pico",
      "project",
      "pico-native",
      options.projectCommandsDir ?? paths.project.commands,
      50,
    ),
    commandSource(
      "project-claude",
      "project",
      "claude-compat",
      join(options.workDir, ".claude", "commands"),
      40,
    ),
  ];
  commandSources.push(
    commandSource(
      "user-pico",
      "user",
      "pico-native",
      options.userCommandsDir ?? paths.home.commands,
      30,
    ),
    ...(options.userCommandsDir && options.homeDir === undefined
      ? []
      : [
          commandSource(
            "user-claude",
            "user",
            "claude-compat",
            join(home, ".claude", "commands"),
            20,
          ),
        ]),
    ...(options.externalSources ?? []).map((catalogSource) => ({
      source: "external" as const,
      catalogSource,
    })),
  );

  const commandGroups = await Promise.all([
    ...commandSources.map(({ source, catalogSource }) =>
      loadCommandsFromDir(catalogSource.root, source, catalogSource),
    ),
    options.includeSkillCommands ? loadSkillProjectionCommands(options) : Promise.resolve([]),
  ]);

  const builtinCommands = Array.from(options.builtinNames ?? [], (name) =>
    makeBuiltinPlaceholder(name),
  );
  return resolveMarkdownCommandConflicts([...builtinCommands, ...commandGroups.flat()]);
}

export function parseMarkdownCommand(
  content: string,
  name: string,
  source: MarkdownCommandSource,
  sourcePath?: string,
  catalogSource?: ResourceCatalogSource,
): MarkdownPromptCommand {
  const { frontmatter, prompt } = parseMarkdownContent(content);
  const allowedTools = optionalAllowedTools(frontmatter).allowedTools;
  const normalizedAllowedTools = normalizeAllowedTools(
    allowedTools,
    catalogSource,
    name,
    sourcePath,
  );

  return {
    description: normalizeString(frontmatter.description),
    name,
    priority: catalogSource?.priority ?? COMMAND_PRIORITIES[source],
    prompt,
    source,
    ...(sourcePath ? { sourcePath } : {}),
    ...optionalString("argumentHint", frontmatter["argument-hint"]),
    ...optionalString("model", frontmatter.model),
    ...(normalizedAllowedTools === undefined ? {} : { allowedTools: normalizedAllowedTools }),
    ...(catalogSource ? { catalogSource } : {}),
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
  const resolved = resolveResourceCatalog(
    commands.map((command) => ({
      name: command.name,
      source:
        command.catalogSource ??
        commandSource(
          `command-${command.source}`,
          command.source,
          command.source === "builtin" ? "builtin" : "external",
          command.sourcePath ?? `command:${command.name}`,
          command.priority,
        ).catalogSource,
      sourcePath: command.sourcePath ?? `command:${command.name}`,
      value: command,
    })),
  );
  return [...resolved.entries]
    .filter((command) => command.source !== "builtin")
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function loadCommandsFromDir(
  commandsDir: string,
  source: MarkdownCommandSource,
  catalogSource: ResourceCatalogSource,
): Promise<MarkdownPromptCommand[]> {
  const files = await walkMarkdownFiles(commandsDir);
  const commands: MarkdownPromptCommand[] = [];
  for (const sourcePath of files) {
    const name = `${catalogSource.namespace ?? ""}${commandNameFromPath(commandsDir, sourcePath)}`;
    if (!COMMAND_PATH_PATTERN.test(name)) continue;
    const content = await readFile(sourcePath, "utf8");
    commands.push(parseMarkdownCommand(content, name, source, sourcePath, catalogSource));
  }
  return commands;
}

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const rootStat = await stat(dir).catch((err: unknown) => {
    if (isErrnoException(err, "ENOENT")) return undefined;
    throw err;
  });
  if (!rootStat) return [];
  if (rootStat.isFile()) return dir.endsWith(".md") ? [dir] : [];
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
  if (!rel) return basename(sourcePath, ".md");
  const withoutExt = rel.slice(0, -".md".length);
  return withoutExt.split(sep).join(":");
}

async function loadSkillProjectionCommands(
  options: LoadMarkdownCommandsOptions,
): Promise<MarkdownPromptCommand[]> {
  const loader =
    options.skillLoader ?? new SkillLoader(options.workDir, { homeDir: options.homeDir });
  return (await loader.list()).flatMap((skill) => {
    const command = parseSkillProjectionCommand(skill);
    return command ? [command] : [];
  });
}

function parseSkillProjectionCommand(skill: Skill): MarkdownPromptCommand | undefined {
  const name = skill.name;
  if (!COMMAND_NAME_PATTERN.test(name)) return undefined;

  return {
    description: skill.description,
    name,
    priority: COMMAND_PRIORITIES.skill,
    prompt: skill.body,
    source: "skill",
    sourcePath: skill.sourcePath,
    ...(skill.argumentHint === undefined ? {} : { argumentHint: skill.argumentHint }),
    ...(skill.model === undefined ? {} : { model: skill.model }),
    ...(skill.allowedTools === undefined ? {} : { allowedTools: skill.allowedTools }),
    ...(skill.hooks === undefined ? {} : { hooks: skill.hooks }),
    ...(skill.source
      ? { catalogSource: { ...skill.source, priority: COMMAND_PRIORITIES.skill } }
      : {}),
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

function commandSource(
  id: string,
  source: MarkdownCommandSource,
  format: ResourceCatalogSource["format"],
  root: string,
  priority: number,
): { source: MarkdownCommandSource; catalogSource: ResourceCatalogSource } {
  const scope: ResourceCatalogSource["scope"] =
    source === "builtin"
      ? "builtin"
      : source === "external"
        ? "external"
        : source === "user"
          ? "user"
          : "project";
  return { source, catalogSource: { id, scope, format, root, priority } };
}

function normalizeAllowedTools(
  tools: string[] | undefined,
  source: ResourceCatalogSource | undefined,
  resource: string,
  sourcePath: string | undefined,
): string[] | undefined {
  if (tools === undefined || source?.format !== "claude-compat") return tools;
  const mapped = mapClaudeToolNames(tools, { resource, sourcePath });
  return [...mapped.tools, ...mapped.unknown];
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

function optionalString(
  key: "argumentHint" | "model",
  value: unknown,
): Partial<MarkdownPromptCommand> {
  const normalized = normalizeString(value);
  return normalized ? { [key]: normalized } : {};
}

function optionalAllowedTools(
  frontmatter: Record<string, unknown>,
): Partial<MarkdownPromptCommand> {
  if (!Object.hasOwn(frontmatter, "allowed-tools")) return {};
  const value = frontmatter["allowed-tools"];
  if (Array.isArray(value)) {
    return { allowedTools: value.map(normalizeString) };
  }
  const normalized = normalizeString(value);
  if (!normalized) return { allowedTools: [""] };
  return {
    allowedTools: normalized.split(",").map((tool) => tool.trim()),
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
