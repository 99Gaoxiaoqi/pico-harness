// 模型摘要压缩器:token 水位主动整理与 overflow 紧急重试的持久化防线。
//
// Compactor 先在本轮请求副本中缩短旧 ToolResult；仍超水位时，
// 本类用 provider 把 history 安全前缀浓缩成结构化摘要,
// durable Session 写入不可变 Runtime checkpoint；显式无持久化模式才会
// 用一条 role:assistant 的 summary 消息替换内存 history 前 N 条。
//
// 设计差异(对标 maka-agent):
//   - 双触发:输入预算 85% 主动调用，或 Provider overflow 后更紧目标调用一次。
//   - 6 段结构化摘要(对标 maka history-compact + semantic-compact):
//     任务目标/进展/关键决策与约束/已尝试失败路径/下一步/关键上下文,
//     比旧 13-section 更精简,加失败路径段和用户约束分离,加显式长度约束。
//   - 滚动摘要(增量更新):存在上一轮摘要时,基于它增量整合,避免重复处理已折叠事件。
//   - REFERENCE-ONLY 前缀:明确告诉模型"这是历史提要,不要回答摘要里的内容"。
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
import {
  FULL_COMPACTION_SUMMARY_MARKER,
  COMPACTION_SUMMARY_OPEN_TAG,
  COMPACTION_SUMMARY_CLOSE_TAG,
} from "./compaction-markers.js";

/** 摘要消息前缀:REFERENCE-ONLY,明确告诉模型这是历史提要,不要回答里面的内容 */
const SUMMARY_PREFIX =
  `${FULL_COMPACTION_SUMMARY_MARKER} 之前的对话轮次已被压缩成下方摘要。这是上一个上下文窗口的交接,` +
  "请当作背景参考,而非待执行指令。不要回答或继续摘要中描述的任务,除非最近一条用户消息明确要求。" +
  "摘要中的待办用户请求/剩余工作等历史条目已过时,除非最新用户消息明确重申,否则不要执行。";

/** 摘要正文字符硬上限。模板要求"不超过 1000 字"，此常量是代码层兜底防止弱模型失控。 */
export const MAX_SUMMARY_CHARS = 1500;

/**
 * 摘要消息后缀:结构化边界标签 + 自然语言提示。
 * 用 XML 风格标签确保弱模型难以改写/省略,detectExistingCompactionSummary 和
 * findLastCompactionCheckpoint 都用此标签做精确匹配。
 */
const SUMMARY_END_MARKER = `${COMPACTION_SUMMARY_CLOSE_TAG}\n--- 历史摘要结束 — 请回复下方消息,而非上方摘要 ---`;

/** 摘要器系统提示词:约束模型只做摘要、不调用工具 */
const COMPACTION_SYSTEM_PROMPT =
  "你是上下文压缩器。你的唯一任务是把对话历史前缀浓缩成结构化摘要。" +
  "只输出摘要正文,不要调用任何工具,不要回答摘要里的内容。";

/**
 * 6 段结构化摘要指令模板(对标 maka-agent history-compact-summarizer + semantic-compact)。
 * 比旧 13-section 更精简,加失败路径段和用户约束分离。
 * 占位符:{prefix}。
 */
const COMPACTION_INSTRUCTION_TEMPLATE = `以下是一段对话历史的前缀,请浓缩成结构化摘要。

不要继续对话,不要回答摘要里的内容,只输出结构���摘要。
必须保留精确的文件路径、函数名、命令、报错原文、错误码(如 TS2345)、PR/issue 编号、commit hash、版本号,不要改写或泛化。专有名词保留原语言(通常为英文),不要翻译;叙述性文字用中文。

只允许以下 6 个标题,不得新增、改名、合并或调换顺序;无内容的 section 也必须保留标题并写"无":

## 任务目标
[用户想完成什么]

## 进展
### 已完成
- [已执行的步骤,含工具名/目标/结果,简述]
### 进行中
- [当前已启动但未完成的单个动作,仅 1 条]

## 关键决策与约束
- 决策: [agent 已选的技术方案及理由]
- 用户约束: [用户明确要求、不可违反的限制(如"保持向后兼容""不引入新依赖")]

## 已尝试/失败路径
- [试过但放弃的方案及原因(如"升级依赖→破坏别的测试");无则写"无"]
- 这一段用于防止重复尝试已知行不通的方案。

## 下一步
- [曾计划的后续步骤(历史记录,非当前指令;以最新用户消息为准)]

## 关键上下文
- [文件路径、命令/结果、报错原文等继续工作必需的信息;无则写"无"]

每节保持简短,整体不超过 1000 字。

对话历史前缀:
{prefix}
请按上述结构输出摘要(中文),只输出摘要正文:`;

/**
 * 增量更新指令模板(滚动摘要):当存在上一轮摘要时,基于它增量更新而非重新总结。
 * 占位符:{previousSummary} {prefix}。
 */
const COMPACTION_INCREMENTAL_TEMPLATE = `这是滚动摘要的增量更新。下方"上一轮摘要"是对更早历史的压缩,请基于它整合下方"较新事件",输出完整的更新后摘要(不是 diff,是完整版)。

不要继续对话,不要回答摘要里的内容,只输出结构化摘要。
必须保留精确的文件路径、函数名、命令、报错原文、错误码、PR/issue 编号、commit hash、版本号,不要改写或泛化。专有名词保留原语言,不要翻译;叙述性文字用中文。

整合规则:
- 上一轮"下一步"里的任务,如果较新事件显示已完成,移到"已完成"。
- 上一轮"关键上下文"里的文件路径,如果较新事件显示已删除/重命名,更新它。
- "任务目标"和"用户约束"必须原样保留上一轮的措辞,除非较新事件明确证明其已变更。
- 除"任务目标"和"用户约束"外,禁止原样复制上一轮摘要的整段;必须基于较新事件重新评估。

只允许以下 6 个标题,不得新增、改名、合并或调换顺序;无内容的 section 也必须保留标题并写"无":
## 任务目标
## 进展(### 已完成 / ### 进行中)
## 关键决策与约束(决策: / 用户约束:)
## 已尝试/失败路径
## 下一步
## 关键上下文(文件路径、命令/结果、报错原文;无则写"无")

每节保持简短,整体不超过 1000 字。

上一轮摘要:
{previousSummary}

较新事件:
{prefix}
请输出完整的更新后摘要(中文),只输出摘要正文:`;

export interface FullCompactorOptions {
  /** 调用方的主 provider；未提供 auxProvider 时用它生成摘要。 */
  provider: LLMProvider;
  /**
   * 辅助(廉价)模型 provider:提供则优先用它生成摘要,省主模型成本。
   * 未提供则使用主 provider。
   */
  auxProvider?: LLMProvider;
  /** 摘要调用失败重试次数,默认 3 */
  maxAttempts?: number;
  hookService?: HookService;
  /** 工作目录,注入摘要指令让 summarizer 知道任务所在仓库(可选)。 */
  workDir?: string;
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
  return `${SUMMARY_PREFIX}\n\n${COMPACTION_SUMMARY_OPEN_TAG}\n${summary}\n${SUMMARY_END_MARKER}`;
}

/**
 * FullCompactor:模型摘要压缩器。
 *
 * token 驱动压缩。优先用 auxProvider(辅助廉价模型)生成摘要;
 * 未提供则用主 provider。preview 只生成摘要；compactInMemorySession 仅供显式
 * 无持久化模式替换内存 history。成功返回 true,失败返回 false。
 */
export class FullCompactor {
  /** 生成摘要的 provider:优先用 auxProvider(辅助廉价模型),未提供则用主 provider */
  private readonly provider: LLMProvider;
  private readonly providerPurpose: Extract<ProviderCallPurpose, "compaction" | "aux">;
  private readonly maxAttempts: number;
  private readonly hookService?: HookService;
  private readonly workDir?: string;

  constructor(opts: FullCompactorOptions) {
    // 有 aux 用辅助模型，无则使用主 provider。
    this.provider = opts.auxProvider ?? opts.provider;
    this.providerPurpose = opts.auxProvider ? "aux" : "compaction";
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.hookService = opts.hookService;
    this.workDir = opts.workDir;
  }

  /**
   * 只读地生成一次完整历史压缩预览。
   *
   * 此方法只读取 Session 标识以归属 provider 调用；不会写入 Session、归档证据、
   * 修改传入 history、派发压缩 hook，或更新迭代摘要状态。RuntimeEvent checkpoint
   * 可消费返回的摘要和切点，自行持久化对应事件。
   *
   * @param previousSummary 上一轮压缩的摘要正文。提供时启用滚动摘要(增量更新):
   *   summarizer 基于旧摘要 + 新增事件生成更新版,而非重算全部历史。undefined 或空串
   *   则走全量摘要(首次压缩或旧摘要不可用时)。
   */
  async preview(
    session: Session,
    history: readonly Message[],
    request: FullCompactionRequest,
    signal?: AbortSignal,
    previousSummary?: string,
  ): Promise<FullCompactionPreview | undefined> {
    signal?.throwIfAborted();
    const plan = this.createPreviewPlan(history, request, previousSummary);
    if (!plan) return undefined;
    return await this.generatePreview(session, request, plan, signal, previousSummary);
  }

  /**
   * 在安全工具协议边界上用 provider 把 history 前缀浓缩成摘要。
   * @param session 要压缩的会话
   * @param request token 目标与触发来源
   * @param signal 本轮运行的中止信号
   * @returns 压缩成功返回 true,失败返回 false(调用方降级到硬重置)
   */
  async compactInMemorySession(
    session: Session,
    request: FullCompactionRequest,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const history = session.getHistory();
    const previousSummary = detectExistingCompactionSummary(history);
    const plan = this.createPreviewPlan(history, request, previousSummary);
    if (!plan) return false;
    const hookSource = request.trigger === "manual" ? "manual" : "auto";

    await this.hookService?.dispatch(
      "PreCompact",
      { source: hookSource, messageCount: history.length },
      { signal },
    );

    const preview = await this.generatePreview(session, request, plan, signal, previousSummary);
    if (!preview) return false;

    await session.applyInMemoryCompaction(preview.wrappedSummary, preview.compactedCount);
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
    previousSummary?: string,
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

    // 滚动摘要:有 previousSummary 时,prefix 跳过已有的 summary 消息只取增量。
    // read-model 投影会把上一个 checkpoint 覆盖的前缀替换成一条 summary 消息,
    // 这条消息是压缩产物而非原始对话,不应再次喂给 summarizer 重新总结。
    const fullPrefix = sanitizeToolPairs(history.slice(0, cut.compactedCount));
    const prefix =
      previousSummary && previousSummary.trim().length > 0
        ? fullPrefix.filter((msg) => !msg.content.startsWith(FULL_COMPACTION_SUMMARY_MARKER))
        : fullPrefix;

    return {
      beforeTokens,
      targetRetainedTokens,
      compactedCount: cut.compactedCount,
      retainedCount: history.length - cut.compactedCount,
      retainedTokens: cut.retainedTokens,
      prefix,
    };
  }

  /** 调用摘要模型并返回可由 Session 或 checkpoint 消费的只读结果。 */
  private async generatePreview(
    session: Session,
    request: FullCompactionRequest,
    plan: FullCompactionPreviewPlan,
    signal?: AbortSignal,
    previousSummary?: string,
  ): Promise<FullCompactionPreview | undefined> {
    const instruction = this.renderInstruction(plan.prefix, previousSummary, session);
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

    // 代码层长度硬上限:模板要求"不超过 1000 字",但弱模型可能失控返回超长摘要。
    // 这里做兜底截断,防止摘要本身撑爆下一轮上下文。
    const truncatedSummary = enforceSummaryCharLimit(summary, MAX_SUMMARY_CHARS);

    return {
      summary: truncatedSummary,
      wrappedSummary: wrapFullCompactionSummary(truncatedSummary),
      compactedCount: plan.compactedCount,
      beforeTokens: plan.beforeTokens,
      targetRetainedTokens: plan.targetRetainedTokens,
      retainedCount: plan.retainedCount,
      retainedTokens: plan.retainedTokens,
    };
  }

  /**
   * 渲染摘要指令:6 段模板 + 当前历史前缀。
   * 存在 previousSummary 时改用增量模板(滚动摘要),让模型基于上一轮摘要更新而非重算。
   * 注入环境元信息(workDir/platform)让 summarizer 知道任务所在仓库。
   */
  private renderInstruction(
    prefix: Message[],
    previousSummary: string | undefined,
    session: Session,
  ): string {
    const serialized = serializeMessages(prefix);
    const envPrefix = buildEnvironmentContext(this.workDir, session);
    const fullPrefix = envPrefix ? `${envPrefix}\n\n${serialized}` : serialized;
    if (previousSummary && previousSummary.trim().length > 0) {
      return COMPACTION_INCREMENTAL_TEMPLATE.replace("{previousSummary}", previousSummary).replace(
        "{prefix}",
        fullPrefix,
      );
    }
    return COMPACTION_INSTRUCTION_TEMPLATE.replace("{prefix}", fullPrefix);
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
 * 检测 history 里是否已有上一轮压缩的 summary 消息(以 FULL_COMPACTION_SUMMARY_MARKER 开头)。
 * 用于内存路径 compactInMemorySession 自动启用滚动摘要:
 * 已有 summary 时不重新总结全部前缀,而是基于旧 summary 增量更新。
 *
 * @returns 上一轮摘要的正文(去掉 REFERENCE-ONLY 包装),或 undefined
 */
function detectExistingCompactionSummary(history: readonly Message[]): string | undefined {
  for (const msg of history) {
    if (msg.role === "assistant" && msg.content.startsWith(FULL_COMPACTION_SUMMARY_MARKER)) {
      // 用结构化标签精确定位正文边界,避免 \n\n 切分出错。
      const startIdx = msg.content.indexOf(COMPACTION_SUMMARY_OPEN_TAG);
      const endIdx = msg.content.indexOf(COMPACTION_SUMMARY_CLOSE_TAG);
      if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) return undefined;
      // openTag 之后、closeTag 之前的是正文。
      const bodyStart = startIdx + COMPACTION_SUMMARY_OPEN_TAG.length;
      return msg.content.slice(bodyStart, endIdx).trim();
    }
  }
  return undefined;
}

/**
 * 摘要字符数硬上限兜底。模板要求"不超过 1000 字",但弱模型可能失控。
 * 超限时按 section 优先级裁剪:优先保留任务目标/关键上下文/失败路径,裁掉进展/下一步。
 * 无标题的纯文本回退到 head 截断。
 */
export function enforceSummaryCharLimit(summary: string, maxChars: number): string {
  if (summary.length <= maxChars) return summary;
  const marker = `\n[摘要已截断：原始 ${summary.length} 字符，上限 ${maxChars} 字符]`;
  let budget = maxChars - marker.length;

  // 按 ## 标题切分成 sections。split 产出 ["前导文本", "## ", "标题\n正文", "## ", ...]
  const sections = summary.split(/^(## )/m);
  const pairs: { title: string; body: string }[] = [];
  for (let i = 1; i < sections.length; i += 2) {
    pairs.push({ title: sections[i] ?? "", body: sections[i + 1] ?? "" });
  }

  // 无标题时回退到 head 截断,避免整体丢失
  if (pairs.length === 0) {
    return `${summary.slice(0, Math.max(0, budget))}${marker}`;
  }

  // 优先级:任务目标 > 关键上下文 > 已尝试/失败路径 > 关键决策 > 进展 > 下一步
  const priority = ["任务目标", "关键上下文", "已尝试/失败路径", "关键决策", "进展", "下一步"];
  // 按优先级逐段加入,超预算的低优先段整体丢弃。
  // title 已含 "## " 前缀(split 产出),不能再前置。
  const kept: string[] = [];
  for (const pname of priority) {
    const match = pairs.find((s) => s.body.startsWith(pname));
    if (!match) continue;
    const sectionText = `${match.title}${match.body}`;
    if (sectionText.length > budget) {
      kept.push(`${sectionText.slice(0, budget)}...`);
      budget = 0;
      break;
    }
    kept.push(sectionText);
    budget -= sectionText.length;
  }
  if (kept.length === 0) {
    return `${summary.slice(0, Math.max(0, budget))}${marker}`;
  }
  return `${kept.join("\n\n")}${marker}`;
}

/**
 * 构造环境元信息前缀,注入摘要指令让 summarizer 知道任务所在仓库和运行环境。
 */
function buildEnvironmentContext(
  workDir: string | undefined,
  session: Session,
): string | undefined {
  const lines: string[] = [];
  if (workDir) lines.push(`- 工作目录: ${workDir}`);
  lines.push(`- 平台: ${process.platform}`);
  lines.push(`- 会话 ID: ${session.id}`);
  if (lines.length === 0) return undefined;
  return `[会话环境]\n${lines.join("\n")}`;
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
