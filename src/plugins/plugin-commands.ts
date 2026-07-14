import type { LocalCommandResult, SlashCommand } from "../input/types.js";
import {
  PluginManagementService,
  type ManagedPluginInspection,
  type PluginReference,
} from "./plugin-management-service.js";
import type { PluginTrustProposal } from "./plugin-trust.js";
import type { PluginScope } from "./plugin-types.js";

const USAGE =
  "/plugin [list|install <path>|inspect <id>|trust <id>|enable <id>|disable <id>] [--scope user|project|local]";

export type PluginManagementCommandService = Pick<
  PluginManagementService,
  "install" | "list" | "inspect" | "prepareTrust" | "trust" | "enable" | "disable"
>;

export interface CreatePluginCommandOptions {
  readonly workDir: string;
  readonly service?: PluginManagementCommandService;
}

/**
 * Plugin 管理命令只修改安装/信任/启用状态。运行时贡献由下一个 Session 快照接管。
 * trust 分为 prepare/confirm 两阶段；confirm 必须回传 proposal id 和完整资源指纹。
 */
export function createPluginCommand(options: CreatePluginCommandOptions): SlashCommand {
  const service = options.service ?? new PluginManagementService({ workDir: options.workDir });
  const pendingTrust = new Map<string, PluginTrustProposal>();

  return {
    name: "plugin",
    aliases: ["plugins"],
    description: "Install, inspect, trust, enable or disable local plugins",
    usage: USAGE,
    category: "system",
    kind: "local",
    source: "builtin",
    availability: "idle",
    execute: async (input): Promise<LocalCommandResult> => {
      try {
        const parsed = parseScope(input.argv);
        const action = parsed.args[0]?.toLowerCase() ?? "list";
        const args = parsed.args.slice(1);
        switch (action) {
          case "list":
            if (args.length > 0) throw new Error("Usage: /plugin list [--scope ...]");
            return message(
              await listPlugins(service, parsed.scopeExplicit ? parsed.scope : undefined),
            );
          case "install":
            return message(await installPlugin(service, args, parsed.scope));
          case "inspect":
            return message(await inspectPlugin(service, reference(args, parsed.scope, "inspect")));
          case "trust":
            return message(await trustPlugin(service, pendingTrust, args, parsed.scope));
          case "enable": {
            const plugin = reference(args, parsed.scope, "enable");
            await service.enable(plugin);
            return message(
              `Plugin ${plugin.id} [${plugin.scope}] enabled. Restart or refresh the host to apply the immutable Plugin snapshot.`,
            );
          }
          case "disable": {
            const plugin = reference(args, parsed.scope, "disable");
            await service.disable(plugin);
            pendingTrust.delete(referenceKey(plugin));
            return message(
              `Plugin ${plugin.id} [${plugin.scope}] disabled. Restart or refresh the host to apply the immutable Plugin snapshot.`,
            );
          }
          default:
            return message(`Unknown Plugin action: ${action}\nUsage: ${USAGE}`);
        }
      } catch (error) {
        return message(`Plugin command failed: ${errorMessage(error)}`);
      }
    },
  };
}

async function listPlugins(
  service: PluginManagementCommandService,
  scope: PluginScope | undefined,
): Promise<string> {
  const plugins = (await service.list()).filter(
    (inspection) => scope === undefined || inspection.installed.scope === scope,
  );
  if (plugins.length === 0) {
    return scope ? `No plugins installed in ${scope} scope.` : "No plugins installed.";
  }
  return ["Plugins", ...plugins.map(formatPluginListItem)].join("\n");
}

async function installPlugin(
  service: PluginManagementCommandService,
  args: readonly string[],
  scope: PluginScope,
): Promise<string> {
  if (args.length !== 1) throw new Error(`Usage: /plugin install <path> [--scope ...]`);
  const result = await service.install(args[0]!, scope);
  if (!result.success) throw new Error(result.message);
  if (!result.pluginId) throw new Error("Plugin install succeeded without a plugin id");
  return `${result.message}\nPlugin remains disabled. Run /plugin inspect ${result.pluginId} --scope ${scope}, then trust and enable it.`;
}

async function inspectPlugin(
  service: PluginManagementCommandService,
  reference: PluginReference,
): Promise<string> {
  return formatPluginInspection(await service.inspect(reference));
}

async function trustPlugin(
  service: PluginManagementCommandService,
  pending: Map<string, PluginTrustProposal>,
  args: readonly string[],
  scope: PluginScope,
): Promise<string> {
  const parsed = parseTrustArgs(args);
  const plugin = { id: parsed.id, scope } satisfies PluginReference;
  const key = referenceKey(plugin);
  if (!parsed.confirmId && !parsed.fingerprint) {
    const proposal = await service.prepareTrust(plugin);
    pending.set(key, proposal);
    return [
      `Trust proposal for ${proposal.pluginId} [${proposal.scope}]`,
      `Root: ${proposal.pluginRoot}`,
      `Fingerprint: ${proposal.resourceDigest}`,
      "Review the plugin contents before confirming.",
      `Confirm: /plugin trust ${proposal.pluginId} --scope ${proposal.scope} --confirm=${proposal.id} --fingerprint=${proposal.resourceDigest}`,
    ].join("\n");
  }
  if (!parsed.confirmId || !parsed.fingerprint) {
    throw new Error(
      "Trust confirmation requires both --confirm=<proposal-id> and --fingerprint=<sha256>",
    );
  }
  const proposal = pending.get(key);
  if (!proposal) throw new Error("No pending trust proposal; run /plugin trust <id> first");
  if (proposal.id !== parsed.confirmId || proposal.resourceDigest !== parsed.fingerprint) {
    throw new Error("Trust proposal or fingerprint does not match the pending confirmation");
  }
  try {
    await service.trust(proposal);
  } catch (error) {
    pending.delete(key);
    throw error;
  }
  pending.delete(key);
  return `Plugin ${plugin.id} [${scope}] trusted for fingerprint ${proposal.resourceDigest}.`;
}

function parseScope(argv: readonly string[]): {
  readonly args: string[];
  readonly scope: PluginScope;
  readonly scopeExplicit: boolean;
} {
  const args: string[] = [];
  let scope: PluginScope = "project";
  let scopeExplicit = false;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--scope") {
      const next = argv[++index];
      if (!next) throw new Error("--scope requires user, project or local");
      scope = parsePluginScope(next);
      scopeExplicit = true;
      continue;
    }
    if (value.startsWith("--scope=")) {
      scope = parsePluginScope(value.slice("--scope=".length));
      scopeExplicit = true;
      continue;
    }
    args.push(value);
  }
  return { args, scope, scopeExplicit };
}

function parsePluginScope(value: string): PluginScope {
  if (value === "user" || value === "project" || value === "local") return value;
  throw new Error(`Invalid Plugin scope: ${value}. Expected user, project or local.`);
}

function parseTrustArgs(args: readonly string[]): {
  readonly id: string;
  readonly confirmId?: string;
  readonly fingerprint?: string;
} {
  const positional: string[] = [];
  let confirmId: string | undefined;
  let fingerprint: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--confirm") {
      confirmId = requireFlagValue(args[++index], "--confirm");
    } else if (value.startsWith("--confirm=")) {
      confirmId = requireFlagValue(value.slice("--confirm=".length), "--confirm");
    } else if (value === "--fingerprint") {
      fingerprint = requireFlagValue(args[++index], "--fingerprint");
    } else if (value.startsWith("--fingerprint=")) {
      fingerprint = requireFlagValue(value.slice("--fingerprint=".length), "--fingerprint");
    } else {
      positional.push(value);
    }
  }
  if (positional.length !== 1) throw new Error("Usage: /plugin trust <id> [--scope ...]");
  return {
    id: positional[0]!,
    ...(confirmId ? { confirmId } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  };
}

function requireFlagValue(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} requires a value`);
  return value.trim();
}

function reference(
  args: readonly string[],
  scope: PluginScope,
  action: "inspect" | "enable" | "disable",
): PluginReference {
  if (args.length !== 1) throw new Error(`Usage: /plugin ${action} <id> [--scope ...]`);
  return { id: args[0]!, scope };
}

function referenceKey(reference: PluginReference): string {
  return `${reference.scope}:${reference.id}`;
}

function formatPluginListItem(inspection: ManagedPluginInspection): string {
  const plugin = inspection.installed;
  const state = inspection.active ? "active" : plugin.enabled ? "inactive" : "disabled";
  const changed = inspection.changedSinceInstall ? " · changed" : "";
  return `- ${plugin.id} [${plugin.scope}] · ${state} · trust ${inspection.trust} · ${inspection.contributions.compatibility}${changed}`;
}

function formatPluginInspection(inspection: ManagedPluginInspection): string {
  const { installed, contributions } = inspection;
  const counts = [
    `skills ${contributions.skills.length}`,
    `commands ${contributions.commands.length}`,
    `agents ${contributions.agents.length}`,
    `hooks ${contributions.hooks.length}`,
    `MCP ${contributions.mcpServers.length}`,
    `LSP ${contributions.lspServers.length}`,
  ].join(", ");
  const diagnostics = contributions.diagnostics.length
    ? contributions.diagnostics.map((item) => `- ${item.severity}: ${item.message}`)
    : ["- none"];
  return [
    `Plugin ${installed.id} [${installed.scope}]`,
    `Version: ${installed.manifest.version ?? "<none>"}`,
    `Root: ${installed.installPath}`,
    `Manifest: ${installed.manifestSource}`,
    `State: ${installed.enabled ? "enabled" : "disabled"}; trust ${inspection.trust}; active ${inspection.active ? "yes" : "no"}`,
    `Compatibility: ${contributions.compatibility}; changed since install: ${inspection.changedSinceInstall ? "yes" : "no"}`,
    `Installed fingerprint: ${installed.resourceFingerprint.digest}`,
    `Current fingerprint: ${contributions.fingerprint?.digest ?? "<unavailable>"}`,
    `Contributions: ${counts}`,
    "Diagnostics:",
    ...diagnostics,
  ].join("\n");
}

function message(text: string): LocalCommandResult {
  return { type: "local", action: "message", message: text };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
