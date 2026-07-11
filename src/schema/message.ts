// 统一的数据结构 (Schema):整个微型 OS 各组件之间传递的"血液"。
// 对应课程第 02 讲 internal/schema/message.go。
// 由于不同大模型 (Claude / OpenAI) 的 API 格式千差万别,
// 我们定义一套 pico 自己的标准结构,承载 ReAct 的"思考"与"行动"。

/** 消息角色:与大模型沟通的基石 */
export type Role = "system" | "user" | "assistant";

/** 工具调用:模型请求调用某个具体工具 */
export interface ToolCall {
  /** 工具调用的唯一 ID (由模型生成,用于把观察结果关联回这条调用) */
  id: string;
  /** 想要调用的工具名称,例如 "bash" */
  name: string;
  /**
   * JSON 参数字符串。延迟解析,把解析责任交给具体工具,
   * Main Loop 根本不关心工具需要什么参数 —— 极致解耦。
   */
  arguments: string;
}

/** 单次推理的 Token 用量(由 Provider 从厂商响应中填充) */
export interface Usage {
  /** 兼容旧字段:厂商报告的总输入 token,可能包含 cache read/write */
  promptTokens: number;
  /** 兼容旧字段:厂商报告的总输出 token,可能包含 reasoning token */
  completionTokens: number;
  /** 归一化后的真实新输入 token,不含 cache read/write */
  inputTokens?: number;
  /** 命中 prompt cache 的输入 token */
  cacheReadTokens?: number;
  /** 创建 prompt cache 的输入 token */
  cacheWriteTokens?: number;
  /** reasoning / thinking token */
  reasoningTokens?: number;
}

/** 计费与油耗分析使用的规范化五桶 Usage */
export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

/** 把不同 Provider 的 usage 字段统一成五桶模型 */
export function toCanonicalUsage(usage: Usage): CanonicalUsage {
  const cacheReadTokens = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWriteTokens = Math.max(0, usage.cacheWriteTokens ?? 0);
  const reasoningTokens = Math.max(0, usage.reasoningTokens ?? 0);
  const inputTokens = Math.max(
    0,
    usage.inputTokens ?? usage.promptTokens - cacheReadTokens - cacheWriteTokens,
  );
  const outputTokens = Math.max(0, usage.completionTokens - reasoningTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalPromptTokens: usage.promptTokens,
    totalCompletionTokens: usage.completionTokens,
  };
}

/** 上下文中传递的单条消息 */
export interface Message {
  role: Role;
  /** 纯文本内容:存放系统提示词 / 用户输入 / 模型推理 / 工具观察结果 */
  content: string;
  /** 模型决定调用工具时填充 (支持单轮并行多个) */
  toolCalls?: ToolCall[];
  /** 若本条是对某次工具调用的响应,此字段必填,以维系推理链条 */
  toolCallId?: string;
  /** 本条助手消息的 Token 用量(仅模型响应填充,用于成本追踪) */
  usage?: Usage;
  /** Provider 返回的 reasoning/thinking 摘要字段(不要求模型重放完整思维链) */
  reasoning?: string;
  /** Provider 特定透传数据,用于保留不进入 pico 核心语义的扩展字段 */
  providerData?: Record<string, unknown>;
  /** 图片附件(5.5 Image/Media):user 消息可携带图片,provider 翻译为各端的多模态 block */
  images?: ImagePart[];
}

/** Engine 内部注入不应在 resume 后伪装成用户消息。 */
export function isMessageHiddenFromTranscript(message: Message): boolean {
  if (message.providerData?.["picoHiddenFromTranscript"] === true) return true;
  if (message.role !== "user" || message.toolCallId !== undefined) return false;
  return (
    message.content.startsWith("[SYSTEM REMINDER") ||
    message.content.startsWith("[SYSTEM] 已达执行预算:")
  );
}

/**
 * 图片附件类型(5.5 Image/Media)。
 * 两种形式:base64 内联(通用,所有 provider 都支持)或 URL 引用(部分 provider 支持)。
 */
export type ImagePart =
  | { type: "image_base64"; mimeType: string; data: string }
  | { type: "image_url"; url: string };

/** 工具执行完毕后返回的物理结果 */
export interface ToolResult {
  toolCallId: string;
  /** 控制台输出或报错堆栈 */
  output: string;
  /** 是否失败,供后续错误自愈 (第 14 讲) 使用 */
  isError: boolean;
}

/** 工具元信息:供模型理解工具有什么用 (对应 JSON Schema) */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 描述的输入参数 */
  inputSchema: Record<string, unknown>;
}

/** 构造助手消息的便捷函数 */
export function assistantMessage(content: string, toolCalls?: ToolCall[]): Message {
  return { role: "assistant", content, toolCalls };
}

/** 构造工具观察结果消息的便捷函数 */
export function toolResultMessage(toolCallId: string, output: string, isError = false): Message {
  return { role: "user", content: isError ? `[ERROR] ${output}` : output, toolCallId };
}
