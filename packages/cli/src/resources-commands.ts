import { randomUUID } from "node:crypto";
import type { RuntimeMethod, RuntimeParams, RuntimeResult, RuntimeUserInput } from "@pico/protocol";
import type {
  SlashArgumentCandidate,
  SlashArgumentCompleter,
  SlashCommand,
} from "./command-contracts.js";

const ARGUMENT_COMPLETER_CACHE_TTL_MS = 5_000;

/** Runtime client surface consumed by CLI resource-command RPC projections. */
export interface ClientCommandRuntime {
  request<Method extends RuntimeMethod>(
    method: Method,
    params: RuntimeParams<Method>,
  ): Promise<RuntimeResult<Method>>;
  sendInput(
    input: RuntimeUserInput,
    behavior?: "auto" | "steer" | "queue" | "replace",
    execution?: { orchestrationMode?: "graph" | "swarm" },
  ): Promise<boolean>;
}

/** TUI/desktop host injects its session runtime; CLI owns only command projection. */
export interface ClientCommandRegistryDeps {
  readonly runtime: ClientCommandRuntime;
  readonly workspacePath: string;
}

export function createResourcesCommands(deps: ClientCommandRegistryDeps) {
  const { runtime, workspacePath } = deps;
  const skillCompleter = cachedArgumentCompleter(
    async () => runtime.request("skills.effective.list", { workspacePath }),
    (result) =>
      result.skills.map((skill) => ({
        value: skill.name,
        label: skill.name,
      })),
  );
  const agentCompleter = cachedArgumentCompleter(
    async () => runtime.request("catalog.agents", { workspacePath }),
    (result) => result.agents.map((agent) => ({ value: agent.name })),
  );
  return {
    plugin: rpcCommand({
      name: "plugin",
      aliases: ["plugins"],
      description: "Install, inspect, trust, enable or disable local plugins",
      usage:
        "/plugin [list|install <path>|inspect <id>|trust <id>|enable <id>|disable <id>] [--scope user|project|local]",
      category: "system",
      availability: "idle",
      execute: async (input) => {
        const msg = message;
        const USAGE =
          "/plugin [list|install <path>|inspect <id>|trust <id>|enable <id>|disable <id>] [--scope user|project|local]";
        const args: string[] = [];
        let scope: "user" | "project" | "local" = "project";
        for (let index = 0; index < input.argv.length; index++) {
          const value = input.argv[index]!;
          if (value === "--scope") {
            const next = input.argv[++index];
            if (!next || !isPluginScope(next))
              return msg("--scope requires user, project or local");
            scope = next;
            continue;
          }
          if (value.startsWith("--scope=")) {
            const next = value.slice("--scope=".length);
            if (!isPluginScope(next)) return msg("--scope requires user, project or local");
            scope = next;
            continue;
          }
          args.push(value);
        }
        const action = args[0]?.toLowerCase() ?? "list";
        const rest = args.slice(1);
        try {
          if (action === "list") {
            const result = await runtime.request("plugin.manage", {
              workspacePath,
              action: "list",
            });
            const plugins = asArray(asRecord(result.result)["plugins"]);
            const visible = plugins.filter((raw) => {
              const installed = asOptionalRecord(asRecord(raw)["installed"]);
              return (
                installed === undefined ||
                installed["scope"] === undefined ||
                installed["scope"] === scope
              );
            });
            if (visible.length === 0) {
              return msg(`No plugins installed in ${scope} scope.`);
            }
            return msg(
              ["Plugins", ...visible.map((raw) => formatPluginListItem(asRecord(raw)))].join("\n"),
            );
          }
          if (action === "install") {
            const path = rest[0];
            if (!path || rest.length !== 1) {
              return msg("Usage: /plugin install <path> [--scope ...]");
            }
            const result = await runtime.request("plugin.manage", {
              workspacePath,
              action: "install",
              path,
              scope,
            });
            const install = asOptionalRecord(asRecord(result.result)["install"]);
            if (install?.["success"] !== true) {
              return msg(String(install?.["message"] ?? "Plugin install failed."));
            }
            return msg(
              `${String(install["message"] ?? "Installed")}\nPlugin remains disabled. Run /plugin inspect ${String(install["pluginId"] ?? "")} --scope ${scope}, then trust and enable it.`,
            );
          }
          if (action === "inspect" || action === "trust") {
            const id = rest[0];
            const confirmArg = rest.find((value) => value.startsWith("--confirm="));
            const fingerprintArg = rest.find((value) => value.startsWith("--fingerprint="));
            if (!id || rest.length > 3) return msg(`Usage: /plugin ${action} <id> [--scope ...]`);
            if (action === "inspect") {
              const result = await runtime.request("plugin.manage", {
                workspacePath,
                action: "inspect",
                id,
                scope,
              });
              return msg(JSON.stringify(asRecord(asRecord(result.result)["plugin"]), null, 2));
            }
            if (!confirmArg && !fingerprintArg) {
              const result = await runtime.request("plugin.manage", {
                workspacePath,
                action: "trust.prepare",
                id,
                scope,
              });
              const proposal = asOptionalRecord(asRecord(result.result)["proposal"]);
              if (!proposal) return msg("Plugin trust proposal unavailable.");
              return msg(
                [
                  `Trust proposal for ${String(proposal["pluginId"] ?? id)} [${String(proposal["scope"] ?? scope)}]`,
                  `Root: ${String(proposal["pluginRoot"] ?? "?")}`,
                  `Fingerprint: ${String(proposal["resourceDigest"] ?? "?")}`,
                  "Review the plugin contents before confirming.",
                  `Confirm: /plugin trust ${String(proposal["pluginId"] ?? id)} --scope ${String(proposal["scope"] ?? scope)} --confirm=${String(proposal["id"] ?? "")} --fingerprint=${String(proposal["resourceDigest"] ?? "")}`,
                ].join("\n"),
              );
            }
            if (!confirmArg || !fingerprintArg) {
              return msg(
                "Trust confirmation requires both --confirm=<proposal-id> and --fingerprint=<sha256>",
              );
            }
            await runtime.request("plugin.manage", {
              workspacePath,
              action: "trust.confirm",
              id,
              scope,
              confirmId: confirmArg.slice("--confirm=".length),
              fingerprint: fingerprintArg.slice("--fingerprint=".length),
            });
            return msg(`Plugin ${id} [${scope}] trusted.`);
          }
          if (action === "enable" || action === "disable") {
            const id = rest[0];
            if (!id || rest.length > 1) return msg(`Usage: /plugin ${action} <id> [--scope ...]`);
            await runtime.request("plugin.manage", { workspacePath, action, id, scope });
            return msg(
              `Plugin ${id} [${scope}] ${action === "enable" ? "enabled" : "disabled"}. Restart or refresh the host to apply the immutable Plugin snapshot.`,
            );
          }
          return msg(`Unknown Plugin action: ${action}\nUsage: ${USAGE}`);
        } catch (error) {
          return msg(
            `Plugin command failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    }),
    hooks: rpcCommand({
      name: "hooks",
      description: "List, review, trust, enable, disable, or reload Hooks",
      usage: "/hooks [list|review|trust|enable|disable|reload] [handler-id]",
      category: "system",
      availability: "idle",
      execute: async (input) => {
        const action = input.argv[0] ?? "list";
        const handlerId = input.argv[1];
        if (!isHookAction(action)) {
          return message("Usage: /hooks [list|review|trust|enable|disable|reload] [handler-id]");
        }
        try {
          const result = await runtime.request("hooks.manage", {
            workspacePath,
            action,
            ...(handlerId ? { handlerId } : {}),
          });
          const outcome = asRecord(result.result);
          if (action === "list") {
            const items = asArray(outcome["items"]);
            if (items.length === 0) return message("No Hooks configured.");
            return message(
              items
                .map((raw) => {
                  const item = asRecord(raw);
                  const source = asOptionalRecord(item["source"]);
                  return `${String(item["id"] ?? "")}  ${String(item["event"] ?? "")}  ${String(item["type"] ?? "")}  ${String(item["status"] ?? "")}  ${String(source?.["kind"] ?? "")}:${String(source?.["path"] ?? "")}`;
                })
                .join("\n"),
            );
          }
          if (action === "review") return message(JSON.stringify(outcome["review"] ?? {}, null, 2));
          if (action === "reload") {
            return message(
              outcome["reloaded"] === true ? "Hooks reloaded." : "Hook reload rejected.",
            );
          }
          return message(
            outcome["ok"] === true
              ? `${action === "trust" ? "Trusted" : action === "enable" ? "Enabled" : "Disabled"} Hook ${handlerId}.`
              : "Hook operation failed.",
          );
        } catch (error) {
          return message(
            `Hooks command failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    }),
    skill: rpcCommand({
      name: "skill",
      aliases: ["use-skill"],
      description: "请求 agent 使用指定技能（daemon 侧解析）",
      usage: "/skill <name> [arguments]",
      argumentHint: "<name> [arguments]",
      category: "skill",
      availability: "always",
      argumentCompleter: skillCompleter,
      execute: async (input) => {
        const skillName = input.argv[0];
        if (skillName === undefined) return message("Usage: /skill <name> [args]");
        const args = input.argv.slice(1).join(" ");
        const sent = await runtime.sendInput({
          kind: "skill",
          name: skillName,
          ...(args ? { args } : {}),
        });
        return message(sent ? `技能 ${skillName} 已提交。` : `技能 ${skillName} 提交失败。`);
      },
    }),
    agent: rpcCommand({
      name: "agent",
      description: "派发命名 agent 任务（daemon 侧解析）",
      usage: "/agent <name> <task>",
      argumentHint: "<name> <task>",
      category: "agent",
      availability: "always",
      argumentCompleter: agentCompleter,
      execute: async (input) => {
        const agentName = input.argv[0];
        const task = input.argv.slice(1).join(" ");
        if (!agentName || !task) return message("Usage: /agent <name> <task>");
        const sent = await runtime.sendInput({ kind: "agent", name: agentName, task });
        return message(
          sent ? `Agent ${agentName} 任务已提交。` : `Agent ${agentName} 任务提交失败。`,
        );
      },
    }),
    skills: rpcCommand({
      name: "skills",
      aliases: ["skill-list"],
      description: "列出可用技能",
      usage: "/skills",
      category: "skill",
      availability: "idle",
      execute: async () => {
        const result = await runtime.request("skills.effective.list", { workspacePath });
        const names = result.skills.map((skill) => skill.name).join("、");
        return {
          type: "local" as const,
          action: "skills" as const,
          message: names ? `可用技能：${names}` : "没有可用技能。",
        };
      },
    }),
    agents: rpcCommand({
      name: "agents",
      description: "列出可用 agent",
      usage: "/agents",
      availability: "idle",
      execute: async () => {
        const result = await runtime.request("catalog.agents", { workspacePath });
        const names = result.agents.map((agent) => agent.name).join("、");
        return {
          type: "local" as const,
          action: "agents" as const,
          message: names ? `可用 agent：${names}` : "没有可用 agent。",
        };
      },
    }),
    explore: rpcCommand({
      name: "explore",
      description: "（已弃用）仓库探索已内建",
      usage: "/explore",
      category: "workspace",
      availability: "idle",
      execute: async () => message("仓库探索已内建：直接描述目标，agent 会自行扫描代码库。"),
    }),
    mcp: rpcCommand({
      name: "mcp",
      description: "Inspect and control MCP server connections",
      usage: "/mcp [reload|enable <server>|disable <server>]",
      category: "mcp",
      availability: "always",
      execute: async (input) => {
        const [action, server, ...extra] = input.argv;
        try {
          if (!action) {
            const [effective, probe] = await Promise.all([
              runtime.request("mcp.effective.list", { workspacePath }),
              runtime.request("config.mcpServers", { workspacePath }).catch(() => undefined),
            ]);
            if (effective.servers.length === 0)
              return message("MCP status\nNo MCP servers loaded.");
            const probeByServer = new Map<string, Record<string, unknown>>(
              (probe?.servers ?? []).map((entry) => [String(entry["name"] ?? ""), asRecord(entry)]),
            );
            const lines = ["MCP status"];
            for (const configured of effective.servers) {
              const status = probeByServer.get(configured.name);
              const transport = configured.transport;
              const enabled = configured.enabled === false ? " disabled" : "";
              const source =
                configured.source.scope === "user"
                  ? "用户级"
                  : configured.source.scope === "project"
                    ? "项目级"
                    : "插件";
              const probeStatus =
                status && typeof status["status"] === "string"
                  ? ` [${status["status"]}${typeof status["toolCount"] === "number" ? ` · ${status["toolCount"]} tools` : ""}]`
                  : "";
              lines.push(`- ${configured.name} [${transport}]${enabled} - ${source}${probeStatus}`);
            }
            return message(lines.join("\n"));
          }
          if (action === "enable" || action === "disable") {
            if (!server || extra.length > 0)
              return message("Usage: /mcp enable <server> | disable <server>");
            const listed = await runtime.request("mcp.user.list", {});
            const target = listed.servers.find((entry) => entry.name === server);
            if (!target)
              return message(
                `未在用户级配置中找到 ${server}（项目级请编辑 .pico/mcp.json，插件级只读）。`,
              );
            const result = await runtime.request("mcp.user.setEnabled", {
              serverName: server,
              enabled: action === "enable",
              expectedRevision: listed.revision,
              idempotencyKey: randomUUID(),
            });
            return message(
              `MCP server ${result.server.name} 已${action === "enable" ? "启用" : "停用"}（下次 run 生效）。`,
            );
          }
          if (action === "reload") {
            if (server !== undefined || extra.length > 0) return message("Usage: /mcp reload");
            return message(
              "MCP 配置由 daemon 在每次 run 时重读，无需 reload；重新拉取状态快照请直接运行 /mcp。",
            );
          }
          return message("Usage: /mcp [reload|enable <server>|disable <server>]");
        } catch (error) {
          return message(
            `MCP command failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    }),
  };
}

function rpcCommand(spec: SlashCommand): SlashCommand {
  return { ...spec, kind: spec.kind ?? "local" };
}

function cachedArgumentCompleter<T>(
  load: () => Promise<T>,
  project: (loaded: T) => readonly SlashArgumentCandidate[],
): SlashArgumentCompleter {
  let cache: { at: number; candidates: readonly SlashArgumentCandidate[] } | undefined;
  return async (query) => {
    if (cache === undefined || Date.now() - cache.at > ARGUMENT_COMPLETER_CACHE_TTL_MS) {
      try {
        cache = { at: Date.now(), candidates: project(await load()) };
      } catch {
        return [];
      }
    }
    const lowered = query.toLowerCase();
    if (!lowered) return cache.candidates;
    return cache.candidates.filter((candidate) =>
      `${candidate.value} ${candidate.label ?? ""} ${candidate.description ?? ""}`
        .toLowerCase()
        .includes(lowered),
    );
  };
}

function isPluginScope(value: string): value is "user" | "project" | "local" {
  return value === "user" || value === "project" || value === "local";
}

function isHookAction(
  value: string,
): value is "list" | "review" | "trust" | "enable" | "disable" | "reload" {
  return ["list", "review", "trust", "enable", "disable", "reload"].includes(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function message(text: string) {
  return { type: "local" as const, action: "message" as const, message: text };
}

function formatPluginListItem(inspection: Record<string, unknown>): string {
  const installed = asRecord(inspection["installed"]);
  const contributions = asRecord(inspection["contributions"]);
  const active = inspection["active"] === true;
  const enabled = installed["enabled"] === true;
  const state = active ? "active" : enabled ? "inactive" : "disabled";
  const changed = inspection["changedSinceInstall"] === true ? " · changed" : "";
  return `- ${String(installed["id"] ?? "")} [${String(installed["scope"] ?? "")}] · ${state} · trust ${String(inspection["trust"] ?? "")} · ${String(contributions["compatibility"] ?? "")}${changed}`;
}
