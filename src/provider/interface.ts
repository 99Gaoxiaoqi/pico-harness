// 大模型通信的统一契约 (Provider 接口)。
// 对应课程第 02 讲 internal/provider/interface.go。
// 第 04 讲会提供 Claude 与 OpenAI 兼容的两套实现;第 02 讲先用 Mock 验证 Loop。

import type { Message, ToolDefinition } from "../schema/message.js";

/** 与大模型通信的统一契约 */
export interface LLMProvider {
  /**
   * 接收当前上下文历史与可用工具列表,发起一次大模型推理。
   * @returns 模型的响应消息 (可能含 toolCalls,也可能只有纯文本最终答案)
   */
  generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message>;
  /** 可选:provider 自治判定哪些错误可重试。未实现则由 retry 层用默认兜底判定。 */
  isRetryableError?(error: unknown): boolean;
  /** 可选:模型名,供重试 / 计费日志打点。 */
  readonly modelName?: string;
  /**
   * 可选:流式生成。与非流式 generate 行为一致,但每收到一段文本就调 onDelta 回调。
   * 如果 Provider 未实现此方法,loop.ts 自动降级到非流式 generate。
   * @returns 最终的完整 Message(和 generate 一样,含 toolCalls + usage)
   */
  generateStream?(
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: (delta: string) => void,
  ): Promise<Message>;
}
