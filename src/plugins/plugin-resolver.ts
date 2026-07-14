import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import type {
  PluginCompatibility,
  PluginConfigContribution,
  PluginConfigDeclaration,
  PluginContributionKind,
  PluginContributionSet,
  PluginDiagnostic,
  PluginManifest,
  PluginManifestSource,
  PluginPathContribution,
  PluginPathDeclaration,
  PluginResourceFingerprint,
  PluginScope,
  PluginVariableMap,
  ResolvedPluginIdentity,
} from "./plugin-types.js";

const MANIFEST_CANDIDATES = [
  { source: "pico-native", relativePath: ".pico/plugin.json" },
  { source: "claude-compatible", relativePath: ".claude-plugin/plugin.json" },
  { source: "legacy-root", relativePath: "plugin.json" },
] as const satisfies readonly {
  source: Exclude<PluginManifestSource, "manifestless">;
  relativePath: string;
}[];

const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MAX_RESOURCE_FILES = 20_000;
const MAX_RESOURCE_BYTES = 1024 * 1024 * 1024;
const MAX_RESOURCE_DEPTH = 64;
const EXCLUDED_RESOURCE_DIRS = new Set([".git"]);

export interface ResolvePluginContributionsOptions {
  readonly projectDir?: string;
  readonly picoHome?: string;
  readonly homeDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface ManifestResolution {
  readonly identity: ResolvedPluginIdentity;
  readonly manifest: PluginManifest;
  readonly diagnostics: PluginDiagnostic[];
}

/**
 * 将 Claude/Pico plugin 目录解析成与运行时无关的贡献快照。
 * blocked 结果不返回任何可激活贡献，避免宿主忽略诊断后部分加载。
 */
export async function resolvePluginContributions(
  pluginPath: string,
): Promise<PluginContributionSet> {
  const manifestResolution = await resolveManifest(pluginPath);
  const { identity, manifest, diagnostics } = manifestResolution;

  const resolvedContributions =
    compatibilityFromDiagnostics(diagnostics) === "blocked"
      ? emptyContributions()
      : await collectContributions(identity, manifest, diagnostics);

  let fingerprint: PluginResourceFingerprint | undefined;
  if (compatibilityFromDiagnostics(diagnostics) !== "blocked") {
    try {
      fingerprint = await fingerprintPluginResources(identity.root);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "error",
          "blocked",
          "plugin_resources_invalid",
          errorMessage(error),
          identity.root,
          "resources",
        ),
      );
    }
  }

  const contributions =
    compatibilityFromDiagnostics(diagnostics) === "blocked"
      ? emptyContributions()
      : resolvedContributions;

  return Object.freeze({
    plugin: identity,
    manifest,
    compatibility: compatibilityFromDiagnostics(diagnostics),
    diagnostics: Object.freeze([...diagnostics]),
    ...contributions,
    ...(fingerprint ? { fingerprint } : {}),
  });
}

/** 构建仅供 plugin 子进程使用的路径变量，兼容 Claude 名称但数据落在 PicoPaths。 */
export function createPluginVariableMap(
  plugin: Pick<ResolvedPluginIdentity, "id" | "root">,
  projectDir: string,
  options: Pick<ResolvePluginContributionsOptions, "picoHome" | "homeDir" | "env"> & {
    readonly scope: PluginScope;
  },
): PluginVariableMap {
  const paths = resolvePicoPaths(projectDir, options);
  const pluginData = join(
    paths.home.pluginData,
    options.scope,
    `${safePluginDataName(plugin.id)}-${createHash("sha256").update(plugin.id).digest("hex").slice(0, 16)}`,
  );
  return Object.freeze({
    CLAUDE_PLUGIN_ROOT: plugin.root,
    CLAUDE_PLUGIN_DATA: pluginData,
    CLAUDE_PROJECT_DIR: paths.canonicalWorkDir,
    PICO_PLUGIN_ROOT: plugin.root,
    PICO_PLUGIN_DATA: pluginData,
    PICO_PROJECT_DIR: paths.canonicalWorkDir,
  });
}

/** 只替换 Pico 明确授权的 plugin 路径变量，其他 `${ENV}` 原样保留。 */
export function substitutePluginVariables(value: string, variables: PluginVariableMap): string {
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/gu, (match, name: string) => {
    return Object.hasOwn(variables, name) ? variables[name as keyof PluginVariableMap] : match;
  });
}

/** 对 manifest inline MCP/LSP/Hook 配置做纯数据的路径变量映射。 */
export function substitutePluginVariablesDeep(
  value: unknown,
  variables: PluginVariableMap,
): unknown {
  if (typeof value === "string") return substitutePluginVariables(value, variables);
  if (Array.isArray(value))
    return value.map((item) => substitutePluginVariablesDeep(item, variables));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      substitutePluginVariablesDeep(item, variables),
    ]),
  );
}

/** 指纹覆盖 plugin 根目录下的全部运行资源（仅排除 VCS 元数据）。 */
export async function fingerprintPluginResources(
  pluginPath: string,
): Promise<PluginResourceFingerprint> {
  const root = await realpath(resolve(pluginPath));
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error(`Plugin root is not a directory: ${root}`);

  const files: ResourceFile[] = [];
  const visitedDirectories = new Set<string>();
  await walkResources(root, root, files, visitedDirectories, 0);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  if (files.length > MAX_RESOURCE_FILES) {
    throw new Error(`Plugin resource count exceeds ${MAX_RESOURCE_FILES}: ${root}`);
  }
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_RESOURCE_BYTES) {
    throw new Error(`Plugin resources exceed ${MAX_RESOURCE_BYTES} bytes: ${root}`);
  }

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    for await (const chunk of createReadStream(file.physicalPath)) hash.update(chunk);
    hash.update("\0");
  }
  return Object.freeze({
    algorithm: "sha256",
    digest: hash.digest("hex"),
    fileCount: files.length,
    totalBytes,
  });
}

async function resolveManifest(pluginPath: string): Promise<ManifestResolution> {
  const absolute = resolve(pluginPath);
  let root: string;
  try {
    root = await realpath(absolute);
  } catch (error) {
    root = absolute;
    const identity = fallbackIdentity(root, "manifestless");
    return {
      identity,
      manifest: { name: identity.name },
      diagnostics: [
        diagnostic(
          "error",
          "blocked",
          "plugin_root_missing",
          `Plugin directory not found: ${absolute}: ${errorMessage(error)}`,
          absolute,
          "manifest",
        ),
      ],
    };
  }
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) {
    const identity = fallbackIdentity(root, "manifestless");
    return {
      identity,
      manifest: { name: identity.name },
      diagnostics: [
        diagnostic(
          "error",
          "blocked",
          "plugin_root_not_directory",
          `Plugin root is not a directory: ${root}`,
          root,
          "manifest",
        ),
      ],
    };
  }

  let candidate:
    | { source: Exclude<PluginManifestSource, "manifestless">; path: string }
    | undefined;
  for (const item of MANIFEST_CANDIDATES) {
    const path = join(root, item.relativePath);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile()) {
      const physical = await realpath(path);
      if (!isWithin(root, physical)) {
        const identity = fallbackIdentity(root, item.source, path);
        return {
          identity,
          manifest: { name: identity.name },
          diagnostics: [
            diagnostic(
              "error",
              "blocked",
              "manifest_path_outside_root",
              `Plugin manifest symlink escapes plugin root: ${path} -> ${physical}`,
              path,
              "manifest",
            ),
          ],
        };
      }
      candidate = { source: item.source, path: physical };
      break;
    }
  }
  if (!candidate) {
    const identity = fallbackIdentity(root, "manifestless");
    return { identity, manifest: { name: identity.name }, diagnostics: [] };
  }

  const diagnostics: PluginDiagnostic[] = [];
  if (candidate.source === "legacy-root") {
    diagnostics.push(
      diagnostic(
        "warning",
        "degraded",
        "legacy_root_manifest",
        "Root plugin.json is supported for compatibility; prefer .pico/plugin.json.",
        candidate.path,
        "manifest",
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(candidate.path, "utf8"));
  } catch (error) {
    const identity = fallbackIdentity(root, candidate.source, candidate.path);
    diagnostics.push(
      diagnostic(
        "error",
        "blocked",
        "manifest_invalid_json",
        `Invalid plugin manifest JSON: ${errorMessage(error)}`,
        candidate.path,
        "manifest",
      ),
    );
    return { identity, manifest: { name: identity.name }, diagnostics };
  }
  if (!isRecord(parsed)) {
    const identity = fallbackIdentity(root, candidate.source, candidate.path);
    diagnostics.push(
      diagnostic(
        "error",
        "blocked",
        "manifest_not_object",
        "Plugin manifest must be a JSON object.",
        candidate.path,
        "manifest",
      ),
    );
    return { identity, manifest: { name: identity.name }, diagnostics };
  }

  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!name || !PLUGIN_NAME_PATTERN.test(name)) {
    const identity = fallbackIdentity(root, candidate.source, candidate.path);
    diagnostics.push(
      diagnostic(
        "error",
        "blocked",
        "manifest_name_invalid",
        "Plugin manifest requires a non-empty name using letters, numbers, dot, underscore or hyphen.",
        candidate.path,
        "manifest",
      ),
    );
    return { identity, manifest: { name: identity.name }, diagnostics };
  }
  const version = optionalNonEmptyString(parsed.version);
  if (parsed.version !== undefined && version === undefined) {
    diagnostics.push(
      diagnostic(
        "error",
        "blocked",
        "manifest_version_invalid",
        "Plugin manifest version must be a non-empty string when provided.",
        candidate.path,
        "manifest",
      ),
    );
  }

  validatePathDeclaration(parsed.skills, "skills", candidate.path, diagnostics);
  validatePathDeclaration(parsed.commands, "commands", candidate.path, diagnostics);
  validatePathDeclaration(parsed.agents, "agents", candidate.path, diagnostics);
  validateConfigDeclaration(parsed.hooks, "hooks", candidate.path, diagnostics);
  validateConfigDeclaration(parsed.mcpServers, "mcpServers", candidate.path, diagnostics);
  validateConfigDeclaration(parsed.lspServers, "lspServers", candidate.path, diagnostics);

  const manifest = {
    ...parsed,
    name,
    ...(version ? { version } : {}),
    ...(optionalNonEmptyString(parsed.displayName)
      ? { displayName: optionalNonEmptyString(parsed.displayName) }
      : {}),
    ...(optionalNonEmptyString(parsed.description)
      ? { description: optionalNonEmptyString(parsed.description) }
      : {}),
  } as PluginManifest;
  const identity: ResolvedPluginIdentity = Object.freeze({
    id: name,
    name,
    displayName: optionalNonEmptyString(parsed.displayName) ?? name,
    ...(version ? { version } : {}),
    ...(optionalNonEmptyString(parsed.description)
      ? { description: optionalNonEmptyString(parsed.description) }
      : {}),
    root,
    manifestPath: candidate.path,
    manifestSource: candidate.source,
  });
  return { identity, manifest, diagnostics };
}

async function collectContributions(
  identity: ResolvedPluginIdentity,
  manifest: PluginManifest,
  diagnostics: PluginDiagnostic[],
): Promise<ReturnType<typeof emptyContributions>> {
  const skills: PluginPathContribution[] = [];
  const commands: PluginPathContribution[] = [];
  const agents: PluginPathContribution[] = [];
  const hooks: PluginConfigContribution[] = [];
  const mcpServers: PluginConfigContribution[] = [];
  const lspServers: PluginConfigContribution[] = [];

  const defaultSkills = join(identity.root, "skills");
  const hasDefaultSkills = await addDefaultPath(
    identity,
    "skill",
    defaultSkills,
    skills,
    diagnostics,
  );
  await addDeclaredPaths(identity, "skill", manifest.skills, skills, diagnostics);
  if (!hasDefaultSkills && manifest.skills === undefined) {
    await addDefaultPath(
      identity,
      "skill",
      join(identity.root, "SKILL.md"),
      skills,
      diagnostics,
      "root-skill",
    );
  }

  if (manifest.commands === undefined) {
    await addDefaultPath(
      identity,
      "command",
      join(identity.root, "commands"),
      commands,
      diagnostics,
    );
  } else {
    await addDeclaredPaths(identity, "command", manifest.commands, commands, diagnostics);
  }
  if (manifest.agents === undefined) {
    await addDefaultPath(identity, "agent", join(identity.root, "agents"), agents, diagnostics);
  } else {
    await addDeclaredPaths(identity, "agent", manifest.agents, agents, diagnostics);
  }

  await addDefaultConfig(identity, "hook", join(identity.root, "hooks", "hooks.json"), hooks);
  await addConfigDeclaration(identity, "hook", manifest.hooks, hooks, diagnostics);
  await addDefaultConfig(identity, "mcp", join(identity.root, ".mcp.json"), mcpServers);
  await addConfigDeclaration(identity, "mcp", manifest.mcpServers, mcpServers, diagnostics);
  await addDefaultConfig(identity, "lsp", join(identity.root, ".lsp.json"), lspServers);
  await addConfigDeclaration(identity, "lsp", manifest.lspServers, lspServers, diagnostics);

  return Object.freeze({
    skills: Object.freeze(dedupePathContributions(skills)),
    commands: Object.freeze(dedupePathContributions(commands)),
    agents: Object.freeze(dedupePathContributions(agents)),
    hooks: Object.freeze(dedupeConfigContributions(hooks)),
    mcpServers: Object.freeze(dedupeConfigContributions(mcpServers)),
    lspServers: Object.freeze(dedupeConfigContributions(lspServers)),
  });
}

async function addDefaultPath(
  identity: ResolvedPluginIdentity,
  kind: "skill" | "command" | "agent",
  path: string,
  output: PluginPathContribution[],
  diagnostics: PluginDiagnostic[],
  origin: "default" | "root-skill" = "default",
): Promise<boolean> {
  const resolved = await resolveComponentPath(identity.root, path, false, kind, diagnostics);
  if (!resolved) return false;
  output.push(pathContribution(identity, kind, resolved, origin));
  return true;
}

async function addDeclaredPaths(
  identity: ResolvedPluginIdentity,
  kind: "skill" | "command" | "agent",
  declaration: PluginPathDeclaration | undefined,
  output: PluginPathContribution[],
  diagnostics: PluginDiagnostic[],
): Promise<void> {
  for (const raw of asPathArray(declaration)) {
    const candidate = manifestPath(identity, raw, kind, diagnostics);
    if (!candidate) continue;
    const resolved = await resolveComponentPath(identity.root, candidate, true, kind, diagnostics);
    if (resolved) output.push(pathContribution(identity, kind, resolved, "manifest"));
  }
}

async function addDefaultConfig(
  identity: ResolvedPluginIdentity,
  kind: "hook" | "mcp" | "lsp",
  path: string,
  output: PluginConfigContribution[],
): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return;
  const physical = await realpath(path);
  if (!isWithin(identity.root, physical)) return;
  output.push(configPathContribution(identity, kind, physical, "default"));
}

async function addConfigDeclaration(
  identity: ResolvedPluginIdentity,
  kind: "hook" | "mcp" | "lsp",
  declaration: PluginConfigDeclaration | undefined,
  output: PluginConfigContribution[],
  diagnostics: PluginDiagnostic[],
): Promise<void> {
  for (const item of asConfigArray(declaration)) {
    if (typeof item !== "string") {
      output.push(
        Object.freeze({
          kind,
          pluginId: identity.id,
          namespace: `${identity.id}:`,
          sourcePath: identity.manifestPath ?? identity.root,
          origin: "manifest",
          inline: deepFreezeClone(item),
        }),
      );
      continue;
    }
    const candidate = manifestPath(identity, item, kind, diagnostics);
    if (!candidate) continue;
    const resolved = await resolveComponentPath(
      identity.root,
      candidate,
      true,
      kind,
      diagnostics,
      true,
    );
    if (resolved) output.push(configPathContribution(identity, kind, resolved, "manifest"));
  }
}

async function resolveComponentPath(
  root: string,
  candidate: string,
  explicit: boolean,
  kind: PluginContributionKind,
  diagnostics: PluginDiagnostic[],
  requireFile = false,
): Promise<string | undefined> {
  let physical: string;
  try {
    physical = await realpath(candidate);
  } catch (error) {
    if (explicit) {
      diagnostics.push(
        diagnostic(
          "warning",
          "degraded",
          "component_path_missing",
          `Plugin ${kind} path is unavailable: ${candidate}: ${errorMessage(error)}`,
          candidate,
          kind,
        ),
      );
    }
    return undefined;
  }
  if (!isWithin(root, physical)) {
    diagnostics.push(
      diagnostic(
        "error",
        "blocked",
        "component_path_outside_root",
        `Plugin ${kind} path escapes plugin root: ${candidate} -> ${physical}`,
        candidate,
        kind,
      ),
    );
    return undefined;
  }
  const info = await stat(physical);
  if (requireFile && !info.isFile()) {
    diagnostics.push(
      diagnostic(
        "warning",
        "degraded",
        "component_path_not_file",
        `Plugin ${kind} config must be a file: ${candidate}`,
        candidate,
        kind,
      ),
    );
    return undefined;
  }
  if (!requireFile && !info.isFile() && !info.isDirectory()) return undefined;
  return physical;
}

function manifestPath(
  identity: ResolvedPluginIdentity,
  raw: string,
  kind: PluginContributionKind,
  diagnostics: PluginDiagnostic[],
): string | undefined {
  if (!raw.startsWith("./") || isAbsolute(raw)) {
    diagnostics.push(
      diagnostic(
        "error",
        "blocked",
        "component_path_not_relative",
        `Plugin ${kind} path must start with ./: ${raw}`,
        identity.manifestPath,
        kind,
      ),
    );
    return undefined;
  }
  const candidate = resolve(identity.root, raw);
  if (!isWithin(identity.root, candidate)) {
    diagnostics.push(
      diagnostic(
        "error",
        "blocked",
        "component_path_traversal",
        `Plugin ${kind} path escapes plugin root: ${raw}`,
        identity.manifestPath,
        kind,
      ),
    );
    return undefined;
  }
  return candidate;
}

interface ResourceFile {
  readonly relativePath: string;
  readonly physicalPath: string;
  readonly size: number;
}

async function walkResources(
  root: string,
  logicalDirectory: string,
  files: ResourceFile[],
  visitedDirectories: Set<string>,
  depth: number,
): Promise<void> {
  if (depth > MAX_RESOURCE_DEPTH) {
    throw new Error(`Plugin resource depth exceeds ${MAX_RESOURCE_DEPTH}: ${logicalDirectory}`);
  }
  const physicalDirectory = await realpath(logicalDirectory);
  if (!isWithin(root, physicalDirectory)) {
    throw new Error(`Plugin resource symlink escapes plugin root: ${logicalDirectory}`);
  }
  if (visitedDirectories.has(physicalDirectory)) return;
  visitedDirectories.add(physicalDirectory);

  const entries = await readdir(logicalDirectory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && EXCLUDED_RESOURCE_DIRS.has(entry.name)) continue;
    const logicalPath = join(logicalDirectory, entry.name);
    const info = await lstat(logicalPath);
    if (info.isSymbolicLink()) {
      const physical = await realpath(logicalPath);
      if (!isWithin(root, physical)) {
        throw new Error(
          `Plugin resource symlink escapes plugin root: ${logicalPath} -> ${physical}`,
        );
      }
      const targetInfo = await stat(physical);
      if (targetInfo.isDirectory()) {
        await walkResources(root, logicalPath, files, visitedDirectories, depth + 1);
      } else if (targetInfo.isFile()) {
        files.push(resourceFile(root, logicalPath, physical, targetInfo.size));
      }
    } else if (info.isDirectory()) {
      await walkResources(root, logicalPath, files, visitedDirectories, depth + 1);
    } else if (info.isFile()) {
      files.push(resourceFile(root, logicalPath, logicalPath, info.size));
    }
    if (files.length > MAX_RESOURCE_FILES) {
      throw new Error(`Plugin resource count exceeds ${MAX_RESOURCE_FILES}: ${root}`);
    }
  }
}

function resourceFile(root: string, logical: string, physical: string, size: number): ResourceFile {
  return {
    relativePath: relative(root, logical).split(sep).join("/"),
    physicalPath: physical,
    size,
  };
}

function pathContribution(
  identity: ResolvedPluginIdentity,
  kind: "skill" | "command" | "agent",
  path: string,
  origin: "default" | "manifest" | "root-skill",
): PluginPathContribution {
  return Object.freeze({
    kind,
    pluginId: identity.id,
    namespace: `${identity.id}:`,
    path,
    sourcePath: path,
    origin,
  });
}

function configPathContribution(
  identity: ResolvedPluginIdentity,
  kind: "hook" | "mcp" | "lsp",
  path: string,
  origin: "default" | "manifest",
): PluginConfigContribution {
  return Object.freeze({
    kind,
    pluginId: identity.id,
    namespace: `${identity.id}:`,
    path,
    sourcePath: path,
    origin,
  });
}

function dedupePathContributions(items: PluginPathContribution[]): PluginPathContribution[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeConfigContributions(items: PluginConfigContribution[]): PluginConfigContribution[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.path) return true;
    const key = `${item.kind}:${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyContributions() {
  return Object.freeze({
    skills: Object.freeze([] as PluginPathContribution[]),
    commands: Object.freeze([] as PluginPathContribution[]),
    agents: Object.freeze([] as PluginPathContribution[]),
    hooks: Object.freeze([] as PluginConfigContribution[]),
    mcpServers: Object.freeze([] as PluginConfigContribution[]),
    lspServers: Object.freeze([] as PluginConfigContribution[]),
  });
}

function fallbackIdentity(
  root: string,
  manifestSource: PluginManifestSource,
  manifestPath?: string,
): ResolvedPluginIdentity {
  const name = fallbackPluginName(root);
  return Object.freeze({
    id: name,
    name,
    displayName: name,
    root,
    ...(manifestPath ? { manifestPath } : {}),
    manifestSource,
  });
}

function fallbackPluginName(root: string): string {
  const candidate = basename(root)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return candidate || "plugin";
}

function safePluginDataName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/gu, "-") || "plugin";
}

function validatePathDeclaration(
  value: unknown,
  field: string,
  manifestPath: string,
  diagnostics: PluginDiagnostic[],
): void {
  if (value === undefined) return;
  if (typeof value === "string") return;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return;
  diagnostics.push(
    diagnostic(
      "error",
      "blocked",
      "manifest_component_type_invalid",
      `Plugin manifest ${field} must be a string or string array.`,
      manifestPath,
      "manifest",
    ),
  );
}

function validateConfigDeclaration(
  value: unknown,
  field: string,
  manifestPath: string,
  diagnostics: PluginDiagnostic[],
): void {
  if (value === undefined || typeof value === "string" || isRecord(value)) return;
  if (Array.isArray(value) && value.every((item) => typeof item === "string" || isRecord(item))) {
    return;
  }
  diagnostics.push(
    diagnostic(
      "error",
      "blocked",
      "manifest_config_type_invalid",
      `Plugin manifest ${field} must be a path, object, or an array of paths/objects.`,
      manifestPath,
      "manifest",
    ),
  );
}

function asPathArray(value: PluginPathDeclaration | undefined): readonly string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function asConfigArray(
  value: PluginConfigDeclaration | undefined,
): readonly (string | Readonly<Record<string, unknown>>)[] {
  if (typeof value === "string" || isRecord(value)) return [value];
  return Array.isArray(value) && value.every((item) => typeof item === "string" || isRecord(item))
    ? value
    : [];
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compatibilityFromDiagnostics(
  diagnostics: readonly PluginDiagnostic[],
): PluginCompatibility {
  if (diagnostics.some((item) => item.compatibility === "blocked")) return "blocked";
  if (diagnostics.some((item) => item.compatibility === "degraded")) return "degraded";
  return "compatible";
}

function diagnostic(
  severity: PluginDiagnostic["severity"],
  compatibility: PluginCompatibility,
  code: string,
  message: string,
  path?: string,
  component?: PluginDiagnostic["component"],
): PluginDiagnostic {
  return Object.freeze({
    severity,
    compatibility,
    code,
    message,
    ...(path ? { path } : {}),
    ...(component ? { component } : {}),
  });
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function deepFreezeClone(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return deepFreeze(structuredClone(value)) as Readonly<Record<string, unknown>>;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
