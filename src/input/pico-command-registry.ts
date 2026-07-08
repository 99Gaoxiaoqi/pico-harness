import { SkillLoader } from "../context/skill.js";
import { createBuiltinCommands } from "./builtin-commands.js";
import { CommandRegistry } from "./command-registry.js";
import {
  loadMarkdownCommands,
  renderMarkdownCommandPrompt,
  type MarkdownPromptCommand,
} from "./markdown-command-loader.js";
import {
  renderSkillCommand,
  renderSkillListCommand,
} from "./skill-commands.js";
import type { LocalCommandResult, PromptCommandResult, SlashCommand } from "./types.js";

export interface PicoCommandRegistryOptions {
  workDir: string;
  model: string;
  provider: string;
}

export async function createPicoCommandRegistry(
  options: PicoCommandRegistryOptions,
): Promise<CommandRegistry> {
  const skillLoader = new SkillLoader(options.workDir);
  const builtins = createBuiltinCommands().filter(
    (command) => command.name !== "skills" && command.name !== "skill" && command.name !== "model" && command.name !== "status",
  );
  const registry = new CommandRegistry([
    ...builtins,
    createStatusCommand(options),
    createModelCommand(options),
    createSkillsCommand(skillLoader),
    createSkillCommand(skillLoader),
  ]);

  const markdownCommands = await loadMarkdownCommands({
    workDir: options.workDir,
    includeSkillCommands: true,
    skillLoader,
    builtinNames: registry.list().map((command) => command.name),
  });
  for (const command of markdownCommands) {
    registry.register(createMarkdownPromptCommand(command));
  }

  return registry;
}

export function commandSuggestions(registry: CommandRegistry, query: string): Array<{ value: string; description?: string }> {
  const needle = query.trim().toLowerCase();
  return registry
    .list()
    .filter((command) => {
      if (!needle) return true;
      return (
        command.name.includes(needle) ||
        command.aliases?.some((alias) => alias.includes(needle)) === true ||
        command.description.toLowerCase().includes(needle)
      );
    })
    .slice(0, 20)
    .map((command) => ({
      value: command.name,
      description: command.description,
    }));
}

function createStatusCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "status",
    aliases: ["st"],
    description: "Show current TUI/session status",
    usage: "/status",
    kind: "local",
    execute: (): LocalCommandResult => ({
      type: "local",
      action: "status",
      message: `WorkDir: ${options.workDir}\nProvider: ${options.provider}\nModel: ${options.model}`,
    }),
  };
}

function createModelCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "model",
    aliases: ["models", "mode"],
    description: "Show the active model",
    usage: "/model",
    kind: "local",
    execute: (): LocalCommandResult => ({
      type: "local",
      action: "model",
      message: `当前模型: ${options.model}`,
    }),
  };
}

function createSkillsCommand(loader: SkillLoader): SlashCommand {
  return {
    name: "skills",
    aliases: ["skill-list"],
    description: "List available skills",
    usage: "/skills",
    kind: "local",
    execute: async (): Promise<LocalCommandResult> => ({
      type: "local",
      action: "skills",
      message: await renderSkillListCommand(loader),
    }),
  };
}

function createSkillCommand(loader: SkillLoader): SlashCommand {
  return {
    name: "skill",
    aliases: ["use-skill"],
    description: "Show a skill body by name",
    usage: "/skill <name>",
    kind: "local",
    execute: async (input): Promise<LocalCommandResult> => ({
      type: "local",
      action: "message",
      message: input.args ? await renderSkillCommand(loader, input.args) : "Usage: /skill <name>",
    }),
  };
}

function createMarkdownPromptCommand(command: MarkdownPromptCommand): SlashCommand {
  return {
    name: command.name,
    description: command.description || `Run ${command.name}`,
    usage: command.argumentHint ? `/${command.name} ${command.argumentHint}` : `/${command.name}`,
    kind: "prompt",
    execute: (input): PromptCommandResult => ({
      type: "prompt",
      prompt: renderMarkdownCommandPrompt(command, input.args),
      metadata: {
        source: command.source,
        sourcePath: command.sourcePath,
        allowedTools: command.allowedTools,
        model: command.model,
      },
    }),
  };
}
