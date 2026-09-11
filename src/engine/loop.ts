// 主 Agent 调度：Session/Runtime 生命周期、模型轮次、工具提交与共享预算。
// 子代理的独立会话执行和上下文压缩分别由 subagent-runner / subagent-context 承担；
// 父子运行的权限 capability、归属及共享成本账本仍由本引擎持有。

import { SubagentRunner, type SubagentExecutionRuntime } from "./subagent-runner.js";
export type { SubagentExecutionRuntime } from "./subagent-runner.js";
import { providerForReporter } from "./provider-reporting.js";
import {
  buildRuntimeToolResultInput,
  buildEphemeralToolResult,
  redactToolResult,
} from "./tool-result-builder.js";
import { buildEvidenceSnapshot, estimateTraceLength } from "./context-evidence.js";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { LLMProvider, LLMProviderRequestOptions } from "../provider/interface.js";
import { ContextOverflowError, isAbortError } from "../provider/errors.js";
import { generateWithRetry, type RetryInfo } from "../provider/retry.js";
import {
  type Message,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "../schema/message.js";
import {
  ToolCommitBoundaryError,
  type Registry,
  type ToolFileSideEffects,
  type ToolExecutionStep,
} from "../tools/registry.js";
import type {
  AgentRunner,
  SubagentModelSelectionRequest,
  SubagentRunOptions,
  SubagentResult,
} from "../tools/subagent.js";
import type { Compactor } from "../context/compactor.js";
import { ContextCompactionError, sanitizeToolPairs } from "../context/compactor.js";
import type {
  FullCompactionPreview,
  FullCompactionRequest,
  FullCompactor,
} from "../context/full-compactor.js";
import {
  recordRuntimeCompactionCheckpoint,
  computeCheckpointSourceDigest,
} from "../context/runtime-compaction-checkpoint.js";
import type { ContextBudget } from "../context/context-budget.js";
import { estimateModelInputTokens, estimateMessagesTokens } from "../context/context-budget.js";
import { findSafeCompactionCut } from "../context/safe-compaction-boundary.js";
import { withProviderCallContext } from "../observability/provider-call-context.js";
import { PromptComposer, type PromptLayers } from "../context/composer.js";
import type { SkillLoader } from "../context/skill.js";
import { RecoveryManager } from "../context/recovery.js";
import { TodoStore } from "../context/todo-store.js";
import { ToolDisclosure, type ToolDisclosureTurn } from "../tools/tool-disclosure.js";
import { SilentReporter, type Reporter } from "./reporter.js";
import { SteerQueue } from "./steer-queue.js";
import { ReminderInjector, ToolGuardrailController, type GuardrailOptions } from "./reminder.js";
import { IterationBudget, type BudgetConfig, type BudgetDecision } from "./budget.js";
import type { GoalManager } from "./goal-manager.js";
import { evaluateGoalCompletion } from "./goal-evaluator.js";
import { STALL_EVALUATOR_THRESHOLD, STALL_BLOCK_THRESHOLD } from "./goal-manager.js";
import { Tracer, exportTraceToFile, truncate, type Span } from "../observability/trace.js";
import { logger } from "../observability/logger.js";
import { canonicalizeWorkspacePath } from "../paths/pico-paths.js";
import { safeResolve } from "../tools/registry-impl.js";
import type { WorkspaceRoots } from "../tools/workspace-roots.js";
import type { Session } from "./session.js";
import type {
  EngineRuntimePort,
  EngineRuntimeRun,
  EngineRuntimeToolResultStatus,
} from "./runtime-port.js";
import { createToolResultEnvelope, type ToolResultEnvelope } from "./tool-result-contract.js";
import type { CanonicalTranscriptToolStart } from "./transcript-tool-start.js";
import { PlanHandoffController } from "./plan-handoff.js";
import type { HookService } from "../hooks/service.js";
import { ToolAccesses } from "../tools/tool-access.js";
import { ToolScheduler } from "../tools/tool-scheduler.js";
import {
  promptCacheConversationShardSeed,
  snapshotToolDefinitions,
} from "../provider/prompt-cache.js";
import {
  delegationTaskCountFromArguments,
  isExploreOnlyRequiredDelegationArguments,
  isRequiredDelegationArguments,
} from "../tools/delegation-contract.js";
import {
  fileHistoryAddJournalWarning,
  fileHistoryBeginJournal,
  fileHistoryCommitJournal,
  fileHistoryJournalCoversPath,
  fileHistoryTrackEdit,
  type FileHistoryJournal,
} from "../safety/file-history.js";
import { raceWithDeadline } from "../util/race-with-deadline.js";

const DEFAULT_AUTO_COMPACT_TRIGGER_RATIO = 0.85;
const DEFAULT_RETAINED_CONTEXT_RATIO = 0.2;
const EMERGENCY_RETAINED_CONTEXT_RATIO = 0.1;
/**
 * midTurn proactive 压缩水位(比主动压缩 85% 更激进)。
 * 工具结果 commit 后、下一轮 prepareModelContext 前主动检查:若已超 75% 水位,
 * 提前触发 checkpoint,避免下一轮才 reactive 发现(那时已在 provider 调用紧前)。
 */
const MID_TURN_COMPACT_TRIGGER_RATIO = 0.75;

/**
 * 工具批次 settle 兜底超时:仅依赖工具协作收口(settleOnAbort/Promise.allSettled)
 * 存在死锁风险(未来工具/卡 IO 不响应 signal 时 allSettled 永远挂起,主循环卡死)。
 * 超过此阈值强制继续,放弃等待真实收口,优先保证 run 终止。failToolProtocol 与
 * finally 块两处复用同一常量。
 */
const TOOL_SETTLE_TIMEOUT_MS = 10_000;
interface EngineSessionExecutionContext {
  readonly capability: string;
  active: boolean;
}

const engineSessionContext = new AsyncLocalStorage<EngineSessionExecutionContext>();
// Plan 模式工具面单源迁移至 tool-surface.ts 的 PLAN_MODE_TOOL_NAMES
// （只读侦察 + ask_user/submit_plan 协议闭环），此处仅保留消费接口。
import { isPlanModeTool } from "../tools/tool-surface.js";

function isPlanProviderTool(name: string): boolean {
  return isPlanModeTool(name);
}
export { isPlanProviderTool };

function normalizeToolResultRedactionSecrets(
  secrets: readonly string[] | undefined,
): readonly string[] {
  if (!secrets) return [];
  return Object.freeze(
    [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
      (left, right) => right.length - left.length,
    ),
  );
}

function engineSessionCapability(session: Session): string {
  return JSON.stringify([
    canonicalizeWorkspacePath(session.workDir),
    session.id,
    session.runtimeEventStore?.storageRoot ?? null,
  ]);
}

const EXPLORE_SYNTHESIS_PROMPT =
  "[DELEGATION SYNTHESIS] 本批 required 委派的实际任务均为 explore，子代理已全部收口。" +
  "你现在只能基于上述聚合结果直接给出统一结论；不得调用任何工具，不得重新阅读、搜索或验证项目。";
const EXPLORE_SYNTHESIS_RETRY_PROMPT =
  "[DELEGATION SYNTHESIS RETRY] 上一次回复违反了纯文本总结协议，所有工具调用均已拒绝。" +
  "请立即基于已有聚合结果输出最终统一总结，只输出纯文本。";
const MAX_EXPLORE_SYNTHESIS_TOOL_RETRIES = 2;
const EXPLORE_SYNTHESIS_FAILED_MESSAGE =
  "子代理已完成探索，但主模型连续违反纯文本总结协议，本次未能生成可靠的统一总结。";
const MAX_PLAN_STOP_CONTINUATIONS = 2;
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

/**
 * required delegate_task 是引擎控制流边界，不是普通并行工具。
 * 与 DelegateTaskTool 的兼容规则保持一致：明确 optional/detached 或旧式
 * background=true 才是非阻塞，其余（包括省略策略与无效 JSON）均按 required
 * 安全地独占执行。
 */
function isRequiredDelegateTaskCall(call: ToolCall): boolean {
  return call.name === "delegate_task" && isRequiredDelegationArguments(call.arguments);
}

function findRequiredDelegationIndex(toolCalls: readonly ToolCall[]): number | undefined {
  const index = toolCalls.findIndex(isRequiredDelegateTaskCall);
  return index >= 0 ? index : undefined;
}

/** 与 DelegateTaskTool 的任务归一化规则保持一致：省略/无效 mode 默认 explore。 */
function isExploreOnlyRequiredDelegation(call: ToolCall): boolean {
  return call.name === "delegate_task" && isExploreOnlyRequiredDelegationArguments(call.arguments);
}

function buildSynthesisToolRejection(
  toolCall: ToolCall,
  runtimeRun?: EngineRuntimeRun,
): ToolExecutionOutcome {
  return buildRejectedToolResult(
    toolCall,
    "工具执行已拒绝：explore-only required 委派收口后必须直接基于聚合结果输出纯文本总结。",
    "explore-synthesis-rejection",
    runtimeRun,
  );
}

function buildDelegationRecoveryToolRejection(
  toolCall: ToolCall,
  runtimeRun?: EngineRuntimeRun,
): ToolExecutionOutcome {
  return buildRejectedToolResult(
    toolCall,
    "工具执行已拒绝：required 委派恢复轮只允许一次缩小范围的 required delegate_task。",
    "required-delegation-recovery-rejection",
    runtimeRun,
  );
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

function appendTurnTail(messages: Message[], turnTail: string): Message[] {
  const normalizedTail = turnTail.trim();
  if (!normalizedTail) return messages;
  const currentUserIndex = messages.findLastIndex(
    (message) =>
      message.role === "user" &&
      message.toolCallId === undefined &&
      message.providerData?.["picoHiddenFromTranscript"] !== true,
  );
  if (currentUserIndex < 0) return messages;

  const currentUser = messages[currentUserIndex]!;
  const requestMessages = [...messages];
  requestMessages[currentUserIndex] = {
    ...currentUser,
    content: `${currentUser.content}\n\n<current-turn-context>\n${normalizedTail}\n</current-turn-context>`,
  };
  return requestMessages;
}

function requiredDelegationTaskCount(call: ToolCall): number {
  return call.name === "delegate_task" ? delegationTaskCountFromArguments(call.arguments) : 0;
}

interface RequiredDelegationAssessment {
  usableResults: number;
  batchFailed: boolean;
}

interface ToolExecutionOutcome {
  message: Message;
  reminder?: Message;
  report: ToolResultEnvelope;
}

interface ToolProtocolFailure {
  status: "cancelled" | "interrupted";
  reason: string;
}

function toolProtocolFailureFrom(error: unknown, signal?: AbortSignal): ToolProtocolFailure {
  const cancelled = signal?.aborted === true || isAbortError(error);
  if (cancelled) {
    return {
      status: "cancelled",
      reason: "本轮运行被中止",
    };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return {
    status: "interrupted",
    reason: `工具批次异常中止: ${truncate(detail, 500)}`,
  };
}

function buildSyntheticToolObservation(
  toolCall: ToolCall,
  failure: ToolProtocolFailure,
  runtimeRun?: EngineRuntimeRun,
): ToolExecutionOutcome {
  const prefix = failure.status === "cancelled" ? "工具执行已取消" : "工具执行已中断";
  const content = `${prefix}: ${failure.reason}；该调用未获得可用结果。`;
  const input = {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    status: failure.status,
    body: inlineRuntimeToolResultBody(content),
    projection: {
      version: 1 as const,
      mode: "synthetic" as const,
      text: content,
      strategy: `tool-batch-${failure.status}`,
      truncated: false,
    },
  };
  const message: Message = runtimeRun
    ? runtimeRun.registerProtocolClosureToolResult(input)
    : {
        role: "user",
        content,
        toolCallId: toolCall.id,
      };
  return {
    message,
    report: createToolResultEnvelope(input),
  };
}

function inlineRuntimeToolResultBody(content: string) {
  return {
    storage: "inline" as const,
    content,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

function buildRejectedToolResult(
  toolCall: ToolCall,
  content: string,
  strategy: string,
  runtimeRun?: EngineRuntimeRun,
): ToolExecutionOutcome {
  const input = {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    status: "rejected" as const,
    body: inlineRuntimeToolResultBody(content),
    projection: {
      version: 1 as const,
      mode: "synthetic" as const,
      text: content,
      strategy,
      truncated: false,
    },
  };
  const message: Message = runtimeRun
    ? runtimeRun.registerUndispatchedToolResult(input)
    : {
        role: "user",
        content,
        toolCallId: toolCall.id,
      };
  return {
    message,
    report: createToolResultEnvelope(input),
  };
}

function buildRejectedToolObservation(
  toolCall: ToolCall,
  requiredDelegation: ToolCall,
  runtimeRun?: EngineRuntimeRun,
): ToolExecutionOutcome {
  const content =
    `工具执行已拒绝：同一模型响应中的 required delegate_task ` +
    `(${requiredDelegation.id}) 必须独占执行并等待所有子代理收口。`;
  return buildRejectedToolResult(toolCall, content, "exclusive-delegation-rejection", runtimeRun);
}

function buildPlanSubmitSiblingRejection(
  toolCall: ToolCall,
  submitCall: ToolCall,
  runtimeRun?: EngineRuntimeRun,
): ToolExecutionOutcome {
  return buildRejectedToolResult(
    toolCall,
    `工具执行已拒绝：submit_plan (${submitCall.id}) 必须独占本批，计划提交后当前 Run 立即结束。`,
    "exclusive-plan-submit-rejection",
    runtimeRun,
  );
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
      const hasEvidenceRefs =
        Array.isArray(record["evidenceRefs"]) && record["evidenceRefs"].length > 0;
      if (hasSummary || hasEvidenceRefs) usableResults++;
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
      session.fileHistoryIo,
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
   * Host-owned layered prompt composition. The first result freezes the system
   * prompt for the run; later turns may rebuild only the turn tail. Takes
   * precedence over systemPromptFactory.
   */
  promptLayersFactory?: (input: { readonly currentUserPrompt: string }) => Promise<PromptLayers>;
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
  /** Runtime-owned dynamic collaboration mode; takes precedence over legacy planMode. */
  collaborationMode?: () => "agent" | "plan";
  /** Run-scoped latch marked by submit_plan after durable proposal creation. */
  planHandoff?: PlanHandoffController;
  /** Host-owned tools whose successful durable result ends the current engine Run. */
  stopAfterSuccessfulToolNames?: readonly string[];
  /** Host-owned control plane: preserve model/runtime facts without projecting tool rounds to users. */
  controlPlanePresentation?: boolean;
  /** 当前 route 的统一上下文预算；未注入时仅保留旧 Compactor 兼容路径。 */
  contextBudget?: ContextBudget;
  /** 主动整理水位，默认为输入预算的 85%。 */
  autoCompactTriggerRatio?: number;
  /** Host-owned memory hooks; snapshots are frozen before each actual provider attempt. */
  memoryHooks?: {
    capture(messages: readonly Message[], tools: readonly ToolDefinition[]): Promise<void>;
    checkpoint(checkpointId: string): Promise<void>;
    compactionDisposition?(): Promise<"eligible" | "policy_denied" | undefined>;
  };
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
   * 注入后:planMode 时 PromptComposer 会把 active goal 注入本轮 turn tail。
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
   * 主激活路径是 load_tools 组级激活（枚举选择），search_tools 兜底检索
   * MCP/Plugin 动态工具。registry.execute 仍按全集路由(软安全网)。
   * 未提供则行为不变(全量工具喂给 LLM)。
   */
  toolDisclosure?: ToolDisclosure;
  /** 文件工具与历史快照共用的工作区根集合。 */
  workspaceRoots?: WorkspaceRoots;
  /** 可选的轮次日志回调,便于第 19 讲 Tracing 接入 */
  onTurn?: (info: { turn: number; message: Message }) => void;
  /**
   * 可信宿主登记的精确敏感值。所有工具结果在进入 recovery、Provider transcript、
   * Runtime 持久化、Hook 与 trace 前按完整字符串替换；工具参数不能扩充此列表。
   */
  toolResultRedactionSecrets?: readonly string[];
  /**
   * Plan Mode 退出回调(ROADMAP 3.6)。
   * ExitPlanModeTool 审批通过、engine.exitPlanMode() 触发后调用,供 host 监听。
   */
  onPlanExit?: () => void;
  /** 输出 Reporter;默认静默 (第 09 讲) */
  reporter?: Reporter;
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
   * turn 边界通知（每个模型 turn 开始时同步调用）。宿主用于按轮重置的
   * 配套状态，如子代理执行容量闸（DelegationManager.resetTurnState）。
   */
  onTurnBoundary?: () => void;
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
  /** 宿主在 committed ToolResult 边界执行的 Hook；不得在工具执行期读取 raw 输出。 */
  postToolResultHook?: (call: ToolCall, result: ToolResultEnvelope) => Promise<void>;
  /** Explore required delegation may use only these tools for final direct verification. */
  exploreSynthesisAllowedTools?: readonly string[];
  /** 主循环正常结束、仍位于 RuntimeRun capability 内时执行的宿主收口。 */
  onRunComplete?: () => Promise<void>;
  /** 主循环异常或取消时执行的宿主中断收口。 */
  onRunInterrupted?: (reason: string) => Promise<void>;
  /** 为主工作区及隔离 worktree 构建同策略 Skill Catalog。 */
  skillLoaderFactory?: (workDir: string) => SkillLoader;
  /** Runtime-owned lifecycle port; the engine never imports the durable implementation. */
  runtimePort?: EngineRuntimePort;
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
  private readonly promptLayersFactory?: AgentEngineOptions["promptLayersFactory"];
  private readonly thinkingEffort: string;
  private readonly modelRouteId?: string;
  private readonly resolveSubagentModelRuntime?: SubagentModelRuntimeResolver;
  // planMode 非 readonly:ExitPlanMode 审批通过后由 exitPlanMode() 置 false。
  private planMode: boolean;
  private readonly contextBudget?: ContextBudget;
  private readonly autoCompactTriggerRatio: number;
  private readonly memoryHooks?: {
    capture(messages: readonly Message[], tools: readonly ToolDefinition[]): Promise<void>;
    checkpoint(checkpointId: string): Promise<void>;
    compactionDisposition?(): Promise<"eligible" | "policy_denied" | undefined>;
  };
  private readonly maxTurns: number;
  private readonly compactor?: Compactor;
  private readonly fullCompactor?: FullCompactor;
  private readonly recovery: RecoveryManager;
  private readonly guardrail: ToolGuardrailController;
  private readonly budget: IterationBudget;
  private readonly usageSession?: Session;
  /**
   * 上一轮 provider 返回的真实输入 token(含工具 schema + 缓存)。
   * 用作下一轮 token 估算的锚定基线(对标 maka midTurn estimateNextRequestTokens):
   * 厂商 usage 是 ground truth,比 BPE 估算更准;冷启动(首轮无 usage)时回退到 BPE。
   */
  private lastAnchoredPromptTokens?: number;
  /**
   * Session 成本是累计值。多个子代理并发返回时，以高水位结算增量，
   * 避免每个请求都用自己的 costBefore 导致重复计费。
   */
  private readonly accountedSessionCostCNY = new WeakMap<Session, number>();
  /** Goal Manager 单例(可选);planMode 注入本轮 turn tail 并执行预算控制 */
  private readonly goalManager?: GoalManager;
  /** TodoStore 单例(可选);planMode 下 PromptComposer 复用,与 TodoTool 共享 */
  private readonly todoStore?: TodoStore;
  /** 工具渐进披露(可选);注入后每轮只把核心+已披露工具喂给 LLM */
  private readonly toolDisclosure?: ToolDisclosure;
  private readonly onTurn?: (info: { turn: number; message: Message }) => void;
  private readonly toolResultRedactionSecrets: readonly string[];
  /** Plan Mode 退出回调(ExitPlanMode 审批通过后触发),供 host 监听 */
  private readonly onPlanExit?: () => void;
  private readonly reporter: Reporter;
  private readonly tracer?: Tracer;
  /**
   * Steer 队列(运行时注入引导文本)。host 持有同一实例在 run 期间 push。
   * 非 readonly:飞书等 host 由 factory 构造 engine 后,经 setSteerQueue 挂载。
   */
  private steerQueue?: SteerQueue;
  private readonly waitAtSafeBoundary?: () => Promise<void>;
  private readonly onTurnBoundary?: () => void;
  /** 非工具停止后续接回调(ROADMAP 3.7):host 可决定让 Agent 接着跑 */
  private readonly shouldContinueAfterStop?: AgentEngineOptions["shouldContinueAfterStop"];
  /** 凭证轮换回调(4.2):429 时切换 key 重建 provider;无多 key 时为 undefined */
  private readonly rebuildProvider?: () => LLMProvider | undefined;
  private readonly hookService?: HookService;
  private readonly postToolResultHook?: AgentEngineOptions["postToolResultHook"];
  private readonly exploreSynthesisAllowedTools: ReadonlySet<string>;
  private readonly onRunComplete?: AgentEngineOptions["onRunComplete"];
  private readonly onRunInterrupted?: AgentEngineOptions["onRunInterrupted"];
  private readonly skillLoaderFactory?: (workDir: string) => SkillLoader;
  private readonly runtimePort?: EngineRuntimePort;
  private readonly collaborationMode?: () => "agent" | "plan";
  private readonly planHandoff?: PlanHandoffController;
  private readonly stopAfterSuccessfulToolNames: ReadonlySet<string>;
  private readonly controlPlanePresentation: boolean;
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
    this.promptLayersFactory = opts.promptLayersFactory;
    this.thinkingEffort = opts.thinkingEffort ?? "off";
    this.modelRouteId = opts.modelRouteId;
    this.resolveSubagentModelRuntime = opts.resolveSubagentModelRuntime;
    this.planMode = opts.planMode ?? false;
    this.contextBudget = opts.contextBudget;
    this.memoryHooks = opts.memoryHooks;
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
    this.toolResultRedactionSecrets = normalizeToolResultRedactionSecrets(
      opts.toolResultRedactionSecrets,
    );
    this.onPlanExit = opts.onPlanExit;
    this.reporter = opts.reporter ?? new SilentReporter();
    this.tracer = opts.tracer;
    this.steerQueue = opts.steerQueue;
    this.waitAtSafeBoundary = opts.waitAtSafeBoundary;
    this.onTurnBoundary = opts.onTurnBoundary;
    this.shouldContinueAfterStop = opts.shouldContinueAfterStop;
    this.rebuildProvider = opts.rebuildProvider;
    this.hookService = opts.hookService;
    this.postToolResultHook = opts.postToolResultHook;
    this.exploreSynthesisAllowedTools = new Set(opts.exploreSynthesisAllowedTools ?? []);
    this.onRunComplete = opts.onRunComplete;
    this.onRunInterrupted = opts.onRunInterrupted;
    this.skillLoaderFactory = opts.skillLoaderFactory;
    this.runtimePort = opts.runtimePort;
    this.collaborationMode = opts.collaborationMode;
    this.planHandoff = opts.planHandoff;
    this.stopAfterSuccessfulToolNames = new Set(opts.stopAfterSuccessfulToolNames ?? []);
    this.controlPlanePresentation = opts.controlPlanePresentation === true;
  }

  private isPlanning(): boolean {
    return (
      this.collaborationMode?.() === "plan" ||
      (this.collaborationMode === undefined && this.planMode)
    );
  }

  private rotateProvider(reporter: Reporter, signal?: AbortSignal): LLMProvider | undefined {
    const provider = this.rebuildProvider?.();
    if (!provider) return undefined;
    this.provider = provider;
    return providerForReporter(provider, reporter, signal);
  }

  /**
   * 组装提示词层。systemPrompt 在一次 run 内冻结（缓存友好）；
   * turnTail 由调用方每轮重新获取以反映最新的 Todo/Goal 状态。
   */
  private async buildPromptLayers(
    currentUserPrompt: string,
    signal?: AbortSignal,
  ): Promise<PromptLayers> {
    if (this.promptLayersFactory) {
      return this.promptLayersFactory({ currentUserPrompt });
    }
    if (this.systemPromptFactory) {
      return {
        systemPrompt: await this.systemPromptFactory(),
        turnTail: "",
      };
    }
    if (this.planMode) {
      // 兼容直接构造 AgentEngine 的调用方，同时把动态状态移出 system prefix。
      const opts: ConstructorParameters<typeof PromptComposer>[2] = {};
      if (this.goalManager) opts.goalManager = this.goalManager;
      if (this.todoStore) opts.todoStore = this.todoStore;
      if (this.hookService) {
        opts.onInstructionsLoaded = async (paths) => {
          await this.hookService?.dispatch("InstructionsLoaded", { paths }, { signal });
        };
      }
      const composer = new PromptComposer(this.workDir, true, opts);
      return composer.buildLayers();
    }
    signal?.throwIfAborted();
    return {
      systemPrompt: this.systemPrompt,
      turnTail: "",
    };
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
   *
   * 流式投影修复(A-P1.2):流式 Provider 已通过 onDelta 把上一轮部分 token 投影到
   * UI(经 providerForReporter 闭包);中途失败重试时若不撤销,第二次尝试会把完整
   * 内容再流一遍,UI 得到"半截 + 完整"拼接。这里在 onRetry 触发时调用
   * reporter.onAssistantResponseSuppressed("network-retry") 撤销上一轮已投影的临时流。
   * reporter 未传入(如 compactSubContext 子代理路径)时只打日志,保持原行为。
   */
  private makeRetryReporter(span?: Span, reporter?: Reporter): (info: RetryInfo) => void {
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
      // attempt>1 表示之前已有一次失败尝试;流式路径下其部分 token 可能已投影到 UI。
      // 通知 reporter 撤销该临时投影,避免重试成功后 UI 出现"半截 + 完整"重复。
      if (info.nextAttempt > 1) {
        reporter?.onAssistantResponseSuppressed?.("network-retry");
      }
    };
  }

  /**
   * 单轮工具并发上限(对齐 hermes _MAX_TOOL_WORKERS=8)。
   * 超出的任务进 queued 等名额释放,不报错不丢弃,保序返回。
   */
  private static readonly MAX_TOOL_CONCURRENCY = 8;

  /** RuntimeEvent is the source of truth for production model history; Session is its UI projection. */
  private async readModelHistory(session: Session): Promise<Message[]> {
    const runtimeRun = this.runtimePort?.currentRun();
    if (runtimeRun?.claimsSession(session)) return runtimeRun.readModelHistory(!!this.memoryHooks);
    return session.getModelContext();
  }

  private isRuntimeSession(session: Session): boolean {
    return this.runtimePort?.currentRun()?.claimsSession(session) === true;
  }

  /**
   * Runtime sessions never destructively compact the Session projection. A checkpoint
   * replaces only the model read model and leaves the immutable facts/UI transcript intact.
   */
  private async recordRuntimeCheckpoint(
    session: Session,
    request: FullCompactionRequest,
    signal?: AbortSignal,
  ): Promise<FullCompactionPreview | undefined> {
    const runtimeRun = this.runtimePort?.currentRun();
    if (!runtimeRun?.claimsSession(session) || !this.fullCompactor) {
      return undefined;
    }
    const result = await recordRuntimeCompactionCheckpoint({
      session,
      runtimeRun,
      compactor: this.fullCompactor,
      request,
      ...(this.memoryHooks?.compactionDisposition
        ? { memoryDisposition: () => this.memoryHooks!.compactionDisposition!() }
        : {}),
      ...(this.hookService ? { hookService: this.hookService } : {}),
      ...(signal ? { signal } : {}),
    });
    if (result) {
      try {
        await this.memoryHooks?.checkpoint(result.checkpointId);
      } catch (error) {
        logger.warn(
          { error: String(error), checkpointId: result.checkpointId },
          "[Memory] checkpoint dispatch unavailable; recovery deferred",
        );
      }
    }
    return result?.preview;
  }

  /**
   * midTurn proactive 压缩(对标 maka midTurn capacity compact)。
   *
   * 在工具结果 commit 后、下一轮 prepareModelContext 前主动检查:若上下文已超
   * 75% 水位,提前触发 Runtime checkpoint,避免下一轮才 reactive 发现。
   *
   * 简化设计(相比 maka):
   * - pico 同步 await 落盘,不需要 maka 的 seq-ack 持久化等待
   * - pico 无 steering/pinned 事件,turnTail 每轮重建不进 history
   * - 复用现有 recordRuntimeCheckpoint + findSafeCompactionCut 边界检测
   * - fail-open:压缩失败不抛错,留给下一轮 prepareModelContext 或 overflow 处理
   */
  private async runMidTurnCompaction(
    session: Session,
    span: Span | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    // 仅 Runtime 会话 + 有 fullCompactor + 有 contextBudget 才执行
    if (!this.fullCompactor || !this.contextBudget || !this.isRuntimeSession(session)) return;
    const runtimeRun = this.runtimePort?.currentRun();
    if (!runtimeRun?.claimsSession(session)) return;

    const budget = this.contextBudget.inputBudgetTokens;
    const triggerTokens = Math.floor(budget * MID_TURN_COMPACT_TRIGGER_RATIO);

    // 优先用上一轮 usage 锚定估算(ground truth),冷启动回退到 BPE。
    let estimatedInput: number;
    if (this.lastAnchoredPromptTokens !== undefined) {
      estimatedInput = this.lastAnchoredPromptTokens;
    } else {
      const entries = await runtimeRun.readModelHistoryEntries();
      estimatedInput = estimateMessagesTokens(entries.map(({ message }) => message));
    }

    if (estimatedInput <= triggerTokens) return; // 未到 75% 水位,不压

    signal?.throwIfAborted();
    logger.info(
      {
        estimatedInput,
        triggerTokens,
        triggerRatio: MID_TURN_COMPACT_TRIGGER_RATIO,
        budget,
      },
      "[midTurn] 工具结果落地后上下文已超 75% 水位,主动触发 Runtime checkpoint",
    );
    try {
      const result = await this.recordRuntimeCheckpoint(
        session,
        {
          inputBudgetTokens: budget,
          trigger: "auto",
        },
        signal,
      );
      if (result) {
        span?.addAttributes({
          midTurnCompacted: true,
          midTurnCompactedCount: result.compactedCount,
        });
      }
    } catch (err) {
      // fail-open:压缩失败不抛错,留给下一轮 prepareModelContext 或 overflow 处理
      if (isAbortError(err)) throw err;
      logger.warn(
        { err: String(err), sessionId: session.id },
        "[midTurn] proactive 压缩失败,fail-open:留给下一轮处理",
      );
      span?.addAttributes({ midTurnCompactionFailedOpen: true });
    }
  }

  /** Replaces prior context with a minimal, auditable checkpoint while preserving this input. */
  private async hardResetRuntimeHistory(
    session: Session,
    currentRequestSessionIndex: number,
  ): Promise<void> {
    const runtimeRun = this.runtimePort?.currentRun();
    if (!runtimeRun?.claimsSession(session)) {
      throw new Error("Runtime hard reset requires the active canonical run");
    }
    const rawProjection = await runtimeRun.readSessionProjectionEntries();
    const currentRequest = rawProjection[currentRequestSessionIndex];
    if (!currentRequest) {
      throw new Error("Runtime hard reset cannot locate the current user request");
    }
    const entries = await runtimeRun.readModelHistoryEntries();
    const currentIndex = entries.findIndex((entry) => entry.eventId === currentRequest.eventId);
    if (currentIndex === 0) return;

    let coveredCount = currentIndex > 0 ? currentIndex : entries.length;
    // A hard reset also creates a physical coverage boundary. Keep the whole
    // recovered exchange (and any intervening user inputs) if it cannot be cut.
    while (
      coveredCount > 0 &&
      (entries[coveredCount - 1]!.compactionBoundarySafe === false ||
        entries[coveredCount]?.message.toolCallId !== undefined)
    )
      coveredCount--;
    if (coveredCount === 0) {
      throw new Error(
        "Runtime hard reset has no safe boundary before interrupted recovery history",
      );
    }
    const covered = entries.slice(0, coveredCount);
    const through = covered.at(-1);
    if (!through) return;
    const checkpointId = `hard-reset:${randomUUID()}`;
    // 复用 evidence snapshot:从 covered 消息提取结构化证据(最近 8 条工具/助手),
    // 让硬重置后模型至少能看到"重置前最后的工作线索",而非完全清零。
    const evidenceSnapshot = buildEvidenceSnapshot(
      covered.map((entry) => entry.message),
      0,
      "[CONTEXT RESET EVIDENCE]",
    );
    const summary =
      currentIndex === -1 &&
      currentRequest.message.role === "user" &&
      currentRequest.message.toolCallId === undefined
        ? structuredClone(currentRequest.message)
        : {
            role: "assistant" as const,
            content: evidenceSnapshot
              ? "[CONTEXT RESET] Earlier conversation context was intentionally reset after a context-limit recovery. Treat the current user request as the only active task.\n\n" +
                evidenceSnapshot
              : "[CONTEXT RESET] Earlier conversation context was intentionally reset after a context-limit recovery. Treat the current user request as the only active task.",
            providerData: { picoKind: "runtime_hard_reset", picoCheckpointId: checkpointId },
          };
    await runtimeRun.recordCheckpoint({
      checkpointId,
      coveredEventCount: covered.length,
      sourceDigest: computeCheckpointSourceDigest(covered),
      throughEventId: through.eventId,
      summary,
    });
  }

  private async prepareModelContext(
    session: Session,
    systemPrompt: string,
    turnTail: string,
    tools: ToolDefinition[],
    span?: Span,
    signal?: AbortSignal,
    allowFullCompaction = true,
  ): Promise<Message[]> {
    signal?.throwIfAborted();
    const rawHistory = await this.readModelHistory(session);
    const context = appendTurnTail(
      sanitizeToolPairs([{ role: "system", content: systemPrompt }, ...rawHistory]),
      turnTail,
    );

    // Compatibility for embedders/tests that have not yet supplied a model profile.
    if (!this.contextBudget) {
      return this.compactor ? this.compactor.compactToBudget(context) : context;
    }

    const budget = this.contextBudget.inputBudgetTokens;
    const triggerTokens = Math.floor(budget * this.autoCompactTriggerRatio);
    const bpeEstimate = estimateModelInputTokens(context, tools);
    // usage 锚定:优先用上一轮 provider 返回的真实 promptTokens 作为估算基线(ground truth),
    // 与 BPE 估算取大者(保守:确保不低估而漏触发压缩)。冷启动(无锚定值)时纯用 BPE。
    const beforeTokens =
      this.lastAnchoredPromptTokens !== undefined
        ? Math.max(bpeEstimate, this.lastAnchoredPromptTokens)
        : bpeEstimate;
    if (beforeTokens <= triggerTokens) return context;

    const targetRetainedTokens = Math.max(1, Math.floor(budget * DEFAULT_RETAINED_CONTEXT_RATIO));
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
      const historyCountBefore = rawHistory.length;
      const request = {
        inputBudgetTokens: budget,
        targetRetainedTokens,
        trigger: "auto" as const,
      };
      const runtimePreview = this.isRuntimeSession(session)
        ? await this.recordRuntimeCheckpoint(session, request, signal)
        : undefined;
      const compacted = runtimePreview
        ? true
        : this.isRuntimeSession(session)
          ? false
          : await this.fullCompactor.compactInMemorySession(session, request, signal);
      signal?.throwIfAborted();
      if (compacted) {
        const compactedCount = runtimePreview?.compactedCount ?? persistentCut?.compactedCount;
        span?.addAttributes({
          contextFullCompaction: true,
          contextCompactionTrigger: "watermark",
          contextCompactionCutIndex: compactedCount,
          contextCompactedMessageCount: compactedCount,
          contextRetainedMessageCount: compactedCount
            ? historyCountBefore - compactedCount
            : undefined,
          contextTokensAfterFullCompaction: estimateMessagesTokens(
            await this.readModelHistory(session),
          ),
        });
        return this.prepareModelContext(
          session,
          systemPrompt,
          turnTail,
          tools,
          span,
          signal,
          false,
        );
      }
      // fail-open:full compaction 失败但字符级投影已完成,不立即硬重置。
      // 返回 projected(可能略超预算),让 generateWithOverflowRetry 的 provider overflow
      // 紧急压缩再尝试一次。硬重置只在紧急压缩也失败时才作为最后兜底。
      logger.warn(
        {
          trigger: request.trigger,
          projectedTokens,
          budget,
          triggerTokens,
        },
        "[Engine] full compaction 失败,fail-open:返回字符级投影,留给 overflow 紧急压缩重试",
      );
      span?.addAttributes({ contextCompactionFailedOpen: true });
    }

    // fail-open:无论 projected 是否超预算,都返回它(而非抛 ContextCompactionError)。
    // 超预算的情况由 generateWithOverflowRetry 的 provider overflow 紧急压缩处理;
    // 紧急压缩也失败时,主循环捕获 ContextOverflowError 触发硬重置兜底。
    // 这样 full compaction 失败不再立即丢上下文,给 overflow 紧急压缩多一次机会。
    return projected;
  }

  /** Provider overflow 只允许一次更紧的模型摘要重试。 */
  private async generateWithOverflowRetry(
    session: Session,
    systemPrompt: string,
    turnTail: string,
    tools: ToolDefinition[],
    baseContext: Message[],
    reporter: Reporter,
    span?: Span,
    signal?: AbortSignal,
    allowEmergencyCompaction = true,
    requestOptions?: Pick<LLMProviderRequestOptions, "toolChoice">,
  ): Promise<Message> {
    const promptCacheCapabilities = this.provider.requestCapabilities;
    const preparePromptCacheSharding = promptCacheCapabilities?.preparePromptCacheSharding;
    const routeThresholdActive = preparePromptCacheSharding?.();
    const promptCacheRequest =
      preparePromptCacheSharding && promptCacheCapabilities.promptCacheRouteIdentity
        ? session.preparePromptCacheSharding(
            promptCacheCapabilities.promptCacheRouteIdentity,
            baseContext,
            routeThresholdActive ?? false,
          )
        : {
            shardSeed: promptCacheConversationShardSeed(baseContext),
            active: routeThresholdActive,
          };
    const generate = async (context: Message[]) => {
      await this.memoryHooks?.capture(context, tools);
      return generateWithRetry(
        providerForReporter(this.provider, reporter, signal),
        context,
        tools,
        {
          signal,
          onRetry: this.makeRetryReporter(span, reporter),
          onRateLimited: () => this.rotateProvider(reporter, signal),
          ...(promptCacheRequest.shardSeed
            ? { promptCacheShardSeed: promptCacheRequest.shardSeed }
            : {}),
          ...(promptCacheRequest.active !== undefined
            ? { promptCacheShardActive: promptCacheRequest.active }
            : {}),
          ...requestOptions,
        },
      );
    };
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
      const historyBefore = await this.readModelHistory(session);
      const historyTokens = estimateMessagesTokens(historyBefore);
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
      const emergencyCut = findSafeCompactionCut(historyBefore, targetRetainedTokens);
      const request = { inputBudgetTokens, targetRetainedTokens, trigger: "overflow" as const };
      const runtimePreview = this.isRuntimeSession(session)
        ? await this.recordRuntimeCheckpoint(session, request, signal)
        : undefined;
      const compacted = runtimePreview
        ? true
        : this.isRuntimeSession(session)
          ? false
          : await this.fullCompactor.compactInMemorySession(session, request, signal);
      if (!compacted) throw err;
      const retryContext = await this.prepareModelContext(
        session,
        systemPrompt,
        turnTail,
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
        fullCompactionCutIndex: runtimePreview?.compactedCount ?? emergencyCut?.compactedCount,
        fullCompactionCompactedMessageCount:
          runtimePreview?.compactedCount ?? emergencyCut?.compactedCount,
        fullCompactionRetainedMessageCount:
          runtimePreview?.retainedCount ??
          (emergencyCut ? historyBefore.length - emergencyCut.compactedCount : undefined),
        fullCompactionTokensBefore: historyTokens,
        fullCompactionTokensAfter: estimateMessagesTokens(await this.readModelHistory(session)),
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
    const capability = engineSessionCapability(session);
    const ambientContext = engineSessionContext.getStore();
    if (ambientContext?.active && ambientContext.capability === capability) {
      throw new Error(`AgentEngine does not support re-entrant runs for Session ${session.id}`);
    }
    const run = () => {
      const context: EngineSessionExecutionContext = { capability, active: true };
      const boundTools = snapshotToolDefinitions(this.registry.getAvailableTools());
      const disclosureTurn = this.toolDisclosure?.beginTurn(boundTools);
      const boundStep = this.registry.captureStep?.(
        randomUUID(),
        boundTools.map((tool) => tool.name),
      );
      const executeTurn = () =>
        engineSessionContext.run(context, async () => {
          try {
            return await this.runInMainCompactorScope(
              session,
              runtimeReporter,
              runtimeTracer,
              signal,
              boundTools,
              disclosureTurn,
              boundStep,
            );
          } finally {
            // Detached work inherits AsyncLocalStorage. Seal only this finished execution so a
            // later exact Graph wake may reuse the same Session without weakening live re-entry.
            context.active = false;
            if (disclosureTurn) this.toolDisclosure?.endTurn(disclosureTurn);
          }
        });
      return disclosureTurn && this.toolDisclosure
        ? this.toolDisclosure.runInTurn(disclosureTurn, executeTurn)
        : executeTurn();
    };
    const execute = () => (this.compactor ? this.compactor.runInMainScope(run) : run());
    const ambientRun = this.runtimePort?.currentRun();
    // Tests and explicit in-memory sessions intentionally skip durable runtime facts.
    if (!session.runtimeEventStore) {
      if (ambientRun && !ambientRun.claimsSession(session)) {
        throw new Error("An in-memory Session cannot run inside another RuntimeRun capability");
      }
      return execute();
    }
    // AgentRuntime already owns the canonical RuntimeEvent run. Direct embedders are
    // serialized here so one durable Session cannot execute overlapping model turns.
    if (ambientRun?.claimsSession(session)) {
      if (ambientRun.runtimeEventWriteGuard !== session) {
        throw new Error(
          `Runtime run ${ambientRun.runId} does not hold the exact Session write capability`,
        );
      }
      return execute();
    }
    return session.serialize(() => this.runWithRuntimeEvents(session, execute, signal));
  }

  private async runWithRuntimeEvents(
    session: Session,
    execute: () => Promise<Message[]>,
    signal?: AbortSignal,
  ): Promise<Message[]> {
    const runtimeStore = session.runtimeEventStore;
    const runtimePort = this.runtimePort;
    if (!runtimePort) {
      throw new Error("Durable AgentEngine execution requires an injected runtimePort");
    }
    if (!runtimeStore) {
      throw new Error("Durable AgentEngine execution requires the Session runtime store");
    }
    const runtimeCapability = session.runtimeEventCapability;
    if (!runtimeCapability) {
      throw new Error("Durable AgentEngine execution requires the Session runtime capability");
    }
    await runtimePort.reconcileIncompleteRuns({
      capability: runtimeCapability,
    });
    await runtimePort.repairSessionProjection(session, {
      capability: runtimeCapability,
    });
    const runtimeRun = await runtimePort.startRun({
      capability: runtimeCapability,
    });
    return runtimeRun.run(execute, signal);
  }

  private async runInMainCompactorScope(
    session: Session,
    runtimeReporter?: Reporter,
    runtimeTracer?: Tracer,
    signal?: AbortSignal,
    boundTools?: ToolDefinition[],
    disclosureTurn?: ToolDisclosureTurn,
    boundStep?: ToolExecutionStep,
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

    const runHistory = await this.readModelHistory(session);
    const currentUserPrompt = latestVisibleUserInput(runHistory);
    const initialPromptLayers = await this.buildPromptLayers(currentUserPrompt, signal);
    const systemPrompt = initialPromptLayers.systemPrompt;
    let turnTail = initialPromptLayers.turnTail;
    signal?.throwIfAborted();

    let beforeLen = session.length;
    let turnCount = 0;
    let exhaustedReason: string | undefined;
    let hardResetTriggered = false;
    let exploreSynthesisOnly = false;
    let exploreSynthesisToolRetries = 0;
    let requiredDelegationRecoveryPending = false;
    let requiredDelegationRecoveryExploreOnly = false;
    let consecutiveHookStopBlocks = 0;
    let planStopContinuations = 0;
    let graceCandidateTools: ToolDefinition[] = [];
    const runToolSnapshot =
      boundTools ?? snapshotToolDefinitions(this.registry.getAvailableTools());
    const userRewindPointId = session.fileHistory.snapshots.findLast(
      (snapshot) => snapshot.messageId === session.fileHistory.currentMessageId,
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
        // turn 边界通知（如子代理执行容量闸的按轮换新）：新 turn 满血配速，
        // 上一 turn 仍在排队的容量等待者被拒绝（饱和背压）。
        this.onTurnBoundary?.();
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
        await this.runtimePort?.currentRun()?.recordTurnStarted(turnCount);
        await this.runtimePort?.currentRun()?.assertNoUnresolvedToolEffects();
        // 首轮直接复用 run 开始时的分层结果，避免重复组装。后续轮次只刷新
        // turnTail，使 TodoStore/GoalManager 等共享状态可见；systemPrompt 保持冻结。
        if (turnCount > 1 && (this.promptLayersFactory || this.planMode)) {
          const fresh = await this.buildPromptLayers(currentUserPrompt, signal);
          turnTail = fresh.turnTail;
        }
        reporter.onTurnStart(turnCount);
        const turnSpan = rootSpan?.startChild(`Turn-${turnCount}`);
        this.registry.setPreWriteHook?.(async (toolName, args) => {
          if (!userRewindPointId) return;
          try {
            const effects = this.registry.getFileSideEffects?.({
              id: `file-history:${userRewindPointId}`,
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
                userRewindPointId,
                session.id,
                session.fileHistoryIo,
              );
            }
          } catch {
            // File-history tracking is best-effort and must not block the tool call.
          }
        });

        try {
          // 获取当前挂载的所有工具定义
          const allTools = runToolSnapshot;
          // 每次推理固定本 Step 可见集合；本轮工具披露在下一 Step 才生效。
          const availableTools = disclosureTurn
            ? [...disclosureTurn.snapshotForStep().tools]
            : allTools;
          // explore-only required 委派收口后不再给主模型任何工具，
          // 从能力边界上阻断它重复阅读项目。worker/mixed 批次不受影响。
          const unrestrictedProviderTools = exploreSynthesisOnly
            ? availableTools.filter((tool) => this.exploreSynthesisAllowedTools.has(tool.name))
            : requiredDelegationRecoveryPending
              ? allTools.filter((tool) => tool.name === "delegate_task")
              : availableTools;
          // Plan 的终态只能由 submit_plan 形成。渐进披露不得把它（或 ask_user）
          // 隐藏，否则模型会看到 Plan Prompt，却没有完成协议所需的工具。
          // 这里仍使用与 safety middleware 相同的严格白名单，不扩大能力面。
          const providerTools = this.isPlanning()
            ? allTools.filter((tool) => isPlanProviderTool(tool.name))
            : unrestrictedProviderTools;
          const step = this.registry.captureStep?.(
            randomUUID(),
            providerTools.map((tool) => tool.name),
            boundStep,
          ) ?? {
            id: randomUUID(),
            visibleToolNames: new Set(providerTools.map((tool) => tool.name)),
          };

          // 主 Agent 默认投影完整 Session 历史。只有超过 token 水位时，
          // 才先缩短旧 ToolResult，再在安全工具边界做持久化摘要。
          const contextChars = estimateTraceLength(
            appendTurnTail(
              [
                { role: "system", content: systemPrompt },
                ...(await this.readModelHistory(session)),
              ],
              turnTail,
            ),
          );
          let compactedContext: Message[];
          try {
            compactedContext = await this.prepareModelContext(
              session,
              systemPrompt,
              turnTail,
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
              if (this.isRuntimeSession(session)) {
                await this.hardResetRuntimeHistory(session, beforeLen - 1);
              } else {
                await session.truncateTo(beforeLen - 1);
                // 硬重置改变了 session 起点,更新 beforeLen 让返回值切片正确
                beforeLen = session.length - 1;
              }
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
          graceCandidateTools =
            !exploreSynthesisOnly && !requiredDelegationRecoveryPending ? [...providerTools] : [];
          const actionSpan = turnSpan?.startChild("LLM.Action", {
            inputMessageCount: compactedContext.length,
            availableToolCount: providerTools.length,
            ...(this.toolDisclosure ? { totalToolCount: allTools.length } : {}),
          });
          let responseMsg: Message;
          const costBefore = session.totalCostCNY;
          try {
            reporter.onThinking();
            responseMsg = await this.generateWithOverflowRetry(
              session,
              systemPrompt,
              turnTail,
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
            if (!this.isRuntimeSession(session) && session.length < beforeLen) {
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
                  currentRequestChars:
                    (await this.readModelHistory(session)).at(-1)?.content.length ?? 0,
                },
                "[Engine] 紧急摘要重试后仍溢出；系统提示、工具 Schema 或当前请求不可再压缩，触发硬重置",
              );
              if (this.isRuntimeSession(session)) {
                await this.hardResetRuntimeHistory(session, beforeLen - 1);
              } else {
                await session.truncateTo(beforeLen - 1);
                beforeLen = session.length - 1;
              }
              continue;
            }
            throw err;
          } finally {
            reporter.onThinkingEnd?.();
            actionSpan?.end();
          }

          const toolCalls = responseMsg.toolCalls ?? [];
          if (this.controlPlanePresentation && toolCalls.length > 0) {
            reporter.onAssistantResponseSuppressed?.("internal-control");
            responseMsg = {
              ...responseMsg,
              providerData: {
                ...responseMsg.providerData,
                picoKind: "control_plane_tool_round",
                picoPresentationAudience: "internal",
                picoHiddenFromTranscript: true,
              },
            };
          }
          if (
            exploreSynthesisOnly &&
            toolCalls.some((toolCall) => !this.exploreSynthesisAllowedTools.has(toolCall.name))
          ) {
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
            const runtimeRun = this.runtimePort?.currentRun();
            const rejectedOutcomes = toolCalls.map((toolCall) =>
              buildSynthesisToolRejection(toolCall, runtimeRun),
            );
            await session.commitMessages(rejectedResponse);
            this.onTurn?.({ turn: turnCount, message: rejectedResponse });
            await this.commitRejectedToolBatch(
              session,
              reporter,
              toolCalls,
              rejectedOutcomes,
              runtimeRun,
            );

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
          if (exploreSynthesisOnly && toolCalls.length === 0) {
            exploreSynthesisOnly = false;
            exploreSynthesisToolRetries = 0;
          }
          const requiredDelegationIndex = findRequiredDelegationIndex(toolCalls);
          const requiredDelegation =
            requiredDelegationIndex !== undefined ? toolCalls[requiredDelegationIndex] : undefined;
          const acceptedRecoveryDelegation =
            requiredDelegation !== undefined && requiredDelegationTaskCount(requiredDelegation) > 0;
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
            const runtimeRun = this.runtimePort?.currentRun();
            const rejectedOutcomes = toolCalls.map((toolCall) =>
              buildDelegationRecoveryToolRejection(toolCall, runtimeRun),
            );
            await session.commitMessages(rejectedResponse);
            this.onTurn?.({ turn: turnCount, message: rejectedResponse });
            await this.commitRejectedToolBatch(
              session,
              reporter,
              toolCalls,
              rejectedOutcomes,
              runtimeRun,
            );
            const failedResponse: Message = {
              role: "assistant",
              content: REQUIRED_DELEGATION_RECOVERY_FAILED_MESSAGE,
            };
            await session.commitMessages(failedResponse);
            await this.reportMessage(reporter, failedResponse.content, signal);
            reporter.onFinish();
            break;
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
          const settledResults: Array<ToolExecutionOutcome | undefined> = new Array(
            toolCalls.length,
          );
          const scheduled: Array<Promise<ToolExecutionOutcome>> = [];
          const completedToolReportIndexes: number[] = [];
          let toolProtocolClosed = toolCalls.length === 0;
          let toolStartsRecorded = toolCalls.length === 0;
          const closeToolProtocol = async (failure: ToolProtocolFailure): Promise<void> => {
            if (toolProtocolClosed) return;
            await this.closeToolProtocolBatch(
              session,
              toolCalls,
              settledResults,
              completedToolReportIndexes,
              failure,
              reporter,
            );
            toolProtocolClosed = true;
          };
          const failToolProtocol = async (error: unknown): Promise<never> => {
            // loop-1 兜底:仅依赖工具协作收口存在死锁风险(未来工具/卡 IO 不响应
            // signal 时 Promise.allSettled 永远挂起,主循环卡死)。TOOL_SETTLE_TIMEOUT_MS
            // 超时强制继续,放弃等待 settleOnAbort 任务的真实收口,优先保证 run 终止。
            // loop-6:定时器句柄清理已收敛进 raceWithDeadline(范式同 retry.ts
            // abortableSleep 的 clearTimeout),杜绝正常批次下的悬挂定时器泄漏。
            await raceWithDeadline(scheduled, TOOL_SETTLE_TIMEOUT_MS);
            if (error instanceof ToolCommitBoundaryError) throw error;
            // The assistant tool-call batch is durable, but no ToolResult may
            // become canonical until its structured starts are known durable.
            // Reconciliation will later close this still-pending model batch.
            if (!toolStartsRecorded) throw error;
            try {
              await closeToolProtocol(toolProtocolFailureFrom(error, signal));
            } catch (closureError) {
              throw new AggregateError(
                [error, closureError],
                "Agent run failed and its committed tool-call batch could not be closed",
                { cause: closureError },
              );
            }
            throw error;
          };

          try {
            const durableStarts = await this.recordAcceptedToolCalls(
              session,
              toolCalls,
              this.runtimePort?.currentRun(),
            );
            toolStartsRecorded = true;
            this.publishAcceptedToolCalls(reporter, toolCalls, durableStarts);
            this.onTurn?.({ turn: turnCount, message: responseMsg });
            if (exhaustedReason) {
              await closeToolProtocol({
                status: "cancelled",
                reason: `执行预算已耗尽: ${exhaustedReason}`,
              });
              break;
            }

            // 模型回复纯文本时广播 (通常是思考过程或最终结果)
            if (responseMsg.content) {
              await this.reportMessage(reporter, responseMsg.content, signal);
            }

            // 3. 退出条件:模型没有请求任何工具调用,说明任务完成,挂起等待下一条指令
            if (toolCalls.length === 0) {
              if (this.isPlanning() && !this.planHandoff?.hasPending()) {
                if (planStopContinuations >= MAX_PLAN_STOP_CONTINUATIONS) {
                  throw new Error(
                    "Plan Mode 模型连续停止但未调用 submit_plan，规划 Run 不能作为成功完成。",
                  );
                }
                planStopContinuations++;
                await session.commitMessages({
                  role: "user",
                  content:
                    "[Plan continuation] 规划尚未提交。继续调查或整理方案，完成后必须调用 submit_plan；不要仅用文字结束。",
                  providerData: {
                    picoKind: "plan_continuation",
                    picoHiddenFromTranscript: true,
                  },
                });
                continue;
              }
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

              // Goal 延续协调器：goal 还 active 时，按停滞计数决定续行 / 评估 / 终止
              if (this.goalManager) {
                const active = this.goalManager.getActive();
                if (active && active.status === "active") {
                  const noProgress = active.consecutiveNoProgress ?? 0;

                  if (noProgress >= STALL_BLOCK_THRESHOLD) {
                    // 硬终止 → 走 Grace Call
                    exhaustedReason = `Goal 疑似停滞（连续 ${noProgress} 轮无进展）`;
                    break;
                  }

                  if (noProgress >= STALL_EVALUATOR_THRESHOLD && this.provider) {
                    // 触发 LLM 评估器判断是否真的完成
                    const evaluation = await evaluateGoalCompletion(
                      this.provider,
                      active,
                      await this.readModelHistory(session),
                      signal,
                    );
                    if (evaluation.met || evaluation.impossible) {
                      // 评估器说完成了/不可能 → 允许退出
                      break;
                    }
                    if (!evaluation.evaluatorFailed) {
                      // 评估器说没完成 → 续行并注入评估理由
                      await session.commitMessages({
                        role: "user",
                        content: `[Goal continuation] 目标尚未完成。评估器判断：${evaluation.reason}\n请继续推进。`,
                        providerData: {
                          picoKind: "goal_continuation",
                          picoHiddenFromTranscript: true,
                        },
                      });
                      continue;
                    }
                    // 评估器失败 → fail-open，允许退出
                    break;
                  }

                  // noProgress < 3 → 直接续行（给模型思考空间）
                  await session.commitMessages({
                    role: "user",
                    content: "[Goal continuation] 目标尚未完成，请继续推进。",
                    providerData: {
                      picoKind: "goal_continuation",
                      picoHiddenFromTranscript: true,
                    },
                  });
                  continue;
                }
              }

              reporter.onFinish();
              break;
            }

            // A pause requested during provider inference takes effect before any new tool starts.
            // A pause requested while tools are running is observed at the next loop boundary,
            // after the whole scheduled batch and file journal have safely settled.
            await this.waitAtSafeBoundary?.();
            signal?.throwIfAborted();
          } catch (error) {
            await failToolProtocol(error);
          }

          // 4. 执行行动 (Action) 与 获取观察结果 (Observation)
          // 资源冲突图调度(对标 kimi-code ToolScheduler):工具按文件路径 × 操作类型
          // 声明访问意图,调度器在冲突图上做最大独立集贪心并行。
          //   - 不冲突(read+read / write 不同文件)→ 并行
          //   - 冲突(同文件含写 / kind:"all")→ 串行
          // 结果按 provider 原始顺序回传(add 顺序即 resolve 顺序)。
          // Kimi AgentSwarm 式独占语义：required delegate_task 是这一轮唯一
          // 允许真实执行的工具。保留原始 toolCalls 和每个对应 observation，
          // 以维持 provider 要求的 tool-call/result 完整配对。
          // maxConcurrency 限制并发执行的工具数(对齐 hermes _MAX_TOOL_WORKERS=8),
          // 防止一批大量不冲突只读工具同时打 IO 把系统压垮。
          let scheduler: ToolScheduler<ToolExecutionOutcome> | undefined;
          let results: ToolExecutionOutcome[] = [];
          const submitPlanIndex = toolCalls.findIndex((call) => call.name === "submit_plan");
          const submitPlanCall = submitPlanIndex >= 0 ? toolCalls[submitPlanIndex] : undefined;
          try {
            try {
              const getAccesses = this.registry.getAccesses;
              const fileSideEffectKinds = toolCalls.map((call, index) =>
                requiredDelegationIndex === undefined || index === requiredDelegationIndex
                  ? fileSideEffectKind(this.registry, call)
                  : "none",
              );
              const hasFileEffects = fileSideEffectKinds.some((kind) => kind !== "none");
              if (hasFileEffects && journalRoots.length > 0 && userRewindPointId) {
                runFileJournal ??= await fileHistoryBeginJournal(
                  journalRoots,
                  session.id,
                  signal,
                  session.fileHistoryBaseDir,
                );
                activeFileJournal = runFileJournal;
                if (
                  runFileJournal &&
                  toolCalls.some(
                    (call, index) =>
                      (requiredDelegationIndex === undefined ||
                        index === requiredDelegationIndex) &&
                      isBackgroundBashCall(call),
                  )
                ) {
                  fileHistoryAddJournalWarning(
                    runFileJournal,
                    "background bash 在工具返回后仍可继续写入，本轮 rewind 只覆盖返回前的变化",
                  );
                }
              }
              scheduler = new ToolScheduler<ToolExecutionOutcome>({
                maxConcurrency: AgentEngine.MAX_TOOL_CONCURRENCY,
                signal,
              });
              for (const [index, tc] of toolCalls.entries()) {
                const execution: Promise<ToolExecutionOutcome> =
                  memoryStepRejects(toolCalls, index) && !submitPlanCall && !requiredDelegation
                    ? Promise.resolve(
                        buildRejectedToolResult(
                          tc,
                          "memory_remember 必须独占模型工具步骤；请在下一步单独调用。",
                          "exclusive-memory-rejection",
                          this.runtimePort?.currentRun(),
                        ),
                      )
                    : submitPlanCall && index !== submitPlanIndex
                      ? Promise.resolve(
                          buildPlanSubmitSiblingRejection(
                            tc,
                            submitPlanCall,
                            this.runtimePort?.currentRun(),
                          ),
                        )
                      : requiredDelegation && index !== requiredDelegationIndex
                        ? Promise.resolve(
                            buildRejectedToolObservation(
                              tc,
                              requiredDelegation,
                              this.runtimePort?.currentRun(),
                            ),
                          )
                        : scheduler.add({
                            accesses: getAccesses
                              ? getAccesses.call(this.registry, tc)
                              : ToolAccesses.all(),
                            // 文件事务只能在活跃写任务的 start Promise 真实收口后提交，
                            // 故所有文件类工具在 abort 时一律等待 settle。文件写很快完成、
                            // 不会无限挂起；即便工具不协作 signal，failToolProtocol / finally
                            // 的 10s 超时兜底也会强制收口，防止主循环卡死（loop-1）。
                            settleOnAbort: fileSideEffectKinds[index] !== "none",
                            start: async () => {
                              signal?.throwIfAborted();
                              return this.runtimePort
                                ? this.runtimePort.runWithToolCall(tc.id, () =>
                                    this.runOneTool(tc, reporter, turnSpan, signal, step),
                                  )
                                : this.runOneTool(tc, reporter, turnSpan, signal, step);
                            },
                          });
                scheduled.push(
                  execution.then((result) => {
                    settledResults[index] = result;
                    completedToolReportIndexes.push(index);
                    return result;
                  }),
                );
              }
              results = await Promise.all(scheduled);
              signal?.throwIfAborted();
            } finally {
              // 异常时也要先等已启动任务收口，再提交文件 journal 和协议闭合结果。
              // loop-1 兜底:与 failToolProtocol 一致,TOOL_SETTLE_TIMEOUT_MS 超时强制继续,
              // 避免 settleOnAbort 任务(文件类工具)不协作 signal 时永久挂起主循环。
              // 定时器清理收敛进 raceWithDeadline。
              await raceWithDeadline(scheduled, TOOL_SETTLE_TIMEOUT_MS);
              scheduler?.dispose();
            }
          } catch (error) {
            await failToolProtocol(error);
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
          toolProtocolClosed = true;
          // Reporter 是派生展示层。必须等 canonical ToolResult durable 且 Session
          // 投影完成后再通知；否则 Reporter 异常会让 pending actual 与 synthetic
          // closure 错配。按工具实际完成顺序保持并发批次既有的展示次序。
          await this.publishCommittedToolBatch(
            reporter,
            toolCalls,
            results,
            completedToolReportIndexes,
          );
          const successfulTerminalTool = toolCalls.some(
            (call, index) =>
              this.stopAfterSuccessfulToolNames.has(call.name) &&
              results[index]?.report.status === "succeeded",
          );
          if (successfulTerminalTool) {
            reporter.onFinish();
            break;
          }
          if (this.planHandoff?.hasPending()) {
            this.planHandoff.consume();
            reporter.onFinish();
            break;
          }
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
                  content: REQUIRED_DELEGATION_RECOVERY_FAILED_MESSAGE,
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

          // Goal 停滞检测：每轮结束后更新停滞计数 + 软提醒（≥5 轮）
          if (this.goalManager && responseMsg) {
            this.goalManager.recordToolCallProgress(responseMsg.toolCalls ?? []);
            const stallWarning = this.goalManager.getStallWarning();
            if (stallWarning) {
              await session.commitMessages({
                role: "user",
                content: `[SYSTEM REMINDER 警告]\n${stallWarning}`,
                providerData: { picoKind: "system_reminder", picoHiddenFromTranscript: true },
              });
            }
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

          // ====================================================================
          // midTurn proactive 压缩(对标 maka midTurn capacity compact):
          // 此时工具结果、reminder、stallWarning、steer 都已 commitMessages 落盘,
          // 下一轮 prepareModelContext 还未执行。若上下文已超 75% 水位,提前压缩。
          // 失败 fail-open,不阻塞主循环。
          // ====================================================================
          await this.runMidTurnCompaction(session, turnSpan, signal);
        } finally {
          turnSpan?.end();
        }
      }
      if (exhaustedReason) {
        signal?.throwIfAborted();
        await this.runGraceCall(
          session,
          systemPrompt,
          turnTail,
          graceCandidateTools,
          exhaustedReason,
          reporter,
          rootSpan,
          signal,
        );
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) reporter.onInterrupted?.();
      await this.onRunInterrupted?.(
        signal?.aborted || isAbortError(error)
          ? "Run was cancelled."
          : `Run failed: ${error instanceof Error ? error.message : String(error)}`,
      ).catch((hookError) =>
        logger.warn({ hookError: String(hookError) }, "[Engine] 运行中断收口失败"),
      );
      throw error;
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
        const tracePath = exportTraceToFile(
          rootSpan,
          session.workDir,
          session.id,
          undefined,
          session.picoHome,
        );
        logger.info({ tracePath }, `[Tracing] 执行回放链路已保存: ${tracePath}`);
      }
    }

    await this.onRunComplete?.();

    // 返回本轮新增的消息序列(从用户输入起到最终答案止)
    const runMessages = session.getHistory().slice(beforeLen);
    assertRunProducedModelOutput(runMessages);
    return runMessages;
  }

  private async commitRejectedToolBatch(
    session: Session,
    reporter: Reporter,
    toolCalls: readonly ToolCall[],
    outcomes: readonly ToolExecutionOutcome[],
    runtimeRun: EngineRuntimeRun | undefined,
  ): Promise<void> {
    let toolStartsRecorded = toolCalls.length === 0;
    let startNotificationError: unknown;
    try {
      const durableStarts = await this.recordAcceptedToolCalls(session, toolCalls, runtimeRun);
      toolStartsRecorded = true;
      this.publishAcceptedToolCalls(reporter, toolCalls, durableStarts);
    } catch (error) {
      if (!toolStartsRecorded) throw error;
      startNotificationError = error;
    }

    try {
      await session.commitMessages(...outcomes.map((outcome) => outcome.message));
      await this.publishCommittedToolBatch(
        reporter,
        toolCalls,
        outcomes,
        toolCalls.map((_toolCall, index) => index),
      );
    } catch (error) {
      if (startNotificationError !== undefined) {
        throw new AggregateError(
          [startNotificationError, error],
          "Accepted tool starts were reported with an error and the rejected batch failed to close",
          { cause: error },
        );
      }
      throw error;
    }

    if (startNotificationError !== undefined) throw startNotificationError;
  }

  /**
   * Acceptance is the single durable start boundary. Reporter callbacks happen
   * only after the complete structured batch has committed.
   */
  private async recordAcceptedToolCalls(
    session: Session,
    toolCalls: readonly ToolCall[],
    runtimeRun: EngineRuntimeRun | undefined,
  ): Promise<readonly CanonicalTranscriptToolStart[] | undefined> {
    if (toolCalls.length === 0) return [];
    if (this.controlPlanePresentation) return undefined;
    const durableStarts = runtimeRun
      ? await runtimeRun.recordTranscriptToolStarts(session, toolCalls)
      : undefined;
    if (durableStarts && durableStarts.length !== toolCalls.length) {
      throw new Error("Durable tool start batch must contain every accepted provider call");
    }
    return durableStarts;
  }

  /** Notify every accepted call exactly once in provider order. */
  private publishAcceptedToolCalls(
    reporter: Reporter,
    toolCalls: readonly ToolCall[],
    durableStarts: readonly CanonicalTranscriptToolStart[] | undefined,
  ): void {
    let firstError: unknown;
    for (const [index, toolCall] of toolCalls.entries()) {
      if (this.controlPlanePresentation) continue;
      const durableStart: CanonicalTranscriptToolStart | undefined = durableStarts?.[index];
      try {
        reporter.onToolCall(
          toolCall.name,
          toolCall.arguments,
          toolCall.id,
          durableStart ? structuredClone(durableStart) : undefined,
        );
      } catch (error) {
        firstError ??= error;
        logger.warn(
          { error: String(error), tool: toolCall.name },
          "[Engine] ToolCall start 已持久化，但 Reporter 通知失败",
        );
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private async closeToolProtocolBatch(
    session: Session,
    toolCalls: readonly ToolCall[],
    settledResults: readonly (ToolExecutionOutcome | undefined)[],
    completedToolReportIndexes: readonly number[],
    failure: ToolProtocolFailure,
    reporter: Reporter,
  ): Promise<void> {
    const syntheticIndexes: number[] = [];
    const outcomes = toolCalls.map((toolCall, index) => {
      const settled = settledResults[index];
      if (settled) return settled;
      const synthetic = buildSyntheticToolObservation(
        toolCall,
        failure,
        this.runtimePort?.currentRun(),
      );
      syntheticIndexes.push(index);
      return synthetic;
    });

    const reminders = settledResults.flatMap((result) =>
      result?.reminder ? [result.reminder] : [],
    );
    await session.commitMessages(...outcomes.map((outcome) => outcome.message), ...reminders);
    // Settled outcomes are notified in their true completion order. Calls without
    // an outcome become synthetic only after the batch closes, so they follow in
    // provider order. Every notification happens after the whole canonical batch
    // is durable, and a broken Reporter cannot mask the original protocol failure.
    await this.publishCommittedToolBatch(
      reporter,
      toolCalls,
      outcomes,
      [...completedToolReportIndexes, ...syntheticIndexes],
      false,
    );
  }

  private async publishCommittedToolBatch(
    reporter: Reporter,
    toolCalls: readonly ToolCall[],
    outcomes: readonly ToolExecutionOutcome[],
    notificationOrder: readonly number[],
    propagateErrors = true,
  ): Promise<void> {
    if (toolCalls.length !== outcomes.length) {
      throw new Error("ToolResult batch calls and outcomes must have the same length");
    }
    if (toolCalls.length === 0) return;
    if (
      notificationOrder.length !== toolCalls.length ||
      new Set(notificationOrder).size !== toolCalls.length
    ) {
      throw new Error("ToolResult notification order must contain every batch index exactly once");
    }

    let firstError: unknown;
    try {
      await this.publishCommittedToolResults(
        reporter,
        notificationOrder.map((index) => {
          const call = toolCalls[index];
          const outcome = outcomes[index];
          if (!call || !outcome) {
            throw new Error(`ToolResult notification index is invalid: ${String(index)}`);
          }
          return { call, envelope: outcome.report };
        }),
      );
    } catch (error) {
      firstError = error;
    }

    try {
      await this.hookService?.dispatch("PostToolBatch", {
        tools: toolCalls.map((call, index) => ({
          tool_name: call.name,
          tool_input: parseHookToolArguments(call.arguments),
          tool_call_id: call.id,
          tool_result: structuredClone(outcomes[index]!.report),
        })),
      });
    } catch (error) {
      firstError ??= error;
      logger.warn(
        { error: String(error), toolCount: toolCalls.length },
        "[Engine] ToolResult 批次已持久化，但 PostToolBatch Hook 通知失败",
      );
    }

    if (propagateErrors && firstError !== undefined) throw firstError;
  }

  private async publishCommittedToolResults(
    reporter: Reporter,
    results: readonly { call: ToolCall; envelope: ToolResultEnvelope }[],
    propagateErrors = true,
  ): Promise<void> {
    let firstError: unknown;
    for (const { call, envelope } of results) {
      try {
        if (!this.controlPlanePresentation) reporter.onToolResult(structuredClone(envelope));
      } catch (error) {
        firstError ??= error;
        logger.warn(
          { error: String(error), tool: envelope.toolName },
          "[Engine] ToolResult 已持久化，但 Reporter 通知失败",
        );
      }
      try {
        await this.hookService?.dispatch(
          envelope.status === "succeeded" ? "PostToolUse" : "PostToolUseFailure",
          {
            tool_name: call.name,
            tool_input: parseHookToolArguments(call.arguments),
            tool_call_id: call.id,
            tool_result: structuredClone(envelope),
          },
        );
      } catch (error) {
        firstError ??= error;
        logger.warn(
          { error: String(error), tool: envelope.toolName },
          "[Engine] ToolResult 已持久化，但 PostToolUse Hook 通知失败",
        );
      }
      try {
        await this.postToolResultHook?.(call, structuredClone(envelope));
      } catch (error) {
        firstError ??= error;
        logger.warn(
          { error: String(error), tool: envelope.toolName },
          "[Engine] ToolResult 已持久化，但宿主结果 Hook 通知失败",
        );
      }
    }
    if (propagateErrors && firstError !== undefined) throw firstError;
  }

  /** 执行单个工具调用并返回观察结果消息 + 原始结果 (带日志 + 错误自愈注入) */
  private async runOneTool(
    toolCall: ToolCall,
    reporter: Reporter,
    parentSpan?: Span,
    signal?: AbortSignal,
    step?: ToolExecutionStep,
  ): Promise<ToolExecutionOutcome> {
    const toolSpan = parentSpan?.startChild("Tool.Execute", {
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      arguments: toolCall.arguments,
    });
    try {
      signal?.throwIfAborted();
      const guardDecision = this.guardrail.beforeCall(toolCall);
      const runtimeRun = this.runtimePort?.currentRun();
      let result: ToolResult;
      let runtimeStatus: EngineRuntimeToolResultStatus;
      let dispatched = false;
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
        runtimeStatus = "rejected";
      } else {
        signal?.throwIfAborted();
        // Registry 在最终参数/权限与资源准入通过后，物理执行前提交 T1。
        result = await this.registry.execute(toolCall, {
          signal,
          step,
          origin: "model",
          beforeDispatch: async (finalCall) => {
            await runtimeRun?.recordToolStarted(finalCall.id, finalCall.name, finalCall.arguments, {
              step,
              origin: "model",
              recoveryPolicy: this.registry.getRecoveryPolicy?.(finalCall.name, step),
              argumentRedactionSecrets: this.toolResultRedactionSecrets,
            });
            dispatched = true;
          },
          onOutput: ({ stream, chunk }) => {
            // 精确值可能横跨多个 chunk，不能安全地逐块替换。启用宿主清理边界时
            // 禁止转发原始流；完成后的 ToolResult 仍会以已清理形式正常发布。
            if (!signal?.aborted && this.toolResultRedactionSecrets.length === 0) {
              reporter.onToolOutput?.(toolCall.name, stream, chunk, toolCall.id);
            }
          },
        });
        runtimeStatus = !dispatched ? "rejected" : result.isError ? "failed" : "succeeded";
      }
      result = redactToolResult(result, this.toolResultRedactionSecrets);

      // 【核心拦截与注入】工具执行失败时,交由 RecoveryManager 诊断并注入"锦囊妙计"。
      // 化被动为主动:不再冷冰冰陈述报错,而是给出带强烈倾向性的行动指南,
      // 引导大模型进入标准排障 SOP(如"请先使用 read_file 重新查看文件")。
      let finalOutput = result.output;
      if (result.isError) {
        finalOutput = this.recovery.analyzeAndInject(toolCall.name, result.output);
        logger.warn({ tool: toolCall.name }, `-> [Recovery] ❌ 注入救援指南: ${toolCall.name}`);
      }
      const readOnly = this.registry.isReadOnlyTool?.(toolCall.name) ?? false;
      const reminder = this.guardrail.afterCall(toolCall, result, { readOnly });
      const builtResult = runtimeRun
        ? await this.buildRuntimeToolResultMessage(
            runtimeRun,
            toolCall,
            result,
            finalOutput,
            runtimeStatus,
          )
        : buildEphemeralToolResult(toolCall, result, finalOutput, runtimeStatus);
      const { message, envelope } = builtResult;

      try {
        toolSpan?.addAttributes({
          isError: result.isError,
          outputPreview: truncate(message.content, 500),
          rawOutputPreview:
            finalOutput === result.output ? undefined : truncate(result.output, 500),
        });
      } catch (error) {
        logger.warn(
          { error: String(error), tool: toolCall.name },
          "[Tracing] ToolResult 属性记录失败",
        );
      }
      return {
        message,
        report: envelope,
        ...(reminder ? { reminder } : {}),
      };
    } catch (err) {
      recordTraceError(toolSpan, err);
      throw err;
    } finally {
      try {
        toolSpan?.end();
      } catch (error) {
        logger.warn({ error: String(error), tool: toolCall.name }, "[Tracing] Tool span 收口失败");
      }
    }
  }

  private async buildRuntimeToolResultMessage(
    runtimeRun: EngineRuntimeRun,
    toolCall: ToolCall,
    result: ToolResult,
    modelOutput: string,
    status: EngineRuntimeToolResultStatus,
  ): Promise<{ message: Message; envelope: ToolResultEnvelope }> {
    const built = buildRuntimeToolResultInput(toolCall, result, modelOutput, status);
    return {
      message:
        status === "rejected"
          ? runtimeRun.registerUndispatchedToolResult(built.input)
          : runtimeRun.registerToolResult(built.input),
      envelope: built.envelope,
    };
  }

  private async runGraceCall(
    session: Session,
    systemPrompt: string,
    turnTail: string,
    candidateTools: ToolDefinition[],
    reason: string,
    reporter: Reporter,
    parentSpan?: Span,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const preserveToolPrefix =
      candidateTools.length > 0 &&
      this.provider.requestCapabilities?.toolChoiceNoneWithTools === true;
    // Claude 的 auto → none 会使 messages 层重新计算；保留相同 tools 后，
    // 显式 tools/system cache breakpoint 仍可复用，避免 grace 整段前缀全失效。
    const graceTools = preserveToolPrefix ? candidateTools : [];
    // 本轮 Goal/Plan/Todo 已在 ephemeral turn tail 中可见，grace 消息只持久化控制指令。
    const gracePrompt = `[SYSTEM] 已达执行预算: ${reason}。立即停止工具调用,用纯文本总结:1)已完成 2)未完成 3)下一步建议。`;
    await session.commitMessages({
      role: "user",
      content: gracePrompt,
      providerData: { picoKind: "grace", picoHiddenFromTranscript: true },
    });
    const graceSpan = parentSpan?.startChild("LLM.GraceCall", {
      reason,
      availableToolCount: graceTools.length,
      toolChoiceNone: preserveToolPrefix,
    });
    try {
      const context = await this.prepareModelContext(
        session,
        systemPrompt,
        turnTail,
        graceTools,
        graceSpan,
        signal,
      );
      const costBefore = session.totalCostCNY;
      const providerResponse = await withProviderCallContext({ purpose: "grace" }, () =>
        this.generateWithOverflowRetry(
          session,
          systemPrompt,
          turnTail,
          graceTools,
          context,
          reporter,
          graceSpan,
          signal,
          true,
          preserveToolPrefix ? { toolChoice: "none" } : undefined,
        ),
      );
      signal?.throwIfAborted();
      // A compatible endpoint may ignore tool_choice:none. Grace never executes tools,
      // and it must not persist an unmatched assistant tool_use into the next request.
      const response: Message = { ...providerResponse };
      if (response.toolCalls !== undefined) {
        graceSpan?.addAttributes({ discardedToolCallCount: response.toolCalls.length });
        delete response.toolCalls;
      }
      if (response.content.trim().length === 0) {
        response.content = "已达执行预算，但模型未返回可用的纯文本总结。";
      }
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
    isSubagent = false,
  ): BudgetDecision {
    const decisions: BudgetDecision[] = [];
    if (response.usage) {
      // 锚定:记录上一轮真实输入 token,供下一轮 prepareModelContext/midTurn 估算。
      // 子代理的 promptTokens 远小于主代理,不能污染主代理的锚定值。
      if (!isSubagent) {
        this.lastAnchoredPromptTokens = response.usage.promptTokens;
      }
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
    if (session) return this.consumeResponseBudget(session, response, costBefore, true);

    // 非 Runtime 宿主可以直接构造 AgentEngine，此时没有可用的 Session 成本账本；
    // 仍严格结算 Provider 返回的 Token usage。
    if (!response.usage) return this.currentSubagentBudgetDecision();
    const decisions = [
      this.budget.consumeUsage(response.usage),
      this.goalManager?.consumeUsage(response.usage) ?? { allowed: true },
    ];
    return decisions.find((decision) => !decision.allowed) ?? { allowed: true };
  }

  private async reportMessage(
    reporter: Reporter,
    content: string,
    signal?: AbortSignal,
  ): Promise<void> {
    reporter.onMessage(content);
    await this.hookService?.dispatch("MessageDisplay", { role: "assistant", content }, { signal });
  }

  /** Resolve child execution dependencies, then keep its durable run inside the parent capability. */
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
    const runner = new SubagentRunner({
      workDir: this.workDir,
      usageSession: this.usageSession,
      runtimePort: this.runtimePort,
      skillLoaderFactory: this.skillLoaderFactory,
      recovery: this.recovery,
      toolResultRedactionSecrets: this.toolResultRedactionSecrets,
      maxToolConcurrency: AgentEngine.MAX_TOOL_CONCURRENCY,
      onRetry: this.makeRetryReporter(),
      budget: {
        currentDecision: () => this.currentSubagentBudgetDecision(),
        consumeResponse: (runtime, response, costBefore) =>
          this.consumeSubagentResponseBudget(runtime, response, costBefore),
      },
      publishCommittedToolBatch: (reporter, calls, outcomes, order) =>
        this.publishCommittedToolBatch(reporter, calls, outcomes, order),
    });
    const run = () => runner.run(taskPrompt, readOnlyRegistry, runtime, reporter, opts);
    const runAttributed = () =>
      withProviderCallContext({ purpose: "subagent", ...(opts.usageAttribution ?? {}) }, () =>
        runtime.compactor ? runtime.compactor.runInIsolatedScope(run) : run(),
      );
    const runtimePort = this.runtimePort;
    const parentRun = runtimePort?.currentRun();
    if (!parentRun) return runAttributed();
    const runtimeCapability = parentRun.runtimeCapability;
    if (!runtimeCapability) {
      throw new Error(
        `Nested Runtime run ${parentRun.runId} does not hold a live Session write capability`,
      );
    }

    if (!runtimePort) {
      throw new Error("Nested Runtime run requires an injected runtimePort");
    }
    const parentToolCallId = runtimePort.currentToolCallId();
    const childRun = await runtimePort.startRun({
      // The parent Session owns the durable run directory even when the child operates
      // in an isolated worktree. This keeps one recoverable session ledger.
      parentRunId: parentRun.runId,
      ...(parentToolCallId ? { parentToolCallId } : {}),
      capability: runtimeCapability,
    });
    return childRun.run(async () => {
      const result = await runAttributed();
      await childRun.recordTranscriptMessage({
        role: "assistant",
        content: result.summary,
        providerData: {
          picoKind: "subagent_report",
          picoSubagentStatus: result.status,
          ...(result.evidenceRefs.length > 0
            ? { picoSubagentEvidenceRefs: result.evidenceRefs }
            : {}),
        },
      });
      return result;
    }, opts.signal);
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

/**
 * 空 run 防线：主循环正常走完但本轮没有任何带内容/工具调用的 assistant 消息，
 * 几乎必是 provider 端点返回了空流（网关 200 + 0 字节 SSE 的实测形态，会话层
 * 表现为 run "succeeded" 但零 assistantMessage，TUI 无任何显示）。此处
 * fail-loud 抛错，复用既有 run 失败可见性链路，把静默空回合变成可诊断错误。
 */
function assertRunProducedModelOutput(messages: readonly Message[]): void {
  const produced = messages.some(
    (message) =>
      message.role === "assistant" &&
      (message.content.trim() !== "" || (message.toolCalls?.length ?? 0) > 0),
  );
  if (!produced) {
    throw new Error(
      "模型本轮零输出（无回复内容、无工具调用）：疑似 provider 端点返回空流（HTTP 200 + 0 字节）。请检查模型路由或端点状态后重试。",
    );
  }
}

function memoryStepRejects(calls: readonly ToolCall[], index: number): boolean {
  const first = calls.findIndex((call) => call.name === "memory_remember");
  return first === 0 ? index !== 0 : first > 0 && calls[index]?.name === "memory_remember";
}
