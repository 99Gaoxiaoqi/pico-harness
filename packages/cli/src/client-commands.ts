import { CommandRegistry, type RegistrySlashCommand } from "./command-registry.js";
import { createBuiltinCommands } from "./builtin-commands.js";
import { processUserInput } from "./process-user-input.js";
import { parseSlashInput } from "@pico/core/slash-parser";
import { getCommandAvailability } from "@pico/cli/command-availability";
import { type InputProcessResult, type LocalCommandResult } from "@pico/cli/command-contracts";
import { createModelCommands } from "@pico/cli/model-commands";
import { createSettingsCommands } from "@pico/cli/settings-commands";
import { createSessionCommands } from "@pico/cli/session-commands";
import { createResourcesCommands } from "@pico/cli/resources-commands";
import { createWorkspaceCommands } from "@pico/cli/workspace-commands";
import { createAutomationCommands } from "@pico/cli/automation-commands";
import { createAutomationCommandServices } from "./tui/commands/automation-commands.js";

import type { SessionCommandRuntime } from "./session-commands.js";
import type { SettingsCommandRuntime } from "./settings-commands.js";
import type { AutomationCredentialImportProposalStore } from "./tui/automation-credential-proposal.js";

/** Shared command port. TUI and Desktop own presentation and session navigation. */
export interface ClientCommandRuntime
  extends SessionCommandRuntime, Omit<SettingsCommandRuntime, "request"> {
  readonly running: boolean;
  abandonPendingSend?(): Promise<string | null>;
}
export interface ClientCommandRegistryDeps {
  readonly runtime: ClientCommandRuntime;
  readonly workspacePath: string;
  readonly automationCredentialProposals?: AutomationCredentialImportProposalStore | undefined;
  readonly credentialEnv?: Readonly<Record<string, string | undefined>> | undefined;
}

export interface ClientInputOutcome {
  readonly kind: "local" | "unknown" | "sent" | "rejected";
  readonly result?: LocalCommandResult | undefined;
  readonly message?: string | undefined;
}

/** TUI 与 Desktop 共用命令执行入口；各领域持有自己的 RPC、补全和格式化逻辑。 */
export function createClientCommandRegistry(deps: ClientCommandRegistryDeps): CommandRegistry {
  const model = createModelCommands(deps);
  const settings = createSettingsCommands(deps);
  const session = createSessionCommands(deps);
  const resources = createResourcesCommands(deps);
  const workspace = createWorkspaceCommands(deps);
  const automation = createAutomationCommands(createAutomationCommandServices(deps));
  const sendRecovery = {
    name: "send-recovery",
    description: "处理无法确认结果的待发送请求；原请求可能已执行",
    usage: "/send-recovery abandon --confirm",
    category: "system" as const,
    kind: "local" as const,
    availability: "always" as const,
    execute: async (input: { argv: readonly string[] }) => {
      if (input.argv.length !== 2 || input.argv[0] !== "abandon" || input.argv[1] !== "--confirm") {
        return {
          type: "local" as const,
          action: "message" as const,
          message:
            "仅在接受风险时执行 /send-recovery abandon --confirm：原请求可能已执行；此操作不会取消 Host 执行，并会把原请求草稿放回输入框。",
        };
      }
      const draft = await deps.runtime.abandonPendingSend?.();
      return draft === null || draft === undefined
        ? {
            type: "local" as const,
            action: "message" as const,
            message: "当前没有可显式放弃的待恢复发送；原请求未更改。",
          }
        : {
            type: "local" as const,
            action: "message" as const,
            message:
              "已放弃本地恢复记录；原请求可能已执行，此操作不会取消 Host 执行。原请求草稿已放回输入框，请检查后决定是否重新发送。",
            data: { restoreDraft: draft },
          };
    },
  };
  return new CommandRegistry([
    ...createBuiltinCommands().filter((command) => command.name !== "skill"),
    ...(deps.runtime.abandonPendingSend ? [sendRecovery] : []),
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
  runtime: Pick<ClientCommandRuntime, "running" | "sendText">,
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
