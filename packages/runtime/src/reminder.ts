import { createHash } from "node:crypto";
import type { Message, ToolCall, ToolResult } from "@pico/core";

const DOOM_LOOP_THRESHOLD = 3;

/** Optional host diagnostics; Runtime retains no dependency on a logger implementation. */
export interface RuntimeReminderLogger {
  warn(message: string): void;
}

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

/** Detects repeated failed calls and inserts a model-visible correction reminder. */
export class ReminderInjector {
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(private readonly logger?: RuntimeReminderLogger) {}

  static fingerprint(toolName: string, args: string): string {
    return createHash("md5").update(toolName).update(args).digest("hex");
  }

  checkAndInject(lastToolCall: ToolCall, lastResult: ToolResult): Message | null {
    const fingerprint = ReminderInjector.fingerprint(lastToolCall.name, lastToolCall.arguments);
    if (!lastResult.isError) {
      if (this.consecutiveFailures.size > 0) this.consecutiveFailures.clear();
      return null;
    }

    const failCount = (this.consecutiveFailures.get(fingerprint) ?? 0) + 1;
    this.consecutiveFailures.set(fingerprint, failCount);
    this.logger?.warn(
      `[Reminder] 监控到工具 ${lastToolCall.name} 执行失败,该参数特征连续失败次数: ${failCount}`,
    );
    if (failCount < DOOM_LOOP_THRESHOLD) return null;
    this.logger?.warn("[Reminder] ⚠ 触发死循环干预!注入强力修正指令。");
    return {
      role: "user",
      content: `[SYSTEM REMINDER 警告]
你似乎陷入了死循环。你刚刚连续 ${failCount} 次使用相同的参数调用了 '${lastToolCall.name}' 工具,并且都失败了。
请立即停止这种无效的重试!你的注意力被当前的报错过度吸引了。
你需要:
1. 停止猜测参数。跳出当前的局部思维。
2. 彻底改变你的策略。
3. 如果你确实无法通过系统工具解决当前问题,请直接结束任务并向用户说明你需要什么人工帮助,而不是继续盲目重试。`,
      providerData: { picoKind: "system_reminder", picoHiddenFromTranscript: true },
    };
  }

  reset(): void {
    this.consecutiveFailures.clear();
  }
}

/** Blocks repeated failed actions before they consume another tool invocation. */
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

  constructor(options: GuardrailOptions = {}) {
    this.exactFailureWarnAt = options.exactFailureWarnAt ?? 3;
    this.exactFailureBlockAt = options.exactFailureBlockAt ?? 5;
    this.sameToolFailureWarnAt = options.sameToolFailureWarnAt ?? 3;
    this.sameToolFailureBlockAt = options.sameToolFailureBlockAt ?? 8;
    this.noProgressWarnAt = options.noProgressWarnAt ?? 2;
    this.noProgressBlockAt = options.noProgressBlockAt ?? 5;
  }

  beforeCall(toolCall: ToolCall): GuardrailDecision {
    const exactReason = this.blockedReasons.get(this.exactKey(toolCall));
    if (exactReason) return { allowed: false, reason: exactReason };
    const toolReason = this.blockedReasons.get(this.toolKey(toolCall.name));
    return toolReason ? { allowed: false, reason: toolReason } : { allowed: true };
  }

  afterCall(
    toolCall: ToolCall,
    result: ToolResult,
    options: AfterCallOptions = {},
  ): Message | null {
    if (result.isError) return this.recordFailure(toolCall);
    const exactKey = this.exactKey(toolCall);
    const toolKey = this.toolKey(toolCall.name);
    this.exactFailures.delete(exactKey);
    this.sameToolFailures.delete(toolKey);
    this.blockedReasons.delete(exactKey);
    this.blockedReasons.delete(toolKey);
    return options.readOnly ? this.recordNoProgress(toolCall, result) : null;
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
    return count >= this.noProgressWarnAt
      ? makeReminder(
          `无进展警告: 只读工具 '${toolCall.name}' 连续 ${count} 次返回相同结果。请不要继续重复读取同一信息,改为总结已有证据或换一个搜索角度。`,
        )
      : null;
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
    providerData: { picoKind: "system_reminder", picoHiddenFromTranscript: true },
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
