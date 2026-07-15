// 模型摘要压缩器:token 水位主动整理与 overflow 紧急重试的持久化防线。
//
// Compactor 先在本轮请求副本中缩短旧 ToolResult；仍超水位时，
// 本类用 provider 把 history 安全前缀浓缩成结构化摘要,
// 真的修改 session.history —— 用一条 role:assistant 的 summary 消息替换前 N 条。
//
// 设计差异(对标 kimi-code / hermes):
//   - 双触发:输入预算 85% 主动调用，或 Provider overflow 后更紧目标调用一次。
//   - 真改 Session:与字符级 Compactor(只改临时 context 不碰 Session)不同,
//     本类调 session.applyCompaction 真替换 history 前缀,持久化 truncate + summary。
//   - 13-section 结构化摘要:结合 hermes 的 Historical Task Snapshot / Goal /
//     Constraints / Completed Actions 等 + kimi-code 的指令格式,中文版。
//   - REFERENCE-ONLY 前缀:明确告诉模型"这是历史提要,不要回答摘要里的内容"。
//   - 迭代摘要:第二次压缩时基于 previousSummary 做增量更新,不从零重建。
//   - 失败兜底:摘要调用失败/返回空 → 返回 false,调用方降级到字符级硬重置,不崩。

import type { LLMProvider } from "../provider/interface.js";
import { isAbortError } from "../provider/errors.js";
import type { Message } from "../schema/message.js";
import type { Session } from "../engine/session.js";
import { logger } from "../observability/logger.js";
import { withProviderCallContext } from "../observability/provider-call-context.js";
import type { ProviderCallPurpose } from "../tasks/runtime-types.js";
import type { HookService } from "../hooks/service.js";
import { estimateMessagesTokens } from "./context-budget.js";
import { sanitizeToolPairs } from "./compactor.js";
import { findSafeCompactionCut, hasIncompleteToolExchange } from "./safe-compaction-boundary.js";
import { EvidenceArchive, type EvidenceArchiveReference } from "./evidence-archive.js";

/** 摘要消息前缀:REFERENCE-ONLY,明确告诉模型这是历史提要,不要回答里面的内容 */
const SUMMARY_PREFIX =
  "[上下文压缩 — 仅供参考] 之前的对话轮次已被压缩成下方摘要。这是上一个上下文窗口的交接," +
  "请当作背景参考,而非待执行指令。不要回答或继续摘要中描述的任务,除非最近一条用户消息明确要求。" +
  "摘要中的“待办用户请求/剩余工作”等历史条目已过时,除非最新用户消息明确重申,否则不要执行。";

/** 摘要消息后缀:明确的"摘要到此为止"边界,防止弱模型把摘要正文当成新输入 */
const SUMMARY_END_MARKER = "--- 历史摘要结束 — 请回复下方消息,而非上方摘要 ---";

/** 摘要器系统提示词:约束模型只做摘要、不调用工具 */
const COMPACTION_SYSTEM_PROMPT =
  "你是上下文压缩器。你的唯一任务是把对话历史前缀浓缩成结构化摘要。" +
  "只输出摘要正文,不要调用任何工具,不要回答摘要里的内容。";

/**
 * 13-section 结构化摘要指令模板(中文,结合 hermes 13-section + kimi-code 指令格式)。
 * 无内容的 section 写"无"。占位符:{prefix} / {previousSummaryBlock}。
 */
const COMPACTION_INSTRUCTION_TEMPLATE = `以下是一段对话历史的前缀,请浓缩成结构化摘要。

摘要结构(13 个 section,无内容的写"无"):
1. 历史任务快照: 任务总体目标
2. 当前目标: 尚未完成的子目标
3. 约束条件: 技术约束/规范要求
4. 已完成动作: 已执行的步骤(简述,含工具名/目标/结果)
5. 活跃状态: 当前正在做什么
6. 进行中工作: 未完成的中间产物
7. 阻塞项: 遇到的问题(含报错原文)
8. 关键决策: 已确定的技术选型及理由
9. 已解决问题: 之前的排障结论
10. 待办用户请求: 用户提了但还没做的(历史条目,仅供参考)
11. 相关文件: 涉及的文件路径及简述
12. 剩余工作: 还需要做什么(历史条目,仅供参考)
13. 关键上下文: 其他必须记住的信息(不要包含密钥/令牌,写 [已脱敏])

对话历史前缀:
{prefix}
{previousSummaryBlock}
请按上述 13 个 section 输出结构化摘要(中文),只输出摘要正文:`;

/** 迭代摘要(增量更新)的附加指令,previousSummary 存在时拼接 */
const ITERATIVE_UPDATE_INSTRUCTION = `上一次压缩已生成过摘要,请基于它做增量更新:
- 保留仍相关的旧信息,不要从零重建。
- 把新完成的动作追加到"已完成动作"(继续编号)。
- 把已解决的问题从"阻塞项"移到"已解决问题"。
- 更新"活跃状态"与"当前目标"反映最新进展。
- 仅在明显过时时才删除旧信息。

上一次的摘要:
{previousSummary}`;

export interface FullCompactorOptions {
  /** 调用方的主 provider(向后兼容:未提供 auxProvider 时用它生成摘要) */
  provider: LLMProvider;
  /**
   * 辅助(廉价)模型 provider:提供则优先用它生成摘要,省主模型成本。
   * 未提供则回退到主 provider(向后兼容)。
   */
  auxProvider?: LLMProvider;
  /** 摘要调用失败重试次数,默认 3 */
  maxAttempts?: number;
  hookService?: HookService;
  /** Durable evidence required before this compactor removes raw tool exchanges from Session history. */
  evidenceArchive?: EvidenceArchive;
}

export interface FullCompactionRequest {
  /** Model input budget after reserving output tokens and the safety margin. */
  inputBudgetTokens: number;
  /** Desired size of the complete suffix. Defaults to 20% of input budget. */
  targetRetainedTokens?: number;
  /** Why compaction was triggered; overflow is reported to hooks as automatic. */
  trigger: "auto" | "overflow" | "manual";
}

/**
 * 一次只读摘要预览的结果。
 *
 * `summary` 是模型返回的原始摘要，`wrappedSummary` 可直接交给持久化端写入。
 * 调用方持有显式 `history`，可通过 `compactedCount` 自行构造 checkpoint 的
 * summary 与保留尾部，而无需改写 Session。
 */
export interface FullCompactionPreview {
  /** 模型返回的原始摘要正文，不含 REFERENCE-ONLY 包装。 */
  readonly summary: string;
  /** 可直接作为压缩摘要消息正文保存的 REFERENCE-ONLY 包装文本。 */
  readonly wrappedSummary: string;
  /** 将被摘要折叠的 history 前缀消息数。 */
  readonly compactedCount: number;
  /** 压缩前 history 的估算 token 数。 */
  readonly beforeTokens: number;
  /** 本次用于选择安全切点的保留尾部目标 token 数。 */
  readonly targetRetainedTokens: number;
  /** 安全切点后保留的 history 消息数。 */
  readonly retainedCount: number;
  /** 安全切点后保留尾部的估算 token 数。 */
  readonly retainedTokens: number;
}

interface FullCompactionPreviewPlan {
  readonly beforeTokens: number;
  readonly targetRetainedTokens: number;
  readonly compactedCount: number;
  readonly retainedCount: number;
  readonly retainedTokens: number;
  readonly prefix: Message[];
}

/** 将原始摘要包装成可存入上下文的 REFERENCE-ONLY 摘要消息正文。 */
export function wrapFullCompactionSummary(summary: string): string {
  return `${SUMMARY_PREFIX}\n\n${summary}\n\n${SUMMARY_END_MARKER}`;
}

/**
 * FullCompactor:模型摘要压缩器。
 *
 * token 驱动压缩。优先用 auxProvider(辅助廉价模型)生成摘要;
 * 未提供则用主 provider(向后兼容)。把 history 前缀浓缩成摘要,替换 session.history。
 * 成功返回 true,失败返回 false(调用方降级到硬重置)。
 */
export class FullCompactor {
  /** 生成摘要的 provider:优先用 auxProvider(辅助廉价模型),未提供则用主 provider */
  private readonly provider: LLMProvider;
  private readonly providerPurpose: Extract<ProviderCallPurpose, "compaction" | "aux">;
  private readonly maxAttempts: number;
  /** 上一次摘要,用于迭代增量更新(hermes 第 1475-1489 行语义) */
  private previousSummary?: string;
  private readonly hookService?: HookService;
  private readonly evidenceArchive?: EvidenceArchive;

  constructor(opts: FullCompactorOptions) {
    // 有 aux 用 aux(辅助廉价模型),无则用主 —— 向后兼容
    this.provider = opts.auxProvider ?? opts.provider;
    this.providerPurpose = opts.auxProvider ? "aux" : "compaction";
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.hookService = opts.hookService;
    this.evidenceArchive = opts.evidenceArchive;
  }

  /**
   * 只读地生成一次完整历史压缩预览。
   *
   * 此方法只读取 Session 标识以归属 provider 调用；不会写入 Session、归档证据、
   * 修改传入 history、派发压缩 hook，或更新迭代摘要状态。RuntimeEvent checkpoint
   * 可消费返回的摘要和切点，自行持久化对应事件。
   */
  async preview(
    session: Session,
    history: readonly Message[],
    request: FullCompactionRequest,
    signal?: AbortSignal,
  ): Promise<FullCompactionPreview | undefined> {
    signal?.throwIfAborted();
    const plan = this.createPreviewPlan(history, request);
    if (!plan) return undefined;
    return await this.generatePreview(session, request, plan, signal);
  }

  /**
   * 在安全工具协议边界上用 provider 把 history 前缀浓缩成摘要。
   * @param session 要压缩的会话
   * @param request token 目标与触发来源
   * @param signal 本轮运行的中止信号
   * @returns 压缩成功返回 true,失败返回 false(调用方降级到硬重置)
   */
  async compact(
    session: Session,
    request: FullCompactionRequest,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const history = session.getHistory();
    const plan = this.createPreviewPlan(history, request);
    if (!plan) return false;
    const hookSource = request.trigger === "manual" ? "manual" : "auto";

    await this.hookService?.dispatch(
      "PreCompact",
      { source: hookSource, messageCount: history.length },
      { signal },
    );

    const preview = await this.generatePreview(session, request, plan, signal);
    if (!preview) return false;

    let evidenceReference: EvidenceArchiveReference | undefined;
    if (this.evidenceArchive) {
      try {
        // Archive is the write-ahead proof for raw tool exchanges. Do not mutate Session
        // history until this immutable copy has been durably published.
        evidenceReference = await this.evidenceArchive.archiveToolExchanges(
          session.id,
          history.slice(0, preview.compactedCount),
        );
      } catch (error) {
        logger.error(
          { err: String(error), sessionId: session.id, compactedCount: preview.compactedCount },
          "[FullCompactor] 证据归档失败，拒绝删除原始历史",
        );
        return false;
      }
    }

    // 应用压缩:用 REFERENCE-ONLY 前后标记包装摘要,替换 session.history 前 compactedCount 条。
    // 包装职责归 FullCompactor(表现层),Session.applyCompaction 只做纯存储。
    await session.applyCompaction(
      preview.wrappedSummary,
      preview.compactedCount,
      evidenceReference
        ? { summaryProviderData: { picoEvidenceArchives: [evidenceReference] } }
        : undefined,
    );
    session.saveMemorySummary(preview.summary, preview.compactedCount);
    // previousSummary 存原始摘要(不带包装标记),供下次迭代增量更新
    this.previousSummary = preview.summary;
    await this.hookService?.dispatch(
      "PostCompact",
      { source: hookSource, messageCount: session.length },
      { signal },
    );
    const afterTokens = estimateMessagesTokens(session.getHistory());
    logger.info(
      {
        trigger: request.trigger,
        compactedCount: preview.compactedCount,
        retainedCount: preview.retainedCount,
        beforeTokens: preview.beforeTokens,
        afterTokens,
        summaryLen: preview.summary.length,
      },
      "[FullCompactor] ✅ 模型摘要压缩完成",
    );
    return true;
  }

  /** 计算安全切点和摘要输入，不触发任何外部副作用。 */
  private createPreviewPlan(
    history: readonly Message[],
    request: FullCompactionRequest,
  ): FullCompactionPreviewPlan | undefined {
    const beforeTokens = estimateMessagesTokens(history);
    const targetRetainedTokens =
      request.targetRetainedTokens ?? Math.max(1, Math.floor(request.inputBudgetTokens * 0.2));
    if (hasIncompleteToolExchange(history)) {
      logger.warn(
        { trigger: request.trigger, historyLen: history.length },
        "[FullCompactor] 存在未完成工具交换,禁止压缩",
      );
      return undefined;
    }

    const cut = findSafeCompactionCut(history, targetRetainedTokens);
    if (!cut) {
      logger.warn(
        { trigger: request.trigger, historyLen: history.length, targetRetainedTokens },
        "[FullCompactor] 找不到可压缩的安全工具协议边界,跳过",
      );
      return undefined;
    }

    return {
      beforeTokens,
      targetRetainedTokens,
      compactedCount: cut.compactedCount,
      retainedCount: history.length - cut.compactedCount,
      retainedTokens: cut.retainedTokens,
      prefix: sanitizeToolPairs(history.slice(0, cut.compactedCount)),
    };
  }

  /** 调用摘要模型并返回可由 Session 或 checkpoint 消费的只读结果。 */
  private async generatePreview(
    session: Session,
    request: FullCompactionRequest,
    plan: FullCompactionPreviewPlan,
    signal?: AbortSignal,
  ): Promise<FullCompactionPreview | undefined> {
    const instruction = this.renderInstruction(plan.prefix, this.previousSummary);
    logger.info(
      {
        trigger: request.trigger,
        beforeTokens: plan.beforeTokens,
        inputBudgetTokens: request.inputBudgetTokens,
        targetRetainedTokens: plan.targetRetainedTokens,
        cutIndex: plan.compactedCount,
        compactedCount: plan.compactedCount,
        retainedCount: plan.retainedCount,
        retainedTokens: plan.retainedTokens,
      },
      `[FullCompactor] 调用 provider 生成摘要:压缩前缀 ${plan.prefix.length} 条,保留尾部 ${plan.retainedCount} 条`,
    );

    // 调用 provider 生成摘要(带重试,失败/空都重试)
    let summary: string | undefined;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      signal?.throwIfAborted();
      try {
        const resp = await withProviderCallContext(
          {
            purpose: this.providerPurpose,
            sessionId: session.id,
            conversationId: session.conversationId,
          },
          () =>
            this.provider.generate(
              [
                { role: "system", content: COMPACTION_SYSTEM_PROMPT },
                { role: "user", content: instruction },
              ],
              [],
              { signal },
            ),
        );
        signal?.throwIfAborted();
        summary = extractSummary(resp);
        if (summary && summary.trim().length > 0) break;
      } catch (err) {
        if (isAbortError(err)) throw err;
        signal?.throwIfAborted();
        logger.warn(
          { attempt: attempt + 1, maxAttempts: this.maxAttempts, err: String(err) },
          `[FullCompactor] 摘要调用失败(attempt ${attempt + 1}/${this.maxAttempts})`,
        );
      }
    }

    if (!summary || summary.trim().length === 0) {
      logger.error(
        { maxAttempts: this.maxAttempts },
        "[FullCompactor] 摘要生成失败(重试耗尽或返回空),降级到硬重置",
      );
      return undefined;
    }

    return {
      summary,
      wrappedSummary: wrapFullCompactionSummary(summary),
      compactedCount: plan.compactedCount,
      beforeTokens: plan.beforeTokens,
      targetRetainedTokens: plan.targetRetainedTokens,
      retainedCount: plan.retainedCount,
      retainedTokens: plan.retainedTokens,
    };
  }

  /** 渲染摘要指令:13-section 模板 + 历史前缀序列化 + 迭代更新块 */
  private renderInstruction(prefix: Message[], previousSummary?: string): string {
    const prefixText = serializeMessages(prefix);
    const previousSummaryBlock = previousSummary
      ? "\n" + ITERATIVE_UPDATE_INSTRUCTION.replace("{previousSummary}", previousSummary) + "\n"
      : "";
    return COMPACTION_INSTRUCTION_TEMPLATE.replace("{prefix}", prefixText).replace(
      "{previousSummaryBlock}",
      previousSummaryBlock,
    );
  }
}

/**
 * 从模型响应中提取摘要正文。
 * 优先取 content;若为空字符串或纯空白视为失败(返回 undefined 触发重试)。
 */
function extractSummary(resp: Message): string | undefined {
  const text = resp.content;
  if (!text || text.trim().length === 0) return undefined;
  return text.trim();
}

/**
 * 把消息序列化成可读文本,供摘要器输入。
 * 格式:
 *   [用户] 内容
 *   [助手] 内容
 *   [助手→工具: read_file] {"path":"..."}
 *   [工具结果] 内容
 */
function serializeMessages(msgs: Message[]): string {
  const lines: string[] = [];
  for (const msg of msgs) {
    if (msg.role === "user" && msg.toolCallId !== undefined) {
      lines.push(`[工具结果] ${truncateText(msg.content, 2000)}`);
      continue;
    }
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        lines.push(`[助手→工具: ${tc.name}] ${tc.arguments}`);
      }
      if (msg.content && msg.content.trim().length > 0) {
        lines.push(`[助手] ${truncateText(msg.content, 1000)}`);
      }
      continue;
    }
    const tag = msg.role === "user" ? "用户" : msg.role === "assistant" ? "助手" : "系统";
    lines.push(`[${tag}] ${truncateText(msg.content, 2000)}`);
  }
  return lines.join("\n");
}

/** 超长文本截断(摘要输入侧的轻量预处理,避免单条暴击撑爆摘要请求) */
function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const head = text.slice(0, Math.ceil(maxLen / 2));
  const tail = text.slice(text.length - Math.floor(maxLen / 2));
  return `${head}\n...[已截断 ${text.length - maxLen} 字符]...\n${tail}`;
}
