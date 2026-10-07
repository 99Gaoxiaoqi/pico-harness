import type { BaseTool, ToolExecutionContext } from "@pico/pico-host/tool-registry-contract";
import { NO_FILE_SIDE_EFFECTS } from "@pico/pico-host/tool-registry-contract";
import type { ToolDefinition } from "@pico/core";
import { ToolAccesses } from "@pico/runtime/tool-access";
import type { AtomicMemoryResult } from "@pico/core/atomic-memory-runtime-contracts";

export interface AtomicMemoryToolPort {
  remember(signal?: AbortSignal): Promise<AtomicMemoryResult>;
  requestExtract(): Promise<{ status: "accepted" | "unavailable"; reason?: string }>;
}

export function buildMemoryTriggerTools(port: AtomicMemoryToolPort): readonly BaseTool[] {
  return [
    new MemoryTriggerTool("memory_remember", port),
    new MemoryTriggerTool("memory_extract", port),
  ];
}

class MemoryTriggerTool implements BaseTool {
  readonly readOnly = true;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
  constructor(
    private readonly toolName: "memory_remember" | "memory_extract",
    private readonly port: AtomicMemoryToolPort,
  ) {}
  name(): string {
    return this.toolName;
  }
  definition(): ToolDefinition {
    return {
      name: this.toolName,
      description:
        this.toolName === "memory_remember"
          ? "Use only when the user explicitly asks you to remember long-term information or save the preceding assistant reply as a reference note. Call this tool alone in its own step. Confirm saving only when the result lists the actual saved requestedItems; a no-op means nothing was saved."
          : "Request extraction of durable long-term information after this turn. An accepted result means queued, not saved. Normal eligible completed turns are also scheduled by the host.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    };
  }
  accesses() {
    return ToolAccesses.none();
  }
  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const input: unknown = JSON.parse(args);
    if (!input || Array.isArray(input) || typeof input !== "object" || Object.keys(input).length)
      throw new Error("Memory triggers accept an empty object only");
    const result =
      this.toolName === "memory_remember"
        ? await this.port.remember(context?.signal)
        : await this.port.requestExtract();
    if (result.status === "unavailable") throw new Error(memoryFailureMessage(result.reason));
    if (result.status === "discarded")
      throw new Error(
        "记忆提取失败：校验重试后仍未通过，本次没有保存。请重新明确要保存的内容。（discarded）",
      );
    return JSON.stringify(result);
  }
}

function memoryFailureMessage(reason: string | undefined): string {
  const code = reason && /^[a-z_]{1,64}$/u.test(reason) ? reason : "unavailable";
  const explanation: Record<string, string> = {
    provider_unsupported: "当前模型接口暂不支持自动记忆提取",
    source_unavailable: "当前对话的原始内容不可用",
    cannot_resolve: "无法唯一确定要保存的回复，请明确指出要保存的内容",
    reference_ambiguous: "无法唯一确定要保存的回复，请明确指出要保存的内容",
    reference_unavailable: "没有可供保存的上一条完整回复",
    memory_disabled: "记忆功能已关闭",
    workspace_untrusted: "当前工作区尚未受信任",
    runtime_profile_disabled: "当前运行模式不允许写入记忆",
    memory_deleted: "相关记忆已被删除，旧请求不会恢复它",
    policy_changed: "保存期间设置或授权发生变化",
    session_unavailable: "当前会话已不可用",
    draining: "运行时正在退出",
    aborted: "保存请求已取消",
    retry_later: "本次提取未通过模型响应或证据校验，等待下一次提取重试",
    provider_review_failed: "辅助模型请求失败，等待下一次提取重试",
    evidence_rejected: "提取内容未通过原始用户证据校验，本次没有保存",
    invalid_memory_response: "辅助模型返回的记忆格式或内容不符合要求，本次没有保存",
    sensitive_information: "内容包含不适合保存的敏感信息",
    reference_note_too_large: "要保存的回复超过笔记容量，请缩小保存范围",
    reference_too_large: "要保存的回复超过笔记容量，请缩小保存范围",
    invalid_reference_content: "回复内容无法转换为有效笔记",
  };
  return `记忆未保存：${explanation[code] ?? "记忆处理暂时不可用"}。（${code}）`;
}
