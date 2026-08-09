// 记忆触发器工具：对话模型通过调这两个工具决定该不该记。
//
// memory_remember：前台同步——用户明确要求记时调用，工具 execute 里直接跑提取，
//   等结果完成后返回"具体记了什么"给模型，模型基于内容回复用户。
// memory_extract：后台异步——对话含值得保留的信息时调用，只置位标记，
//   executor 在 turn 终结后入队提取（用户不等，不需要即时反馈）。

import type { BaseTool } from "../tools/registry.js";
import { NO_FILE_SIDE_EFFECTS } from "../tools/registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses, type ToolAccesses as ToolAccessSet } from "../tools/tool-access.js";
import type { MemoryProposalProcessResult, TerminalMemoryEvidenceRef } from "./proposal-contracts.js";

/**
 * 前台同步提取回调：接收当前 turn 的引用，直接跑提取引擎，等结果返回。
 * 由 runtime 层构造，注入 memoryRepository + model。
 */
export type MemoryRememberHandler = (ref: TerminalMemoryEvidenceRef) => Promise<MemoryProposalProcessResult>;

/**
 * 每轮记忆触发标记：memory_extract 置位，executor 在 turn 终结后检查。
 */
export interface MemoryTriggerSlot {
  trigger: "remember" | "extract" | undefined;
  /** Executor 在 user message commit 后设置，供 memory_remember 前台同步读取。 */
  ref?: TerminalMemoryEvidenceRef;
}

export interface MemoryTriggerContext {
  /** memory_remember 的前台同步提取处理器（undefined 时降级为后台入队）。 */
  readonly rememberHandler?: MemoryRememberHandler;
  /** memory_extract 的置位标记。 */
  readonly slot: MemoryTriggerSlot;
}

/**
 * 构造两个记忆触发器工具。
 */
export function buildMemoryTriggerTools(
  context: MemoryTriggerContext,
  resolveContext: () => TerminalMemoryEvidenceRef | undefined,
): readonly BaseTool[] {
  return [
    new MemoryRememberTool(context, resolveContext),
    new MemoryExtractTool(context.slot),
  ];
}

/** 用户明确要求记忆时调用（前台同步，返回具体记了什么）。 */
class MemoryRememberTool implements BaseTool {
  readonly readOnly = true;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;

  constructor(
    private readonly context: MemoryTriggerContext,
    private readonly resolveContext: () => TerminalMemoryEvidenceRef | undefined,
  ) {}

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
    const ref = this.resolveContext();
    if (!ref) return "记忆提取不可用：无法确定当前会话上下文。";
    const handler = this.context.rememberHandler;
    if (handler) {
      // 前台同步：直接跑提取，等结果，返回具体记了什么
      try {
        const result = await handler(ref);
        return formatRememberResult(result);
      } catch {
        return "记忆提取暂时不可用，请稍后重试。";
      }
    }
    // 降级：无前台处理器时走后台入队
    this.context.slot.trigger = "remember";
    return "已记录，将在本轮结束后提取并保存。";
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

/** 格式化提取结果为模型可读的确认消息。 */
function formatRememberResult(result: MemoryProposalProcessResult): string {
  if (result.status === "succeeded" || result.status === "already_succeeded") {
    const proposals = result.proposals;
    if (proposals.length === 0) {
      return "已检查，没有发现值得长期记住的内容。";
    }
    const lines = proposals.map((p) => {
      const title = p.title ?? "(无标题)";
      const content = p.content ?? "(无内容)";
      return `- [${p.kind}] ${title}: ${content}`;
    });
    return `已记住 ${proposals.length} 条信息：\n${lines.join("\n")}`;
  }
  if (result.status === "disabled") return "记忆功能已禁用。";
  if (result.status === "in_progress") return "记忆提取正在进行中，请稍候。";
  if (result.status === "attempts_exhausted") return "记忆提取多次失败，请稍后重试。";
  if (result.status === "retryable_failure") {
    return "记忆提取遇到临时问题，请稍后重试。";
  }
  return "记忆提取完成。";
}
