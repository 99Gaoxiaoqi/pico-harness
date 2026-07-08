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
  if (input.trim().length === 0) {
    return {
      type: "empty",
      raw: input,
    };
  }

  const parsed = parseSlashInput(input);
  if (parsed === null) {
    return {
      type: "prompt",
      raw: input,
      prompt: input,
    };
  }

  const registry = options.registry ?? createBuiltinCommandRegistry();
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
