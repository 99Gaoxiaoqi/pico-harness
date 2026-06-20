// OpenAI 兼容协议适配器 (同声传译员)。
// 对应课程第 04 讲 internal/provider/openai.go。
//
// 职责:把内部干净的 schema.Message 历史 → OpenAI Chat Completions 请求体;
//       把 OpenAI 返回的 tool_calls → 内部 schema.Message。
// 不引入重型 SDK,直接用原生 fetch,更贴合"手写翻译层"的精神。

import type { LLMProvider } from "./interface.js";
import type { Message, ToolCall, ToolDefinition } from "../schema/message.js";
import type { ProviderConfig } from "./config.js";

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIChoiceMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIChatResponse {
  choices?: { message: OpenAIChoiceMessage }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** OpenAI 兼容协议适配器 */
export class OpenAIProvider implements LLMProvider {
  constructor(private readonly config: ProviderConfig) {}

  async generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message> {
    // 1. 翻译上下文消息
    const openaiMsgs: unknown[] = [];
    for (const msg of messages) {
      switch (msg.role) {
        case "system":
          openaiMsgs.push({ role: "system", content: msg.content });
          break;
        case "user":
          if (msg.toolCallId) {
            // 工具观察结果:role=tool + tool_call_id
            openaiMsgs.push({ role: "tool", content: msg.content, tool_call_id: msg.toolCallId });
          } else {
            openaiMsgs.push({ role: "user", content: msg.content });
          }
          break;
        case "assistant": {
          const ast: Record<string, unknown> = { role: "assistant" };
          // 部分模型(如 glm-5.2)要求 assistant 消息必须显式带 content 字段
          // (即使为 null),否则 400 "A parameter specified is not valid"
          ast.content = msg.content || null;
          // 历史的 ToolCalls 必须原样放回,维系大模型逻辑链
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            ast.tool_calls = msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            }));
          }
          openaiMsgs.push(ast);
          break;
        }
      }
    }

    // 2. 翻译工具定义
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: openaiMsgs,
    };
    // 慢思考支撑:availableTools 为空时不挂载 tools,模型只能纯文本输出
    if (availableTools.length > 0) {
      body.tools = availableTools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    // 3. 构建请求并发送
    const bodyJson = JSON.stringify(body);
    console.log(
      `[OpenAI] POST /chat/completions (model=${this.config.model}, msgs=${openaiMsgs.length}, tools=${availableTools.length})`,
    );
    const resp = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: bodyJson,
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[OpenAI] ❌ ${resp.status} 响应: ${text}`);
      console.error(`[OpenAI] 请求体(前 2000 字符): ${bodyJson.slice(0, 2000)}`);
      throw new Error(`OpenAI API 请求失败 [${resp.status}]: ${text}`);
    }

    const data = (await resp.json()) as OpenAIChatResponse;
    if (!data.choices || data.choices.length === 0) {
      throw new Error("API 返回了空的 choices");
    }

    // 4. 反向翻译为内部 schema.Message
    const choice = data.choices[0]!.message;
    const toolCalls: ToolCall[] = (choice.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    const usage =
      data.usage &&
      (typeof data.usage.prompt_tokens === "number" ||
        typeof data.usage.completion_tokens === "number")
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
          }
        : undefined;

    return {
      role: "assistant",
      content: choice.content ?? "",
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
    };
  }
}
