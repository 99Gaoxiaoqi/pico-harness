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
  formatRewindUsage,
  latestSnapshotMessageId,
} from "../tui/rewind-selector.js";
import { listCliSessionSummaries } from "../cli/session-resolver.js";
import { createPermissionState } from "../approval/permission-state.js";
import { formatPermissionPanel } from "../tui/approval-panel.js";
import { createBuiltinCommands } from "./builtin-commands.js";
import { CommandRegistry } from "./command-registry.js";
import {
  loadMarkdownCommands,
  renderMarkdownCommandPrompt,
  type MarkdownPromptCommand,
} from "./markdown-command-loader.js";
import { renderSkillCommand, renderSkillListCommand } from "./skill-commands.js";
import {
  loadClaudeAgents,
  summarizeClaudeAgents,
  type ClaudeAgent,
  type ClaudeAgentSummary,
  type ClaudeAgentSource,
} from "./agent-loader.js";
import type {
  LocalCommandResult,
  PromptCommandResult,
  SlashArgumentCandidate,
  SlashCommand,
} from "./types.js";
import { createProvider, type ProviderKind } from "../provider/factory.js";
import { loadApiKeys } from "../provider/config.js";
import { buildDefaultToolRegistry } from "../tools/default-registry.js";
import {
  formatSessionStatus,
  getOrCreateSessionSettings,
  parseThinkingEffortArg,
  setSessionMode,
  setSessionModel,
  setSessionPermissionMode,
  setSessionThinkingEffort,
  toolStatusFromRegistry,
  type SessionMode,
  type SessionSettings,
  type SessionToolStatus,
} from "./session-settings.js";
import type { ThinkingEffort } from "../provider/thinking.js";
import type { McpStatusSnapshot } from "../mcp/manager.js";
import { getTier } from "../tools/tool-tiers.js";
import {
  formatToolDisclosureItem,
  ToolDisclosure,
  type ToolDisclosureItem,
} from "../tools/tool-disclosure.js";
import { findMatchingTools } from "../tools/search-tools.js";
import type { ToolDefinition } from "../schema/message.js";

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
  "tools",
  "mcp",
  "thinking",
  "agents",
]);

export type McpStatusProvider = () => McpStatusSnapshot | undefined;

export interface PicoCommandRegistryOptions {
  workDir: string;
  model: string;
  provider: ProviderKind;
  session?: Session;
  sessionId?: string;
  sessionMode?: SessionMode;
  forkFrom?: string;
  thinkingEffort?: ThinkingEffort;
  permissionMode?: string;
  tools?: readonly SessionToolStatus[];
  toolDisclosure?: ToolDisclosure;
  mcpStatus?: McpStatusProvider;
}

export async function createPicoCommandRegistry(
  options: PicoCommandRegistryOptions,
): Promise<CommandRegistry> {
  const skillLoader = new SkillLoader(options.workDir);
  const [skillCandidates, agentCandidates, sessionCandidates, snapshotCandidates] =
    await Promise.all([
      loadSkillArgumentCandidates(skillLoader),
      loadAgentArgumentCandidates(options.workDir),
      loadSessionArgumentCandidates(options.workDir),
      loadSnapshotArgumentCandidates(options),
    ]);
  const tools = options.tools ?? toolStatusFromRegistry(buildDefaultToolRegistry(options.workDir));
  const settings = getOrCreateSessionSettings({
    sessionId: options.sessionId ?? `cwd:${options.workDir}`,
    ...(options.sessionMode !== undefined ? { sessionMode: options.sessionMode } : {}),
    ...(options.forkFrom !== undefined ? { forkFrom: options.forkFrom } : {}),
    cwd: options.workDir,
    provider: options.provider,
    model: options.model,
    ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
    ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
    tools,
  });
  const builtins = createBuiltinCommands().filter(
    (command) => !OVERRIDDEN_BUILTIN_COMMANDS.has(command.name),
  );
  const registry = new CommandRegistry([
    ...builtins,
    createStatusCommand(settings, options.mcpStatus),
    createModeCommand(settings),
    createPermissionsCommand(settings),
    createCompactCommand(options),
    createInitCommand(options),
    createDoctorCommand(options),
    createModelCommand(settings),
    createThinkingCommand(settings),
    createToolsCommand(settings, options.toolDisclosure),
    createMcpCommand(options.mcpStatus),
    createAgentsCommand(options),
    createSessionsCommand(options),
    createResumeCommand(sessionCandidates),
    createSnapshotsCommand(options),
    createRewindCommand(options, snapshotCandidates),
    createUndoCommand(options),
    createImageCommand(),
    createAgentCommand(options, agentCandidates),
    createSkillsCommand(skillLoader),
    createSkillCommand(skillLoader, skillCandidates),
  ]);

  const markdownCommands = await loadMarkdownCommands({
    workDir: options.workDir,
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
): Array<{
  value: string;
  description?: string;
  argumentHint?: string;
  source?: string;
  kind?: string;
  category?: string;
  usage?: string;
  matchedAlias?: string;
}> {
  return registry
    .detailedSuggestions(query)
    .slice(0, 20)
    .map((command) => ({
      value: command.insertText,
      description: command.description,
      source: command.source,
      kind: command.kind,
      ...(command.category === undefined ? {} : { category: command.category }),
      ...(command.usage === undefined ? {} : { usage: command.usage }),
      ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
      ...(command.matchedAlias === undefined ? {} : { matchedAlias: command.matchedAlias }),
    }));
}

export function commandArgumentSuggestions(
  registry: CommandRegistry,
  commandName: string,
  query: string,
): readonly SlashArgumentCandidate[] {
  const command = registry.resolve(commandName);
  const result = command?.argumentCompleter?.(query) ?? [];
  if (isPromiseLike(result)) return [];
  return [...result];
}

export const MODEL_ARGUMENT_CANDIDATES: readonly SlashArgumentCandidate[] = [
  { value: "glm-5.2", description: "OpenAI-compatible default model" },
  { value: "kimi-k2.5", description: "OpenAI-compatible fallback model" },
  { value: "claude-3-5-sonnet", description: "Claude default model" },
  { value: "gemini-2.0-flash", description: "Gemini default model" },
];

const MODE_CANDIDATES: readonly SlashArgumentCandidate[] = [
  { value: "default", description: "Normal interactive mode" },
  { value: "plan", description: "Plan before acting" },
  { value: "auto", description: "Autonomous mode" },
  { value: "yolo", description: "YOLO mode" },
];

const PERMISSION_CANDIDATES: readonly SlashArgumentCandidate[] = [
  { value: "ask", description: "Ask before actions that need approval" },
  { value: "default", description: "Use the default permission policy" },
  { value: "auto", description: "Auto-approve supported actions" },
  { value: "yolo", description: "Auto-approve the session" },
  { value: "plan", description: "Use plan-oriented permissions" },
];

const THINKING_CANDIDATES: readonly SlashArgumentCandidate[] = [
  { value: "off", description: "Disable native thinking effort" },
  { value: "low", description: "Use low thinking effort" },
  { value: "medium", description: "Use medium thinking effort" },
  { value: "high", description: "Use high thinking effort" },
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

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(
    typeof value === "object" &&
      value !== null &&
      "then" in value &&
      typeof (value as { then?: unknown }).then === "function",
  );
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
): Promise<readonly SlashArgumentCandidate[]> {
  const sessions = await listCliSessionSummaries(workDir);
  return sessions.map((session) => ({
    value: session.id,
    description: `${session.messageCount} messages · ${session.updatedAt.toISOString()}`,
  }));
}

async function loadSnapshotArgumentCandidates(
  options: PicoCommandRegistryOptions,
): Promise<readonly SlashArgumentCandidate[]> {
  if (!options.session) return [];
  return listFileHistorySnapshotSummaries(options.session).map((snapshot) => ({
    value: snapshot.messageId,
    description: `${snapshot.trackedFileCount} files · ${snapshot.timestamp}`,
  }));
}

function createStatusCommand(
  settings: SessionSettings,
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
      message: formatStatusWithMcp(settings, mcpStatus),
    }),
  };
}

function formatStatusWithMcp(
  settings: SessionSettings,
  mcpStatus: McpStatusProvider | undefined,
): string {
  const base = formatSessionStatus(settings);
  const snapshot = mcpStatus?.();
  if (snapshot === undefined) return base;
  return `${base}\n${formatMcpOverview(snapshot)}`;
}

function createCompactCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "compact",
    description: "Compact current session context",
    usage: "/compact",
    category: "session",
    kind: "local",
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
    aliases: ["models"],
    description: "Show or change the active model",
    usage: "/model [name]",
    argumentHint: "[name]",
    category: "model",
    argumentCompleter: completeFromCandidates(MODEL_ARGUMENT_CANDIDATES),
    kind: "local",
    execute: (input): LocalCommandResult => {
      const result = setSessionModel(settings, input.args);
      return {
        type: "local",
        action: "model",
        message: result.message,
        data: { model: settings.model },
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
    usage: "/permissions [ask|default|auto|yolo|plan]",
    argumentHint: "[ask|default|auto|yolo|plan]",
    category: "permissions",
    argumentCompleter: completeFromCandidates(PERMISSION_CANDIDATES),
    kind: "local",
    execute: (input): LocalCommandResult => {
      if (input.args.trim().length === 0) {
        return {
          type: "local",
          action: "message",
          message: [
            formatPermissionPanel(createPermissionState({ mode: settings.permissionMode })),
            "Usage: /permissions <ask|default|auto|yolo|plan>",
          ].join("\n"),
          data: { permissionMode: settings.permissionMode },
        };
      }

      const result = setSessionPermissionMode(settings, input.args);
      return {
        type: "local",
        action: "message",
        message: `${result.message}\nSession approvals: unavailable`,
        data: { ok: result.ok, permissionMode: settings.permissionMode },
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
    argumentHint: "<off|low|medium|high>",
    category: "model",
    argumentCompleter: completeFromCandidates(THINKING_CANDIDATES),
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

function createToolsCommand(settings: SessionSettings, disclosure?: ToolDisclosure): SlashCommand {
  return {
    name: "tools",
    aliases: ["tool"],
    description: "List or search available tools",
    usage: "/tools [query]",
    argumentHint: "[query]",
    category: "tools",
    kind: "local",
    execute: (input): LocalCommandResult => {
      const query = input.args.trim();
      return {
        type: "local",
        action: "tools",
        message: query
          ? formatToolSearchResults(settings.tools, query, disclosure)
          : formatToolsByDisclosure(settings.tools, disclosure),
      };
    },
  };
}

function createMcpCommand(mcpStatus?: McpStatusProvider): SlashCommand {
  return {
    name: "mcp",
    description: "Show MCP server connection status",
    usage: "/mcp",
    category: "mcp",
    kind: "local",
    execute: (): LocalCommandResult => ({
      type: "local",
      action: "mcp",
      message: formatMcpStatus(mcpStatus?.()),
    }),
  };
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
  const suffix = toolNames.length > visible.length ? `, +${toolNames.length - visible.length} more` : "";
  return `: ${visible.join(", ")}${suffix}`;
}

function createAgentsCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "agents",
    description: "List available subagents",
    usage: "/agents",
    kind: "local",
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

function formatToolsByDisclosure(
  tools: readonly SessionToolStatus[],
  disclosure?: ToolDisclosure,
): string {
  if (tools.length === 0) {
    return "No tools are available.\nUse /tools <query> to search after tools are loaded.";
  }

  const grouped = groupToolsByDisclosure(tools, disclosure);
  const lines = [
    "Core tools",
    renderToolGroup(grouped.core),
    "",
    "Disclosed tools",
    renderToolGroup(grouped.disclosed),
    "",
    "Searchable tools",
    grouped.searchable.length > 0
      ? renderToolGroup(grouped.searchable)
      : "No searchable tools are loaded.",
    "",
    "Use /tools <query> to search searchable tools.",
  ];
  return lines.join("\n");
}

function formatToolSearchResults(
  tools: readonly SessionToolStatus[],
  query: string,
  disclosure?: ToolDisclosure,
): string {
  const grouped = groupToolsByDisclosure(tools, disclosure);
  const definitions = grouped.searchable.map(toolStatusToDefinition);
  const hits = findMatchingTools(definitions, query);
  if (hits.length === 0) {
    return `No matching searchable tools for "${query}".\nUse /tools to list core, disclosed, and searchable tools.`;
  }

  const statusByName = new Map(grouped.searchable.map((tool) => [tool.name, tool]));
  const hitStatuses = hits
    .map((tool) => statusByName.get(tool.name))
    .filter((tool): tool is SessionToolStatus => tool !== undefined);
  return [`Search results for "${query}"`, renderToolGroup(hitStatuses)].join("\n");
}

function groupToolsByDisclosure(
  tools: readonly SessionToolStatus[],
  disclosure?: ToolDisclosure,
): {
  core: SessionToolStatus[];
  disclosed: SessionToolStatus[];
  searchable: SessionToolStatus[];
} {
  const disclosedNames = new Set(disclosure?.getDisclosed() ?? []);
  const core: SessionToolStatus[] = [];
  const disclosed: SessionToolStatus[] = [];
  const searchable: SessionToolStatus[] = [];

  for (const tool of tools) {
    if (tool.name === "search_tools") continue;
    if (getTier(tool.name) === "core") {
      core.push(tool);
    } else if (disclosedNames.has(tool.name)) {
      disclosed.push(tool);
    } else {
      searchable.push(tool);
    }
  }

  return {
    core: sortTools(core),
    disclosed: sortTools(disclosed),
    searchable: sortTools(searchable),
  };
}

function renderToolGroup(tools: readonly ToolDisclosureItem[]): string {
  if (tools.length === 0) return "(none)";
  return tools.map(formatToolDisclosureItem).join("\n");
}

function sortTools<T extends ToolDisclosureItem>(tools: readonly T[]): T[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

function toolStatusToDefinition(tool: SessionToolStatus): ToolDefinition {
  return {
    name: tool.name,
    description: "",
    inputSchema: { type: "object", properties: {} },
  };
}

function createImageCommand(): SlashCommand {
  return {
    name: "image",
    description: "Attach a local image to this prompt",
    usage: "/image <path>",
    argumentHint: "<path>",
    category: "workspace",
    kind: "prompt",
    execute: (input): PromptCommandResult | LocalCommandResult => {
      const imagePath = input.args.trim();
      if (imagePath.length === 0) {
        return {
          type: "local",
          action: "message",
          message: "Usage: /image <path>",
        };
      }
      return {
        type: "prompt",
        prompt: `请查看这张图片。 @image:${JSON.stringify(imagePath)}`,
      };
    },
  };
}

function createSessionsCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "sessions",
    aliases: ["session-list"],
    description: "List resumable sessions for this project",
    usage: "/sessions",
    category: "session",
    kind: "local",
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

function createResumeCommand(sessionCandidates: readonly SlashArgumentCandidate[]): SlashCommand {
  return {
    name: "resume",
    description: "Show how to resume a saved session",
    usage: "/resume <session-id>",
    argumentHint: "<session-id>",
    category: "session",
    argumentCompleter: completeFromCandidates(sessionCandidates),
    kind: "local",
    execute: (input): LocalCommandResult => {
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

      return {
        type: "local",
        action: "message",
        message: [
          `准备恢复 session: ${sessionId}`,
          `请重启入口并传入启动参数: --session ${sessionId}`,
          "也可以使用 --continue 继续当前项目最近会话。",
          "当前会话不会热切换 running engine。",
        ].join("\n"),
        data: { sessionId },
      };
    },
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

function createRewindCommand(
  options: PicoCommandRegistryOptions,
  snapshotCandidates: readonly SlashArgumentCandidate[],
): SlashCommand {
  return {
    name: "rewind",
    aliases: ["checkpoint"],
    description: "Rewind code, conversation, or both to a file-history snapshot",
    usage: "/rewind [message-id] [code|conversation|both]",
    argumentHint: "[message-id] [code|conversation|both]",
    category: "session",
    argumentCompleter: completeFromCandidates(snapshotCandidates),
    kind: "local",
    execute: async (input): Promise<LocalCommandResult> => {
      const session = await resolveCommandSession(options);
      const messageId = input.argv[0];
      const summaries = listFileHistorySnapshotSummaries(session);
      if (messageId === undefined) {
        return {
          type: "local",
          action: "message",
          message: formatRewindUsage(session.id, summaries),
          ui: { kind: "open-selector", selector: "rewind" },
        };
      }

      const message = await tryRewindCommand(session, messageId, input.argv[1]);
      return {
        type: "local",
        action: "message",
        message,
      };
    },
  };
}

function createUndoCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "undo",
    description: "Undo the latest file-history snapshot",
    usage: "/undo [message-id] [code|conversation|both]",
    argumentHint: "[message-id] [code|conversation|both]",
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
      const result = await session.serialize(() =>
        rewindFileHistoryFromCli(session, messageId, mode),
      );
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

async function tryRewindCommand(
  session: Session,
  messageId: string,
  modeInput: string | undefined,
): Promise<string> {
  try {
    const result = await session.serialize(async () => {
      const mode = parseRewindMode(modeInput);
      return rewindFileHistoryFromCli(session, messageId, mode);
    });
    return result.output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith(`找不到 messageId=${messageId}`)) {
      return `找不到 messageId=${messageId} 的文件历史快照。请运行 /snapshots 查看可用快照，或使用 /rewind <messageId> code|conversation|both。`;
    }
    return `${message}\n用法: /rewind <messageId> code|conversation|both`;
  }
}

function createSkillsCommand(loader: SkillLoader): SlashCommand {
  return {
    name: "skills",
    aliases: ["skill-list"],
    description: "List available skills",
    usage: "/skills",
    category: "skill",
    kind: "local",
    execute: async (): Promise<LocalCommandResult> => ({
      type: "local",
      action: "skills",
      message: await renderSkillListCommand(loader),
    }),
  };
}

function createSkillCommand(
  loader: SkillLoader,
  skillCandidates: readonly SlashArgumentCandidate[],
): SlashCommand {
  return {
    name: "skill",
    aliases: ["use-skill"],
    description: "Show a skill body by name",
    usage: "/skill <name>",
    argumentHint: "<name>",
    category: "skill",
    argumentCompleter: completeFromCandidates(skillCandidates),
    kind: "local",
    execute: async (input): Promise<LocalCommandResult> => ({
      type: "local",
      action: "message",
      message: input.args ? await renderSkillCommand(loader, input.args) : "Usage: /skill <name>",
    }),
  };
}

function createAgentCommand(
  options: PicoCommandRegistryOptions,
  agentCandidates: readonly SlashArgumentCandidate[],
): SlashCommand {
  return {
    name: "agent",
    description: "Dispatch a task to a named subagent",
    usage: "/agent <name> <task>",
    argumentHint: "<name> <task>",
    category: "agent",
    argumentCompleter: completeFromCandidates(agentCandidates),
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
