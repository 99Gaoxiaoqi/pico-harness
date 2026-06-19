// 统一的数据结构 (Schema):整个微型 OS 各组件之间传递的"血液"。
// 对应课程第 02 讲 internal/schema/message.go。
// 由于不同大模型 (Claude / OpenAI) 的 API 格式千差万别,
// 我们定义一套 tiny-claw 自己的标准结构,承载 ReAct 的"思考"与"行动"。

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

/** 上下文中传递的单条消息 */
export interface Message {
  role: Role;
  /** 纯文本内容:存放系统提示词 / 用户输入 / 模型推理 / 工具观察结果 */
  content: string;
  /** 模型决定调用工具时填充 (支持单轮并行多个) */
  toolCalls?: ToolCall[];
  /** 若本条是对某次工具调用的响应,此字段必填,以维系推理链条 */
  toolCallId?: string;
}

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
