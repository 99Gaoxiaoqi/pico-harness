import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentEngine } from "../engine/loop.js";
import type { GoalManager } from "../engine/goal-manager.js";
import { globalSessionManager, type Session } from "../engine/session.js";
import { TerminalReporter, type Reporter } from "../engine/reporter.js";
import { Compactor } from "../context/compactor.js";
import { FullCompactor } from "../context/full-compactor.js";
import { ToolResultArtifactStore } from "../context/artifact-store.js";
import { createContextBudget, estimateTokenBudgetAsChars } from "../context/context-budget.js";
import { PromptComposer } from "../context/composer.js";
import type { TodoStore } from "../context/todo-store.js";
import { ToolDisclosure } from "../tools/tool-disclosure.js";
import {
  createProvider,
  createRawProvider,
  getCredentialPool,
  type ProviderKind,
} from "../provider/factory.js";
import { fallbackModelFor, isModelUnavailableError } from "../provider/fallback.js";
import type { ProviderConfig } from "../provider/config.js";
import type { LLMProvider, LLMProviderRequestOptions } from "../provider/interface.js";
import { resolveProviderProfile } from "../provider/profile.js";
import type { ImagePart, Message, ToolDefinition } from "../schema/message.js";
import { ToolRegistry } from "../tools/registry-impl.js";
import { buildDefaultToolRegistry } from "../tools/default-registry.js";
import type { AskUserHandler } from "../tools/ask-user.js";
import { WorkspaceRoots, workspaceAccessesFromCall } from "../tools/workspace-roots.js";
import { ExitPlanModeTool } from "../tools/plan-exit.js";
import { DelegationManager, DelegateStatusTool } from "../tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../tools/delegation-registry.js";
import { AgentProfileLoader, type AgentProfile } from "../tools/agent-profile.js";
import { DelegateTaskTool, SpawnSubagentTool } from "../tools/subagent.js";
import { createToolResultObservationProcessor } from "../tools/tool-result-observation.js";
import { CostTracker } from "../observability/tracker.js";
import type { BillingRoute } from "../observability/pricing.js";
import type { ModelRouteCapabilities } from "../provider/model-capabilities.js";
import { Tracer } from "../observability/trace.js";
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
import { formatApprovalPanel } from "../tui/approval-panel.js";
import { createTuiRuntimeState, type TuiRuntimeState } from "../tui/runtime-state.js";
import type { MiddlewareFunc } from "../tools/registry.js";
import { McpConnectionManager, type McpStatusSnapshot } from "../mcp/manager.js";
import { isMcpToolName } from "../mcp/types.js";
import { BackgroundManager } from "../tools/background-manager.js";
import { loadHooksConfig } from "../hooks/config.js";
import { HookRunner } from "../hooks/runner.js";
import {
  getOrCreateSessionSettings,
  exitSessionPlanMode,
  setSessionAdditionalDirectories,
  toolStatusFromRegistry,
  type SessionToolStatus,
  type SessionSettings,
} from "../input/session-settings.js";
import { loadPicoConfig } from "../input/pico-config.js";
import { loadImage } from "../input/prepare-prompt.js";
import type { YoloSandboxConfig } from "../safety/yolo-sandbox.js";
import { resolveCliSession, type CliSessionSelection } from "./session-resolver.js";
import type { WorktreeSupervisor } from "../tasks/worktree-supervisor.js";

export interface RunAgentCliOptions {
  prompt: string;
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
  /** TUI 中用户实际发送的文本，用作 /rewind 的可见名称。 */
  rewindPrompt?: string;
  /** 用户消息写入可见 transcript 前的条目下标。 */
  rewindTranscriptIndex?: number;
  /** 宿主可选记录该消息发送时的交互模式。 */
  rewindInteractionMode?: string;
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

export interface RunAgentCliDependencies {
  env?: RunAgentEnv;
  provider?: LLMProvider;
  providerFactory?: RunAgentProviderFactory;
  reporter?: Reporter;
  approvalNotifier?: ApprovalNotifier;
  toolDisclosure?: ToolDisclosure;
  /** Session-scoped services owned by the TUI host and reused across prompts. */
  runtimeState?: TuiRuntimeState;
  /** 仅由可展示结构化问题的 TUI bundle 提供。 */
  askUserHandler?: AskUserHandler;
  /** Receives the complete registry after late delegation/MCP registration. */
  toolStatusSink?: (tools: readonly SessionToolStatus[]) => void;
  mcpStatusSink?: (snapshot: McpStatusSnapshot) => void;
  /** TUI 宿主持有的 MCP manager；注入时本轮只换 registry，不重连或关闭 server。 */
  mcpManager?: McpConnectionManager;
  /** 宿主本轮运行的中止信号。 */
  signal?: AbortSignal;
}

export async function runAgentFromCli(
  options: RunAgentCliOptions,
  dependencies: RunAgentCliDependencies = {},
): Promise<RunAgentCliResult> {
  dependencies.signal?.throwIfAborted();
  const prompt = normalizePrompt(options.prompt);
  const kind = options.provider ?? "openai";
  const workDir = await resolveWorkDir(options.dir);
  const picoConfig = await loadPicoConfig(workDir);
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
  const settings = getOrCreateSessionSettings({
    sessionId: sessionSelection.sessionId,
    cwd: workDir,
    provider: kind,
    model: defaultConfigModel,
    ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
  });
  const workspaceRoots = await WorkspaceRoots.create(workDir, [
    ...configuredAdditionalDirectories,
    ...(options.addDirs ?? []),
    ...settings.additionalDirectories,
  ]);
  setSessionAdditionalDirectories(settings, workspaceRoots.list().slice(1));
  const traceEnabled =
    options.trace === true || isTruthyEnv((dependencies.env ?? process.env).PICO_TRACE);
  const effectiveOptions: RunAgentCliOptions = {
    ...options,
    dir: workDir,
    session: sessionSelection.sessionId,
    sessionSelection,
    model: options.model ?? settings.model,
    planMode: options.planMode ?? settings.mode === "plan",
    trace: traceEnabled,
    addDirs: [...settings.additionalDirectories],
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
  const session = await globalSessionManager.getOrCreate(sessionSelection.sessionId, workDir);
  if (sessionSelection.mode === "fork" && sessionSelection.sourceSessionId) {
    await seedForkedSession(session, sessionSelection.sourceSessionId, workDir);
  }
  const ownsRuntimeState = dependencies.runtimeState === undefined;
  const runtimeState =
    dependencies.runtimeState ??
    (await createTuiRuntimeState({
      workDir,
      sessionId: session.id,
      session,
      ...(dependencies.toolDisclosure !== undefined
        ? { toolDisclosure: dependencies.toolDisclosure }
        : {}),
      lspServers: picoConfig.lspServers,
    }));
  runtimeState.assertCompatible(workDir, session.id);
  if (
    dependencies.toolDisclosure !== undefined &&
    dependencies.toolDisclosure !== runtimeState.toolDisclosure
  ) {
    throw new Error("runtimeState.toolDisclosure must match dependencies.toolDisclosure");
  }
  // 凭证轮换(4.2):多 key 时从池取首个 key 覆盖 config.apiKey,并构建轮换回调。
  // 单 key / 注入 provider 时跳过(向后兼容)。pool 注入点集中在此,便于追踪 currentKey。
  const credentialPool = options.apiKey === undefined ? getCredentialPool() : undefined;
  let currentConfig: ProviderConfig = providerConfig;
  let rebuildProvider: (() => LLMProvider | undefined) | undefined;
  if (credentialPool && credentialPool.size > 1 && dependencies.provider === undefined) {
    currentConfig = { ...providerConfig, apiKey: credentialPool.getNext() };
  }
  const trackedProvider =
    dependencies.provider !== undefined
      ? new CostTracker(dependencies.provider, trackingRoute(kind, providerConfig), session)
      : effectiveOptions.allowModelFallback === false
        ? new CostTracker(
            (dependencies.providerFactory ?? createRawProvider)(kind, currentConfig),
            trackingRoute(kind, currentConfig),
            session,
          )
        : createTrackedProviderWithFallback(
            kind,
            currentConfig,
            dependencies.providerFactory ?? createRawProvider,
            session,
          );
  if (credentialPool && credentialPool.size > 1 && dependencies.provider === undefined) {
    rebuildProvider = (): LLMProvider | undefined => {
      // 标记当前 key 限流 → 取下一个可用 key → 重建整条包装链
      credentialPool.markRateLimited(currentConfig.apiKey);
      const nextKey = credentialPool.getNextAvailable();
      if (!nextKey || nextKey === currentConfig.apiKey) {
        // 轮换无可用 key(所有 key cooling)→ 交给 retry 层指数退避
        return undefined;
      }
      currentConfig = { ...currentConfig, apiKey: nextKey };
      return createTrackedProviderWithFallback(
        kind,
        currentConfig,
        dependencies.providerFactory ?? createRawProvider,
        session,
      );
    };
  }
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
  );
  // 【任务 2.6】用户可配置 Shell Hooks:加载 .claw/settings.json 的 hooks 配置,
  // 存在则挂载 HookRunner 到 registry。fail-open:配置缺失/畸形均不启用 hook,零影响。
  registry.setSessionId?.(session.id);
  const hooksConfig = await loadHooksConfig(workDir);
  if (hooksConfig) {
    registry.setHookRunner?.(new HookRunner(workDir, hooksConfig));
  }
  const observationProcessor = buildObservationProcessor(workDir);
  // Inject steer text into the session-scoped queue before the next provider turn.
  const steerQueue = runtimeState.steerQueue;
  if (options.steer) {
    steerQueue.push(options.steer);
  }
  const systemPromptFactory = (): Promise<string> =>
    new PromptComposer(workDir, effectiveOptions.planMode ?? false, {
      sessionId: session.id,
      skillRegistry: runtimeState.skillRegistry,
      ...(runtimeState.memoryNudger !== undefined
        ? { memoryNudger: runtimeState.memoryNudger }
        : {}),
      goalManager,
      todoStore,
    }).build(runtimeState.conversationTurnCount(session));
  // 辅助(廉价)模型:用于 FullCompactor 生成摘要,省主模型成本。
  // 配齐 AUX_LLM_BASE_URL / AUX_LLM_API_KEY / AUX_LLM_MODEL 才启用;缺则用主 provider。
  const auxProvider = loadAuxProvider(dependencies.env ?? process.env);
  const reporter = dependencies.reporter ?? new TerminalReporter();
  const engine = new AgentEngine({
    provider: trackedProvider,
    registry,
    workDir,
    workspaceRoots,
    ...(effectiveOptions.thinkingEffort !== undefined
      ? { thinkingEffort: effectiveOptions.thinkingEffort }
      : {}),
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
    observationProcessor,
    reporter,
    tracer: traceEnabled ? new Tracer() : undefined,
    steerQueue,
    ...(rebuildProvider ? { rebuildProvider } : {}),
  });

  registry.use(
    buildApprovalMiddleware(
      dependencies.approvalNotifier ?? terminalNotifier,
      workDir,
      dependencies.signal,
      globalApprovalManager,
      settings,
      workspaceRoots,
    ),
  );
  registerDelegationTools(
    registry,
    engine,
    workDir,
    await loadProfiles(workDir),
    delegationManager,
    workspaceRoots,
    // 主会话的 mode 只控制主 Agent 权限。worker/explore 是独立的不可信执行边界，
    // 必须始终使用 worktree + OS 沙箱，不得因 default/auto 模式退化为无沙箱 Bash。
    { config: picoConfig.sandbox },
    runtimeState.taskHostRuntime?.supervisor,
    reporter,
  );
  dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));

  // 3.6 Plan Review:把 ExitPlanModeTool 的退出回调接到 engine.exitPlanMode,
  // 并把审批通知路由到 host 注入的 notifier,使审批通过后真正切换 planMode。
  const notifier = dependencies.approvalNotifier ?? terminalNotifier;
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
  const mcpConfigPath = options.mcpConfigPath;
  const ownsMcpManager = dependencies.mcpManager === undefined;
  const mcpManager =
    dependencies.mcpManager ??
    (mcpConfigPath ? new McpConnectionManager(registry, { stdioCwd: workDir }) : undefined);
  const unsubscribeMcpStatus =
    mcpManager && dependencies.mcpStatusSink
      ? mcpManager.subscribe(dependencies.mcpStatusSink)
      : undefined;
  if (mcpManager && !ownsMcpManager) {
    mcpManager.attachRegistry(registry);
    dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));
  } else if (mcpManager && mcpConfigPath) {
    await mcpManager.loadConfig(mcpConfigPath);
    dependencies.mcpStatusSink?.(mcpManager.getStatusSnapshot());
    await mcpManager.connectAll();
    dependencies.mcpStatusSink?.(mcpManager.getStatusSnapshot());
    dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));
  }

  try {
    return await session.serialize(async () => {
      dependencies.signal?.throwIfAborted();
      const images: ImagePart[] | undefined =
        effectiveOptions.images ??
        (effectiveOptions.imagePath ? [loadImage(effectiveOptions.imagePath, workDir)] : undefined);
      await session.beginRewindPoint({
        userPrompt: effectiveOptions.rewindPrompt ?? prompt,
        ...(effectiveOptions.rewindTranscriptIndex !== undefined
          ? { transcriptIndex: effectiveOptions.rewindTranscriptIndex }
          : {}),
        ...(effectiveOptions.rewindInteractionMode !== undefined
          ? { interactionMode: effectiveOptions.rewindInteractionMode }
          : {}),
      });
      session.append({
        role: "user",
        content: prompt,
        ...(images ? { images } : {}),
      });

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

      return result;
    });
  } finally {
    unsubscribeMcpStatus?.();
    // 非 TUI 调用仍按轮关闭；TUI 注入的 manager 由宿主在退出时统一关闭。
    if (mcpManager && ownsMcpManager) {
      await mcpManager.closeAll();
      dependencies.mcpStatusSink?.(mcpManager.getStatusSnapshot());
    }
    if (ownsRuntimeState) {
      await runtimeState.dispose();
    }
  }
}

function buildRegistry(
  workDir: string,
  backgroundManager: BackgroundManager,
  goalManager?: GoalManager,
  todoStore?: TodoStore,
  toolDisclosure?: ToolDisclosure,
  workspaceRoots?: WorkspaceRoots,
  askUserHandler?: AskUserHandler,
  codeIntelligence?: TuiRuntimeState["codeIntelligence"],
  excludeSensitiveGrepFiles?: boolean | ((path: string | undefined) => boolean),
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
  });
}

function createTrackedProviderWithFallback(
  kind: ProviderKind,
  config: ProviderConfig,
  providerFactory: RunAgentProviderFactory,
  session: Session,
): LLMProvider {
  const fallbackModel = config.capabilities
    ? config.capabilities.fallbackModel
    : fallbackModelFor(config.model);
  if (!fallbackModel) {
    return new CostTracker(providerFactory(kind, config), trackingRoute(kind, config), session);
  }

  return new CostTrackedModelFallbackProvider(
    kind,
    config,
    fallbackModel,
    providerFactory,
    session,
  );
}

class CostTrackedModelFallbackProvider implements LLMProvider {
  private activeProvider: LLMProvider;
  private activeModel: string;
  private switched = false;

  constructor(
    private readonly kind: ProviderKind,
    private readonly primaryConfig: ProviderConfig,
    private readonly fallbackModel: string,
    private readonly providerFactory: RunAgentProviderFactory,
    private readonly session: Session,
  ) {
    this.activeModel = primaryConfig.model;
    this.activeProvider = this.createTrackedProvider(primaryConfig);
  }

  async generate(
    messages: Message[],
    availableTools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    try {
      return await this.activeProvider.generate(messages, availableTools, options);
    } catch (err) {
      if (this.switched || !isModelUnavailableError(err, this.activeModel)) {
        throw err;
      }

      console.warn(`[Provider] ${this.activeModel} 不可用,自动切换到 ${this.fallbackModel}`);
      this.activeModel = this.fallbackModel;
      this.activeProvider = this.createTrackedProvider({
        ...this.primaryConfig,
        model: this.fallbackModel,
      });
      this.switched = true;
      return this.activeProvider.generate(messages, availableTools, options);
    }
  }

  async generateStream(
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: (delta: string) => void,
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    try {
      if (this.activeProvider.generateStream) {
        return await this.activeProvider.generateStream(messages, availableTools, onDelta, options);
      }
      return await this.activeProvider.generate(messages, availableTools, options);
    } catch (err) {
      if (this.switched || !isModelUnavailableError(err, this.activeModel)) {
        throw err;
      }

      console.warn(`[Provider] ${this.activeModel} 不可用,自动切换到 ${this.fallbackModel}`);
      this.activeModel = this.fallbackModel;
      this.activeProvider = this.createTrackedProvider({
        ...this.primaryConfig,
        model: this.fallbackModel,
      });
      this.switched = true;
      if (this.activeProvider.generateStream) {
        return this.activeProvider.generateStream(messages, availableTools, onDelta, options);
      }
      return this.activeProvider.generate(messages, availableTools, options);
    }
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
    );
  }
}

/** 加载工作区的自定义子代理角色(.claw/agents.yaml)。失败静默返回空。 */
async function loadProfiles(workDir: string): Promise<AgentProfile[]> {
  try {
    return await new AgentProfileLoader(workDir).load();
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
  worktreeSupervisor?: WorktreeSupervisor,
  reporter?: Reporter,
): void {
  const registryFactory = createSubagentRegistryFactory({
    workDir,
    workspaceRoots,
    runner: engine,
    manager,
    yoloSandbox,
    ...(worktreeSupervisor ? { worktreeSupervisor } : {}),
    ...(profiles.length > 0 ? { profiles } : {}),
  });
  registry.register(
    new DelegateTaskTool(engine, registryFactory, manager, {
      ...(profiles.length > 0 ? { profiles } : {}),
      ...(worktreeSupervisor ? { worktreeSupervisor } : {}),
      ...(reporter ? { reporter } : {}),
    }),
  );
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

/**
 * 加载辅助(廉价)模型 provider,供 FullCompactor 生成摘要。
 * 配齐 AUX_LLM_BASE_URL / AUX_LLM_API_KEY / AUX_LLM_MODEL 三项才启用;
 * 缺任意一项则返回 undefined(FullCompactor 回退到主 provider)。
 */
function loadAuxProvider(env: RunAgentEnv): LLMProvider | undefined {
  const baseURL = env.AUX_LLM_BASE_URL;
  const apiKey = env.AUX_LLM_API_KEY;
  const model = env.AUX_LLM_MODEL;
  if (!baseURL || !apiKey || !model) return undefined;
  const kind = (env.AUX_LLM_PROVIDER as ProviderKind | undefined) ?? "openai";
  return createProvider(kind, { baseURL, apiKey, model });
}

function buildObservationProcessor(workDir: string) {
  const store = new ToolResultArtifactStore({
    baseDir: join(workDir, ".claw", "artifacts"),
  });
  return createToolResultObservationProcessor({ store });
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

    const sessionId = settings?.sessionId ?? "cli";
    const workspaceAccesses = workspaceAccessesFromCall(call);

    // 主 TUI 的 YOLO 是全程放权：普通工具不审批，也不施加工作区、网络或
    // 敏感写沙箱。直接文件工具仍需给自身的 WorkspaceRoots 一次性通行证；
    // worker 使用独立 registry/worktree，继续保留显式沙箱隔离。
    if (mode === "yolo") {
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
      hasSessionGrant &&
      externalDirectories.length === 0 &&
      (safetyPath === undefined || hasExplicitSafetyGrant)
    ) {
      return { allowed: true, reason: "本会话结构化权限规则放行" };
    }

    const needsApproval =
      safetyPath !== undefined ||
      externalDirectories.length > 0 ||
      bashNeedsApproval(call) ||
      isMcpToolName(call.name) ||
      (mode === "default" && isAgentOpsDangerousCommand(call.name, call.arguments)) ||
      (mode === "auto" && isDangerousCommand(call.name, call.arguments));
    if (!needsApproval) return { allowed: true, reason: `${mode} 模式自动放行` };

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
    if (!result.allowed || !workspaceRoots || !settings) return result;

    if (result.allowForSession) {
      await applySessionPermissionScope(scope, {
        sessionId,
        settings: settings as PermissionRuntimeSettings,
        workspaceRoots,
      });
      if (safetyPath !== undefined && externalScope?.type === "directories") {
        await applySessionPermissionScope(
          { ...externalScope, enableAutoEdits: false },
          {
            sessionId,
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

const terminalNotifier: ApprovalNotifier = (notice) => {
  console.warn(`\n${formatApprovalPanel(notice)}\n`);
};

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

async function seedForkedSession(
  target: Session,
  sourceSessionId: string,
  workDir: string,
): Promise<void> {
  if (target.length > 0) return;

  const source = await globalSessionManager.getOrCreate(sourceSessionId, workDir);
  const history = source.getHistory();
  if (history.length === 0) return;

  target.append(...history);
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
  const traceDir = join(workDir, ".claw", "traces");
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
