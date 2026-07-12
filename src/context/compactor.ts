// 上下文压缩器:像操作系统的垃圾回收器一样,防止大模型 Context Window 发生 OOM。
//
// 解决第 11 讲遗留的致命漏洞:WorkingMemory 的条数截断防不住"单条消息暴击"。
// Agent 读一个 1MB 的日志文件,即使只保留最近 3 条消息,只要其中一条 ToolResult
// 含这 1MB 文本,大模型 API 瞬间 400 Bad Request: context length exceeded。
//
// 驾驭工程铁律:大模型是 CPU,Context Window 是昂贵且容量受限的 RAM。
// 物理防御(防 OOM)的优先级,永远高于业务逻辑(短期记忆完整性)。
//
// 双重降级策略(放弃昂贵的 LLM 摘要,采用轻量字符级截断):
// 1. System Prompt:永远保留,神圣不可侵犯
// 2. 远期历史(超出保护区):ToolCall 意图保留,ToolResult 先温和摘要(MicroCompaction),
//    strongerCompact 触发后再全量掩码
// 3. WorkingMemory(保护区):期望完整,但单条超长则掐头去尾(前 500 + 后 500)
//
// 关键:绝不触碰 msg.toolCalls —— 这是模型行动的证据,维系逻辑链的关键!
// 删掉 ToolResult 而保留 ToolCall,大模型会困惑"命令没发出去"而陷入死循环;
// 掩码替换(而非删除)既释放内存又保住意图连贯。

import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMProvider } from "../provider/interface.js";
import type { Message } from "../schema/message.js";
import { logger } from "../observability/logger.js";
import { countTokens } from "./token-counter.js";

/** 远期 ToolResult 触发全量掩码的字符阈值(短于阈值的小输出保留原样) */
const REMOTE_MASK_THRESHOLD = 200;
/** 保护区 ToolResult 触发掐头去尾的字符阈值 */
const PROTECT_TRUNCATE_THRESHOLD = 1000;
/** 掐头去尾保留的首尾字符数 */
const HEAD_TAIL_KEEP = 500;
/** 远期 Assistant 冗长 Thinking Trace 触发折叠的字符阈值 */
const REMOTE_THINKING_FOLD_THRESHOLD = 200;
/** 预算闭环压缩时替换 ToolResult 的短占位符 */
const BUDGET_TOOL_RESULT_PLACEHOLDER = "[工具输出已被预算压缩";
/** 预算闭环压缩时折叠助手正文,但保留 toolCalls */
const BUDGET_ASSISTANT_TOOL_CONTENT = "[助手正文已被预算压缩,toolCalls 已保留]";
/** 预算闭环压缩时折叠远期普通对话 */
const BUDGET_OLD_MESSAGE_CONTENT = "[早期消息已被预算压缩]";
/** 预算闭环压缩最后一条普通消息时使用的中间标记 */
const BUDGET_CONTENT_MARKER = "\n...[预算压缩]...\n";

/**
 * MicroCompaction 3.1 增强:按缓存年龄触发远期 ToolResult 清理。
 * ToolResult 缓存时间超过此阈值(默认 1 小时),且使用率达标,即替换为 cleared 标记。
 */
const MICRO_CACHE_AGE_MS = 60 * 60 * 1000;
/**
 * MicroCompaction 3.1:ToolResult 被读取次数达到此阈值,视为"被读过多次"(高使用率)。
 * 与年龄共同触发清理(简化:不维护调用总次数分母,直接用绝对 accessCount 阈值)。
 */
const MICRO_ACCESS_COUNT_THRESHOLD = 2;
/** MicroCompaction 3.1:远期 ToolResult 清理后的标记 */
const MICRO_CLEARED_MARKER = "[Old tool result cleared]";
/** MicroCompaction 3.1:保护区内最近消息条数(默认 20),其中的 ToolResult 不被清理 */
const MICRO_RETAIN_LAST_MSGS_DEFAULT = 20;

/** 掩码占位符 */
function maskRemoteToolResult(originalLen: number): string {
  return `...[为了节省内存,早期的工具输出已被系统清理。原始长度: ${originalLen} 字节]...`;
}

/** 掐头去尾占位符 */
function truncateProtectedContent(content: string): string {
  const head = content.slice(0, HEAD_TAIL_KEEP);
  const tail = content.slice(content.length - HEAD_TAIL_KEEP);
  const dropped = content.length - HEAD_TAIL_KEEP * 2;
  return `${head}\n\n...[内容过长,中间 ${dropped} 字节已被系统截断]...\n${tail}`;
}

function budgetToolResultPlaceholder(originalLen: number): string {
  return `${BUDGET_TOOL_RESULT_PLACEHOLDER}:${originalLen}]`;
}

/**
 * 把旧 ToolResult 内容浓缩成 1 行温和摘要(保留语义,释放空间)。
 * 对标 hermes tool output pruning + kimi-code MicroCompaction:
 * 不再粗暴全量掩码,而是提取工具名/退出码/规模,生成 1 行可读摘要。
 *
 * - 找得到对应 ToolCall: `[工具 {name} 输出已清理,exit {code},原始 {N} 字符,{M} 行]`
 *   (无退出码时省略 exit 段)
 * - 找不到 ToolCall(向前无匹配 assistant): `[早期工具输出已清理,原始 {N} 字符]`
 */
export function makeToolResultSummary(msg: Message, allMsgs: Message[], index: number): string {
  const content = msg.content;
  const lineCount = content.split("\n").length;
  // 向前找最近的 assistant toolCalls,匹配本条 toolCallId,提取工具名
  let toolName: string | undefined;
  for (let j = index - 1; j >= 0; j--) {
    const prev = allMsgs[j];
    if (prev?.role === "assistant" && prev.toolCalls) {
      const call = prev.toolCalls.find((tc) => tc.id === msg.toolCallId);
      if (call) {
        toolName = call.name;
        break;
      }
    }
  }
  // 从输出文本里提取退出码(bash 常见模式:exit 0 / exit code 1)
  const exitMatch = /exit (?:code )?(\d+)/i.exec(content);
  const exitPart = exitMatch ? `,exit ${exitMatch[1]}` : "";
  if (!toolName) {
    // 找不到工具名:退化为通用格式(仅保留规模信息)
    return `[早期工具输出已清理${exitPart},原始 ${content.length} 字符]`;
  }
  return `[工具 ${toolName} 输出已清理${exitPart},原始 ${content.length} 字符,${lineCount} 行]`;
}

function hasToolCalls(msg: Message): boolean {
  return msg.toolCalls !== undefined && msg.toolCalls.length > 0;
}

function isToolResult(msg: Message): boolean {
  return msg.role === "user" && msg.toolCallId !== undefined;
}

function isOrdinaryConversationMessage(msg: Message): boolean {
  return (
    (msg.role === "user" && msg.toolCallId === undefined) ||
    (msg.role === "assistant" && !hasToolCalls(msg))
  );
}

function findLastOrdinaryMessageIndex(msgs: Message[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (isOrdinaryConversationMessage(msgs[i]!)) {
      return i;
    }
  }
  return -1;
}

function trimContentToLength(content: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }
  if (content.length <= maxLength) {
    return content;
  }
  if (maxLength <= BUDGET_CONTENT_MARKER.length + 2) {
    return content.slice(0, maxLength);
  }
  const keep = maxLength - BUDGET_CONTENT_MARKER.length;
  const headLen = Math.ceil(keep / 2);
  const tailLen = Math.floor(keep / 2);
  return `${content.slice(0, headLen)}${BUDGET_CONTENT_MARKER}${content.slice(content.length - tailLen)}`;
}

export class ContextCompactionError extends Error {
  readonly beforeChars: number;
  readonly afterChars: number;
  readonly maxChars: number;

  constructor(beforeChars: number, afterChars: number, maxChars: number) {
    super(
      `Context compaction failed: ${beforeChars} chars -> ${afterChars} chars still exceeds budget ${maxChars}.`,
    );
    this.name = "ContextCompactionError";
    this.beforeChars = beforeChars;
    this.afterChars = afterChars;
    this.maxChars = maxChars;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface SummaryInput {
  newMessages: Message[];
  previousSummary?: string;
  focusTopic?: string;
}

/** 摘要器函数:把一批远期消息浓缩成一段"剧情提要"(第 12 讲前沿升级) */
export type Summarizer = (input: SummaryInput) => Promise<string>;

/**
 * 用辅助 provider 创建 Summarizer(供 Compactor.compactWithSummary 使用)。
 * 让压缩摘要走廉价模型而非主模型,降低成本。
 *
 * SummaryInput 没有 historyText 字段,这里把 newMessages 序列化成可读文本喂给小模型;
 * previousSummary / focusTopic 拼进 user prompt,便于做增量摘要与主题聚焦。
 */
export function createAuxSummarizer(provider: LLMProvider): Summarizer {
  return async (input: SummaryInput): Promise<string> => {
    const historyText = serializeForSummary(input.newMessages);
    const previousSummaryBlock = input.previousSummary
      ? `\n\n上一次的摘要(请基于它做增量更新,保留仍相关的旧信息):\n${input.previousSummary}`
      : "";
    const focusTopicBlock = input.focusTopic ? `\n\n请重点关注以下主题:\n${input.focusTopic}` : "";
    const messages: Message[] = [
      {
        role: "system",
        content: "你是上下文压缩器。把对话历史浓缩成简洁摘要,保留关键信息。",
      },
      {
        role: "user",
        content: `请压缩以下对话历史:\n\n${historyText}${previousSummaryBlock}${focusTopicBlock}`,
      },
    ];
    const result = await provider.generate(messages, []);
    return result.content;
  };
}

/**
 * 把远期消息序列化成可读文本,供辅助摘要器输入。
 * 复用 FullCompactor 的格式约定(role 标签 + 截断防单条暴击)。
 */
function serializeForSummary(msgs: Message[]): string {
  const lines: string[] = [];
  for (const msg of msgs) {
    if (msg.role === "user" && msg.toolCallId !== undefined) {
      lines.push(`[工具结果] ${msg.content}`);
      continue;
    }
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        lines.push(`[助手→工具: ${tc.name}] ${tc.arguments}`);
      }
      if (msg.content && msg.content.trim().length > 0) {
        lines.push(`[助手] ${msg.content}`);
      }
      continue;
    }
    const tag = msg.role === "user" ? "用户" : msg.role === "assistant" ? "助手" : "系统";
    lines.push(`[${tag}] ${msg.content}`);
  }
  return lines.join("\n");
}

/**
 * ToolResult 外挂元数据(按 toolCallId 索引),供 MicroCompaction 3.1 判断
 * 缓存年龄与使用率。由 Session.getToolResultMeta() 提供。
 */
export interface ToolResultMetaEntry {
  /** 首次缓存(append)的时间戳 */
  cachedAt: number;
  /** 被 getWorkingMemory 读出的次数 */
  accessCount: number;
}

export interface CompactorOptions {
  /** 触发压缩的最大字符数阈值(水位线,可参考模型的 token 窗口大小折算) */
  maxChars: number;
  /** WorkingMemory 保护区:最近的 N 条消息 */
  retainLastMsgs: number;
  /** WorkingMemory 保护区:最近约 N 个 token,优先级高于 retainLastMsgs */
  retainLastTokens?: number;
  /** 摘要时希望保留的主题 */
  focusTopic?: string;
  /**
   * 可选的 LLM 摘要器(第 12 讲前沿升级)。
   * 提供时,远期历史不再粗暴掩码,而是异步调小模型浓缩成"剧情提要"替换。
   * 未提供时退回字符级掩码(极简模式)。
   */
  summarizer?: Summarizer;
  /**
   * MicroCompaction 3.1:ToolResult 元数据提供者(按 toolCallId 索引)。
   * 提供 cachedAt(缓存时间)+ accessCount(被读次数),用于按年龄 + 使用率
   * 触发远期 ToolResult 清理。未提供时退回纯字符阈值触发(旧行为)。
   */
  toolResultMetaProvider?: () => ReadonlyMap<string, ToolResultMetaEntry>;
  /**
   * MicroCompaction 3.1:保护区内最近消息条数(默认 20),其中的 ToolResult 不被清理。
   * 与 retainLastMsgs 独立(micro 保护区 = max(retainLastMsgs, retainLastMsgsMicro))。
   * 不影响现有 retainLastMsgs 的生产配置(6 条)。
   */
  retainLastMsgsMicro?: number;
  /** 压缩成功后追加的恢复消息,用于重新注入计划/关键文件等轻量上下文。 */
  postCompactRestore?: () => Message[];
}

interface CompactorRuntimeState {
  ineffectiveCount: number;
  usedStrongerCompact: boolean;
  previousSummary: string | undefined;
  summarizedRemoteCount: number;
}

function createCompactorRuntimeState(): CompactorRuntimeState {
  return {
    ineffectiveCount: 0,
    usedStrongerCompact: false,
    previousSummary: undefined,
    summarizedRemoteCount: 0,
  };
}

/**
 * Compactor:监控和压缩上下文内存,防止大模型发生 OOM。
 *
 * Compact 只作用于"本轮发给大模型的临时 Context"。
 * 写入 Session 的永远是全量真实数据 —— 全量原始数据供人类翻阅,
 * 每次向 API 发请求时带上一副经过过滤的"有色眼镜"。
 */
export class Compactor {
  readonly maxChars: number;
  readonly retainLastMsgs: number;
  readonly retainLastTokens?: number;
  private readonly summarizer?: Summarizer;
  private readonly focusTopic?: string;
  /** MicroCompaction 3.1:ToolResult 元数据提供者 */
  private readonly toolResultMetaProvider?: () => ReadonlyMap<string, ToolResultMetaEntry>;
  /** MicroCompaction 3.1:保护区最近消息条数(默认 20) */
  private readonly retainLastMsgsMicro: number;
  private readonly postCompactRestore?: () => Message[];
  /** 主 Agent 与非隔离调用沿用原有的持久状态语义。 */
  private readonly defaultRuntimeState = createCompactorRuntimeState();
  /** 并行子代理共享配置与自定义行为，但不共享压缩进度。 */
  private readonly runtimeStateStorage = new AsyncLocalStorage<CompactorRuntimeState>();

  constructor(opts: CompactorOptions) {
    this.maxChars = opts.maxChars;
    this.retainLastMsgs = opts.retainLastMsgs;
    this.retainLastTokens = opts.retainLastTokens;
    this.summarizer = opts.summarizer;
    this.focusTopic = opts.focusTopic;
    this.toolResultMetaProvider = opts.toolResultMetaProvider;
    this.retainLastMsgsMicro = opts.retainLastMsgsMicro ?? MICRO_RETAIN_LAST_MSGS_DEFAULT;
    this.postCompactRestore = opts.postCompactRestore;
  }

  get ineffectiveCompressionCount(): number {
    return this.runtimeState.ineffectiveCount;
  }

  /**
   * 在独立的压缩状态域中执行一次完整调用链。
   *
   * 不复制 Compactor 实例：调用方注入的子类覆写、summarizer 和
   * metadata provider 仍按原样执行；只隔离 stronger compact、无效压缩
   * 计数与增量摘要游标。AsyncLocalStorage 保证并行/嵌套子代理互不污染。
   */
  runInIsolatedScope<T>(callback: () => T): T {
    return this.runtimeStateStorage.run(createCompactorRuntimeState(), callback);
  }

  /**
   * 压缩准备发送给大模型的消息数组。
   * 若总长度未超标,直接返回(深拷贝);否则施加双重降级。
   */
  compact(msgs: Message[]): Message[] {
    const currentLength = this.estimateLength(msgs);

    // 未超水位线:正常路径,直接返回深拷贝
    if (currentLength < this.maxChars) {
      return sanitizeToolPairs(msgs);
    }

    if (this.runtimeState.ineffectiveCount >= 2) {
      logger.warn("[Compactor] 连续压缩收益不足,本轮跳过压缩以避免反复抖动。");
      return sanitizeToolPairs(msgs);
    }

    logger.warn(
      `[Compactor] ⚠ 内存告警:当前上下文长度 (${currentLength} 字符) 超过阈值 (${this.maxChars}),触发压缩`,
    );

    const msgCount = msgs.length;
    // 受保护的 WorkingMemory 起始索引(基于 retainLastMsgs,控制摘要/掩码防线)
    const protectStartIndex = this.protectStartIndex(msgs);
    // MicroCompaction 3.1:独立的 micro 保护区起始索引 = max(retainLastMsgs, retainLastMsgsMicro)
    // 最后 microProtectStartIndex..末尾 的 ToolResult 不被 age+usage 清理
    const microProtectStartIndex = this.microProtectStartIndex(msgs);

    const compacted: Message[] = [];
    for (let i = 0; i < msgCount; i++) {
      const msg = msgs[i]!;
      // 拷贝一份新消息,不污染原引用(并发安全)
      const newMsg: Message = { ...msg };
      const isInWorkingMemory = i >= protectStartIndex;

      // 1. System Prompt 绝对不能动,直接保留
      if (msg.role === "system") {
        compacted.push(newMsg);
        continue;
      }

      // 【核心驾驭逻辑】:双重降级防线
      if (msg.role === "user" && msg.toolCallId) {
        // 工具返回结果 (Observation/ToolResult)
        if (!isInWorkingMemory) {
          // 【第一道防线:远期历史】
          // MicroCompaction 3.1 新增触发:缓存年龄 > 1h 且使用率高(被读过多次)
          //   且不在 micro 保护区(最后 retainLastMsgsMicro 条)内
          //   → 替换为 [Old tool result cleared] 标记(语义:旧且已消化,无保留价值)
          //   优先于字符阈值(更彻底的清理,语义上"已归档")
          if (i < microProtectStartIndex && this.shouldClearByAgeUsage(msg.toolCallId)) {
            newMsg.content = MICRO_CLEARED_MARKER;
          } else if (msg.content.length > REMOTE_MASK_THRESHOLD) {
            // 第一档(温和):浓缩成 1 行摘要,保留工具名/退出码/规模语义
            //   对标 hermes tool pruning + kimi-code MicroCompaction
            // 第二档(激进):strongerCompact 已触发过 → 全量掩码,释放更多空间
            newMsg.content = this.runtimeState.usedStrongerCompact
              ? maskRemoteToolResult(msg.content.length)
              : makeToolResultSummary(msg, msgs, i);
          }
        } else {
          // 【第二道防线:短期记忆】即使处于保护区,单条过大也掐头去尾
          if (msg.content.length > PROTECT_TRUNCATE_THRESHOLD) {
            newMsg.content = truncateProtectedContent(msg.content);
          }
        }
      } else if (msg.role === "assistant" && msg.content) {
        // 大模型的冗长推理废话 (Thinking Trace)
        if (!isInWorkingMemory && msg.content.length > REMOTE_THINKING_FOLD_THRESHOLD) {
          newMsg.content = "...[早期的推理思考过程已折叠]...";
        }
      }

      // 注意:绝不动 msg.toolCalls —— 维系逻辑链的关键!
      compacted.push(newMsg);
    }

    const sanitized = sanitizeToolPairs(compacted);
    const newLength = this.estimateLength(sanitized);
    this.recordCompressionEffect(currentLength, newLength);
    logger.warn(`[Compactor] ✅ 压缩完成。上下文长度从 ${currentLength} 降至 ${newLength} 字符。`);
    return sanitized;
  }

  /**
   * 闭环压缩:先保持 compact() 的旧行为,若仍超过预算再执行更强降级。
   * 如果 system/toolCalls 等不可压缩部分本身已超过预算,抛出明确错误。
   */
  compactToBudget(msgs: Message[], maxChars = this.maxChars): Message[] {
    const beforeChars = this.estimateLength(msgs);
    const compacted = this.compact(msgs);
    const compactedChars = this.estimateLength(compacted);
    if (compactedChars <= maxChars) {
      return compacted;
    }

    const strongerCompacted = this.strongerCompact(compacted, maxChars);
    const afterChars = this.estimateLength(strongerCompacted);
    if (afterChars <= maxChars) {
      this.recordCompressionEffect(beforeChars, afterChars);
      logger.warn(
        `[Compactor] ✅ 预算闭环压缩完成。上下文长度从 ${beforeChars} 降至 ${afterChars} 字符。`,
      );
      return strongerCompacted;
    }

    throw new ContextCompactionError(beforeChars, afterChars, maxChars);
  }

  /**
   * 带摘要的异步压缩(第 12 讲前沿升级)。
   *
   * 当总长度超标且提供了 summarizer 时,把远期历史(保护区之前的消息)
   * 异步调小模型浓缩成一段"剧情提要",替换掉粗暴的字符级掩码。
   * 保护区内的消息仍走 compact() 的掐头去尾逻辑。
   *
   * 未提供 summarizer 时,直接退化为同步 compact()。
   *
   * @returns 压缩后的消息数组
   */
  async compactWithSummary(msgs: Message[]): Promise<Message[]> {
    // 无 summarizer 或未超标:退化为同步 compact
    if (!this.summarizer) {
      return this.compact(msgs);
    }
    const currentLength = this.estimateLength(msgs);
    if (currentLength < this.maxChars) {
      return this.compact(msgs);
    }

    // 分割:远期历史 + 保护区
    const protectStartIndex = this.protectStartIndex(msgs);
    const remoteMsgs = msgs.slice(0, protectStartIndex);
    const protectedMsgs = msgs.slice(protectStartIndex);
    const runtimeState = this.runtimeState;
    const newMessages = remoteMsgs.slice(runtimeState.summarizedRemoteCount);

    // 远期历史调小模型摘要
    let summaryText: string;
    try {
      logger.info(
        { remoteCount: newMessages.length },
        `[Compactor] 调用 LLM 摘要 ${newMessages.length} 条远期历史...`,
      );
      summaryText = await this.summarizer({
        newMessages,
        ...(runtimeState.previousSummary ? { previousSummary: runtimeState.previousSummary } : {}),
        ...(this.focusTopic ? { focusTopic: this.focusTopic } : {}),
      });
    } catch (err) {
      logger.warn({ err }, `[Compactor] LLM 摘要失败,退回字符级掩码`);
      return this.appendPostCompactRestore(this.compactToBudget(msgs));
    }
    runtimeState.previousSummary = summaryText;
    runtimeState.summarizedRemoteCount = remoteMsgs.length;

    // 摘要消息替换远期历史,保护区走 compact 逻辑
    const summaryMsg: Message = {
      role: "system",
      content: `[历史摘要]: ${summaryText}`,
    };
    const protectedCompacted = this.compact([...protectedMsgs.filter((m) => m.role !== "system")]);

    const result = sanitizeToolPairs([summaryMsg, ...protectedCompacted]);
    const newLength = this.estimateLength(result);
    this.recordCompressionEffect(currentLength, newLength);
    logger.warn(
      `[Compactor] ✅ LLM 摘要压缩完成。${currentLength} → ${newLength} 字符(远期 ${remoteMsgs.length} 条 → 摘要)。`,
    );
    return this.appendPostCompactRestore(result);
  }

  /** 粗略计算当前上下文的总字符长度(用 char count 代替 token) */
  estimateLength(msgs: Message[]): number {
    let length = 0;
    for (const msg of msgs) {
      length += msg.content.length;
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          length += tc.name.length + tc.arguments.length;
        }
      }
    }
    return length;
  }

  private protectStartIndex(msgs: Message[]): number {
    if (this.retainLastTokens === undefined) {
      return Math.max(0, msgs.length - this.retainLastMsgs);
    }
    let tokens = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      tokens += estimateTokens(msgs[i]!);
      if (tokens > this.retainLastTokens) {
        return Math.min(msgs.length, i + 1);
      }
    }
    return 0;
  }

  /**
   * MicroCompaction 3.1:独立的 micro 保护区起始索引。
   * 取 max(retainLastMsgs, retainLastMsgsMicro):既不缩小现有保护区,
   * 又保证最近 retainLastMsgsMicro(默认 20)条不受 age+usage 清理。
   * (retainLastTokens 模式下退化为 retainLastMsgsMicro,与字符阈值防线解耦)
   */
  private microProtectStartIndex(msgs: Message[]): number {
    const protectCount = Math.max(this.retainLastMsgs, this.retainLastMsgsMicro);
    return Math.max(0, msgs.length - protectCount);
  }

  /**
   * MicroCompaction 3.1:判断远期 ToolResult 是否应按"缓存年龄 + 使用率"清理。
   * 触发条件(三选一中的新增项):age > 1 小时 且 accessCount >= 阈值(被读过多次)。
   * 无 toolResultMetaProvider 或无该 id 的 meta → 不触发(回退纯字符阈值)。
   */
  private shouldClearByAgeUsage(toolCallId: string): boolean {
    if (!this.toolResultMetaProvider) return false;
    let meta: Readonly<ToolResultMetaEntry> | undefined;
    try {
      meta = this.toolResultMetaProvider().get(toolCallId);
    } catch {
      return false;
    }
    if (!meta) return false;
    const age = Date.now() - meta.cachedAt;
    return age > MICRO_CACHE_AGE_MS && meta.accessCount >= MICRO_ACCESS_COUNT_THRESHOLD;
  }

  private recordCompressionEffect(before: number, after: number): void {
    const savingPct = before === 0 ? 100 : ((before - after) / before) * 100;
    const runtimeState = this.runtimeState;
    runtimeState.ineffectiveCount = savingPct < 10 ? runtimeState.ineffectiveCount + 1 : 0;
  }

  private get runtimeState(): CompactorRuntimeState {
    return this.runtimeStateStorage.getStore() ?? this.defaultRuntimeState;
  }

  private appendPostCompactRestore(msgs: Message[]): Message[] {
    if (!this.postCompactRestore) {
      return msgs;
    }
    let restored: Message[];
    try {
      restored = this.postCompactRestore();
    } catch (err) {
      logger.warn({ err }, `[Compactor] postCompactRestore 失败,跳过恢复消息`);
      return msgs;
    }
    if (restored.length === 0) {
      return msgs;
    }
    return sanitizeToolPairs([...msgs, ...restored]);
  }

  private strongerCompact(msgs: Message[], maxChars: number): Message[] {
    // 温和摘要已被证明不足以压进预算,后续 compact 直接采用全量掩码
    this.runtimeState.usedStrongerCompact = true;
    const lastOrdinaryIndex = findLastOrdinaryMessageIndex(msgs);
    const compacted = msgs.map((msg, index): Message => {
      const newMsg: Message = { ...msg };
      if (msg.role === "system") {
        return newMsg;
      }
      if (isToolResult(msg)) {
        newMsg.content = budgetToolResultPlaceholder(msg.content.length);
        return newMsg;
      }
      if (msg.role === "assistant" && hasToolCalls(msg)) {
        newMsg.content = msg.content.length > 0 ? BUDGET_ASSISTANT_TOOL_CONTENT : "";
        return newMsg;
      }
      if (
        isOrdinaryConversationMessage(msg) &&
        index !== lastOrdinaryIndex &&
        msg.content.length > 0
      ) {
        newMsg.content = BUDGET_OLD_MESSAGE_CONTENT;
      }
      return newMsg;
    });

    const sanitized = sanitizeToolPairs(compacted);
    return this.trimLastOrdinaryToFitBudget(sanitized, maxChars);
  }

  private trimLastOrdinaryToFitBudget(msgs: Message[], maxChars: number): Message[] {
    const currentLength = this.estimateLength(msgs);
    if (currentLength <= maxChars) {
      return msgs;
    }

    const targetIndex = findLastOrdinaryMessageIndex(msgs);
    if (targetIndex < 0) {
      return msgs;
    }

    const target = msgs[targetIndex]!;
    const fixedLength = currentLength - target.content.length;
    const availableForContent = maxChars - fixedLength;
    if (target.content.length <= availableForContent) {
      return msgs;
    }

    return msgs.map((msg, index) => {
      if (index !== targetIndex) {
        return { ...msg };
      }
      return {
        ...msg,
        content: trimContentToLength(msg.content, availableForContent),
      };
    });
  }
}

export function sanitizeToolPairs(msgs: Message[]): Message[] {
  const callIds = new Set<string>();
  for (const msg of msgs) {
    for (const toolCall of msg.toolCalls ?? []) {
      callIds.add(toolCall.id);
    }
  }

  const resultIds = new Set<string>();
  const withoutOrphanResults: Message[] = [];
  for (const msg of msgs) {
    if (msg.role === "user" && msg.toolCallId) {
      if (!callIds.has(msg.toolCallId)) {
        continue;
      }
      resultIds.add(msg.toolCallId);
    }
    withoutOrphanResults.push({ ...msg });
  }

  const out: Message[] = [];
  for (let i = 0; i < withoutOrphanResults.length; i++) {
    const msg = withoutOrphanResults[i]!;
    out.push(msg);
    if (msg.role !== "assistant" || !msg.toolCalls || msg.toolCalls.length === 0) {
      continue;
    }
    const ids = new Set(msg.toolCalls.map((toolCall) => toolCall.id));
    while (i + 1 < withoutOrphanResults.length) {
      const nextMsg = withoutOrphanResults[i + 1]!;
      if (nextMsg.role !== "user" || !nextMsg.toolCallId || !ids.has(nextMsg.toolCallId)) {
        break;
      }
      i++;
      out.push(withoutOrphanResults[i]!);
    }
    for (const toolCall of msg.toolCalls) {
      if (!resultIds.has(toolCall.id)) {
        out.push({
          role: "user",
          toolCallId: toolCall.id,
          content: `[早期工具结果已归档] 工具 ${toolCall.name} 的结果已被上下文压缩器替换为占位符。`,
        });
      }
    }
  }
  return out;
}

function estimateTokens(msg: Message): number {
  let text = msg.content;
  for (const toolCall of msg.toolCalls ?? []) {
    text += toolCall.name + toolCall.arguments;
  }
  return Math.max(1, countTokens(text));
}
