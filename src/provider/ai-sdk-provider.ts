import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenResponses } from "@ai-sdk/open-responses";
import { generateText, streamText, jsonSchema, type LanguageModelUsage, type ToolSet } from "ai";
import type { Message, ToolDefinition, Usage, UsageReportedField } from "../schema/message.js";
import type { ProviderConfig } from "./config.js";
import type { ProviderProtocol, ProviderProfile } from "./profile.js";
import { resolveProviderProfile } from "./profile.js";
import {
  providerRequestSignal,
  type LLMProvider,
  type LLMProviderRequestOptions,
} from "./interface.js";
import { toAiSdkMessages, fromAiSdkContent } from "./ai-sdk-messages.js";
import { OpenAIRequestPolicy } from "./openai-request-policy.js";
import { applyAnthropicCacheControl } from "./anthropic-cache.js";
import { applyReasoningRequestPatch } from "./reasoning-capability.js";
import { isLegacyThinkingEffort, toAnthropicThinkingConfig } from "./thinking.js";
import { defaultToolChoiceNoneWithTools } from "./model-capabilities.js";
import { snapshotToolDefinitions } from "./prompt-cache.js";
import { openCodeClientHeaders } from "./opencode-headers.js";
import { appendProviderEndpointPath } from "./provider-endpoint.js";
import { parseRateLimitHeaders } from "./ratelimit.js";
import { ContextOverflowError, isContextOverflowStatus, LLMStatusError } from "./errors.js";

/** One model step only. Pico owns tools, permissions, retries and conversation persistence. */
export class AiSdkProvider implements LLMProvider {
  readonly requestCapabilities;
  private readonly profile: ProviderProfile;
  private readonly chatPolicy: OpenAIRequestPolicy;
  constructor(
    private readonly wire: ProviderProtocol,
    private readonly config: ProviderConfig,
    profile?: ProviderProfile,
  ) {
    this.profile = profile ?? resolveProviderProfile(wire, config.model);
    this.chatPolicy = new OpenAIRequestPolicy(
      config,
      this.profile,
      wire === "responses" ? "responses" : "openai",
    );
    const configuredToolChoiceNone = config.capabilities?.toolChoiceNoneWithTools;
    const toolChoiceNoneWithTools =
      typeof configuredToolChoiceNone === "boolean"
        ? configuredToolChoiceNone
        : defaultToolChoiceNoneWithTools(wire, config.baseURL) === true;
    this.requestCapabilities = {
      ...(wire !== "claude" ? this.chatPolicy.requestCapabilities : {}),
      toolChoiceNoneWithTools,
    };
  }
  get modelName(): string {
    return this.config.model;
  }

  generate(
    messages: Message[],
    tools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    return this.run(messages, tools, undefined, options);
  }
  generateStream(
    messages: Message[],
    tools: ToolDefinition[],
    onDelta: (delta: string) => void,
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    return this.run(messages, tools, onDelta, options);
  }

  private async run(
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: ((delta: string) => void) | undefined,
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    const signal = providerRequestSignal(options?.signal, options?.timeoutMs);
    const definitions = snapshotToolDefinitions(availableTools);
    const tools: ToolSet = Object.fromEntries(
      definitions.map((t) => [
        t.name,
        {
          description: t.description,
          inputSchema: jsonSchema(t.inputSchema),
          // Deliberately no execute: all execution and approval happen in Pico's Loop.
        },
      ]),
    );
    let nonStreamingUsage: unknown;
    const transport: typeof fetch = async (_url, init) => {
      let body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      body = this.prepareBody(body, messages, definitions, options);
      let response: Response;
      let errorText: string | undefined;
      if (this.wire !== "claude") {
        const dispatched = await this.chatPolicy.dispatch(body, options, { ...init, signal });
        response = dispatched.response;
        errorText = dispatched.errorText;
      } else {
        options?.onRequestPrepared?.({ provider: this.wire, model: this.config.model, body });
        const headers = new Headers(init?.headers);
        headers.delete("user-agent");
        headers.delete("authorization");
        headers.delete("x-api-key");
        if (this.config.auth !== "none")
          headers.set(
            this.wire === "claude" ? "x-api-key" : "authorization",
            this.wire === "claude" ? this.config.apiKey : `Bearer ${this.config.apiKey}`,
          );
        for (const [key, value] of Object.entries(openCodeClientHeaders(this.config)))
          headers.set(key, value);
        response = await fetch(this.endpoint(), {
          ...init,
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) errorText = await response.text();
      }
      if (!response.ok) {
        if (isContextOverflowStatus(response.status, errorText ?? ""))
          throw new ContextOverflowError(
            `Model API context overflow [${response.status}]; response omitted`,
          );
        throw new LLMStatusError(
          response.status,
          `Model API request failed [${response.status}]; response omitted`,
        );
      }
      const rate = this.config.onRateLimitInfo && parseRateLimitHeaders(response.headers);
      if (rate) this.config.onRateLimitInfo?.(rate);
      if (!body.stream) nonStreamingUsage = record(await response.clone().json())?.usage;
      // Some compatible gateways omit the final SSE blank line. Let the SDK parse the
      // final event too, without adding another protocol/event parser in Pico.
      if (body.stream && response.body) {
        return new Response(
          response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                controller.enqueue(chunk);
              },
              flush(controller) {
                controller.enqueue(new TextEncoder().encode("\n\n"));
              },
            }),
          ),
          { status: response.status, statusText: response.statusText, headers: response.headers },
        );
      }
      return response;
    };
    const apiKey = this.config.auth === "none" ? "anonymous" : this.config.apiKey;
    const deepseek =
      this.wire === "responses" && new URL(this.config.baseURL).hostname === "api.deepseek.com";
    const model =
      this.wire === "claude"
        ? createAnthropic({ apiKey, fetch: transport })(this.config.model)
        : this.wire === "openai"
          ? createOpenAICompatible({
              name: "pico",
              apiKey,
              baseURL: this.config.baseURL,
              fetch: transport,
              includeUsage: this.config.capabilities?.streamUsage === true,
              supportedUrls: () => ({ "image/*": [/^https?:\/\//] }),
            }).chatModel(this.config.model)
          : deepseek
            ? createOpenResponses({ name: "pico", apiKey, url: this.endpoint(), fetch: transport })(
                this.config.model,
              )
            : createOpenAI({ apiKey, fetch: transport }).responses(this.config.model);
    const request = {
      model,
      messages: toAiSdkMessages(messages, this.wire),
      allowSystemInMessages: true,
      tools,
      ...(this.wire === "claude" ? { maxOutputTokens: this.profile.maxOutputTokens } : {}),
      maxRetries: 0,
      abortSignal: signal,
      ...(options?.toolChoice === "none" &&
      definitions.length &&
      (this.wire !== "claude" || !this.requestCapabilities.toolChoiceNoneWithTools)
        ? { toolChoice: "none" as const }
        : {}),
      ...(this.wire === "responses" && !deepseek
        ? { providerOptions: { openai: { store: false, forceReasoning: true } } }
        : {}),
    };
    try {
      if (!onDelta) {
        const result = await generateText(request);
        if (result.finishReason === "error") throw new Error("Model response failed");
        return {
          ...fromAiSdkContent(result.content, this.wire),
          usage: translateUsage(
            result.steps.at(-1)!.usage,
            this.wire,
            nonStreamingUsage ?? record(result.response.body)?.usage,
          ),
        };
      }
      const result = streamText({ ...request, includeRawChunks: true, onError: () => {} });
      let finished = false;
      let rawUsage: Record<string, unknown> | undefined;
      for await (const chunk of result.stream) {
        if (chunk.type === "raw") {
          const raw = record(chunk.rawValue);
          const value =
            record(raw?.usage) ??
            record(record(raw?.message)?.usage) ??
            record(record(raw?.response)?.usage);
          if (value) rawUsage = { ...rawUsage, ...value };
        } else if (chunk.type === "text-delta") onDelta(chunk.text);
        else if (chunk.type === "reasoning-delta") options?.onReasoningDelta?.(chunk.text);
        else if (chunk.type === "error") throw chunk.error;
        else if (chunk.type === "abort")
          throw signal.reason ?? new DOMException("Aborted", "AbortError");
        else if (chunk.type === "finish") {
          if (chunk.finishReason === "error" || chunk.finishReason === "other")
            throw new Error("Model stream ended without a valid completion");
          finished = true;
        }
      }
      signal.throwIfAborted();
      if (!finished) throw new Error("Model stream ended before completion");
      return {
        ...fromAiSdkContent(await result.content, this.wire),
        usage: translateUsage((await result.steps).at(-1)!.usage, this.wire, rawUsage),
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      // SDK validation errors can embed arbitrary response content; never expose their raw data/cause.
      let cause: unknown = error;
      for (let depth = 0; cause instanceof Error && depth < 8; depth++, cause = cause.cause) {
        if (cause instanceof LLMStatusError) throw cause;
        if (cause instanceof TypeError)
          // eslint-disable-next-line preserve-caught-error -- SDK causes may contain credentials and prompt data.
          throw new TypeError("模型网络请求失败；已省略连接及响应详情");
        if (cause.name === "AbortError" || cause.name === "TimeoutError") throw cause;
      }
      // eslint-disable-next-line preserve-caught-error -- Do not retain SDK request/response objects in errors.
      throw new Error("模型通信失败：响应格式或连接异常；已省略请求及响应内容");
    }
  }

  private endpoint(): string {
    const endpoint = new URL(this.config.baseURL);
    const suffix = this.wire === "claude" ? "messages" : "responses";
    if (endpoint.pathname.replace(/\/+$/u, "").endsWith(`/${suffix}`)) return endpoint.toString();
    return appendProviderEndpointPath(this.config.baseURL, suffix);
  }

  private prepareBody(
    body: Record<string, unknown>,
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Record<string, unknown> {
    if (this.wire === "openai")
      return this.chatPolicy.finalizeRequestBody(body, messages, tools, options);
    const capability = this.config.capabilities;
    const effort = this.config.thinkingEffort ?? "off";
    if (this.wire === "responses") {
      body = this.chatPolicy.finalizeRequestBody(body, messages, tools, options);
      body.store = false;
      delete body.previous_response_id;
      body = capability
        ? applyReasoningRequestPatch(body, capability.reasoningProfile, effort, "responses")
        : body;
      if (!capability && effort !== "off") body.reasoning = { effort };
      delete body.max_tokens;
      delete body.max_completion_tokens;
      delete body.max_output_tokens;
      if (capability?.maxOutputTokens !== undefined)
        body.max_output_tokens = capability.maxOutputTokens;
      // Full-history requests also replay reasoning; no server-side conversation dependency.
      return body;
    }
    // The SDK removes Anthropic tools for "none". Opted-in routes preserve their cache prefix.
    if (
      options?.toolChoice === "none" &&
      tools.length &&
      this.requestCapabilities.toolChoiceNoneWithTools
    )
      body.tool_choice = { type: "none" };
    body.max_tokens = this.profile.maxOutputTokens;
    if (!capability && isLegacyThinkingEffort(effort)) {
      const thinking = toAnthropicThinkingConfig(effort);
      if (thinking) body.thinking = thinking;
    }
    if (
      this.profile.supportsPromptCache &&
      (capability?.cache === true ||
        !capability ||
        (capability.cache === "unknown" &&
          new URL(this.config.baseURL).hostname === "api.anthropic.com"))
    ) {
      applyAnthropicCacheControl(body, true, {
        stablePrefixTtl: capability?.promptCache.ttl === "1h" ? "1h" : "5m",
        historyTtl: "5m",
      });
    }
    if (capability)
      body = applyReasoningRequestPatch(body, capability.reasoningProfile, effort, "claude");
    const budget = record(body.thinking)?.budget_tokens;
    if (
      typeof budget === "number" &&
      budget > 0 &&
      typeof body.max_tokens === "number" &&
      body.max_tokens <= budget
    )
      body.max_tokens = Math.max(this.profile.maxOutputTokens, budget + 1024);
    if (options?.promptCachePrewarm) body.max_tokens = 0;
    return body;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Raw fields preserve missing-vs-zero semantics; SDK totals normalize Anthropic cache buckets. */
function translateUsage(
  usage: LanguageModelUsage,
  wire: ProviderProtocol,
  rawValue?: unknown,
): Usage | undefined {
  const raw = record(rawValue) ?? usage.raw;
  if (!raw && usage.inputTokens === undefined && usage.outputTokens === undefined) return undefined;
  const input = wire === "openai" ? raw?.prompt_tokens : raw?.input_tokens;
  const output = wire === "openai" ? raw?.completion_tokens : raw?.output_tokens;
  const details = record(
    wire === "openai" ? raw?.prompt_tokens_details : raw?.input_tokens_details,
  );
  const outputDetails = record(
    wire === "openai" ? raw?.completion_tokens_details : raw?.output_tokens_details,
  );
  const read = wire === "claude" ? raw?.cache_read_input_tokens : details?.cached_tokens;
  const write = wire === "claude" ? raw?.cache_creation_input_tokens : details?.cache_write_tokens;
  const reasoning = outputDetails?.reasoning_tokens;
  const reported: UsageReportedField[] = [];
  if (typeof input === "number") reported.push("prompt");
  if (typeof output === "number") reported.push("completion");
  if (typeof read === "number") reported.push("cacheRead");
  if (typeof write === "number") reported.push("cacheWrite");
  if (typeof reasoning === "number") reported.push("reasoning");
  if (wire === "claude" && typeof input === "number") reported.push("input");
  return {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
    ...(wire === "claude" && typeof input === "number" ? { inputTokens: input } : {}),
    cacheReadTokens: typeof read === "number" ? read : 0,
    ...(typeof write === "number" ? { cacheWriteTokens: write } : {}),
    ...(wire !== "claude" || typeof reasoning === "number"
      ? { reasoningTokens: typeof reasoning === "number" ? reasoning : 0 }
      : {}),
    reportedFields: reported,
  };
}
