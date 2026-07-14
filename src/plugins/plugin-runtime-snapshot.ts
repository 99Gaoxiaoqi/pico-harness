import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { AgentExternalCatalogSource } from "../agents/catalog.js";
import type { ExternalResourceCatalogSource } from "../catalog/resource-catalog.js";
import type { LspServerConfig } from "../code-intelligence/index.js";
import type { HookConfigSourceSpec } from "../hooks/config.js";
import type { McpConfigSource } from "../mcp/manager.js";
import type { McpConfig, McpServerConfig } from "../mcp/types.js";
import { PluginManagementService } from "./plugin-management-service.js";
import { createPluginVariableMap, substitutePluginVariablesDeep } from "./plugin-resolver.js";
import type {
  PluginConfigContribution,
  PluginContributionSet,
  PluginPathContribution,
  PluginScope,
} from "./plugin-types.js";

const MAX_PLUGIN_CONFIG_BYTES = 1024 * 1024;

export interface PluginRuntimeSnapshotOptions {
  readonly workDir: string;
  readonly service?: PluginManagementService;
  readonly picoHome?: string;
  readonly homeDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface PluginRuntimeDiagnostic {
  readonly pluginId: string;
  readonly sourcePath: string;
  readonly message: string;
}

/** One immutable startup projection of already enabled and trusted plugins. */
export interface PluginRuntimeSnapshot {
  readonly pluginIds: readonly string[];
  readonly skillSources: readonly ExternalResourceCatalogSource[];
  readonly commandSources: readonly ExternalResourceCatalogSource[];
  readonly agentSources: readonly AgentExternalCatalogSource[];
  readonly hookSources: readonly HookConfigSourceSpec[];
  readonly mcpSources: readonly McpConfigSource[];
  readonly lspServers: readonly LspServerConfig[];
  readonly diagnostics: readonly PluginRuntimeDiagnostic[];
}

export async function loadPluginRuntimeSnapshot(
  options: PluginRuntimeSnapshotOptions,
): Promise<PluginRuntimeSnapshot> {
  const service = options.service ?? new PluginManagementService(options);
  const active = (await service.list()).filter((plugin) => plugin.active);
  const skillSources: ExternalResourceCatalogSource[] = [];
  const commandSources: ExternalResourceCatalogSource[] = [];
  const agentSources: AgentExternalCatalogSource[] = [];
  const hookSources: HookConfigSourceSpec[] = [];
  const mcpSources: McpConfigSource[] = [];
  const lspServers: LspServerConfig[] = [];
  const diagnostics: PluginRuntimeDiagnostic[] = [];

  for (const inspection of active) {
    const { contributions, installed } = inspection;
    const priority = pluginPriority(installed.scope);
    skillSources.push(...pathSources(contributions, contributions.skills, "skill", priority));
    commandSources.push(...pathSources(contributions, contributions.commands, "command", priority));
    agentSources.push(...(await agentPathSources(contributions, contributions.agents, priority)));
    const variables = createPluginVariableMap(contributions.plugin, options.workDir, {
      ...options,
      scope: installed.scope,
    });

    for (const contribution of contributions.hooks) {
      try {
        const value = unwrap(await readPluginConfig(contribution, variables), "hooks");
        hookSources.push({
          kind: "plugin",
          path: contribution.sourcePath,
          componentId: contributions.plugin.id,
          inlineHooks: value,
        });
      } catch (error) {
        diagnostics.push(runtimeDiagnostic(contributions, contribution, error));
      }
    }
    for (const contribution of contributions.mcpServers) {
      try {
        mcpSources.push({
          id: contributionId(contributions.plugin.id, "mcp", contribution, mcpSources.length),
          config: namespaceMcpConfig(
            contributions.plugin.id,
            await readPluginConfig(contribution, variables),
          ),
        });
      } catch (error) {
        diagnostics.push(runtimeDiagnostic(contributions, contribution, error));
      }
    }
    for (const contribution of contributions.lspServers) {
      try {
        lspServers.push(
          ...parseLspServers(
            contributions.plugin.id,
            await readPluginConfig(contribution, variables),
          ),
        );
      } catch (error) {
        diagnostics.push(runtimeDiagnostic(contributions, contribution, error));
      }
    }
  }

  return Object.freeze({
    pluginIds: Object.freeze(active.map(({ installed }) => installed.id)),
    skillSources: Object.freeze(skillSources),
    commandSources: Object.freeze(commandSources),
    agentSources: Object.freeze(agentSources),
    hookSources: Object.freeze(hookSources),
    mcpSources: Object.freeze(mcpSources),
    lspServers: Object.freeze(lspServers),
    diagnostics: Object.freeze(diagnostics),
  });
}

function pathSources(
  plugin: PluginContributionSet,
  contributions: readonly PluginPathContribution[],
  kind: "skill" | "command",
  priority: number,
): ExternalResourceCatalogSource[] {
  return contributions.map((contribution, index) => ({
    id: contributionId(plugin.plugin.id, kind, contribution, index),
    scope: "external",
    format: "external",
    root: contribution.path,
    priority,
    namespace: contribution.namespace,
  }));
}

async function agentPathSources(
  plugin: PluginContributionSet,
  contributions: readonly PluginPathContribution[],
  priority: number,
): Promise<AgentExternalCatalogSource[]> {
  return await Promise.all(
    contributions.map(async (contribution, index) => ({
      id: contributionId(plugin.plugin.id, "agent", contribution, index),
      scope: "external" as const,
      format: "external" as const,
      root: contribution.path,
      priority,
      namespace: contribution.namespace,
      adapter: (await isYamlFile(contribution.path))
        ? ("pico-agent-yaml" as const)
        : ("claude-agent-directory" as const),
    })),
  );
}

async function readPluginConfig(
  contribution: PluginConfigContribution,
  variables: ReturnType<typeof createPluginVariableMap>,
): Promise<unknown> {
  const raw =
    contribution.inline ??
    (contribution.path ? await readBoundedJson(contribution.path) : undefined);
  if (raw === undefined) throw new Error("Plugin 配置贡献缺少 path 或 inline 内容");
  return substitutePluginVariablesDeep(raw, variables);
}

async function readBoundedJson(path: string): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Plugin 配置不是普通文件");
  if (info.size > MAX_PLUGIN_CONFIG_BYTES) {
    throw new Error(`Plugin 配置超过 ${MAX_PLUGIN_CONFIG_BYTES} bytes`);
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function namespaceMcpConfig(pluginId: string, input: unknown): McpConfig {
  const root = requireRecord(input, "MCP 配置顶层必须是对象");
  const servers = requireRecord(root["mcpServers"] ?? root, "mcpServers 必须是对象");
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(servers)) {
    const server = requireRecord(value, `MCP server ${name} 必须是对象`);
    mcpServers[`${pluginId}:${name}`] = server as unknown as McpServerConfig;
  }
  return { mcpServers };
}

function parseLspServers(pluginId: string, input: unknown): LspServerConfig[] {
  const root = requireRecord(input, "LSP 配置顶层必须是对象");
  const value = root["lspServers"] ?? root["servers"] ?? root;
  const candidates: Array<{ id?: string; server: unknown }> = Array.isArray(value)
    ? value.map((server) => ({ server }))
    : Object.entries(requireRecord(value, "LSP servers 必须是数组或对象")).map(([id, server]) => ({
        id,
        server,
      }));
  return candidates.map(({ id, server }, index) => {
    const config = requireRecord(server, `LSP server ${id ?? index} 必须是对象`);
    const rawId = optionalString(config["id"]) ?? id;
    const command = optionalString(config["command"]);
    if (!rawId || !command) throw new Error(`LSP server ${id ?? index} 缺少 id 或 command`);
    return {
      id: `${pluginId}:${rawId}`,
      command,
      ...optionalStringArrayField(config, "args"),
      ...optionalStringMapField(config, "env"),
      ...optionalStringArrayField(config, "languages"),
      ...optionalPositiveIntegerField(config, "requestTimeoutMs"),
      ...optionalPositiveIntegerField(config, "startupTimeoutMs"),
    } satisfies LspServerConfig;
  });
}

function unwrap(value: unknown, field: string): unknown {
  return isRecord(value) && Object.hasOwn(value, field) ? value[field] : value;
}

function pluginPriority(scope: PluginScope): number {
  if (scope === "local") return 38;
  if (scope === "project") return 35;
  return 15;
}

async function isYamlFile(path: string): Promise<boolean> {
  const info = await stat(path);
  return info.isFile() && [".yaml", ".yml"].includes(extname(path).toLowerCase());
}

function contributionId(
  pluginId: string,
  kind: string,
  contribution: Pick<PluginPathContribution | PluginConfigContribution, "origin">,
  index: number,
): string {
  return `plugin:${pluginId}:${kind}:${contribution.origin}:${index}`;
}

function runtimeDiagnostic(
  plugin: PluginContributionSet,
  contribution: PluginConfigContribution,
  error: unknown,
): PluginRuntimeDiagnostic {
  return {
    pluginId: plugin.plugin.id,
    sourcePath: contribution.path ?? contribution.sourcePath,
    message: error instanceof Error ? error.message : String(error),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArrayField(
  record: Readonly<Record<string, unknown>>,
  field: "args" | "languages",
): Partial<LspServerConfig> {
  const value = record[field];
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`LSP ${field} 必须是字符串数组`);
  }
  return { [field]: value };
}

function optionalStringMapField(
  record: Readonly<Record<string, unknown>>,
  field: "env",
): Partial<LspServerConfig> {
  const value = record[field];
  if (value === undefined) return {};
  const map = requireRecord(value, `LSP ${field} 必须是字符串对象`);
  if (Object.values(map).some((item) => typeof item !== "string")) {
    throw new Error(`LSP ${field} 必须是字符串对象`);
  }
  return { [field]: map as Readonly<Record<string, string>> };
}

function optionalPositiveIntegerField(
  record: Readonly<Record<string, unknown>>,
  field: "requestTimeoutMs" | "startupTimeoutMs",
): Partial<LspServerConfig> {
  const value = record[field];
  if (value === undefined) return {};
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`LSP ${field} 必须是正整数`);
  }
  return { [field]: value as number };
}

function requireRecord(value: unknown, message: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
