import type { Message, ToolCall, ToolDefinition } from "../schema/message.js";
import type { LLMProvider } from "../provider/interface.js";
import type { RetryInfo } from "../provider/retry.js";
import { isAbortError } from "../provider/errors.js";
import type { Compactor } from "../context/compactor.js";
import type { RecoveryManager } from "../context/recovery.js";
import { SkillLoader } from "../context/skill.js";
import { logger } from "../observability/logger.js";
import { truncate } from "../observability/trace.js";
import type { Registry } from "../tools/registry.js";
import type { SubagentRunOptions, SubagentResult } from "../tools/subagent.js";
import { ToolScheduler } from "../tools/tool-scheduler.js";
import { ToolAccesses } from "../tools/tool-access.js";
import { SUBAGENT_OUTPUT_BUDGET } from "../tools/subagent-budget.js";
import {
  buildOverLimitRejectionText,
  MAX_TOOL_RESULT_BYTES,
} from "../tools/tool-result-observation.js";
import { snapshotToolDefinitions } from "../provider/prompt-cache.js";
import type { EngineRuntimePort, EngineRuntimeToolResultInput } from "./runtime-port.js";
import type { ToolResultEnvelope } from "./tool-result-contract.js";
import { SilentReporter, type Reporter } from "./reporter.js";
import type { Session } from "./session.js";
import type { BudgetDecision } from "./budget.js";
import { generateSubagentResponse, buildSubagentEvidenceSnapshot } from "./subagent-context.js";
import {
  buildRuntimeToolResultInput,
  buildEphemeralToolResult,
  redactToolResult,
} from "./tool-result-builder.js";

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

/** 子代理 summary 低于此字数则触发一轮扩写(对齐 Kimi Code SUMMARY_MIN_LENGTH) */
const SUBAGENT_SUMMARY_MIN_CHARS = 200;
/** summary 续写提示词:要求子代理把过短的总结扩写成完整汇报 */
const SUBAGENT_SUMMARY_CONTINUATION_PROMPT =
  "你上一轮的总结过于简短,主架构师无法据此决策。请直接重写为结构化纯文本：先给结论，再列关键证据(文件:行号)、未验证风险和下一步。不要重放原始日志，不要调用任何工具。";
const SUBAGENT_FINALIZE_PROMPT =
  "[FINALIZE] 已进入预留的最终收口轮。立即停止探索和工具调用，只基于当前上下文中已收集的证据输出纯文本汇报：" +
  "1) 结论；2) 已确认的事实与文件:行号证据；3) 未完成或未验证风险；4) 主 Agent 可直接采取的下一步。通常控制在 1000–2000 字符，简单任务可更短，不要重放原始日志。" +
  "若任务整体无法完成，结论必须以「无法完成：原因」开头如实声明，不要用完成口吻收场。";
const SUBAGENT_EMPTY_SUMMARY_FALLBACK =
  "子代理未能生成可用的最终总结；请主 Agent 根据已回传的工具证据继续收口。";
/** 子代理总结开篇的引导性标签（"总结：" / "- 结论：" / "1. Report:" 等），判定失败宣言前剥离。 */
const SUBAGENT_SUMMARY_LEAD_RE =
  /^(?:[#*\->\s]*|\d+[.、)]\s*)*(?:总结|汇报|报告|结论|任务状态|summary|report|result|status)\s*[:：\-—]*\s*/i;
/** 失败宣言锚点：总结首行（剥标签后）以下列词开头才判定失败——保守锚定，正文中段的"修复了失败测试"等不误伤。 */
const SUBAGENT_FAILURE_LEADS = [
  "无法完成",
  "未能完成",
  "无法实现",
  "无法达成",
  "无法执行",
  "任务失败",
  "执行失败",
  "我无法完成",
  "我无法做到",
  "未完成任务",
  "unable to complete",
  "failed to complete",
  "could not complete",
  "cannot complete",
  "did not complete",
  "task failed",
  "did not finish",
] as const;

interface SubagentRunnerOptions {
  readonly workDir: string;
  readonly usageSession?: Session;
  readonly runtimePort?: EngineRuntimePort;
  readonly skillLoaderFactory?: (workDir: string) => SkillLoader;
  readonly recovery: RecoveryManager;
  readonly toolResultRedactionSecrets: readonly string[];
  readonly maxToolConcurrency: number;
  readonly onRetry: (info: RetryInfo) => void;
  /** The engine owns the shared budget and cumulative Session cost high-water mark. */
  readonly budget: {
    currentDecision(): BudgetDecision;
    consumeResponse(
      runtime: SubagentExecutionRuntime,
      response: Message,
      costBefore: number,
    ): BudgetDecision;
  };
  /** The shared notification boundary runs only after the batch has committed. */
  readonly publishCommittedToolBatch: (
    reporter: Reporter,
    calls: readonly ToolCall[],
    outcomes: readonly { readonly message: Message; readonly report: ToolResultEnvelope }[],
    notificationOrder: readonly number[],
  ) => Promise<void>;
}
/** Executes one isolated child conversation; the parent owns Runtime capability and attribution. */
export class SubagentRunner {
  constructor(private readonly options: SubagentRunnerOptions) {}
  /** 每个子代理保留注入 Compactor 的行为，但使用独立压缩进度。 */
  async run(
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

    const initialTools = snapshotToolDefinitions(readOnlyRegistry.getAvailableTools());
    const initialToolNames = new Set(initialTools.map((tool) => tool.name));
    // 委派层会传入 host/worktree 的可信运行目录；不从任务 context 或模型输出猜测根目录。
    const runtimeWorkspaceRoot = opts.workDir ?? this.options.workDir;
    const canViewSkills = initialToolNames.has("skill_view");
    const skillIndex = canViewSkills
      ? await (
          this.options.skillLoaderFactory?.(runtimeWorkspaceRoot) ??
          new SkillLoader(runtimeWorkspaceRoot)
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
    await this.options.runtimePort?.currentRun()?.recordTranscriptMessage(contextHistory[1]!);

    // maxTurns 可由调用方覆盖(默认 10)。最后一轮始终预留为 tools=[] 收口，
    // 不通过提高上限隐藏控制流问题。
    const maxSubTurns = Math.max(1, opts.maxTurns ?? 10);
    const depth = opts.depth ?? 0;
    const maxSpawnDepth = opts.maxSpawnDepth ?? 2;
    if (depth > maxSpawnDepth) {
      throw new Error(`子智能体超过最大委派深度 ${maxSpawnDepth}`);
    }
    let turnCount = 0;

    for (;;) {
      signal?.throwIfAborted();
      const availableBudget = this.options.budget.currentDecision();
      if (!availableBudget.allowed) {
        return this.finalizeSubagentResult(
          "partial",
          `子代理已停止：${availableBudget.reason ?? "执行预算已用尽"}。`,
          taskPrompt,
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

      // 【驾驭底线】普通探索轮仅能获取传入的受限 Registry。明确支持
      // tool_choice:none + tools 的 Provider 在收口轮保留同一 Schema，
      // 避免为了纯文本总结丢失稳定 tools 缓存前缀。
      const retainFinalizeToolPrefix =
        finalizing && runtime.provider.requestCapabilities?.toolChoiceNoneWithTools === true;
      const availableTools = finalizing
        ? retainFinalizeToolPrefix
          ? initialTools
          : []
        : initialTools;

      // 响应式溢出重试:子代理用独立 contextHistory(非 Session 驱动),无法重取
      // WorkingMemory,故仅用更小的 maxChars 预算对 contextHistory 重新压缩重试。
      let actionResp: Message;
      const usageSession = runtime.usageSession ?? this.options.usageSession;
      const costBefore = usageSession?.totalCostCNY ?? 0;
      try {
        await this.options.runtimePort?.currentRun()?.assertNoUnresolvedToolEffects();
        actionResp = await generateSubagentResponse(
          contextHistory,
          availableTools,
          rep,
          runtime,
          this.options.onRetry,
          signal,
          retainFinalizeToolPrefix ? { toolChoice: "none" } : undefined,
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
          buildSubagentPartialSummary(contextHistory),
          taskPrompt,
        );
      }
      const budgetDecision = this.options.budget.consumeResponse(runtime, actionResp, costBefore);
      contextHistory.push(actionResp);
      await this.options.runtimePort?.currentRun()?.recordTranscriptMessage(actionResp);

      if (actionResp.content) {
        rep.onMessage(`[Subagent] ${actionResp.content}`);
      }

      // 并发子代理可能同时在途，因此限额最多被已在途的单次响应超出。
      // 每个响应结算后立即停止该子代理，且其他子代理在下一次调用前会共享检查。
      if (!budgetDecision.allowed) {
        const evidence = buildSubagentPartialSummary(contextHistory);
        return this.finalizeSubagentResult(
          "partial",
          `${evidence}\n\n子代理已停止：${budgetDecision.reason ?? "执行预算已用尽"}。`,
          taskPrompt,
        );
      }

      // 【核心退出条件】子智能体不调工具了,说明做好了总结汇报
      const toolCalls = actionResp.toolCalls ?? [];
      if (toolCalls.length === 0 || finalizing) {
        if (finalizing) {
          const summary =
            toolCalls.length === 0 && usableSummary(actionResp.content)
              ? actionResp.content
              : buildSubagentPartialSummary(contextHistory);
          logger.warn(
            { turns: turnCount, maxSubTurns },
            `[Subagent] 已进入预留收口轮，以 partial 状态返回已收集证据。`,
          );
          return this.finalizeSubagentResult("partial", summary, taskPrompt);
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
            const continuationBudget = this.options.budget.currentDecision();
            if (!continuationBudget.allowed) {
              return this.finalizeSubagentResult(
                "partial",
                `${summary}\n\n子代理已停止：${continuationBudget.reason ?? "执行预算已用尽"}。`,
                taskPrompt,
              );
            }
            const continuationCostBefore = usageSession?.totalCostCNY ?? 0;
            await this.options.runtimePort?.currentRun()?.assertNoUnresolvedToolEffects();
            const continuationResp = await generateSubagentResponse(
              contextHistory,
              runtime.provider.requestCapabilities?.toolChoiceNoneWithTools === true
                ? initialTools
                : [],
              rep,
              runtime,
              this.options.onRetry,
              signal,
              runtime.provider.requestCapabilities?.toolChoiceNoneWithTools === true
                ? { toolChoice: "none" }
                : undefined,
            );
            const continuationDecision = this.options.budget.consumeResponse(
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
                `${buildSubagentPartialSummary(contextHistory)}\n\n子代理已停止：${continuationDecision.reason ?? "执行预算已用尽"}。`,
                taskPrompt,
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
        if (!completed) summary = buildSubagentPartialSummary(contextHistory);
        logger.info(
          { turns: turnCount, status: completed ? "completed" : "partial" },
          `[Subagent] ✅ 探路者完成收口,返回总结。`,
        );
        const finalized = await this.finalizeSubagentResult(
          completed ? "completed" : "partial",
          summary,
          taskPrompt,
        );
        // D10④ 内容级熔断：自报 completed 但总结开篇明确声明失败 → 降级 error，
        // 宿主按失败结算（plan step 不落 completed）。
        // 放在 finalize 之后：报告 inline 收口与上限门照常，只改终态。
        if (finalized.status === "completed" && subagentDeclaresFailure(finalized.summary)) {
          logger.warn(
            { turns: turnCount, summaryHead: finalized.summary.slice(0, 80) },
            `[Subagent] 🔌 内容级熔断：自报完成但总结开篇为失败宣言，降级 error。`,
          );
          return {
            ...finalized,
            status: "error",
            error: "子代理自报任务失败（总结开篇失败宣言，内容级熔断降级）",
          };
        }
        return finalized;
      }

      // 执行只读工具的并发循环(资源冲突图调度,复用主循环的调度策略)
      const getAccesses = readOnlyRegistry.getAccesses;
      const runtimeRun = this.options.runtimePort?.currentRun();
      const completedToolReportIndexes: number[] = [];
      const scheduler = new ToolScheduler<{
        readonly message?: Message;
        readonly input?: EngineRuntimeToolResultInput;
        readonly report: ToolResultEnvelope;
      }>({
        maxConcurrency: this.options.maxToolConcurrency,
        signal,
      });
      const scheduled = toolCalls.map((tc, index) =>
        scheduler.add({
          accesses: getAccesses ? getAccesses.call(readOnlyRegistry, tc) : ToolAccesses.all(),
          settleOnAbort: true,
          start: async () => {
            signal?.throwIfAborted();
            rep.onToolCall(`[Subagent] ${tc.name}`, tc.arguments, tc.id);
            let dispatched = false;
            const executionContext = {
              signal,
              beforeDispatch: async (finalCall: ToolCall) => {
                await runtimeRun?.recordToolStarted(
                  finalCall.id,
                  finalCall.name,
                  finalCall.arguments,
                );
                dispatched = true;
              },
            };
            const rawResult = await (this.options.runtimePort
              ? this.options.runtimePort.runWithToolCall(tc.id, () =>
                  readOnlyRegistry.execute(tc, executionContext),
                )
              : readOnlyRegistry.execute(tc, executionContext));
            const result = redactToolResult(rawResult, this.options.toolResultRedactionSecrets);
            let finalOutput = result.output;
            if (result.isError) {
              finalOutput = this.options.recovery.analyzeAndInject(tc.name, result.output);
            }
            if (runtimeRun) {
              const builtResult = buildRuntimeToolResultInput(
                tc,
                result,
                finalOutput,
                !dispatched ? "rejected" : result.isError ? "failed" : "succeeded",
              );
              completedToolReportIndexes.push(index);
              return { input: builtResult.input, report: builtResult.envelope };
            }
            const builtResult = buildEphemeralToolResult(
              tc,
              result,
              finalOutput,
              result.isError ? "failed" : "succeeded",
            );
            completedToolReportIndexes.push(index);
            return { message: builtResult.message, report: builtResult.envelope };
          },
        }),
      );
      let subResults: Array<{
        readonly message?: Message;
        readonly input?: EngineRuntimeToolResultInput;
        readonly report: ToolResultEnvelope;
      }>;
      try {
        subResults = await Promise.all(scheduled);
        signal?.throwIfAborted();
      } catch (error) {
        if (signal?.aborted) await Promise.allSettled(scheduled);
        throw error;
      } finally {
        scheduler.dispose();
      }

      const observations = runtimeRun
        ? [
            ...(await runtimeRun.recordTranscriptToolResults(
              subResults.map((result, index) => {
                if (!result.input) {
                  throw new Error(`Subagent ToolResult ${String(index)} has no Runtime input`);
                }
                return result.input;
              }),
            )),
          ]
        : subResults.map((result, index) => {
            if (!result.message) {
              throw new Error(`Subagent ToolResult ${String(index)} has no in-memory projection`);
            }
            return result.message;
          });

      contextHistory.push(...observations);
      await this.options.publishCommittedToolBatch(
        rep,
        toolCalls,
        observations.map((message, index) => ({
          message,
          report: subResults[index]!.report,
        })),
        completedToolReportIndexes,
      );
    }
  }

  /**
   * ADR 26(票 E3):子代理报告不再外部化进 Evidence CAS——全文 inline 进
   * subagent_report transcript 事件与回传 summary,与工具结果入口上限门同款
   * 语义:超过 MAX_TOOL_RESULT_BYTES 时替换为指引主 Agent 有界重取的合成错误。
   *
   * 第 1 轮审查问题 3 修复:报告被上限门拒绝时,原始报告已永久丢弃,交付物
   * 只剩合成错误文本——终态结算与工具结果入口门对齐(超限工具结果按
   * isError/failed 结算),status 落 "error"(既有失败语义，plan step
   * 不落 completed),不再以 completed/partial
   * 收场掩盖"报告不可用"的事实。拒绝文本保留在 summary 供主 Agent 重取。
   */
  private async finalizeSubagentResult(
    status: "completed" | "partial",
    report: string,
    _taskPrompt: string,
  ): Promise<SubagentResult> {
    const rawSizeBytes = Buffer.byteLength(report, "utf8");
    if (rawSizeBytes > MAX_TOOL_RESULT_BYTES) {
      logger.warn(
        { status, rawSizeBytes, maxToolResultBytes: MAX_TOOL_RESULT_BYTES },
        "[Subagent] 完整报告超过入口上限,已被上限门拒绝并替换为合成错误,终态按失败结算",
      );
      return {
        status: "error",
        summary: buildOverLimitRejectionText("子代理完整报告 ", rawSizeBytes),
        evidenceRefs: [],
        error: `子代理完整报告 ${rawSizeBytes} 字节超过入口上限 ${MAX_TOOL_RESULT_BYTES} 字节,已被上限门拒绝（原文未保存）`,
      };
    }
    return { status, summary: report, evidenceRefs: [] };
  }
}

/**
 * D10④ 内容级熔断：子代理 loop 的"完成"是模型自报（不再调工具 + 总结可用），
 * 流程状态无法区分"真做完"与"做完样子但任务失败"。宿主若按 completed 记账
 * （例如 plan step completed），失败就被自报完成掩盖。Graph v2 Operator
 * 使用独立 RuntimeRun + agent_output 提交记录，不再经过本子代理结算路径。
 * 本函数只认总结开篇的明确失败宣言——保守换取零误伤：模糊表述交由宿主
 * 模型读 summary 自行判断，这里只兜底"模型亲口说失败"的下界。
 */
function subagentDeclaresFailure(summary: string): boolean {
  const firstLine = summary
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return false;
  const head = firstLine.replace(SUBAGENT_SUMMARY_LEAD_RE, "").toLowerCase();
  return SUBAGENT_FAILURE_LEADS.some((lead) => head.startsWith(lead));
}

function usableSummary(summary: string): boolean {
  return summary.trim().length > 0;
}

function buildSubagentPartialSummary(contextHistory: readonly Message[]): string {
  return buildSubagentEvidenceSnapshot(contextHistory) ?? SUBAGENT_EMPTY_SUMMARY_FALLBACK;
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
