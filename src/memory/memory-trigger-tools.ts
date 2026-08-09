// 记忆触发器工具：对话模型通过调这两个无参工具"举手"决定该不该记。
// 对标 maka-agent 的 memory_remember / memory_extract。
//
// 两个工具都不接收候选内容（无参数），只负责标记"本轮需要记忆提取"。
// 实际入队在 turn 终结后由 executor 用完整的 terminalEventId 触发。
// 这替代了原来纯正则的 detectStableMemorySignal 门控——
// 把"该不该记"从正则判断改为对话模型自主判断。

import type { BaseTool } from "../tools/registry.js";
import { NO_FILE_SIDE_EFFECTS } from "../tools/registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses, type ToolAccesses as ToolAccessSet } from "../tools/tool-access.js";

/**
 * 每轮记忆触发标记：工具 execute 时置位，executor 在 turn 终结后检查。
 * 对标 maka 的 scope.memoryExtractRequested 布尔 flag。
 */
export interface MemoryTriggerSlot {
  /** 'remember' = 用户明确要求记；'extract' = 系统发现值得记；undefined = 未触发 */
  trigger: "remember" | "extract" | undefined;
}

/**
 * 构造两个记忆触发器工具（memory_remember / memory_extract）。
 *
 * @param slot 每轮共享的触发标记（executor 在 turn 终结后检查）
 */
export function buildMemoryTriggerTools(slot: MemoryTriggerSlot): readonly BaseTool[] {
  return [new MemoryRememberTool(slot), new MemoryExtractTool(slot)];
}

/** 用户明确要求记忆时调用。 */
class MemoryRememberTool implements BaseTool {
  readonly readOnly = true;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;

  constructor(private readonly slot: MemoryTriggerSlot) {}

  name(): string {
    return "memory_remember";
  }

  definition(): ToolDefinition {
    return {
      name: "memory_remember",
      description:
        "Use only when the user explicitly asks you to remember long-term information. " +
        "It stores the requested memory and returns what was saved.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    };
  }

  accesses(): ToolAccessSet {
    return ToolAccesses.none();
  }

  async execute(): Promise<string> {
    this.slot.trigger = "remember";
    return "已记录，将在本轮结束后提取并保存。";
  }
}

/** 对话含值得保留的持久信息但用户未明确要求记忆时调用。 */
class MemoryExtractTool implements BaseTool {
  readonly readOnly = true;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;

  constructor(private readonly slot: MemoryTriggerSlot) {}

  name(): string {
    return "memory_extract";
  }

  definition(): ToolDefinition {
    return {
      name: "memory_extract",
      description:
        "Use when the conversation contains durable long-term information worth preserving " +
        "and the user did not explicitly ask to remember it. The extraction runs after this turn.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    };
  }

  accesses(): ToolAccessSet {
    return ToolAccesses.none();
  }

  async execute(): Promise<string> {
    // 'remember' 优先级更高：如果用户已经明确要求记，不覆盖
    if (this.slot.trigger !== "remember") {
      this.slot.trigger = "extract";
    }
    return "已安排提取，将在本轮结束后在后台处理。";
  }
}
