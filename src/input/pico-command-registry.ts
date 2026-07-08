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
import type { ProviderKind } from "../provider/factory.js";
import { buildDefaultToolRegistry } from "../tools/default-registry.js";
import {
  formatSessionStatus,
  formatToolStatus,
  getOrCreateSessionSettings,
  parseThinkingEffortArg,
  setSessionModel,
  setSessionThinkingEffort,
  toolStatusFromRegistry,
  type SessionSettings,
  type SessionToolStatus,
} from "./session-settings.js";
import type { ThinkingEffort } from "../provider/thinking.js";

export interface PicoCommandRegistryOptions {
  workDir: string;
  model: string;
  provider: ProviderKind;
  sessionId?: string;
  thinkingEffort?: ThinkingEffort;
  permissionMode?: string;
  tools?: readonly SessionToolStatus[];
}

export async function createPicoCommandRegistry(
  options: PicoCommandRegistryOptions,
): Promise<CommandRegistry> {
  const skillLoader = new SkillLoader(options.workDir);
  const tools =
    options.tools ?? toolStatusFromRegistry(buildDefaultToolRegistry(options.workDir));
  const settings = getOrCreateSessionSettings({
    sessionId: options.sessionId ?? `cwd:${options.workDir}`,
    cwd: options.workDir,
    provider: options.provider,
    model: options.model,
    ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
    ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
    tools,
  });
  const builtins = createBuiltinCommands().filter(
    (command) =>
      command.name !== "skills" &&
      command.name !== "skill" &&
      command.name !== "model" &&
      command.name !== "status" &&
      command.name !== "tools" &&
      command.name !== "thinking",
  );
  const registry = new CommandRegistry([
    ...builtins,
    createStatusCommand(settings),
    createModelCommand(settings),
    createThinkingCommand(settings),
    createToolsCommand(settings),
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

function createStatusCommand(settings: SessionSettings): SlashCommand {
  return {
    name: "status",
    aliases: ["st"],
    description: "Show current TUI/session status",
    usage: "/status",
    kind: "local",
    execute: (): LocalCommandResult => ({
      type: "local",
      action: "status",
      message: formatSessionStatus(settings),
    }),
  };
}

function createModelCommand(settings: SessionSettings): SlashCommand {
  return {
    name: "model",
    aliases: ["models", "mode"],
    description: "Show or change the active model",
    usage: "/model [name]",
    kind: "local",
    execute: (input): LocalCommandResult => {
      const result = setSessionModel(settings, input.args);
      return {
        type: "local",
        action: "model",
        message: result.message,
        data: { model: settings.model },
      };
    },
  };
}

function createThinkingCommand(settings: SessionSettings): SlashCommand {
  return {
    name: "thinking",
    aliases: ["effort"],
    description: "Show or change thinking effort",
    usage: "/thinking <off|low|medium|high>",
    kind: "local",
    execute: (input): LocalCommandResult => {
      const effort = parseThinkingEffortArg(input.args);
      if (effort === undefined) {
        return {
          type: "local",
          action: "thinking",
          message: `Current thinking effort: ${settings.thinkingEffort}\nUsage: /thinking <off|low|medium|high>`,
        };
      }

      const result = setSessionThinkingEffort(settings, effort);
      return {
        type: "local",
        action: "thinking",
        message: result.message,
        data: { ok: result.ok, thinkingEffort: settings.thinkingEffort },
      };
    },
  };
}

function createToolsCommand(settings: SessionSettings): SlashCommand {
  return {
    name: "tools",
    aliases: ["tool"],
    description: "List available tools",
    usage: "/tools",
    kind: "local",
    execute: (): LocalCommandResult => ({
      type: "local",
      action: "tools",
      message: formatToolStatus(settings.tools),
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
