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
import {
  openAIPromptCacheKey,
  promptCacheRouteIdentity,
  promptCacheRevisions,
  snapshotToolDefinitions,
} from "./prompt-cache.js";
import { openCodeClientHeaders } from "./opencode-headers.js";
import { appendProviderEndpointPath } from "./provider-endpoint.js";

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
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
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
  private static readonly MAX_ROUTE_TRAFFIC_WINDOWS = 1_024;
  /** Endpoint/model capability memory survives short-lived runtime/provider reconstruction. */
  private static readonly unsupportedPromptCacheKeyRoutes = new Set<string>();
  private static readonly unsupportedPromptCacheBreakpointRoutes = new Set<string>();
  private static readonly unsupportedPromptCacheRetentionRoutes = new Set<string>();
  private static readonly promptCacheRouteTraffic = new Map<
    string,
    { minute: number; count: number }
  >();
  /** Once a route crosses the threshold, do not make existing Sessions drift back next minute. */
  private static readonly shardedPromptCacheRoutes = new Set<string>();
  readonly requestCapabilities;
  private readonly profile: ProviderProfile;
  private readonly thinkingEffort: string;
  private readonly promptCacheFieldRoute: string | undefined;
  private readonly promptCacheRoutingIdentity: string | undefined;
  private promptCacheKeyEnabled: boolean;
  private promptCacheBreakpointsEnabled: boolean;
  private promptCacheRetentionEnabled: boolean;

  constructor(
    private readonly config: ProviderConfig,
    profile?: ProviderProfile,
  ) {
    this.profile = profile ?? resolveProviderProfile("openai", config.model);
    this.thinkingEffort = config.thinkingEffort ?? "off";
    this.promptCacheFieldRoute =
      config.capabilities?.cache === true
        ? promptCacheRouteIdentity({
            provider: "openai",
            model: config.model,
            baseURL: config.baseURL,
            policy: { activeCacheFields: true },
          })
        : undefined;
    this.promptCacheRoutingIdentity =
      config.capabilities?.cache === true
        ? promptCacheRouteIdentity({
            provider: "openai",
            model: config.model,
            baseURL: config.baseURL,
            policy: config.capabilities.promptCache,
          })
        : undefined;
    this.promptCacheKeyEnabled =
      this.promptCacheFieldRoute === undefined ||
      !OpenAIProvider.unsupportedPromptCacheKeyRoutes.has(this.promptCacheFieldRoute);
    this.promptCacheBreakpointsEnabled =
      this.promptCacheFieldRoute === undefined ||
      !OpenAIProvider.unsupportedPromptCacheBreakpointRoutes.has(this.promptCacheFieldRoute);
    this.promptCacheRetentionEnabled =
      this.promptCacheFieldRoute === undefined ||
      !OpenAIProvider.unsupportedPromptCacheRetentionRoutes.has(this.promptCacheFieldRoute);
    this.requestCapabilities = {
      toolChoiceNoneWithTools: config.capabilities?.toolChoiceNoneWithTools === true,
      ...(this.promptCacheRoutingIdentity && (config.capabilities?.promptCache.keyShards ?? 1) > 1
        ? {
            promptCacheRouteIdentity: this.promptCacheRoutingIdentity,
            preparePromptCacheSharding: () =>
              OpenAIProvider.recordPromptCacheRouteTraffic(
                this.promptCacheRoutingIdentity!,
                config.capabilities?.promptCache.shardThresholdRpm ?? 15,
              ),
          }
        : {}),
    };
  }

  /** Record one logical call, not each transport retry, in the route's current minute window. */
  private static recordPromptCacheRouteTraffic(
    routeIdentity: string,
    thresholdRpm: number,
  ): boolean {
    if (this.shardedPromptCacheRoutes.has(routeIdentity)) return true;
    const minute = Math.floor(Date.now() / 60_000);
    const current = this.promptCacheRouteTraffic.get(routeIdentity);
    const next =
      current?.minute === minute ? { minute, count: current.count + 1 } : { minute, count: 1 };
    this.promptCacheRouteTraffic.delete(routeIdentity);
    this.promptCacheRouteTraffic.set(routeIdentity, next);
    if (this.promptCacheRouteTraffic.size > this.MAX_ROUTE_TRAFFIC_WINDOWS) {
      const oldest = this.promptCacheRouteTraffic.keys().next().value;
      if (oldest !== undefined) this.promptCacheRouteTraffic.delete(oldest);
    }
    if (next.count > thresholdRpm) {
      this.shardedPromptCacheRoutes.add(routeIdentity);
      return true;
    }
    return false;
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

  private async dispatchChatCompletion(
    requestBody: Record<string, unknown>,
    options?: LLMProviderRequestOptions,
  ): Promise<{ response: Response; bodyJson: string; errorText?: string }> {
    const dispatch = async (body: Record<string, unknown>): Promise<Response> => {
      options?.onRequestPrepared?.({
        provider: "openai",
        model: this.config.model,
        body,
      });
      return fetch(appendProviderEndpointPath(this.config.baseURL, "chat/completions"), {
        method: "POST",
        headers: {
          ...(this.config.auth === "none" ? {} : { Authorization: `Bearer ${this.config.apiKey}` }),
          ...openCodeClientHeaders(this.config),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: providerRequestSignal(options?.signal, options?.timeoutMs),
      });
    };

    let actualBody = requestBody;
    let response = await dispatch(actualBody);
    let errorText = response.ok ? undefined : await response.text();
    for (let downgrade = 0; !response.ok && downgrade < 2; downgrade++) {
      const rejected = rejectedPromptCacheFields(response.status, errorText ?? "");
      if (!rejected) break;
      if (rejected.key) {
        this.promptCacheKeyEnabled = false;
        if (this.promptCacheFieldRoute) {
          OpenAIProvider.unsupportedPromptCacheKeyRoutes.add(this.promptCacheFieldRoute);
        }
      }
      if (rejected.breakpoints) {
        this.promptCacheBreakpointsEnabled = false;
        if (this.promptCacheFieldRoute) {
          OpenAIProvider.unsupportedPromptCacheBreakpointRoutes.add(this.promptCacheFieldRoute);
        }
      }
      if (rejected.retention) {
        this.promptCacheRetentionEnabled = false;
        if (this.promptCacheFieldRoute) {
          OpenAIProvider.unsupportedPromptCacheRetentionRoutes.add(this.promptCacheFieldRoute);
        }
      }
      actualBody = stripPromptCacheRequestFields(actualBody, rejected);
      logger.warn(
        {
          model: this.config.model,
          status: response.status,
          promptCacheKey: rejected.key ? "unsupported" : "retained",
          promptCacheBreakpoints: rejected.breakpoints ? "unsupported" : "retained",
          promptCacheRetention: rejected.retention ? "unsupported" : "retained",
        },
        "[OpenAI] 兼容端点拒绝部分主动缓存字段，已按字段降级",
      );
      response = await dispatch(actualBody);
      errorText = response.ok ? undefined : await response.text();
    }
    return {
      response,
      bodyJson: JSON.stringify(actualBody),
      ...(errorText !== undefined ? { errorText } : {}),
    };
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

    // 2. 翻译工具定义。Schema 在 provider 边界再规范化一次，保护直接调用者。
    const tools = snapshotToolDefinitions(availableTools);
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: openaiMsgs,
    };
    // 无可用工具时不挂载 tools,模型只能纯文本输出
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
      if (options?.toolChoice === "none") body.tool_choice = "none";
    }
    const requestBody = this.finalizeRequestBody(body, messages, tools, options);

    // 3. 构建请求并发送
    logger.debug(
      { model: this.config.model, messages: openaiMsgs.length, tools: tools.length },
      "[OpenAI] POST /chat/completions",
    );
    const dispatched = await this.dispatchChatCompletion(requestBody, options);
    const resp = dispatched.response;

    if (!resp.ok) {
      const text = dispatched.errorText ?? "";
      logger.debug(
        {
          model: this.config.model,
          status: resp.status,
          requestBytes: Buffer.byteLength(dispatched.bodyJson, "utf8"),
          messages: openaiMsgs.length,
          tools: tools.length,
        },
        "[OpenAI] 请求失败，已省略可能包含源码或密钥的请求体",
      );
      if (isContextOverflowStatus(resp.status, text)) {
        throw new ContextOverflowError(`OpenAI API 上下文溢出 [${resp.status}]; response omitted`);
      }
      throw new LLMStatusError(
        resp.status,
        `OpenAI API 请求失败 [${resp.status}]; response omitted`,
      );
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
            ...(typeof data.usage.prompt_tokens_details?.cache_write_tokens === "number"
              ? { cacheWriteTokens: data.usage.prompt_tokens_details.cache_write_tokens }
              : {}),
            reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            reportedFields: [
              ...(typeof data.usage.prompt_tokens === "number" ? (["prompt"] as const) : []),
              ...(typeof data.usage.completion_tokens === "number"
                ? (["completion"] as const)
                : []),
              ...(typeof data.usage.prompt_tokens_details?.cached_tokens === "number"
                ? (["cacheRead"] as const)
                : []),
              ...(typeof data.usage.prompt_tokens_details?.cache_write_tokens === "number"
                ? (["cacheWrite"] as const)
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
          if (msg.reasoning && this.profile.supportsReasoningContent) {
            ast.reasoning_content = msg.reasoning;
          }
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

    const tools = snapshotToolDefinitions(availableTools);
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: openaiMsgs,
      stream: true, // 关键:启用流式
    };
    if (this.config.capabilities?.streamUsage === true) {
      body.stream_options = { include_usage: true };
    }
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }
    const requestBody = this.finalizeRequestBody(body, messages, tools, options);
    const dispatched = await this.dispatchChatCompletion(requestBody, options);
    const resp = dispatched.response;

    if (!resp.ok) {
      const text = dispatched.errorText ?? "";
      if (isContextOverflowStatus(resp.status, text)) {
        throw new ContextOverflowError(`OpenAI API 上下文溢出 [${resp.status}]; response omitted`);
      }
      throw new LLMStatusError(
        resp.status,
        `OpenAI API 流式请求失败 [${resp.status}]; response omitted`,
      );
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
    let fullReasoning = "";
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
              reasoning_content?: string;
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
            prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
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
            ...(typeof chunk.usage.prompt_tokens_details?.cache_write_tokens === "number"
              ? { cacheWriteTokens: chunk.usage.prompt_tokens_details.cache_write_tokens }
              : {}),
            reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            reportedFields: [
              ...(typeof chunk.usage.prompt_tokens === "number" ? (["prompt"] as const) : []),
              ...(typeof chunk.usage.completion_tokens === "number"
                ? (["completion"] as const)
                : []),
              ...(typeof chunk.usage.prompt_tokens_details?.cached_tokens === "number"
                ? (["cacheRead"] as const)
                : []),
              ...(typeof chunk.usage.prompt_tokens_details?.cache_write_tokens === "number"
                ? (["cacheWrite"] as const)
                : []),
              ...(typeof chunk.usage.completion_tokens_details?.reasoning_tokens === "number"
                ? (["reasoning"] as const)
                : []),
            ],
          };
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) return true;

        // Provider 可展示的 reasoning 独立回传，不能混入最终回答正文。
        if (delta.reasoning_content) {
          fullReasoning += delta.reasoning_content;
          options?.onReasoningDelta?.(delta.reasoning_content);
        }

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
      reasoning: fullReasoning || undefined,
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
  private finalizeRequestBody(
    body: Record<string, unknown>,
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Record<string, unknown> {
    const requestBody = { ...this.applyThinkingLevel(body) };
    const capabilities = this.config.capabilities;
    if (!capabilities) return requestBody;
    if (options?.toolChoice === "none" && Array.isArray(requestBody["tools"])) {
      requestBody.tool_choice = "none";
    }

    // `cache:true` explicitly allows the routing key for both implicit and explicit caching.
    // Compatible endpoints that reject active cache fields are remembered and fail open.
    if (capabilities.cache === true) {
      const revisions = promptCacheRevisions(messages, tools);
      const routeIdentity =
        this.promptCacheRoutingIdentity ??
        promptCacheRouteIdentity({
          provider: "openai",
          model: this.config.model,
          baseURL: this.config.baseURL,
          policy: capabilities.promptCache,
        });
      if (this.promptCacheKeyEnabled) {
        requestBody.prompt_cache_key = openAIPromptCacheKey(
          this.config.model,
          revisions,
          shouldShardPromptCacheKey(capabilities.promptCache, options)
            ? capabilities.promptCache.keyShards
            : 1,
          {
            routeIdentity,
            ...(options?.promptCacheShardSeed
              ? { conversationShardSeed: options.promptCacheShardSeed }
              : {}),
          },
        );
      }
      if (capabilities.promptCache.retention && this.promptCacheRetentionEnabled) {
        requestBody.prompt_cache_retention = capabilities.promptCache.retention;
      }
      if (
        capabilities.promptCache.mode === "explicit" &&
        capabilities.promptCache.explicitBreakpoints === true &&
        this.promptCacheBreakpointsEnabled &&
        applyOpenAIExplicitPromptCacheBreakpoint(requestBody)
      ) {
        requestBody.prompt_cache_options = {
          mode: "explicit",
          ...(capabilities.promptCache.ttl !== undefined
            ? { ttl: capabilities.promptCache.ttl }
            : {}),
        };
      }
    }

    const outputTokenField = capabilities.outputTokenField;
    const alternateField =
      outputTokenField === "max_tokens" ? "max_completion_tokens" : "max_tokens";
    delete requestBody[alternateField];
    // 不传 maxOutputTokens 时让 provider 使用模型默认上限（reasoning 模型不会因预算不足返回空 content）
    if (capabilities.maxOutputTokens !== undefined) {
      requestBody[outputTokenField] = capabilities.maxOutputTokens;
    }
    return requestBody;
  }
}

function rejectedPromptCacheFields(
  status: number,
  body: string,
):
  | { readonly key: boolean; readonly breakpoints: boolean; readonly retention: boolean }
  | undefined {
  if (status !== 400 && status !== 422) return undefined;
  const key = /prompt[_ -]?cache[_ -]?key/iu.test(body);
  const breakpoints = /prompt[_ -]?cache[_ -]?(?:options|breakpoint)/iu.test(body);
  const retention = /prompt[_ -]?cache[_ -]?retention/iu.test(body);
  return key || breakpoints || retention ? { key, breakpoints, retention } : undefined;
}

function shouldShardPromptCacheKey(
  policy: { readonly keyShards: number },
  options?: LLMProviderRequestOptions,
): boolean {
  return policy.keyShards > 1 && options?.promptCacheShardActive === true;
}

/** GPT-5.6 Chat Completions breakpoints live on content blocks, not top-level request fields. */
function applyOpenAIExplicitPromptCacheBreakpoint(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body["messages"])) return false;
  const messages = body["messages"].map((message) =>
    isRecord(message) ? { ...message } : message,
  );
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || (message["role"] !== "system" && message["role"] !== "developer")) {
      continue;
    }
    const content = message["content"];
    if (typeof content === "string") {
      messages[index] = {
        ...message,
        content: [
          {
            type: "text",
            text: content,
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      };
      body.messages = messages;
      return true;
    }
    if (!Array.isArray(content)) continue;
    const blocks = content.map((block) => (isRecord(block) ? { ...block } : block));
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = blocks[blockIndex];
      if (!isRecord(block) || !isOpenAICacheableContentBlock(block["type"])) continue;
      blocks[blockIndex] = {
        ...block,
        prompt_cache_breakpoint: { mode: "explicit" },
      };
      messages[index] = { ...message, content: blocks };
      body.messages = messages;
      return true;
    }
  }
  return false;
}

function isOpenAICacheableContentBlock(value: unknown): boolean {
  return (
    value === "text" ||
    value === "image_url" ||
    value === "input_audio" ||
    value === "file" ||
    value === "refusal"
  );
}

function stripPromptCacheRequestFields(
  body: Readonly<Record<string, unknown>>,
  fields: { readonly key: boolean; readonly breakpoints: boolean; readonly retention: boolean },
): Record<string, unknown> {
  const stripped = fields.breakpoints
    ? stripInjectedPromptCacheBreakpoints(body)
    : structuredClone(body);
  if (!isRecord(stripped)) return {};
  if (fields.key) delete stripped["prompt_cache_key"];
  if (fields.breakpoints) delete stripped["prompt_cache_options"];
  if (fields.retention) delete stripped["prompt_cache_retention"];
  return stripped;
}

function stripInjectedPromptCacheBreakpoints(
  body: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const stripped: Record<string, unknown> = structuredClone({ ...body });
  const messages = stripped["messages"];
  if (!Array.isArray(messages)) return stripped;
  stripped.messages = messages.map((message) => {
    if (
      !isRecord(message) ||
      (message["role"] !== "system" && message["role"] !== "developer") ||
      !Array.isArray(message["content"])
    ) {
      return message;
    }
    return {
      ...message,
      content: message["content"].map((block) => {
        if (!isRecord(block)) return block;
        const breakpoint = block["prompt_cache_breakpoint"];
        if (!isRecord(breakpoint) || breakpoint["mode"] !== "explicit") return block;
        const cleaned = { ...block };
        delete cleaned["prompt_cache_breakpoint"];
        return cleaned;
      }),
    };
  });
  return stripped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
