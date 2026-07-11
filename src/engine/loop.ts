// 核心心脏:Agent 的 Main Loop (ReAct 循环)。
// 经第 02/03/08/09 讲持续演进,本讲(第 11 讲)重构为 Session 驱动。
//
// 驾驭工程的极简之美:loop.ts 根本不关心 bash 怎么运行、Claude 的 HTTP 请求怎么发,
// 它只负责维护这根脆弱但重要的"上下文时间线" (contextHistory)。
// 它像一个忠实的书记员,严格执行 ReAct 范式:
// 把模型的意图 (ToolCall) 交给执行层,再把物理世界的反馈 (Observation) 追加回内存。
//
// 第 11 讲:引擎彻底沦为"打工执行器"。它不内部维护状态,
// 而是依靠喂给它的 Session 实例进行推理 —— 随时休眠、随时被唤醒的记忆连续体。
// 每轮组装 = SystemPrompt + Session.GetWorkingMemory(N),严格限制 Context 规模。

import type { LLMProvider, LLMProviderRequestOptions } from "../provider/interface.js";
import { ContextOverflowError } from "../provider/errors.js";
import { generateWithRetry, type RetryInfo } from "../provider/retry.js";
import {
  PICO_TOOL_RESULT_ERROR_KEY,
  type Message,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "../schema/message.js";
import type { Registry, ToolFileSideEffects } from "../tools/registry.js";
import type { AgentRunner } from "../tools/subagent.js";
import type { SubagentRunOptions, SubagentResult } from "../tools/subagent.js";
import type { Compactor } from "../context/compactor.js";
import { ContextCompactionError } from "../context/compactor.js";
import type { FullCompactor } from "../context/full-compactor.js";
import { PromptComposer } from "../context/composer.js";
import { SkillLoader } from "../context/skill.js";
import { RecoveryManager } from "../context/recovery.js";
import { TodoStore } from "../context/todo-store.js";
import { ToolDisclosure } from "../tools/tool-disclosure.js";
import { SilentReporter, type Reporter } from "./reporter.js";
import { SteerQueue } from "./steer-queue.js";
import { ReminderInjector, ToolGuardrailController, type GuardrailOptions } from "./reminder.js";
import { IterationBudget, type BudgetConfig, type BudgetDecision } from "./budget.js";
import type { GoalManager } from "./goal-manager.js";
import { Tracer, exportTraceToFile, truncate, type Span } from "../observability/trace.js";
import { logger } from "../observability/logger.js";
import { safeResolve } from "../tools/registry-impl.js";
import type { WorkspaceRoots } from "../tools/workspace-roots.js";
import type { Session } from "./session.js";
import type { ToolObservationProcessor } from "../tools/tool-result-observation.js";
import { ToolAccesses } from "../tools/tool-access.js";
import { ToolScheduler } from "../tools/tool-scheduler.js";
import {
  fileHistoryAddJournalWarning,
  fileHistoryBeginJournal,
  fileHistoryCommitJournal,
  fileHistoryJournalCoversPath,
  fileHistoryTrackEdit,
  fileHistoryMakeSnapshot,
  type FileHistoryJournal,
} from "../safety/file-history.js";

/** WorkingMemory 滑动窗口大小:截取最近 N 条消息供压缩器判断(含远期历史) */
const DEFAULT_WORKING_MEMORY_LIMIT = 20;

/** 子代理 summary 低于此字数则触发一轮扩写(对齐 Kimi Code SUMMARY_MIN_LENGTH) */
const SUBAGENT_SUMMARY_MIN_CHARS = 200;
/** 子代理单次最终汇报上限，避免过长结果回灌主上下文。 */
const SUBAGENT_SUMMARY_MAX_CHARS = 5_000;
/** summary 续写提示词:要求子代理把过短的总结扩写成完整汇报 */
const SUBAGENT_SUMMARY_CONTINUATION_PROMPT =
  "你上一轮的总结过于简短,主架构师无法据此决策。请重新输出一份结构完整、细节充分的总结汇报:包括你探索了哪些文件/发现了什么、关键结论、以及尚存的不确定点。不要调用任何工具,直接用纯文本回答。";

function isBackgroundBashCall(call: ToolCall): boolean {
  if (call.name !== "bash") return false;
  try {
    const input = JSON.parse(call.arguments) as { background?: unknown };
    return input.background === true;
  } catch {
    return false;
  }
}

interface DelegateTaskPolicyInput {
  completion_policy?: unknown;
  background?: unknown;
}

/**
 * required delegate_task 是引擎控制流边界，不是普通并行工具。
 * 与 DelegateTaskTool 的兼容规则保持一致：明确 optional/detached 或旧式
 * background=true 才是非阻塞，其余（包括省略策略与无效 JSON）均按 required
 * 安全地独占执行。
 */
function isRequiredDelegateTaskCall(call: ToolCall): boolean {
  if (call.name !== "delegate_task") return false;
  try {
    const input = JSON.parse(call.arguments) as DelegateTaskPolicyInput;
    if (input.completion_policy === "optional" || input.completion_policy === "detached") {
      return false;
    }
    if (input.completion_policy === "required") return true;
    return input.background !== true;
  } catch {
    return true;
  }
}

function findRequiredDelegationIndex(toolCalls: readonly ToolCall[]): number | undefined {
  const index = toolCalls.findIndex(isRequiredDelegateTaskCall);
  return index >= 0 ? index : undefined;
}

function buildExclusiveDelegationRejection(
  toolCall: ToolCall,
  requiredDelegation: ToolCall,
): { message: Message } {
  const content =
    `工具执行已拒绝：同一模型响应中的 required delegate_task ` +
    `(${requiredDelegation.id}) 必须独占执行并等待所有子代理收口。`;
  return {
    message: {
      role: "user",
      content,
      toolCallId: toolCall.id,
      providerData: { [PICO_TOOL_RESULT_ERROR_KEY]: true },
    },
  };
}

function fileSideEffectKind(registry: Registry, call: ToolCall): ToolFileSideEffects["kind"] {
  try {
    const effects = registry.getFileSideEffects?.(call);
    if (effects) return effects.kind;
    return registry.isReadOnlyTool?.(call.name) ? "none" : "workspace";
  } catch {
    return "workspace";
  }
}

async function commitFileJournal(
  session: Session,
  journal: FileHistoryJournal,
  messageId: string,
): Promise<void> {
  try {
    const commit = await fileHistoryCommitJournal(
      session.fileHistory,
      journal,
      messageId,
      session.id,
    );
    if (commit.incomplete) {
      logger.warn({ warnings: commit.warnings }, "[FileHistory] 本轮文件 journal 覆盖不完整");
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "[FileHistory] 本轮文件 journal 提交失败");
  }
}

export interface AgentEngineOptions {
  provider: LLMProvider;
  registry: Registry;
  /** 工作区:借鉴 OpenClaw 理念,Agent 必须有明确的物理边界 */
  workDir: string;
  /** 系统提示词;由 PromptComposer 动态组装。planMode 开启时此项被忽略 */
  systemPrompt?: string;
  /** Host-owned prompt composition with session-scoped memory and runtime state. */
  systemPromptFactory?: () => Promise<string>;
  /**
   * 当前模型的原生思考档位。
   * 控制 provider 向模型发送 reasoning_effort / thinking.budget_tokens 参数。
   * 此字段在 engine 层仅用于子代理继承;provider 的实际参数注入在构造时已完成。
   */
  thinkingEffort?: string;
  /**
   * 计划模式开关 (第 13 讲)。
   * 开启后,每次 run 动态用 PromptComposer 组装 System Prompt,
   * 注入"状态外部化强制规范",引导大模型读写 PLAN.md / TODO.md 管理长程任务。
   */
  planMode?: boolean;
  /** WorkingMemory 滑动窗口大小(默认 20 条,给压缩器留判断空间) */
  workingMemoryLimit?: number;
  /** 主循环最大轮次兜底(默认 50,防止失控烧穿 Token) */
  maxTurns?: number;
  /**
   * 上下文压缩器:在向 Provider 发起推理前过一遍,防 OOM (第 12 讲)。
   * 未提供则不压缩(纯靠 WorkingMemory 条数截断)。
   */
  compactor?: Compactor;
  /**
   * 模型摘要压缩器:字符级降级用尽后的最后防线(对标 kimi-code FullCompaction)。
   * 当 generateWithOverflowRetry 的字符级降级(MAX_OVERFLOW_RETRY 次)仍 overflow 时,
   * 在抛错前调用本压缩器,用 provider 把 history 前缀浓缩成摘要替换,
   * 成功后用新 history 重新组装 context 重试。未提供则直接抛 ContextOverflowError
   * (由 run() 的硬重置兜底处理)。
   */
  fullCompactor?: FullCompactor;
  /**
   * 错误自愈管理器:工具执行失败时注入锦囊妙计 (第 14 讲)。
   * 未提供则默认创建一个,对所有工具报错都尝试匹配恢复建议。
   */
  recovery?: RecoveryManager;
  /**
   * 死循环探测器:连续同参数失败时注入 [SYSTEM REMINDER] 强行打断 (第 15 讲)。
   * 未提供则默认创建一个,阈值 3 次同参数失败触发干预。
   */
  reminderInjector?: ReminderInjector;
  /** 工具级 Guardrail 配置:失败循环、同工具失败、只读无进展 */
  guardrailOptions?: GuardrailOptions;
  /** 轮次/token/成本预算配置 */
  budgetConfig?: BudgetConfig;
  /**
   * Goal Manager 单例(ROADMAP 3.5 Goal Mode)。
   * 注入后:planMode 时 PromptComposer 会把 active goal 注入 system prompt;
   * Grace Call 收尾总结会拼上 goal 状态,让收尾对齐目标。
   * 必须与 buildDefaultToolRegistry 传入的是同一实例,确保工具与引擎状态一致。
   * 未提供则 Goal Mode 不生效,行为不变。
   */
  goalManager?: GoalManager;
  /**
   * TodoStore 单例(ROADMAP 补充任务 2026-07-07)。
   * 注入后:planMode 时 PromptComposer 每轮动态重组会复用此实例,
   * 与 TodoTool 共享同一实例,确保工具改的状态 prompt 立即可见。
   * 必须与 buildDefaultToolRegistry 传入的是同一实例(根治跨实例不可见 bug)。
   * 未提供则行为不变(单进程单实例场景不受影响)。
   */
  todoStore?: TodoStore;
  /**
   * 工具渐进披露状态机(ROADMAP 5.4)。
   * 注入后:每轮只把核心组 + 已披露的扩展组工具喂给大模型,而非全量。
   * 模型用 search_tools 元工具检索激活扩展工具。registry.execute 仍按全集路由(安全网)。
   * 未提供则行为不变(全量工具喂给 LLM)。
   */
  toolDisclosure?: ToolDisclosure;
  /** 文件工具与历史快照共用的工作区根集合。 */
  workspaceRoots?: WorkspaceRoots;
  /** 可选的轮次日志回调,便于第 19 讲 Tracing 接入 */
  onTurn?: (info: { turn: number; message: Message }) => void;
  /**
   * Plan Mode 退出回调(ROADMAP 3.6)。
   * ExitPlanModeTool 审批通过、engine.exitPlanMode() 触发后调用,供 host 监听。
   */
  onPlanExit?: () => void;
  /** 输出 Reporter;默认静默 (第 09 讲) */
  reporter?: Reporter;
  /** 工具 Observation 入上下文前的处理器,用于大输出摘要与 artifact 外部化 */
  observationProcessor?: ToolObservationProcessor;
  /**
   * 链路追踪器:记录决策树到 .claw/traces/ (第 19 讲)。
   * 未提供则不追踪。
   */
  tracer?: Tracer;
  /**
   * Steer 队列(ROADMAP 3.2):host 在 Agent 运行期间注入的引导文本。
   * loop 在 provider 调用前 peek 临时拼进上下文(本轮可见),
   * 工具结果落地后 drain 写进 session(下轮浮现)。
   * 未提供则引擎无 steer 能力,行为不变。
   */
  steerQueue?: SteerQueue;
  /**
   * 非工具停止后,host 可决定是否续接(ROADMAP 3.7)。
   * 模型跑完一轮没调工具(toolCalls.length === 0)时,正常是 onFinish + break 退出。
   * host 可借此回调让 Agent 继续(如"任务还没完,接着干"):
   * 返回 {continue:true, continuePrompt?} 则不退出循环,append 续接消息继续下一轮;
   * 返回 void 或 {continue:false} 表示正常退出。
   * 防无限循环是 host 的职责(回调内部自行计数限制)。
   */
  shouldContinueAfterStop?: (info: {
    turn: number;
    lastMessage: Message;
  }) => Promise<{ continue: boolean; continuePrompt?: string } | void> | void;
  /**
   * 凭证轮换回调(可选,4.2 Credential Pool)。
   * generateWithRetry 遇到 429 限流时触发:标记当前 key 限流、
   * 切换到下一个可用 key 重建 provider。返回新 provider(已切 key),
   * 或返回 undefined 表示无多凭证可轮换(回退同 key 指数退避)。
   * 仅当配置了 LLM_API_KEYS(多 key)时由调用方注入;单 key 时为 undefined,
   * 重试行为与原有一致(向后兼容)。
   */
  rebuildProvider?: () => LLMProvider | undefined;
}

/** 微型 OS 的核心驱动 */
export class AgentEngine implements AgentRunner {
  private provider: LLMProvider;
  private readonly registry: Registry;
  private readonly workDir: string;
  private readonly workspaceRoots?: WorkspaceRoots;
  private readonly systemPrompt: string;
  private readonly systemPromptFactory?: () => Promise<string>;
  private readonly thinkingEffort: string;
  // planMode 非 readonly:ExitPlanMode 审批通过后由 exitPlanMode() 置 false。
  private planMode: boolean;
  private readonly workingMemoryLimit: number;
  private readonly maxTurns: number;
  private readonly compactor?: Compactor;
  private readonly fullCompactor?: FullCompactor;
  private readonly recovery: RecoveryManager;
  private readonly guardrail: ToolGuardrailController;
  private readonly budget: IterationBudget;
  /** Goal Manager 单例(可选);planMode 注入 prompt + Grace Call 收尾对齐目标 */
  private readonly goalManager?: GoalManager;
  /** TodoStore 单例(可选);planMode 下 PromptComposer 复用,与 TodoTool 共享 */
  private readonly todoStore?: TodoStore;
  /** 工具渐进披露(可选);注入后每轮只把核心+已披露工具喂给 LLM */
  private readonly toolDisclosure?: ToolDisclosure;
  private readonly onTurn?: (info: { turn: number; message: Message }) => void;
  /** Plan Mode 退出回调(ExitPlanMode 审批通过后触发),供 host 监听 */
  private readonly onPlanExit?: () => void;
  private readonly reporter: Reporter;
  private runtimeReporter?: Reporter;
  private readonly observationProcessor?: ToolObservationProcessor;
  private readonly tracer?: Tracer;
  /**
   * Steer 队列(运行时注入引导文本)。host 持有同一实例在 run 期间 push。
   * 非 readonly:飞书等 host 由 factory 构造 engine 后,经 setSteerQueue 挂载。
   */
  private steerQueue?: SteerQueue;
  /** 非工具停止后续接回调(ROADMAP 3.7):host 可决定让 Agent 接着跑 */
  private readonly shouldContinueAfterStop?: AgentEngineOptions["shouldContinueAfterStop"];
  /** 凭证轮换回调(4.2):429 时切换 key 重建 provider;无多 key 时为 undefined */
  private readonly rebuildProvider?: () => LLMProvider | undefined;

  constructor(opts: AgentEngineOptions) {
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.workDir = opts.workDir;
    this.workspaceRoots = opts.workspaceRoots;
    this.systemPrompt =
      opts.systemPrompt ??
      "You are pico, an expert coding assistant running in a Harness engine. " +
        "You have tools to read, write, edit files and run bash. Think step by step.";
    this.systemPromptFactory = opts.systemPromptFactory;
    this.thinkingEffort = opts.thinkingEffort ?? "off";
    this.planMode = opts.planMode ?? false;
    this.workingMemoryLimit = opts.workingMemoryLimit ?? DEFAULT_WORKING_MEMORY_LIMIT;
    this.maxTurns = opts.maxTurns ?? 50;
    this.compactor = opts.compactor;
    this.fullCompactor = opts.fullCompactor;
    this.recovery = opts.recovery ?? new RecoveryManager();
    this.guardrail = new ToolGuardrailController(opts.guardrailOptions);
    this.budget = new IterationBudget({
      ...opts.budgetConfig,
      maxTurns: opts.budgetConfig?.maxTurns ?? this.maxTurns,
    });
    this.goalManager = opts.goalManager;
    this.todoStore = opts.todoStore;
    this.toolDisclosure = opts.toolDisclosure;
    this.onTurn = opts.onTurn;
    this.onPlanExit = opts.onPlanExit;
    this.reporter = opts.reporter ?? new SilentReporter();
    this.observationProcessor = opts.observationProcessor;
    this.tracer = opts.tracer;
    this.steerQueue = opts.steerQueue;
    this.shouldContinueAfterStop = opts.shouldContinueAfterStop;
    this.rebuildProvider = opts.rebuildProvider;

    this.provider = this.wrapStreamingProvider(this.provider);
  }

  private wrapStreamingProvider(provider: LLMProvider): LLMProvider {
    const generateStreamFn = provider.generateStream;
    if (!generateStreamFn) return provider;
    return {
      generate: (msgs: Message[], tools: ToolDefinition[], options?: LLMProviderRequestOptions) =>
        generateStreamFn.call(
          provider,
          msgs,
          tools,
          (delta: string) => {
            const reporter = this.runtimeReporter ?? this.reporter;
            reporter.onTextDelta?.(delta);
          },
          options,
        ),
      get modelName() {
        return provider.modelName;
      },
      isRetryableError: provider.isRetryableError,
      generateStream: generateStreamFn.bind(provider),
    };
  }

  private rotateProvider(): LLMProvider | undefined {
    const provider = this.rebuildProvider?.();
    if (!provider) return undefined;
    this.provider = this.wrapStreamingProvider(provider);
    return this.provider;
  }

  /**
   * 组装本轮 System Prompt。
   * Plan Mode 开启时,每次 run 动态用 PromptComposer 重新组装,
   * 以反映工作区最新的 AGENTS.md / Skills / 外部化规范状态;
   * 关闭时使用构造时固定的 systemPrompt。
   */
  private async buildSystemPrompt(): Promise<string> {
    if (this.systemPromptFactory) {
      return this.systemPromptFactory();
    }
    if (this.planMode) {
      // planMode 时用 PromptComposer 动态组装;goalManager / todoStore 单例注入,
      // 让 active goal 与最新 todo 状态在每轮 prompt 中浮现(对齐 host 注入范式)。
      const opts: ConstructorParameters<typeof PromptComposer>[2] = {};
      if (this.goalManager) opts.goalManager = this.goalManager;
      if (this.todoStore) opts.todoStore = this.todoStore;
      const composer = new PromptComposer(this.workDir, true, opts);
      return composer.build();
    }
    return this.systemPrompt;
  }

  /**
   * 从全量工具里挑出 search_tools 的 schema(若已注册)。
   * disclosure 启用时,search_tools 元工具必须始终暴露给 LLM,否则模型无法激活扩展工具。
   * 未注册 search_tools(用户未注入 disclosure 到 registry)则返回空数组。
   */
  private searchToolSchema(allTools: ToolDefinition[]): ToolDefinition[] {
    const search = allTools.find((t) => t.name === "search_tools");
    return search ? [search] : [];
  }

  /**
   * 退出 Plan Mode(ROADMAP 3.6)。
   * 由 ExitPlanModeTool 审批通过后经 onExit 回调间接触发。
   * 置 planMode=false,并通知 host 注入的 onPlanExit 监听者。
   */
  exitPlanMode(): void {
    this.planMode = false;
    this.onPlanExit?.();
  }

  /**
   * 暴露 steer 队列给 host(ROADMAP 3.2)。
   * host 在 run 期间调用 queue.push(text) 注入引导文本,
   * engine 在下一轮把文本浮现给模型。未配置 steerQueue 时返回 undefined。
   */
  getSteerQueue(): SteerQueue | undefined {
    return this.steerQueue;
  }

  /**
   * 运行时挂载 steer 队列(ROADMAP 3.2)。
   * 供 host(如飞书 bot)在 engine 由 factory 构造后注入队列,避免改 factory 签名。
   * 仅在构造时未提供时生效(已配置的不覆盖)。
   */
  setSteerQueue(queue: SteerQueue): void {
    if (!this.steerQueue) {
      this.steerQueue = queue;
    }
  }

  /**
   * 构造普通重试(429/5xx/网络错误)的 onRetry 回调:每次重试时打 warn 日志,
   * 并把最近一次重试的 attempt / delayMs 写入对应 Span,供 Tracing 复盘。
   * 多次重试时后值覆盖前值(span 记录最后一次重试的快照)。
   */
  private makeRetryReporter(span?: Span): (info: RetryInfo) => void {
    return (info: RetryInfo) => {
      logger.warn(
        {
          attempt: `${info.failedAttempt}/${info.maxAttempts}`,
          nextAttempt: info.nextAttempt,
          delayMs: info.delayMs,
          statusCode: info.statusCode,
          model: this.provider.modelName,
        },
        `[Retry] 第 ${info.failedAttempt}/${info.maxAttempts} 次调用失败,${info.delayMs}ms 后重试`,
      );
      span?.addAttributes({
        retryAttempt: info.nextAttempt,
        retryDelayMs: info.delayMs,
      });
    };
  }

  /** 响应式压缩最大重试次数(溢出后再尝试 3 轮渐进降级,合计最多 4 次调用) */
  private static readonly MAX_OVERFLOW_RETRY = 3;
  /** 每轮重试的字符预算降级系数(1.0 → 0.6 → 0.4 → 0.25) */
  private static readonly OVERFLOW_BUDGET_FACTORS = [1.0, 0.6, 0.4, 0.25] as const;
  /** 每轮重试的 WorkingMemory 条数降级系数(1.0 → 0.7 → 0.5 → 0.3) */
  private static readonly OVERFLOW_MEMORY_FACTORS = [1.0, 0.7, 0.5, 0.3] as const;
  /**
   * 单轮工具并发上限(对齐 hermes _MAX_TOOL_WORKERS=8)。
   * 超出的任务进 queued 等名额释放,不报错不丢弃,保序返回。
   */
  private static readonly MAX_TOOL_CONCURRENCY = 8;

  /**
   * 响应式溢出重试:catch 到 ContextOverflowError 后,用更小的 WorkingMemory limit
   * + 更小的 maxChars 预算,从 Session 重新组装上下文并压缩、重试 provider.generate。
   *
   * 借鉴 kimi-code handleOverflowError 的闭环语义,但用 pico-harness 现有的字符级截断
   * Compactor,不引入模型摘要 —— 全量记忆仍完整保留在 Session 里,压缩只作用于本轮
   * 发给大模型的临时 Context,写回 Session 的永远是全量真实数据。
   *
   * 与普通重试(generateWithRetry)的两层叠加(已集成):
   *   本方法内部调 generateWithRetry(普通重试层在内),429/5xx/网络错误由其自动退避重试;
   *   ContextOverflowError 不被普通重试吞掉(defaultIsRetryableError 已排除),冒泡到本
   *   方法 catch 做响应式降级(压缩层在外)。非 overflow 且非可重试错误直接抛出。
   *   两层叠加天然成立:普通重试在内,响应式压缩在外。
   *
   * @param session 当前会话(重试时从中重取更小的 WorkingMemory,不改写其历史)
   * @param systemPrompt 本轮系统提示词(重试时用于重建 contextHistory 头部)
   * @param tools 本轮可用工具(Thinking 阶段传 [],Action 阶段传 availableTools)
   * @param baseContext 首轮已组装+压缩好的上下文(attempt 0 直接复用,避免重复压缩)
   * @param span 链路追踪 span(重试时记录 overflowRetry 属性)
   * @returns 模型响应消息
   */
  private async generateWithOverflowRetry(
    session: Session,
    systemPrompt: string,
    tools: ToolDefinition[],
    baseContext: Message[],
    span?: Span,
    signal?: AbortSignal,
  ): Promise<Message> {
    // attempt 0:直接用调用方已压缩好的 baseContext,避免重复压缩
    let context = baseContext;
    // 模型摘要压缩最多触发 1 次/调用,防止压缩后仍 overflow → 再压缩 → 死循环
    let compactionDone = false;
    for (let attempt = 0; ; attempt++) {
      try {
        signal?.throwIfAborted();
        // 【集成点】普通重试层(generateWithRetry)在内,响应式压缩在外:
        // 429/5xx/网络错误在此重试;ContextOverflowError 不被普通重试吞掉
        // (defaultIsRetryableError 已排除),冒泡到本方法 catch 做响应式降级。
        return await generateWithRetry(this.provider, context, tools, {
          signal,
          onRetry: this.makeRetryReporter(span),
          onRateLimited: () => this.rotateProvider(),
        });
      } catch (err) {
        // 非 overflow 错误直接抛(429/5xx 等普通重试已由 generateWithRetry 处理)
        if (!(err instanceof ContextOverflowError)) {
          throw err;
        }
        if (attempt >= AgentEngine.MAX_OVERFLOW_RETRY) {
          // 最后兜底:尝试模型摘要压缩(对标 kimi-code handleOverflowError)
          // 字符级降级用尽仍 overflow,在抛错前用 provider 把 history 前缀浓缩成摘要替换,
          // 成功后用新 history 重新组装 context 从默认预算重试。仅触发 1 次,防死循环。
          if (this.fullCompactor && !compactionDone) {
            signal?.throwIfAborted();
            compactionDone = true;
            // 保留尾部:最近约半个最降级窗口的消息(对标 kimi-code computeCompactCount)
            const lastMemoryFactor = AgentEngine.OVERFLOW_MEMORY_FACTORS[attempt]!;
            const retainLastN = Math.max(
              2,
              Math.floor(this.workingMemoryLimit * lastMemoryFactor * 0.5),
            );
            logger.warn(
              { retainLastN },
              `[Engine] ⚠ 字符级降级用尽,触发模型摘要压缩(FullCompactor),保留尾部 ${retainLastN} 条`,
            );
            const compacted = await this.fullCompactor.compact(session, retainLastN, signal);
            signal?.throwIfAborted();
            if (compacted) {
              // 压缩成功:用新 history 重新组装 context,从默认预算重试
              const newWorkingMemory = session.getWorkingMemory(this.workingMemoryLimit);
              const newContextHistory: Message[] = [
                { role: "system", content: systemPrompt },
                ...newWorkingMemory,
              ];
              context = this.compactor
                ? this.compactor.compactToBudget(newContextHistory)
                : newContextHistory;
              span?.addAttributes({
                fullCompaction: true,
                fullCompactionRetainLastN: retainLastN,
              });
              attempt = -1; // 下次 ++attempt = 0,从默认预算重试
              continue;
            }
            // 压缩失败(返回 false):降级到抛错,由 run() 的硬重置兜底
            logger.error(`[Engine] 模型摘要压缩失败,降级到抛出 ContextOverflowError(由硬重置兜底)`);
          }
          logger.error(
            { attempt, maxRetry: AgentEngine.MAX_OVERFLOW_RETRY },
            `[Engine] 响应式压缩已用尽 ${AgentEngine.MAX_OVERFLOW_RETRY} 次降级仍溢出,抛出 ContextOverflowError`,
          );
          throw err;
        }
        // 渐进降级:更小的 WorkingMemory limit + 更小的 maxChars 预算
        const memoryFactor = AgentEngine.OVERFLOW_MEMORY_FACTORS[attempt + 1]!;
        const budgetFactor = AgentEngine.OVERFLOW_BUDGET_FACTORS[attempt + 1]!;
        const newLimit = Math.max(1, Math.floor(this.workingMemoryLimit * memoryFactor));
        const newWorkingMemory = session.getWorkingMemory(newLimit);
        const newContextHistory: Message[] = [
          { role: "system", content: systemPrompt },
          ...newWorkingMemory,
        ];
        if (this.compactor) {
          const newBudget = Math.max(1, Math.floor(this.compactor.maxChars * budgetFactor));
          context = this.compactor.compactToBudget(newContextHistory, newBudget);
          logger.warn(
            {
              attempt: attempt + 1,
              limit: newLimit,
              budget: newBudget,
              beforeChars: this.compactor.estimateLength(newContextHistory),
            },
            `[Engine] ⚠ 上下文溢出,响应式降级重试(attempt ${attempt + 1}):WorkingMemory ${newLimit} 条 / 预算 ${newBudget} 字符`,
          );
          span?.addAttributes({
            overflowRetry: true,
            overflowRetryAttempt: attempt + 1,
            overflowRetryLimit: newLimit,
            overflowRetryBudget: newBudget,
          });
        } else {
          // 无 Compactor:仅靠条数截断降级
          context = newContextHistory;
          logger.warn(
            { attempt: attempt + 1, limit: newLimit },
            `[Engine] ⚠ 上下文溢出,响应式降级重试(attempt ${attempt + 1},无 Compactor):WorkingMemory ${newLimit} 条`,
          );
          span?.addAttributes({
            overflowRetry: true,
            overflowRetryAttempt: attempt + 1,
            overflowRetryLimit: newLimit,
          });
        }
      }
    }
  }

  /**
   * 启动 Agent 的生命周期(Session 驱动)。
   *
   * 引擎不再"用完即毁":它以传入的 Session 作为上下文承载体,
   * 从 Session.GetWorkingMemory 恢复记忆,而非从零开始。
   * 所有 Thinking / Action / Observation 均持久化回 Session。
   *
   * @param session 当前会话(已 append 用户本轮输入)
   * @param runtimeReporter 可选的运行时 Reporter,覆盖构造时的默认值
   *                        (第 09 讲:飞书每次会话用独立 reporter 回写)
   * @returns 本轮新增的消息序列(从用户输入起)
   */
  async run(
    session: Session,
    runtimeReporter?: Reporter,
    runtimeTracer?: Tracer,
    signal?: AbortSignal,
  ): Promise<Message[]> {
    signal?.throwIfAborted();
    const reporter = runtimeReporter ?? this.reporter;
    const tracer = runtimeTracer ?? this.tracer;
    const rootSpan = tracer?.startRoot("Agent.Run", {
      sessionId: session.id,
      workDir: session.workDir,
      planMode: this.planMode,
    });
    reporter.onStart(this.workDir);
    logger.info(
      { sessionId: session.id, workDir: session.workDir, planMode: this.planMode },
      `[Engine] 唤醒会话 [${session.id}],锁定工作区: ${session.workDir} (PlanMode: ${this.planMode})`,
    );

    // Plan Mode 开启时,每次 run 动态组装 System Prompt(反映最新工作区状态)
    const systemPrompt = await this.buildSystemPrompt();
    signal?.throwIfAborted();

    let beforeLen = session.length;
    let turnCount = 0;
    let exhaustedReason: string | undefined;
    let hardResetTriggered = false;
    const userRewindPointId = session.fileHistory.snapshots.findLast(
      (snapshot) =>
        snapshot.messageId === session.fileHistory.currentMessageId &&
        snapshot.userPrompt !== undefined,
    )?.messageId;
    const journalRoots =
      this.workspaceRoots?.list() ?? (this.registry.setPreWriteHook ? [this.workDir] : []);
    let runFileJournal: FileHistoryJournal | undefined;
    let activeFileJournal: FileHistoryJournal | undefined;
    const previousRuntimeReporter = this.runtimeReporter;
    this.runtimeReporter = reporter;

    // The Main Loop:心跳开始 (ReAct 循环)
    try {
      for (;;) {
        signal?.throwIfAborted();
        turnCount++;
        const turnBudget = this.budget.canStartTurn(turnCount);
        if (!turnBudget.allowed) {
          exhaustedReason = turnBudget.reason ?? `已达到最大轮次 ${this.maxTurns}`;
          logger.warn(
            { turnCount, maxTurns: this.maxTurns },
            `[Engine] ${exhaustedReason},准备触发 Grace Call 收尾`,
          );
          break;
        }
        const goalTurnBudget = this.goalManager?.startTurn() ?? { allowed: true };
        if (!goalTurnBudget.allowed) {
          exhaustedReason = goalTurnBudget.reason ?? "Goal 预算已耗尽";
          logger.warn(
            { turnCount, goalId: this.goalManager?.getActive()?.id },
            `[Engine] ${exhaustedReason},准备触发 Grace Call 收尾`,
          );
          break;
        }
        reporter.onTurnStart(turnCount);
        const turnSpan = rootSpan?.startChild(`Turn-${turnCount}`);
        const currentMessageId =
          userRewindPointId ?? `turn-${session.fileHistory.snapshotSequence + 1}`;
        this.registry.setPreWriteHook?.(async (toolName, args) => {
          try {
            const effects = this.registry.getFileSideEffects?.({
              id: `file-history:${currentMessageId}`,
              name: toolName,
              arguments: args,
            });
            if (effects?.kind !== "exact") return;
            for (const path of effects.paths) {
              const resolvedPath =
                this.workspaceRoots?.resolve(path) ?? safeResolve(this.workDir, path);
              if (
                activeFileJournal &&
                fileHistoryJournalCoversPath(activeFileJournal, resolvedPath)
              ) {
                continue;
              }
              await fileHistoryTrackEdit(
                session.fileHistory,
                resolvedPath,
                currentMessageId,
                session.id,
              );
            }
          } catch {
            // File-history tracking is best-effort and must not block the tool call.
          }
        });

        try {
          // 获取当前挂载的所有工具定义
          const allTools = this.registry.getAvailableTools();
          // 渐进披露(ROADMAP 5.4):启用时只把核心组+已披露扩展组喂给 LLM,
          // 模型用 search_tools 元工具按需激活扩展工具。registry.execute 仍按全集路由(安全网)。
          // 未启用 disclosure 时 availableTools = allTools,行为不变。
          const availableTools = this.toolDisclosure
            ? [...this.toolDisclosure.pickForLLM(allTools), ...this.searchToolSchema(allTools)]
            : allTools;

          // ====================================================================
          // 1. 上下文组装:System Prompt + 截取最近 N 条作为 WorkingMemory
          // 无论聊多久,发给大模型的 Context 规模始终被严格控制。
          // ====================================================================
          const workingMemory = session.getWorkingMemory(this.workingMemoryLimit);
          const contextHistory: Message[] = [
            { role: "system", content: systemPrompt },
            ...workingMemory,
          ];

          // ====================================================================
          // 2. 【核心注入点】:在向 Provider 发起推理前,过一遍内存压缩器!
          // 无论带出多少上下文,若字符总数超标,早期日志将被掩码化,
          // 超大日志将被掐头去尾。Compact 只作用于本轮发给大模型的临时 Context,
          // 写入 Session 的永远是全量真实数据。
          // ====================================================================
          const contextChars = estimateTraceLength(contextHistory);
          let compactedContext: Message[];
          try {
            compactedContext = this.compactor
              ? this.compactor.compactToBudget(contextHistory)
              : contextHistory;
          } catch (err) {
            if (err instanceof ContextCompactionError && !hardResetTriggered) {
              hardResetTriggered = true;
              logger.error(
                {
                  beforeChars: err.beforeChars,
                  afterChars: err.afterChars,
                  maxChars: err.maxChars,
                },
                `[Engine] ⚠ 上下文压缩彻底失败(${err.beforeChars}→${err.afterChars} 仍超 ${err.maxChars}),触发硬重置兜底:清空历史只保留本轮用户输入`,
              );
              turnSpan
                ?.startChild("Context.HardReset", {
                  beforeChars: err.beforeChars,
                  afterChars: err.afterChars,
                  maxChars: err.maxChars,
                })
                ?.end();
              session.truncateTo(beforeLen - 1);
              // 硬重置改变了 session 起点,更新 beforeLen 让返回值切片正确
              beforeLen = session.length - 1;
              continue;
            }
            throw err;
          }
          const compactedChars = estimateTraceLength(compactedContext);
          turnSpan?.addAttributes({
            contextMessageCount: contextHistory.length,
            compactedMessageCount: compactedContext.length,
            contextChars,
            compactedChars,
            availableToolCount: availableTools.length,
          });
          recordCompaction(turnSpan, contextChars, compactedChars);

          // ====================================================================
          // 【Steer A 点】(ROADMAP 3.2):provider 调用前,把 pending steer 文本
          // 临时拼进 compactedContext 末尾。本轮模型立即看到,
          // 不落 session;真正的落盘在下方 C 点(工具结果 append 后)。
          // 用 peek 而非 drain:让本轮先"瞥见",待本轮工具执行完再正式入 session。
          // ====================================================================
          const pendingSteer = this.steerQueue?.peek();
          if (pendingSteer) {
            compactedContext.push({
              role: "user",
              content: `[STEER] ${pendingSteer}`,
              providerData: { picoKind: "steer", picoHiddenFromTranscript: true },
            });
          }

          const actionSpan = turnSpan?.startChild("LLM.Action", {
            inputMessageCount: compactedContext.length,
            availableToolCount: availableTools.length,
            ...(this.toolDisclosure ? { totalToolCount: allTools.length } : {}),
          });
          let responseMsg: Message;
          const costBefore = session.totalCostCNY;
          try {
            responseMsg = await this.generateWithOverflowRetry(
              session,
              systemPrompt,
              availableTools,
              compactedContext,
              actionSpan,
              signal,
            );
            signal?.throwIfAborted();
            // 若本轮内部触发了模型摘要压缩(session.history 被缩短),调整 beforeLen
            // 让返回切片包含摘要起的所有消息(对标硬重置路径的 beforeLen 调整)
            if (session.length < beforeLen) {
              beforeLen = 0;
            }
            recordLlmResponse(actionSpan, responseMsg);
            const budgetDecision = this.consumeResponseBudget(session, responseMsg, costBefore);
            if (!budgetDecision.allowed) {
              exhaustedReason = budgetDecision.reason;
            }
          } catch (err) {
            recordTraceError(actionSpan, err);
            throw err;
          } finally {
            actionSpan?.end();
          }

          const toolCalls = responseMsg.toolCalls ?? [];
          const requiredDelegationIndex = findRequiredDelegationIndex(toolCalls);
          const requiredDelegation =
            requiredDelegationIndex !== undefined ? toolCalls[requiredDelegationIndex] : undefined;
          if (requiredDelegation && responseMsg.content) {
            responseMsg = {
              ...responseMsg,
              content: "",
              providerData: {
                ...responseMsg.providerData,
                picoKind: "required_delegation_dispatch",
                picoHiddenFromTranscript: true,
              },
            };
          }

          // 将大模型的行动响应持久化到 Session。required 委派轮只保留
          // tool calls，不让委派前的解释正文再次进入主上下文。
          session.append(responseMsg);
          compactedContext.push(responseMsg);
          this.onTurn?.({ turn: turnCount, message: responseMsg });
          if (exhaustedReason) {
            break;
          }

          // 模型回复纯文本时广播 (通常是思考过程或最终结果)
          if (responseMsg.content) {
            reporter.onMessage(responseMsg.content);
          }

          // 3. 退出条件:模型没有请求任何工具调用,说明任务完成,挂起等待下一条指令
          if (toolCalls.length === 0) {
            // 3.7: host 可决定续接(返回 {continue:true} 则不退出,append 续接消息继续)
            const decision = await this.shouldContinueAfterStop?.({
              turn: turnCount,
              lastMessage: responseMsg,
            });
            signal?.throwIfAborted();

            // steer 可能在最后一次 provider 调用期间到达。必须在真正 stop
            // 前同步 drain 并续接本轮，否则它会泄漏到下一次无关 run。
            const stopSteers = this.steerQueue?.drain() ?? [];
            for (const text of stopSteers) {
              session.append({
                role: "user",
                content: text,
                providerData: { picoKind: "steer" },
              });
            }
            if (decision?.continue) {
              session.append({
                role: "user",
                content: decision.continuePrompt ?? "请继续推进任务。",
                providerData: { picoKind: "continuation", picoHiddenFromTranscript: true },
              });
            }
            if (stopSteers.length > 0 || decision?.continue) {
              continue; // 不 break,回 for(;;) 顶部继续下一轮
            }
            reporter.onFinish();
            break;
          }

          // 4. 执行行动 (Action) 与 获取观察结果 (Observation)
          // 资源冲突图调度(对标 kimi-code ToolScheduler):工具按文件路径 × 操作类型
          // 声明访问意图,调度器在冲突图上做最大独立集贪心并行。
          //   - 不冲突(read+read / write 不同文件)→ 并行
          //   - 冲突(同文件含写 / kind:"all")→ 串行
          // 结果按 provider 原始顺序回传(add 顺序即 resolve 顺序)。
          const getAccesses = this.registry.getAccesses;
          // Kimi AgentSwarm 式独占语义：required delegate_task 是这一轮唯一
          // 允许真实执行的工具。保留原始 toolCalls 和每个对应 observation，
          // 以维持 provider 要求的 tool-call/result 完整配对。
          // maxConcurrency 限制并发执行的工具数(对齐 hermes _MAX_TOOL_WORKERS=8),
          // 防止一批大量不冲突只读工具同时打 IO 把系统压垮。
          let turnFileJournal: FileHistoryJournal | undefined;
          const fileSideEffectKinds = toolCalls.map((call, index) =>
            requiredDelegationIndex === undefined || index === requiredDelegationIndex
              ? fileSideEffectKind(this.registry, call)
              : "none",
          );
          const hasWorkspaceEffects = fileSideEffectKinds.includes("workspace");
          if (hasWorkspaceEffects && journalRoots.length > 0) {
            if (userRewindPointId) {
              runFileJournal ??= await fileHistoryBeginJournal(journalRoots, session.id, signal);
            } else {
              turnFileJournal = await fileHistoryBeginJournal(journalRoots, session.id, signal);
            }
            const activeJournal = runFileJournal ?? turnFileJournal;
            activeFileJournal = activeJournal;
            if (
              activeJournal &&
              toolCalls.some(
                (call, index) =>
                  (requiredDelegationIndex === undefined || index === requiredDelegationIndex) &&
                  isBackgroundBashCall(call),
              )
            ) {
              fileHistoryAddJournalWarning(
                activeJournal,
                "background bash 在工具返回后仍可继续写入，本轮 rewind 只覆盖返回前的变化",
              );
            }
          }
          const scheduler = new ToolScheduler<{ message: Message; reminder?: Message }>({
            maxConcurrency: AgentEngine.MAX_TOOL_CONCURRENCY,
            signal,
          });
          const settledResults: Array<{ message: Message; reminder?: Message } | undefined> =
            new Array(toolCalls.length);
          let results: Array<{ message: Message; reminder?: Message }>;
          let scheduled: Array<Promise<{ message: Message; reminder?: Message }>> = [];
          try {
            scheduled = toolCalls.map((tc, index) => {
              const execution =
                requiredDelegation && index !== requiredDelegationIndex
                  ? Promise.resolve(buildExclusiveDelegationRejection(tc, requiredDelegation))
                  : scheduler.add({
                      accesses: getAccesses
                        ? getAccesses.call(this.registry, tc)
                        : ToolAccesses.all(),
                      // 文件事务只能在活跃写任务的 start Promise 真实收口后提交。
                      settleOnAbort: fileSideEffectKinds[index] !== "none",
                      start: async () => {
                        signal?.throwIfAborted();
                        return this.runOneTool(tc, reporter, session.id, turnSpan, signal);
                      },
                    });
              return execution.then((result) => {
                settledResults[index] = result;
                return result;
              });
            });
            results = await Promise.all(scheduled);
            signal?.throwIfAborted();
          } catch (err) {
            if (signal?.aborted) {
              // 队列任务已拒绝；workspace/exact 活跃任务则等底层 start 真实 settle。
              await Promise.allSettled(scheduled);
              const abortedObservations = toolCalls.map((toolCall, index) => {
                const settled = settledResults[index];
                if (settled) return settled.message;
                const content = "工具执行已取消:本轮运行被中止,未产生可用结果。";
                reporter.onToolResult(toolCall.name, content, true, toolCall.id);
                return {
                  role: "user" as const,
                  content,
                  toolCallId: toolCall.id,
                  providerData: { [PICO_TOOL_RESULT_ERROR_KEY]: true },
                };
              });
              session.append(...abortedObservations);
              const settledReminders = settledResults.flatMap((result) =>
                result?.reminder ? [result.reminder] : [],
              );
              if (settledReminders.length > 0) {
                session.append(...settledReminders);
              }
            }
            throw err;
          } finally {
            scheduler.dispose();
            if (turnFileJournal) {
              await commitFileJournal(session, turnFileJournal, currentMessageId);
              activeFileJournal = runFileJournal;
            }
          }

          const observations: Message[] = new Array(toolCalls.length);
          const reminderMessages: Message[] = [];
          for (let i = 0; i < results.length; i++) {
            const { message, reminder } = results[i]!;
            observations[i] = message;
            if (reminder) {
              reminderMessages.push(reminder);
            }
          }

          // 将所有 Observation 持久化到 Session,开启下一轮复盘与推理
          session.append(...observations);
          if (requiredDelegation) {
            session.append({
              role: "user",
              content:
                "[DELEGATION JOIN] required 子代理已全部收口（结果可能包含失败）。" +
                "请吸收上述聚合结果并继续集成、定点验证或统一总结；" +
                "不要重复子代理已完成范围的大规模探索。",
              providerData: {
                picoKind: "delegation_join",
                picoHiddenFromTranscript: true,
              },
            });
          }
          if (reminderMessages.length > 0) {
            session.append(...reminderMessages);
          }

          // ====================================================================
          // 【Steer C 点】(ROADMAP 3.2):工具结果落地后,drain 整个 steer 队列,
          // 把每条引导文本落成一条 user 消息写进 session。
          // 下一轮 getWorkingMemory 自动浮现 → 永久可见。drain 清空队列,
          // 避免重复注入。与上方 A 点(本轮临时 peek)配合形成"先瞥见后落盘"。
          // ====================================================================
          const steerTexts = this.steerQueue?.drain() ?? [];
          for (const text of steerTexts) {
            session.append({
              role: "user",
              content: text,
              providerData: { picoKind: "steer" },
            });
          }
        } finally {
          if (!userRewindPointId) {
            await fileHistoryMakeSnapshot(
              session.fileHistory,
              currentMessageId,
              session.id,
              undefined,
              session.length,
            ).catch((err) => logger.warn({ err: String(err) }, "[FileHistory] 每轮快照创建失败"));
          }
          turnSpan?.end();
        }
      }
      if (exhaustedReason) {
        signal?.throwIfAborted();
        await this.runGraceCall(session, systemPrompt, exhaustedReason, reporter, rootSpan, signal);
      }
    } finally {
      if (runFileJournal && userRewindPointId) {
        await commitFileJournal(session, runFileJournal, userRewindPointId);
      }
      activeFileJournal = undefined;
      this.runtimeReporter = previousRuntimeReporter;
      rootSpan?.end();
      if (rootSpan) {
        const tracePath = exportTraceToFile(rootSpan, session.workDir, session.id);
        logger.info({ tracePath }, `[Tracing] 执行回放链路已保存: ${tracePath}`);
      }
    }

    // 返回本轮新增的消息序列(从用户输入起到最终答案止)
    return session.getHistory().slice(beforeLen);
  }

  /** 执行单个工具调用并返回观察结果消息 + 原始结果 (带日志 + 错误自愈注入) */
  private async runOneTool(
    toolCall: ToolCall,
    reporter: Reporter,
    sessionId?: string,
    parentSpan?: Span,
    signal?: AbortSignal,
  ): Promise<{ message: Message; result: ToolResult; reminder?: Message }> {
    const toolSpan = parentSpan?.startChild("Tool.Execute", {
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      arguments: toolCall.arguments,
    });
    try {
      signal?.throwIfAborted();
      reporter.onToolCall(toolCall.name, toolCall.arguments, toolCall.id);
      const guardDecision = this.guardrail.beforeCall(toolCall);
      let result: ToolResult;
      if (!guardDecision.allowed) {
        result = {
          toolCallId: toolCall.id,
          output: `执行被 Guardrail 阻断。原因: ${guardDecision.reason ?? "未知"}`,
          isError: true,
        };
      } else {
        signal?.throwIfAborted();
        result = await this.registry.execute(toolCall, {
          signal,
          onOutput: ({ stream, chunk }) =>
            reporter.onToolOutput?.(toolCall.name, stream, chunk, toolCall.id),
        });
        signal?.throwIfAborted();
      }

      // 【核心拦截与注入】工具执行失败时,交由 RecoveryManager 诊断并注入"锦囊妙计"。
      // 化被动为主动:不再冷冰冰陈述报错,而是给出带强烈倾向性的行动指南,
      // 引导大模型进入标准排障 SOP(如"请先使用 read_file 重新查看文件")。
      let finalOutput = result.output;
      if (result.isError) {
        finalOutput = this.recovery.analyzeAndInject(toolCall.name, result.output);
        logger.warn({ tool: toolCall.name }, `-> [Recovery] ❌ 注入救援指南: ${toolCall.name}`);
      }
      const observationOutput = await this.processObservation(
        toolCall,
        result,
        finalOutput,
        sessionId,
      );
      signal?.throwIfAborted();

      toolSpan?.addAttributes({
        isError: result.isError,
        outputPreview: truncate(observationOutput, 500),
        rawOutputPreview: finalOutput === result.output ? undefined : truncate(result.output, 500),
      });

      reporter.onToolResult(toolCall.name, observationOutput, result.isError, toolCall.id);
      const readOnly = this.registry.isReadOnlyTool?.(toolCall.name) ?? false;
      const reminder = this.guardrail.afterCall(toolCall, result, { readOnly });
      // ToolCallId 必须携带!这是维系大模型推理链条的关键
      return {
        message: {
          role: "user",
          content: observationOutput,
          toolCallId: toolCall.id,
          providerData: { [PICO_TOOL_RESULT_ERROR_KEY]: result.isError },
        },
        result,
        ...(reminder ? { reminder } : {}),
      };
    } catch (err) {
      recordTraceError(toolSpan, err);
      throw err;
    } finally {
      toolSpan?.end();
    }
  }

  private async processObservation(
    toolCall: ToolCall,
    result: ToolResult,
    output: string,
    sessionId?: string,
  ): Promise<string> {
    if (!this.observationProcessor) {
      return output;
    }
    try {
      return await this.observationProcessor({ toolCall, result, output, sessionId });
    } catch (err) {
      logger.warn({ err, tool: toolCall.name }, "[ToolResult] observation processor failed");
      return [
        "[工具输出处理失败,已回退为截断观察结果]",
        `tool: ${toolCall.name}`,
        `toolCallId: ${toolCall.id}`,
        `originalChars: ${output.length}`,
        "preview:",
        truncate(output, 4000),
      ].join("\n");
    }
  }

  private async runGraceCall(
    session: Session,
    systemPrompt: string,
    reason: string,
    reporter: Reporter,
    parentSpan?: Span,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    // Goal Mode(可选):把 active goal 状态拼进收尾提示,让总结对齐目标。
    // 无 goalManager 或无 active goal 时 goalSection 为空,gracePrompt 保持原样。
    const goalContext = this.goalManager?.buildGoalContext() ?? "";
    const goalSection = goalContext
      ? `\n\n${goalContext}\n请在总结中明确:当前目标达成到什么程度。`
      : "";
    const gracePrompt = `[SYSTEM] 已达执行预算: ${reason}。立即停止工具调用,用纯文本总结:1)已完成 2)未完成 3)下一步建议。${goalSection}`;
    session.append({
      role: "user",
      content: gracePrompt,
      providerData: { picoKind: "grace", picoHiddenFromTranscript: true },
    });
    const graceSpan = parentSpan?.startChild("LLM.GraceCall", {
      reason,
      availableToolCount: 0,
    });
    try {
      const context: Message[] = [
        { role: "system", content: systemPrompt },
        ...session.getWorkingMemory(this.workingMemoryLimit),
      ];
      const costBefore = session.totalCostCNY;
      const response = await generateWithRetry(this.provider, context, [], {
        signal,
        onRetry: this.makeRetryReporter(graceSpan),
        onRateLimited: () => this.rotateProvider(),
      });
      signal?.throwIfAborted();
      recordLlmResponse(graceSpan, response);
      // Grace Call is the one permitted over-budget summary. It does not consume another
      // goal turn, but its measurable token/cost usage remains part of the goal totals.
      this.consumeResponseBudget(session, response, costBefore);
      session.append(response);
      if (response.content) {
        reporter.onMessage(response.content);
      }
      reporter.onFinish();
    } catch (err) {
      recordTraceError(graceSpan, err);
      throw err;
    } finally {
      graceSpan?.end();
    }
  }

  private consumeResponseBudget(
    session: Session,
    response: Message,
    costBefore: number,
  ): BudgetDecision {
    const decisions: BudgetDecision[] = [];
    if (response.usage) {
      decisions.push(this.budget.consumeUsage(response.usage));
      decisions.push(this.goalManager?.consumeUsage(response.usage) ?? { allowed: true });
    }

    const costDelta = Math.max(0, session.totalCostCNY - costBefore);
    if (costDelta > 0) {
      decisions.push(this.budget.consumeCost(costDelta));
      decisions.push(this.goalManager?.consumeCost(costDelta) ?? { allowed: true });
    }
    return decisions.find((decision) => !decision.allowed) ?? { allowed: true };
  }

  /**
   * runSub 专用的简化版响应式溢出重试。
   *
   * 子代理用独立 contextHistory 局部变量(非 Session 驱动),无法重取 WorkingMemory,
   * 故仅用更小的 maxChars 预算对 contextHistory 重新 compactToBudget 重试,不改 limit。
   * 降级系数复用 OVERFLOW_BUDGET_FACTORS(与主循环一致,便于心智模型统一)。
   *
   * 与 generateWithOverflowRetry 的差异:
   *   - 不从 Session 重取 WorkingMemory(子代理无 Session)
   *   - 仅压缩字符预算,条数不变
   *   - 首轮压缩也由本方法内部完成(调用方直接传原始 contextHistory)
   *
   * @param contextHistory 子代理当前完整上下文(未经压缩)
   * @param tools 本轮可用工具
   * @returns 模型响应消息
   */
  private async generateSubWithOverflowRetry(
    contextHistory: Message[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<Message> {
    if (!this.compactor) {
      // 无 Compactor:子代理无法降级,叠加普通重试层(溢出则原样抛出)
      return generateWithRetry(this.provider, contextHistory, tools, {
        signal,
        onRetry: this.makeRetryReporter(),
        onRateLimited: () => this.rotateProvider(),
      });
    }
    // 首轮:用默认预算压缩(attempt 0,系数 1.0)
    let context = this.compactSubContext(contextHistory);
    for (let attempt = 0; ; attempt++) {
      try {
        // 【集成点】同 generateWithOverflowRetry,叠加普通重试层在内,
        // 响应式压缩在外(子代理版仅降字符预算,不改 WorkingMemory 条数)。
        return await generateWithRetry(this.provider, context, tools, {
          signal,
          onRetry: this.makeRetryReporter(),
          onRateLimited: () => this.rotateProvider(),
        });
      } catch (err) {
        if (!(err instanceof ContextOverflowError)) {
          throw err;
        }
        if (attempt >= AgentEngine.MAX_OVERFLOW_RETRY) {
          logger.error(
            { attempt, maxRetry: AgentEngine.MAX_OVERFLOW_RETRY },
            `[Subagent] 响应式压缩已用尽 ${AgentEngine.MAX_OVERFLOW_RETRY} 次降级仍溢出,抛出 ContextOverflowError`,
          );
          throw err;
        }
        const budgetFactor = AgentEngine.OVERFLOW_BUDGET_FACTORS[attempt + 1]!;
        const newBudget = Math.max(1, Math.floor(this.compactor.maxChars * budgetFactor));
        // 始终从原始 contextHistory 重新压缩,避免对已压缩结果二次压缩丢失结构
        context = this.compactSubContext(contextHistory, newBudget);
        logger.warn(
          { attempt: attempt + 1, budget: newBudget },
          `[Subagent] ⚠ 上下文溢出,响应式降级重试(attempt ${attempt + 1}):预算 ${newBudget} 字符`,
        );
      }
    }
  }

  /**
   * 子代理上下文压缩 + 硬重置兜底。
   * compactToBudget 抛 ContextCompactionError 时,清空探索中间产物,
   * 只保留 [system, taskPrompt](contextHistory 前 2 条)重新压缩。
   * 二次仍失败则自然抛错(只剩 system+taskPrompt 不可恢复)。
   */
  private compactSubContext(contextHistory: Message[], budget?: number): Message[] {
    try {
      return budget !== undefined
        ? this.compactor!.compactToBudget(contextHistory, budget)
        : this.compactor!.compactToBudget(contextHistory);
    } catch (err) {
      if (err instanceof ContextCompactionError) {
        logger.warn(
          { beforeChars: err.beforeChars, afterChars: err.afterChars, maxChars: err.maxChars },
          `[Subagent] ⚠ 压缩彻底失败,清空探索中间产物只留任务指令重试`,
        );
        // 只保留 [system, taskPrompt],丢弃所有探索中间产物
        const reset = contextHistory.slice(0, 2);
        return budget !== undefined
          ? this.compactor!.compactToBudget(reset, budget)
          : this.compactor!.compactToBudget(reset);
      }
      throw err;
    }
  }

  /**
   * RunSub:专为 Subagent 拉起的一次性受限循环 (第 17 讲)。
   *
   * 不依赖外部 Session,打完就跑。子智能体拥有全新纯净上下文,
   * 无论怎么折腾犯错,主干 contextHistory 依然纯洁如初。
   *
   * 防污染机制:
   * - 仅传入受限 Registry(只读/受控工具,爆炸半径限制)
   * - 专属 System Prompt 严厉警告必须用工具不许偷懒,并暴露项目 Skill 索引
   * - maxSubTurns=10 防卡死
   * - 退出条件:不调工具 = 做好总结,返回 content
   *
   * @returns 子智能体的纯文本总结汇报及外部化产物引用
   */
  async runSub(
    taskPrompt: string,
    readOnlyRegistry: Registry,
    reporter?: Reporter,
    opts: SubagentRunOptions = {},
  ): Promise<SubagentResult> {
    const rep = reporter ?? new SilentReporter();
    const signal = opts.signal;
    signal?.throwIfAborted();
    logger.info(
      { task: taskPrompt.slice(0, 100), thinkingEffort: this.thinkingEffort },
      `[Subagent] 🚀 拉起探路者,任务: ${taskPrompt.slice(0, 100)} (thinkingEffort: ${this.thinkingEffort},继承自主 Agent)`,
    );

    const initialToolNames = new Set(readOnlyRegistry.getAvailableTools().map((tool) => tool.name));
    const canViewSkills = initialToolNames.has("skill_view");
    const skillIndex = canViewSkills ? await new SkillLoader(this.workDir).loadAll() : "";
    signal?.throwIfAborted();
    const toolExamples = canViewSkills
      ? "bash 的 find/grep、read_file、skill_view"
      : "bash 的 find/grep、read_file";

    // 子智能体专属 System Prompt:严厉警告必须用工具,不许凭空猜测。
    // 若工作区配置了 Skills,只注入 name/description 索引;正文仍由 skill_view 按需读取。
    // 支持调用方自定义:默认追加拼接(对标 kimi-code ROLE_ADDITIONAL),
    // systemPromptOverride=true 时完全覆盖(对标 hermes ephemeral_system_prompt)。
    const subSystemPrompt = buildSubagentSystemPrompt(toolExamples, skillIndex, opts);

    // 全新纯净上下文:不共享主 Agent 的 Session
    const contextHistory: Message[] = [
      { role: "system", content: subSystemPrompt },
      { role: "user", content: taskPrompt },
    ];

    // maxTurns 可由调用方覆盖(默认 10),子代理跑满此轮次仍没总结会被强制召回
    const maxSubTurns = opts.maxTurns ?? 10;
    const depth = opts.depth ?? 0;
    const maxSpawnDepth = opts.maxSpawnDepth ?? 2;
    let turnCount = 0;
    // 收集子代理探索期间被外部化的大型工具输出磁盘路径,回传给主 Agent 供回查。
    const artifactPaths: string[] = [];

    for (;;) {
      signal?.throwIfAborted();
      turnCount++;
      if (turnCount > maxSubTurns) {
        throw new Error(
          `子智能体探索过于深入,超过 ${maxSubTurns} 轮被强制召回,请主 Agent 缩小探索范围或拆分任务。`,
        );
      }
      if (depth > maxSpawnDepth) {
        throw new Error(`子智能体超过最大委派深度 ${maxSpawnDepth}`);
      }

      // 【驾驭底线】子智能体仅能获取传入的只读工具注册表
      const availableTools = readOnlyRegistry.getAvailableTools();

      // 响应式溢出重试:子代理用独立 contextHistory(非 Session 驱动),无法重取
      // WorkingMemory,故仅用更小的 maxChars 预算对 contextHistory 重新压缩重试。
      const actionResp = await this.generateSubWithOverflowRetry(
        contextHistory,
        availableTools,
        signal,
      );
      contextHistory.push(actionResp);

      if (actionResp.content) {
        rep.onMessage(`[Subagent] ${actionResp.content}`);
      }

      // 【核心退出条件】子智能体不调工具了,说明做好了总结汇报
      const toolCalls = actionResp.toolCalls ?? [];
      if (toolCalls.length === 0) {
        // 【改动 B】summary 续写:子代理最终汇报过短(< 200 字)时,
        // 再给一轮强制扩写,防止主 Agent 因信息不足而"失忆"。
        // 对齐 Kimi Code 的 SUMMARY_MIN_LENGTH / SUMMARY_CONTINUATION_ATTEMPTS 设计。
        // 约束:最多续写 1 次,且复用 turnCount 预算,不会无限循环。
        let summary = actionResp.content;
        if (summary.length < SUBAGENT_SUMMARY_MIN_CHARS && turnCount < maxSubTurns) {
          contextHistory.push({
            role: "user",
            content: SUBAGENT_SUMMARY_CONTINUATION_PROMPT,
          });
          logger.info(
            { turns: turnCount, summaryLen: summary.length },
            `[Subagent] 📝 探路者总结过短,追加一轮扩写。`,
          );
          const continuationResp = await this.generateSubWithOverflowRetry(
            contextHistory,
            [],
            signal,
          );
          contextHistory.push(continuationResp);
          if (continuationResp.content && continuationResp.content.trim().length > 0) {
            summary = continuationResp.content;
          }
        }
        logger.info(
          { turns: turnCount },
          `[Subagent] ✅ 探路者完成 ${turnCount} 轮探索,返回总结。`,
        );
        return {
          summary: truncateSubagentSummary(summary, SUBAGENT_SUMMARY_MAX_CHARS),
          artifacts: artifactPaths,
        };
      }

      // 执行只读工具的并发循环(资源冲突图调度,复用主循环的调度策略)
      const getAccesses = readOnlyRegistry.getAccesses;
      const scheduler = new ToolScheduler<{ message: Message; artifactPath?: string }>({
        maxConcurrency: AgentEngine.MAX_TOOL_CONCURRENCY,
        signal,
      });
      const scheduled = toolCalls.map((tc) =>
        scheduler.add({
          accesses: getAccesses ? getAccesses.call(readOnlyRegistry, tc) : ToolAccesses.all(),
          settleOnAbort: true,
          start: async () => {
            signal?.throwIfAborted();
            rep.onToolCall(`[Subagent] ${tc.name}`, tc.arguments, tc.id);
            const result = await readOnlyRegistry.execute(tc, { signal });
            let finalOutput = result.output;
            if (result.isError) {
              finalOutput = this.recovery.analyzeAndInject(tc.name, result.output);
            }
            const observationOutput = await this.processObservation(
              tc,
              result,
              finalOutput,
              `subagent:${tc.id}`,
            );
            // 从外部化占位文本中提取磁盘路径,回传给主 Agent 供其用 read_file 回查。
            const artifactPath = extractArtifactPath(observationOutput);
            rep.onToolResult(`[Subagent] ${tc.name}`, observationOutput, result.isError, tc.id);
            return {
              message: {
                role: "user" as const,
                content: observationOutput,
                toolCallId: tc.id,
                providerData: { [PICO_TOOL_RESULT_ERROR_KEY]: result.isError },
              },
              ...(artifactPath !== undefined ? { artifactPath } : {}),
            };
          },
        }),
      );
      let subResults: Array<{ message: Message; artifactPath?: string }>;
      try {
        subResults = await Promise.all(scheduled);
        signal?.throwIfAborted();
      } catch (error) {
        if (signal?.aborted) await Promise.allSettled(scheduled);
        throw error;
      } finally {
        scheduler.dispose();
      }

      const observations: Message[] = new Array(toolCalls.length);
      for (let i = 0; i < subResults.length; i++) {
        const { message, artifactPath } = subResults[i]!;
        observations[i] = message;
        if (artifactPath !== undefined) {
          artifactPaths.push(artifactPath);
        }
      }

      contextHistory.push(...observations);
    }
  }
}

function truncateSubagentSummary(summary: string, maxChars: number): string {
  if (summary.length <= maxChars) return summary;
  const marker = `\n[子代理总结已截断：原始 ${summary.length} 字符，上限 ${maxChars} 字符]`;
  return `${summary.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

/**
 * 构造子代理的 system prompt。
 *
 * 自定义语义(对标 kimi-code ROLE_ADDITIONAL + hermes ephemeral_system_prompt):
 * - 未传 opts.systemPrompt:返回默认的"探路者"骨架(向后兼容)。
 * - 传 opts.systemPrompt 且 opts.systemPromptOverride !== true:默认骨架 + 追加拼接
 *   自定义片段。保留基本纪律 + 调用方追加要求(对标 kimi-code 的 ROLE_ADDITIONAL)。
 * - opts.systemPromptOverride === true 且有 systemPrompt:完全覆盖默认骨架
 *   (对标 hermes 的 ephemeral_system_prompt 替换语义),给需要完全定制的场景。
 */
function buildSubagentSystemPrompt(
  toolExamples: string,
  skillIndex: string,
  opts: SubagentRunOptions,
): string {
  // 完全覆盖模式:调用方显式声明,直接用自定义 prompt 替换默认骨架
  if (opts.systemPromptOverride && opts.systemPrompt) {
    return opts.systemPrompt;
  }

  // 默认骨架(与原硬编码逐字一致,保证向后兼容)
  const base = `你是专门负责深度探索的探路者 (Explorer Subagent)。
你的任务是根据主架构师的指令,在当前工作区内仔细阅读代码、查阅日志,搜集足够的信息。
【核心纪律】
1. 你必须、且只能依靠内置工具(如 ${toolExamples})去寻找答案。绝对不允许凭空猜测。
2. 如果你没有找到确切的答案,你必须继续使用工具深入搜索。
3. 当且仅当你找到了确切的线索后,停止调用工具,直接输出一段纯文本作为你的终极汇报。主架构师会根据你的汇报决定下一步。${
    skillIndex ? `\n\n${skillIndex}` : ""
  }`;

  // 追加模式:默认骨架 + 自定义片段
  return opts.systemPrompt ? `${base}\n\n${opts.systemPrompt}` : base;
}

/**
 * 从 observationProcessor 返回的"已外部化"占位文本中提取 artifactPath。
 * 该文本形如(tool-result-observation.ts 产物):
 *   [大型工具输出已外部化]
 *   tool: bash
 *   ...
 *   artifactPath: <绝对磁盘路径>
 *   ...
 * 提取出 path 行的值返回;无则返回 undefined。
 */
function extractArtifactPath(observation: string): string | undefined {
  const match = /^artifactPath:\s*(.+)$/m.exec(observation);
  return match?.[1]?.trim() || undefined;
}

function estimateTraceLength(messages: Message[]): number {
  let length = 0;
  for (const message of messages) {
    length += message.content.length;
    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        length += toolCall.name.length + toolCall.arguments.length;
      }
    }
  }
  return length;
}

function recordCompaction(span: Span | undefined, beforeChars: number, afterChars: number): void {
  if (!span || beforeChars === afterChars) {
    return;
  }
  const compactionSpan = span.startChild("Context.Compaction", {
    beforeChars,
    afterChars,
  });
  compactionSpan.end();
}

function recordLlmResponse(span: Span | undefined, response: Message): void {
  span?.addAttributes({
    outputContentLength: response.content.length,
    toolCallCount: response.toolCalls?.length ?? 0,
    promptTokens: response.usage?.promptTokens,
    completionTokens: response.usage?.completionTokens,
  });
}

function recordTraceError(span: Span | undefined, error: unknown): void {
  span?.addAttributes({
    isError: true,
    outputPreview: truncate(error instanceof Error ? error.message : String(error), 500),
  });
}
