import { randomUUID } from "node:crypto";
import type { ClientCommandRegistryDeps } from "./types.js";
import { rpcCommand, cachedArgumentCompleter } from "./shared.js";

export function createResourcesCommands(deps: ClientCommandRegistryDeps) {
  const { runtime, workspacePath } = deps;
  const skillCompleter = cachedArgumentCompleter(
    async () => runtime.request("skills.effective.list", { workspacePath }),
    (result) =>
      (result.skills as readonly { name?: string }[]).map((skill) => ({
        value: skill.name ?? "",
        label: skill.name ?? "(unnamed)",
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
        const msg = (text: string) => ({
          type: "local" as const,
          action: "message" as const,
          message: text,
        });
        const USAGE =
          "/plugin [list|install <path>|inspect <id>|trust <id>|enable <id>|disable <id>] [--scope user|project|local]";
        // --scope 默认 project。
        const args: string[] = [];
        let scope: "user" | "project" | "local" = "project";
        for (let index = 0; index < input.argv.length; index++) {
          const value = input.argv[index]!;
          if (value === "--scope") {
            const next = input.argv[++index];
            if (!next || !["user", "project", "local"].includes(next)) {
              return msg("--scope requires user, project or local");
            }
            scope = next as "user" | "project" | "local";
            continue;
          }
          if (value.startsWith("--scope=")) {
            const next = value.slice("--scope=".length);
            if (!["user", "project", "local"].includes(next)) {
              return msg("--scope requires user, project or local");
            }
            scope = next as "user" | "project" | "local";
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
            const plugins = Array.isArray((result.result as Record<string, unknown>)["plugins"])
              ? ((result.result as Record<string, unknown>)["plugins"] as unknown[])
              : [];
            const visible = plugins.filter((raw) => {
              const installed = (raw as Record<string, unknown>)["installed"] as
                | Record<string, unknown>
                | undefined;
              return (
                installed === undefined ||
                installed["scope"] === undefined ||
                installed["scope"] === scope
              );
            });
            if (visible.length === 0) {
              return msg(
                scope ? `No plugins installed in ${scope} scope.` : "No plugins installed.",
              );
            }
            return msg(
              [
                "Plugins",
                ...visible.map((raw) => formatPluginListItem(raw as Record<string, unknown>)),
              ].join("\n"),
            );
          }
          if (action === "install") {
            if (rest.length !== 1) return msg(`Usage: /plugin install <path> [--scope ...]`);
            const result = await runtime.request("plugin.manage", {
              workspacePath,
              action: "install",
              path: rest[0],
              scope,
            });
            const install = (result.result as Record<string, unknown>)["install"] as
              | Record<string, unknown>
              | undefined;
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
              const plugin = (result.result as Record<string, unknown>)["plugin"] as Record<
                string,
                unknown
              >;
              return msg(JSON.stringify(plugin, null, 2));
            }
            // trust 两阶段：prepare 输出确认指引；confirm 校验 fresh proposal 指纹
            //（无状态化——daemon 侧以 fresh proposal 对 confirmId+指纹，客户端不持有 pending）。
            if (!confirmArg && !fingerprintArg) {
              const result = await runtime.request("plugin.manage", {
                workspacePath,
                action: "trust.prepare",
                id,
                scope,
              });
              const proposal = (result.result as Record<string, unknown>)["proposal"] as
                | Record<string, unknown>
                | undefined;
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
            await runtime.request("plugin.manage", {
              workspacePath,
              action,
              id,
              scope,
            });
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
        const msg = (text: string) => ({
          type: "local" as const,
          action: "message" as const,
          message: text,
        });
        const action = input.argv[0] ?? "list";
        const handlerId = input.argv[1];
        const known = ["list", "review", "trust", "enable", "disable", "reload"];
        if (!known.includes(action)) {
          return msg("Usage: /hooks [list|review|trust|enable|disable|reload] [handler-id]");
        }
        try {
          const result = await runtime.request("hooks.manage", {
            workspacePath,
            action: action as "list" | "review" | "trust" | "enable" | "disable" | "reload",
            ...(handlerId ? { handlerId } : {}),
          });
          const outcome = result.result as Record<string, unknown>;
          if (action === "list") {
            const items = Array.isArray(outcome["items"]) ? outcome["items"] : [];
            if (items.length === 0) return msg("No Hooks configured.");
            return msg(
              items
                .map((raw) => {
                  const item = raw as Record<string, unknown>;
                  const source = item["source"] as Record<string, unknown> | undefined;
                  return `${String(item["id"] ?? "")}  ${String(item["event"] ?? "")}  ${String(item["type"] ?? "")}  ${String(item["status"] ?? "")}  ${String(source?.["kind"] ?? "")}:${String(source?.["path"] ?? "")}`;
                })
                .join("\n"),
            );
          }
          if (action === "review") {
            return msg(JSON.stringify(outcome["review"] ?? {}, null, 2));
          }
          if (action === "reload") {
            return msg(outcome["reloaded"] === true ? "Hooks reloaded." : "Hook reload rejected.");
          }
          return msg(
            outcome["ok"] === true
              ? `${action === "trust" ? "Trusted" : action === "enable" ? "Enabled" : "Disabled"} Hook ${handlerId}.`
              : "Hook operation failed.",
          );
        } catch (error) {
          return msg(
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
      // session.send 由 daemon 决定排队或转向，允许在运行中提交。
      availability: "always",
      argumentCompleter: skillCompleter,
      execute: async (input) => {
        const skillName = input.argv[0];
        if (skillName === undefined) {
          return { type: "local", action: "message", message: "Usage: /skill <name> [args]" };
        }
        const args = input.argv.slice(1).join(" ");
        const sent = await runtime.sendInput({
          kind: "skill",
          name: skillName,
          ...(args ? { args } : {}),
        });
        return sent
          ? { type: "local", action: "message", message: `技能 ${skillName} 已提交。` }
          : { type: "local", action: "message", message: `技能 ${skillName} 提交失败。` };
      },
    }),
    agent: rpcCommand({
      name: "agent",
      description: "派发命名 agent 任务（daemon 侧解析）",
      usage: "/agent <name> <task>",
      argumentHint: "<name> <task>",
      category: "agent",
      // 有意分歧：同 /skill——经 session.send 排队，运行中提交合法。
      availability: "always",
      argumentCompleter: agentCompleter,
      execute: async (input) => {
        const agentName = input.argv[0];
        const task = input.argv.slice(1).join(" ");
        if (!agentName || !task) {
          return { type: "local", action: "message", message: "Usage: /agent <name> <task>" };
        }
        const sent = await runtime.sendInput({ kind: "agent", name: agentName, task });
        return sent
          ? { type: "local", action: "message", message: `Agent ${agentName} 任务已提交。` }
          : { type: "local", action: "message", message: `Agent ${agentName} 任务提交失败。` };
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
        const names = (result.skills as readonly { name?: string }[])
          .map((skill) => skill.name ?? "(unnamed)")
          .join("、");
        return {
          type: "local",
          action: "skills",
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
          type: "local",
          action: "agents",
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
      execute: async () => ({
        type: "local",
        action: "message",
        message: "仓库探索已内建：直接描述目标，agent 会自行扫描代码库。",
      }),
    }),
    mcp: rpcCommand({
      name: "mcp",
      description: "Inspect and control MCP server connections",
      usage: "/mcp [reload|enable <server>|disable <server>]",
      category: "mcp",
      availability: "always",
      execute: async (input) => {
        const msg = (text: string) => ({
          type: "local" as const,
          action: "message" as const,
          message: text,
        });
        const [action, server, ...extra] = input.argv;
        try {
          // 无参 = 状态：effective 配置面 + config.mcpServers 瞬态探测面拼合。
          if (!action) {
            const [effective, probe] = await Promise.all([
              runtime.request("mcp.effective.list", { workspacePath }),
              runtime.request("config.mcpServers", { workspacePath }).catch(() => undefined),
            ]);
            if (effective.servers.length === 0) {
              return msg("MCP status\nNo MCP servers loaded.");
            }
            const probeByServer = new Map<string, Record<string, unknown>>(
              (probe?.servers ?? []).map((entry: Record<string, unknown>) => [
                String(entry["name"] ?? ""),
                entry,
              ]),
            );
            const lines = ["MCP status"];
            for (const server of effective.servers) {
              const status = probeByServer.get(server.name);
              const transport =
                server.transport === "stdio"
                  ? "stdio"
                  : server.transport === "http"
                    ? "http"
                    : "sse";
              const enabled = server.enabled === false ? " disabled" : "";
              const source =
                server.source.scope === "user"
                  ? "用户级"
                  : server.source.scope === "project"
                    ? "项目级"
                    : "插件";
              const probeStatus =
                status && typeof status["status"] === "string"
                  ? ` [${status["status"]}${typeof status["toolCount"] === "number" ? ` · ${status["toolCount"]} tools` : ""}]`
                  : "";
              lines.push(`- ${server.name} [${transport}]${enabled} - ${source}${probeStatus}`);
            }
            return msg(lines.join("\n"));
          }
          if (action === "enable" || action === "disable") {
            if (!server || extra.length > 0) {
              return msg("Usage: /mcp enable <server> | disable <server>");
            }
            const listed = await runtime.request("mcp.user.list", {});
            const target = listed.servers.find((entry) => entry.name === server);
            if (!target) {
              return msg(
                `未在用户级配置中找到 ${server}（项目级请编辑 .pico/mcp.json，插件级只读）。`,
              );
            }
            const result = await runtime.request("mcp.user.setEnabled", {
              serverName: server,
              enabled: action === "enable",
              expectedRevision: listed.revision,
              idempotencyKey: randomUUID(),
            });
            return msg(
              `MCP server ${result.server.name} 已${action === "enable" ? "启用" : "停用"}（下次 run 生效）。`,
            );
          }
          if (action === "reload") {
            if (server !== undefined || extra.length > 0) {
              return msg("Usage: /mcp reload");
            }
            // daemon 无跨 run 常驻连接管理面：reload = 配置快照刷新（下次 run 重读配置）。
            return msg(
              "MCP 配置由 daemon 在每次 run 时重读，无需 reload；重新拉取状态快照请直接运行 /mcp。",
            );
          }
          return msg("Usage: /mcp [reload|enable <server>|disable <server>]");
        } catch (error) {
          return msg(
            `MCP command failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    }),
  };
}

function formatPluginListItem(inspection: Record<string, unknown>): string {
  const installed = (inspection["installed"] ?? {}) as Record<string, unknown>;
  const contributions = (inspection["contributions"] ?? {}) as Record<string, unknown>;
  const active = inspection["active"] === true;
  const enabled = installed["enabled"] === true;
  const state = active ? "active" : enabled ? "inactive" : "disabled";
  const changed = inspection["changedSinceInstall"] === true ? " · changed" : "";
  return `- ${String(installed["id"] ?? "")} [${String(installed["scope"] ?? "")}] · ${state} · trust ${String(inspection["trust"] ?? "")} · ${String(contributions["compatibility"] ?? "")}${changed}`;
}
