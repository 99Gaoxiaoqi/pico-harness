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
// 2. 远期历史(超出保护区):ToolCall 意图保留,ToolResult 全量掩码
// 3. WorkingMemory(保护区):期望完整,但单条超长则掐头去尾(前 500 + 后 500)
//
// 关键:绝不触碰 msg.toolCalls —— 这是模型行动的证据,维系逻辑链的关键!
// 删掉 ToolResult 而保留 ToolCall,大模型会困惑"命令没发出去"而陷入死循环;
// 掩码替换(而非删除)既释放内存又保住意图连贯。

import type { Message } from "../schema/message.js";

/** 远期 ToolResult 触发全量掩码的字符阈值(短于阈值的小输出保留原样) */
const REMOTE_MASK_THRESHOLD = 200;
/** 保护区 ToolResult 触发掐头去尾的字符阈值 */
const PROTECT_TRUNCATE_THRESHOLD = 1000;
/** 掐头去尾保留的首尾字符数 */
const HEAD_TAIL_KEEP = 500;
/** 远期 Assistant 冗长 Thinking Trace 触发折叠的字符阈值 */
const REMOTE_THINKING_FOLD_THRESHOLD = 200;

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

export interface CompactorOptions {
  /** 触发压缩的最大字符数阈值(水位线,可参考模型的 token 窗口大小折算) */
  maxChars: number;
  /** WorkingMemory 保护区:最近的 N 条消息 */
  retainLastMsgs: number;
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

  constructor(opts: CompactorOptions) {
    this.maxChars = opts.maxChars;
    this.retainLastMsgs = opts.retainLastMsgs;
  }

  /**
   * 压缩准备发送给大模型的消息数组。
   * 若总长度未超标,直接返回(深拷贝);否则施加双重降级。
   */
  compact(msgs: Message[]): Message[] {
    const currentLength = this.estimateLength(msgs);

    // 未超水位线:正常路径,直接返回深拷贝
    if (currentLength < this.maxChars) {
      return msgs.map((m) => ({ ...m }));
    }

    console.warn(
      `[Compactor] ⚠ 内存告警:当前上下文长度 (${currentLength} 字符) 超过阈值 (${this.maxChars}),触发压缩`,
    );

    const msgCount = msgs.length;
    // 受保护的 WorkingMemory 起始索引
    const protectStartIndex = Math.max(0, msgCount - this.retainLastMsgs);

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
          // 【第一道防线:远期历史】全量掩码 (Full Masking)
          if (msg.content.length > REMOTE_MASK_THRESHOLD) {
            newMsg.content = maskRemoteToolResult(msg.content.length);
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

    const newLength = this.estimateLength(compacted);
    console.warn(`[Compactor] ✅ 压缩完成。上下文长度从 ${currentLength} 降至 ${newLength} 字符。`);
    return compacted;
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
}
