import { createBuiltinCommandRegistry } from "./builtin-commands.js";
import { normalizeCommandName, type CommandRegistry } from "./command-registry.js";
import { parseSlashInput } from "./slash-parser.js";
import type { InputProcessResult, SlashCommand } from "./types.js";

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
  "agents",
  "sessions",
  "resume",
  "snapshots",
  "rewind",
  "undo",
  "agent",
  "skills",
  "skill",
]);

export interface ProcessUserInputOptions {
  registry?: CommandRegistry;
}

export async function processUserInput(
  input: string,
  options: ProcessUserInputOptions = {},
): Promise<InputProcessResult> {
  const registry = options.registry ?? createBuiltinCommandRegistry();

  if (input.trim().length === 0) {
    return {
      type: "empty",
      raw: input,
    };
  }

  const parsed = parseSlashInput(input);
  if (parsed === null) {
    if (isSlashLikeInput(input)) {
      return {
        type: "unknown-command",
        raw: input,
        command: "",
        args: "",
        argv: [],
        message: "Invalid slash command. Type /help to see available commands.",
        suggestions: registry.suggestions("help"),
      };
    }

    return {
      type: "prompt",
      raw: input,
      prompt: input,
    };
  }

  const command = registry.resolve(parsed.name);
  if (command === undefined) {
    return {
      type: "unknown-command",
      raw: input,
      command: parsed.name,
      args: parsed.args,
      argv: parsed.argv,
      message: `Unknown slash command: /${parsed.name}`,
      suggestions: registry.suggestions(parsed.name),
    };
  }

  const result = await command.execute(parsed, { registry });
  if (command.name === "help" && result.type === "local") {
    return {
      type: "local-command",
      raw: input,
      command: command.name,
      args: parsed.args,
      argv: parsed.argv,
      result: {
        ...result,
        action: "help",
        message: buildHelpMessage(registry, parsed.argv[0]),
      },
    };
  }

  if (result.type === "prompt") {
    return {
      type: "prompt-command",
      raw: input,
      command: command.name,
      args: parsed.args,
      argv: parsed.argv,
      result,
    };
  }

  return {
    type: "local-command",
    raw: input,
    command: command.name,
    args: parsed.args,
    argv: parsed.argv,
    result,
  };
}

function isSlashLikeInput(input: string): boolean {
  return input.trimStart().startsWith("/");
}

function buildHelpMessage(registry: CommandRegistry, filter?: string): string {
  if (filter !== undefined && filter.trim().length > 0) {
    const command = registry.resolve(filter);
    return command === undefined
      ? `No help found for /${normalizeCommandName(filter)}.`
      : formatCommandHelp(command);
  }

  const commands = registry
    .list()
    .filter((command) => CORE_HELP_COMMANDS.has(command.name));
  const lines = commands
    .map((command) => `/${command.name} - ${command.description}`);
  return [
    "Available slash commands:",
    ...lines,
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
    .filter((part) => (part.startsWith("<") && part.endsWith(">")) || (part.startsWith("[") && part.endsWith("]")));
}
