import { CommandRegistry } from "./command-registry.js";
import type { LocalCommandResult, PromptCommandResult, SlashCommand } from "./types.js";

const CORE_HELP_COMMANDS = new Set([
  "help",
  "clear",
  "exit",
  "status",
  "mode",
  "permissions",
  "compact",
  "init",
  "doctor",
  "model",
  "thinking",
  "tools",
  "mcp",
  "agents",
  "sessions",
  "resume",
  "snapshots",
  "rewind",
  "undo",
  "image",
  "agent",
  "skills",
  "skill",
]);

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
        ui: { kind: "open-panel", panel: "help" },
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

  if (normalizedFilter !== undefined && normalizedFilter.trim().length > 0) {
    const visible = commands.filter(
      (command) =>
        command.name === normalizedFilter ||
        command.aliases?.some((alias) => alias.toLowerCase() === normalizedFilter) === true,
    );
    if (visible.length === 0) return `No help found for /${filter ?? ""}.`;
    return visible.map(formatCommandHelp).join("\n");
  }

  const visible = commands.filter((command) => CORE_HELP_COMMANDS.has(command.name));
  if (visible.length === 0) return "No slash commands available.";

  return [
    "Available slash commands:",
    ...visible.map((command) => `/${command.name} - ${command.description}`),
    "",
    "Use /help <command> for any command, or /skills and /agents for extension lists.",
  ].join("\n");
}

function formatCommandHelp(command: SlashCommand): string {
  const usage = command.usage ?? `/${command.name}`;
  const aliases = command.aliases?.map((alias) => `/${alias}`).join(", ") || "none";
  const parameters = extractUsageParameters(usage);
  const parameterLines =
    parameters.length === 0
      ? ["Parameters: none"]
      : ["Parameters:", ...parameters.map((parameter) => `  ${parameter}`)];

  return [
    `Command: /${command.name}`,
    `Usage: ${usage}`,
    `Aliases: ${aliases}`,
    `Description: ${command.description}`,
    ...parameterLines,
  ].join("\n");
}

function extractUsageParameters(usage: string): string[] {
  return usage
    .split(/\s+/)
    .slice(1)
    .filter(
      (part) =>
        (part.startsWith("<") && part.endsWith(">")) ||
        (part.startsWith("[") && part.endsWith("]")),
    );
}
