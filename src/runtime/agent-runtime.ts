import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentEngine } from "../engine/loop.js";
import type { GoalManager } from "../engine/goal-manager.js";
import { globalSessionManager, type Session } from "../engine/session.js";
import type { SessionManagerLease } from "../engine/session-manager.js";
import {
  reconcileUnfinishedSessionForksOrThrow,
  SessionForkService,
} from "../engine/session-fork-service.js";
import { TerminalReporter, type Reporter } from "../engine/reporter.js";
import { Compactor } from "../context/compactor.js";
import { FullCompactor } from "../context/full-compactor.js";
import { EvidenceArchive } from "../context/evidence-archive.js";
import { ToolResultArtifactStore } from "../context/artifact-store.js";
import {
  createContextBudget,
  estimateTokenBudgetAsChars,
  type ContextBudget,
} from "../context/context-budget.js";
import { PromptComposer } from "../context/composer.js";
import type { TodoStore } from "../context/todo-store.js";
import { SkillLoader, type Skill } from "../context/skill.js";
import { ToolDisclosure } from "../tools/tool-disclosure.js";
import { createProvider, createRawProvider, type ProviderKind } from "../provider/factory.js";
import { ContextOverflowError, isAbortError } from "../provider/errors.js";
import type { ProviderConfig } from "../provider/config.js";
import { resolveAuxProviderConfig } from "../provider/aux-provider.js";
import type { CredentialResolver } from "../provider/credential-vault.js";
import type { LLMProvider } from "../provider/interface.js";
import { CredentialPool } from "../provider/credential-pool.js";
import { resolveProviderProfile } from "../provider/profile.js";
import { ToolRegistry } from "../tools/registry-impl.js";
import { buildDefaultToolRegistry } from "../tools/default-registry.js";
import type { AskUserHandler } from "../tools/ask-user.js";
import { WorkspaceRoots, workspaceAccessesFromCall } from "../tools/workspace-roots.js";
import { ExitPlanModeTool } from "../tools/plan-exit.js";
import { FetchURLTool } from "../tools/web.js";
import { DelegationManager, DelegateStatusTool } from "../tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../tools/delegation-registry.js";
import type { AgentProfile } from "../tools/agent-profile.js";
import { loadAgentCatalog, type AgentExternalCatalogSource } from "../agents/catalog.js";
import {
  DelegateTaskTool,
  SpawnSubagentTool,
  type SubagentModelSelectionRequest,
  type SubagentReportArtifactWriter,
} from "../tools/subagent.js";
import {
  createToolResultObservationProcessor,
  type ToolObservationProcessor,
} from "../tools/tool-result-observation.js";
import { CostTracker, type CostTrackerOptions } from "../observability/tracker.js";
import { ensureSessionUsageBaseline } from "../observability/usage-baseline.js";
import { resolveModelRouteCapabilities } from "../provider/model-capabilities.js";
import { ModelRouter } from "../provider/model-router.js";
import { Tracer } from "../observability/trace.js";
import { logger } from "../observability/logger.js";
import {
  globalApprovalManager,
  isAgentOpsDangerousCommand,
  isDangerousCommand,
  isHardlineCommand,
  type ApprovalManager,
  type ApprovalNotifier,
} from "../approval/manager.js";
import {
  applySessionPermissionScope,
  bypassImmuneSafetyPath,
  globalSessionPermissionGrants,
  isSensitiveCredentialPath,
  permissionScopeForCall,
  type PermissionRuntimeSettings,
} from "../approval/session-permissions.js";
import { computeApprovalDiff } from "../approval/diff.js";
import { classifyBashCommand } from "../approval/bash-safety.js";
import { createSessionRuntime, type SessionRuntime } from "./session-runtime.js";
import {
  buildSubagentModelCatalog,
  createInheritOnlySubagentModelCatalog,
  type SubagentModelCatalog,
} from "./subagent-model-catalog.js";
import type { MiddlewareFunc } from "../tools/registry.js";
import {
  McpConnectionManager,
  type McpConfigSource,
  type McpStatusSnapshot,
} from "../mcp/manager.js";
import { isMcpToolName } from "../mcp/types.js";
import { createBackgroundMcpClient } from "../safety/background-mcp-client.js";
import { configuredMcpServerNames, filterPluginMcpSources } from "../mcp/effective-config.js";
import type { ScheduleDraftCoordinator } from "../tasks/cron-draft.js";
import { looksLikeScheduleCreationIntent, ScheduleTaskTool } from "../tools/schedule-task.js";
import { BackgroundManager } from "../tools/background-manager.js";
import type { HookService } from "../hooks/service.js";
import {
  getOrCreateSessionSettings,
  DEFAULT_INTERACTION_MODE,
  exitSessionPlanMode,
  setSessionAdditionalDirectories,
  toolStatusFromRegistry,
  type SessionToolStatus,
  type SessionSettings,
} from "../input/session-settings.js";
import { loadPicoConfig } from "../input/pico-config.js";
import type { YoloSandboxConfig } from "../safety/yolo-sandbox.js";
import { resolveCliSession, type CliSessionSelection } from "../cli/session-resolver.js";
import type { WorktreeSupervisor } from "../tasks/worktree-supervisor.js";
import { RuntimeStore } from "../tasks/runtime-store.js";
import { WorkspaceTrustStore } from "../security/workspace-trust.js";
import {
  BackgroundPolicyViolationError,
  buildBackgroundYoloHookExecutionMiddleware,
  buildBackgroundYoloMiddleware,
  prepareBackgroundYoloPolicy,
  type BackgroundWorkspaceTrustVerifier,
  type PreparedBackgroundYoloPolicy,
} from "../safety/background-yolo-policy.js";
import { resolveSubagentModelSelection } from "./subagent-model-selection.js";
import { createSubagentModelRuntime } from "./subagent-model-runtime.js";
import {
  loadPluginRuntimeSnapshot,
  type PluginRuntimeSnapshot,
} from "../plugins/plugin-runtime-snapshot.js";
import {
  PluginCapabilityActivationScope,
  type PluginCapabilityRegistry,
} from "../plugins/plugin-capability.js";
import { registerPluginCapabilityTools } from "../plugins/plugin-tool-activation.js";
import { activatePluginProviderCapabilities } from "../plugins/plugin-provider-activation.js";
import { resolvePicoHome, resolvePicoPaths } from "../paths/pico-paths.js";
import { RuntimeEventStore } from "./runtime-event-store.js";
import { currentRuntimeRun, RuntimeRun } from "./runtime-run.js";
import { RuntimeCleanupScope } from "./runtime-cleanup.js";
import { emitRuntimeLifecycleEvent, RuntimeRunExecutor } from "./runtime-run-executor.js";
import {
  invalidateMemoryReviewRecoverySuccess,
  recoverMemoryReviewJobs,
} from "./memory-review-recovery.js";
import { createEngineRuntimePort } from "./engine-runtime-port-adapter.js";
import { createSessionForkRuntimePort } from "./session-fork-runtime-port-adapter.js";
import {
  assembleRuntimeProvider,
  billingRouteForProvider,
  type RuntimeProviderFactory,
} from "./runtime-assembly.js";
import type {
  RunAgentCliOptions,
  RunAgentCliResult,
  RuntimeExecution,
  RuntimeLifecycleEvent,
} from "./runtime-contract.js";
import { MemoryContextBuilder } from "../memory/context-builder.js";
import { MemoryRepository } from "../memory/memory-repository.js";
import {
  MemoryReviewScheduler,
  type MemoryReviewSchedulerPort,
} from "../memory/runtime-scheduler.js";
import {
  kickMemoryReviewWorker,
  MemoryReviewWorker,
  ProviderMemoryProposalModel,
  type MemoryProposalModelFactory,
  type MemoryProposalPublishedSink,
} from "../memory/worker.js";
export type {
  RunAgentCliOptions,
  RunAgentCliResult,
  RunAgentUsage,
  RuntimeExecution,
  RuntimeLifecycleEvent,
} from "./runtime-contract.js";

export { loadImage } from "../input/prepare-prompt.js";

export type RunAgentEnv = Record<string, string | undefined>;
export type RunAgentProviderFactory = RuntimeProviderFactory;

/**
 * Host-provided effects. The runtime never renders an Ink component or assumes a terminal.
 * Missing approval delivery fails closed when a dangerous tool is requested.
 */
export interface RuntimeHost {
  reporter?: Reporter;
  approvalNotifier?: ApprovalNotifier;
  onEvent?: (event: RuntimeLifecycleEvent) => void;
  /** Metadata-only observer for newly committed pending memory proposals. */
  memoryProposalSink?: MemoryProposalPublishedSink;
}

export interface RunAgentCliDependencies extends RuntimeHost {
  env?: RunAgentEnv;
  /** Host-owned Pico state root. Omitted callers keep the process default. */
  picoHome?: string;
  provider?: LLMProvider;
  providerFactory?: RunAgentProviderFactory;
  /** 前台宿主持有的完整可信模型目录；子代理不得自行读取 endpoint 或凭证。 */
  modelRouter?: ModelRouter;
  toolDisclosure?: ToolDisclosure;
  /** Session-scoped services owned by the caller and reused across prompts. */
  runtimeState?: SessionRuntime;
  /** 仅由可展示结构化问题的 TUI bundle 提供。 */
  askUserHandler?: AskUserHandler;
  /** Host-owned approval state, required when decisions are settled outside the TUI process. */
  approvalManager?: ApprovalManager;
  /** Receives the complete registry after late delegation/MCP registration. */
  toolStatusSink?: (tools: readonly SessionToolStatus[]) => void;
  mcpStatusSink?: (snapshot: McpStatusSnapshot) => void;
  /** TUI 宿主持有的 MCP manager；注入时本轮只换 registry，不重连或关闭 server。 */
  mcpManager?: McpConnectionManager;
  /** Trusted foreground hosts may inject a collision-free user/project MCP snapshot. */
  mcpConfigSources?: readonly McpConfigSource[];
  /** 宿主本轮运行的中止信号。 */
  signal?: AbortSignal;
  /** Host-owned gate used by desktop Pause at tool-safe execution boundaries. */
  waitAtSafeBoundary?: () => Promise<void>;
  /** Receives the exact durable rewind point created for this top-level prompt. */
  rewindPointSink?: (checkpointId: string) => void;
  /** @internal 继续已存在的未完成轮次，不新增 user 消息或 rewind point。 */
  resumeExistingSession?: boolean;
  /** 仅用于后台执行的实时信任校验；生产默认读取用户级 WorkspaceTrustStore。 */
  backgroundTrustStore?: BackgroundWorkspaceTrustVerifier;
  /** daemon/Cron 注入的系统凭证库读取边界；前台 BYOK 不需要。 */
  credentialResolver?: CredentialResolver;
  /** 宿主装配的会话级 HookService；TUI 后续消息必须复用同一实例。 */
  hookService?: HookService;
  /** 仅结构化 TUI 前台可提供；后台与兼容行模式不得注入。 */
  scheduleDraftCoordinator?: ScheduleDraftCoordinator;
  /** TUI/宿主已冻结的受信 Plugin 快照；未注入时前台运行自行加载。 */
  pluginSnapshot?: PluginRuntimeSnapshot;
  /** Host-owned restricted capability factories used for snapshot resolution and activation. */
  pluginCapabilityRegistry?: PluginCapabilityRegistry;
  /** Explicit user-level trust authority for memory recall and review. */
  memoryTrustStore?: WorkspaceTrustStore;
  /** Long-lived hosts with injected providers supply a fresh, self-owned worker model per claim. */
  memoryProposalModelFactory?: MemoryProposalModelFactory;
  /** Test/host override; production automatic reviews wait for a short workspace debounce. */
  memoryReviewDebounceMs?: number;
}

/** Runtime-first entry point. CLI/TUI compatibility wrappers call this method. */
export class AgentRuntime {
  async execute(
    options: RunAgentCliOptions,
    host: RunAgentCliDependencies = {},
  ): Promise<RunAgentCliResult> {
    return executeAgentRuntime(options, host);
  }
}

export type AgentRuntimeRequest = RunAgentCliOptions;
export type AgentRuntimeResult = RunAgentCliResult;
export type AgentRuntimeDependencies = RunAgentCliDependencies;

export async function executeAgentRuntime(
  options: RunAgentCliOptions,
  dependencies: RunAgentCliDependencies = {},
): Promise<RunAgentCliResult> {
  // 阶段 1：解析宿主请求与静态配置。
  dependencies.signal?.throwIfAborted();
  const picoHome = resolvePicoHome({
    picoHome: dependencies.picoHome,
    env: dependencies.env ?? process.env,
  });
  const runtimeEnv: RunAgentEnv = Object.freeze({
    ...(dependencies.env ?? process.env),
    PICO_HOME: picoHome,
  });
  const resumeExistingSession = dependencies.resumeExistingSession === true;
  const prompt = resumeExistingSession ? options.prompt : normalizePrompt(options.prompt);
  const kind = options.provider ?? "openai";
  const workDir = await resolveWorkDir(options.dir);
  await reconcileUnfinishedSessionForksOrThrow(workDir, {
    picoHome,
    runtimePort: createSessionForkRuntimePort(),
  });
  const execution = options.execution ?? ({ kind: "foreground" } as const);
  const backgroundPolicy =
    execution.kind === "background"
      ? await prepareBackgroundExecution(execution, workDir, options, dependencies, picoHome)
      : undefined;
  const backgroundApiKey = await resolveBackgroundCredential(options, execution, dependencies);
  const picoConfig = await loadPicoConfig(workDir);
  const claudeCompatibility = picoConfig.compatibility.claude;
  const configuredAdditionalDirectories = picoConfig.additionalDirectories;
  const sessionSelection =
    options.sessionSelection ??
    (await resolveCliSession({
      workDir,
      picoHome,
      ...(options.session ? { session: options.session } : {}),
      ...(options.continueSession ? { continueSession: true } : {}),
      ...(options.resumeSession ? { resumeSession: options.resumeSession } : {}),
      ...(options.forkSession ? { forkSession: options.forkSession } : {}),
    }));
  const defaultConfigModel = options.model ?? runtimeEnv.LLM_MODEL ?? defaultModel(kind);

  // 阶段 2：获取持久化 Session，并推导会话级有效配置。
  const sessionLease = await acquireRuntimeSession({
    sessionSelection,
    workDir,
    picoHome,
    resumeExistingSession,
    planMode: options.planMode === true,
  });
  const session = sessionLease.session;
  const ownsRuntimeState = dependencies.runtimeState === undefined;
  let sessionLeaseTransferred = false;
  let cleanupRuntimeState: SessionRuntime | undefined;
  let ownedUsageStore: RuntimeStore | undefined;
  let ownsMcpManager = false;
  let cleanupMcpManager: McpConnectionManager | undefined;
  let memoryRepository: MemoryRepository | undefined;
  let memoryContextBuilder: MemoryContextBuilder | undefined;
  let memoryReviewScheduler: MemoryReviewSchedulerPort | undefined;
  let kickMemoryWorker = (): void => undefined;
  let unsubscribeMcpStatus: (() => void) | undefined;
  const cleanupScope = new RuntimeCleanupScope((resource, error) => {
    logger.warn(
      { resource, error: error instanceof Error ? error.message : String(error) },
      "[Runtime] 资源释放失败",
    );
  });
  cleanupScope.register("Session acquisition lease", () => {
    if (!sessionLeaseTransferred) sessionLease.release();
  });
  cleanupScope.register("Workspace memory repository", () => memoryRepository?.close());

  try {
    if (resumeExistingSession && dependencies.runtimeState === undefined) {
      throw new Error("resumeExistingSession requires an existing runtimeState.");
    }
    dependencies.runtimeState?.assertCompatible(session);
    if (dependencies.runtimeState) {
      sessionLease.release();
      sessionLeaseTransferred = true;
    }
    const settings = getOrCreateSessionSettings(
      {
        sessionId: sessionSelection.sessionId,
        sessionMode: sessionSelection.mode,
        ...(sessionSelection.sourceSessionId !== undefined
          ? { forkFrom: sessionSelection.sourceSessionId }
          : {}),
        cwd: workDir,
        picoHome: session.picoHome,
        provider: kind,
        ...(backgroundPolicy ? { mode: "yolo" as const } : {}),
        model: defaultConfigModel,
        ...(options.modelRouteId !== undefined ? { modelRouteId: options.modelRouteId } : {}),
        ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
      },
      { persistence: session, ...(backgroundPolicy ? { restore: false } : {}) },
    );
    const memoryTrustStore =
      dependencies.memoryTrustStore ?? new WorkspaceTrustStore({ userStateDirectory: picoHome });
    if (!backgroundPolicy) {
      try {
        const canonicalMemoryWorkspace = await memoryTrustStore.canonicalize(workDir);
        if (await memoryTrustStore.isTrusted(canonicalMemoryWorkspace)) {
          const memoryPaths = resolvePicoPaths(canonicalMemoryWorkspace, { picoHome });
          memoryRepository = new MemoryRepository({
            databasePath: memoryPaths.workspace.memoryDatabase,
            workspaceId: memoryPaths.workspace.id,
          });
          memoryContextBuilder = new MemoryContextBuilder(memoryRepository);
          const memorySettings = memoryRepository.getSettings();
          if (memorySettings.enabled && memorySettings.autoPropose) {
            memoryReviewScheduler = {
              enqueue: (input) => {
                // This callback runs in RuntimeRunExecutor's detached host task, after the
                // foreground result is available. Own the connection so AgentRuntime cleanup
                // cannot close it before the durable enqueue begins.
                const schedulerRepository = new MemoryRepository({
                  databasePath: memoryPaths.workspace.memoryDatabase,
                  workspaceId: memoryPaths.workspace.id,
                });
                try {
                  new MemoryReviewScheduler(schedulerRepository, {
                    debounceMs: dependencies.memoryReviewDebounceMs,
                  }).enqueue(input);
                } catch (error) {
                  invalidateMemoryReviewRecoverySuccess(memoryPaths.workspace.runtimeDatabase);
                  throw error;
                } finally {
                  schedulerRepository.close();
                }
                kickMemoryWorker();
              },
            };
          }
        }
      } catch (error) {
        logger.warn(
          { workDir, error: error instanceof Error ? error.message : String(error) },
          "[Memory] workspace runtime unavailable; continuing without recall/review",
        );
        memoryRepository?.close();
        memoryRepository = undefined;
        memoryContextBuilder = undefined;
        memoryReviewScheduler = undefined;
      }
    }
    const workspaceRoots = await WorkspaceRoots.create(
      workDir,
      backgroundPolicy || sessionSelection.mode === "fork"
        ? []
        : [
            ...configuredAdditionalDirectories,
            ...(options.addDirs ?? []),
            ...settings.additionalDirectories,
          ],
    );
    setSessionAdditionalDirectories(settings, workspaceRoots.list().slice(1));
    const traceEnabled = options.trace === true || isTruthyEnv(runtimeEnv.PICO_TRACE);
    const effectiveOptions: RunAgentCliOptions = {
      ...options,
      ...(backgroundApiKey !== undefined ? { apiKey: backgroundApiKey } : {}),
      dir: workDir,
      session: sessionSelection.sessionId,
      sessionSelection,
      model: options.model ?? settings.model,
      planMode: backgroundPolicy ? false : (options.planMode ?? settings.mode === "plan"),
      trace: traceEnabled,
      addDirs: backgroundPolicy ? [] : [...settings.additionalDirectories],
      ...(options.thinkingEffort !== undefined
        ? { thinkingEffort: options.thinkingEffort }
        : settings.thinkingEffortExplicit
          ? { thinkingEffort: settings.thinkingEffort }
          : {}),
    };
    const providerConfig = resolveProviderConfig(
      effectiveOptions,
      runtimeEnv,
      dependencies.provider !== undefined,
    );
    const credentialPool =
      effectiveOptions.apiKey === undefined && dependencies.provider === undefined
        ? createRuntimeCredentialPool(runtimeEnv)
        : undefined;
    const pluginSnapshot = backgroundPolicy
      ? undefined
      : (dependencies.pluginSnapshot ??
        (await loadPluginRuntimeSnapshot({
          workDir,
          env: runtimeEnv,
          picoHome,
          ...(dependencies.pluginCapabilityRegistry
            ? { capabilityRegistry: dependencies.pluginCapabilityRegistry }
            : {}),
        })));
    const ownsPluginSnapshot =
      pluginSnapshot !== undefined && dependencies.pluginSnapshot === undefined;
    const pluginActivationScope = new PluginCapabilityActivationScope();
    cleanupScope.register("Session 组件 Hook", () => cleanupRuntimeState?.clearComponentHooks());
    cleanupScope.register("MCP 状态订阅", () => unsubscribeMcpStatus?.());
    cleanupScope.register("MCP manager", async () => {
      if (!cleanupMcpManager || !ownsMcpManager) return;
      await cleanupMcpManager.closeAll();
      dependencies.mcpStatusSink?.(cleanupMcpManager.getStatusSnapshot());
    });
    cleanupScope.register("SessionRuntime", () =>
      ownsRuntimeState ? cleanupRuntimeState?.dispose() : undefined,
    );
    cleanupScope.register("Plugin capability activations", () => pluginActivationScope.dispose());
    cleanupScope.register("Plugin runtime snapshot", () =>
      ownsPluginSnapshot ? pluginSnapshot?.dispose() : undefined,
    );
    cleanupScope.register("Runtime usage ledger", () => ownedUsageStore?.close());
    if (pluginSnapshot?.diagnostics.length) {
      logger.warn(
        {
          workDir,
          diagnostics: pluginSnapshot.diagnostics,
        },
        "[Plugin] Runtime snapshot contains unavailable contributions",
      );
    }
    const skillLoaderFactory = (root: string): SkillLoader =>
      new SkillLoader(root, {
        includeUserResources: true,
        includeClaudeProjectResources:
          claudeCompatibility.enabled && claudeCompatibility.projectResources,
        includeClaudeUserResources:
          claudeCompatibility.enabled && claudeCompatibility.userResources,
        ...(pluginSnapshot?.skillSources ? { externalSources: pluginSnapshot.skillSources } : {}),
        env: runtimeEnv,
        picoHome,
      });

    // 阶段 3：装配 Provider、工具、Hook 与 AgentEngine 能力图。
    const runtimeState =
      dependencies.runtimeState ??
      (await createSessionRuntime({
        session,
        sessionLease,
        env: runtimeEnv,
        ...(dependencies.toolDisclosure !== undefined
          ? { toolDisclosure: dependencies.toolDisclosure }
          : {}),
        // LSP 是项目配置启动的子进程；后台策略尚未为其提供网络/写入沙箱。
        lspServers: backgroundPolicy
          ? []
          : [...picoConfig.lspServers, ...(pluginSnapshot?.lspServers ?? [])],
        sessionStartSource:
          sessionSelection.mode === "resume" || sessionSelection.mode === "continue"
            ? "resume"
            : "startup",
        ...(backgroundPolicy ? { hooks: false as const } : {}),
        ...(dependencies.hookService ? { hookService: dependencies.hookService } : {}),
        ...(pluginSnapshot?.hookSources
          ? { hookExtensionSources: pluginSnapshot.hookSources }
          : {}),
      }));
    if (ownsRuntimeState) sessionLeaseTransferred = true;
    cleanupRuntimeState = runtimeState;
    if (dependencies.hookService) runtimeState.attachHookService(dependencies.hookService);
    if (
      dependencies.toolDisclosure !== undefined &&
      dependencies.toolDisclosure !== runtimeState.toolDisclosure
    ) {
      throw new Error("runtimeState.toolDisclosure must match dependencies.toolDisclosure");
    }
    if (!runtimeState.taskHostRuntime) {
      try {
        ownedUsageStore = new RuntimeStore({
          workDir,
          picoHome,
        });
      } catch (error) {
        logger.error(
          { workDir, error: error instanceof Error ? error.message : String(error) },
          "[Tracker] runtime usage ledger 初始化失败",
        );
      }
    }
    const usageLedger = runtimeState.taskHostRuntime?.jobService ?? ownedUsageStore;
    if (usageLedger) {
      try {
        ensureSessionUsageBaseline(usageLedger, session);
      } catch (error) {
        logger.error(
          { sessionId: session.id, error: error instanceof Error ? error.message : String(error) },
          "[Tracker] Session usage baseline 导入失败",
        );
      }
    }
    const trackerOptions: CostTrackerOptions = {
      ...(usageLedger ? { ledger: usageLedger } : {}),
      context: () => {
        const goalId = runtimeState.goalManager.getActive()?.id;
        return {
          purpose: "main",
          sessionId: session.id,
          conversationId: session.conversationId,
          ...(goalId ? { goalId } : {}),
        };
      },
    };
    const artifactBaseDir = resolvePicoPaths(workDir, {
      picoHome: session.picoHome,
    }).workspace.artifacts;
    // 凭证轮换(4.2):多 key 时从池取首个 key 覆盖 config.apiKey,并构建轮换回调。
    // 单 key / 注入 provider 时跳过(向后兼容)。pool 注入点集中在此,便于追踪 currentKey。
    let currentConfig: ProviderConfig = providerConfig;
    if (credentialPool && credentialPool.size > 1 && dependencies.provider === undefined) {
      currentConfig = { ...providerConfig, apiKey: credentialPool.getNext() };
    }
    const providerFactory = dependencies.providerFactory ?? createRawProvider;
    const providerDecorator = (provider: LLMProvider): LLMProvider =>
      activatePluginProviderCapabilities(
        pluginSnapshot,
        dependencies.pluginCapabilityRegistry,
        provider,
        pluginActivationScope,
      );
    const subagentModelRouter =
      dependencies.modelRouter ??
      (effectiveOptions.modelRouteId && dependencies.provider === undefined
        ? activeRouteModelRouter(kind, providerConfig, effectiveOptions.modelRouteId)
        : undefined);
    const parentModelRouteId = effectiveOptions.modelRouteId;
    const parentModelDisplayId =
      parentModelRouteId ?? dependencies.provider?.modelName ?? providerConfig.model;
    const allowSubagentModelRouteOverride =
      dependencies.modelRouter !== undefined &&
      dependencies.provider === undefined &&
      !backgroundPolicy;
    const subagentModelCatalog =
      subagentModelRouter && parentModelRouteId
        ? buildSubagentModelCatalog({
            router: subagentModelRouter,
            parentRouteId: parentModelRouteId,
            aliases: claudeCompatibility.enabled ? claudeCompatibility.modelAliases : {},
            allowRouteOverride: allowSubagentModelRouteOverride,
          })
        : createInheritOnlySubagentModelCatalog(parentModelDisplayId);
    const resolveSubagentModelRuntime =
      subagentModelRouter && parentModelRouteId && dependencies.provider === undefined
        ? (request?: SubagentModelSelectionRequest) => {
            const requestedModelRoute = request?.ephemeralRouteId ?? request?.profileRouteId;
            const selection = resolveSubagentModelSelection({
              router: subagentModelRouter,
              parentRouteId: parentModelRouteId,
              ...(request?.ephemeralRouteId !== undefined
                ? { ephemeralRouteId: request.ephemeralRouteId }
                : {}),
              ...(request?.profileRouteId !== undefined
                ? { profileRouteId: request.profileRouteId }
                : {}),
              ...(request?.ephemeralThinkingEffort !== undefined
                ? { ephemeralThinkingEffort: request.ephemeralThinkingEffort }
                : {}),
              ...(request?.profileThinkingEffort !== undefined
                ? { profileThinkingEffort: request.profileThinkingEffort }
                : {}),
              parentThinkingEffort: effectiveOptions.thinkingEffort ?? "off",
              modelAliases: picoConfig.compatibility.claude.modelAliases,
              claudeCompatibilityEnabled: picoConfig.compatibility.claude.enabled,
              allowRouteOverride: allowSubagentModelRouteOverride,
            });
            const runtime = createSubagentModelRuntime({
              router: subagentModelRouter,
              selection,
              session,
              providerFactory,
              providerDecorator,
              trackerOptions,
            });
            return {
              provider: runtime.provider,
              compactor: runtime.compactor,
              usageSession: session,
              thinkingEffort: runtime.thinkingEffort ?? "off",
              ...(requestedModelRoute ? { requestedModelRoute } : {}),
              resolvedModelRoute: runtime.route.id,
              source: selection.source,
            };
          }
        : undefined;
    const providerAssembly = assembleRuntimeProvider({
      kind,
      config: currentConfig,
      session,
      trackerOptions,
      ...(dependencies.provider !== undefined ? { provider: dependencies.provider } : {}),
      providerFactory,
      providerDecorator,
      ...(credentialPool ? { credentialPool } : {}),
    });
    const trackedProvider = providerAssembly.provider;
    const rebuildProvider = providerAssembly.rebuildProvider;
    const memoryModelFactory =
      dependencies.memoryProposalModelFactory ??
      (dependencies.provider === undefined
        ? async () => {
            const ledger = new RuntimeStore({ workDir, picoHome });
            const billingRoute = billingRouteForProvider(kind, currentConfig);
            const provider = new CostTracker(
              providerFactory(kind, currentConfig),
              billingRoute,
              undefined,
              {
                ledger,
                context: { purpose: "memory_review" },
              },
            );
            return {
              model: new ProviderMemoryProposalModel(provider, billingRoute),
              dispose: () => ledger.close(),
            };
          }
        : undefined);
    if (memoryReviewScheduler && memoryModelFactory) {
      const memoryPaths = resolvePicoPaths(workDir, { picoHome });
      kickMemoryWorker = () =>
        kickMemoryReviewWorker(
          memoryPaths.workspace.id,
          () =>
            new MemoryReviewWorker({
              workDir,
              workspaceId: memoryPaths.workspace.id,
              memoryDatabasePath: memoryPaths.workspace.memoryDatabase,
              runtimeDatabasePath: memoryPaths.workspace.runtimeDatabase,
              trustStore: memoryTrustStore,
              modelFactory: memoryModelFactory,
              ...(dependencies.memoryProposalSink
                ? { proposalSink: dependencies.memoryProposalSink }
                : {}),
            }),
        );
      // Rebuild jobs lost after a canonical terminal commit, then drain all durable work. Keep
      // this detached from the foreground path: recovery degradation must not delay streaming.
      void recoverMemoryReviewJobs({
        runtimeDatabasePath: memoryPaths.workspace.runtimeDatabase,
        scheduler: memoryReviewScheduler,
      })
        .catch((error: unknown) =>
          logger.warn(
            { workDir, error: error instanceof Error ? error.message : String(error) },
            "[Memory] runtime-ledger recovery failed",
          ),
        )
        .finally(kickMemoryWorker);
    }
    let activeMcpManager = dependencies.mcpManager;
    runtimeState.bindHookRuntime({
      provider: trackedProvider,
      modelRuntime: {
        run: (execute, signal) => runHostOwnedRuntimeOperation(session, execute, signal),
      },
      mcpInvoker: {
        async invokeConnectedTool(server, tool, input, context) {
          if (!activeMcpManager) throw new Error("MCP manager 尚未连接");
          return await activeMcpManager.invokeConnectedTool(server, tool, input, context);
        },
      },
      agentVerifier: {
        async verify(request) {
          const verifierEngine = new AgentEngine({
            provider: hookPurposeProvider(trackedProvider),
            registry: new ToolRegistry(),
            workDir,
            runtimePort: createEngineRuntimePort(),
            workspaceRoots,
            usageSession: session,
            goalManager: runtimeState.goalManager,
          });
          const verifierRegistry = createSubagentRegistryFactory({
            workDir,
            workspaceRoots,
            runner: verifierEngine,
            manager: runtimeState.delegationManager,
            maxSpawnDepth: 0,
            yoloSandbox: { config: picoConfig.sandbox },
            ownerSessionId: session.id,
            artifactBaseDir,
            env: runtimeEnv,
          })({ mode: "explore", role: "leaf", depth: 0, maxSpawnDepth: 0 });
          const task = [
            request.prompt,
            "",
            "只读核验以下 Hook input。最终只输出单个 JSON 对象：",
            '{"ok": boolean, "reason": string}',
            JSON.stringify(request.input),
          ].join("\n");
          const result = await verifierEngine.runSub(task, verifierRegistry, undefined, {
            maxTurns: request.maxTurns,
            role: "leaf",
            depth: 0,
            maxSpawnDepth: 0,
            signal: request.signal,
            workDir,
          });
          return result.summary;
        },
      },
      onAsyncRewake(handler, output) {
        runtimeState.hookRewakeQueue.enqueue(
          `[Hook asyncRewake ${handler.id}] ${output.reason ?? output.additionalContext ?? output.decision}`,
        );
      },
    });
    const { goalManager, todoStore, toolDisclosure, backgroundManager, delegationManager } =
      runtimeState;
    const approvalManager = dependencies.approvalManager ?? globalApprovalManager;
    const registry = buildRegistry(
      workDir,
      backgroundManager,
      goalManager,
      todoStore,
      toolDisclosure,
      workspaceRoots,
      dependencies.askUserHandler,
      runtimeState.codeIntelligence,
      (path) => {
        if (settings.mode === "yolo") return false;
        if (settings.mode === "plan" || path === undefined) return true;
        return !isSensitiveCredentialPath(workspaceRoots.resolveUnchecked(path));
      },
      backgroundPolicy
        ? {
            config: {
              network: backgroundPolicy.snapshot.toolNetworkPolicy === "allow" ? "allow" : "deny",
            },
          }
        : undefined,
      async (skill) => {
        if (!skill.sourcePath || skill.hooks === undefined) return;
        await runtimeState.activateComponentHooks({
          kind: "skill",
          path: skill.sourcePath,
          componentId: skill.name,
          inlineHooks: skill.hooks,
          ...(skill.source?.hookTrustAuthority
            ? { trustAuthority: skill.source.hookTrustAuthority }
            : {}),
        });
      },
      skillLoaderFactory(workDir),
      approvalManager,
      artifactBaseDir,
      runtimeEnv,
    );
    registerPluginCapabilityTools(
      registry,
      pluginSnapshot,
      dependencies.pluginCapabilityRegistry,
      workDir,
      pluginActivationScope,
    );
    if (!backgroundPolicy && dependencies.scheduleDraftCoordinator) {
      registry.register(new ScheduleTaskTool(dependencies.scheduleDraftCoordinator));
    }
    // 前台只使用会话级 HookService；legacy .claw source 也由它统一加载并校验信任。
    if (runtimeState.hookService) {
      registry.setHookService?.(runtimeState.hookService);
    }
    const artifactRuntime = buildArtifactRuntime(session.id, artifactBaseDir);
    // Inject steer text into the session-scoped queue before the next provider turn.
    const steerQueue = runtimeState.steerQueue;
    if (options.steer) {
      steerQueue.push(options.steer);
    }
    const systemPromptFactory = async (): Promise<string> => {
      const composed = await new PromptComposer(workDir, effectiveOptions.planMode ?? false, {
        goalManager,
        todoStore,
        skillLoader: skillLoaderFactory(workDir),
        onInstructionsLoaded: async (paths) => {
          await runtimeState.dispatchHook(
            "InstructionsLoaded",
            { paths },
            { signal: dependencies.signal },
          );
        },
      }).build();
      let withMemory = composed;
      if (memoryContextBuilder) {
        try {
          const canonical = await memoryTrustStore.canonicalize(workDir);
          if (await memoryTrustStore.isTrusted(canonical)) {
            const memory = await memoryContextBuilder.build(prompt);
            if (memory.block) withMemory = `${composed}\n\n${memory.block}`;
          }
        } catch (error) {
          logger.warn(
            { workDir, error: error instanceof Error ? error.message : String(error) },
            "[Memory] recall injection degraded",
          );
        }
      }
      if (
        backgroundPolicy ||
        !dependencies.scheduleDraftCoordinator ||
        !looksLikeScheduleCreationIntent(prompt)
      ) {
        return withMemory;
      }
      return `${withMemory}\n\n<schedule-task-intent>用户明确要求创建周期任务。请调用 schedule_task 提交结构化草案等待用户确认；不得仅用文字声称已经创建。</schedule-task-intent>`;
    };
    // 辅助(廉价)模型:用于 FullCompactor 生成摘要,省主模型成本。
    // 配齐 AUX_LLM_BASE_URL / AUX_LLM_API_KEY / AUX_LLM_MODEL 才启用;缺则用主 provider。
    const auxProvider = loadAuxProvider(runtimeEnv, session, trackerOptions, providerDecorator);
    const evidenceArchive = new EvidenceArchive({
      baseDir: resolvePicoPaths(workDir, { picoHome }).workspace.evidence,
    });
    const reporter = dependencies.reporter ?? new TerminalReporter();
    const approvalNotifier =
      dependencies.approvalNotifier ?? buildFailClosedApprovalNotifier(approvalManager);
    const contextRuntime = buildContextRuntime(kind, providerConfig.model);
    const engine = new AgentEngine({
      provider: trackedProvider,
      registry,
      workDir,
      runtimePort: createEngineRuntimePort(),
      workspaceRoots,
      usageSession: session,
      ...(effectiveOptions.thinkingEffort !== undefined
        ? { thinkingEffort: effectiveOptions.thinkingEffort }
        : {}),
      ...(effectiveOptions.modelRouteId !== undefined
        ? { modelRouteId: effectiveOptions.modelRouteId }
        : {}),
      ...(resolveSubagentModelRuntime ? { resolveSubagentModelRuntime } : {}),
      planMode: effectiveOptions.planMode ?? false,
      systemPromptFactory,
      goalManager,
      todoStore,
      toolDisclosure,
      compactor: contextRuntime.compactor,
      contextBudget: contextRuntime.budget,
      // 模型摘要压缩:85% 水位主动整理 + Provider overflow 紧急重试。
      // 优先用辅助廉价模型(AUX_LLM_*)生成摘要省主模型成本;未配置则用主 provider。
      fullCompactor: new FullCompactor({
        provider: trackedProvider,
        ...(auxProvider ? { auxProvider } : {}),
        ...(runtimeState.hookService ? { hookService: runtimeState.hookService } : {}),
        evidenceArchive,
      }),
      observationProcessor: artifactRuntime.observationProcessor,
      runtimeEvidenceArchive: evidenceArchive,
      subagentReportArtifactWriter: artifactRuntime.subagentReportArtifactWriter,
      reporter,
      tracer: traceEnabled ? new Tracer({ picoHome }) : undefined,
      steerQueue,
      ...(dependencies.waitAtSafeBoundary
        ? { waitAtSafeBoundary: dependencies.waitAtSafeBoundary }
        : {}),
      ...(runtimeState.hookService ? { hookService: runtimeState.hookService } : {}),
      skillLoaderFactory,
      ...(rebuildProvider ? { rebuildProvider } : {}),
    });

    if (backgroundPolicy) {
      registry.useSafety?.(
        buildBackgroundYoloMiddleware({
          policy: backgroundPolicy,
          workspaceRoots,
          sessionId: session.id,
        }),
      );
      registry.useExecution?.(
        buildBackgroundYoloHookExecutionMiddleware({
          policy: backgroundPolicy,
          sessionId: session.id,
        }),
      );
    } else {
      registry.useSafety?.(buildForegroundSafetyMiddleware(workDir, settings, workspaceRoots));
      registry.usePermission?.(
        buildPermissionMiddleware(
          approvalNotifier,
          workDir,
          dependencies.signal,
          approvalManager,
          settings,
          workspaceRoots,
          runtimeState.hookService,
          session.picoHome,
        ),
      );
    }
    registerDelegationTools(
      registry,
      engine,
      workDir,
      await loadProfiles(workDir, {
        externalSources: pluginSnapshot?.agentSources,
        includeClaudeProjectResources:
          claudeCompatibility.enabled && claudeCompatibility.projectResources,
        includeClaudeUserResources:
          claudeCompatibility.enabled && claudeCompatibility.userResources,
        env: runtimeEnv,
        picoHome,
      }),
      delegationManager,
      workspaceRoots,
      // 主会话的 mode 只控制主 Agent 权限。worker/explore 是独立的不可信执行边界，
      // 必须始终使用 worktree + OS 沙箱，不得因 default/auto 模式退化为无沙箱 Bash。
      { config: picoConfig.sandbox },
      session.id,
      !ownsRuntimeState,
      runtimeState.taskHostRuntime?.supervisor,
      reporter,
      skillLoaderFactory,
      runtimeState.hookService,
      subagentModelCatalog,
      artifactBaseDir,
      runtimeEnv,
      async (profile) => {
        if (!profile.sourcePath || profile.hooks === undefined) return async () => undefined;
        return await runtimeState.activateComponentHookLease({
          kind: "agent",
          path: profile.sourcePath,
          componentId: profile.name,
          inlineHooks: profile.hooks,
          ...(profile.hookTrustAuthority ? { trustAuthority: profile.hookTrustAuthority } : {}),
        });
      },
    );
    if (backgroundPolicy) pruneRegistryToBackgroundAllowlist(registry, backgroundPolicy);
    dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));

    // 3.6 Plan Review:把 ExitPlanModeTool 的退出回调接到 engine.exitPlanMode,
    // 并把审批通知路由到 host 注入的 notifier,使审批通过后真正切换 planMode。
    const notifier = approvalNotifier;
    const exitTool = registry.getTool("exit_plan_mode");
    if (exitTool instanceof ExitPlanModeTool) {
      exitTool.setApprovalManager(approvalManager);
      exitTool.setExitCallback(() => {
        markSharedPlanModeExited(settings);
        engine.exitPlanMode();
      });
      exitTool.setNotify(notifier);
      exitTool.setAbortSignal(dependencies.signal);
    }

    // MCP 服务器:加载配置 → 并行连接 → 自动注册工具到 registry。
    // per-server 失败隔离,一个 server 挂了不影响其他。
    const mcpConfigPath = backgroundPolicy?.mcpConfigPath ?? options.mcpConfigPath;
    const hostMcpSources = backgroundPolicy ? [] : (dependencies.mcpConfigSources ?? []);
    const pluginMcpSources = filterPluginMcpSources(
      pluginSnapshot?.mcpSources ?? [],
      configuredMcpServerNames(hostMcpSources),
    );
    ownsMcpManager = dependencies.mcpManager === undefined;
    const mcpManager =
      dependencies.mcpManager ??
      (mcpConfigPath || hostMcpSources.length > 0 || pluginMcpSources.length > 0
        ? new McpConnectionManager(registry, {
            stdioCwd: workDir,
            ...(backgroundPolicy?.snapshot.mcpConfigFingerprint
              ? { expectedConfigFingerprint: backgroundPolicy.snapshot.mcpConfigFingerprint }
              : {}),
            ...(backgroundPolicy
              ? {
                  clientFactory: (config) =>
                    createBackgroundMcpClient(
                      config,
                      workDir,
                      backgroundPolicy.snapshot.toolNetworkPolicy,
                      backgroundPolicy.allowedToolNetworkHosts,
                    ),
                }
              : {}),
            ...(pluginMcpSources.length > 0 &&
            (hostMcpSources.length > 0 || mcpConfigPath !== undefined)
              ? { duplicateServerPolicy: "keep-first" as const }
              : {}),
          })
        : undefined);
    cleanupMcpManager = mcpManager;
    activeMcpManager = mcpManager;
    unsubscribeMcpStatus =
      mcpManager && dependencies.mcpStatusSink
        ? mcpManager.subscribe(dependencies.mcpStatusSink)
        : undefined;
    if (mcpManager && !ownsMcpManager) {
      mcpManager.attachRegistry(registry);
      dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));
    } else if (
      mcpManager &&
      (mcpConfigPath || hostMcpSources.length > 0 || pluginMcpSources.length > 0)
    ) {
      if (
        mcpConfigPath &&
        (backgroundPolicy || (hostMcpSources.length === 0 && pluginMcpSources.length === 0))
      ) {
        await mcpManager.loadConfig(mcpConfigPath);
      } else {
        await mcpManager.replaceSources([
          ...hostMcpSources,
          ...(mcpConfigPath
            ? [{ id: "project", path: mcpConfigPath } satisfies McpConfigSource]
            : []),
          ...pluginMcpSources,
        ]);
      }
      dependencies.mcpStatusSink?.(mcpManager.getStatusSnapshot());
      await mcpManager.connectAll();
      dependencies.mcpStatusSink?.(mcpManager.getStatusSnapshot());
      if (backgroundPolicy) {
        pruneRegistryToBackgroundAllowlist(registry, backgroundPolicy);
      }
      dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));
    }
    if (backgroundPolicy) {
      pruneRegistryToBackgroundAllowlist(registry, backgroundPolicy);
      const missingTools = [...backgroundPolicy.allowedTools].filter(
        (tool) => registry.getTool(tool) === undefined,
      );
      if (missingTools.length > 0) {
        const onlyMcp = missingTools.every(isMcpToolName);
        throw new BackgroundPolicyViolationError(
          onlyMcp ? "mcp_unavailable" : "tool_unavailable",
          `后台工具不可用: ${missingTools.join(", ")}`,
        );
      }
    }
    if (effectiveOptions.allowedTools !== undefined) {
      pruneRegistryToCommandAllowlist(registry, effectiveOptions.allowedTools);
      dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));
    }

    // 阶段 4：在当前 Session 内串行执行一次 RuntimeRun。
    // RuntimeRunExecutor 不拥有任何资源；本函数仍负责阶段 3 的装配和 finally 清理。
    const result = await new RuntimeRunExecutor({
      session,
      runtimeState,
      engine,
      sessionSelection,
      workDir,
      picoHome,
      prompt,
      resumeExistingSession,
      traceEnabled,
      options: {
        ...(effectiveOptions.rewindPrompt !== undefined
          ? { rewindPrompt: effectiveOptions.rewindPrompt }
          : {}),
        ...(effectiveOptions.rewindTranscriptIndex !== undefined
          ? { rewindTranscriptIndex: effectiveOptions.rewindTranscriptIndex }
          : {}),
        ...(effectiveOptions.rewindInteractionMode !== undefined
          ? { rewindInteractionMode: effectiveOptions.rewindInteractionMode }
          : {}),
        ...(effectiveOptions.rewindPrePlanMode !== undefined
          ? { rewindPrePlanMode: effectiveOptions.rewindPrePlanMode }
          : {}),
        ...(effectiveOptions.imagePath !== undefined
          ? { imagePath: effectiveOptions.imagePath }
          : {}),
        ...(effectiveOptions.images !== undefined ? { images: effectiveOptions.images } : {}),
      },
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      ...(dependencies.onEvent ? { onEvent: dependencies.onEvent } : {}),
      ...(dependencies.rewindPointSink ? { rewindPointSink: dependencies.rewindPointSink } : {}),
      ...(memoryReviewScheduler ? { memoryReviewScheduler } : {}),
    }).execute();
    return result;
  } catch (error) {
    if (cleanupRuntimeState?.hookService && !dependencies.signal?.aborted) {
      await cleanupRuntimeState
        .dispatchHook("StopFailure", {
          category: classifyStopFailure(error),
          error: error instanceof Error ? error.message : String(error),
        })
        .catch((hookError) =>
          logger.warn({ hookError: String(hookError) }, "[Hook] StopFailure 事件执行失败"),
        );
    }
    emitRuntimeLifecycleEvent(dependencies.onEvent, {
      type: "run.failed",
      sessionId: session.id,
      workDir,
      at: Date.now(),
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    // 阶段 5：只释放本次调用持有的资源。
    // 非 TUI 调用仍按轮关闭；TUI 注入的 manager 由宿主在退出时统一关闭。
    await cleanupScope.dispose();
  }
}

async function acquireRuntimeSession({
  sessionSelection,
  workDir,
  picoHome,
  resumeExistingSession,
  planMode,
}: {
  sessionSelection: CliSessionSelection;
  workDir: string;
  picoHome: string;
  resumeExistingSession: boolean;
  planMode: boolean;
}): Promise<SessionManagerLease> {
  const runtimeEventStore = new RuntimeEventStore({
    databasePath: resolvePicoPaths(workDir, { picoHome }).workspace.runtimeDatabase,
  });
  let targetManifest = await runtimeEventStore.readSessionManifest(sessionSelection.sessionId);
  if (sessionSelection.mode === "fork" && sessionSelection.sourceSessionId) {
    const sourceManifest = await runtimeEventStore.readSessionManifest(
      sessionSelection.sourceSessionId,
    );
    if (!sourceManifest) {
      throw new Error(
        `无法 fork session ${sessionSelection.sourceSessionId}: runtime.sqlite 中不存在`,
      );
    }
    if (!targetManifest) {
      const sourceLease = await globalSessionManager.getOrCreatePinned(
        sessionSelection.sourceSessionId,
        workDir,
        {
          persistence: true,
          picoHome,
          runtimePort: createEngineRuntimePort(),
        },
      );
      try {
        const sourceCapability = sourceLease.session.runtimeEventCapability;
        if (!sourceCapability) {
          throw new Error(`Fork source requires a durable Session: ${sourceLease.session.id}`);
        }
        await RuntimeRun.repairSessionProjection(sourceLease.session, {
          capability: sourceCapability,
        });
        await new SessionForkService({
          workDir,
          picoHome,
          runtimePort: createSessionForkRuntimePort(),
        }).fork({
          sourceSessionId: sessionSelection.sourceSessionId,
          targetSessionId: sessionSelection.sessionId,
          targetMode: planMode ? "plan" : DEFAULT_INTERACTION_MODE,
        });
        targetManifest = await runtimeEventStore.readSessionManifest(sessionSelection.sessionId);
      } finally {
        sourceLease.release();
      }
    }
    const forkEvent = (await runtimeEventStore.readSession(sessionSelection.sessionId)).findLast(
      (event) => event.kind === "session.forked",
    );
    if (!targetManifest || !forkEvent) {
      throw new Error(`fork target ${sessionSelection.sessionId} 缺少完整的 RuntimeEvent 历史`);
    }
    if (forkEvent.data.parentSessionId !== sessionSelection.sourceSessionId) {
      throw new Error(
        `fork target ${sessionSelection.sessionId} 记录的 parent ${forkEvent.data.parentSessionId} 与当前请求不一致`,
      );
    }
  }
  let lease: SessionManagerLease | undefined;
  if (resumeExistingSession) {
    const session = globalSessionManager.get(sessionSelection.sessionId, workDir, { picoHome });
    if (session) {
      lease = { session, release: globalSessionManager.pin(session) };
    }
  } else {
    lease = await globalSessionManager.getOrCreatePinned(sessionSelection.sessionId, workDir, {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    });
  }
  if (!lease) {
    throw new Error(`Cannot resume missing session: ${sessionSelection.sessionId}`);
  }
  try {
    const runtimeCapability = lease.session.runtimeEventCapability;
    const runtimeStore = lease.session.runtimeEventStore;
    if (!runtimeCapability || !runtimeStore) {
      throw new Error(`AgentRuntime requires a durable Session: ${sessionSelection.sessionId}`);
    }
    await runtimeStore.initializeSession({ sessionId: lease.session.id, workDir });
    await RuntimeRun.repairSessionProjection(lease.session, { capability: runtimeCapability });
    return lease;
  } catch (error) {
    lease.release();
    throw error;
  }
}

function classifyStopFailure(error: unknown): string {
  if (isAbortError(error)) return "abort";
  if (error instanceof ContextOverflowError) return "context";
  const message = error instanceof Error ? error.message : String(error);
  return /provider|model|429|rate limit|network/iu.test(message) ? "provider" : "internal";
}

function buildRegistry(
  workDir: string,
  backgroundManager: BackgroundManager,
  goalManager?: GoalManager,
  todoStore?: TodoStore,
  toolDisclosure?: ToolDisclosure,
  workspaceRoots?: WorkspaceRoots,
  askUserHandler?: AskUserHandler,
  codeIntelligence?: SessionRuntime["codeIntelligence"],
  excludeSensitiveGrepFiles?: boolean | ((path: string | undefined) => boolean),
  yoloSandbox?: { config?: Partial<YoloSandboxConfig> },
  activateSkillHooks?: (skill: Skill) => void | Promise<void>,
  skillLoader?: SkillLoader,
  approvalManager?: ApprovalManager,
  artifactBaseDir?: string,
  env?: NodeJS.ProcessEnv,
): ToolRegistry {
  return buildDefaultToolRegistry(workDir, {
    truncateResults: false,
    deferWorkspaceBoundary: true,
    backgroundManager,
    ...(goalManager !== undefined ? { goalManager } : {}),
    ...(todoStore !== undefined ? { todoStore } : {}),
    ...(toolDisclosure !== undefined ? { toolDisclosure } : {}),
    ...(workspaceRoots !== undefined ? { workspaceRoots } : {}),
    ...(askUserHandler !== undefined ? { askUserHandler } : {}),
    ...(codeIntelligence !== undefined ? { codeIntelligence } : {}),
    ...(excludeSensitiveGrepFiles !== undefined ? { excludeSensitiveGrepFiles } : {}),
    ...(yoloSandbox !== undefined ? { yoloSandbox } : {}),
    ...(activateSkillHooks !== undefined ? { activateSkillHooks } : {}),
    ...(skillLoader !== undefined ? { skillLoader } : {}),
    ...(approvalManager !== undefined ? { approvalManager } : {}),
    ...(artifactBaseDir !== undefined ? { artifactBaseDir } : {}),
    ...(env !== undefined ? { env } : {}),
  });
}

async function prepareBackgroundExecution(
  execution: Extract<RuntimeExecution, { kind: "background" }>,
  workDir: string,
  options: RunAgentCliOptions,
  dependencies: RunAgentCliDependencies,
  picoHome: string,
): Promise<PreparedBackgroundYoloPolicy> {
  if (options.planMode === true) {
    throw new BackgroundPolicyViolationError("invalid_policy", "后台 YOLO 不支持 planMode。");
  }
  if ((options.addDirs?.length ?? 0) > 0) {
    throw new BackgroundPolicyViolationError(
      "invalid_policy",
      "后台执行只允许访问 Job 绑定的真实工作区，不接受 addDirs。",
    );
  }
  if (options.mcpConfigPath) {
    throw new BackgroundPolicyViolationError(
      "invalid_policy",
      "后台 MCP 配置只能由 Job policySnapshot 绑定的工作区固定配置加载。",
    );
  }
  if (
    dependencies.mcpManager ||
    dependencies.mcpConfigSources ||
    dependencies.hookService ||
    dependencies.scheduleDraftCoordinator
  ) {
    throw new BackgroundPolicyViolationError(
      "invalid_policy",
      "后台执行不得复用前台 MCP、Hook 或定时草案交互宿主。",
    );
  }
  if (dependencies.runtimeState || dependencies.resumeExistingSession) {
    throw new BackgroundPolicyViolationError(
      "invalid_policy",
      "后台执行不得复用可能携带前台 LSP、权限或未完成轮次的 runtimeState。",
    );
  }
  return prepareBackgroundYoloPolicy({
    workDir,
    policy: execution.policy,
    trustStore:
      dependencies.backgroundTrustStore ??
      new WorkspaceTrustStore({ userStateDirectory: picoHome }),
  });
}

function pruneRegistryToBackgroundAllowlist(
  registry: ToolRegistry,
  policy: PreparedBackgroundYoloPolicy,
): void {
  for (const tool of registry.getAvailableTools()) {
    if (!policy.allowedTools.has(tool.name)) registry.unregisterForHostPolicy(tool.name);
  }
  const fetchUrl = registry.getTool("fetch_url");
  if (policy.snapshot.toolNetworkPolicy === "allowlist" && fetchUrl instanceof FetchURLTool) {
    fetchUrl.setAuthorizeUrl((url) => {
      const hostname = url.hostname
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "")
        .toLowerCase();
      if (!policy.allowedToolNetworkHosts.has(hostname)) {
        throw new Error(
          `[background:network_denied] 重定向主机 ${hostname} 不在 Job 工具网络 allowlist 中。`,
        );
      }
    });
  }
}

function pruneRegistryToCommandAllowlist(
  registry: ToolRegistry,
  requestedTools: readonly string[],
): void {
  const normalized = requestedTools.map((tool) => tool.trim());
  if (normalized.some((tool) => tool.length === 0)) {
    throw new Error("Markdown command allowed-tools 含空值，已拒绝执行。");
  }
  const available = new Set(registry.getAvailableTools().map((tool) => tool.name));
  const unknown = [...new Set(normalized.filter((tool) => !available.has(tool)))];
  if (unknown.length > 0) {
    throw new Error(`Markdown command allowed-tools 包含未知工具: ${unknown.join(", ")}`);
  }
  const allowed = new Set(normalized);
  for (const tool of registry.getAvailableTools()) {
    if (!allowed.has(tool.name)) registry.unregisterForHostPolicy(tool.name);
  }
}

/** 加载原生 Profile 与 Claude 兼容输入合并后的统一 Agent 目录。 */
async function loadProfiles(
  workDir: string,
  options: {
    externalSources?: readonly AgentExternalCatalogSource[];
    includeClaudeProjectResources: boolean;
    includeClaudeUserResources: boolean;
    env: Readonly<Record<string, string | undefined>>;
    picoHome?: string;
  },
): Promise<AgentProfile[]> {
  try {
    return await loadAgentCatalog({ workDir, includeBuiltins: true, ...options });
  } catch {
    return [];
  }
}

function registerDelegationTools(
  registry: ToolRegistry,
  engine: AgentEngine,
  workDir: string,
  profiles: AgentProfile[],
  manager: DelegationManager,
  workspaceRoots: WorkspaceRoots,
  yoloSandbox: { config?: Partial<YoloSandboxConfig> },
  ownerSessionId: string,
  allowAsyncCompletion: boolean,
  worktreeSupervisor?: WorktreeSupervisor,
  reporter?: Reporter,
  skillLoaderFactory?: (workDir: string) => SkillLoader,
  hookService?: HookService,
  modelCatalog?: SubagentModelCatalog,
  artifactBaseDir?: string,
  env?: Readonly<Record<string, string | undefined>>,
  activateAgentHooks?: (profile: AgentProfile) => Promise<() => void | Promise<void>>,
): void {
  const registryFactory = createSubagentRegistryFactory({
    workDir,
    workspaceRoots,
    runner: engine,
    manager,
    yoloSandbox,
    ownerSessionId,
    allowAsyncCompletion,
    ...(skillLoaderFactory ? { skillLoaderFactory } : {}),
    ...(hookService ? { hookService } : {}),
    ...(modelCatalog ? { modelCatalog } : {}),
    ...(artifactBaseDir ? { artifactBaseDir } : {}),
    ...(env ? { env } : {}),
    ...(activateAgentHooks ? { activateAgentHooks } : {}),
    ...(worktreeSupervisor ? { worktreeSupervisor } : {}),
    ...(profiles.length > 0 ? { profiles } : {}),
  });
  const delegateTaskOptions = {
    workDir,
    ...(profiles.length > 0 ? { profiles } : {}),
    ...(worktreeSupervisor ? { worktreeSupervisor } : {}),
    ...(reporter ? { reporter } : {}),
    ownerSessionId,
    allowAsyncCompletion,
    ...(activateAgentHooks ? { activateAgentHooks } : {}),
    ...(hookService ? { hookService } : {}),
    ...(modelCatalog ? { modelCatalog } : {}),
  };
  registry.register(new DelegateTaskTool(engine, registryFactory, manager, delegateTaskOptions));
  registry.register(new DelegateStatusTool(manager));
  registry.register(
    new SpawnSubagentTool(
      engine,
      registryFactory({ mode: "explore", role: "leaf", depth: 0, maxSpawnDepth: 1 }),
    ),
  );
}

function buildContextRuntime(
  kind: ProviderKind,
  model: string,
): { budget: ContextBudget; compactor: Compactor } {
  const protocol = kind === "openai" ? "openai" : kind;
  const profile = resolveProviderProfile(protocol, model);
  const budget = createContextBudget(profile);
  return {
    budget,
    compactor: new Compactor({
      maxChars: estimateTokenBudgetAsChars(budget.inputBudgetTokens),
      retainLastMsgs: 6,
    }),
  };
}

/** Hook verifier 的所有模型调用都显式覆盖为 purpose=hook。 */
function hookPurposeProvider(provider: LLMProvider): LLMProvider {
  return {
    ...(provider.modelName ? { modelName: provider.modelName } : {}),
    generate: (messages, tools, options) =>
      provider.generate(messages, tools, { ...options, purpose: "hook" }),
    ...(provider.generateStream
      ? {
          generateStream: (messages, tools, onDelta, options) =>
            provider.generateStream!(messages, tools, onDelta, {
              ...options,
              purpose: "hook",
            }),
        }
      : {}),
  };
}

async function runHostOwnedRuntimeOperation<Result>(
  session: Session,
  execute: () => Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  const ambient = currentRuntimeRun();
  if (ambient) {
    if (!ambient.claimsSession(session) || ambient.runtimeEventWriteGuard !== session) {
      throw new Error(
        `Hook model handler cannot reuse RuntimeRun ${ambient.runId} for Session ${session.id}`,
      );
    }
    return execute();
  }

  return session.serialize(async () => {
    const runtimeCapability = session.runtimeEventCapability;
    if (!runtimeCapability) {
      throw new Error(`Hook model handler requires a durable Session: ${session.id}`);
    }
    await RuntimeRun.reconcileIncompleteRuns({
      capability: runtimeCapability,
    });
    await RuntimeRun.repairSessionProjection(session, {
      capability: runtimeCapability,
    });
    const runtimeRun = await RuntimeRun.start({
      capability: runtimeCapability,
    });
    return runtimeRun.run(execute, signal);
  });
}

function activeRouteModelRouter(
  kind: ProviderKind,
  config: ProviderConfig,
  routeId: string,
): ModelRouter {
  const apiKeyEnv = "PICO_ACTIVE_MODEL_API_KEY";
  return new ModelRouter(
    [
      {
        id: routeId,
        providerId: routeId.split("/", 1)[0] || "active",
        provider: kind,
        model: config.model,
        baseURL: config.baseURL,
        apiKeyEnv,
        source: "config",
        capabilities:
          config.capabilities ??
          resolveModelRouteCapabilities(kind, config.model, undefined, {
            baseURL: config.baseURL,
          }),
      },
    ],
    { [apiKeyEnv]: config.apiKey },
    routeId,
  );
}

/**
 * 加载辅助(廉价)模型 provider,供 FullCompactor 生成摘要。
 * 配齐 AUX_LLM_BASE_URL / AUX_LLM_API_KEY / AUX_LLM_MODEL 三项才启用;
 * 缺任意一项则返回 undefined(FullCompactor 回退到主 provider)。
 */
function loadAuxProvider(
  env: RunAgentEnv,
  session: Session,
  trackerOptions: CostTrackerOptions,
  decorateProvider: (provider: LLMProvider) => LLMProvider,
): LLMProvider | undefined {
  const resolved = resolveAuxProviderConfig(env);
  if (!resolved) return undefined;
  return new CostTracker(
    decorateProvider(createProvider(resolved.kind, resolved.config)),
    billingRouteForProvider(resolved.kind, resolved.config),
    session,
    trackerOptions,
  );
}

function buildArtifactRuntime(
  sessionId: string,
  artifactBaseDir: string,
): {
  observationProcessor: ToolObservationProcessor;
  subagentReportArtifactWriter: SubagentReportArtifactWriter;
} {
  const store = new ToolResultArtifactStore({
    baseDir: artifactBaseDir,
  });
  const subagentReportArtifactWriter: SubagentReportArtifactWriter = async (input) => {
    const meta = await store.write({
      sessionId,
      toolName: "subagent_report",
      args: {
        taskPrompt: input.taskPrompt,
        status: input.status,
        workDir: input.workDir,
      },
      output: input.report,
      summary: `子代理 ${input.status} 完整报告，${input.report.length} 字符`,
      pinned: input.status === "partial",
    });
    try {
      const cleanup = await store.cleanup();
      if (cleanup.deleted.includes(meta.id)) {
        logger.warn(
          { artifactId: meta.id },
          "[Subagent] 完整报告因 artifact 全局配额被清理，回退到内联摘要。",
        );
        return undefined;
      }
    } catch (error) {
      logger.warn({ error }, "[Subagent] 完整报告 artifact cleanup 失败");
    }
    return meta.path;
  };
  return {
    observationProcessor: createToolResultObservationProcessor({ store }),
    subagentReportArtifactWriter,
  };
}

export function buildApprovalMiddleware(
  notifier: ApprovalNotifier,
  workDir: string,
  signal?: AbortSignal,
  approvalManager: ApprovalManager = globalApprovalManager,
  settings?: Pick<SessionSettings, "sessionId" | "mode"> &
    Partial<Pick<SessionSettings, "additionalDirectories">>,
  workspaceRoots?: WorkspaceRoots,
  picoHome?: string,
): MiddlewareFunc {
  const safety = buildForegroundSafetyMiddleware(workDir, settings, workspaceRoots);
  const permission = buildPermissionMiddleware(
    notifier,
    workDir,
    signal,
    approvalManager,
    settings,
    workspaceRoots,
    undefined,
    picoHome,
  );
  return async (call, context) => {
    const safetyResult = await safety(call);
    return safetyResult.allowed ? permission(safetyResult.call ?? call, context) : safetyResult;
  };
}

/** Hardline / Plan / Trust 属于不可审批绕过的前置安全门。 */
export function buildForegroundSafetyMiddleware(
  workDir: string,
  settings?: Pick<SessionSettings, "mode">,
  workspaceRoots?: WorkspaceRoots,
): MiddlewareFunc {
  return async (call) => {
    const mode = settings?.mode ?? "default";
    const planModeDenial = await planModeDenialReason(call, mode, workDir, workspaceRoots);
    if (planModeDenial !== undefined) {
      return {
        allowed: false,
        reason: planModeDenial,
      };
    }
    if (isHardlineCommand(call.name, call.arguments, workDir)) {
      return {
        allowed: false,
        reason: "Hardline 高危命令不可审批绕过,系统直接拒绝。",
      };
    }
    return { allowed: true };
  };
}

/** PreToolUse 通过后的交互权限链；只在确实需要审批时发 PermissionRequest。 */
export function buildPermissionMiddleware(
  notifier: ApprovalNotifier,
  workDir: string,
  signal?: AbortSignal,
  approvalManager: ApprovalManager = globalApprovalManager,
  settings?: Pick<SessionSettings, "sessionId" | "mode"> &
    Partial<Pick<SessionSettings, "additionalDirectories">>,
  workspaceRoots?: WorkspaceRoots,
  hookService?: HookService,
  picoHome?: string,
): MiddlewareFunc {
  return async (call, context) => {
    const mode = settings?.mode ?? "default";
    const sessionId = settings?.sessionId ?? "cli";
    const workspaceAccesses = workspaceAccessesFromCall(call);

    // 主 TUI 的 YOLO 是全程放权：普通工具不审批，也不施加工作区、网络或
    // 敏感写沙箱。直接文件工具仍需给自身的 WorkspaceRoots 一次性通行证；
    // worker 使用独立 registry/worktree，继续保留显式沙箱隔离。
    if (mode === "yolo" && context?.forceApproval !== true) {
      if (workspaceRoots) {
        for (const access of workspaceAccesses) workspaceRoots.authorizeOnce(access.path);
      }
      return { allowed: true, reason: "YOLO 模式全程放行" };
    }

    const externalAccesses = workspaceRoots
      ? workspaceAccesses.filter((access) => !workspaceRoots.isAllowedPath(access.path))
      : [];
    const externalDirectories = workspaceRoots
      ? await externalAuthorizationDirectories(externalAccesses, workspaceRoots)
      : [];
    const safetyPath = bypassImmuneSafetyPath(call, workDir, workspaceRoots);
    const hasSessionGrant = globalSessionPermissionGrants.allows(
      sessionId,
      call,
      workDir,
      workspaceRoots,
      picoHome,
    );
    const hasExplicitSafetyGrant = globalSessionPermissionGrants.allowsSafetyOverride(
      sessionId,
      call,
      workDir,
      workspaceRoots,
      picoHome,
    );

    if (
      context?.forceApproval !== true &&
      hasSessionGrant &&
      externalDirectories.length === 0 &&
      (safetyPath === undefined || hasExplicitSafetyGrant)
    ) {
      return { allowed: true, reason: "本会话结构化权限规则放行" };
    }

    const needsApproval =
      context?.forceApproval === true ||
      safetyPath !== undefined ||
      externalDirectories.length > 0 ||
      bashNeedsApproval(call) ||
      isMcpToolName(call.name) ||
      (mode === "default" && isAgentOpsDangerousCommand(call.name, call.arguments)) ||
      (mode === "auto" && isDangerousCommand(call.name, call.arguments));
    if (!needsApproval) return { allowed: true, reason: `${mode} 模式自动放行` };

    if (hookService) {
      const hookDecision = await hookService.dispatch(
        "PermissionRequest",
        {
          tool_name: call.name,
          tool_input: parseHookToolInput(call.arguments),
          tool_call_id: call.id,
          reason: "工具调用需要交互审批",
        },
        { signal },
      );
      if (hookDecision.decision === "deny") {
        return {
          allowed: false,
          reason: hookDecision.reason ?? "PermissionRequest hook 拒绝了该工具调用。",
          denialSource: "hook",
        };
      }
    }

    const externalScope =
      externalDirectories.length > 0
        ? permissionScopeForCall(call, {
            externalDirectories,
            autoEditsAlreadyEnabled: mode === "auto",
          })
        : undefined;
    const scope = permissionScopeForCall(call, {
      ...(safetyPath !== undefined
        ? { safetyPath }
        : externalDirectories.length > 0
          ? { externalDirectories }
          : {}),
      autoEditsAlreadyEnabled: mode === "auto",
    });
    const diff = await computeApprovalDiff(call.name, call.arguments, workDir, workspaceRoots);
    const approvalId = `approval_${randomUUID()}`;
    const runtimeRun = currentRuntimeRun();
    let runtimeApprovalRecorded = false;
    if (runtimeRun) {
      await runtimeRun.recordApprovalRequested(approvalId, call.id, call.name);
      runtimeApprovalRecorded = true;
    }
    let result;
    try {
      result = await approvalManager.waitForApproval(
        approvalId,
        call.name,
        call.arguments,
        notifier,
        diff,
        signal,
        { sessionScope: scope, providerCallId: call.id },
      );
    } catch (error) {
      if (runtimeApprovalRecorded) {
        await runtimeRun!.recordApprovalSettled(approvalId, "rejected");
      }
      throw error;
    }
    if (runtimeApprovalRecorded) {
      await runtimeRun!.recordApprovalSettled(approvalId, result.allowed ? "approved" : "rejected");
    }
    if (!result.allowed || !workspaceRoots || !settings) {
      return result.allowed ? result : { ...result, denialSource: "human" };
    }

    if (result.allowForSession) {
      await applySessionPermissionScope(scope, {
        sessionId,
        workDir,
        settings: settings as PermissionRuntimeSettings,
        workspaceRoots,
        picoHome,
      });
      if (safetyPath !== undefined && externalScope?.type === "directories") {
        await applySessionPermissionScope(
          { ...externalScope, enableAutoEdits: false },
          {
            sessionId,
            workDir,
            settings: settings as PermissionRuntimeSettings,
            workspaceRoots,
            picoHome,
          },
        );
      }
    } else {
      for (const access of externalAccesses) workspaceRoots.authorizeOnce(access.path);
    }
    return result;
  };
}

function parseHookToolInput(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return {};
  }
}

async function externalAuthorizationDirectories(
  accesses: ReturnType<typeof workspaceAccessesFromCall>,
  workspaceRoots: WorkspaceRoots,
): Promise<string[]> {
  const directories = await Promise.all(
    accesses
      .filter((access) => !workspaceRoots.isAllowedPath(access.path))
      .map((access) => workspaceRoots.authorizationDirectoryForPath(access.path)),
  );
  return [...new Set(directories)];
}

async function planModeDenialReason(
  call: { name: string; arguments: string },
  mode: SessionSettings["mode"],
  workDir: string,
  workspaceRoots?: WorkspaceRoots,
): Promise<string | undefined> {
  if (mode !== "plan") return undefined;
  if (
    (call.name === "read_file" || call.name === "grep") &&
    bypassImmuneSafetyPath(call, workDir, workspaceRoots) !== undefined
  ) {
    return "Plan Mode 守卫：密钥与凭据文件不属于计划阶段的可读边界。";
  }
  if (call.name === "write_file" || call.name === "edit_file") {
    const path = parseJsonStringField(call.arguments, "path");
    return path !== undefined && !(await isPlanModeAllowedPath(path, workDir))
      ? "Plan Mode 守卫：当前处于 Plan Mode，只能修改 PLAN.md / TODO.md。"
      : undefined;
  }
  if (isMcpToolName(call.name)) {
    return "Plan Mode 守卫：MCP 工具的外部副作用无法证明为只读，已拒绝执行。";
  }
  if (call.name === "delegate_task") {
    return "Plan Mode 守卫：delegate_task 可能启动可写 worker 或递归委派，已拒绝执行；只读探索请使用 spawn_subagent。";
  }
  if (call.name !== "bash") return undefined;
  if (parseJsonBooleanField(call.arguments, "background") === true) {
    return "Plan Mode 守卫：只读 Bash 必须在前台完成，已拒绝后台进程。";
  }
  const command = parseJsonStringField(call.arguments, "command");
  if (command === undefined) {
    return "Plan Mode 守卫：无法解析 Bash 命令，只允许可证明只读的命令。";
  }
  const classification = classifyBashCommand(command);
  return classification.kind === "read-only"
    ? undefined
    : `Plan Mode 守卫：只允许可证明只读的 Bash；${classification.reason}。`;
}

function bashNeedsApproval(call: { name: string; arguments: string }): boolean {
  if (call.name !== "bash") return false;
  const command = parseJsonStringField(call.arguments, "command");
  return command === undefined || classifyBashCommand(command).kind !== "read-only";
}

function parseJsonStringField(args: string, field: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonBooleanField(args: string, field: string): boolean | undefined {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function isPlanModeAllowedPath(path: string, workDir: string): Promise<boolean> {
  const target = resolve(workDir, path);
  const allowed = [resolve(workDir, "PLAN.md"), resolve(workDir, "TODO.md")];
  if (!allowed.includes(target)) return false;
  try {
    return !(await lstat(target)).isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function markSharedPlanModeExited(settings: SessionSettings): void {
  exitSessionPlanMode(settings);
}

/** A headless runtime settles the same manager it asked, so it never waits for absent UI. */
function buildFailClosedApprovalNotifier(approvalManager: ApprovalManager): ApprovalNotifier {
  return (notice) => {
    queueMicrotask(() => {
      approvalManager.resolveApproval(
        notice.taskId,
        false,
        "当前 Runtime Host 未提供审批交互，已安全拒绝。",
      );
    });
  };
}

async function resolveBackgroundCredential(
  options: RunAgentCliOptions,
  execution: RuntimeExecution,
  dependencies: RunAgentCliDependencies,
): Promise<string | undefined> {
  if (execution.kind === "foreground" || dependencies.provider !== undefined) return undefined;
  if (options.apiKey !== undefined) {
    throw new Error("后台执行拒绝直接传入 apiKey；请使用 credentialRef 和系统凭证库。");
  }
  if (options.credentialRef === undefined || dependencies.credentialResolver === undefined) {
    throw new Error("后台执行缺少 credentialRef 或系统凭证解析器，已按 fail-closed 拒绝。");
  }
  return dependencies.credentialResolver.resolve(options.credentialRef);
}

function resolveProviderConfig(
  options: RunAgentCliOptions,
  env: RunAgentEnv,
  allowMissingNetworkConfig: boolean,
): ProviderConfig {
  const baseURL = options.baseURL ?? env.LLM_BASE_URL;
  const apiKey = options.apiKey ?? firstApiKey(env.LLM_API_KEYS) ?? env.LLM_API_KEY;
  const model = options.model ?? env.LLM_MODEL ?? defaultModel(options.provider ?? "openai");

  if (!allowMissingNetworkConfig && (!baseURL || !apiKey)) {
    throw new Error("缺少 Provider 配置:请提供 LLM_BASE_URL / LLM_API_KEY 或对应 CLI 参数");
  }

  return {
    baseURL: baseURL ?? "",
    apiKey: apiKey ?? "",
    model,
    ...(options.modelRouteId ? { routeId: options.modelRouteId } : {}),
    ...(options.modelCapabilities ? { capabilities: options.modelCapabilities } : {}),
    ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
  };
}

function firstApiKey(value: string | undefined): string | undefined {
  return value
    ?.split(",")
    .map((key) => key.trim())
    .find(Boolean);
}

/** @internal Pure runtime-env boundary used by executeAgentRuntime. */
export function createRuntimeCredentialPool(env: RunAgentEnv): CredentialPool | undefined {
  const keys = env.LLM_API_KEYS?.split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  return keys && keys.length > 1 ? new CredentialPool(keys) : undefined;
}

async function resolveWorkDir(dir: string | undefined): Promise<string> {
  const target = resolve(dir ?? process.cwd());

  await mkdir(target, { recursive: true });

  return realpath(target);
}

function normalizePrompt(prompt: string): string {
  if (prompt.trim() === "") {
    throw new Error("Prompt must not be empty.");
  }

  return prompt;
}

function defaultModel(kind: ProviderKind): string {
  switch (kind) {
    case "openai":
      return "glm-5.2";
    case "claude":
      return "claude-3-5-sonnet";
    case "gemini":
      return "gemini-2.0-flash";
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "on";
}
