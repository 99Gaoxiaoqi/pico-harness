import { CommandRegistry, type RegistrySlashCommand } from "../command-registry.js";
import { createBuiltinCommands } from "../builtin-commands.js";
import { processUserInput } from "../process-user-input.js";
import { parseSlashInput } from "@pico/core/slash-parser";
import { getCommandAvailability } from "@pico/cli/command-availability";
import { type InputProcessResult, type LocalCommandResult } from "@pico/cli/command-contracts";
import { type ClientSessionRuntime } from "./client-session-runtime.js";
import type { ClientCommandRegistryDeps } from "./commands/types.js";
export type { ClientCommandRegistryDeps } from "./commands/types.js";
import { createModelCommands } from "@pico/cli/model-commands";
import { createSettingsCommands } from "@pico/cli/settings-commands";
import { createSessionCommands } from "@pico/cli/session-commands";
import { createResourcesCommands } from "@pico/cli/resources-commands";
import { createWorkspaceCommands } from "@pico/cli/workspace-commands";
import { createAutomationCommands } from "@pico/cli/automation-commands";
import { createAutomationCommandServices } from "./commands/automation-commands.js";

export interface ClientInputOutcome {
  readonly kind: "local" | "unknown" | "sent" | "rejected";
  readonly result?: LocalCommandResult | undefined;
  readonly message?: string | undefined;
}

/** TUI 唯一命令执行入口；各领域持有自己的 RPC、补全和格式化逻辑。 */
export function createClientCommandRegistry(deps: ClientCommandRegistryDeps): CommandRegistry {
  const model = createModelCommands(deps);
  const settings = createSettingsCommands(deps);
  const session = createSessionCommands(deps);
  const resources = createResourcesCommands(deps);
  const workspace = createWorkspaceCommands(deps);
  const automation = createAutomationCommands(createAutomationCommandServices(deps));
  return new CommandRegistry([
    ...createBuiltinCommands().filter((command) => command.name !== "skill"),
    model.model,
    model.thinking,
    settings.mode,
    settings.plan,
    settings.permissions,
    settings.graph,
    settings.swarm,
    session.status,
    session.goal,
    session.rename,
    session.compact,
    resources.plugin,
    workspace.operations,
    resources.hooks,
    workspace["add-dir"],
    session.context,
    workspace.snapshots,
    workspace.rewind,
    workspace.changes,
    workspace.init,
    workspace.doctor,
    session.usage,
    session.sessions,
    session.resume,
    session.fork,
    session.new,
    ...session.running,
    resources.skill,
    resources.agent,
    resources.skills,
    resources.agents,
    resources.explore,
    workspace.memory,
    model.provider,
    automation.cron,
    resources.mcp,
  ] as readonly RegistrySlashCommand[]);
}

export async function processClientInput(
  input: string,
  registry: CommandRegistry,
  runtime: ClientSessionRuntime,
): Promise<ClientInputOutcome> {
  // 命令可用性门：
  // running-only 命令 idle 时、idle-only 命令 running时拦截，不发 RPC。
  const parsed = parseSlashInput(input);
  if (parsed) {
    const command = registry.resolve(parsed.name);
    if (command) {
      const state: "idle" | "running" = runtime.running ? "running" : "idle";
      const swarmStatus =
        command.name === "swarm" && (!parsed.args.trim() || parsed.args.trim() === "status");
      const availability = getCommandAvailability(
        swarmStatus ? { ...command, availability: "always" } : command,
        state,
      );
      if (!availability.available) {
        return {
          kind: "local",
          result: {
            type: "local",
            action: "message",
            message: `/${command.name} ${availability.disabledReason ?? "当前不可用。"}`,
          },
        };
      }
    }
  }
  const processed: InputProcessResult = await (async () => {
    try {
      return await processUserInput(input, { registry });
    } catch (error) {
      // 任何命令执行器内的 RPC/解析错误都不得变成 unhandled rejection 崩掉
      // TUI：统一降级为错误消息。
      const detail = error instanceof Error ? error.message : String(error);
      return {
        type: "local-command" as const,
        raw: input,
        command: parsed?.name ?? "",
        args: parsed?.args ?? "",
        argv: parsed?.argv ?? [],
        result: {
          type: "local" as const,
          action: "message" as const,
          message: `命令执行失败：${detail}`,
        },
      };
    }
  })();
  switch (processed.type) {
    case "empty":
      return { kind: "rejected" };
    case "prompt":
      return (await runtime.sendText(processed.prompt)) ? { kind: "sent" } : { kind: "rejected" };
    case "local-command":
      return { kind: "local", result: processed.result };
    case "prompt-command": {
      // 客户端注册表的 /skill /agent 走 sendInput；此分支只剩 builtin /skill
      // 兜底（无本地解析），按文本上送。
      const sent = await runtime.sendText(processed.result.prompt);
      return sent ? { kind: "sent" } : { kind: "rejected" };
    }
    case "unknown-command":
      return { kind: "unknown", message: processed.message };
    default:
      return { kind: "rejected" };
  }
}
