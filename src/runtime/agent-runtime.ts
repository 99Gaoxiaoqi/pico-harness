import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentEngine } from "../engine/loop.js";
import type { GoalManager } from "../engine/goal-manager.js";
import { globalSessionManager, type Session } from "../engine/session.js";
import { SessionForkService } from "../engine/session-fork-service.js";
import { TerminalReporter, type Reporter } from "../engine/reporter.js";
import { Compactor } from "../context/compactor.js";
import { FullCompactor } from "../context/full-compactor.js";
import { ToolResultArtifactStore } from "../context/artifact-store.js";
import { createContextBudget, estimateTokenBudgetAsChars } from "../context/context-budget.js";
import { PromptComposer } from "../context/composer.js";
import type { TodoStore } from "../context/todo-store.js";
import { SkillLoader, type Skill } from "../context/skill.js";
import { ToolDisclosure } from "../tools/tool-disclosure.js";
import {
  createProvider,
  createRawProvider,
  getCredentialPool,
  type ProviderKind,
} from "../provider/factory.js";
import { fallbackModelFor, isModelUnavailableError } from "../provider/fallback.js";
import { ContextOverflowError, isAbortError } from "../provider/errors.js";
import type { ProviderConfig } from "../provider/config.js";
import type { CredentialRef, CredentialResolver } from "../provider/credential-vault.js";
import type { LLMProvider, LLMProviderRequestOptions } from "../provider/interface.js";
import { CredentialRotationCoordinator } from "../provider/credential-rotation.js";
import { resolveProviderProfile } from "../provider/profile.js";
import type { ImagePart, Message, ToolDefinition } from "../schema/message.js";
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
import type { BillingRoute } from "../observability/pricing.js";
import {
  resolveModelRouteCapabilities,
  type ModelRouteCapabilities,
} from "../provider/model-capabilities.js";
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
import type { MiddlewareFunc } from "../tools/registry.js";
import { McpConnectionManager, type McpStatusSnapshot } from "../mcp/manager.js";
import { isMcpToolName } from "../mcp/types.js";
import { createBackgroundMcpClient } from "../safety/background-mcp-client.js";
import type { ScheduleDraftCoordinator } from "../tasks/cron-draft.js";
import { looksLikeScheduleCreationIntent, ScheduleTaskTool } from "../tools/schedule-task.js";
import { BackgroundManager } from "../tools/background-manager.js";
import { loadHooksConfig } from "../hooks/config.js";
import { HookRunner } from "../hooks/runner.js";
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
import { loadImage } from "../input/prepare-prompt.js";
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
  type BackgroundYoloPolicySnapshot,
  type PreparedBackgroundYoloPolicy,
} from "../safety/background-yolo-policy.js";
import { resolveSubagentModelSelection } from "./subagent-model-selection.js";
import { createSubagentModelRuntime } from "./subagent-model-runtime.js";
import {
  loadPluginRuntimeSnapshot,
  type PluginRuntimeSnapshot,
} from "../plugins/plugin-runtime-snapshot.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";

export type RuntimeExecution =
  | { readonly kind: "foreground" }
  | { readonly kind: "background"; readonly policy: BackgroundYoloPolicySnapshot };

export interface RunAgentCliOptions {
  prompt: string;
  /** 默认 foreground；daemon/Cron 必须显式提供完整 background policy。 */
  execution?: RuntimeExecution;
  dir?: string;
  /** 兼容旧 --session:按指定 id 恢复会话 */
  session?: string;
  /** Continue the latest session in the current project. */
  continueSession?: boolean;
  /** Resume a specific session. */
  resumeSession?: string;
  /** 从指定会话派生一个新会话 */
  forkSession?: string;
  /** 已解析的 session 选择结果(TUI/宿主可复用,避免每轮重新生成 id) */
  sessionSelection?: CliSessionSelection;
  provider?: ProviderKind;
  baseURL?: string;
  apiKey?: string;
  /** 后台执行只持有非秘密引用；明文由 Runtime Host 在系统凭证库边界解析。 */
  credentialRef?: CredentialRef;
  model?: string;
  modelRouteId?: string;
  modelCapabilities?: ModelRouteCapabilities;
  /** Route-aware callers disable bare-model fallback because a fallback may need another endpoint. */
  allowModelFallback?: boolean;
  /** Active model reasoning level. Legacy CLI callers still pass off/low/medium/high. */
  thinkingEffort?: string;
  planMode?: boolean;
  /** Enable per-request JSON trace export. Also enabled by PICO_TRACE=1. */
  trace?: boolean;
  /** MCP 配置文件路径(--mcp-config)。提供则启动时连接所有 MCP server 并注册工具 */
  mcpConfigPath?: string;
  /** Steer text injected once before the run starts. */
  steer?: string;
  /** 图片附件路径:读取为 ImagePart 附到本轮 user 消息。 */
  imagePath?: string;
  /** TUI/宿主已解析好的图片附件。 */
  images?: ImagePart[];
  /** Claude Code 风格附加工作目录；可重复传入，当前会话内生效。 */
  addDirs?: string[];
  /** Per-run command restriction. Unknown names fail before the first provider call. */
  allowedTools?: readonly string[];
  /** TUI 中用户实际发送的文本，用作 /rewind 的可见名称。 */
  rewindPrompt?: string;
  /** 用户消息写入可见 transcript 前的条目下标。 */
  rewindTranscriptIndex?: number;
  /** 宿主可选记录该消息发送时的交互模式。 */
  rewindInteractionMode?: SessionSettings["mode"];
  /** 该消息在 plan 模式下发送时，记录进入 plan 前的模式。 */
  rewindPrePlanMode?: NonNullable<SessionSettings["prePlanMode"]>;
}

export { loadImage } from "../input/prepare-prompt.js";

export interface RunAgentUsage {
  promptTokens: number;
  completionTokens: number;
  costCNY: number;
}

export interface RunAgentCliResult {
  sessionId: string;
  sessionSelection: CliSessionSelection;
  workDir: string;
  finalMessage: string;
  usage: RunAgentUsage;
  messages: readonly Message[];
  tracePath?: string;
}

export type RunAgentEnv = Record<string, string | undefined>;
export type RunAgentProviderFactory = (kind: ProviderKind, config: ProviderConfig) => LLMProvider;

/** A UI-neutral lifecycle event for a runtime host. */
export interface RuntimeEvent {
  type: "run.started" | "run.finished" | "run.failed";
  sessionId?: string;
  workDir?: string;
  at: number;
  detail?: string;
}

/**
 * Host-provided effects. The runtime never renders an Ink component or assumes a terminal.
 * Missing approval delivery fails closed when a dangerous tool is requested.
 */
export interface RuntimeHost {
  reporter?: Reporter;
  approvalNotifier?: ApprovalNotifier;
  onEvent?: (event: RuntimeEvent) => void;
}

export interface RunAgentCliDependencies extends RuntimeHost {
  env?: RunAgentEnv;
  provider?: LLMProvider;
  providerFactory?: RunAgentProviderFactory;
  /** 前台宿主持有的完整可信模型目录；子代理不得自行读取 endpoint 或凭证。 */
  modelRouter?: ModelRouter;
  toolDisclosure?: ToolDisclosure;
  /** Session-scoped services owned by the caller and reused across prompts. */
  runtimeState?: SessionRuntime;
  /** 仅由可展示结构化问题的 TUI bundle 提供。 */
  askUserHandler?: AskUserHandler;
  /** Receives the complete registry after late delegation/MCP registration. */
  toolStatusSink?: (tools: readonly SessionToolStatus[]) => void;
  mcpStatusSink?: (snapshot: McpStatusSnapshot) => void;
  /** TUI 宿主持有的 MCP manager；注入时本轮只换 registry，不重连或关闭 server。 */
  mcpManager?: McpConnectionManager;
  /** 宿主本轮运行的中止信号。 */
  signal?: AbortSignal;
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
  dependencies.signal?.throwIfAborted();
  const resumeExistingSession = dependencies.resumeExistingSession === true;
  let prompt = resumeExistingSession ? options.prompt : normalizePrompt(options.prompt);
  const kind = options.provider ?? "openai";
  const workDir = await resolveWorkDir(options.dir);
  const execution = options.execution ?? ({ kind: "foreground" } as const);
  const backgroundPolicy =
    execution.kind === "background"
      ? await prepareBackgroundExecution(execution, workDir, options, dependencies)
      : undefined;
  const backgroundApiKey = await resolveBackgroundCredential(options, execution, dependencies);
  const picoConfig = await loadPicoConfig(workDir);
  const claudeCompatibility = picoConfig.compatibility.claude;
  const configuredAdditionalDirectories = picoConfig.additionalDirectories;
  const sessionSelection =
    options.sessionSelection ??
    (await resolveCliSession({
      workDir,
      ...(options.session ? { session: options.session } : {}),
      ...(options.continueSession ? { continueSession: true } : {}),
      ...(options.resumeSession ? { resumeSession: options.resumeSession } : {}),
      ...(options.forkSession ? { forkSession: options.forkSession } : {}),
    }));
  const defaultConfigModel =
    options.model ?? (dependencies.env ?? process.env).LLM_MODEL ?? defaultModel(kind);
  const existingSession = globalSessionManager.get(sessionSelection.sessionId, workDir);
  const targetPublished = await stat(
    join(resolvePicoPaths(workDir).workspace.sessions, `${sessionSelection.sessionId}.jsonl`),
  ).then(
    (info) => info.isFile(),
    () => false,
  );
  if (
    !resumeExistingSession &&
    !existingSession &&
    !targetPublished &&
    sessionSelection.mode === "fork" &&
    sessionSelection.sourceSessionId
  ) {
    await new SessionForkService({ workDir }).fork({
      sourceSessionId: sessionSelection.sourceSessionId,
      targetSessionId: sessionSelection.sessionId,
      targetMode: options.planMode === true ? "plan" : DEFAULT_INTERACTION_MODE,
    });
  }
  const session = resumeExistingSession
    ? globalSessionManager.get(sessionSelection.sessionId, workDir)
    : (existingSession ??
      (await globalSessionManager.getOrCreate(sessionSelection.sessionId, workDir)));
  if (!session) {
    throw new Error(`Cannot resume missing session: ${sessionSelection.sessionId}`);
  }
  if (resumeExistingSession && dependencies.runtimeState === undefined) {
    throw new Error("resumeExistingSession requires an existing runtimeState.");
  }
  const settings = getOrCreateSessionSettings(
    {
      sessionId: sessionSelection.sessionId,
      sessionMode: sessionSelection.mode,
      ...(sessionSelection.sourceSessionId !== undefined
        ? { forkFrom: sessionSelection.sourceSessionId }
        : {}),
      cwd: workDir,
      provider: kind,
      ...(backgroundPolicy ? { mode: "yolo" as const } : {}),
      model: defaultConfigModel,
      ...(options.modelRouteId !== undefined ? { modelRouteId: options.modelRouteId } : {}),
      ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
    },
    { persistence: session, ...(backgroundPolicy ? { restore: false } : {}) },
  );
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
  const traceEnabled =
    options.trace === true || isTruthyEnv((dependencies.env ?? process.env).PICO_TRACE);
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
    dependencies.env ?? process.env,
    dependencies.provider !== undefined,
  );
  const ownsRuntimeState = dependencies.runtimeState === undefined;
  let cleanupRuntimeState: SessionRuntime | undefined;
  let ownedUsageStore: RuntimeStore | undefined;
  let cleanupRegistry: ToolRegistry | undefined;
  let ownsMcpManager = false;
  let cleanupMcpManager: McpConnectionManager | undefined;
  let unsubscribeMcpStatus: (() => void) | undefined;
  const pluginSnapshot = backgroundPolicy
    ? undefined
    : (dependencies.pluginSnapshot ??
      (await loadPluginRuntimeSnapshot({ workDir, env: dependencies.env ?? process.env })));
  const ownsPluginSnapshot =
    pluginSnapshot !== undefined && dependencies.pluginSnapshot === undefined;
  const skillLoaderFactory = (root: string): SkillLoader =>
    new SkillLoader(root, {
      includeUserResources: true,
      includeClaudeProjectResources:
        claudeCompatibility.enabled && claudeCompatibility.projectResources,
      includeClaudeUserResources: claudeCompatibility.enabled && claudeCompatibility.userResources,
      ...(pluginSnapshot?.skillSources ? { externalSources: pluginSnapshot.skillSources } : {}),
      env: dependencies.env ?? process.env,
    });

  try {
    const runtimeState =
      dependencies.runtimeState ??
      (await createSessionRuntime({
        workDir,
        sessionId: session.id,
        session,
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
    cleanupRuntimeState = runtimeState;
    runtimeState.assertCompatible(workDir, session.id);
    if (dependencies.hookService) runtimeState.attachHookService(dependencies.hookService);
    if (
      dependencies.toolDisclosure !== undefined &&
      dependencies.toolDisclosure !== runtimeState.toolDisclosure
    ) {
      throw new Error("runtimeState.toolDisclosure must match dependencies.toolDisclosure");
    }
    if (!runtimeState.taskHostRuntime) {
      try {
        ownedUsageStore = new RuntimeStore({ workDir });
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
    // 凭证轮换(4.2):多 key 时从池取首个 key 覆盖 config.apiKey,并构建轮换回调。
    // 单 key / 注入 provider 时跳过(向后兼容)。pool 注入点集中在此,便于追踪 currentKey。
    const credentialPool = effectiveOptions.apiKey === undefined ? getCredentialPool() : undefined;
    let currentConfig: ProviderConfig = providerConfig;
    if (credentialPool && credentialPool.size > 1 && dependencies.provider === undefined) {
      currentConfig = { ...providerConfig, apiKey: credentialPool.getNext() };
    }
    const providerFactory = dependencies.providerFactory ?? createRawProvider;
    const subagentModelRouter =
      dependencies.modelRouter ??
      (effectiveOptions.modelRouteId && dependencies.provider === undefined
        ? activeRouteModelRouter(kind, providerConfig, effectiveOptions.modelRouteId)
        : undefined);
    const parentModelRouteId = effectiveOptions.modelRouteId;
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
              allowRouteOverride: !backgroundPolicy,
            });
            const runtime = createSubagentModelRuntime({
              router: subagentModelRouter,
              selection,
              session,
              providerFactory,
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
    const buildTrackedProvider = (config: ProviderConfig): LLMProvider =>
      effectiveOptions.allowModelFallback === false
        ? new CostTracker(
            providerFactory(kind, config),
            trackingRoute(kind, config),
            session,
            trackerOptions,
          )
        : createTrackedProviderWithFallback(kind, config, providerFactory, session, trackerOptions);
    let trackedProvider: LLMProvider;
    let rebuildProvider: (() => LLMProvider | undefined) | undefined;
    if (dependencies.provider !== undefined) {
      trackedProvider = new CostTracker(
        dependencies.provider,
        trackingRoute(kind, providerConfig),
        session,
        trackerOptions,
      );
    } else if (credentialPool && credentialPool.size > 1) {
      const rotation = new CredentialRotationCoordinator(
        credentialPool,
        currentConfig,
        buildTrackedProvider,
      );
      trackedProvider = rotation.provider;
      rebuildProvider = () => rotation.rotate();
    } else {
      trackedProvider = buildTrackedProvider(currentConfig);
    }
    let activeMcpManager = dependencies.mcpManager;
    runtimeState.bindHookRuntime({
      provider: trackedProvider,
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
        });
      },
      skillLoaderFactory(workDir),
    );
    cleanupRegistry = registry;
    if (!backgroundPolicy && dependencies.scheduleDraftCoordinator) {
      registry.register(new ScheduleTaskTool(dependencies.scheduleDraftCoordinator));
    }
    // 【任务 2.6】用户可配置 Shell Hooks:加载 .claw/settings.json 的 hooks 配置,
    // 存在则挂载 HookRunner 到 registry。fail-open:配置缺失/畸形均不启用 hook,零影响。
    registry.setSessionId?.(session.id);
    if (runtimeState.hookService) {
      registry.setHookService?.(runtimeState.hookService);
    } else if (!backgroundPolicy) {
      const hooksConfig = await loadHooksConfig(workDir);
      if (hooksConfig) {
        registry.setHookRunner?.(new HookRunner(workDir, hooksConfig));
      }
    }
    const artifactRuntime = buildArtifactRuntime(workDir, session.id);
    // Inject steer text into the session-scoped queue before the next provider turn.
    const steerQueue = runtimeState.steerQueue;
    if (options.steer) {
      steerQueue.push(options.steer);
    }
    const systemPromptFactory = async (): Promise<string> => {
      const composed = await new PromptComposer(workDir, effectiveOptions.planMode ?? false, {
        sessionId: session.id,
        skillRegistry: runtimeState.skillRegistry,
        ...(runtimeState.memoryNudger !== undefined
          ? { memoryNudger: runtimeState.memoryNudger }
          : {}),
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
      }).build(runtimeState.conversationTurnCount(session));
      if (
        backgroundPolicy ||
        !dependencies.scheduleDraftCoordinator ||
        !looksLikeScheduleCreationIntent(prompt)
      ) {
        return composed;
      }
      return `${composed}\n\n<schedule-task-intent>用户明确要求创建周期任务。请调用 schedule_task 提交结构化草案等待用户确认；不得仅用文字声称已经创建。</schedule-task-intent>`;
    };
    // 辅助(廉价)模型:用于 FullCompactor 生成摘要,省主模型成本。
    // 配齐 AUX_LLM_BASE_URL / AUX_LLM_API_KEY / AUX_LLM_MODEL 才启用;缺则用主 provider。
    const auxProvider = loadAuxProvider(dependencies.env ?? process.env, session, trackerOptions);
    const reporter = dependencies.reporter ?? new TerminalReporter();
    const approvalNotifier = dependencies.approvalNotifier ?? failClosedApprovalNotifier;
    dependencies.onEvent?.({ type: "run.started", sessionId: session.id, workDir, at: Date.now() });
    const engine = new AgentEngine({
      provider: trackedProvider,
      registry,
      workDir,
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
      compactor: buildCompactor(kind, providerConfig.model),
      // 模型摘要压缩:provider 存在即启用,作为字符级降级用尽后的最后防线。
      // 优先用辅助廉价模型(AUX_LLM_*)生成摘要省主模型成本;未配置则用主 provider。
      fullCompactor: new FullCompactor({
        provider: trackedProvider,
        ...(auxProvider ? { auxProvider } : {}),
      }),
      observationProcessor: artifactRuntime.observationProcessor,
      subagentReportArtifactWriter: artifactRuntime.subagentReportArtifactWriter,
      reporter,
      tracer: traceEnabled ? new Tracer() : undefined,
      steerQueue,
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
          globalApprovalManager,
          settings,
          workspaceRoots,
          runtimeState.hookService,
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
        env: dependencies.env ?? process.env,
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
      async (profile) => {
        if (!profile.sourcePath || profile.hooks === undefined) return async () => undefined;
        return await runtimeState.activateComponentHookLease({
          kind: "agent",
          path: profile.sourcePath,
          componentId: profile.name,
          inlineHooks: profile.hooks,
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
    const pluginMcpSources = pluginSnapshot?.mcpSources ?? [];
    ownsMcpManager = dependencies.mcpManager === undefined;
    const mcpManager =
      dependencies.mcpManager ??
      (mcpConfigPath || pluginMcpSources.length > 0
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
    } else if (mcpManager && (mcpConfigPath || pluginMcpSources.length > 0)) {
      if (mcpConfigPath && (backgroundPolicy || pluginMcpSources.length === 0)) {
        await mcpManager.loadConfig(mcpConfigPath);
      } else {
        await mcpManager.replaceSources([
          {
            id: "project",
            path: mcpConfigPath ?? join(workDir, ".pico", "mcp.json"),
            optional: mcpConfigPath === undefined,
          },
          ...pluginMcpSources,
        ]);
      }
      dependencies.mcpStatusSink?.(mcpManager.getStatusSnapshot());
      await mcpManager.connectAll();
      dependencies.mcpStatusSink?.(mcpManager.getStatusSnapshot());
      if (backgroundPolicy) {
        pruneRegistryToBackgroundAllowlist(registry, backgroundPolicy);
        const missingMcpTools = [...backgroundPolicy.allowedTools].filter(
          (tool) => isMcpToolName(tool) && registry.getTool(tool) === undefined,
        );
        if (missingMcpTools.length > 0) {
          throw new BackgroundPolicyViolationError(
            "mcp_unavailable",
            `后台 MCP 工具不可用: ${missingMcpTools.join(", ")}`,
          );
        }
      }
      dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));
    }
    if (effectiveOptions.allowedTools !== undefined) {
      pruneRegistryToCommandAllowlist(registry, effectiveOptions.allowedTools);
      dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));
    }

    return await session.serialize(async () => {
      dependencies.signal?.throwIfAborted();
      if (!resumeExistingSession) {
        const submittedPrompt = prompt;
        const submitDecision = await runtimeState.dispatchHook(
          "UserPromptSubmit",
          { prompt: submittedPrompt },
          { signal: dependencies.signal },
        );
        if (submitDecision.decision === "deny") {
          throw new Error(
            `UserPromptSubmit hook 阻断了输入: ${submitDecision.reason ?? "(无原因)"}`,
          );
        }
        prompt = normalizePrompt(applyPromptHookDecision(submittedPrompt, submitDecision));
        const expansionDecision = await runtimeState.dispatchHook(
          "UserPromptExpansion",
          {
            prompt: effectiveOptions.rewindPrompt ?? submittedPrompt,
            expandedPrompt: prompt,
          },
          { signal: dependencies.signal },
        );
        if (expansionDecision.decision === "deny") {
          throw new Error(
            `UserPromptExpansion hook 阻断了输入: ${expansionDecision.reason ?? "(无原因)"}`,
          );
        }
        prompt = normalizePrompt(applyPromptHookDecision(prompt, expansionDecision));
        const images: ImagePart[] | undefined =
          effectiveOptions.images ??
          (effectiveOptions.imagePath
            ? [loadImage(effectiveOptions.imagePath, workDir)]
            : undefined);
        const rewindPointId = await session.beginRewindPoint({
          userPrompt: effectiveOptions.rewindPrompt ?? prompt,
          ...(effectiveOptions.rewindTranscriptIndex !== undefined
            ? { transcriptIndex: effectiveOptions.rewindTranscriptIndex }
            : {}),
          ...(effectiveOptions.rewindInteractionMode !== undefined
            ? { interactionMode: effectiveOptions.rewindInteractionMode }
            : {}),
          ...(effectiveOptions.rewindPrePlanMode !== undefined
            ? { prePlanMode: effectiveOptions.rewindPrePlanMode }
            : {}),
        });
        const userReceipt = await session.commitMessageOnce(`user-message:${rewindPointId}`, {
          role: "user",
          content: prompt,
          ...(images ? { images } : {}),
        });
        await session.bindRewindPointSource(rewindPointId, userReceipt);
      }

      const messages = await engine.run(session, undefined, undefined, dependencies.signal);
      const result: RunAgentCliResult = {
        sessionId: session.id,
        sessionSelection,
        workDir,
        finalMessage: findFinalMessage(messages),
        usage: snapshotUsage(session),
        messages,
        ...(traceEnabled ? { tracePath: await findTracePath(workDir, session.id) } : {}),
      };

      dependencies.onEvent?.({
        type: "run.finished",
        sessionId: session.id,
        workDir,
        at: Date.now(),
      });
      return result;
    });
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
    dependencies.onEvent?.({
      type: "run.failed",
      sessionId: session.id,
      workDir,
      at: Date.now(),
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await bestEffortRuntimeCleanup("Session 组件 Hook", () =>
      cleanupRuntimeState?.clearComponentHooks(),
    );
    await bestEffortRuntimeCleanup("Registry Hook 事件", () =>
      cleanupRegistry?.drainHookEvents?.(),
    );
    await bestEffortRuntimeCleanup("MCP 状态订阅", () => unsubscribeMcpStatus?.());
    // 非 TUI 调用仍按轮关闭；TUI 注入的 manager 由宿主在退出时统一关闭。
    if (cleanupMcpManager && ownsMcpManager) {
      await bestEffortRuntimeCleanup("MCP manager", async () => {
        await cleanupMcpManager?.closeAll();
        if (cleanupMcpManager) {
          dependencies.mcpStatusSink?.(cleanupMcpManager.getStatusSnapshot());
        }
      });
    }
    if (ownsRuntimeState && cleanupRuntimeState) {
      await bestEffortRuntimeCleanup("SessionRuntime", () => cleanupRuntimeState?.dispose());
    }
    if (ownsPluginSnapshot) {
      await bestEffortRuntimeCleanup("Plugin runtime snapshot", () => pluginSnapshot.dispose());
    }
    await bestEffortRuntimeCleanup("Runtime usage ledger", () => ownedUsageStore?.close());
  }
}

async function bestEffortRuntimeCleanup(
  resource: string,
  cleanup: () => void | Promise<void> | undefined,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    logger.warn(
      { resource, error: error instanceof Error ? error.message : String(error) },
      "[Runtime] 资源释放失败",
    );
  }
}

function applyPromptHookDecision(
  prompt: string,
  decision: import("../hooks/types.js").HookOutput,
): string {
  let next = prompt;
  if (typeof decision.modifiedInput === "string") {
    next = decision.modifiedInput;
  } else if (
    typeof decision.modifiedInput === "object" &&
    decision.modifiedInput !== null &&
    "prompt" in decision.modifiedInput &&
    typeof Reflect.get(decision.modifiedInput, "prompt") === "string"
  ) {
    next = String(Reflect.get(decision.modifiedInput, "prompt"));
  }
  return decision.additionalContext ? `${next}\n\n${decision.additionalContext}` : next;
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
  });
}

async function prepareBackgroundExecution(
  execution: Extract<RuntimeExecution, { kind: "background" }>,
  workDir: string,
  options: RunAgentCliOptions,
  dependencies: RunAgentCliDependencies,
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
    trustStore: dependencies.backgroundTrustStore ?? new WorkspaceTrustStore(),
  });
}

function pruneRegistryToBackgroundAllowlist(
  registry: ToolRegistry,
  policy: PreparedBackgroundYoloPolicy,
): void {
  for (const tool of registry.getAvailableTools()) {
    if (!policy.allowedTools.has(tool.name)) registry.unregister(tool.name);
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
    if (!allowed.has(tool.name)) registry.unregister(tool.name);
  }
}

function createTrackedProviderWithFallback(
  kind: ProviderKind,
  config: ProviderConfig,
  providerFactory: RunAgentProviderFactory,
  session: Session,
  trackerOptions: CostTrackerOptions,
): LLMProvider {
  const fallbackModel = config.capabilities
    ? config.capabilities.fallbackModel
    : fallbackModelFor(config.model);
  if (!fallbackModel) {
    return new CostTracker(
      providerFactory(kind, config),
      trackingRoute(kind, config),
      session,
      trackerOptions,
    );
  }

  return new CostTrackedModelFallbackProvider(
    kind,
    config,
    fallbackModel,
    providerFactory,
    session,
    trackerOptions,
  );
}

/** @internal 保持计费路由的模型 fallback 包装器。 */
export class CostTrackedModelFallbackProvider implements LLMProvider {
  private readonly primaryProvider: LLMProvider;
  private fallbackProvider: LLMProvider | undefined;
  private fallbackSwitch: Promise<LLMProvider> | undefined;

  constructor(
    private readonly kind: ProviderKind,
    private readonly primaryConfig: ProviderConfig,
    private readonly fallbackModel: string,
    private readonly providerFactory: RunAgentProviderFactory,
    private readonly session: Session,
    private readonly trackerOptions: CostTrackerOptions = {},
  ) {
    this.primaryProvider = this.createTrackedProvider(primaryConfig);
  }

  get modelName(): string {
    if (this.fallbackProvider || this.fallbackSwitch) return this.fallbackModel;
    return this.primaryProvider.modelName ?? this.primaryConfig.model;
  }

  async generate(
    messages: Message[],
    availableTools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    const provider = await this.providerForRequest();
    try {
      return await provider.generate(messages, availableTools, options);
    } catch (err) {
      if (
        provider !== this.primaryProvider ||
        !isModelUnavailableError(err, this.primaryConfig.model)
      ) {
        throw err;
      }

      const fallback = await this.switchToFallback();
      return fallback.generate(messages, availableTools, options);
    }
  }

  async generateStream(
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: (delta: string) => void,
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    const provider = await this.providerForRequest();
    try {
      return await this.generateFrom(provider, messages, availableTools, onDelta, options);
    } catch (err) {
      if (
        provider !== this.primaryProvider ||
        !isModelUnavailableError(err, this.primaryConfig.model)
      ) {
        throw err;
      }

      const fallback = await this.switchToFallback();
      return this.generateFrom(fallback, messages, availableTools, onDelta, options);
    }
  }

  private providerForRequest(): Promise<LLMProvider> {
    if (this.fallbackSwitch) return this.fallbackSwitch;
    return Promise.resolve(this.primaryProvider);
  }

  private switchToFallback(): Promise<LLMProvider> {
    if (!this.fallbackSwitch) {
      console.warn(
        `[Provider] ${this.primaryConfig.model} 不可用,自动切换到 ${this.fallbackModel}`,
      );
      this.fallbackSwitch = Promise.resolve().then(() => {
        const provider = this.createTrackedProvider({
          ...this.primaryConfig,
          model: this.fallbackModel,
        });
        this.fallbackProvider = provider;
        return provider;
      });
    }
    return this.fallbackSwitch;
  }

  private generateFrom(
    provider: LLMProvider,
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: (delta: string) => void,
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    return provider.generateStream
      ? provider.generateStream(messages, availableTools, onDelta, options)
      : provider.generate(messages, availableTools, options);
  }

  private createTrackedProvider(config: ProviderConfig): LLMProvider {
    // A fallback model requires its own capability record. Until the router supplies one,
    // omit primary-model metadata instead of pretending both models share capabilities.
    const fallbackConfig =
      config.model === this.primaryConfig.model
        ? config
        : { ...config, capabilities: undefined, routeId: undefined };
    return new CostTracker(
      this.providerFactory(this.kind, fallbackConfig),
      trackingRoute(this.kind, fallbackConfig),
      this.session,
      this.trackerOptions,
    );
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

function buildCompactor(kind: ProviderKind, model: string): Compactor {
  const protocol = kind === "openai" ? "openai" : kind;
  const profile = resolveProviderProfile(protocol, model);
  const budget = createContextBudget(profile);
  return new Compactor({
    maxChars: estimateTokenBudgetAsChars(budget.inputBudgetTokens),
    retainLastMsgs: 6,
  });
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
          config.capabilities ?? resolveModelRouteCapabilities(kind, config.model, undefined),
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
): LLMProvider | undefined {
  const baseURL = env.AUX_LLM_BASE_URL;
  const apiKey = env.AUX_LLM_API_KEY;
  const model = env.AUX_LLM_MODEL;
  if (!baseURL || !apiKey || !model) return undefined;
  const kind = (env.AUX_LLM_PROVIDER as ProviderKind | undefined) ?? "openai";
  const config = { baseURL, apiKey, model };
  return new CostTracker(
    createProvider(kind, config),
    trackingRoute(kind, config),
    session,
    trackerOptions,
  );
}

function buildArtifactRuntime(
  workDir: string,
  sessionId: string,
): {
  observationProcessor: ToolObservationProcessor;
  subagentReportArtifactWriter: SubagentReportArtifactWriter;
} {
  const store = new ToolResultArtifactStore({
    baseDir: resolvePicoPaths(workDir).workspace.artifacts,
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
): MiddlewareFunc {
  const safety = buildForegroundSafetyMiddleware(workDir, settings, workspaceRoots);
  const permission = buildPermissionMiddleware(
    notifier,
    workDir,
    signal,
    approvalManager,
    settings,
    workspaceRoots,
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
    if (isHardlineCommand(call.name, call.arguments)) {
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
    );
    const hasExplicitSafetyGrant = globalSessionPermissionGrants.allowsSafetyOverride(
      sessionId,
      call,
      workDir,
      workspaceRoots,
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
    const result = await approvalManager.waitForApproval(
      `approval_${randomUUID()}`,
      call.name,
      call.arguments,
      notifier,
      diff,
      signal,
      { sessionScope: scope, providerCallId: call.id },
    );
    if (!result.allowed || !workspaceRoots || !settings) {
      return result.allowed ? result : { ...result, denialSource: "human" };
    }

    if (result.allowForSession) {
      await applySessionPermissionScope(scope, {
        sessionId,
        workDir,
        settings: settings as PermissionRuntimeSettings,
        workspaceRoots,
      });
      if (safetyPath !== undefined && externalScope?.type === "directories") {
        await applySessionPermissionScope(
          { ...externalScope, enableAutoEdits: false },
          {
            sessionId,
            workDir,
            settings: settings as PermissionRuntimeSettings,
            workspaceRoots,
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

/** A headless runtime never waits for an approval that no host can answer. */
const failClosedApprovalNotifier: ApprovalNotifier = (notice) => {
  queueMicrotask(() => {
    globalApprovalManager.resolveApproval(
      notice.taskId,
      false,
      "当前 Runtime Host 未提供审批交互，已安全拒绝。",
    );
  });
};

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

function trackingRoute(kind: ProviderKind, config: ProviderConfig): BillingRoute | string {
  const price = config.capabilities?.price;
  if (!config.capabilities) return config.model;
  return {
    provider: kind,
    model: config.model,
    baseUrl: config.baseURL,
    pricing:
      price?.source === "config"
        ? {
            inputPerMillion: price.inputPerMillion,
            outputPerMillion: price.outputPerMillion,
            cacheReadPerMillion: price.cacheReadPerMillion,
            cacheWritePerMillion: price.cacheWritePerMillion,
            source: "configured",
          }
        : null,
  };
}

function firstApiKey(value: string | undefined): string | undefined {
  return value
    ?.split(",")
    .map((key) => key.trim())
    .find(Boolean);
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

function findFinalMessage(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) === 0) {
      return message.content;
    }
  }

  return "";
}

function snapshotUsage(session: Session): RunAgentUsage {
  return {
    promptTokens: session.totalPromptTokens,
    completionTokens: session.totalCompletionTokens,
    costCNY: session.totalCostCNY,
  };
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "on";
}

async function findTracePath(workDir: string, sessionId: string): Promise<string | undefined> {
  const traceDir = resolvePicoPaths(workDir).workspace.traces;
  let files: string[];

  try {
    files = await readdir(traceDir);
  } catch {
    return undefined;
  }

  const prefix = `trace_${sanitizeTracePart(sessionId)}_`;
  const traceFile = files
    .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
    .sort()
    .at(-1);

  return traceFile ? join(traceDir, traceFile) : undefined;
}

function sanitizeTracePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
}
