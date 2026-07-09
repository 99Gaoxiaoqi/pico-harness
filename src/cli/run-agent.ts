import { mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentEngine } from "../engine/loop.js";
import { GoalManager } from "../engine/goal-manager.js";
import { SteerQueue } from "../engine/steer-queue.js";
import { globalSessionManager, type Session } from "../engine/session.js";
import { TerminalReporter, type Reporter } from "../engine/reporter.js";
import { Compactor } from "../context/compactor.js";
import { FullCompactor } from "../context/full-compactor.js";
import { ToolResultArtifactStore } from "../context/artifact-store.js";
import { createContextBudget, estimateTokenBudgetAsChars } from "../context/context-budget.js";
import { PromptComposer } from "../context/composer.js";
import { SkillLoader, SkillViewTool } from "../context/skill.js";
import { TodoStore } from "../context/todo-store.js";
import { ToolDisclosure } from "../tools/tool-disclosure.js";
import {
  createProvider,
  createRawProvider,
  getCredentialPool,
  type ProviderKind,
} from "../provider/factory.js";
import { fallbackModelFor, isModelUnavailableError } from "../provider/fallback.js";
import type { ProviderConfig } from "../provider/config.js";
import type { LLMProvider } from "../provider/interface.js";
import { resolveProviderProfile } from "../provider/profile.js";
import type { ThinkingEffort } from "../provider/thinking.js";
import type { ImagePart, Message, ToolDefinition } from "../schema/message.js";
import { BashTool, ReadFileTool, ToolRegistry } from "../tools/registry-impl.js";
import { buildDefaultToolRegistry } from "../tools/default-registry.js";
import { ExitPlanModeTool } from "../tools/plan-exit.js";
import { DelegationManager, DelegateStatusTool } from "../tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../tools/delegation-registry.js";
import { AgentProfileLoader, type AgentProfile } from "../tools/agent-profile.js";
import { DelegateTaskTool, SpawnSubagentTool } from "../tools/subagent.js";
import { createToolResultObservationProcessor } from "../tools/tool-result-observation.js";
import { CostTracker } from "../observability/tracker.js";
import { Tracer } from "../observability/trace.js";
import {
  globalApprovalManager,
  globalApprovalPolicy,
  type ApprovalNotifier,
} from "../approval/manager.js";
import { computeApprovalDiff } from "../approval/diff.js";
import { formatApprovalPanel } from "../tui/approval-panel.js";
import type { MiddlewareFunc } from "../tools/registry.js";
import { McpConnectionManager, type McpStatusSnapshot } from "../mcp/manager.js";
import { BackgroundManager } from "../tools/background-manager.js";
import { loadHooksConfig } from "../hooks/config.js";
import { HookRunner } from "../hooks/runner.js";
import { getOrCreateSessionSettings } from "../input/session-settings.js";
import { loadImage } from "../input/prepare-prompt.js";
import { resolveCliSession, type CliSessionSelection } from "./session-resolver.js";

const cliBackgroundManager = new BackgroundManager();

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
  enableThinking?: boolean;
  /** Native model thinking effort: off/low/medium/high. */
  thinkingEffort?: ThinkingEffort;
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
  mcpStatusSink?: (snapshot: McpStatusSnapshot) => void;
}

export async function runAgentFromCli(
  options: RunAgentCliOptions,
  dependencies: RunAgentCliDependencies = {},
): Promise<RunAgentCliResult> {
  const prompt = normalizePrompt(options.prompt);
  const kind = options.provider ?? "openai";
  const workDir = await resolveWorkDir(options.dir);
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
    permissionMode: "ask",
  });
  const traceEnabled =
    options.trace === true || isTruthyEnv((dependencies.env ?? process.env).PICO_TRACE);
  const effectiveOptions: RunAgentCliOptions = {
    ...options,
    dir: workDir,
    session: sessionSelection.sessionId,
    sessionSelection,
    model: options.model ?? settings.model,
    trace: traceEnabled,
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
  // 凭证轮换(4.2):多 key 时从池取首个 key 覆盖 config.apiKey,并构建轮换回调。
  // 单 key / 注入 provider 时跳过(向后兼容)。pool 注入点集中在此,便于追踪 currentKey。
  const credentialPool = getCredentialPool();
  let currentConfig: ProviderConfig = providerConfig;
  let rebuildProvider: (() => LLMProvider | undefined) | undefined;
  if (credentialPool && credentialPool.size > 1 && dependencies.provider === undefined) {
    currentConfig = { ...providerConfig, apiKey: credentialPool.getNext() };
  }
  const trackedProvider =
    dependencies.provider !== undefined
      ? new CostTracker(dependencies.provider, providerConfig.model, session)
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
      const nextKey = credentialPool.getNext();
      if (nextKey === currentConfig.apiKey) {
        // 轮换无可用 key(全限流兜底返回同 key)→ 交给 retry 层指数退避
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
  // GoalManager 单例:registry(3 工具)与 engine(prompt 注入 + Grace Call)共享同一实例,
  // 确保工具改的状态引擎侧立即可见。
  const goalManager = new GoalManager();
  // TodoTool and PromptComposer must share one store so todo context stays current.
  const todoStore = new TodoStore(workDir);
  // search_tools and engine tool selection share disclosure state across turns.
  const toolDisclosure = dependencies.toolDisclosure ?? new ToolDisclosure();
  const registry = buildRegistry(
    workDir,
    cliBackgroundManager,
    goalManager,
    todoStore,
    toolDisclosure,
  );
  // 【任务 2.6】用户可配置 Shell Hooks:加载 .claw/settings.json 的 hooks 配置,
  // 存在则挂载 HookRunner 到 registry。fail-open:配置缺失/畸形均不启用 hook,零影响。
  registry.setSessionId?.(session.id);
  const hooksConfig = await loadHooksConfig(workDir);
  if (hooksConfig) {
    registry.setHookRunner?.(new HookRunner(workDir, hooksConfig));
  }
  const observationProcessor = buildObservationProcessor(workDir);
  // Inject steer text before the first turn can read it.
  const steerQueue = new SteerQueue();
  if (options.steer) {
    steerQueue.push(options.steer);
  }
  // 默认(非 Plan Mode)路径预组装 System Prompt:加载 AGENTS.md + Skills 清单 + Goal 状态,
  // 避免 loop.ts 退化到硬编码英文兜底。Plan Mode 下由 buildSystemPrompt() 每轮动态重组,故此处不传。
  const systemPrompt = options.planMode
    ? undefined
    : await new PromptComposer(workDir, false, { goalManager, todoStore }).build();
  // 辅助(廉价)模型:用于 FullCompactor 生成摘要,省主模型成本。
  // 配齐 AUX_LLM_BASE_URL / AUX_LLM_API_KEY / AUX_LLM_MODEL 才启用;缺则用主 provider。
  const auxProvider = loadAuxProvider(dependencies.env ?? process.env);
  const engine = new AgentEngine({
    provider: trackedProvider,
    registry,
    workDir,
    enableThinking: effectiveOptions.enableThinking ?? true,
    ...(effectiveOptions.thinkingEffort !== undefined
      ? { thinkingEffort: effectiveOptions.thinkingEffort }
      : {}),
    planMode: effectiveOptions.planMode ?? false,
    systemPrompt,
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
    reporter: dependencies.reporter ?? new TerminalReporter(),
    tracer: traceEnabled ? new Tracer() : undefined,
    steerQueue,
    ...(rebuildProvider ? { rebuildProvider } : {}),
  });

  registry.use(buildApprovalMiddleware(dependencies.approvalNotifier ?? terminalNotifier, workDir));
  registerDelegationTools(registry, engine, workDir, await loadProfiles(workDir));

  // 3.6 Plan Review:把 ExitPlanModeTool 的退出回调接到 engine.exitPlanMode,
  // 并把审批通知路由到 host 注入的 notifier,使审批通过后真正切换 planMode。
  const notifier = dependencies.approvalNotifier ?? terminalNotifier;
  const exitTool = registry.getTool("exit_plan_mode");
  if (exitTool instanceof ExitPlanModeTool) {
    exitTool.setExitCallback(() => engine.exitPlanMode());
    exitTool.setNotify(notifier);
  }

  // MCP 服务器:加载配置 → 并行连接 → 自动注册工具到 registry。
  // per-server 失败隔离,一个 server 挂了不影响其他。
  const mcpConfigPath = options.mcpConfigPath;
  const mcpManager = mcpConfigPath
    ? new McpConnectionManager(registry, { stdioCwd: workDir })
    : undefined;
  if (mcpManager && mcpConfigPath) {
    await mcpManager.loadConfig(mcpConfigPath);
    dependencies.mcpStatusSink?.(mcpManager.getStatusSnapshot());
    await mcpManager.connectAll();
    dependencies.mcpStatusSink?.(mcpManager.getStatusSnapshot());
  }

  try {
    return await session.serialize(async () => {
      const images: ImagePart[] | undefined =
        effectiveOptions.images ??
        (effectiveOptions.imagePath ? [loadImage(effectiveOptions.imagePath, workDir)] : undefined);
      session.append({
        role: "user",
        content: prompt,
        ...(images ? { images } : {}),
      });

      const messages = await engine.run(session);
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
    // Close MCP connections and child processes before returning.
    if (mcpManager) {
      await mcpManager.closeAll();
      dependencies.mcpStatusSink?.(mcpManager.getStatusSnapshot());
    }
  }
}

function buildRegistry(
  workDir: string,
  backgroundManager: BackgroundManager = cliBackgroundManager,
  goalManager?: GoalManager,
  todoStore?: TodoStore,
  toolDisclosure?: ToolDisclosure,
): ToolRegistry {
  return buildDefaultToolRegistry(workDir, {
    truncateResults: false,
    backgroundManager,
    ...(goalManager !== undefined ? { goalManager } : {}),
    ...(todoStore !== undefined ? { todoStore } : {}),
    ...(toolDisclosure !== undefined ? { toolDisclosure } : {}),
  });
}

function createTrackedProviderWithFallback(
  kind: ProviderKind,
  config: ProviderConfig,
  providerFactory: RunAgentProviderFactory,
  session: Session,
): LLMProvider {
  const fallbackModel = fallbackModelFor(config.model);
  if (!fallbackModel) {
    return new CostTracker(providerFactory(kind, config), config.model, session);
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

  async generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message> {
    try {
      return await this.activeProvider.generate(messages, availableTools);
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
      return this.activeProvider.generate(messages, availableTools);
    }
  }

  private createTrackedProvider(config: ProviderConfig): LLMProvider {
    return new CostTracker(this.providerFactory(this.kind, config), config.model, this.session);
  }
}

function buildReadOnlyRegistry(workDir: string): ToolRegistry {
  const registry = new ToolRegistry({ truncateResults: false });
  registry.register(new ReadFileTool(workDir));
  registry.register(new BashTool(workDir, undefined, { allowBackground: false }));
  registry.register(new SkillViewTool(new SkillLoader(workDir)));
  return registry;
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
): void {
  const manager = new DelegationManager();
  const registryFactory = createSubagentRegistryFactory({
    workDir,
    runner: engine,
    manager,
    ...(profiles.length > 0 ? { profiles } : {}),
  });
  registry.register(
    new DelegateTaskTool(engine, registryFactory, manager, {
      ...(profiles.length > 0 ? { profiles } : {}),
    }),
  );
  registry.register(new DelegateStatusTool(manager));
  registry.register(new SpawnSubagentTool(engine, buildReadOnlyRegistry(workDir)));
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

function buildApprovalMiddleware(notifier: ApprovalNotifier, workDir: string): MiddlewareFunc {
  return async (call) => {
    return globalApprovalPolicy.decide("cli", call, async () => {
      // 拦截时计算 before/after diff,失败返回 undefined 不阻断审批
      const diff = await computeApprovalDiff(call.name, call.arguments, workDir);
      return globalApprovalManager.waitForApproval(
        call.id,
        call.name,
        call.arguments,
        notifier,
        diff,
      );
    });
  };
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
  const apiKey = options.apiKey ?? env.LLM_API_KEY;
  const model = options.model ?? env.LLM_MODEL ?? defaultModel(options.provider ?? "openai");

  if (!allowMissingNetworkConfig && (!baseURL || !apiKey)) {
    throw new Error("缺少 Provider 配置:请提供 LLM_BASE_URL / LLM_API_KEY 或对应 CLI 参数");
  }

  return {
    baseURL: baseURL ?? "",
    apiKey: apiKey ?? "",
    model,
    ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
  };
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
