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
// 每轮组装 = SystemPrompt + Session 完整历史投影，接近 token 水位时主动整理。

import type { LLMProvider, LLMProviderRequestOptions } from "../provider/interface.js";
import { ContextOverflowError, isAbortError } from "../provider/errors.js";
import { generateWithRetry, type RetryInfo } from "../provider/retry.js";
import {
  PICO_TOOL_RESULT_ERROR_KEY,
  type Message,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "../schema/message.js";
import type { Registry, ToolFileSideEffects } from "../tools/registry.js";
import type {
  AgentRunner,
  SubagentModelSelectionRequest,
  SubagentReportArtifactWriter,
  SubagentRunOptions,
  SubagentResult,
} from "../tools/subagent.js";
import type { Compactor } from "../context/compactor.js";
import { ContextCompactionError, sanitizeToolPairs } from "../context/compactor.js";
import type { FullCompactor } from "../context/full-compactor.js";
import type { ContextBudget } from "../context/context-budget.js";
import {
  estimateModelInputTokens,
  estimateMessagesTokens,
  estimateTokenBudgetAsChars,
} from "../context/context-budget.js";
import { findSafeCompactionCut } from "../context/safe-compaction-boundary.js";
import { withProviderCallContext } from "../observability/provider-call-context.js";
import { PromptComposer } from "../context/composer.js";
import { SkillLoader } from "../context/skill.js";
import { RecoveryManager } from "../context/recovery.js";
import { TodoStore } from "../context/todo-store.js";
import {
  createFirstTurnDelegationPolicy,
  type RequestedDelegationCount,
} from "../input/delegation-intent-policy.js";
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
import type { HookService } from "../hooks/service.js";
import type { ToolObservationProcessor } from "../tools/tool-result-observation.js";
import { ToolAccesses } from "../tools/tool-access.js";
import { ToolScheduler } from "../tools/tool-scheduler.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { RunLedger, type RunTerminalStatus } from "./run-ledger.js";
import { SUBAGENT_OUTPUT_BUDGET } from "../tools/subagent-budget.js";
import {
  fileHistoryAddJournalWarning,
  fileHistoryBeginJournal,
  fileHistoryCommitJournal,
  fileHistoryJournalCoversPath,
  fileHistoryTrackEdit,
  fileHistoryMakeSnapshot,
  type FileHistoryJournal,
} from "../safety/file-history.js";

const DEFAULT_AUTO_COMPACT_TRIGGER_RATIO = 0.85;
const DEFAULT_RETAINED_CONTEXT_RATIO = 0.2;
const EMERGENCY_RETAINED_CONTEXT_RATIO = 0.1;

/** 子代理 summary 低于此字数则触发一轮扩写(对齐 Kimi Code SUMMARY_MIN_LENGTH) */
const SUBAGENT_SUMMARY_MIN_CHARS = 200;
/** summary 续写提示词:要求子代理把过短的总结扩写成完整汇报 */
const SUBAGENT_SUMMARY_CONTINUATION_PROMPT =
  "你上一轮的总结过于简短,主架构师无法据此决策。请直接重写为结构化纯文本：先给结论，再列关键证据(文件:行号)、未验证风险和下一步。不要重放原始日志，不要调用任何工具。";
const SUBAGENT_FINALIZE_PROMPT =
  "[FINALIZE] 已进入预留的最终收口轮。立即停止探索和工具调用，只基于当前上下文中已收集的证据输出纯文本汇报：" +
  "1) 结论；2) 已确认的事实与文件:行号证据；3) 未完成或未验证风险；4) 主 Agent 可直接采取的下一步。通常控制在 1000–2000 字符，简单任务可更短，不要重放原始日志。";
const SUBAGENT_EMPTY_SUMMARY_FALLBACK =
  "子代理未能生成可用的最终总结；请主 Agent 根据已回传的工具证据和 artifact 继续收口。";

const EXPLORE_SYNTHESIS_PROMPT =
  "[DELEGATION SYNTHESIS] 本批 required 委派的实际任务均为 explore，子代理已全部收口。" +
  "你现在只能基于上述聚合结果直接给出统一结论；不得调用任何工具，不得重新阅读、搜索或验证项目。";
const EXPLORE_SYNTHESIS_RETRY_PROMPT =
  "[DELEGATION SYNTHESIS RETRY] 上一次回复违反了纯文本总结协议，所有工具调用均已拒绝。" +
  "请立即基于已有聚合结果输出最终统一总结，只输出纯文本。";
const MAX_EXPLORE_SYNTHESIS_TOOL_RETRIES = 2;
const EXPLORE_SYNTHESIS_FAILED_MESSAGE =
  "子代理已完成探索，但主模型连续违反纯文本总结协议，本次未能生成可靠的统一总结。";
const MAX_REQUIRED_FIRST_DELEGATION_ATTEMPTS = 2;
const REQUIRED_FIRST_DELEGATION_FAILED_MESSAGE =
  "模型未能按用户的明确要求启动 required 子代理，已停止主 Agent 自行探索。";
const REQUIRED_DELEGATION_RECOVERY_PROMPT =
  "[DELEGATION RECOVERY] 上一批 required 委派没有产生可用的 completed/partial 证据。" +
  "本轮只允许再调用一次 required delegate_task，将任务缩小为一个最关键、可独立验证的缺口；" +
  "不得改用主 Agent 工具大范围重读项目，不得输出解释性正文。";
const REQUIRED_DELEGATION_RECOVERY_FAILED_MESSAGE =
  "required 子代理在一次缩小范围的恢复委派后仍未产生可用证据，已停止主 Agent 自行大范围重读。";

function isBackgroundBashCall(call: ToolCall): boolean {
  if (call.name !== "bash") return false;
  try {
    const input = JSON.parse(call.arguments) as { background?: unknown };
    return input.background === true;
  } catch {
    return false;
  }
}

function parseHookToolArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return {};
  }
}

interface DelegateTaskPolicyInput {
  completion_policy?: unknown;
  background?: unknown;
}

interface DelegateTaskModeInput extends DelegateTaskPolicyInput {
  goal?: unknown;
  mode?: unknown;
  tasks?: Array<{ goal?: unknown; mode?: unknown }>;
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

/** 与 DelegateTaskTool 的任务归一化规则保持一致：省略/无效 mode 默认 explore。 */
function isExploreOnlyRequiredDelegation(call: ToolCall): boolean {
  if (!isRequiredDelegateTaskCall(call)) return false;
  try {
    const input = JSON.parse(call.arguments) as DelegateTaskModeInput;
    const defaultMode = input.mode === "worker" ? "worker" : "explore";
    const tasks =
      Array.isArray(input.tasks) && input.tasks.length > 0
        ? input.tasks.filter(
            (task) =>
              typeof task === "object" &&
              task !== null &&
              typeof task.goal === "string" &&
              task.goal.trim().length > 0,
          )
        : typeof input.goal === "string" && input.goal.trim().length > 0
          ? [{ goal: input.goal, mode: input.mode }]
          : [];
    return (
      tasks.length > 0 &&
      tasks.every(
        (task) =>
          (task.mode === "worker" || task.mode === "explore" ? task.mode : defaultMode) ===
          "explore",
      )
    );
  } catch {
    return false;
  }
}

function buildSynthesisToolRejection(toolCall: ToolCall): Message {
  return {
    role: "user",
    content: "工具执行已拒绝：explore-only required 委派收口后必须直接基于聚合结果输出纯文本总结。",
    toolCallId: toolCall.id,
    providerData: { [PICO_TOOL_RESULT_ERROR_KEY]: true },
  };
}

function buildRequiredFirstToolRejection(toolCall: ToolCall): Message {
  return {
    role: "user",
    content: "工具执行已拒绝：用户明确要求首先委派子代理，本轮只允许 required delegate_task。",
    toolCallId: toolCall.id,
    providerData: { [PICO_TOOL_RESULT_ERROR_KEY]: true },
  };
}

function buildDelegationRecoveryToolRejection(toolCall: ToolCall): Message {
  return {
    role: "user",
    content: "工具执行已拒绝：required 委派恢复轮只允许一次缩小范围的 required delegate_task。",
    toolCallId: toolCall.id,
    providerData: { [PICO_TOOL_RESULT_ERROR_KEY]: true },
  };
}

function latestVisibleUserInput(messages: readonly Message[]): string {
  return (
    messages.findLast(
      (message) =>
        message.role === "user" &&
        message.toolCallId === undefined &&
        message.providerData?.["picoHiddenFromTranscript"] !== true,
    )?.content ?? ""
  );
}

function isSubagentCompletionWake(messages: readonly Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.providerData?.["picoKind"] === "subagent_completion") return true;
    if (
      message.role === "user" &&
      message.toolCallId === undefined &&
      message.providerData?.["picoHiddenFromTranscript"] !== true
    ) {
      return false;
    }
  }
  return false;
}

function requiredDelegationTaskCount(call: ToolCall): number {
  try {
    const input = JSON.parse(call.arguments) as DelegateTaskModeInput;
    if (Array.isArray(input.tasks) && input.tasks.length > 0) {
      return input.tasks.filter(
        (task) =>
          typeof task === "object" &&
          task !== null &&
          typeof task.goal === "string" &&
          task.goal.trim().length > 0,
      ).length;
    }
    return typeof input.goal === "string" && input.goal.trim().length > 0 ? 1 : 0;
  } catch {
    return 0;
  }
}

function satisfiesRequestedDelegationCount(
  call: ToolCall,
  requestedCount: RequestedDelegationCount,
): boolean {
  const actual = requiredDelegationTaskCount(call);
  return requestedCount === "multiple" ? actual >= 2 : actual >= 1;
}

interface RequiredDelegationAssessment {
  usableResults: number;
  batchFailed: boolean;
}

function assessRequiredDelegationResult(message: Message): RequiredDelegationAssessment {
  try {
    const parsed = JSON.parse(message.content) as {
      status?: unknown;
      results?: unknown;
      omittedResults?: unknown;
      error?: unknown;
    };
    const batchFailed =
      typeof parsed.error === "string" ||
      parsed.status === "error" ||
      parsed.status === "timed_out" ||
      parsed.status === "cancelled";
    if (!Array.isArray(parsed.results)) return { usableResults: 0, batchFailed: true };

    let usableResults = 0;
    for (const result of parsed.results) {
      if (typeof result !== "object" || result === null) continue;
      const record = result as Record<string, unknown>;
      if (record["status"] !== "completed" && record["status"] !== "partial") continue;
      const hasSummary =
        typeof record["summary"] === "string" && record["summary"].trim().length > 0;
      const hasArtifacts = Array.isArray(record["artifacts"]) && record["artifacts"].length > 0;
      if (hasSummary || hasArtifacts) usableResults++;
    }
    if (
      (parsed.status === "completed" || parsed.status === "partial") &&
      typeof parsed.omittedResults === "number" &&
      Number.isSafeInteger(parsed.omittedResults) &&
      parsed.omittedResults > 0
    ) {
      // 工具输出在批量总预算下可能只保留 omittedResults。顶层终态已证明
      // 这些结果可用，不能因为文本被预算裁剪就误判为整批失败并重复委派。
      usableResults += parsed.omittedResults;
    }
    return { usableResults, batchFailed };
  } catch {
    return { usableResults: 0, batchFailed: true };
  }
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
): Promise<readonly string[]> {
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
    return commit.changedPaths;
  } catch (err) {
    logger.warn({ err: String(err) }, "[FileHistory] 本轮文件 journal 提交失败");
    return [];
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
  /** 当前主会话的稳定模型路由标识。 */
  modelRouteId?: string;
  /** 可信宿主为每次子代理执行创建独立 Provider/Compactor。 */
  resolveSubagentModelRuntime?: SubagentModelRuntimeResolver;
  /**
   * 计划模式开关 (第 13 讲)。
   * 开启后,每次 run 动态用 PromptComposer 组装 System Prompt,
   * 注入"状态外部化强制规范",引导大模型读写 PLAN.md / TODO.md 管理长程任务。
   */
  planMode?: boolean;
  /** 当前 route 的统一上下文预算；未注入时仅保留旧 Compactor 兼容路径。 */
  contextBudget?: ContextBudget;
  /** 主动整理水位，默认为输入预算的 85%。 */
  autoCompactTriggerRatio?: number;
  /** 主循环最大轮次兜底(默认 50,防止失控烧穿 Token) */
  maxTurns?: number;
  /**
   * 字符级 ToolResult 投影压缩器；只在 token 超过主动水位时缩短旧结果。
   */
  compactor?: Compactor;
  /**
   * token 水位主动摘要器，也用于 Provider 真实 overflow 后的一次紧急压缩。
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
  /** 被 CostTracker 记账的主 Session，用于并发子代理成本结算。 */
  usageSession?: Session;
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
  /** 子代理完整报告写入器；超过常规摘要目标时先落盘，再向主上下文回灌预览。 */
  subagentReportArtifactWriter?: SubagentReportArtifactWriter;
  /**
   * 链路追踪器：记录决策树到 workspace traces 目录（第 19 讲）。
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
  /** Host pause gate. The engine awaits it only at boundaries where no tool is in flight. */
  waitAtSafeBoundary?: () => Promise<void>;
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
  /** 主会话 Hook 生命周期；子代 verifier/agent 不注入以防递归。 */
  hookService?: HookService;
  /** 为主工作区及隔离 worktree 构建同策略 Skill Catalog。 */
  skillLoaderFactory?: (workDir: string) => SkillLoader;
}

export interface SubagentExecutionRuntime {
  provider: LLMProvider;
  compactor?: Compactor;
  thinkingEffort: string;
  requestedModelRoute?: string;
  resolvedModelRoute?: string;
  source: "ephemeral" | "profile" | "parent";
  /** 该 Provider 写入用量的 Session；显式路由与父路由都应指向主 Session。 */
  usageSession?: Session;
  /** 仅兼容继承父 Provider 的旧路径；显式路由 Runtime 默认不做跨路由 fallback。 */
  onRateLimited?: (reporter: Reporter, signal?: AbortSignal) => LLMProvider | undefined;
}

export type SubagentModelRuntimeResolver = (
  request?: SubagentModelSelectionRequest,
) => SubagentExecutionRuntime;

/** 微型 OS 的核心驱动 */
export class AgentEngine implements AgentRunner {
  private provider: LLMProvider;
  private readonly registry: Registry;
  private readonly workDir: string;
  private readonly workspaceRoots?: WorkspaceRoots;
  private readonly systemPrompt: string;
  private readonly systemPromptFactory?: () => Promise<string>;
  private readonly thinkingEffort: string;
  private readonly modelRouteId?: string;
  private readonly resolveSubagentModelRuntime?: SubagentModelRuntimeResolver;
  // planMode 非 readonly:ExitPlanMode 审批通过后由 exitPlanMode() 置 false。
  private planMode: boolean;
  private readonly contextBudget?: ContextBudget;
  private readonly autoCompactTriggerRatio: number;
  private readonly maxTurns: number;
  private readonly compactor?: Compactor;
  private readonly fullCompactor?: FullCompactor;
  private readonly recovery: RecoveryManager;
  private readonly guardrail: ToolGuardrailController;
  private readonly budget: IterationBudget;
  private readonly usageSession?: Session;
  /**
   * Session 成本是累计值。多个子代理并发返回时，以高水位结算增量，
   * 避免每个请求都用自己的 costBefore 导致重复计费。
   */
  private readonly accountedSessionCostCNY = new WeakMap<Session, number>();
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
  private readonly observationProcessor?: ToolObservationProcessor;
  private readonly subagentReportArtifactWriter?: SubagentReportArtifactWriter;
  private readonly tracer?: Tracer;
  /**
   * Steer 队列(运行时注入引导文本)。host 持有同一实例在 run 期间 push。
   * 非 readonly:飞书等 host 由 factory 构造 engine 后,经 setSteerQueue 挂载。
   */
  private steerQueue?: SteerQueue;
  private readonly waitAtSafeBoundary?: () => Promise<void>;
  /** 非工具停止后续接回调(ROADMAP 3.7):host 可决定让 Agent 接着跑 */
  private readonly shouldContinueAfterStop?: AgentEngineOptions["shouldContinueAfterStop"];
  /** 凭证轮换回调(4.2):429 时切换 key 重建 provider;无多 key 时为 undefined */
  private readonly rebuildProvider?: () => LLMProvider | undefined;
  private readonly hookService?: HookService;
  private readonly skillLoaderFactory?: (workDir: string) => SkillLoader;

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
    this.modelRouteId = opts.modelRouteId;
    this.resolveSubagentModelRuntime = opts.resolveSubagentModelRuntime;
    this.planMode = opts.planMode ?? false;
    this.contextBudget = opts.contextBudget;
    this.autoCompactTriggerRatio =
      opts.autoCompactTriggerRatio ?? DEFAULT_AUTO_COMPACT_TRIGGER_RATIO;
    this.maxTurns = opts.maxTurns ?? 50;
    this.compactor = opts.compactor;
    this.fullCompactor = opts.fullCompactor;
    this.recovery = opts.recovery ?? new RecoveryManager();
    this.guardrail = new ToolGuardrailController(opts.guardrailOptions);
    this.budget = new IterationBudget({
      ...opts.budgetConfig,
      maxTurns: opts.budgetConfig?.maxTurns ?? this.maxTurns,
    });
    this.usageSession = opts.usageSession;
    this.goalManager = opts.goalManager;
    this.todoStore = opts.todoStore;
    this.toolDisclosure = opts.toolDisclosure;
    this.onTurn = opts.onTurn;
    this.onPlanExit = opts.onPlanExit;
    this.reporter = opts.reporter ?? new SilentReporter();
    this.observationProcessor = opts.observationProcessor;
    this.subagentReportArtifactWriter = opts.subagentReportArtifactWriter;
    this.tracer = opts.tracer;
    this.steerQueue = opts.steerQueue;
    this.waitAtSafeBoundary = opts.waitAtSafeBoundary;
    this.shouldContinueAfterStop = opts.shouldContinueAfterStop;
    this.rebuildProvider = opts.rebuildProvider;
    this.hookService = opts.hookService;
    this.skillLoaderFactory = opts.skillLoaderFactory;
  }

  /**
   * 为单次运行构造绑定 Reporter 的流式 Provider 视图。
   *
   * Reporter 是调用级状态，不能存在 AgentEngine 的可变字段上：同一 Engine
   * 可能并行运行多个子代理，共享 reporter 会把 child delta 泄漏到主流或
   * 另一个 child。这个包装器每次 generate 都闭包当前调用的 sink，无全局可变状态。
   */
  private providerForReporter(
    provider: LLMProvider,
    reporter: Reporter,
    signal?: AbortSignal,
  ): LLMProvider {
    const generateStreamFn = provider.generateStream;
    if (!generateStreamFn) return provider;
    return {
      generate: (msgs: Message[], tools: ToolDefinition[], options?: LLMProviderRequestOptions) =>
        generateStreamFn.call(
          provider,
          msgs,
          tools,
          (delta: string) => {
            if (!signal?.aborted) reporter.onTextDelta?.(delta);
          },
          options,
        ),
      get modelName() {
        return provider.modelName;
      },
      ...(provider.isRetryableError
        ? { isRetryableError: provider.isRetryableError.bind(provider) }
        : {}),
      generateStream: generateStreamFn.bind(provider),
    };
  }

  private rotateProvider(reporter: Reporter, signal?: AbortSignal): LLMProvider | undefined {
    const provider = this.rebuildProvider?.();
    if (!provider) return undefined;
    this.provider = provider;
    return this.providerForReporter(provider, reporter, signal);
  }

  /**
   * 组装本轮 System Prompt。
   * Plan Mode 开启时,每次 run 动态用 PromptComposer 重新组装,
   * 以反映工作区最新的 AGENTS.md / Skills / 外部化规范状态;
   * 关闭时使用构造时固定的 systemPrompt。
   */
  private async buildSystemPrompt(signal?: AbortSignal): Promise<string> {
    if (this.systemPromptFactory) {
      return this.systemPromptFactory();
    }
    if (this.planMode) {
      // planMode 时用 PromptComposer 动态组装;goalManager / todoStore 单例注入,
      // 让 active goal 与最新 todo 状态在每轮 prompt 中浮现(对齐 host 注入范式)。
      const opts: ConstructorParameters<typeof PromptComposer>[2] = {};
      if (this.goalManager) opts.goalManager = this.goalManager;
      if (this.todoStore) opts.todoStore = this.todoStore;
      if (this.hookService) {
        opts.onInstructionsLoaded = async (paths) => {
          await this.hookService?.dispatch("InstructionsLoaded", { paths }, { signal });
        };
      }
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

  /** 子代 Agent 局部上下文的响应式降级次数；主 Agent 不使用此常量。 */
  private static readonly MAX_OVERFLOW_RETRY = 3;
  /** 每轮重试的字符预算降级系数(1.0 → 0.6 → 0.4 → 0.25) */
  private static readonly OVERFLOW_BUDGET_FACTORS = [1.0, 0.6, 0.4, 0.25] as const;
  /**
   * 单轮工具并发上限(对齐 hermes _MAX_TOOL_WORKERS=8)。
   * 超出的任务进 queued 等名额释放,不报错不丢弃,保序返回。
   */
  private static readonly MAX_TOOL_CONCURRENCY = 8;

  private async prepareModelContext(
    session: Session,
    systemPrompt: string,
    tools: ToolDefinition[],
    span?: Span,
    signal?: AbortSignal,
    allowFullCompaction = true,
  ): Promise<Message[]> {
    signal?.throwIfAborted();
    const rawHistory = session.getModelContext();
    const context = sanitizeToolPairs([{ role: "system", content: systemPrompt }, ...rawHistory]);

    // Compatibility for embedders/tests that have not yet supplied a model profile.
    if (!this.contextBudget) {
      return this.compactor ? this.compactor.compactToBudget(context) : context;
    }

    const budget = this.contextBudget.inputBudgetTokens;
    const triggerTokens = Math.floor(budget * this.autoCompactTriggerRatio);
    const beforeTokens = estimateModelInputTokens(context, tools);
    if (beforeTokens <= triggerTokens) return context;

    const targetRetainedTokens = Math.max(
      1,
      Math.floor(budget * DEFAULT_RETAINED_CONTEXT_RATIO),
    );
    const projectedHistory = context.slice(1);
    const protectedCut = findSafeCompactionCut(projectedHistory, targetRetainedTokens);
    const protectFromIndex = protectedCut ? protectedCut.compactedCount + 1 : context.length;
    const toolSchemaTokens = beforeTokens - estimateMessagesTokens(context);
    const projectionTargetTokens = Math.max(0, triggerTokens - toolSchemaTokens);
    const projected = this.compactor
      ? this.compactor.compactOldToolResults(context, {
          protectFromIndex,
          targetTokens: projectionTargetTokens,
        })
      : context;
    const projectedTokens = estimateModelInputTokens(projected, tools);
    logger.info(
      {
        trigger: "watermark",
        beforeTokens,
        projectedTokens,
        budget,
        triggerTokens,
        toolSchemaTokens,
        projectionTargetTokens,
        protectFromIndex,
      },
      "[Engine] 上下文超过主动水位，已缩短旧 ToolResult 投影",
    );
    span?.addAttributes({
      contextCompactionTrigger: "watermark",
      contextTokensBefore: beforeTokens,
      contextTokensAfterProjection: projectedTokens,
      contextInputBudgetTokens: budget,
      contextTriggerTokens: triggerTokens,
      contextToolSchemaTokens: toolSchemaTokens,
      contextProjectionTargetTokens: projectionTargetTokens,
      contextProtectedFromIndex: protectFromIndex,
    });
    if (projectedTokens <= triggerTokens) return projected;

    if (allowFullCompaction && this.fullCompactor) {
      const persistentCut = findSafeCompactionCut(rawHistory, targetRetainedTokens);
      const historyCountBefore = session.length;
      const compacted = await this.fullCompactor.compact(
        session,
        {
          inputBudgetTokens: budget,
          targetRetainedTokens,
          trigger: "auto",
        },
        signal,
      );
      signal?.throwIfAborted();
      if (compacted) {
        span?.addAttributes({
          contextFullCompaction: true,
          contextCompactionTrigger: "watermark",
          contextCompactionCutIndex: persistentCut?.compactedCount,
          contextCompactedMessageCount: persistentCut?.compactedCount,
          contextRetainedMessageCount: persistentCut
            ? historyCountBefore - persistentCut.compactedCount
            : undefined,
          contextTokensAfterFullCompaction: estimateMessagesTokens(session.getHistory()),
        });
        return this.prepareModelContext(session, systemPrompt, tools, span, signal, false);
      }
    }

    if (projectedTokens <= budget) return projected;
    const beforeChars = estimateTraceLength(context);
    const afterChars = estimateTraceLength(projected);
    throw new ContextCompactionError(
      beforeChars,
      afterChars,
      estimateTokenBudgetAsChars(budget),
    );
  }

  /** Provider overflow 只允许一次更紧的模型摘要重试。 */
  private async generateWithOverflowRetry(
    session: Session,
    systemPrompt: string,
    tools: ToolDefinition[],
    baseContext: Message[],
    reporter: Reporter,
    span?: Span,
    signal?: AbortSignal,
    allowEmergencyCompaction = true,
  ): Promise<Message> {
    const generate = (context: Message[]) =>
      generateWithRetry(this.providerForReporter(this.provider, reporter, signal), context, tools, {
        signal,
        onRetry: this.makeRetryReporter(span),
        onRateLimited: () => this.rotateProvider(reporter, signal),
      });
    try {
      return await generate(baseContext);
    } catch (err) {
      if (
        !(err instanceof ContextOverflowError) ||
        !this.fullCompactor ||
        !allowEmergencyCompaction
      ) {
        throw err;
      }
      signal?.throwIfAborted();
      const inputBudgetTokens =
        this.contextBudget?.inputBudgetTokens ??
        Math.max(1, Math.floor((this.compactor?.maxChars ?? 4_000) / 4));
      const historyTokens = estimateMessagesTokens(session.getHistory());
      const targetRetainedTokens = Math.max(
        1,
        Math.min(
          Math.floor(inputBudgetTokens * EMERGENCY_RETAINED_CONTEXT_RATIO),
          Math.floor(historyTokens * 0.5),
        ),
      );
      logger.warn(
        { trigger: "provider-overflow", inputBudgetTokens, targetRetainedTokens, historyTokens },
        "[Engine] Provider 报告上下文溢出，执行一次紧急 FullCompaction",
      );
      const historyBefore = session.getHistory();
      const emergencyCut = findSafeCompactionCut(historyBefore, targetRetainedTokens);
      const compacted = await this.fullCompactor.compact(
        session,
        { inputBudgetTokens, targetRetainedTokens, trigger: "overflow" },
        signal,
      );
      if (!compacted) throw err;
      const retryContext = await this.prepareModelContext(
        session,
        systemPrompt,
        tools,
        span,
        signal,
        false,
      );
      span?.addAttributes({
        overflowRetry: true,
        overflowRetryAttempt: 1,
        fullCompaction: true,
        fullCompactionRetainedTokens: targetRetainedTokens,
        fullCompactionCutIndex: emergencyCut?.compactedCount,
        fullCompactionCompactedMessageCount: emergencyCut?.compactedCount,
        fullCompactionRetainedMessageCount: emergencyCut
          ? historyBefore.length - emergencyCut.compactedCount
          : undefined,
        fullCompactionTokensBefore: historyTokens,
        fullCompactionTokensAfter: estimateMessagesTokens(session.getHistory()),
      });
      return generate(retryContext);
    }
  }

  /**
   * 启动 Agent 的生命周期(Session 驱动)。
   *
   * 引擎不再"用完即毁":它以传入的 Session 作为上下文承载体,
   * 从 Session.getModelContext 恢复完整协议历史,而非从零开始。
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
    const run = () => this.runInMainCompactorScope(session, runtimeReporter, runtimeTracer, signal);
    const execute = () => (this.compactor ? this.compactor.runInMainScope(run) : run());
    // Tests and explicit in-memory sessions intentionally skip durable runtime facts.
    // Production sessions get a separate run ledger; Session JSONL stays focused on memory.
    if (!session.recordStore) return execute();
    return this.runWithLedger(session, execute, signal);
  }

  private async runWithLedger(
    session: Session,
    execute: () => Promise<Message[]>,
    signal?: AbortSignal,
  ): Promise<Message[]> {
    const baseDir = resolvePicoPaths(session.workDir).workspace.runs;
    await RunLedger.reconcileIncompleteRuns({ baseDir, sessionId: session.id });
    const ledger = await RunLedger.start({
      baseDir,
      sessionId: session.id,
      workDir: session.workDir,
    });
    try {
      const messages = await execute();
      await ledger.finish("completed");
      return messages;
    } catch (error) {
      const status: RunTerminalStatus =
        signal?.aborted || isAbortError(error) ? "cancelled" : "failed";
      try {
        await ledger.finish(status, runFailureReason(error));
      } catch (ledgerError) {
        throw new AggregateError(
          [error, ledgerError],
          "Agent run failed and its terminal runtime fact could not be persisted",
          { cause: ledgerError },
        );
      }
      throw error;
    }
  }

  private async runInMainCompactorScope(
    session: Session,
    runtimeReporter?: Reporter,
    runtimeTracer?: Tracer,
    signal?: AbortSignal,
  ): Promise<Message[]> {
    signal?.throwIfAborted();
    await session.flushPersistence();
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
    const systemPrompt = await this.buildSystemPrompt(signal);
    signal?.throwIfAborted();

    const runHistory = session.getHistory();
    const firstTurnDelegationPolicy = createFirstTurnDelegationPolicy(
      isSubagentCompletionWake(runHistory) ? "" : latestVisibleUserInput(runHistory),
    );
    let requiredFirstDelegationPending =
      firstTurnDelegationPolicy.kind === "required-first-delegation";
    let requiredFirstDelegationAttempts = 0;
    let beforeLen = session.length;
    let turnCount = 0;
    let exhaustedReason: string | undefined;
    let hardResetTriggered = false;
    let exploreSynthesisOnly = false;
    let exploreSynthesisToolRetries = 0;
    let requiredDelegationRecoveryPending = false;
    let requiredDelegationRecoveryExploreOnly = false;
    let consecutiveHookStopBlocks = 0;
    const userRewindPointId = session.fileHistory.snapshots.findLast(
      (snapshot) =>
        snapshot.messageId === session.fileHistory.currentMessageId &&
        snapshot.userPrompt !== undefined,
    )?.messageId;
    const journalRoots =
      this.workspaceRoots?.list() ?? (this.registry.setPreWriteHook ? [this.workDir] : []);
    let runFileJournal: FileHistoryJournal | undefined;
    let activeFileJournal: FileHistoryJournal | undefined;
    // The Main Loop:心跳开始 (ReAct 循环)
    try {
      for (;;) {
        signal?.throwIfAborted();
        await this.waitAtSafeBoundary?.();
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
          const requiredFirstDelegationActive =
            requiredFirstDelegationPending &&
            firstTurnDelegationPolicy.kind === "required-first-delegation" &&
            allTools.some((tool) => tool.name === firstTurnDelegationPolicy.toolName);
          // explore-only required 委派收口后不再给主模型任何工具，
          // 从能力边界上阻断它重复阅读项目。worker/mixed 批次不受影响。
          const providerTools = exploreSynthesisOnly
            ? []
            : requiredFirstDelegationActive || requiredDelegationRecoveryPending
              ? allTools.filter((tool) => tool.name === "delegate_task")
              : availableTools;

          // 主 Agent 默认投影完整 Session 历史。只有超过 token 水位时，
          // 才先缩短旧 ToolResult，再在安全工具边界做持久化摘要。
          const contextChars = estimateTraceLength([
            { role: "system", content: systemPrompt },
            ...session.getHistory(),
          ]);
          let compactedContext: Message[];
          try {
            compactedContext = await this.prepareModelContext(
              session,
              systemPrompt,
              providerTools,
              turnSpan,
              signal,
            );
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
              await session.truncateTo(beforeLen - 1);
              // 硬重置改变了 session 起点,更新 beforeLen 让返回值切片正确
              beforeLen = session.length - 1;
              continue;
            }
            throw err;
          }
          const compactedChars = estimateTraceLength(compactedContext);
          turnSpan?.addAttributes({
            contextMessageCount: session.length + 1,
            compactedMessageCount: compactedContext.length,
            contextChars,
            compactedChars,
            availableToolCount: providerTools.length,
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
          if (
            requiredFirstDelegationActive &&
            !requiredDelegationRecoveryPending &&
            firstTurnDelegationPolicy.kind === "required-first-delegation"
          ) {
            compactedContext.push({
              role: "user",
              content: firstTurnDelegationPolicy.hiddenConstraint,
              providerData: {
                picoKind: "required_first_delegation",
                picoHiddenFromTranscript: true,
              },
            });
          }
          const actionSpan = turnSpan?.startChild("LLM.Action", {
            inputMessageCount: compactedContext.length,
            availableToolCount: providerTools.length,
            ...(this.toolDisclosure ? { totalToolCount: allTools.length } : {}),
          });
          let responseMsg: Message;
          const costBefore = session.totalCostCNY;
          try {
            responseMsg = await this.generateWithOverflowRetry(
              session,
              systemPrompt,
              providerTools,
              compactedContext,
              reporter,
              actionSpan,
              signal,
              !hardResetTriggered,
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
            if (err instanceof ContextOverflowError && !hardResetTriggered) {
              hardResetTriggered = true;
              const staticTokens = estimateModelInputTokens(
                [{ role: "system", content: systemPrompt }],
                providerTools,
              );
              logger.error(
                {
                  staticTokens,
                  inputBudgetTokens: this.contextBudget?.inputBudgetTokens,
                  currentRequestChars: session.getHistory().at(-1)?.content.length ?? 0,
                },
                "[Engine] 紧急摘要重试后仍溢出；系统提示、工具 Schema 或当前请求不可再压缩，触发硬重置",
              );
              await session.truncateTo(beforeLen - 1);
              beforeLen = session.length - 1;
              continue;
            }
            throw err;
          } finally {
            actionSpan?.end();
          }

          const toolCalls = responseMsg.toolCalls ?? [];
          if (exploreSynthesisOnly && toolCalls.length > 0) {
            reporter.onAssistantResponseSuppressed?.("explore-synthesis-retry");
            // 某些 provider/模型可能在 tools=[] 时仍幻觉产生 tool_calls。
            // 保留 assistant tool call 与逐一 tool result 的协议配对，但绝不进入 Registry。
            const rejectedResponse: Message = {
              ...responseMsg,
              content: "",
              providerData: {
                ...responseMsg.providerData,
                picoKind: "explore_synthesis_tool_rejected",
                picoHiddenFromTranscript: true,
              },
            };
            await session.commitMessages(rejectedResponse);
            this.onTurn?.({ turn: turnCount, message: rejectedResponse });
            await session.commitMessages(...toolCalls.map(buildSynthesisToolRejection));

            if (exploreSynthesisToolRetries >= MAX_EXPLORE_SYNTHESIS_TOOL_RETRIES) {
              const failedResponse: Message = {
                role: "assistant",
                content: EXPLORE_SYNTHESIS_FAILED_MESSAGE,
              };
              await session.commitMessages(failedResponse);
              await this.reportMessage(reporter, failedResponse.content, signal);
              reporter.onFinish();
              break;
            }

            exploreSynthesisToolRetries++;
            await session.commitMessages({
              role: "user",
              content: EXPLORE_SYNTHESIS_RETRY_PROMPT,
              providerData: {
                picoKind: "explore_synthesis_retry",
                picoHiddenFromTranscript: true,
              },
            });
            continue;
          }
          if (exploreSynthesisOnly) {
            exploreSynthesisOnly = false;
            exploreSynthesisToolRetries = 0;
          }
          const requiredDelegationIndex = findRequiredDelegationIndex(toolCalls);
          const requiredDelegation =
            requiredDelegationIndex !== undefined ? toolCalls[requiredDelegationIndex] : undefined;
          const requestedDelegationCount =
            firstTurnDelegationPolicy.kind === "required-first-delegation"
              ? firstTurnDelegationPolicy.intent.requestedCount
              : "unspecified";
          const acceptedRecoveryDelegation =
            requiredDelegation !== undefined && requiredDelegationTaskCount(requiredDelegation) > 0;
          const acceptedRequiredFirstDelegation =
            requiredDelegation !== undefined &&
            (requiredDelegationRecoveryPending
              ? acceptedRecoveryDelegation
              : satisfiesRequestedDelegationCount(requiredDelegation, requestedDelegationCount));
          if (requiredDelegationRecoveryPending && !acceptedRecoveryDelegation) {
            reporter.onAssistantResponseSuppressed?.("delegation-first-retry");
            const rejectedResponse: Message = {
              ...responseMsg,
              content: "",
              providerData: {
                ...responseMsg.providerData,
                picoKind: "required_delegation_recovery_rejected",
                picoHiddenFromTranscript: true,
              },
            };
            await session.commitMessages(rejectedResponse);
            this.onTurn?.({ turn: turnCount, message: rejectedResponse });
            await session.commitMessages(...toolCalls.map(buildDelegationRecoveryToolRejection));
            const failedResponse: Message = {
              role: "assistant",
              content: requiredFirstDelegationActive
                ? REQUIRED_FIRST_DELEGATION_FAILED_MESSAGE
                : REQUIRED_DELEGATION_RECOVERY_FAILED_MESSAGE,
            };
            await session.commitMessages(failedResponse);
            await this.reportMessage(reporter, failedResponse.content, signal);
            reporter.onFinish();
            break;
          }
          if (requiredFirstDelegationActive && !acceptedRequiredFirstDelegation) {
            reporter.onAssistantResponseSuppressed?.("delegation-first-retry");
            const rejectedResponse: Message = {
              ...responseMsg,
              content: "",
              providerData: {
                ...responseMsg.providerData,
                picoKind: "required_first_delegation_rejected",
                picoHiddenFromTranscript: true,
              },
            };
            await session.commitMessages(rejectedResponse);
            this.onTurn?.({ turn: turnCount, message: rejectedResponse });
            await session.commitMessages(...toolCalls.map(buildRequiredFirstToolRejection));
            requiredFirstDelegationAttempts++;

            if (requiredFirstDelegationAttempts >= MAX_REQUIRED_FIRST_DELEGATION_ATTEMPTS) {
              const failedResponse: Message = {
                role: "assistant",
                content: REQUIRED_FIRST_DELEGATION_FAILED_MESSAGE,
              };
              await session.commitMessages(failedResponse);
              await this.reportMessage(reporter, failedResponse.content, signal);
              reporter.onFinish();
              break;
            }
            continue;
          }
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
          await session.commitMessages(responseMsg);
          compactedContext.push(responseMsg);
          this.onTurn?.({ turn: turnCount, message: responseMsg });
          if (exhaustedReason) {
            break;
          }

          // 模型回复纯文本时广播 (通常是思考过程或最终结果)
          if (responseMsg.content) {
            await this.reportMessage(reporter, responseMsg.content, signal);
          }

          // 3. 退出条件:模型没有请求任何工具调用,说明任务完成,挂起等待下一条指令
          if (toolCalls.length === 0) {
            const stopHookDecision = await this.hookService?.dispatch(
              "Stop",
              { reason: "model_stop", response: responseMsg.content },
              { signal },
            );
            signal?.throwIfAborted();
            const hookRequestsContinuation = stopHookDecision?.decision === "deny";
            const hookCanContinue = hookRequestsContinuation && consecutiveHookStopBlocks < 3;
            if (hookCanContinue) consecutiveHookStopBlocks++;
            else if (!hookRequestsContinuation) consecutiveHookStopBlocks = 0;
            // 3.7: host 可决定续接(返回 {continue:true} 则不退出,append 续接消息继续)
            const decision = hookCanContinue
              ? {
                  continue: true,
                  continuePrompt:
                    stopHookDecision?.additionalContext ??
                    stopHookDecision?.reason ??
                    "Stop hook 要求继续推进任务。",
                }
              : await this.shouldContinueAfterStop?.({
                  turn: turnCount,
                  lastMessage: responseMsg,
                });
            signal?.throwIfAborted();

            // steer 可能在最后一次 provider 调用期间到达。必须在真正 stop
            // 前同步 drain 并续接本轮，否则它会泄漏到下一次无关 run。
            const stopSteers = this.steerQueue?.drain() ?? [];
            for (const text of stopSteers) {
              await session.commitMessages({
                role: "user",
                content: text,
                providerData: { picoKind: "steer" },
              });
            }
            if (decision?.continue) {
              await session.commitMessages({
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

          // A pause requested during provider inference takes effect before any new tool starts.
          // A pause requested while tools are running is observed at the next loop boundary,
          // after the whole scheduled batch and file journal have safely settled.
          await this.waitAtSafeBoundary?.();
          signal?.throwIfAborted();

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
          const hasFileEffects = fileSideEffectKinds.some((kind) => kind !== "none");
          if (hasFileEffects && journalRoots.length > 0) {
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
              await session.commitMessages(...abortedObservations);
              const settledReminders = settledResults.flatMap((result) =>
                result?.reminder ? [result.reminder] : [],
              );
              if (settledReminders.length > 0) {
                await session.commitMessages(...settledReminders);
              }
            }
            throw err;
          } finally {
            scheduler.dispose();
            if (turnFileJournal) {
              const changedPaths = await commitFileJournal(
                session,
                turnFileJournal,
                currentMessageId,
              );
              if (changedPaths.length > 0) {
                await this.hookService?.dispatch("FileChanged", {
                  paths: changedPaths,
                  origin: "internal",
                });
              }
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
          await session.commitMessages(...observations);
          await this.hookService?.dispatch(
            "PostToolBatch",
            {
              tools: toolCalls.map((call, index) => {
                const observation = observations[index]!;
                return {
                  tool_name: call.name,
                  tool_input: parseHookToolArguments(call.arguments),
                  tool_call_id: call.id,
                  ok: observation.providerData?.[PICO_TOOL_RESULT_ERROR_KEY] !== true,
                  output: observation.content,
                };
              }),
            },
            { signal },
          );
          if (requiredDelegation && requiredDelegationIndex !== undefined) {
            const assessment = assessRequiredDelegationResult(
              observations[requiredDelegationIndex]!,
            );
            const hasUsableResult = !assessment.batchFailed && assessment.usableResults > 0;
            if (!hasUsableResult) {
              exploreSynthesisOnly = false;
              exploreSynthesisToolRetries = 0;
              if (requiredDelegationRecoveryPending) {
                const failedResponse: Message = {
                  role: "assistant",
                  content: requiredFirstDelegationActive
                    ? REQUIRED_FIRST_DELEGATION_FAILED_MESSAGE
                    : REQUIRED_DELEGATION_RECOVERY_FAILED_MESSAGE,
                };
                await session.commitMessages(failedResponse);
                await this.reportMessage(reporter, failedResponse.content, signal);
                reporter.onFinish();
                break;
              }

              requiredDelegationRecoveryPending = true;
              requiredDelegationRecoveryExploreOnly =
                isExploreOnlyRequiredDelegation(requiredDelegation);
              await session.commitMessages({
                role: "user",
                content: REQUIRED_DELEGATION_RECOVERY_PROMPT,
                providerData: {
                  picoKind: "required_delegation_recovery",
                  picoHiddenFromTranscript: true,
                },
              });
              continue;
            }

            const currentExploreOnly = isExploreOnlyRequiredDelegation(requiredDelegation);
            exploreSynthesisOnly = requiredDelegationRecoveryPending
              ? requiredDelegationRecoveryExploreOnly && currentExploreOnly
              : currentExploreOnly;
            requiredDelegationRecoveryPending = false;
            requiredDelegationRecoveryExploreOnly = false;
            if (requiredFirstDelegationActive) {
              requiredFirstDelegationPending = false;
              requiredFirstDelegationAttempts = 0;
            }
            exploreSynthesisToolRetries = 0;
            await session.commitMessages({
              role: "user",
              content: exploreSynthesisOnly
                ? EXPLORE_SYNTHESIS_PROMPT
                : "[DELEGATION JOIN] required 子代理已全部收口（结果可能包含失败）。" +
                  "请吸收上述聚合结果并继续集成、定点验证或统一总结；" +
                  "不要重复子代理已完成范围的大规模探索。",
              providerData: {
                picoKind: exploreSynthesisOnly ? "explore_delegation_synthesis" : "delegation_join",
                picoHiddenFromTranscript: true,
              },
            });
          }
          if (reminderMessages.length > 0) {
            await session.commitMessages(...reminderMessages);
          }

          // ====================================================================
          // 【Steer C 点】(ROADMAP 3.2):工具结果落地后,drain 整个 steer 队列,
          // 把每条引导文本落成一条 user 消息写进 session。
          // 下一轮 getModelContext 自动浮现 → 永久可见。drain 清空队列,
          // 避免重复注入。与上方 A 点(本轮临时 peek)配合形成"先瞥见后落盘"。
          // ====================================================================
          const steerTexts = this.steerQueue?.drain() ?? [];
          for (const text of steerTexts) {
            await session.commitMessages({
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
        const changedPaths = await commitFileJournal(session, runFileJournal, userRewindPointId);
        if (changedPaths.length > 0) {
          await this.hookService?.dispatch("FileChanged", {
            paths: changedPaths,
            origin: "internal",
          });
        }
      }
      activeFileJournal = undefined;
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
        await this.hookService?.dispatch(
          "PermissionDenied",
          {
            tool_name: toolCall.name,
            tool_input: parseHookToolArguments(toolCall.arguments),
            tool_call_id: toolCall.id,
            source: "guardrail",
            reason: guardDecision.reason ?? "未知 Guardrail 原因",
          },
          { signal },
        );
        result = {
          toolCallId: toolCall.id,
          output: `执行被 Guardrail 阻断。原因: ${guardDecision.reason ?? "未知"}`,
          isError: true,
        };
      } else {
        signal?.throwIfAborted();
        result = await this.registry.execute(toolCall, {
          signal,
          onOutput: ({ stream, chunk }) => {
            if (!signal?.aborted) {
              reporter.onToolOutput?.(toolCall.name, stream, chunk, toolCall.id);
            }
          },
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
    await session.commitMessages({
      role: "user",
      content: gracePrompt,
      providerData: { picoKind: "grace", picoHiddenFromTranscript: true },
    });
    const graceSpan = parentSpan?.startChild("LLM.GraceCall", {
      reason,
      availableToolCount: 0,
    });
    try {
      const context = await this.prepareModelContext(
        session,
        systemPrompt,
        [],
        graceSpan,
        signal,
      );
      const costBefore = session.totalCostCNY;
      const response = await withProviderCallContext({ purpose: "grace" }, () =>
        this.generateWithOverflowRetry(
          session,
          systemPrompt,
          [],
          context,
          reporter,
          graceSpan,
          signal,
        ),
      );
      signal?.throwIfAborted();
      recordLlmResponse(graceSpan, response);
      // Grace Call is the one permitted over-budget summary. It does not consume another
      // goal turn, but its measurable token/cost usage remains part of the goal totals.
      this.consumeResponseBudget(session, response, costBefore);
      await session.commitMessages(response);
      if (response.content) {
        await this.reportMessage(reporter, response.content, signal);
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

    const accountedCost = this.accountedSessionCostCNY.get(session) ?? costBefore;
    const observedCost = session.totalCostCNY;
    const costDelta = Math.max(0, observedCost - accountedCost);
    this.accountedSessionCostCNY.set(session, Math.max(accountedCost, observedCost));
    if (costDelta > 0) {
      decisions.push(this.budget.consumeCost(costDelta));
      decisions.push(this.goalManager?.consumeCost(costDelta) ?? { allowed: true });
    }
    return decisions.find((decision) => !decision.allowed) ?? { allowed: true };
  }

  private currentSubagentBudgetDecision(): BudgetDecision {
    const decisions = [
      this.budget.currentDecision(),
      this.goalManager?.currentBudgetDecision() ?? { allowed: true },
    ];
    return decisions.find((decision) => !decision.allowed) ?? { allowed: true };
  }

  private consumeSubagentResponseBudget(
    runtime: SubagentExecutionRuntime,
    response: Message,
    costBefore: number,
  ): BudgetDecision {
    const session = runtime.usageSession ?? this.usageSession;
    if (session) return this.consumeResponseBudget(session, response, costBefore);

    // 非 Runtime 宿主可以直接构造 AgentEngine，此时没有可用的 Session 成本账本；
    // 仍严格结算 Provider 返回的 Token usage。
    if (!response.usage) return this.currentSubagentBudgetDecision();
    const decisions = [
      this.budget.consumeUsage(response.usage),
      this.goalManager?.consumeUsage(response.usage) ?? { allowed: true },
    ];
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
    reporter: Reporter,
    runtime: SubagentExecutionRuntime,
    signal?: AbortSignal,
  ): Promise<Message> {
    if (!runtime.compactor) {
      // 无 Compactor:子代理无法降级,叠加普通重试层(溢出则原样抛出)
      return generateWithRetry(
        this.providerForReporter(runtime.provider, reporter, signal),
        contextHistory,
        tools,
        {
          signal,
          onRetry: this.makeRetryReporter(),
          ...(runtime.onRateLimited
            ? { onRateLimited: () => runtime.onRateLimited?.(reporter, signal) }
            : {}),
        },
      );
    }
    // 首轮:用默认预算压缩(attempt 0,系数 1.0)
    let context = this.compactSubContext(contextHistory, runtime.compactor);
    for (let attempt = 0; ; attempt++) {
      try {
        // 【集成点】同 generateWithOverflowRetry,叠加普通重试层在内,
        // 响应式压缩在外(子代理版仅降字符预算,不改 WorkingMemory 条数)。
        return await generateWithRetry(
          this.providerForReporter(runtime.provider, reporter, signal),
          context,
          tools,
          {
            signal,
            onRetry: this.makeRetryReporter(),
            ...(runtime.onRateLimited
              ? { onRateLimited: () => runtime.onRateLimited?.(reporter, signal) }
              : {}),
          },
        );
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
        const newBudget = Math.max(1, Math.floor(runtime.compactor.maxChars * budgetFactor));
        // contextHistory 已持久化上一档压缩结果；继续缩紧预算时从该结构化历史降级，
        // 避免下一轮又从未压缩原文开始并重复探索。
        context = this.compactSubContext(contextHistory, runtime.compactor, newBudget);
        logger.warn(
          { attempt: attempt + 1, budget: newBudget },
          `[Subagent] ⚠ 上下文溢出,响应式降级重试(attempt ${attempt + 1}):预算 ${newBudget} 字符`,
        );
      }
    }
  }

  /**
   * 子代理上下文压缩 + 硬重置兜底。
   *
   * 子代理没有 Session，因此压缩结果必须回写到这次 runSub 的局部历史；
   * 否则 provider 本轮虽看到压缩请求，下轮仍会从未压缩原文重新开始。
   * compactToBudget 完全失败时，保留 system/task 和一条结构化 evidence snapshot；
   * 若连 snapshot 也放不下，才退化到只保留 system/task。
   */
  private compactSubContext(
    contextHistory: Message[],
    compactor: Compactor,
    budget?: number,
  ): Message[] {
    // system prompt 不允许被 Compactor 裁剪。动态 workspace/tool 纪律可能使它大于
    // 最低降级系数算出的预算；若不钳制可行下限，会在真正的 provider
    // overflow 重试之前误抛 ContextCompactionError。
    const effectiveBudget =
      budget === undefined
        ? undefined
        : Math.max(budget, estimateTraceLength(contextHistory.slice(0, 1)) + 1);
    try {
      const compacted =
        effectiveBudget !== undefined
          ? compactor.compactToBudget(contextHistory, effectiveBudget)
          : compactor.compactToBudget(contextHistory);
      return persistSubagentContext(contextHistory, compacted);
    } catch (err) {
      if (err instanceof ContextCompactionError) {
        const evidenceSnapshot = buildSubagentEvidenceSnapshot(contextHistory);
        logger.warn(
          {
            beforeChars: err.beforeChars,
            afterChars: err.afterChars,
            maxChars: err.maxChars,
            evidenceSnapshot: evidenceSnapshot !== undefined,
          },
          `[Subagent] ⚠ 压缩彻底失败,重置为任务指令与结构化证据快照`,
        );
        const taskBoundary = contextHistory.slice(0, 2);
        const reset = evidenceSnapshot
          ? [
              ...taskBoundary,
              {
                role: "user" as const,
                content: evidenceSnapshot,
                providerData: {
                  picoKind: "subagent_evidence_snapshot",
                  picoHiddenFromTranscript: true,
                },
              },
            ]
          : taskBoundary;
        try {
          const compactedReset =
            effectiveBudget !== undefined
              ? compactor.compactToBudget(reset, effectiveBudget)
              : compactor.compactToBudget(reset);
          return persistSubagentContext(contextHistory, compactedReset);
        } catch (resetError) {
          if (!(resetError instanceof ContextCompactionError) || !evidenceSnapshot) {
            throw resetError;
          }
          const compactedTask =
            effectiveBudget !== undefined
              ? compactor.compactToBudget(taskBoundary, effectiveBudget)
              : compactor.compactToBudget(taskBoundary);
          return persistSubagentContext(contextHistory, compactedTask);
        }
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
   * - 专属 System/Task Prompt 注入可信 workspace root、实际工具定义与 Skill 索引
   * - maxSubTurns 最后一轮预留为 tools=[] FINALIZE，耗尽时以 partial 返回证据
   * - 正常退出条件:不调工具且生成非空总结
   *
   * @returns 子智能体的纯文本总结汇报及外部化产物引用
   */
  private async reportMessage(
    reporter: Reporter,
    content: string,
    signal?: AbortSignal,
  ): Promise<void> {
    reporter.onMessage(content);
    await this.hookService?.dispatch("MessageDisplay", { role: "assistant", content }, { signal });
  }

  async runSub(
    taskPrompt: string,
    readOnlyRegistry: Registry,
    reporter?: Reporter,
    opts: SubagentRunOptions = {},
  ): Promise<SubagentResult> {
    const runtime = this.subagentExecutionRuntime(opts.modelSelection);
    if (runtime.resolvedModelRoute) {
      reporter?.onSubagentModelResolved?.({
        ...(runtime.requestedModelRoute
          ? { requestedModelRoute: runtime.requestedModelRoute }
          : {}),
        resolvedModelRoute: runtime.resolvedModelRoute,
        ...(runtime.thinkingEffort ? { thinkingEffort: runtime.thinkingEffort } : {}),
        source: runtime.source,
      });
    }
    const run = () =>
      this.runSubInIsolatedCompactorScope(taskPrompt, readOnlyRegistry, runtime, reporter, opts);
    const runAttributed = () =>
      withProviderCallContext({ purpose: "subagent", ...(opts.usageAttribution ?? {}) }, () =>
        runtime.compactor ? runtime.compactor.runInIsolatedScope(run) : run(),
      );
    return runAttributed();
  }

  private subagentExecutionRuntime(
    request?: SubagentModelSelectionRequest,
  ): SubagentExecutionRuntime {
    if (this.resolveSubagentModelRuntime) return this.resolveSubagentModelRuntime(request);

    const requestedRoute = request?.ephemeralRouteId ?? request?.profileRouteId;
    const requestedThinking = request?.ephemeralThinkingEffort ?? request?.profileThinkingEffort;
    if (
      requestedRoute !== undefined &&
      requestedRoute !== "inherit" &&
      requestedRoute !== this.modelRouteId
    ) {
      throw new Error(`当前宿主没有可用的子代理模型路由器，无法切换到 ${requestedRoute}`);
    }
    if (requestedThinking !== undefined && requestedThinking !== this.thinkingEffort) {
      throw new Error(`当前宿主不能为子代理独立设置 thinking_effort=${requestedThinking}`);
    }
    return {
      provider: this.provider,
      ...(this.compactor ? { compactor: this.compactor } : {}),
      ...(this.usageSession ? { usageSession: this.usageSession } : {}),
      thinkingEffort: this.thinkingEffort,
      ...(requestedRoute ? { requestedModelRoute: requestedRoute } : {}),
      ...(this.modelRouteId || this.provider.modelName
        ? { resolvedModelRoute: this.modelRouteId ?? this.provider.modelName }
        : {}),
      source:
        request?.ephemeralRouteId !== undefined
          ? "ephemeral"
          : request?.profileRouteId !== undefined
            ? "profile"
            : "parent",
      onRateLimited: (reporter, signal) => this.rotateProvider(reporter, signal),
    };
  }

  /** 每个子代理保留注入 Compactor 的行为，但使用独立压缩进度。 */
  private async runSubInIsolatedCompactorScope(
    taskPrompt: string,
    readOnlyRegistry: Registry,
    runtime: SubagentExecutionRuntime,
    reporter?: Reporter,
    opts: SubagentRunOptions = {},
  ): Promise<SubagentResult> {
    const rep = reporter ?? new SilentReporter();
    const signal = opts.signal;
    signal?.throwIfAborted();
    logger.info(
      {
        task: taskPrompt.slice(0, 100),
        thinkingEffort: runtime.thinkingEffort,
        modelRoute: runtime.resolvedModelRoute,
      },
      `[Subagent] 🚀 拉起探路者,任务: ${taskPrompt.slice(0, 100)} (thinkingEffort: ${runtime.thinkingEffort})`,
    );

    const initialTools = readOnlyRegistry.getAvailableTools();
    const initialToolNames = new Set(initialTools.map((tool) => tool.name));
    // 委派层会传入 host/worktree 的可信运行目录；不从任务 context 或模型输出猜测根目录。
    const runtimeWorkspaceRoot = opts.workDir ?? this.workDir;
    const canViewSkills = initialToolNames.has("skill_view");
    const skillIndex = canViewSkills
      ? await (
          this.skillLoaderFactory?.(runtimeWorkspaceRoot) ?? new SkillLoader(runtimeWorkspaceRoot)
        ).loadAll()
      : "";
    signal?.throwIfAborted();

    // 子智能体专属 System Prompt:严厉警告必须用工具,不许凭空猜测。
    // 若工作区配置了 Skills,只注入 name/description 索引;正文仍由 skill_view 按需读取。
    // 支持调用方自定义:默认追加拼接(对标 kimi-code ROLE_ADDITIONAL),
    // systemPromptOverride=true 时完全覆盖(对标 hermes ephemeral_system_prompt)。
    const subSystemPrompt = buildSubagentSystemPrompt(
      initialTools,
      skillIndex,
      runtimeWorkspaceRoot,
      opts,
    );
    const effectiveTaskPrompt = buildSubagentTaskPrompt(runtimeWorkspaceRoot, taskPrompt);

    // 全新纯净上下文:不共享主 Agent 的 Session
    const contextHistory: Message[] = [
      { role: "system", content: subSystemPrompt },
      { role: "user", content: effectiveTaskPrompt },
    ];

    // maxTurns 可由调用方覆盖(默认 10)。最后一轮始终预留为 tools=[] 收口，
    // 不通过提高上限隐藏控制流问题。
    const maxSubTurns = Math.max(1, opts.maxTurns ?? 10);
    const depth = opts.depth ?? 0;
    const maxSpawnDepth = opts.maxSpawnDepth ?? 2;
    if (depth > maxSpawnDepth) {
      throw new Error(`子智能体超过最大委派深度 ${maxSpawnDepth}`);
    }
    let turnCount = 0;
    // 收集子代理探索期间被外部化的大型工具输出磁盘路径,回传给主 Agent 供回查。
    const artifactPaths: string[] = [];

    for (;;) {
      signal?.throwIfAborted();
      const availableBudget = this.currentSubagentBudgetDecision();
      if (!availableBudget.allowed) {
        return this.finalizeSubagentResult(
          "partial",
          `子代理已停止：${availableBudget.reason ?? "执行预算已用尽"}。`,
          artifactPaths,
          taskPrompt,
          runtimeWorkspaceRoot,
        );
      }
      turnCount++;
      const finalizing = turnCount >= maxSubTurns;
      if (finalizing) {
        contextHistory.push({
          role: "user",
          content: SUBAGENT_FINALIZE_PROMPT,
          providerData: {
            picoKind: "subagent_finalize",
            picoHiddenFromTranscript: true,
          },
        });
      }

      // 【驾驭底线】普通探索轮仅能获取传入的受限 Registry；
      // 预留收口轮从能力边界上禁用工具。
      const availableTools = finalizing ? [] : readOnlyRegistry.getAvailableTools();

      // 响应式溢出重试:子代理用独立 contextHistory(非 Session 驱动),无法重取
      // WorkingMemory,故仅用更小的 maxChars 预算对 contextHistory 重新压缩重试。
      let actionResp: Message;
      const usageSession = runtime.usageSession ?? this.usageSession;
      const costBefore = usageSession?.totalCostCNY ?? 0;
      try {
        actionResp = await this.generateSubWithOverflowRetry(
          contextHistory,
          availableTools,
          rep,
          runtime,
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error) || !finalizing) throw error;
        logger.warn(
          { error: error instanceof Error ? error.message : String(error), turns: turnCount },
          `[Subagent] FINALIZE 调用失败，直接以 partial 返回已收集证据。`,
        );
        return this.finalizeSubagentResult(
          "partial",
          buildSubagentPartialSummary(contextHistory, artifactPaths),
          artifactPaths,
          taskPrompt,
          runtimeWorkspaceRoot,
        );
      }
      const budgetDecision = this.consumeSubagentResponseBudget(runtime, actionResp, costBefore);
      contextHistory.push(actionResp);

      if (actionResp.content) {
        rep.onMessage(`[Subagent] ${actionResp.content}`);
      }

      // 并发子代理可能同时在途，因此限额最多被已在途的单次响应超出。
      // 每个响应结算后立即停止该子代理，且其他子代理在下一次调用前会共享检查。
      if (!budgetDecision.allowed) {
        const evidence = buildSubagentPartialSummary(contextHistory, artifactPaths);
        return this.finalizeSubagentResult(
          "partial",
          `${evidence}\n\n子代理已停止：${budgetDecision.reason ?? "执行预算已用尽"}。`,
          artifactPaths,
          taskPrompt,
          runtimeWorkspaceRoot,
        );
      }

      // 【核心退出条件】子智能体不调工具了,说明做好了总结汇报
      const toolCalls = actionResp.toolCalls ?? [];
      if (toolCalls.length === 0 || finalizing) {
        if (finalizing) {
          const summary =
            toolCalls.length === 0 && usableSummary(actionResp.content)
              ? actionResp.content
              : buildSubagentPartialSummary(contextHistory, artifactPaths);
          logger.warn(
            { turns: turnCount, maxSubTurns },
            `[Subagent] 已进入预留收口轮，以 partial 状态返回已收集证据。`,
          );
          return this.finalizeSubagentResult(
            "partial",
            summary,
            artifactPaths,
            taskPrompt,
            runtimeWorkspaceRoot,
          );
        }

        // 【改动 B】summary 续写:子代理最终汇报过短(< 200 字)时,
        // 再给一轮强制扩写,防止主 Agent 因信息不足而"失忆"。
        // 对齐 Kimi Code 的 SUMMARY_MIN_LENGTH / SUMMARY_CONTINUATION_ATTEMPTS 设计。
        // 约束:最多续写 1 次,且复用 turnCount 预算,不会无限循环。
        let summary = actionResp.content;
        if (summary.length < SUBAGENT_SUMMARY_MIN_CHARS && turnCount < maxSubTurns) {
          turnCount++;
          contextHistory.push({
            role: "user",
            content: SUBAGENT_SUMMARY_CONTINUATION_PROMPT,
          });
          logger.info(
            { turns: turnCount, summaryLen: summary.length },
            `[Subagent] 📝 探路者总结过短,追加一轮扩写。`,
          );
          try {
            const continuationBudget = this.currentSubagentBudgetDecision();
            if (!continuationBudget.allowed) {
              return this.finalizeSubagentResult(
                "partial",
                `${summary}\n\n子代理已停止：${continuationBudget.reason ?? "执行预算已用尽"}。`,
                artifactPaths,
                taskPrompt,
                runtimeWorkspaceRoot,
              );
            }
            const continuationCostBefore = usageSession?.totalCostCNY ?? 0;
            const continuationResp = await this.generateSubWithOverflowRetry(
              contextHistory,
              [],
              rep,
              runtime,
              signal,
            );
            const continuationDecision = this.consumeSubagentResponseBudget(
              runtime,
              continuationResp,
              continuationCostBefore,
            );
            contextHistory.push(continuationResp);
            if (
              (continuationResp.toolCalls?.length ?? 0) === 0 &&
              usableSummary(continuationResp.content)
            ) {
              summary = continuationResp.content;
              rep.onMessage(`[Subagent] ${continuationResp.content}`);
            }
            if (!continuationDecision.allowed) {
              return this.finalizeSubagentResult(
                "partial",
                `${buildSubagentPartialSummary(contextHistory, artifactPaths)}\n\n子代理已停止：${continuationDecision.reason ?? "执行预算已用尽"}。`,
                artifactPaths,
                taskPrompt,
                runtimeWorkspaceRoot,
              );
            }
          } catch (error) {
            signal?.throwIfAborted();
            if (isAbortError(error)) throw error;
            logger.warn(
              { error: error instanceof Error ? error.message : String(error) },
              `[Subagent] 总结扩写失败，保留上一版有效总结。`,
            );
          }
        }
        const completed = usableSummary(summary);
        if (!completed) summary = buildSubagentPartialSummary(contextHistory, artifactPaths);
        logger.info(
          { turns: turnCount, status: completed ? "completed" : "partial" },
          `[Subagent] ✅ 探路者完成收口,返回总结。`,
        );
        return this.finalizeSubagentResult(
          completed ? "completed" : "partial",
          summary,
          artifactPaths,
          taskPrompt,
          runtimeWorkspaceRoot,
        );
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

  private async finalizeSubagentResult(
    status: "completed" | "partial",
    report: string,
    artifactPaths: readonly string[],
    taskPrompt: string,
    workDir: string,
  ): Promise<SubagentResult> {
    const artifacts = [...new Set(artifactPaths)];
    let summary = report;

    if (
      report.length > SUBAGENT_OUTPUT_BUDGET.summary.softMax &&
      this.subagentReportArtifactWriter
    ) {
      try {
        const artifactPath = await this.subagentReportArtifactWriter({
          taskPrompt,
          report,
          status,
          workDir,
        });
        if (artifactPath) {
          artifacts.push(artifactPath);
          summary = buildExternalizedSubagentPreview(
            report,
            artifactPath,
            SUBAGENT_OUTPUT_BUDGET.summary.softMax,
          );
        }
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "[Subagent] 完整报告外部化失败，回退到单次硬上限。",
        );
      }
    }

    return {
      status,
      summary: truncateSubagentSummary(summary, SUBAGENT_OUTPUT_BUDGET.summary.hardMax),
      artifacts: [...new Set(artifacts)],
    };
  }
}

function persistSubagentContext(contextHistory: Message[], compacted: Message[]): Message[] {
  contextHistory.splice(0, contextHistory.length, ...compacted);
  return contextHistory;
}

function buildSubagentEvidenceSnapshot(contextHistory: readonly Message[]): string | undefined {
  const toolNames = new Map<string, string>();
  const evidence: string[] = [];
  for (const message of contextHistory.slice(2)) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
      if (message.content.trim()) {
        evidence.push(`[assistant checkpoint] ${truncate(message.content.trim(), 400)}`);
      }
      continue;
    }
    if (message.role === "user" && message.toolCallId) {
      const toolName = toolNames.get(message.toolCallId) ?? "unknown_tool";
      evidence.push(
        `[tool evidence: ${toolName}; call=${message.toolCallId}] ${truncate(message.content, 700)}`,
      );
    }
  }
  if (evidence.length === 0) return undefined;
  return [
    "[SUBAGENT EVIDENCE SNAPSHOT] 上下文已重置；以下是压缩前已收集的结构化证据，不要重复探索同一范围。",
    ...evidence.slice(-8),
  ].join("\n");
}

function usableSummary(summary: string): boolean {
  return summary.trim().length > 0;
}

function buildSubagentPartialSummary(
  contextHistory: readonly Message[],
  artifactPaths: readonly string[],
): string {
  const evidence = buildSubagentEvidenceSnapshot(contextHistory);
  const lines = [evidence ?? SUBAGENT_EMPTY_SUMMARY_FALLBACK];
  if (artifactPaths.length > 0) {
    lines.push("", "[已外部化证据]", ...artifactPaths.map((artifactPath) => `- ${artifactPath}`));
  }
  return lines.join("\n");
}

function truncateSubagentSummary(summary: string, maxChars: number): string {
  if (summary.length <= maxChars) return summary;
  const marker = `\n[子代理总结已截断：原始 ${summary.length} 字符，上限 ${maxChars} 字符]`;
  return `${sliceUtf16Safe(summary, Math.max(0, maxChars - marker.length))}${marker}`;
}

function buildExternalizedSubagentPreview(
  report: string,
  artifactPath: string,
  maxChars: number,
): string {
  const marker = [
    "",
    "[完整子代理报告已外部化]",
    `artifactPath: ${artifactPath}`,
    `originalChars: ${report.length}`,
    "当前仅保留结论/证据预览，需要细节时再按路径回查。",
  ].join("\n");
  if (marker.length >= maxChars) {
    return truncateSubagentSummary(marker, maxChars);
  }

  const previewBudget = maxChars - marker.length;
  const separator = "\n…\n";
  if (report.length <= previewBudget) return `${report}${marker}`;
  const headBudget = Math.max(0, Math.floor((previewBudget - separator.length) * 0.75));
  const tailBudget = Math.max(0, previewBudget - separator.length - headBudget);
  return `${sliceUtf16Safe(report, headBudget)}${separator}${sliceUtf16TailSafe(
    report,
    tailBudget,
  )}${marker}`;
}

function sliceUtf16Safe(value: string, maxChars: number): string {
  let end = Math.max(0, Math.min(value.length, maxChars));
  if (end > 0 && end < value.length) {
    const previous = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  }
  return value.slice(0, end);
}

function sliceUtf16TailSafe(value: string, maxChars: number): string {
  let start = Math.max(0, value.length - Math.max(0, maxChars));
  if (start > 0 && start < value.length) {
    const previous = value.charCodeAt(start - 1);
    const next = value.charCodeAt(start);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) start++;
  }
  return value.slice(start);
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
  tools: readonly ToolDefinition[],
  skillIndex: string,
  runtimeWorkspaceRoot: string,
  opts: SubagentRunOptions,
): string {
  // 完全覆盖模式:调用方显式声明,直接用自定义 prompt 替换默认骨架
  if (opts.systemPromptOverride && opts.systemPrompt) {
    return opts.systemPrompt;
  }

  const toolDiscipline = buildSubagentToolDiscipline(tools);

  // 默认骨架：工作区与工具能力均从本次运行时注册表动态注入。
  const base = `你是专门负责深度探索的探路者 (Explorer Subagent)。
你的任务是根据主架构师的指令,在当前工作区内仔细阅读代码、查阅日志,搜集足够的信息。
【运行时工作区边界】
- 唯一真实 workspace root: ${JSON.stringify(runtimeWorkspaceRoot)}
- 所有相对路径都基于该 root。任务 context 中若出现与它冲突的绝对路径，那是过期上下文，必须忽略，不得读写、切换或推断为当前工作区。
【本次实际工具】
${toolDiscipline}
【核心纪律】
1. 只能使用上面列出的实际工具；不得声称或调用未列出的工具。绝对不允许凭空猜测。
2. 如果已注册可用工具且尚未找到确切答案，继续在真实 workspace root 内定点搜索；如果没有工具，明确报告证据边界。
3. 当且仅当你找到了确切的线索后,停止调用工具,直接输出一段纯文本作为你的终极汇报。主架构师会根据你的汇报决定下一步。${
    skillIndex ? `\n\n${skillIndex}` : ""
  }`;

  // 追加模式:默认骨架 + 自定义片段
  return opts.systemPrompt ? `${base}\n\n${opts.systemPrompt}` : base;
}

function buildSubagentToolDiscipline(tools: readonly ToolDefinition[]): string {
  if (tools.length === 0) {
    return "- 本次 Registry 未注册任何工具。不得虚构任何工具；只能根据任务中已给出的证据总结。";
  }
  return tools
    .map((tool) => `- ${tool.name}: ${truncate(tool.description.trim() || "无描述", 240)}`)
    .join("\n");
}

function buildSubagentTaskPrompt(runtimeWorkspaceRoot: string, taskPrompt: string): string {
  return [
    "[RUNTIME WORKSPACE — AUTHORITATIVE]",
    `workspace_root=${JSON.stringify(runtimeWorkspaceRoot)}`,
    "该路径是本次执行的唯一权威工作区根。下方任务/context 中的其他绝对路径如与它冲突，必须忽略。",
    "",
    "[任务]",
    taskPrompt,
    "",
    "[最终汇报合约]",
    "- 先给可直接决策的结论，再列关键证据，不要重放搜索过程或原始日志。",
    "- 证据尽量使用 `文件路径:行号`；明确标出未验证风险与建议下一步。",
    `- 常规目标为 ${SUBAGENT_OUTPUT_BUDGET.summary.softMin}–${SUBAGENT_OUTPUT_BUDGET.summary.softMax} 字符；简单任务可以更短，单次硬上限 ${SUBAGENT_OUTPUT_BUDGET.summary.hardMax} 字符。`,
  ].join("\n");
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

/** Keep the durable control-plane diagnosis small and avoid copying tool/provider payloads. */
function runFailureReason(error: unknown): string {
  if (isAbortError(error)) return "aborted";
  if (error instanceof Error) {
    const name = error.name.trim() || "Error";
    const message = truncate(error.message.trim() || "runtime failure", 300);
    return `${name}: ${message}`;
  }
  return "unknown runtime failure";
}
