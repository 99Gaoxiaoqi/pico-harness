import { mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentEngine } from "../engine/loop.js";
import { globalSessionManager, type Session } from "../engine/session.js";
import { TerminalReporter, type Reporter } from "../engine/reporter.js";
import { Compactor } from "../context/compactor.js";
import { FullCompactor } from "../context/full-compactor.js";
import { ToolResultArtifactStore } from "../context/artifact-store.js";
import { createContextBudget, estimateTokenBudgetAsChars } from "../context/context-budget.js";
import { PromptComposer } from "../context/composer.js";
import { SkillLoader, SkillViewTool } from "../context/skill.js";
import {
  createRawProvider,
  fallbackModelFor,
  isModelUnavailableError,
  type ProviderKind,
} from "../provider/factory.js";
import type { ProviderConfig } from "../provider/config.js";
import type { LLMProvider } from "../provider/interface.js";
import { resolveProviderProfile } from "../provider/profile.js";
import type { ThinkingEffort } from "../provider/thinking.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import {
  BashTool,
  ReadFileTool,
  ToolRegistry,
} from "../tools/registry-impl.js";
import { buildDefaultToolRegistry } from "../tools/default-registry.js";
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
import type { MiddlewareFunc } from "../tools/registry.js";
import { McpConnectionManager } from "../mcp/manager.js";
import { BackgroundManager } from "../tools/background-manager.js";

const cliBackgroundManager = new BackgroundManager();

export interface RunAgentCliOptions {
  prompt: string;
  dir?: string;
  session?: string;
  provider?: ProviderKind;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  enableThinking?: boolean;
  /** 模型原生思考强度(off/low/medium/high),控制 reasoning_effort / thinking.budget_tokens */
  thinkingEffort?: ThinkingEffort;
  planMode?: boolean;
  trace?: boolean;
  /** MCP 配置文件路径(--mcp-config)。提供则启动时连接所有 MCP server 并注册工具 */
  mcpConfigPath?: string;
}

export interface RunAgentUsage {
  promptTokens: number;
  completionTokens: number;
  costCNY: number;
}

export interface RunAgentCliResult {
  sessionId: string;
  workDir: string;
  finalMessage: string;
  usage: RunAgentUsage;
  messages: readonly Message[];
  tracePath?: string;
}

export type RunAgentEnv = Record<string, string | undefined>;
export type RunAgentWriter = (chunk: string) => Promise<void> | void;
export type RunAgentProviderFactory = (kind: ProviderKind, config: ProviderConfig) => LLMProvider;

export interface RunAgentCliDependencies {
  env?: RunAgentEnv;
  provider?: LLMProvider;
  providerFactory?: RunAgentProviderFactory;
  reporter?: Reporter;
  approvalNotifier?: ApprovalNotifier;
  write?: RunAgentWriter;
}

export async function runAgentFromCli(
  options: RunAgentCliOptions,
  dependencies: RunAgentCliDependencies = {},
): Promise<RunAgentCliResult> {
  const prompt = normalizePrompt(options.prompt);
  const kind = options.provider ?? "openai";
  const providerConfig = resolveProviderConfig(
    options,
    dependencies.env ?? process.env,
    dependencies.provider !== undefined,
  );
  const workDir = await resolveWorkDir(options.dir);
  const session = await globalSessionManager.getOrCreate(
    options.session ?? consoleSessionId(workDir),
    workDir,
  );
  const trackedProvider =
    dependencies.provider !== undefined
      ? new CostTracker(dependencies.provider, providerConfig.model, session)
      : createTrackedProviderWithFallback(
          kind,
          providerConfig,
          dependencies.providerFactory ?? createRawProvider,
          session,
        );
  const registry = buildRegistry(workDir);
  const observationProcessor = buildObservationProcessor(workDir);
  // 默认(非 Plan Mode)路径预组装 System Prompt:加载 AGENTS.md + Skills 清单,
  // 避免 loop.ts 退化到硬编码英文兜底。Plan Mode 下由 buildSystemPrompt() 每轮动态重组,故此处不传。
  const systemPrompt = options.planMode
    ? undefined
    : await new PromptComposer(workDir).build();
  const engine = new AgentEngine({
    provider: trackedProvider,
    registry,
    workDir,
    enableThinking: options.enableThinking ?? true,
    ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
    planMode: options.planMode ?? false,
    systemPrompt,
    compactor: buildCompactor(kind, providerConfig.model),
    // 模型摘要压缩:provider 存在即启用,作为字符级降级用尽后的最后防线
    fullCompactor: new FullCompactor({ provider: trackedProvider }),
    observationProcessor,
    reporter: dependencies.reporter ?? new TerminalReporter(),
    tracer: options.trace === true ? new Tracer() : undefined,
  });

  registry.use(buildApprovalMiddleware(dependencies.approvalNotifier ?? terminalNotifier));
  registerDelegationTools(registry, engine, workDir, await loadProfiles(workDir));

  // MCP 服务器:加载配置 → 并行连接 → 自动注册工具到 registry。
  // per-server 失败隔离,一个 server 挂了不影响其他。
  const mcpConfigPath = options.mcpConfigPath;
  const mcpManager = mcpConfigPath ? new McpConnectionManager(registry) : undefined;
  if (mcpManager && mcpConfigPath) {
    await mcpManager.loadConfig(mcpConfigPath);
    await mcpManager.connectAll();
  }

  try {
    session.append({ role: "user", content: prompt });

    const messages = await engine.run(session);
    const result: RunAgentCliResult = {
      sessionId: session.id,
      workDir,
      finalMessage: findFinalMessage(messages),
      usage: snapshotUsage(session),
      messages,
      ...(options.trace === true ? { tracePath: await findTracePath(workDir, session.id) } : {}),
    };

    await writeRunSummary(dependencies.write, result);

    return result;
  } finally {
    // 进程退出前优雅关闭所有 MCP 连接(杀子进程/关 HTTP 连接)
    if (mcpManager) {
      await mcpManager.closeAll();
    }
  }
}

function buildRegistry(
  workDir: string,
  backgroundManager: BackgroundManager = cliBackgroundManager,
): ToolRegistry {
  return buildDefaultToolRegistry(workDir, {
    truncateResults: false,
    backgroundManager,
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
  const protocol = kind === "claude" ? "claude" : "openai";
  const profile = resolveProviderProfile(protocol, model);
  const budget = createContextBudget(profile);
  return new Compactor({
    maxChars: estimateTokenBudgetAsChars(budget.inputBudgetTokens),
    retainLastMsgs: 6,
  });
}

function buildObservationProcessor(workDir: string) {
  const store = new ToolResultArtifactStore({
    baseDir: join(workDir, ".claw", "artifacts"),
  });
  return createToolResultObservationProcessor({ store });
}

function buildApprovalMiddleware(notifier: ApprovalNotifier): MiddlewareFunc {
  return async (call) => {
    return globalApprovalPolicy.decide("cli", call, () =>
      globalApprovalManager.waitForApproval(call.id, call.name, call.arguments, notifier),
    );
  };
}

const terminalNotifier: ApprovalNotifier = (notice) => {
  console.warn(`\n\x1b[31m[需要审批 TaskID: ${notice.taskId}]\x1b[0m ${notice.message}\n`);
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

function consoleSessionId(workDir: string): string {
  return `console:${workDir}`;
}

function defaultModel(kind: ProviderKind): string {
  return kind === "openai" ? "glm-5.2" : "claude-3-5-sonnet";
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

async function writeRunSummary(
  write: RunAgentWriter | undefined,
  result: RunAgentCliResult,
): Promise<void> {
  const emit =
    write ??
    ((chunk: string) => {
      process.stdout.write(chunk);
    });
  const lines = [
    "",
    `Session: ${result.sessionId}`,
    `WorkDir: ${result.workDir}`,
    `Final: ${result.finalMessage}`,
    `Usage: input ${result.usage.promptTokens} tk, output ${result.usage.completionTokens} tk, ¥${result.usage.costCNY.toFixed(6)}`,
    ...(result.tracePath ? [`Trace: ${result.tracePath}`] : []),
  ];

  await emit(`${lines.join("\n")}\n`);
}
