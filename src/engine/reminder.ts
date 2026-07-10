// 死循环斩断:基于工具调用哈希指纹的 SystemReminders 防死循环机制。
//
// 解决 Doom Loop(死循环)/ Exploration Spiral(探索螺旋):大模型遇到超出
// 认知的错误时,会在同一节点不断重试直到 API Token 耗尽。
//
// 为什么 System Prompt 拦不住?两大行为陷阱:
// 1. 上下文内容分布偏移:连续同质错误信息占据主导,牵引下一步生成
// 2. 近因偏差 (Recency Bias) / Lost in the Middle:模型对末尾信息响应权重
//    显著高于头部,无视前部"连续失败请停止"的宏观警告
//
// 破局之道:在大模型做决定的前一刻(Point of decision),将高优先级引导指令
// 伪装成最新一条 User Message,直接怼到它脸上。凭最高近因效应击碎局部执念。
//
// 实现:ReminderInjector 在每个 Turn 尾部扫描工具调用特征。用 MD5 指纹
// (toolName + args) 监控连续失败次数。阈值 3 次同参数失败 → 注入
// [SYSTEM REMINDER 警告] 强力指令,强行打断局部执念。
// 工具成功则清零计数器(说明这条路走通了)。

import { createHash } from "node:crypto";
import type { Message, ToolCall, ToolResult } from "../schema/message.js";
import { logger } from "../observability/logger.js";

/** 连续同参数失败多少次触发死循环干预 */
const DOOM_LOOP_THRESHOLD = 3;

export interface GuardrailOptions {
  exactFailureWarnAt?: number;
  exactFailureBlockAt?: number;
  sameToolFailureWarnAt?: number;
  sameToolFailureBlockAt?: number;
  noProgressWarnAt?: number;
  noProgressBlockAt?: number;
}

export interface GuardrailDecision {
  allowed: boolean;
  reason?: string;
}

interface AfterCallOptions {
  readOnly?: boolean;
}

/**
 * ReminderInjector:运行时死循环探测器。
 *
 * 在每个 Turn 尾部,分析本轮工具执行结果,若检测到大模型连续多次用相同
 * 参数调用同一工具且都失败,则注入一条 [SYSTEM REMINDER 警告] 的 User 消息,
 * 作为 Session 最末尾内容,大模型下一轮第一眼就会看到,打破局部执念。
 */
export class ReminderInjector {
  /** 指纹 → 连续失败次数 (成功即清零) */
  private readonly consecutiveFailures = new Map<string, number>();

  /**
   * 生成工具调用的唯一指纹,用于判断大模型是否在重复相同的动作。
   * MD5(toolName + args) —— 只有完全相同的参数才算"重复"。
   */
  static fingerprint(toolName: string, args: string): string {
    return createHash("md5").update(toolName).update(args).digest("hex");
  }

  /**
   * 分析本轮执行结果,决定是否在 Context 尾部追加 Reminder。
   * @returns 若触发干预,返回一条 RoleUser 消息(享受最高近因效应);否则 null
   */
  checkAndInject(lastToolCall: ToolCall, lastResult: ToolResult): Message | null {
    const fp = ReminderInjector.fingerprint(lastToolCall.name, lastToolCall.arguments);

    // 工具执行成功 → Agent 在这条路径上走通了,清空所有失败计数器
    if (!lastResult.isError) {
      if (this.consecutiveFailures.size > 0) {
        this.consecutiveFailures.clear();
      }
      return null;
    }

    // 失败 → 累加该特征的失败次数
    const failCount = (this.consecutiveFailures.get(fp) ?? 0) + 1;
    this.consecutiveFailures.set(fp, failCount);
    logger.warn(
      `[Reminder] 监控到工具 ${lastToolCall.name} 执行失败,该参数特征连续失败次数: ${failCount}`,
    );

    // 【驾驭底线】触发死循环打断!连续 3 次同参数失败,强行打断局部执念
    if (failCount >= DOOM_LOOP_THRESHOLD) {
      logger.warn("[Reminder] ⚠ 触发死循环干预!注入强力修正指令。");
      const nudgeMsg = `[SYSTEM REMINDER 警告]
你似乎陷入了死循环。你刚刚连续 ${failCount} 次使用相同的参数调用了 '${lastToolCall.name}' 工具,并且都失败了。
请立即停止这种无效的重试!你的注意力被当前的报错过度吸引了。
你需要:
1. 停止猜测参数。跳出当前的局部思维。
2. 彻底改变你的策略。
3. 如果你确实无法通过系统工具解决当前问题,请直接结束任务并向用户说明你需要什么人工帮助,而不是继续盲目重试。`;
      // 【核心】必须是 RoleUser,以保证在下一次 API 请求时位于上下文最末尾,
      // 享受最高近因效应 (Recency Bias),彻底击碎局部执念。
      return { role: "user", content: nudgeMsg };
    }

    return null;
  }

  /** 重置所有失败计数(主要用于测试) */
  reset(): void {
    this.consecutiveFailures.clear();
  }
}

export class ToolGuardrailController {
  private readonly exactFailureWarnAt: number;
  private readonly exactFailureBlockAt: number;
  private readonly sameToolFailureWarnAt: number;
  private readonly sameToolFailureBlockAt: number;
  private readonly noProgressWarnAt: number;
  private readonly noProgressBlockAt: number;
  private readonly exactFailures = new Map<string, number>();
  private readonly sameToolFailures = new Map<string, number>();
  private readonly noProgress = new Map<string, { outputHash: string; count: number }>();
  private readonly blockedReasons = new Map<string, string>();

  constructor(opts: GuardrailOptions = {}) {
    this.exactFailureWarnAt = opts.exactFailureWarnAt ?? 3;
    this.exactFailureBlockAt = opts.exactFailureBlockAt ?? 5;
    this.sameToolFailureWarnAt = opts.sameToolFailureWarnAt ?? 3;
    this.sameToolFailureBlockAt = opts.sameToolFailureBlockAt ?? 8;
    this.noProgressWarnAt = opts.noProgressWarnAt ?? 2;
    this.noProgressBlockAt = opts.noProgressBlockAt ?? 5;
  }

  beforeCall(toolCall: ToolCall): GuardrailDecision {
    const exactKey = this.exactKey(toolCall);
    const toolKey = this.toolKey(toolCall.name);
    const exactReason = this.blockedReasons.get(exactKey);
    if (exactReason) {
      return { allowed: false, reason: exactReason };
    }
    const toolReason = this.blockedReasons.get(toolKey);
    if (toolReason) {
      return { allowed: false, reason: toolReason };
    }
    return { allowed: true };
  }

  afterCall(toolCall: ToolCall, result: ToolResult, opts: AfterCallOptions = {}): Message | null {
    if (result.isError) {
      return this.recordFailure(toolCall);
    }
    this.exactFailures.delete(this.exactKey(toolCall));
    return opts.readOnly ? this.recordNoProgress(toolCall, result) : null;
  }

  reset(): void {
    this.exactFailures.clear();
    this.sameToolFailures.clear();
    this.noProgress.clear();
    this.blockedReasons.clear();
  }

  private recordFailure(toolCall: ToolCall): Message | null {
    const exactKey = this.exactKey(toolCall);
    const exactCount = (this.exactFailures.get(exactKey) ?? 0) + 1;
    this.exactFailures.set(exactKey, exactCount);
    if (exactCount >= this.exactFailureBlockAt) {
      this.blockedReasons.set(
        exactKey,
        `重复失败: ${toolCall.name} 使用相同参数连续失败 ${exactCount} 次`,
      );
    }
    if (exactCount >= this.exactFailureWarnAt) {
      return makeReminder(
        `你似乎陷入了重复失败。'${toolCall.name}' 使用相同参数连续失败 ${exactCount} 次。请停止重复尝试,先改变策略。`,
      );
    }

    const toolKey = this.toolKey(toolCall.name);
    const toolCount = (this.sameToolFailures.get(toolKey) ?? 0) + 1;
    this.sameToolFailures.set(toolKey, toolCount);
    if (toolCount >= this.sameToolFailureBlockAt) {
      this.blockedReasons.set(
        toolKey,
        `同一工具重复失败: ${toolCall.name} 连续失败 ${toolCount} 次`,
      );
    }
    if (toolCount >= this.sameToolFailureWarnAt) {
      return makeReminder(
        `同一工具 '${toolCall.name}' 已连续失败 ${toolCount} 次,即使参数不同也说明方向可能错了。请换用观察/读取/定位策略。`,
      );
    }
    return null;
  }

  private recordNoProgress(toolCall: ToolCall, result: ToolResult): Message | null {
    const key = this.exactKey(toolCall);
    const outputHash = hashText(result.output);
    const previous = this.noProgress.get(key);
    const count = previous && previous.outputHash === outputHash ? previous.count + 1 : 1;
    this.noProgress.set(key, { outputHash, count });
    if (count >= this.noProgressBlockAt) {
      this.blockedReasons.set(key, `无进展: ${toolCall.name} 连续 ${count} 次返回相同结果`);
    }
    if (count >= this.noProgressWarnAt) {
      return makeReminder(
        `无进展警告: 只读工具 '${toolCall.name}' 连续 ${count} 次返回相同结果。请不要继续重复读取同一信息,改为总结已有证据或换一个搜索角度。`,
      );
    }
    return null;
  }

  private exactKey(toolCall: ToolCall): string {
    return `exact:${ReminderInjector.fingerprint(toolCall.name, toolCall.arguments)}`;
  }

  private toolKey(toolName: string): string {
    return `tool:${toolName}`;
  }
}

function makeReminder(content: string): Message {
  return {
    role: "user",
    content: `[SYSTEM REMINDER 警告]\n${content}`,
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
