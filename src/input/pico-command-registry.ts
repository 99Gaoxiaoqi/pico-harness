import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillLoader } from "../context/skill.js";
import { FullCompactor } from "../context/full-compactor.js";
import { globalSessionManager, type Session } from "../engine/session.js";
import {
  defaultCliSessionId,
  listFileHistorySnapshotSummaries,
  parseRewindMode,
  rewindFileHistoryFromCli,
} from "../cli/file-history.js";
import {
  formatRewindSelector,
  latestSnapshotMessageId,
} from "../tui/rewind-selector.js";
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
import { createProvider, type ProviderKind } from "../provider/factory.js";
import { loadApiKeys } from "../provider/config.js";
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
  session?: Session;
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
      command.name !== "compact" &&
      command.name !== "init" &&
      command.name !== "doctor" &&
      command.name !== "tools" &&
      command.name !== "thinking",
  );
  const registry = new CommandRegistry([
    ...builtins,
    createStatusCommand(settings),
    createCompactCommand(options),
    createInitCommand(options),
    createDoctorCommand(options),
    createModelCommand(settings),
    createThinkingCommand(settings),
    createToolsCommand(settings),
    createSnapshotsCommand(options),
    createRewindCommand(options),
    createUndoCommand(options),
    createSkillsCommand(skillLoader),
    createSkillCommand(skillLoader),
  ]);

  const markdownCommands = await loadMarkdownCommands({
    workDir: options.workDir,
    includeSkillCommands: true,
    skillLoader,
    builtinNames: registry.list().flatMap((command) => [
      command.name,
      ...(command.aliases ?? []),
    ]),
  });
  for (const command of markdownCommands) {
    if (registry.has(command.name)) continue;
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

function createCompactCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "compact",
    description: "Compact current session context",
    usage: "/compact",
    kind: "local",
    execute: async (): Promise<LocalCommandResult> => {
      if (!options.session) {
        return {
          type: "local",
          action: "message",
          message:
            "Compact unavailable: no live session was provided to the command registry.",
        };
      }

      const retainLastN = 6;
      if (options.session.length <= retainLastN) {
        return {
          type: "local",
          action: "message",
          message: `Compact skipped: session has ${options.session.length} messages; keeping the last ${retainLastN} would leave no history prefix to compact.`,
        };
      }

      const baseURL = process.env.LLM_BASE_URL;
      const apiKey = loadApiKeys()[0];
      if (!baseURL || !apiKey) {
        return {
          type: "local",
          action: "message",
          message:
            "Compact unavailable: missing LLM_BASE_URL or LLM_API_KEY[S], so FullCompactor cannot call the summary model.",
        };
      }

      try {
        const before = options.session.length;
        const provider = createProvider(options.provider, {
          baseURL,
          apiKey,
          model: options.model,
        });
        const ok = await new FullCompactor({ provider }).compact(options.session, retainLastN);
        return {
          type: "local",
          action: "message",
          message: ok
            ? `Compact complete: session history ${before} -> ${options.session.length} messages.`
            : "Compact unavailable: FullCompactor could not produce a valid summary.",
        };
      } catch (error) {
        return {
          type: "local",
          action: "message",
          message: `Compact failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

function createInitCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "init",
    description: "Create lightweight Pico project entry files",
    usage: "/init",
    kind: "local",
    execute: (): LocalCommandResult => ({
      type: "local",
      action: "message",
      message: initializeProjectEntrypoints(options.workDir),
    }),
  };
}

function createDoctorCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "doctor",
    description: "Diagnose local Pico configuration",
    usage: "/doctor",
    kind: "local",
    execute: (): LocalCommandResult => ({
      type: "local",
      action: "message",
      message: formatDoctorReport(options),
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

function createSnapshotsCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "snapshots",
    aliases: ["snapshot"],
    description: "List current session rewind points",
    usage: "/snapshots",
    kind: "local",
    execute: async (): Promise<LocalCommandResult> => {
      const session = await resolveCommandSession(options);
      const summaries = listFileHistorySnapshotSummaries(session);
      return {
        type: "local",
        action: "message",
        message: formatRewindSelector(session.id, summaries),
        data: summaries,
      };
    },
  };
}

function createRewindCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "rewind",
    description: "Rewind code, conversation, or both to a file-history snapshot",
    usage: "/rewind [message-id] [code|conversation|both]",
    kind: "local",
    execute: async (input): Promise<LocalCommandResult> => {
      const session = await resolveCommandSession(options);
      const messageId = input.argv[0];
      const mode = parseRewindMode(input.argv[1]);
      const result = await rewindFileHistoryFromCli(session, messageId, mode);
      return {
        type: "local",
        action: "message",
        message: result.changed
          ? result.output
          : formatRewindSelector(session.id, listFileHistorySnapshotSummaries(session)),
      };
    },
  };
}

function createUndoCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "undo",
    description: "Undo the latest file-history snapshot",
    usage: "/undo [message-id] [code|conversation|both]",
    kind: "local",
    execute: async (input): Promise<LocalCommandResult> => {
      const session = await resolveCommandSession(options);
      const summaries = listFileHistorySnapshotSummaries(session);
      const messageId = input.argv[0] ?? latestSnapshotMessageId(summaries);
      if (!messageId) {
        return {
          type: "local",
          action: "message",
          message: formatRewindSelector(session.id, summaries),
        };
      }

      const mode = parseRewindMode(input.argv[1]);
      const result = await rewindFileHistoryFromCli(session, messageId, mode);
      return {
        type: "local",
        action: "message",
        message: result.output,
      };
    },
  };
}

async function resolveCommandSession(options: PicoCommandRegistryOptions): Promise<Session> {
  if (options.session) return options.session;
  return globalSessionManager.getOrCreate(
    options.sessionId ?? defaultCliSessionId(options.workDir),
    options.workDir,
  );
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

function initializeProjectEntrypoints(workDir: string): string {
  const messages: string[] = [];
  const agentsPath = join(workDir, "AGENTS.md");
  const picoDir = join(workDir, ".pico");
  const configPath = join(picoDir, "config.json");

  if (existsSync(agentsPath)) {
    messages.push("AGENTS.md already exists");
  } else {
    writeFileSync(
      agentsPath,
      [
        "# AGENTS.md",
        "",
        "## Project Guidance",
        "",
        "- Keep changes small and easy to review.",
        "- Prefer existing project conventions before adding new patterns.",
        "",
      ].join("\n"),
    );
    messages.push("Created AGENTS.md");
  }

  mkdirSync(picoDir, { recursive: true });
  if (existsSync(configPath)) {
    messages.push(".pico/config.json already exists");
  } else {
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          commandsDir: ".pico/commands",
        },
        null,
        2,
      )}\n`,
    );
    messages.push("Created .pico/config.json");
  }

  return messages.join("\n");
}

function formatDoctorReport(options: PicoCommandRegistryOptions): string {
  const envPath = join(options.workDir, ".env");
  const apiKeys = loadApiKeys();
  const nodeMajor = Number(process.versions.node.split(".")[0] ?? "0");
  const nodeOk = nodeMajor >= 22;
  const cwdOk = existsSync(options.workDir);
  const envModel = process.env.LLM_MODEL;

  return [
    `CWD: ${options.workDir} (${cwdOk ? "ok" : "missing"})`,
    `.env: ${existsSync(envPath) ? "found" : "missing"}`,
    `Provider: ${options.provider}`,
    `Model: ${options.model}${envModel && envModel !== options.model ? ` (env: ${envModel})` : ""}`,
    `LLM_BASE_URL: ${process.env.LLM_BASE_URL ? "set" : "missing"}`,
    `LLM_API_KEY[S]: ${apiKeys.length > 0 ? `${apiKeys.length} configured` : "missing"}`,
    `Node: ${process.version} (${nodeOk ? "ok" : "requires >=22.0.0"})`,
  ].join("\n");
}
