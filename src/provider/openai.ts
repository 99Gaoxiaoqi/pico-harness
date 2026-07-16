// OpenAI 兼容协议适配器 (同声传译员)。
// 对应课程第 04 讲 internal/provider/openai.go。
//
// 职责:把内部干净的 schema.Message 历史 → OpenAI Chat Completions 请求体;
//       把 OpenAI 返回的 tool_calls → 内部 schema.Message。
// 不引入重型 SDK,直接用原生 fetch,更贴合"手写翻译层"的精神。

import {
  providerRequestSignal,
  type LLMProvider,
  type LLMProviderRequestOptions,
} from "./interface.js";
import type { Message, ToolCall, ToolDefinition, Usage } from "../schema/message.js";
import type { ProviderConfig } from "./config.js";
import { resolveProviderProfile, type ProviderProfile } from "./profile.js";
import { isLegacyThinkingEffort, toOpenAIReasoningEffort } from "./thinking.js";
import { applyReasoningRequestPatch } from "./reasoning-capability.js";
import { ContextOverflowError, isContextOverflowStatus, LLMStatusError } from "./errors.js";
import { parseRateLimitHeaders } from "./ratelimit.js";
import { logger } from "../observability/logger.js";

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

/**
 * Incrementally consume SSE data fields without assuming a specific line ending.
 * A false return from onData stops the stream (used by OpenAI's [DONE] sentinel).
 */
async function consumeSseDataStream(
  stream: NonNullable<Response["body"]>,
  onData: (data: string) => boolean,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const dataLines: string[] = [];
  let buffer = "";
  let keepReading = true;
  let reachedEof = false;

  const dispatchEvent = (): void => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines.length = 0;
    keepReading = onData(data);
  };

  const consumeLine = (line: string): void => {
    if (line.length === 0) {
      dispatchEvent();
      return;
    }
    if (line.startsWith(":")) return;

    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    if (field !== "data") return;

    let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    dataLines.push(value);
  };

  const consumeBufferedLines = (atEof: boolean): void => {
    let lineStart = 0;
    let cursor = 0;

    while (keepReading && cursor < buffer.length) {
      const character = buffer[cursor];
      if (character !== "\n" && character !== "\r") {
        cursor += 1;
        continue;
      }

      let delimiterLength = 1;
      if (character === "\r") {
        // A trailing CR may be the first half of CRLF in the next network chunk.
        if (cursor + 1 === buffer.length && !atEof) break;
        if (buffer[cursor + 1] === "\n") delimiterLength = 2;
      }

      consumeLine(buffer.slice(lineStart, cursor));
      cursor += delimiterLength;
      lineStart = cursor;
    }

    buffer = buffer.slice(lineStart);
    if (!atEof || !keepReading) return;

    if (buffer.length > 0) {
      consumeLine(buffer);
      buffer = "";
    }
    if (keepReading) dispatchEvent();
  };

  try {
    while (keepReading) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        buffer += decoder.decode();
        consumeBufferedLines(true);
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      consumeBufferedLines(false);
    }
  } finally {
    if (!reachedEof) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

/** OpenAI 兼容协议适配器 */
export class OpenAIProvider implements LLMProvider {
  private readonly profile: ProviderProfile;
  private readonly thinkingEffort: string;

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

  /**
   * 把 user 消息内容翻译为 OpenAI Chat Completions 的 content 字段。
   * - 无图片:返回纯字符串(向后兼容)。
   * - 有图片:返回 [text, image_url...] 数组,走多模态格式。
   * generate 与 generateStream 复用此方法,避免两处重复实现。
   */
  private translateUserContent(msg: Message): unknown {
    if (!msg.images || msg.images.length === 0) {
      return msg.content;
    }
    const content: unknown[] = [{ type: "text", text: msg.content }];
    for (const img of msg.images) {
      if (img.type === "image_base64") {
        content.push({
          type: "image_url",
          image_url: { url: `data:${img.mimeType};base64,${img.data}` },
        });
      } else {
        content.push({ type: "image_url", image_url: { url: img.url } });
      }
    }
    return content;
  }

  async generate(
    messages: Message[],
    availableTools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
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
            openaiMsgs.push({ role: "user", content: this.translateUserContent(msg) });
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
    // 无可用工具时不挂载 tools,模型只能纯文本输出
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
    const requestBody = this.finalizeRequestBody(body);

    // 3. 构建请求并发送
    const bodyJson = JSON.stringify(requestBody);
    logger.debug(
      { model: this.config.model, messages: openaiMsgs.length, tools: availableTools.length },
      "[OpenAI] POST /chat/completions",
    );
    const resp = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: bodyJson,
      signal: providerRequestSignal(options?.signal),
    });

    if (!resp.ok) {
      const text = await resp.text();
      logger.debug(
        {
          model: this.config.model,
          status: resp.status,
          requestBytes: Buffer.byteLength(bodyJson, "utf8"),
          messages: openaiMsgs.length,
          tools: availableTools.length,
        },
        "[OpenAI] 请求失败，已省略可能包含源码或密钥的请求体",
      );
      if (isContextOverflowStatus(resp.status, text)) {
        throw new ContextOverflowError(`OpenAI API 上下文溢出 [${resp.status}]: ${text}`);
      }
      throw new LLMStatusError(resp.status, `OpenAI API 请求失败 [${resp.status}]: ${text}`);
    }

    // 限流信息回传:resp.ok 成功后解析 RateLimit header,命中即回调
    if (this.config.onRateLimitInfo) {
      const info = parseRateLimitHeaders(resp.headers);
      if (info) this.config.onRateLimitInfo(info);
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
            reportedFields: [
              ...(typeof data.usage.prompt_tokens === "number" ? (["prompt"] as const) : []),
              ...(typeof data.usage.completion_tokens === "number"
                ? (["completion"] as const)
                : []),
              ...(typeof data.usage.prompt_tokens_details?.cached_tokens === "number"
                ? (["cacheRead"] as const)
                : []),
              ...(typeof data.usage.completion_tokens_details?.reasoning_tokens === "number"
                ? (["reasoning"] as const)
                : []),
            ],
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

  /**
   * 流式生成:与非流式 generate 行为一致,但每收到一段文本就调 onDelta。
   * 通过 SSE (Server-Sent Events) 解析 OpenAI 的流式响应。
   */
  async generateStream(
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: (delta: string) => void,
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    // 复用 generate 的消息翻译逻辑
    const openaiMsgs: unknown[] = [];
    for (const msg of messages) {
      switch (msg.role) {
        case "system":
          openaiMsgs.push({ role: "system", content: msg.content });
          break;
        case "user":
          if (msg.toolCallId) {
            openaiMsgs.push({ role: "tool", content: msg.content, tool_call_id: msg.toolCallId });
          } else {
            openaiMsgs.push({ role: "user", content: this.translateUserContent(msg) });
          }
          break;
        case "assistant": {
          const ast: Record<string, unknown> = { role: "assistant" };
          ast.content =
            this.profile.assistantContent === "null_when_empty" ? msg.content || null : msg.content;
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

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: openaiMsgs,
      stream: true, // 关键:启用流式
    };
    if (this.config.capabilities?.streamUsage === true) {
      body.stream_options = { include_usage: true };
    }
    if (availableTools.length > 0) {
      body.tools = availableTools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }
    const requestBody = this.finalizeRequestBody(body);

    const resp = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: providerRequestSignal(options?.signal),
    });

    if (!resp.ok) {
      const text = await resp.text();
      if (isContextOverflowStatus(resp.status, text)) {
        throw new ContextOverflowError(`OpenAI API 上下文溢出 [${resp.status}]: ${text}`);
      }
      throw new LLMStatusError(resp.status, `OpenAI API 流式请求失败 [${resp.status}]: ${text}`);
    }

    // 限流信息回传:resp.ok 成功后解析 RateLimit header,命中即回调
    if (this.config.onRateLimitInfo) {
      const info = parseRateLimitHeaders(resp.headers);
      if (info) this.config.onRateLimitInfo(info);
    }

    if (!resp.body) {
      throw new Error("流式响应没有 body");
    }

    // 解析 SSE 流
    let fullContent = "";
    const toolCallAccumulator = new Map<
      number,
      { id?: string; name?: string; arguments: string }
    >();
    let usage: Usage | undefined;

    await consumeSseDataStream(resp.body, (data) => {
      if (data === "[DONE]") return false;

      try {
        const chunk = JSON.parse(data) as {
          choices?: {
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string;
          }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
            completion_tokens_details?: { reasoning_tokens?: number };
          };
        };

        // OpenAI 兼容 Provider 通常用 choices 为空的最后一个 chunk 上报 Usage。
        // 必须先消费 Usage，再判断是否存在内容 delta。
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            reportedFields: [
              ...(typeof chunk.usage.prompt_tokens === "number" ? (["prompt"] as const) : []),
              ...(typeof chunk.usage.completion_tokens === "number"
                ? (["completion"] as const)
                : []),
              ...(typeof chunk.usage.prompt_tokens_details?.cached_tokens === "number"
                ? (["cacheRead"] as const)
                : []),
              ...(typeof chunk.usage.completion_tokens_details?.reasoning_tokens === "number"
                ? (["reasoning"] as const)
                : []),
            ],
          };
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) return true;

        // 文本 delta
        if (delta.content) {
          fullContent += delta.content;
          onDelta(delta.content);
        }

        // 工具调用 delta(分片累积)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallAccumulator.get(tc.index) ?? { arguments: "" };
            if (tc.id) {
              existing.id = tc.id;
            }
            if (tc.function?.name) {
              existing.name = tc.function.name;
            }
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
            toolCallAccumulator.set(tc.index, existing);
          }
        }
      } catch {
        // 跳过无法解析的事件
      }
      return true;
    });

    const toolCalls: ToolCall[] = [];
    for (const [index, tc] of toolCallAccumulator) {
      if (!tc.id || !tc.name) {
        throw new Error(`OpenAI 流式工具调用缺少必要字段(index=${index})`);
      }
      toolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
    }

    return {
      role: "assistant",
      content: fullContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
    };
  }

  /** 路由请求严格使用模型 profile；无 profile 的旧直连调用保留四档映射。 */
  private applyThinkingLevel(body: Record<string, unknown>): Record<string, unknown> {
    const capability = this.config.capabilities?.reasoningProfile;
    if (capability) {
      return applyReasoningRequestPatch(body, capability, this.thinkingEffort, "openai");
    }
    if (!isLegacyThinkingEffort(this.thinkingEffort)) return body;
    const reasoningEffort = toOpenAIReasoningEffort(this.thinkingEffort);
    return reasoningEffort === undefined ? body : { ...body, reasoning_effort: reasoningEffort };
  }

  /** Canonical routes restore the output budget last; legacy direct calls cannot safely guess the field. */
  private finalizeRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    const requestBody = { ...this.applyThinkingLevel(body) };
    const capabilities = this.config.capabilities;
    if (!capabilities) return requestBody;

    const outputTokenField = capabilities.outputTokenField;
    const alternateField =
      outputTokenField === "max_tokens" ? "max_completion_tokens" : "max_tokens";
    delete requestBody[alternateField];
    requestBody[outputTokenField] = capabilities.maxOutputTokens;
    return requestBody;
  }
}
