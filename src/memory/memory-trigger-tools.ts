// 记忆触发器工具：对话模型通过调这两个工具决定该不该记。
//
// memory_remember：用户明确要求记时调用，置位 remember 标记；executor 在已完成
//   terminal 落盘后入队，避免用尚不存在的终态事实做同步提取。
// memory_extract：后台异步——对话含值得保留的信息时调用，只置位标记，
//   executor 在 turn 终结后入队提取（用户不等，不需要即时反馈）。

import type { BaseTool } from "../tools/registry.js";
import { NO_FILE_SIDE_EFFECTS } from "../tools/registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses, type ToolAccesses as ToolAccessSet } from "../tools/tool-access.js";
/**
 * 每轮记忆触发标记：memory_extract 置位，executor 在 turn 终结后检查。
 */
export interface MemoryTriggerSlot {
  trigger: "remember" | "extract" | undefined;
}

/**
 * 构造两个记忆触发器工具。
 */
export function buildMemoryTriggerTools(slot: MemoryTriggerSlot): readonly BaseTool[] {
  return [new MemoryRememberTool(slot), new MemoryExtractTool(slot)];
}

/** 用户明确要求记忆时调用；remember 优先级不会被后续 extract 覆盖。 */
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
        "It stores the requested memory and returns exactly what was saved.",
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
    return "已记录，将在本轮结束后提取并进入记忆流程。";
  }
}

/** 对话含值得保留的信息时调用（后台异步）。 */
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
    if (this.slot.trigger !== "remember") {
      this.slot.trigger = "extract";
    }
    return "已安排提取，将在本轮结束后在后台处理。";
  }
}
