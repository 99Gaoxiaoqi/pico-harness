// OpenAI 兼容协议适配器 (同声传译员)。
// 对应课程第 04 讲 internal/provider/openai.go。
//
// 职责:把内部干净的 schema.Message 历史 → OpenAI Chat Completions 请求体;
//       把 OpenAI 返回的 tool_calls → 内部 schema.Message。
// 不引入重型 SDK,直接用原生 fetch,更贴合"手写翻译层"的精神。

import type { LLMProvider } from "./interface.js";
import type { Message, ToolCall, ToolDefinition } from "../schema/message.js";
import type { ProviderConfig } from "./config.js";
import { resolveProviderProfile, type ProviderProfile } from "./profile.js";
import { toOpenAIReasoningEffort, type ThinkingEffort } from "./thinking.js";
import { ContextOverflowError, isContextOverflowStatus, LLMStatusError } from "./errors.js";

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIChoiceMessage {
  role: string;
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIChatResponse {
  choices?: { message: OpenAIChoiceMessage }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/** OpenAI 兼容协议适配器 */
export class OpenAIProvider implements LLMProvider {
  private readonly profile: ProviderProfile;
  private readonly thinkingEffort: ThinkingEffort;

  constructor(
    private readonly config: ProviderConfig,
    profile?: ProviderProfile,
  ) {
    this.profile = profile ?? resolveProviderProfile("openai", config.model);
    this.thinkingEffort = config.thinkingEffort ?? "off";
  }

  get modelName(): string {
    return this.config.model;
  }

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
          ast.content =
            this.profile.assistantContent === "null_when_empty" ? msg.content || null : msg.content;
          if (msg.reasoning && this.profile.supportsReasoningContent) {
            ast.reasoning_content = msg.reasoning;
          }
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
    // 统一思考强度:模型原生 reasoning_effort(off 时不发送,与旧行为一致)
    const reasoningEffort = toOpenAIReasoningEffort(this.thinkingEffort);
    if (reasoningEffort !== undefined) {
      body.reasoning_effort = reasoningEffort;
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
      signal: AbortSignal.timeout(120_000), // 2 分钟超时,防网络挂起永久阻塞
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[OpenAI] ❌ ${resp.status} 响应: ${text}`);
      console.error(`[OpenAI] 请求体(前 2000 字符): ${bodyJson.slice(0, 2000)}`);
      if (isContextOverflowStatus(resp.status, text)) {
        throw new ContextOverflowError(`OpenAI API 上下文溢出 [${resp.status}]: ${text}`);
      }
      throw new LLMStatusError(resp.status, `OpenAI API 请求失败 [${resp.status}]: ${text}`);
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
            cacheReadTokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
            reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens ?? 0,
          }
        : undefined;

    return {
      role: "assistant",
      content: choice.content ?? "",
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      reasoning: choice.reasoning_content ?? undefined,
    };
  }
}
