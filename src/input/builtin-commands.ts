import { CommandRegistry } from "./command-registry.js";
import type { LocalCommandResult, PromptCommandResult, SlashCommand } from "./types.js";

export function createBuiltinCommands(): readonly SlashCommand[] {
  return [
    localCommand({
      name: "help",
      aliases: ["h", "?"],
      description: "Show available slash commands",
      usage: "/help [command]",
      action: "help",
      execute: (input, context) => ({
        type: "local",
        action: "help",
        message: buildHelpMessage(context.registry?.list() ?? [], input.argv[0]),
      }),
    }),
    localCommand({
      name: "clear",
      aliases: ["cls"],
      description: "Clear the local transcript view",
      usage: "/clear",
      action: "clear",
      message: "Clear requested.",
    }),
    localCommand({
      name: "exit",
      aliases: ["quit", "q"],
      description: "Exit the interactive session",
      usage: "/exit",
      action: "exit",
      message: "Exit requested.",
    }),
    localCommand({
      name: "status",
      aliases: ["st"],
      description: "Show current session status",
      usage: "/status",
      action: "status",
      message: "Status is not connected yet.",
    }),
    localCommand({
      name: "model",
      aliases: ["models"],
      description: "Show or change the active model",
      usage: "/model [name]",
      action: "model",
      execute: (input) => ({
        type: "local",
        action: "model",
        message:
          input.args.length === 0
            ? "Model command is not connected yet."
            : `Model change requested: ${input.args}`,
        data: input.args.length === 0 ? undefined : { model: input.args },
      }),
    }),
    localCommand({
      name: "tools",
      aliases: ["tool"],
      description: "List available tools",
      usage: "/tools",
      action: "tools",
      message: "Tools command is not connected yet.",
    }),
    localCommand({
      name: "skills",
      aliases: ["skill-list"],
      description: "List available skills",
      usage: "/skills",
      action: "skills",
      message: "Skills command is not connected yet.",
    }),
    {
      name: "skill",
      aliases: ["use-skill"],
      description: "Ask the agent to use a named skill",
      usage: "/skill <name>",
      kind: "prompt",
      execute: (input): PromptCommandResult | LocalCommandResult => {
        const skillName = input.argv[0];
        if (skillName === undefined) {
          return {
            type: "local",
            action: "message",
            message: "Usage: /skill <name>",
          };
        }

        return {
          type: "prompt",
          prompt: `Use the ${skillName} skill for this task.`,
          metadata: { skillName },
        };
      },
    },
    localCommand({
      name: "agents",
      aliases: ["agent"],
      description: "List available subagents",
      usage: "/agents",
      action: "agents",
      message: "Agents command is not connected yet.",
    }),
  ];
}

export function createBuiltinCommandRegistry(): CommandRegistry {
  return new CommandRegistry(createBuiltinCommands());
}

interface LocalCommandSpec {
  name: string;
  aliases?: readonly string[];
  description: string;
  usage: string;
  action: LocalCommandResult["action"];
  message?: string;
  execute?: SlashCommand["execute"];
}

function localCommand(spec: LocalCommandSpec): SlashCommand {
  return {
    name: spec.name,
    aliases: spec.aliases,
    description: spec.description,
    usage: spec.usage,
    kind: "local",
    execute:
      spec.execute ??
      (() => ({
        type: "local",
        action: spec.action,
        message: spec.message,
      })),
  };
}

function buildHelpMessage(commands: readonly SlashCommand[], filter?: string): string {
  const normalizedFilter = filter?.replace(/^\/+/, "").toLowerCase();
  const visible =
    normalizedFilter === undefined
      ? commands
      : commands.filter(
          (command) =>
            command.name === normalizedFilter ||
            command.aliases?.some((alias) => alias.toLowerCase() === normalizedFilter) === true,
        );

  if (visible.length === 0) {
    return `No help found for /${filter ?? ""}.`;
  }

  return visible
    .map((command) => {
      const usage = command.usage ?? `/${command.name}`;
      const aliases =
        command.aliases === undefined || command.aliases.length === 0
          ? ""
          : ` (aliases: ${command.aliases.map((alias) => `/${alias}`).join(", ")})`;
      return `${usage}${aliases} - ${command.description}`;
    })
    .join("\n");
}
