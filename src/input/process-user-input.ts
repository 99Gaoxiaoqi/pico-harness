import { createBuiltinCommandRegistry } from "./builtin-commands.js";
import type { CommandRegistry } from "./command-registry.js";
import { parseSlashInput } from "./slash-parser.js";
import type { InputProcessResult } from "./types.js";

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
