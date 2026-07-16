import { createHash, randomUUID } from "node:crypto";
import { SkillLoader } from "../context/skill.js";
import { FullCompactor } from "../context/full-compactor.js";
import { createContextBudget, estimateMessagesTokens } from "../context/context-budget.js";
import { globalSessionManager, type Session } from "../engine/session.js";
import { SessionForkService } from "../engine/session-fork-service.js";
import { defaultCliSessionId, listFileHistorySnapshotSummaries } from "../cli/file-history.js";
import { formatRewindSelector, formatRewindUsage } from "./rewind-presentation.js";
import { formatSessionCandidateDetails, sessionDisplayTitle } from "./session-presentation.js";
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
import { renderAgentDispatchPrompt } from "./agent-activation.js";
import {
  findAgentProfile,
  loadAgentCatalog,
  summarizeAgentProfiles,
  type AgentCatalogSource,
  type AgentProfileSummary,
  type CatalogAgentProfile,
  type AgentExternalCatalogSource,
} from "../agents/catalog.js";
import type { ExternalResourceCatalogSource } from "../catalog/resource-catalog.js";
import type {
  CommandListOptions,
  LocalCommandResult,
  PromptCommandResult,
  SlashArgumentCandidate,
  SlashCommand,
} from "./types.js";
import { createProvider, type ProviderKind } from "../provider/factory.js";
import { resolveProviderProfile } from "../provider/profile.js";
import { type ModelProviderConfig, type ModelRouter } from "../provider/model-router.js";
import type { EffectiveProviderCredentialStatus } from "../provider/effective-model-runtime.js";
import {
  credentialRefForProvider,
  normalizeProviderEndpoint,
  type CredentialVault,
} from "../provider/credential-vault.js";
import {
  resolveAutomationCredentialTarget,
  type AutomationCredentialTarget,
} from "../provider/automation-credential.js";
import { loadApiKeys } from "../provider/config.js";
import { initializeProjectEntrypoints } from "./project-initializer.js";
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
import { CronService } from "../tasks/cron-service.js";
import type { CronDaemonBridge } from "./cron-daemon-bridge.js";
import { filterBackgroundEligibleTools } from "../safety/background-yolo-policy.js";
import type { McpConnectionManager } from "../mcp/manager.js";
import { CostTracker } from "../observability/tracker.js";
import { ensureSessionUsageBaseline } from "../observability/usage-baseline.js";
import type { HookService } from "../hooks/service.js";
import {
  ResourceDoctor,
  renderResourceDoctorReport,
  type ResourceDoctorReport,
} from "../diagnostics/resource-doctor.js";
import { StorageDoctor } from "../storage/storage-doctor.js";
import type {
  StorageOperation,
  StorageOperationDispositionInput,
} from "../storage/operation-journal.js";
import type { ForkReconciliationResult } from "../storage/fork-operation-coordinator.js";
import { runWorkspaceDoctor } from "../diagnostics/workspace-doctor.js";
import type { EffectiveConfigSnapshot } from "./effective-config.js";
import { UserConfigStore } from "./user-config-store.js";
import {
  createPluginCommand,
  type PluginManagementCommandService,
} from "../plugins/plugin-commands.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { RuntimeEventStore } from "../runtime/runtime-event-store.js";
import { RuntimeRun } from "../runtime/runtime-run.js";

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
  "provider",
  "mcp",
  "thinking",
  "agents",
]);

export type McpStatusProvider = () => McpStatusSnapshot | undefined;

export interface OperationRecoveryCommandResult {
  readonly operation: StorageOperation;
  readonly reconciliation?: ForkReconciliationResult;
  readonly stagingCleanup?: "completed" | "failed";
  readonly cleanupDiagnostic?: string;
}

export interface OperationRecoveryCommandService {
  listNeedsAttention(): Promise<readonly StorageOperation[]>;
  getOperation(operationId: string): Promise<StorageOperation | undefined>;
  retryNeedsAttention(
    input: StorageOperationDispositionInput,
  ): Promise<OperationRecoveryCommandResult>;
  abortNeedsAttention(
    input: StorageOperationDispositionInput,
  ): Promise<OperationRecoveryCommandResult>;
}

export interface PicoCommandRegistryOptions {
  workDir: string;
  projectCommandsDir?: string;
  model: string;
  modelRouteId?: string;
  modelRouter?: ModelRouter;
  /** Re-resolves config and credentials at an idle command boundary. */
  modelRouterProvider?: () => ModelRouter | Promise<ModelRouter>;
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
  /** 可选的本机 Cron 账本；未注入时 /cron 明确说明不可用。 */
  cronService?: CronService;
  /** TUI 通过它把启用的 Cron 工作区交给本机 Runtime daemon。 */
  cronDaemonBridge?: CronDaemonBridge;
  /** TUI 专用系统凭证库；导入仅从进程环境读取，命令参数永不接收 secret。 */
  credentialVault?: CredentialVault;
  credentialEnv?: Readonly<Record<string, string | undefined>>;
  /** Effective startup snapshot used only for source/status diagnostics. */
  effectiveConfig?: EffectiveConfigSnapshot;
  providerCredentialStatuses?: Readonly<Record<string, EffectiveProviderCredentialStatus>>;
  /** Injectable durable user store for tests and alternate PICO_HOME hosts. */
  userConfigStore?: UserConfigStore;
  /** TaskHostRuntime 不可用时的宿主诊断；TUI 仍可在非 Git 目录运行。 */
  taskRuntimeDiagnostic?: string;
  /** 可注入的只读存储诊断器；默认扫描当前 workspace 和全局 File History。 */
  storageDoctor?: Pick<StorageDoctor, "scan">;
  /** needs_attention 人工处置入口；默认只允许 SessionForkService 可证明的 fork 恢复。 */
  operationRecovery?: OperationRecoveryCommandService;
  resourceDoctor?: { scan(): Promise<ResourceDoctorReport> };
  hookService?: HookService;
  hookCommands?: readonly SlashCommand[];
  mcpControl?: McpConnectionManager;
  /** Plugin 管理命令可注入测试/宿主单例；未注入时按 workDir 创建。 */
  pluginManagement?: PluginManagementCommandService;
  picoHome?: string;
  homeDir?: string;
  includeUserSkillResources?: boolean;
  includeClaudeProjectResources?: boolean;
  includeClaudeUserResources?: boolean;
  skillSources?: readonly ExternalResourceCatalogSource[];
  commandSources?: readonly ExternalResourceCatalogSource[];
  agentSources?: readonly AgentExternalCatalogSource[];
}

export async function createPicoCommandRegistry(
  options: PicoCommandRegistryOptions,
): Promise<CommandRegistry> {
  const skillLoader = new SkillLoader(options.workDir, {
    ...(options.picoHome ? { picoHome: options.picoHome } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.includeUserSkillResources !== undefined
      ? { includeUserResources: options.includeUserSkillResources }
      : {}),
    ...(options.includeClaudeProjectResources !== undefined
      ? { includeClaudeProjectResources: options.includeClaudeProjectResources }
      : {}),
    ...(options.includeClaudeUserResources !== undefined
      ? { includeClaudeUserResources: options.includeClaudeUserResources }
      : {}),
    ...(options.skillSources ? { externalSources: options.skillSources } : {}),
  });
  const tools = options.tools ?? toolStatusFromRegistry(buildDefaultToolRegistry(options.workDir));
  const settings = getOrCreateSessionSettings(
    {
      sessionId: options.sessionId ?? `cwd:${options.workDir}`,
      ...(options.sessionMode !== undefined ? { sessionMode: options.sessionMode } : {}),
      ...(options.forkFrom !== undefined ? { forkFrom: options.forkFrom } : {}),
      cwd: options.workDir,
      ...(options.picoHome ? { picoHome: options.picoHome } : {}),
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
    createStatusCommand(settings, options.mcpStatus),
    createModelRuntimeCommand("usage", options.modelRuntime),
    createModelRuntimeCommand("context", options.modelRuntime),
    createGoalCommand(options.goalManager),
    createModeCommand(settings),
    createPermissionsCommand(settings),
    createCompactCommand(options, settings),
    createInitCommand(options),
    ...(options.hookCommands ?? []),
    createDoctorCommand(options),
    createOperationsCommand(options),
    createProviderCommand(options),
    createModelCommand(settings, options.modelRouter, options.modelRouterProvider),
    createAddDirectoryCommand(settings, options.additionalDirectoryManager),
    createThinkingCommand(settings, options.modelRouter, options.modelRouterProvider),
    createMcpCommand(options.mcpStatus, options.mcpControl),
    createPluginCommand({
      workDir: options.workDir,
      ...(options.pluginManagement ? { service: options.pluginManagement } : {}),
    }),
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
    createCronCommand(options, settings),
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
    ...(options.picoHome ? { picoHome: options.picoHome } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.includeClaudeProjectResources !== undefined
      ? { includeClaudeProjectResources: options.includeClaudeProjectResources }
      : {}),
    ...(options.includeClaudeUserResources !== undefined
      ? { includeClaudeUserResources: options.includeClaudeUserResources }
      : {}),
    ...(options.commandSources ? { externalSources: options.commandSources } : {}),
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
  options: PicoCommandRegistryOptions,
): Promise<readonly SlashArgumentCandidate[]> {
  const agents = await loadRegistryAgents(options);
  return summarizeAgentProfiles(agents).map((agent) => ({
    value: agent.name,
    description: agent.description,
  }));
}

async function loadRegistryAgents(
  options: PicoCommandRegistryOptions,
): Promise<CatalogAgentProfile[]> {
  return await loadAgentCatalog({
    workDir: options.workDir,
    includeBuiltins: true,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.picoHome ? { picoHome: options.picoHome } : {}),
    ...(options.includeClaudeProjectResources !== undefined
      ? { includeClaudeProjectResources: options.includeClaudeProjectResources }
      : {}),
    ...(options.includeClaudeUserResources !== undefined
      ? { includeClaudeUserResources: options.includeClaudeUserResources }
      : {}),
    ...(options.agentSources ? { externalSources: options.agentSources } : {}),
  });
}

async function loadSessionArgumentCandidates(
  workDir: string,
  currentSessionId?: string,
  picoHome?: string,
): Promise<readonly SlashArgumentCandidate[]> {
  const sessions = await listCliSessionSummaries(workDir, {
    ...(picoHome ? { picoHome } : {}),
  });
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
  mcpStatus: McpStatusProvider | undefined,
): string {
  const base = formatSessionStatus(settings);
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
      const session = options.session;

      let activeProvider = options.provider;
      let activeConfig: { baseURL: string; apiKey: string; model: string } | undefined;
      const modelRouter = await resolveCommandModelRouter(
        options.modelRouter,
        options.modelRouterProvider,
      );
      if (modelRouter) {
        try {
          const resolved = modelRouter.providerConfig(
            settings.modelRouteId,
            effectiveSessionReasoningLevel(settings, modelRouter),
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
        const before = session.length;
        const model = activeConfig?.model ?? settings.model;
        const profile = resolveProviderProfile(
          activeProvider === "openai" ? "openai" : activeProvider,
          model,
        );
        const budget = createContextBudget(profile);
        const historyTokens = estimateMessagesTokens(session.getHistory());
        const rawProvider = createProvider(activeProvider, {
          baseURL,
          apiKey,
          model,
        });
        const jobs = options.taskRuntime?.jobService;
        if (jobs) ensureSessionUsageBaseline(jobs, session);
        const runtimeEventStore = session.runtimeEventStore;
        if (!runtimeEventStore) {
          return {
            type: "local",
            action: "message",
            message: "Compact unavailable: the current session has no durable RuntimeEvent store.",
          };
        }
        const provider = new CostTracker(
          rawProvider,
          { provider: activeProvider, model, baseUrl: baseURL },
          session,
          {
            ...(jobs ? { ledger: jobs } : {}),
            context: () => {
              const goalId = options.goalManager?.getActive()?.id;
              return {
                purpose: "main",
                sessionId: session.id,
                conversationId: session.conversationId,
                ...(goalId ? { goalId } : {}),
              };
            },
          },
        );
        const fullCompactor = new FullCompactor({
          provider,
          ...(options.hookService ? { hookService: options.hookService } : {}),
        });
        const request = {
          inputBudgetTokens: budget.inputBudgetTokens,
          targetRetainedTokens: Math.max(
            1,
            Math.min(Math.floor(budget.inputBudgetTokens * 0.5), Math.floor(historyTokens * 0.5)),
          ),
          trigger: "manual" as const,
        };
        const runtimeRun = await RuntimeRun.start({
          sessionId: session.id,
          workDir: session.workDir,
          store: runtimeEventStore,
          writeGuard: session,
        });
        const preview = await runtimeRun.run(async () => {
          const entries = await runtimeRun.readModelHistoryEntries();
          const runtimeHistoryTokens = estimateMessagesTokens(
            entries.map(({ message }) => message),
          );
          const runtimeRequest = {
            ...request,
            targetRetainedTokens: Math.max(
              1,
              Math.min(
                Math.floor(budget.inputBudgetTokens * 0.5),
                Math.floor(runtimeHistoryTokens * 0.5),
              ),
            ),
          };
          await options.hookService?.dispatch("PreCompact", {
            source: "manual",
            messageCount: entries.length,
          });
          const candidate = await fullCompactor.preview(
            session,
            entries.map(({ message }) => message),
            runtimeRequest,
          );
          if (!candidate) return undefined;
          const covered = entries.slice(0, candidate.compactedCount);
          const through = covered.at(-1);
          if (!through) return undefined;
          const checkpointId = `checkpoint:${randomUUID()}`;
          await runtimeRun.recordCheckpoint({
            checkpointId,
            coveredEventCount: covered.length,
            sourceDigest: createHash("sha256")
              .update(covered.map(({ eventId }) => eventId).join("\n"))
              .digest("hex"),
            throughEventId: through.eventId,
            summary: {
              role: "assistant",
              content: candidate.wrappedSummary,
              providerData: {
                picoKind: "runtime_checkpoint",
                picoCheckpointId: checkpointId,
              },
            },
          });
          await options.hookService?.dispatch("PostCompact", {
            source: "manual",
            messageCount: (await runtimeRun.readModelHistoryEntries()).length,
          });
          return candidate;
        });
        return {
          type: "local",
          action: "message",
          message: preview
            ? `Compact complete: recorded a RuntimeEvent checkpoint for ${preview.compactedCount} messages; session transcript remains ${before} messages.`
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
    execute: async (): Promise<LocalCommandResult> => {
      const result = await initializeProjectEntrypoints(options.workDir);
      await options.hookService?.dispatch("Setup", { action: "init" });
      return {
        type: "local",
        action: "message",
        message: result.message,
        data: result,
      };
    },
  };
}

function createDoctorCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "doctor",
    description: "Diagnose local Pico configuration",
    usage: "/doctor [resources]",
    argumentHint: "[resources]",
    kind: "local",
    availability: "idle",
    execute: async (input): Promise<LocalCommandResult> => {
      const subcommand = input.args.trim();
      if (!subcommand) {
        const report = await runWorkspaceDoctor({
          workDir: options.workDir,
          ...(options.picoHome ? { picoHome: options.picoHome } : {}),
          provider: options.provider,
          model: options.model,
          taskRuntimeAvailable: options.taskRuntime !== undefined,
          ...(options.taskRuntimeDiagnostic
            ? { taskRuntimeDiagnostic: options.taskRuntimeDiagnostic }
            : {}),
          ...(options.storageDoctor ? { storageDoctor: options.storageDoctor } : {}),
          ...(options.effectiveConfig
            ? {
                configuration: {
                  defaultModelRouteId: options.effectiveConfig.defaultModelRouteId,
                  defaultSource: options.effectiveConfig.sources["defaults.modelRouteId"],
                  providerSources: Object.fromEntries(
                    Object.keys(options.effectiveConfig.providers).map((id) => [
                      id,
                      options.effectiveConfig?.sources[`providers.${id}`] ?? "unknown",
                    ]),
                  ),
                  credentialStates: Object.fromEntries(
                    Object.entries(options.providerCredentialStatuses ?? {}).map(([id, status]) => [
                      id,
                      status.state,
                    ]),
                  ),
                },
              }
            : {}),
        });
        return { type: "local", action: "message", message: report.output, data: report };
      }
      if (subcommand !== "resources") {
        return { type: "local", action: "message", message: "Usage: /doctor [resources]" };
      }
      try {
        const report = await (
          options.resourceDoctor ??
          new ResourceDoctor({
            workDir: options.workDir,
            ...(options.picoHome ? { picoHome: options.picoHome } : {}),
          })
        ).scan();
        return {
          type: "local",
          action: "message",
          message: renderResourceDoctorReport(report).join("\n"),
          data: report,
        };
      } catch (error) {
        return {
          type: "local",
          action: "message",
          message: `Resource diagnostic unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

function createOperationsCommand(options: PicoCommandRegistryOptions): SlashCommand {
  let fallback: SessionForkService | undefined;
  const recovery = (): OperationRecoveryCommandService =>
    options.operationRecovery ??
    (fallback ??= new SessionForkService({
      workDir: options.workDir,
      ...(options.picoHome ? { picoHome: options.picoHome } : {}),
    }));
  const subcommands: readonly SlashArgumentCandidate[] = [
    { value: "list", description: "List operations requiring manual disposition" },
    { value: "show", description: "Show one operation and its recorded failure" },
    { value: "retry", description: "Retry from the recorded failed phase" },
    { value: "abort", description: "Abort and release the operation claim" },
  ];
  return {
    name: "operations",
    aliases: ["ops"],
    description: "Inspect and dispose storage operations needing attention",
    usage: operationsUsage(),
    argumentHint: "[list|show|retry|abort]",
    category: "system",
    kind: "local",
    availability: "idle",
    argumentCompleter: completeFromCandidates(subcommands),
    execute: async (input): Promise<LocalCommandResult> => {
      const action = input.argv[0] ?? "list";
      try {
        if (action === "list") {
          if (input.argv.length > 1) return operationsUsageResult();
          const operations = await recovery().listNeedsAttention();
          return {
            type: "local",
            action: "message",
            message: formatNeedsAttentionOperations(operations),
            data: operations,
          };
        }

        const operationId = input.argv[1];
        if (action === "show") {
          if (!operationId || input.argv.length !== 2) return operationsUsageResult();
          const operation = await recovery().getOperation(operationId);
          return {
            type: "local",
            action: "message",
            message: operation
              ? formatStorageOperation(operation)
              : `Storage operation not found: ${operationId}`,
            ...(operation ? { data: operation } : {}),
          };
        }

        if (action !== "retry" && action !== "abort") return operationsUsageResult();
        const expectedVersion = parseOperationVersion(input.argv[2]);
        if (!operationId || expectedVersion === undefined) return operationsUsageResult();
        const reason =
          input.argv.slice(3).join(" ").trim() || `requested via /operations ${action}`;
        const dispositionInput = { operationId, expectedVersion, reason };
        const result =
          action === "retry"
            ? await recovery().retryNeedsAttention(dispositionInput)
            : await recovery().abortNeedsAttention(dispositionInput);
        return {
          type: "local",
          action: "message",
          message: formatOperationDisposition(action, result),
          data: result,
        };
      } catch (error) {
        return {
          type: "local",
          action: "message",
          message: `Operation disposition failed closed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

function createProviderCommand(options: PicoCommandRegistryOptions): SlashCommand {
  const store = options.userConfigStore ?? new UserConfigStore({ picoHome: options.picoHome });
  const env = options.credentialEnv ?? process.env;
  return {
    name: "provider",
    description: "Manage shared user providers without exposing credentials in command arguments",
    usage:
      "/provider [list | import-env <id> [--confirm] | default <provider/model|clear> | delete <id>]",
    argumentHint: "[list | import-env | default | delete]",
    category: "model",
    kind: "local",
    availability: "idle",
    execute: async (input): Promise<LocalCommandResult> => {
      const [subcommand = "list", first, confirmation, ...rest] = input.argv;
      if (rest.length > 0) return providerUsage();
      try {
        if (subcommand === "list" && first === undefined && confirmation === undefined) {
          return await listUserProviders(store, options, env);
        }
        if (subcommand === "import-env") {
          if (!first || (confirmation !== undefined && confirmation !== "--confirm")) {
            return providerUsage();
          }
          return await importEnvironmentProvider({
            providerId: first,
            confirmed: confirmation === "--confirm",
            providerKind: options.provider,
            store,
            env,
            daemon: options.cronDaemonBridge,
          });
        }
        if (subcommand === "default" && first && confirmation === undefined) {
          if (first === "clear" || first === "none") {
            return await clearDefaultUserProvider(store);
          }
          return await setDefaultUserProvider(store, first);
        }
        if (subcommand === "delete" && first && confirmation === undefined) {
          return await deleteUserProvider(store, first, options.cronDaemonBridge);
        }
        return providerUsage();
      } catch (error) {
        return {
          type: "local",
          action: "message",
          message: `Provider command failed: ${safeProviderError(error)}`,
        };
      }
    },
  };
}

function operationsUsageResult(): LocalCommandResult {
  return { type: "local", action: "message", message: operationsUsage() };
}

function operationsUsage(): string {
  return [
    "Usage:",
    "  /operations list",
    "  /operations show <operation-id>",
    "  /operations retry <operation-id> <expected-version> [reason]",
    "  /operations abort <operation-id> <expected-version> [reason]",
  ].join("\n");
}

function parseOperationVersion(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) return undefined;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : undefined;
}

function formatNeedsAttentionOperations(operations: readonly StorageOperation[]): string {
  if (operations.length === 0) return "No storage operations need attention.";
  return [
    `Storage operations needing attention: ${operations.length}`,
    ...operations.map(
      (operation) =>
        `${operation.operationId} · ${operation.kind} · v${operation.version} · phase=${operation.error?.phase ?? "unknown"}\n  ${operation.error?.message ?? "No failure reason was recorded"}`,
    ),
    "Use /operations show <operation-id> before retry or abort.",
  ].join("\n");
}

function formatStorageOperation(operation: StorageOperation): string {
  const dispositions = operation.dispositions ?? [];
  return [
    `Operation: ${operation.operationId}`,
    `Kind: ${operation.kind}`,
    `State: ${operation.state}`,
    `Version: ${operation.version}`,
    `Failure phase: ${operation.error?.phase ?? "none"}`,
    `Failure reason: ${operation.error?.message ?? "none"}`,
    ...(operation.error?.conflictingPaths?.length
      ? [`Conflicting paths: ${operation.error.conflictingPaths.join(", ")}`]
      : []),
    `Disposition history: ${dispositions.length}`,
    ...dispositions.map(
      (entry) => `  ${entry.action} from v${entry.fromVersion} at ${entry.at}: ${entry.reason}`,
    ),
  ].join("\n");
}

function formatOperationDisposition(
  action: "retry" | "abort",
  result: OperationRecoveryCommandResult,
): string {
  const reconciliation = result.reconciliation;
  const leaseTimeout =
    reconciliation && "status" in reconciliation && reconciliation.status === "lease_timeout"
      ? reconciliation.diagnostic
      : undefined;
  return [
    `Operation ${action}: ${result.operation.operationId}`,
    `State: ${result.operation.state}`,
    `Version: ${result.operation.version}`,
    ...(leaseTimeout
      ? [
          `Recovery status: lease_timeout`,
          `Lease diagnostic: target=${leaseTimeout.targetSessionId}, attempts=${leaseTimeout.attempts}, waitedMs=${leaseTimeout.waitedMs}`,
        ]
      : []),
    ...(result.stagingCleanup ? [`Staging cleanup: ${result.stagingCleanup}`] : []),
    ...(result.cleanupDiagnostic ? [`Cleanup diagnostic: ${result.cleanupDiagnostic}`] : []),
  ].join("\n");
}

async function listUserProviders(
  store: UserConfigStore,
  options: PicoCommandRegistryOptions,
  env: Readonly<Record<string, string | undefined>>,
): Promise<LocalCommandResult> {
  const snapshot = await store.read();
  const effective = options.effectiveConfig;
  const providers = Object.fromEntries(
    Object.entries(effective?.providers ?? {}).filter(
      ([id]) => effective?.sources[`providers.${id}`] !== "user",
    ),
  );
  Object.assign(providers, snapshot.config.providers);
  const entries = Object.entries(providers);
  if (entries.length === 0) {
    return {
      type: "local",
      action: "message",
      message:
        "No providers configured. Set complete LLM_* variables, then run /provider import-env <id> to preview an import.",
    };
  }
  const lines = await Promise.all(
    entries.map(async ([id, provider]) => {
      const source = snapshot.config.providers[id]
        ? "user"
        : (effective?.sources[`providers.${id}`] ?? "unknown");
      const state = await providerCredentialState(id, provider, source, options, env);
      const effectiveDefault =
        effective?.sources["defaults.modelRouteId"] === "user"
          ? undefined
          : effective?.defaultModelRouteId;
      const defaultMarker =
        (snapshot.config.defaults?.modelRouteId ?? effectiveDefault)?.startsWith(`${id}/`) === true
          ? " · default"
          : "";
      return `${id} · ${provider.protocol} · ${source} · credential=${state}${defaultMarker}\n  ${provider.baseURL}\n  models: ${provider.models.join(", ") || "discovery"}`;
    }),
  );
  return { type: "local", action: "message", message: lines.join("\n") };
}

async function providerCredentialState(
  id: string,
  provider: ModelProviderConfig,
  source: string,
  options: PicoCommandRegistryOptions,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  if (firstCredential(env[provider.apiKeyEnv])) return "environment";
  if (source === "user" && options.credentialVault) {
    if (!options.credentialVault.capability().available) return "unsupported";
    const ref = credentialRefForProvider({
      providerId: id,
      protocol: provider.protocol,
      baseURL: provider.baseURL,
    });
    return (await options.credentialVault.has(ref)) ? "keychain" : "missing";
  }
  return options.providerCredentialStatuses?.[id]?.state ?? "missing";
}

async function importEnvironmentProvider(input: {
  providerId: string;
  confirmed: boolean;
  providerKind: ProviderKind;
  store: UserConfigStore;
  env: Readonly<Record<string, string | undefined>>;
  daemon?: CronDaemonBridge;
}): Promise<LocalCommandResult> {
  if (!/^[^/\s]+$/u.test(input.providerId)) {
    return providerMessage("Provider ID cannot contain whitespace or a slash.");
  }
  const baseURL = input.env["LLM_BASE_URL"]?.trim();
  const defaultModel = input.env["LLM_MODEL"]?.trim();
  const apiKeyEnv = firstCredential(input.env["LLM_API_KEYS"]) ? "LLM_API_KEYS" : "LLM_API_KEY";
  const secret = firstCredential(input.env[apiKeyEnv]);
  if (!baseURL || !defaultModel || !secret) {
    return providerMessage(
      "Import unavailable: LLM_BASE_URL, LLM_MODEL and LLM_API_KEY[S] must all be set in this process.",
    );
  }
  const models = uniqueProviderModels([
    defaultModel,
    ...splitProviderModels(input.env["LLM_MODELS"]),
  ]);
  const provider: ModelProviderConfig = {
    protocol: input.providerKind,
    baseURL: normalizeProviderEndpoint(baseURL),
    apiKeyEnv,
    models,
    discoverModels: input.providerKind === "openai",
  };
  if (!input.confirmed) {
    return providerMessage(
      [
        `Import preview for ${input.providerId}:`,
        `protocol: ${provider.protocol}`,
        `endpoint: ${provider.baseURL}`,
        `models: ${provider.models.join(", ")}`,
        "credential: current process environment -> OS credential vault (value hidden)",
        `Confirm with: /provider import-env ${input.providerId} --confirm`,
      ].join("\n"),
    );
  }
  const snapshot = await input.store.read();
  const existing = snapshot.config.providers[input.providerId];
  if (existing && !sameProviderAuthority(existing, provider)) {
    return providerMessage(
      `Provider ${input.providerId} already uses a different protocol or endpoint; delete it explicitly before importing.`,
    );
  }
  if (!input.daemon?.importEnvironmentProvider) {
    return providerMessage(
      "Local Runtime daemon is unavailable; Provider import is fail-closed so config and OS credentials cannot diverge.",
    );
  }
  const result = await input.daemon.importEnvironmentProvider({
    provider: {
      id: input.providerId,
      protocol: provider.protocol,
      baseURL: provider.baseURL,
      apiKeyEnv: provider.apiKeyEnv,
      models: provider.models,
      discoverModels: provider.discoverModels,
    },
    defaultModel,
    secret,
    expectedRevision: snapshot.revision,
  });
  return providerMessage(
    result.status === "imported"
      ? `${result.message} 更新会在下一个 Session 或 Run 安全边界生效；运行中请求不会热切换。`
      : result.message,
  );
}

async function setDefaultUserProvider(
  store: UserConfigStore,
  routeId: string,
): Promise<LocalCommandResult> {
  const separator = routeId.indexOf("/");
  if (separator <= 0 || separator === routeId.length - 1) return providerUsage();
  const providerId = routeId.slice(0, separator);
  const model = routeId.slice(separator + 1);
  const snapshot = await store.read();
  const provider = snapshot.config.providers[providerId];
  if (!provider || !provider.models.includes(model)) {
    return providerMessage(
      `Cannot set default ${routeId}: it is not an explicit model in the shared user provider registry.`,
    );
  }
  await store.write(
    {
      ...snapshot.config,
      defaults: { ...snapshot.config.defaults, modelRouteId: routeId },
    },
    { expectedRevision: snapshot.revision },
  );
  return providerMessage(
    `Shared default model set to ${routeId}. New sessions apply it at their next safe boundary; the current Session keeps its explicit model.`,
  );
}

async function clearDefaultUserProvider(store: UserConfigStore): Promise<LocalCommandResult> {
  const snapshot = await store.read();
  if (!snapshot.config.defaults?.modelRouteId) {
    return providerMessage("Shared default model is already clear.");
  }
  await store.write(
    {
      ...snapshot.config,
      defaults: { ...snapshot.config.defaults, modelRouteId: undefined },
    },
    { expectedRevision: snapshot.revision },
  );
  return providerMessage("Shared default model cleared. You can now delete its Provider.");
}

async function deleteUserProvider(
  store: UserConfigStore,
  providerId: string,
  daemon: CronDaemonBridge | undefined,
): Promise<LocalCommandResult> {
  if (!/^[^/\s]+$/u.test(providerId)) return providerUsage();
  const snapshot = await store.read();
  const provider = snapshot.config.providers[providerId];
  if (!provider) return providerMessage(`Shared user provider ${providerId} does not exist.`);
  if (!daemon) {
    return providerMessage(
      "Local Runtime daemon is unavailable; Provider deletion is fail-closed so config and OS credentials cannot diverge.",
    );
  }
  const result = await daemon.deleteProvider({
    providerId,
    expectedRevision: snapshot.revision,
  });
  return providerMessage(result.message);
}

function providerUsage(): LocalCommandResult {
  return providerMessage(
    "Usage: /provider [list | import-env <id> [--confirm] | default <provider/model|clear> | delete <id>]",
  );
}

function providerMessage(message: string): LocalCommandResult {
  return { type: "local", action: "message", message };
}

function safeProviderError(error: unknown): string {
  if (
    error instanceof Error &&
    (error.name === "UserConfigRevisionConflictError" ||
      error.name === "UserConfigLockTimeoutError")
  ) {
    return error.message;
  }
  return error instanceof Error
    ? error.message.replace(/(api[_-]?key|token|secret)\s*[=:]\s*\S+/giu, "$1=<redacted>")
    : "unknown error";
}

function sameProviderAuthority(left: ModelProviderConfig, right: ModelProviderConfig): boolean {
  return (
    left.protocol === right.protocol &&
    normalizeProviderEndpoint(left.baseURL) === normalizeProviderEndpoint(right.baseURL)
  );
}

function firstCredential(value: string | undefined): string | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .find(Boolean);
}

function splitProviderModels(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueProviderModels(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

async function resolveCommandModelRouter(
  fallback: ModelRouter | undefined,
  provider: (() => ModelRouter | Promise<ModelRouter>) | undefined,
): Promise<ModelRouter | undefined> {
  return provider ? await provider() : fallback;
}

function createModelCommand(
  settings: SessionSettings,
  fallbackRouter?: ModelRouter,
  routerProvider?: () => ModelRouter | Promise<ModelRouter>,
): SlashCommand {
  const candidates = (): readonly SlashArgumentCandidate[] =>
    fallbackRouter
      ? fallbackRouter.routes.map((route) => ({
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
    execute: async (input): Promise<LocalCommandResult> => {
      const router = await resolveCommandModelRouter(fallbackRouter, routerProvider);
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
          ...(router
            ? {
                modelRoutes: router.routes.map((route) => ({
                  id: route.id,
                  providerId: route.providerId,
                  provider: route.provider,
                  model: route.model,
                })),
              }
            : {}),
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

function createThinkingCommand(
  settings: SessionSettings,
  fallbackRouter?: ModelRouter,
  routerProvider?: () => ModelRouter | Promise<ModelRouter>,
): SlashCommand {
  const candidates = (): readonly SlashArgumentCandidate[] =>
    sessionReasoningCandidates(settings, fallbackRouter).map((level) => ({
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
    execute: async (input): Promise<LocalCommandResult> => {
      const router = await resolveCommandModelRouter(fallbackRouter, routerProvider);
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
      const agents = summarizeAgentProfiles(await loadRegistryAgents(options));
      return {
        type: "local",
        action: "agents",
        message: formatAgentSummaries(agents),
        data: agents,
      };
    },
  };
}

function formatAgentSummaries(agents: readonly AgentProfileSummary[]): string {
  if (agents.length === 0) return "No agents available.";

  return [
    "Available Agents:",
    ...agents.map((agent) => {
      const description = agent.description ? `: ${agent.description}` : "";
      const tools =
        agent.tools && agent.tools.length > 0 ? ` (tools: ${agent.tools.join(", ")})` : "";
      const model = agent.modelRouteId ? ` (model: ${agent.modelRouteId})` : "";
      return `- ${agent.name} [${formatAgentSource(agent.source)}]${description}${tools}${model}`;
    }),
  ].join("\n");
}

function formatAgentSource(source: AgentCatalogSource | undefined): string {
  if (source === undefined) return "unknown";
  if (source === "builtin") return "built-in";
  if (source === "project-native") return "project/native";
  if (source === "project-claude") return "project/claude";
  return "user/claude";
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
      const summaries = await listCliSessionSummaries(options.workDir, {
        ...(options.picoHome ? { picoHome: options.picoHome } : {}),
      });
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
        await loadSessionArgumentCandidates(options.workDir, options.sessionId, options.picoHome),
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

      if (!(await sessionExists(options.workDir, sessionId, options.picoHome))) {
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
        await loadSessionArgumentCandidates(options.workDir, options.sessionId, options.picoHome),
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
      if (!(await sessionExists(options.workDir, sessionId, options.picoHome))) {
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

async function sessionExists(
  workDir: string,
  sessionId: string,
  picoHome?: string,
): Promise<boolean> {
  const store = new RuntimeEventStore({
    databasePath: resolvePicoPaths(workDir, { picoHome }).workspace.runtimeDatabase,
  });
  return Boolean(await store.readSessionManifest(sessionId));
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
  const session =
    options.session ??
    (await globalSessionManager.getOrCreate(
      options.sessionId ?? defaultCliSessionId(options.workDir),
      options.workDir,
      {
        persistence: true,
        ...(options.picoHome ? { picoHome: options.picoHome } : {}),
      },
    ));
  const runtimeEventStore =
    session.runtimeEventStore ??
    new RuntimeEventStore({
      databasePath: resolvePicoPaths(session.workDir, { picoHome: session.picoHome }).workspace
        .runtimeDatabase,
    });
  await runtimeEventStore.initializeSession({
    sessionId: session.id,
    workDir: session.workDir,
  });
  await RuntimeRun.repairSessionProjection(session, {
    workDir: session.workDir,
    store: runtimeEventStore,
  });
  return session;
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
      const skill = await loader.view(resolved.name);
      const activation = renderSkillActivation({
        name: resolved.name,
        args: skillArgs,
        body: resolved.body,
        sourcePath: skill?.sourcePath,
        trigger: "user-slash",
      });
      return {
        type: "prompt",
        prompt: activation.prompt,
        metadata: {
          ...activation.metadata,
          ...(skill?.hooks === undefined ? {} : { skillHookConfig: skill.hooks }),
        },
        ...(skill && (skill.model !== undefined || skill.allowedTools !== undefined)
          ? {
              execution: {
                ...(skill.model === undefined ? {} : { model: skill.model }),
                ...(skill.allowedTools === undefined ? {} : { allowedTools: skill.allowedTools }),
              },
            }
          : {}),
      };
    },
  };
}

function createCronCommand(
  options: PicoCommandRegistryOptions,
  settings: SessionSettings,
): SlashCommand {
  return {
    name: "cron",
    description: "Manage persistent YOLO cron jobs for this workspace",
    usage:
      "/cron <status|list|credential|add|enable|disable|delete|runs> [--tool-network=allow|disabled|allowlist:host1,host2] [arguments]",
    argumentHint: "<status|list|credential|add|enable|disable|delete|runs>",
    category: "workspace",
    kind: "local",
    availability: "idle",
    execute: async (input): Promise<LocalCommandResult> => {
      const cron = options.cronService;
      if (!cron) {
        return {
          type: "local",
          action: "message",
          message: "Cron unavailable: this workspace runtime is not connected.",
        };
      }
      const [operation = "list", ...args] = input.argv;
      try {
        if (operation === "status") {
          const jobs = cron.list(options.workDir);
          const daemon = await cronDaemonStatus(options);
          return cronMessage(
            `本地账本：${jobs.length} 个 Cron Job（${jobs.filter((job) => job.enabled).length} 个已启用）。\n工具网络策略只约束 Agent 工具；模型 Provider 调用仍需联网。\n${daemon}`,
          );
        }
        if (operation === "list") return cronMessage(formatCronJobs(cron.list(options.workDir)));
        if (operation === "runs") {
          return cronMessage(
            formatCronRuns(
              cron.runs({
                workspacePath: options.workDir,
                ...(args[0] ? { cronJobId: args[0] } : {}),
              }),
            ),
          );
        }
        if (operation === "credential") {
          return cronMessage(await manageCronCredential(options, settings, args));
        }
        if (operation === "add") {
          if (settings.mode !== "yolo") {
            return cronMessage(
              "Cron jobs require /mode yolo; interactive permission modes cannot run unattended.",
            );
          }
          const toolNetwork = parseCronToolNetwork(args);
          if (toolNetwork.args.length < 6)
            return cronMessage(
              "Usage: /cron add [--tool-network=allow|disabled|allowlist:host1,host2] <minute> <hour> <day> <month> <weekday> <prompt>",
            );
          const [minute, hour, day, month, weekday, ...promptParts] = toolNetwork.args;
          const credential = await requireCronCredential(options, settings);
          const allowedTools = filterBackgroundEligibleTools(
            settings.tools.map((tool) => tool.name),
          );
          const daemon = options.cronDaemonBridge;
          if (!daemon?.createAutomation) {
            return cronMessage(
              "本机 Runtime daemon 不支持安全的 Automation 创建；任务未写入，请升级或重启 Runtime。",
            );
          }
          const result = await daemon.createAutomation({
            workspacePath: options.workDir,
            schedule: [minute, hour, day, month, weekday].join(" "),
            prompt: promptParts.join(" "),
            modelRouteId: credential.route.id,
            expectedCredentialRef: credential.target.ref,
            allowedTools,
            toolNetworkPolicy: toolNetwork.policy,
            ...(toolNetwork.allowedHosts
              ? { allowedToolNetworkHosts: toolNetwork.allowedHosts }
              : {}),
            enabled: true,
          });
          if (result.status !== "ok") return cronMessage(result.message);
          const finalJob = result.job;
          return cronMessage(
            `Cron job created: ${finalJob.jobId} (${finalJob.enabled ? "enabled" : "disabled"})\n${finalJob.schedule} · ${String(finalJob["timeZone"] ?? "system")}\n${formatRequestedToolNetworkPolicy(toolNetwork.policy, toolNetwork.allowedHosts)}\n${result.message}`,
          );
        }
        const cronJobId = args[0];
        if (!cronJobId) return cronMessage(`Usage: /cron ${operation} <job-id>`);
        const job = cron
          .list(options.workDir)
          .find((candidate) => candidate.cronJobId === cronJobId);
        if (!job) return cronMessage(`Unknown cron job: ${cronJobId}`);
        if (operation === "enable" || operation === "disable") {
          const daemon = options.cronDaemonBridge;
          if (!daemon?.setAutomationEnabled) {
            return cronMessage(
              `本机 Runtime daemon 不支持安全的 Automation ${operation}；任务未变更。`,
            );
          }
          const result = await daemon.setAutomationEnabled({
            workspacePath: options.workDir,
            jobId: cronJobId,
            enabled: operation === "enable",
          });
          return cronMessage(result.message);
        }
        if (operation === "delete") {
          const daemon = options.cronDaemonBridge;
          if (!daemon?.deleteAutomation) {
            return cronMessage("本机 Runtime daemon 不支持安全的 Automation 删除；任务未变更。");
          }
          return cronMessage(
            (await daemon.deleteAutomation({ workspacePath: options.workDir, jobId: cronJobId }))
              .message,
          );
        }
        return cronMessage(
          "Usage: /cron <status|list|credential|add|enable|disable|delete|runs> [arguments]",
        );
      } catch (error) {
        return cronMessage(
          `Cron failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

async function manageCronCredential(
  options: PicoCommandRegistryOptions,
  settings: SessionSettings,
  args: readonly string[],
): Promise<string> {
  const vault = options.credentialVault;
  if (!vault) return "系统凭证库未配置，后台 Provider 凭证已禁用。";
  const capability = vault.capability();
  if (!capability.available) return capability.diagnostic;
  const [action = "status", requestedRoute] = args;
  const route = options.modelRouter?.require(requestedRoute ?? settings.modelRouteId);
  if (!route) return "当前没有可导入的配置模型路由。";
  if (route.source === "legacy") {
    return "持久 Cron 不支持 legacy 环境变量路由；请先在 .pico/config.json 配置 provider。";
  }
  const target = await resolveCronCredentialTarget(options, route);
  if (action === "status") {
    return `${capability.diagnostic}\n${route.id}: ${(await vault.has(target.ref)) ? "已导入" : "未导入"}`;
  }
  if (action !== "import") {
    return "Usage: /cron credential <status|import> [providerID/modelID]";
  }
  const daemon = options.cronDaemonBridge;
  if (!daemon?.importAutomationCredential) {
    return "本机 Runtime daemon 不支持安全的 Automation 凭证导入；凭证未写入。";
  }
  const secret = firstCredentialSecret((options.credentialEnv ?? process.env)[route.apiKeyEnv]);
  if (!secret) return `缺少凭证环境变量 ${route.apiKeyEnv}，无法导入。`;
  const result = await daemon.importAutomationCredential({
    workspacePath: options.workDir,
    modelRouteId: route.id,
    expectedCredentialRef: target.ref,
    secret,
  });
  return result.message;
}

async function requireCronCredential(
  options: PicoCommandRegistryOptions,
  settings: SessionSettings,
): Promise<{
  readonly route: import("../provider/model-router.js").ModelRoute;
  readonly target: AutomationCredentialTarget;
}> {
  const vault = options.credentialVault;
  if (!vault?.capability().available) {
    throw new Error(vault?.capability().diagnostic ?? "系统凭证库未配置");
  }
  const route = options.modelRouter?.require(settings.modelRouteId);
  if (!route) throw new Error("当前没有可用模型路由。");
  const target = await resolveCronCredentialTarget(options, route);
  if (!(await vault.has(target.ref))) {
    throw new Error(`模型路由 ${route.id} 尚未导入系统凭证库；请先执行 /cron credential import。`);
  }
  return { route, target };
}

async function resolveCronCredentialTarget(
  options: PicoCommandRegistryOptions,
  route: import("../provider/model-router.js").ModelRoute,
): Promise<AutomationCredentialTarget> {
  const store = options.userConfigStore ?? new UserConfigStore({ picoHome: options.picoHome });
  const userProvider = (await store.read()).config.providers[route.providerId];
  return resolveAutomationCredentialTarget({
    route,
    workspacePath: options.workDir,
    ...(userProvider ? { userProvider } : {}),
    ...(options.effectiveConfig?.sources[`providers.${route.providerId}`]
      ? { configSource: options.effectiveConfig.sources[`providers.${route.providerId}`] }
      : {}),
  });
}

async function cronDaemonStatus(options: PicoCommandRegistryOptions): Promise<string> {
  if (!options.cronDaemonBridge) {
    return "本机 Runtime daemon 未配置；守护状态未知，任务仅保存在本地账本中。";
  }
  return (await options.cronDaemonBridge.statusWorkspace(options.workDir)).message;
}

function firstCredentialSecret(value: string | undefined): string | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .find(Boolean);
}

function cronMessage(message: string): LocalCommandResult {
  return { type: "local", action: "message", message };
}

function parseCronToolNetwork(args: string[]): {
  args: string[];
  policy: "allow" | "disabled" | "allowlist";
  allowedHosts?: string[];
} {
  const option = args[0];
  if (!option?.startsWith("--tool-network=")) {
    return { args, policy: "allow" };
  }
  const value = option.slice("--tool-network=".length);
  if (value === "allow") return { args: args.slice(1), policy: "allow" };
  if (value === "disabled") return { args: args.slice(1), policy: "disabled" };
  if (value.startsWith("allowlist:")) {
    return {
      args: args.slice(1),
      policy: "allowlist",
      allowedHosts: value.slice("allowlist:".length).split(","),
    };
  }
  throw new Error(
    "工具网络策略必须是 allow、disabled 或 allowlist:host1,host2；它不控制模型 Provider 网络。",
  );
}

function formatToolNetworkPolicy(
  policy: import("../tasks/runtime-types.js").YoloPolicySnapshot,
): string {
  return policy.toolNetworkPolicy === "disabled"
    ? "工具网络：关闭（模型 Provider 网络不受此项控制）"
    : policy.toolNetworkPolicy === "allow"
      ? "工具网络：允许所有符合后台资格的工具联网（模型 Provider 网络独立）"
      : `工具网络：仅允许 ${policy.allowedToolNetworkHosts?.join(", ") ?? "<invalid>"}（模型 Provider 网络不受此项控制）`;
}

function formatRequestedToolNetworkPolicy(
  policy: "allow" | "disabled" | "allowlist",
  allowedHosts?: readonly string[],
): string {
  return policy === "disabled"
    ? "工具网络：关闭（模型 Provider 网络不受此项控制）"
    : policy === "allow"
      ? "工具网络：允许所有符合后台资格的工具联网（模型 Provider 网络独立）"
      : `工具网络：仅允许 ${allowedHosts?.join(", ") ?? "<invalid>"}（模型 Provider 网络不受此项控制）`;
}

function formatCronJobs(
  jobs: readonly import("../tasks/runtime-types.js").CronJobRecord[],
): string {
  if (jobs.length === 0) return "No cron jobs for this workspace.";
  return jobs
    .map(
      (job) =>
        `${job.cronJobId} · ${job.enabled ? "enabled" : "disabled"} · ${job.schedule} · ${job.timeZone}\n  ${formatToolNetworkPolicy(job.policySnapshot)}\n  ${job.prompt}`,
    )
    .join("\n");
}

function formatCronRuns(
  runs: readonly import("../tasks/runtime-types.js").CronRunRecord[],
): string {
  if (runs.length === 0) return "No cron runs for this workspace.";
  return runs
    .map(
      (run) =>
        `${run.cronRunId} · ${run.status} · ${new Date(run.scheduledFor).toISOString()}${run.reason ? ` · ${run.reason}` : ""}`,
    )
    .join("\n");
}

function createAgentCommand(options: PicoCommandRegistryOptions): SlashCommand {
  return {
    name: "agent",
    description: "Dispatch a task to a named subagent",
    usage: "/agent <name> <task>",
    argumentHint: "<name> <task>",
    category: "agent",
    argumentCompleter: async (query) =>
      filterArgumentCandidates(await loadAgentArgumentCandidates(options), query),
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

      const agents = await loadRegistryAgents(options);
      const agent = findAgentProfile(agents, agentName);
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
          ...(agent.hooks === undefined ? {} : { agentHookConfig: agent.hooks }),
        },
      };
    },
  };
}

function formatAgentUsage(): string {
  return "Usage: /agent <name> <task>\n先用 /agents 查看可用 Agent。";
}

function formatAgentNotFound(name: string, agents: readonly CatalogAgentProfile[]): string {
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
      const execution = commandExecution(command);
      const baseMetadata = {
        source: command.source,
        sourcePath: command.sourcePath,
        allowedTools: command.allowedTools,
        model: command.model,
        ...(command.source === "skill" && command.hooks !== undefined
          ? { skillHookConfig: command.hooks }
          : {}),
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
          ...(execution ? { execution } : {}),
        };
      }
      return {
        type: "prompt",
        prompt: renderMarkdownCommandPrompt(command, input.args),
        metadata: baseMetadata,
        ...(execution ? { execution } : {}),
      };
    },
  };
}

function commandExecution(
  command: Pick<MarkdownPromptCommand, "model" | "allowedTools">,
): PromptCommandResult["execution"] {
  if (command.model === undefined && command.allowedTools === undefined) return undefined;
  return {
    ...(command.model === undefined ? {} : { model: command.model }),
    ...(command.allowedTools === undefined ? {} : { allowedTools: command.allowedTools }),
  };
}
