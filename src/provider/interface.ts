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
  generate(
    messages: Message[],
    availableTools: ToolDefinition[],
  ): Promise<Message>;
}
