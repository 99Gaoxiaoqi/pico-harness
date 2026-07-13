import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillLoader } from "../context/skill.js";
import { FullCompactor } from "../context/full-compactor.js";
import { globalSessionManager, type Session } from "../engine/session.js";
import { defaultCliSessionId, listFileHistorySnapshotSummaries } from "../cli/file-history.js";
import { formatRewindSelector, formatRewindUsage } from "../tui/rewind-selector.js";
import { formatSessionCandidateDetails, sessionDisplayTitle } from "../tui/session-presentation.js";
import { listCliSessionSummaries } from "../cli/session-resolver.js";
import { createBuiltinCommands } from "./builtin-commands.js";
import { createAddDirectoryCommand, type AdditionalDirectoryManager } from "./add-directory.js";
import { CommandRegistry } from "./command-registry.js";
import {
  loadMarkdownCommands,
  renderMarkdownCommandPrompt,
  type MarkdownPromptCommand,
} from "./markdown-command-loader.js";
import {
  renderSkillCommand,
  renderSkillListCommand,
  resolveSkillCommand,
} from "./skill-commands.js";
import { renderSkillActivation } from "./skill-activation.js";
import {
  loadClaudeAgents,
  summarizeClaudeAgents,
  type ClaudeAgent,
  type ClaudeAgentSummary,
  type ClaudeAgentSource,
} from "./agent-loader.js";
import type {
  CommandListOptions,
  LocalCommandResult,
  PromptCommandResult,
  SlashArgumentCandidate,
  SlashCommand,
} from "./types.js";
import { createProvider, type ProviderKind } from "../provider/factory.js";
import { type ModelRouter } from "../provider/model-router.js";
import { loadApiKeys } from "../provider/config.js";
import { buildDefaultToolRegistry } from "../tools/default-registry.js";
import {
  formatSessionStatus,
  formatSessionReasoningStatus,
  effectiveSessionReasoningLevel,
  getOrCreateSessionSettings,
  parseThinkingEffortArg,
  sessionReasoningCandidates,
  setSessionMode,
  setSessionModel,
  setSessionModelRoute,
  setSessionPermissionMode,
  setSessionTitle,
  setSessionThinkingEffort,
  toolStatusFromRegistry,
  type SessionMode,
  type SessionSettings,
  type SessionToolStatus,
} from "./session-settings.js";
import type { McpStatusSnapshot } from "../mcp/manager.js";
import type { GoalManager } from "../engine/goal-manager.js";
import type { ModelRuntimeCommandService } from "../provider/model-runtime-report.js";
import type { TaskHostRuntime } from "../tasks/task-runtime.js";
import type { McpConnectionManager } from "../mcp/manager.js";
import {
  getDefaultSessionCatalogProjector,
  readSessionCatalogProjectionHealth,
} from "../storage/session-catalog-projection.js";

const OVERRIDDEN_BUILTIN_COMMANDS = new Set([
  "skills",
  "skill",
  "model",
  "mode",
  "permissions",
  "status",
  "compact",
  "init",
  "doctor",
  "mcp",
  "thinking",
  "agents",
]);

export type McpStatusProvider = () => McpStatusSnapshot | undefined;

export interface PicoCommandRegistryOptions {
  workDir: string;
  projectCommandsDir?: string;
  model: string;
  modelRouteId?: string;
  modelRouter?: ModelRouter;
  provider: ProviderKind;
  session?: Session;
  sessionId?: string;
  sessionMode?: SessionMode;
  forkFrom?: string;
  thinkingEffort?: string;
  permissionMode?: string;
  tools?: readonly SessionToolStatus[];
  mcpStatus?: McpStatusProvider;
  additionalDirectories?: readonly string[];
  additionalDirectoryManager?: AdditionalDirectoryManager;
  goalManager?: GoalManager;
  modelRuntime?: () => Pick<ModelRuntimeCommandService, "execute"> | undefined;
  taskRuntime?: TaskHostRuntime;
  mcpControl?: McpConnectionManager;
}

export async function createPicoCommandRegistry(
  options: PicoCommandRegistryOptions,
): Promise<CommandRegistry> {
  const skillLoader = new SkillLoader(options.workDir);
  const tools = options.tools ?? toolStatusFromRegistry(buildDefaultToolRegistry(options.workDir));
  const settings = getOrCreateSessionSettings(
    {
      sessionId: options.sessionId ?? `cwd:${options.workDir}`,
      ...(options.sessionMode !== undefined ? { sessionMode: options.sessionMode } : {}),
      ...(options.forkFrom !== undefined ? { forkFrom: options.forkFrom } : {}),
      cwd: options.workDir,
      provider: options.provider,
      model: options.model,
      ...(options.modelRouteId !== undefined ? { modelRouteId: options.modelRouteId } : {}),
      ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
      ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
      tools,
      ...(options.additionalDirectories !== undefined
        ? { additionalDirectories: options.additionalDirectories }
        : {}),
    },
    options.session ? { persistence: options.session } : undefined,
  );
  const builtins = createBuiltinCommands().filter(
    (command) => !OVERRIDDEN_BUILTIN_COMMANDS.has(command.name),
  );
  const registry = new CommandRegistry([
    ...builtins,
    createStatusCommand(settings, options.session, options.mcpStatus),
    createModelRuntimeCommand("usage", options.modelRuntime),
    createModelRuntimeCommand("context", options.modelRuntime),
    createGoalCommand(options.goalManager),
    createModeCommand(settings),
    createPermissionsCommand(settings),
    createCompactCommand(options, settings),
    createInitCommand(options),
    createDoctorCommand(options),
    createModelCommand(settings, options.modelRouter),
    createAddDirectoryCommand(settings, options.additionalDirectoryManager),
    createThinkingCommand(settings, options.modelRouter),
    createMcpCommand(options.mcpStatus, options.mcpControl),
    createAgentsCommand(options),
    createSessionsCommand(options),
    createRenameCommand(settings),
    createResumeCommand(options),
    createForkCommand(options),
    ...createRunningInputCommands(),
    createChangesCommand(options),
    createSnapshotsCommand(options),
    createRewindCommand(options),
    createAgentCommand(options),
    createSkillsCommand(skillLoader),
    createSkillCommand(skillLoader),
  ]);

  const markdownCommands = await loadMarkdownCommands({
    workDir: options.workDir,
    ...(options.projectCommandsDir !== undefined
      ? { projectCommandsDir: options.projectCommandsDir }
      : {}),
    includeSkillCommands: true,
    skillLoader,
    builtinNames: registry.list().flatMap((command) => [command.name, ...(command.aliases ?? [])]),
  });
  for (const command of markdownCommands) {
    if (registry.has(command.name)) continue;
    registry.register(createMarkdownPromptCommand(command));
  }

  return registry;
}

export function commandSuggestions(
  registry: CommandRegistry,
  query: string,
  options: Pick<CommandListOptions, "availabilityState"> = {},
): Array<{
  value: string;
  description?: string;
  argumentHint?: string;
  source?: string;
  kind?: string;
  category?: string;
  usage?: string;
  matchedAlias?: string;
  disabled?: boolean;
  disabledReason?: string;
}> {
  return registry
    .detailedSuggestions(query, { availabilityState: options.availabilityState })
    .map((command) => ({
      value: command.insertText,
      description: command.description,
      source: command.source,
      kind: command.kind,
      ...(command.category === undefined ? {} : { category: command.category }),
      ...(command.usage === undefined ? {} : { usage: command.usage }),
      ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
      ...(command.matchedAlias === undefined ? {} : { matchedAlias: command.matchedAlias }),
      ...(command.disabled === true ? { disabled: true } : {}),
      ...(command.disabledReason === undefined ? {} : { disabledReason: command.disabledReason }),
    }));
}

export function commandArgumentSuggestions(
  registry: CommandRegistry,
  commandName: string,
  query: string,
): Promise<readonly SlashArgumentCandidate[]> {
  const command = registry.resolve(commandName);
  const result = command?.argumentCompleter?.(query) ?? [];
  return Promise.resolve(result).then((items) => [...items]);
}

const MODE_CANDIDATES: readonly SlashArgumentCandidate[] = [
  { value: "default", description: "Normal interactive mode" },
  { value: "plan", description: "Plan before acting" },
  { value: "auto", description: "Autonomous mode" },
  { value: "yolo", description: "YOLO mode" },
];

const PERMISSION_CANDIDATES: readonly SlashArgumentCandidate[] = [
  { value: "default", description: "Claude-style permission prompts" },
  { value: "auto", description: "Accept ordinary edits" },
  { value: "yolo", description: "Bypass ordinary permission prompts" },
  { value: "plan", description: "Plan without implementation writes" },
];

function completeFromCandidates(
  candidates: readonly SlashArgumentCandidate[],
): (query: string) => readonly SlashArgumentCandidate[] {
  return (query) => filterArgumentCandidates(candidates, query);
}

function filterArgumentCandidates(
  candidates: readonly SlashArgumentCandidate[],
  query: string,
): SlashArgumentCandidate[] {
  const normalized = query.trimStart().toLowerCase();
  return candidates
    .filter((candidate) => candidate.value.toLowerCase().startsWith(normalized))
    .map((candidate) => ({ ...candidate }));
}

function filterSessionArgumentCandidates(
  candidates: readonly SlashArgumentCandidate[],
  query: string,
): SlashArgumentCandidate[] {
  const normalized = query.trimStart().toLowerCase();
  if (!normalized) return candidates.map((candidate) => ({ ...candidate }));
  return candidates
    .filter((candidate) =>
      [candidate.value, candidate.label, candidate.description].some((value) =>
        value?.toLowerCase().includes(normalized),
      ),
    )
    .map((candidate) => ({ ...candidate }));
}

async function loadSkillArgumentCandidates(
  loader: SkillLoader,
): Promise<readonly SlashArgumentCandidate[]> {
  const skills = await loader.listSummaries();
  return skills.map((skill) => ({
    value: skill.name,
    description: skill.description,
  }));
}

async function loadAgentArgumentCandidates(
  workDir: string,
): Promise<readonly SlashArgumentCandidate[]> {
  const agents = await loadClaudeAgents({ workDir, includeBuiltins: true });
  return summarizeClaudeAgents(agents).map((agent) => ({
    value: agent.name,
    description: agent.description,
  }));
}

async function loadSessionArgumentCandidates(
  workDir: string,
  currentSessionId?: string,
): Promise<readonly SlashArgumentCandidate[]> {
  const sessions = await listCliSessionSummaries(workDir);
  const titlesById = new Map(sessions.map((session) => [session.id, sessionDisplayTitle(session)]));
  return sessions.map((session) => {
    const presentation = {
      ...session,
      ...(session.forkFrom ? { forkParentTitle: titlesById.get(session.forkFrom) } : {}),
      isCurrent: session.id === currentSessionId,
    };
    return {
      value: session.id,
      insertText: session.id,
      label: sessionDisplayTitle(presentation),
      description: formatSessionCandidateDetails(presentation),
    };
  });
}

function createStatusCommand(
  settings: SessionSettings,
  session?: Session,
  mcpStatus?: McpStatusProvider,
): SlashCommand {
  return {
    name: "status",
    aliases: ["st"],
    description: "Show current TUI/session status",
    usage: "/status",
    category: "session",
    kind: "local",
    execute: (): LocalCommandResult => ({
      type: "local",
      action: "status",
      message: formatStatusWithMcp(settings, session, mcpStatus),
    }),
  };
}

function createModelRuntimeCommand(
  command: "usage" | "context",
  provider?: () => Pick<ModelRuntimeCommandService, "execute"> | undefined,
): SlashCommand {
  return {
    name: command,
    description:
      command === "usage"
        ? "Show measured model usage and cost coverage"
        : "Show the active route context budget and capabilities",
    usage: `/${command}`,
    category: "model",
    kind: "local",
    availability: "always",
    execute: (input): LocalCommandResult => {
      if (input.args.trim()) {
        return { type: "local", action: "message", message: `Usage: /${command}` };
      }
      const service = provider?.();
      if (!service) {
        return {
          type: "local",
          action: "message",
          message: `/${command} unavailable: no active model route/session runtime.`,
        };
      }
      const result = service.execute(command);
      return { type: "local", action: "message", message: result.message, data: result.data };
    },
  };
}

function createGoalCommand(goalManager?: GoalManager): SlashCommand {
  return {
    name: "goal",
    description: "Show the current session goal",
    usage: "/goal",
    category: "session",
    kind: "local",
    availability: "always",
    execute: (input): LocalCommandResult => {
      if (input.args.trim().length > 0) {
        return {
          type: "local",
          action: "message",
          message: "Usage: /goal",
        };
      }
      if (!goalManager) {
        return {
          type: "local",
          action: "message",
          message: "Goal unavailable: no live TUI runtime was provided.",
        };
      }

      const currentGoal = goalManager.buildGoalContext();
      return {
        type: "local",
        action: "message",
        message:
          currentGoal || "No active goal. Tell Pico the long-running goal you want to track.",
      };
    },
  };
}

function formatStatusWithMcp(
  settings: SessionSettings,
  session: Session | undefined,
  mcpStatus: McpStatusProvider | undefined,
): string {
  const base = [formatSessionStatus(settings), ...formatMemoryBackend(session, false)].join("\n");
  const snapshot = mcpStatus?.();
  if (snapshot === undefined) return base;
  return `${base}\n${formatMcpOverview(snapshot)}`;
}

function createCompactCommand(
  options: PicoCommandRegistryOptions,
  settings: SessionSettings,
): SlashCommand {
  return {
    name: "compact",
    description: "Compact current session context",
    usage: "/compact",
    category: "session",
    kind: "local",
    availability: "idle",
    execute: async (): Promise<LocalCommandResult> => {
      if (!options.session) {
        return {
          type: "local",
          action: "message",
          message: "Compact unavailable: no live session was provided to the command registry.",
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

      let activeProvider = options.provider;
      let activeConfig: { baseURL: string; apiKey: string; model: string } | undefined;
      if (options.modelRouter) {
        try {
          const resolved = options.modelRouter.providerConfig(
            settings.modelRouteId,
            effectiveSessionReasoningLevel(settings, options.modelRouter),
          );
          activeProvider = resolved.provider;
          activeConfig = resolved.config;
        } catch (error) {
          return {
            type: "local",
            action: "message",
            message: `Compact unavailable: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      const baseURL = activeConfig?.baseURL ?? process.env.LLM_BASE_URL;
      const apiKey = activeConfig?.apiKey ?? loadApiKeys()[0];
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
        const provider = createProvider(activeProvider, {
          baseURL,
          apiKey,
          model: activeConfig?.model ?? settings.model,
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
    availability: "idle",
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
    availability: "idle",
    execute: async (): Promise<LocalCommandResult> => ({
      type: "local",
      action: "message",
      message: await formatDoctorReport(options),
    }),
  };
}

function createModelCommand(settings: SessionSettings, router?: ModelRouter): SlashCommand {
  const candidates = (): readonly SlashArgumentCandidate[] =>
    router
      ? router.routes.map((route) => ({
          value: route.id,
          description: `${route.providerId} · ${route.provider}`,
        }))
      : [{ value: settings.model, description: `${settings.provider} · current model` }];
  return {
    name: "model",
    aliases: ["models"],
    description: "Show or change the active model",
    usage: "/model [name]",
    argumentHint: "[name]",
    category: "model",
    argumentCompleter: (query) => filterArgumentCandidates(candidates(), query),
    kind: "local",
    availability: "idle",
    execute: (input): LocalCommandResult => {
      const result = router
        ? input.args.trim().length === 0
          ? {
              ok: false,
              message: `Current model: ${settings.modelRouteId ?? settings.model}`,
            }
          : setSessionModelRoute(settings, router, input.args)
        : setSessionModel(settings, input.args);
      return {
        type: "local",
        action: "model",
        message: result.message,
        data: {
          model: settings.model,
          provider: settings.provider,
          modelRouteId: settings.modelRouteId,
          ok: result.ok,
        },
        ...(input.args.trim().length === 0
          ? { ui: { kind: "open-selector", selector: "model" } as const }
          : {}),
      };
    },
  };
}

function createModeCommand(settings: SessionSettings): SlashCommand {
  return {
    name: "mode",
    description: "Show or change the current interaction mode",
    usage: "/mode <default|plan|auto|yolo>",
    argumentHint: "<default|plan|auto|yolo>",
    category: "session",
    argumentCompleter: completeFromCandidates(MODE_CANDIDATES),
    kind: "local",
    availability: "idle",
    execute: (input): LocalCommandResult => {
      if (input.args.trim().length === 0) {
        return {
          type: "local",
          action: "message",
          message: `Current mode: ${settings.mode}`,
          data: { mode: settings.mode },
        };
      }

      const result = setSessionMode(settings, input.args);
      return {
        type: "local",
        action: "message",
        message: result.message,
        data: { ok: result.ok, mode: settings.mode },
      };
    },
  };
}

function createPermissionsCommand(settings: SessionSettings): SlashCommand {
  return {
    name: "permissions",
    aliases: ["permission"],
    description: "Show or change the current permission mode",
    usage: "/permissions [default|auto|yolo|plan]",
    argumentHint: "[default|auto|yolo|plan]",
    category: "permissions",
    argumentCompleter: completeFromCandidates(PERMISSION_CANDIDATES),
    kind: "local",
    availability: "idle",
    execute: (input): LocalCommandResult => {
      if (input.args.trim().length === 0) {
        return {
          type: "local",
          action: "message",
          message: [
            `Current mode: ${settings.mode}`,
            "/permissions is an alias for /mode.",
            `Authorized directories: ${settings.additionalDirectories.length}`,
            "Usage: /permissions <default|auto|yolo|plan>",
          ].join("\n"),
          data: { mode: settings.mode, permissionMode: settings.mode },
        };
      }

      const result = setSessionPermissionMode(settings, input.args);
      return {
        type: "local",
        action: "message",
        message: result.message,
        data: { ok: result.ok, mode: settings.mode, permissionMode: settings.mode },
      };
    },
  };
}

function createThinkingCommand(settings: SessionSettings, router?: ModelRouter): SlashCommand {
  const candidates = (): readonly SlashArgumentCandidate[] =>
    sessionReasoningCandidates(settings, router).map((level) => ({
      value: level,
      description: `Use ${level} reasoning for the current model`,
    }));
  return {
    name: "thinking",
    aliases: ["effort"],
    description: "Show or change thinking effort",
    usage: "/thinking [level]",
    argumentHint: "[model level]",
    category: "model",
    argumentCompleter: (query) => filterArgumentCandidates(candidates(), query),
    kind: "local",
    availability: "idle",
    execute: (input): LocalCommandResult => {
      const raw = input.args.trim();
      if (raw.length === 0) {
        return {
          type: "local",
          action: "thinking",
          message: formatSessionReasoningStatus(settings, router),
        };
      }

      const effort = router ? raw : parseThinkingEffortArg(raw);
      const result =
        effort === undefined
          ? {
              ok: false,
              message: formatSessionReasoningStatus(settings),
            }
          : setSessionThinkingEffort(settings, effort, router);
      return {
        type: "local",
        action: "thinking",
        message: result.message,
        data: { ok: result.ok, thinkingEffort: settings.thinkingEffort },
      };
    },
  };
}

function createMcpCommand(
  mcpStatus?: McpStatusProvider,
  mcpControl?: McpConnectionManager,
): SlashCommand {
  return {
    name: "mcp",
    description: "Inspect and control MCP server connections",
    usage: "/mcp [reload|enable|disable|reconnect|resources|read|prompts|prompt|auth]",
    category: "mcp",
    kind: "local",
    execute: async (input): Promise<LocalCommandResult> => {
      if (!input.argv[0]) {
        return { type: "local", action: "mcp", message: formatMcpStatus(mcpStatus?.()) };
      }
      if (!mcpControl) {
        return { type: "local", action: "mcp", message: "MCP lifecycle manager unavailable." };
      }
      const [action, server, value, ...rest] = input.argv;
      try {
        if (action === "reload") await mcpControl.reload(server);
        else if (action === "enable" && server) await mcpControl.enable(server);
        else if (action === "disable" && server) await mcpControl.disable(server);
        else if (action === "reconnect" && server) await mcpControl.reconnect(server);
        else if (action === "auth" && server) await mcpControl.authenticate(server);
        else if (action === "resources" && server) {
          return mcpResult(await mcpControl.listResources(server));
        } else if (action === "read" && server && value) {
          return mcpResult(await mcpControl.readResource(server, value));
        } else if (action === "prompts" && server) {
          return mcpResult(await mcpControl.listPrompts(server));
        } else if (action === "prompt" && server && value) {
          const rawArgs = rest.join(" ").trim();
          const args = rawArgs ? (JSON.parse(rawArgs) as Record<string, string>) : undefined;
          return mcpResult(await mcpControl.getPrompt(server, value, args));
        } else {
          return {
            type: "local",
            action: "mcp",
            message:
              "Usage: /mcp [reload [path]|enable <server>|disable <server>|reconnect <server>|resources <server>|read <server> <uri>|prompts <server>|prompt <server> <name> [json]|auth <server>]",
          };
        }
        return { type: "local", action: "mcp", message: formatMcpStatus(mcpStatus?.()) };
      } catch (error) {
        return {
          type: "local",
          action: "mcp",
          message: `MCP command failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

function mcpResult(value: unknown): LocalCommandResult {
  return { type: "local", action: "mcp", message: JSON.stringify(value, null, 2) };
}

function formatMcpStatus(snapshot: McpStatusSnapshot | undefined): string {
  if (snapshot === undefined) {
    return "MCP status\nNo MCP config loaded.";
  }

  const lines = [
    "MCP status",
    `Config: ${snapshot.configPath ?? "(not loaded)"}`,
    formatMcpSummary(snapshot),
  ];

  if (snapshot.servers.length === 0) {
    lines.push("No MCP servers loaded.");
    if (snapshot.loadError) lines.push(`Error: ${snapshot.loadError}`);
    return lines.join("\n");
  }

  for (const server of snapshot.servers) {
    lines.push(
      `- ${server.name} [${server.transport}] ${server.status} - ${formatToolCount(server.toolCount)}${formatToolSummary(server.toolNames)}`,
    );
    if (server.error) lines.push(`  error: ${server.error}`);
  }

  if (snapshot.loadError) lines.push(`Load error: ${snapshot.loadError}`);
  return lines.join("\n");
}

function formatMcpOverview(snapshot: McpStatusSnapshot): string {
  const summary = snapshot.summary;
  const parts = [
    `MCP: ${summary.connected}/${summary.total} connected`,
    `${summary.failed} failed`,
    `${summary.toolCount} tools`,
  ];
  if (summary.disabled > 0) parts.splice(2, 0, `${summary.disabled} disabled`);
  if (summary.pending > 0) parts.splice(2, 0, `${summary.pending} pending`);
  if (snapshot.loadError) parts.push("load error");
  return parts.join(", ");
}

function formatMcpSummary(snapshot: McpStatusSnapshot): string {
  const summary = snapshot.summary;
  const parts = [
    `Summary: ${summary.connected}/${summary.total} connected`,
    `${summary.failed} failed`,
  ];
  if (summary.disabled > 0) parts.push(`${summary.disabled} disabled`);
  if (summary.pending > 0) parts.push(`${summary.pending} pending`);
  parts.push(`${summary.toolCount} tools`);
  return parts.join(", ");
}

function formatToolCount(count: number): string {
  return count === 1 ? "1 tool" : `${count} tools`;
}

function formatToolSummary(toolNames: readonly string[]): string {
  if (toolNames.length === 0) return "";
  const visible = toolNames.slice(0, 5);
  const suffix =
    toolNames.length > visible.length ? `, +${toolNames.length - visible.length} more` : "";
  return `: ${visible.join(", ")}${suffix}`;
}

function createAgentsCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "agents",
    description: "List available subagents",
    usage: "/agents",
    kind: "local",
    availability: "idle",
    execute: async (): Promise<LocalCommandResult> => {
      const agents = summarizeClaudeAgents(
        await loadClaudeAgents({ workDir: options.workDir, includeBuiltins: true }),
        { includeSource: true },
      );
      return {
        type: "local",
        action: "agents",
        message: formatAgentSummaries(agents),
        data: agents,
      };
    },
  };
}

function formatAgentSummaries(agents: readonly ClaudeAgentSummary[]): string {
  if (agents.length === 0) return "No agents available.";

  return [
    "Available Agents:",
    ...agents.map((agent) => {
      const description = agent.description ? `: ${agent.description}` : "";
      const tools =
        agent.tools && agent.tools.length > 0 ? ` (tools: ${agent.tools.join(", ")})` : "";
      return `- ${agent.name} [${formatAgentSource(agent.source)}]${description}${tools}`;
    }),
  ].join("\n");
}

function formatAgentSource(source: ClaudeAgentSource | undefined): string {
  if (source === undefined) return "unknown";
  return source === "builtin" ? "built-in" : source;
}

function createSessionsCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "sessions",
    aliases: ["session-list"],
    description: "List resumable sessions for this project",
    usage: "/sessions",
    category: "session",
    kind: "local",
    availability: "idle",
    execute: async (): Promise<LocalCommandResult> => {
      const summaries = await listCliSessionSummaries(options.workDir);
      return {
        type: "local",
        action: "message",
        message:
          summaries.length === 0
            ? "当前项目暂无可恢复 session。"
            : `找到 ${summaries.length} 个可恢复 session。`,
        data: summaries,
        ui: { kind: "open-selector", selector: "session" },
      };
    },
  };
}

function createRenameCommand(settings: SessionSettings): SlashCommand {
  return {
    name: "rename",
    description: "Rename the current session",
    usage: "/rename <title>",
    argumentHint: "<title>",
    category: "session",
    kind: "local",
    availability: "idle",
    execute: (input): LocalCommandResult => {
      const result = setSessionTitle(settings, input.args);
      return {
        type: "local",
        action: "message",
        message: result.message,
        data: { ok: result.ok, title: settings.title },
      };
    },
  };
}

function createResumeCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "resume",
    description: "Switch this TUI to a saved session",
    usage: "/resume <session-id>",
    argumentHint: "<session-id>",
    category: "session",
    argumentCompleter: async (query) =>
      filterSessionArgumentCandidates(
        await loadSessionArgumentCandidates(options.workDir, options.sessionId),
        query,
      ),
    kind: "local",
    availability: "idle",
    execute: async (input): Promise<LocalCommandResult> => {
      const sessionId = input.argv[0];
      if (!sessionId) {
        return {
          type: "local",
          action: "message",
          message: [
            "Usage: /resume <session-id>",
            "先用 /sessions 查看可恢复 session。",
            "启动时可使用 --session <session-id> / -S <session-id> 恢复指定会话，或使用 --continue / -c 继续当前项目最近会话。",
          ].join("\n"),
        };
      }

      if (!(await sessionExists(options.workDir, sessionId))) {
        return {
          type: "local",
          action: "message",
          message: `Cannot resume session ${sessionId}: no saved session was found.`,
        };
      }

      return {
        type: "local",
        action: "resume",
        message: `Switching to session: ${sessionId}`,
        data: { sessionId, mode: "resume" },
      };
    },
  };
}

function createForkCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "fork",
    description: "Fork a saved session and switch this TUI to the new branch",
    usage: "/fork <session-id>",
    argumentHint: "<session-id>",
    category: "session",
    argumentCompleter: async (query) =>
      filterSessionArgumentCandidates(
        await loadSessionArgumentCandidates(options.workDir, options.sessionId),
        query,
      ),
    kind: "local",
    availability: "idle",
    execute: async (input): Promise<LocalCommandResult> => {
      const sessionId = input.argv[0];
      if (!sessionId) {
        return {
          type: "local",
          action: "message",
          message: "Usage: /fork <session-id>",
        };
      }
      if (!(await sessionExists(options.workDir, sessionId))) {
        return {
          type: "local",
          action: "message",
          message: `Cannot fork session ${sessionId}: no saved session was found.`,
        };
      }
      return {
        type: "local",
        action: "resume",
        message: `Forking session: ${sessionId}`,
        data: { sessionId, mode: "fork" },
      };
    },
  };
}

async function sessionExists(workDir: string, sessionId: string): Promise<boolean> {
  return (await listCliSessionSummaries(workDir)).some((session) => session.id === sessionId);
}

function createRunningInputCommands(): SlashCommand[] {
  return [
    runningInputCommand(
      "steer",
      "Guide the active run at the next model boundary",
      "/steer <guidance>",
    ),
    runningInputCommand("queue", "Queue a prompt as the next user turn", "/queue <prompt>"),
    runningInputCommand(
      "replace",
      "Interrupt the active run and replace it with a new prompt",
      "/replace <prompt>",
    ),
    {
      name: "interrupt",
      description: "Interrupt the active run and drop queued input",
      usage: "/interrupt",
      category: "session",
      kind: "local",
      availability: "running",
      execute: (): LocalCommandResult => ({
        type: "local",
        action: "message",
        message: "Interrupting the active run.",
      }),
    },
  ];
}

function runningInputCommand(name: string, description: string, usage: string): SlashCommand {
  return {
    name,
    description,
    usage,
    argumentHint: "<text>",
    category: "session",
    kind: "local",
    availability: "running",
    execute: (input): LocalCommandResult => ({
      type: "local",
      action: "message",
      message: input.args.trim().length > 0 ? `${name} input accepted.` : `Usage: ${usage}`,
    }),
  };
}

function createSnapshotsCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "snapshots",
    aliases: ["snapshot"],
    description: "List current session rewind points",
    usage: "/snapshots",
    category: "session",
    kind: "local",
    availability: "idle",
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

function createChangesCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "changes",
    description: "Preview a message checkpoint and partially rewind one file",
    usage: "/changes [message-id]",
    argumentHint: "[message-id]",
    category: "session",
    kind: "local",
    availability: "idle",
    argumentCompleter: async (query) => {
      const session = await resolveCommandSession(options);
      return filterArgumentCandidates(
        listFileHistorySnapshotSummaries(session).map((snapshot) => ({
          value: snapshot.messageId,
          description: snapshot.userPrompt ?? snapshot.changeSummary,
        })),
        query,
      );
    },
    execute: async (input): Promise<LocalCommandResult> => {
      const session = await resolveCommandSession(options);
      const snapshots = listFileHistorySnapshotSummaries(session);
      const requested = input.argv[0];
      const target = requested
        ? snapshots.find((snapshot) => snapshot.messageId === requested)
        : (snapshots.findLast((snapshot) => !snapshot.legacy) ?? snapshots.at(-1));
      if (!target) {
        return {
          type: "local",
          action: "message",
          message: requested
            ? `Cannot open Changes: checkpoint ${requested} was not found.`
            : "No message checkpoint is available yet.",
        };
      }
      return {
        type: "local",
        action: "changes",
        message: `Opening partial rewind preview for ${target.messageId}.`,
        data: { messageId: target.messageId },
      };
    },
  };
}

function createRewindCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "rewind",
    aliases: ["checkpoint"],
    description: "Open the rewind menu for code and conversation checkpoints",
    usage: "/rewind",
    category: "session",
    kind: "local",
    availability: "idle",
    execute: async (input): Promise<LocalCommandResult> => {
      const session = await resolveCommandSession(options);
      const summaries = listFileHistorySnapshotSummaries(session);
      return {
        type: "local",
        action: "message",
        message:
          input.argv.length === 0
            ? formatRewindUsage(session.id, summaries)
            : `直接 message-id 回滚已收敛到交互菜单。请在列表中选择目标消息。\n${formatRewindUsage(session.id, summaries)}`,
        ui: { kind: "open-selector", selector: "rewind" },
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
    category: "skill",
    kind: "local",
    availability: "idle",
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
    description: "Activate a skill and run it with the agent",
    usage: "/skill <name> [arguments]",
    argumentHint: "<name> [arguments]",
    category: "skill",
    argumentCompleter: async (query) =>
      filterArgumentCandidates(await loadSkillArgumentCandidates(loader), query),
    kind: "prompt",
    availability: "idle",
    execute: async (input): Promise<PromptCommandResult | LocalCommandResult> => {
      const skillName = input.argv[0];
      if (!skillName) {
        return { type: "local", action: "message", message: "Usage: /skill <name> [arguments]" };
      }
      const resolved = await resolveSkillCommand(loader, skillName);
      if (!resolved.found) {
        return {
          type: "local",
          action: "message",
          message: await renderSkillCommand(loader, skillName),
        };
      }
      const skillArgs = input.args.match(/^\S+(?:\s+([\s\S]*))?$/)?.[1] ?? "";
      const activation = renderSkillActivation({
        name: resolved.name,
        args: skillArgs,
        body: resolved.body,
        sourcePath: await loader.viewSourcePath(resolved.name),
        trigger: "user-slash",
      });
      return {
        type: "prompt",
        prompt: activation.prompt,
        metadata: { ...activation.metadata },
      };
    },
  };
}

function createAgentCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "agent",
    description: "Dispatch a task to a named subagent",
    usage: "/agent <name> <task>",
    argumentHint: "<name> <task>",
    category: "agent",
    argumentCompleter: async (query) =>
      filterArgumentCandidates(await loadAgentArgumentCandidates(options.workDir), query),
    kind: "prompt",
    execute: async (input): Promise<PromptCommandResult | LocalCommandResult> => {
      const agentName = input.argv[0]?.trim();
      const task = input.argv.slice(1).join(" ").trim();
      if (!agentName || !task) {
        return {
          type: "local",
          action: "message",
          message: formatAgentUsage(),
        };
      }

      const agents = await loadClaudeAgents({ workDir: options.workDir, includeBuiltins: true });
      const agent = findAgentByName(agents, agentName);
      if (!agent) {
        return {
          type: "local",
          action: "message",
          message: formatAgentNotFound(agentName, agents),
        };
      }

      return {
        type: "prompt",
        prompt: renderAgentDispatchPrompt(agent, task),
        metadata: {
          agentName: agent.name,
          sourcePath: agent.sourcePath,
          task,
          toolName: "delegate_task",
        },
      };
    },
  };
}

function formatAgentUsage(): string {
  return "Usage: /agent <name> <task>\n先用 /agents 查看可用 Agent。";
}

function findAgentByName(agents: readonly ClaudeAgent[], name: string): ClaudeAgent | undefined {
  return (
    agents.find((agent) => agent.name === name) ??
    agents.find((agent) => agent.name.toLowerCase() === name.toLowerCase())
  );
}

function formatAgentNotFound(name: string, agents: readonly ClaudeAgent[]): string {
  if (agents.length === 0) {
    return `未找到 Agent: ${name}\n当前没有可用 Agents。\n${formatAgentUsage()}`;
  }

  const suggestion = closestAgentName(
    name,
    agents.map((agent) => agent.name),
  );
  const lines = [
    `未找到 Agent: ${name}`,
    suggestion
      ? `Did you mean: ${suggestion}`
      : `可用 Agents: ${agents.map((agent) => agent.name).join(", ")}`,
    formatAgentUsage(),
  ];
  return lines.join("\n");
}

function closestAgentName(name: string, candidates: readonly string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (!best || distance < best.distance) {
      best = { name: candidate, distance };
    }
  }
  return best?.name;
}

function renderAgentDispatchPrompt(agent: ClaudeAgent, task: string): string {
  const context = [
    `Claude agent profile: ${agent.name}`,
    agent.description ? `Description: ${agent.description}` : undefined,
    `Source: ${agent.sourcePath}`,
    agent.tools && agent.tools.length > 0 ? `Declared tools: ${agent.tools.join(", ")}` : undefined,
    "",
    "Agent instructions:",
    agent.prompt || "(empty)",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  const args = {
    agent_name: agent.name,
    goal: task,
    context,
  };

  return [
    "请把下面任务委派给指定 Agent 执行,不要由主 Agent 直接完成。",
    "必须调用工具: delegate_task",
    "",
    "建议调用参数:",
    JSON.stringify(args, null, 2),
  ].join("\n");
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

function createMarkdownPromptCommand(command: MarkdownPromptCommand): SlashCommand {
  return {
    name: command.name,
    description: command.description || `Run ${command.name}`,
    usage: command.argumentHint ? `/${command.name} ${command.argumentHint}` : `/${command.name}`,
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    kind: "prompt",
    source: command.source,
    category: command.source === "skill" ? "skill" : "workspace",
    execute: (input): PromptCommandResult => {
      const baseMetadata = {
        source: command.source,
        sourcePath: command.sourcePath,
        allowedTools: command.allowedTools,
        model: command.model,
      };
      if (command.source === "skill") {
        const activation = renderSkillActivation({
          name: command.name,
          args: input.args,
          body: command.prompt,
          sourcePath: command.sourcePath,
          trigger: "user-slash",
        });
        return {
          type: "prompt",
          prompt: activation.prompt,
          metadata: { ...baseMetadata, ...activation.metadata },
        };
      }
      return {
        type: "prompt",
        prompt: renderMarkdownCommandPrompt(command, input.args),
        metadata: baseMetadata,
      };
    },
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
          keybindings: {},
        },
        null,
        2,
      )}\n`,
    );
    messages.push("Created .pico/config.json");
  }

  return messages.join("\n");
}

async function formatDoctorReport(options: PicoCommandRegistryOptions): Promise<string> {
  const envPath = join(options.workDir, ".env");
  const apiKeys = loadApiKeys();
  const nodeMajor = Number(process.versions.node.split(".")[0] ?? "0");
  const nodeOk = nodeMajor >= 22;
  const cwdOk = existsSync(options.workDir);
  const envModel = process.env.LLM_MODEL;
  const catalogHealth =
    process.env.PICO_SESSION_CATALOG === "0"
      ? (options.session?.sessionCatalogHealth ??
        (await readSessionCatalogProjectionHealth(options.workDir)))
      : (await getDefaultSessionCatalogProjector().syncWorkspace(options.workDir)).health;

  return [
    `CWD: ${options.workDir} (${cwdOk ? "ok" : "missing"})`,
    `.env: ${existsSync(envPath) ? "found" : "missing"}`,
    `Provider: ${options.provider}`,
    `Model: ${options.model}${envModel && envModel !== options.model ? ` (env: ${envModel})` : ""}`,
    `LLM_BASE_URL: ${process.env.LLM_BASE_URL ? "set" : "missing"}`,
    `LLM_API_KEY[S]: ${apiKeys.length > 0 ? `${apiKeys.length} configured` : "missing"}`,
    `Node: ${process.version} (${nodeOk ? "ok" : "requires >=22.0.0"})`,
    `Session catalog: ${catalogHealth.state}`,
    ...(catalogHealth.diagnostic ? [`Session catalog reason: ${catalogHealth.diagnostic}`] : []),
    ...(catalogHealth.state !== "healthy"
      ? [`Session catalog recommendation: ${catalogHealth.recommendation}`]
      : []),
    ...formatMemoryBackend(options.session, true),
  ].join("\n");
}

function formatMemoryBackend(
  session: Session | undefined,
  includeRecommendation: boolean,
): string[] {
  if (!session) return ["Memory: unavailable (no live session)"];
  const status = session.memoryStatus;
  return [
    `Memory: ${status.backend} (${status.state}; source=${status.persistentSource})`,
    `Memory runtime: ${status.nodeVersion}; ABI ${status.nodeModuleAbi ?? "unknown"}`,
    ...(status.reason ? [`Memory reason: ${status.reason}`] : []),
    ...(includeRecommendation && status.recommendation
      ? [`Memory recommendation: ${status.recommendation}`]
      : []),
  ];
}
