import { PhysicalAttemptTracker } from "./physical-attempt-tracker.js";
import { randomUUID } from "node:crypto";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenResponses } from "@ai-sdk/open-responses";
import { generateText, streamText, jsonSchema, type LanguageModelUsage, type ToolSet } from "ai";
import type {
  LLMProvider,
  LLMProviderRequestOptions,
  Message,
  ToolDefinition,
  Usage,
  UsageReportedField,
  ModelResponseDiagnostic,
  ModelCommunicationCategory,
} from "@pico/core";
import type { ProviderConfig } from "@pico/runtime/provider-config";
import type { ProviderProfile, ProviderProtocol } from "@pico/core";
import { resolveProviderProfile } from "@pico/runtime";
import { providerRequestSignal } from "@pico/core";
import { toAiSdkMessages, fromAiSdkContent, restoreResponsesWebSearch } from "./ai-sdk-messages.js";
import { OpenAIRequestPolicy } from "./openai-request-policy.js";
import { applyAnthropicCacheControl } from "@pico/runtime/provider/anthropic-cache";
import { applyReasoningRequestPatch } from "@pico/runtime";
import { defaultToolChoiceNoneWithTools } from "@pico/runtime";
import { snapshotToolDefinitions } from "@pico/runtime/prompt-cache";
import { openCodeClientHeaders } from "./opencode-headers.js";
import { appendProviderEndpointPath } from "@pico/runtime/provider-endpoint";
import { parseRateLimitHeaders } from "@pico/runtime/rate-limit";
import { ContextOverflowError, isContextOverflowStatus, LLMStatusError } from "@pico/core";
import { modelCommunicationError } from "./model-communication-error.js";

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
      physicalAttempts: true,
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
    if (
      options?.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0)
    )
      throw new RangeError("Provider output budget must be a positive integer");
    const signal = providerRequestSignal(options?.signal, options?.timeoutMs);
    const startedAt = performance.now();
    const diagnosticId = randomUUID();
    const attempts = new PhysicalAttemptTracker(
      this.wire,
      this.config.model,
      signal,
      options?.onProviderAttempt,
      options,
    );
    let rawUsage: Record<string, unknown> | undefined;
    let terminalUsageObserved = false;
    let responseDiagnostic: Partial<ModelResponseDiagnostic> = {};
    let failureCategory: ModelCommunicationCategory = "request_failed";
    const definitions = snapshotToolDefinitions(availableTools);
    const deepseek =
      this.wire === "responses" && new URL(this.config.baseURL).hostname === "api.deepseek.com";
    const tools: ToolSet = Object.fromEntries(
      definitions.map((definition) => {
        const kind = definition.providerTool?.kind;
        if (kind) {
          if (definition.name !== "web_search")
            throw new Error("模型原生搜索工具必须命名为 web_search");
          if (deepseek) throw new Error("DeepSeek 官方 Responses 当前不支持模型原生搜索");
          if (kind === "openai-web-search" && this.wire === "responses")
            return [definition.name, openai.tools.webSearch({})];
          if (kind === "anthropic-web-search" && this.wire === "claude")
            return [definition.name, anthropic.tools.webSearch_20250305({})];
          throw new Error("模型原生搜索工具与当前 Provider 协议不匹配");
        }
        return [
          definition.name,
          {
            description: definition.description,
            inputSchema: jsonSchema(definition.inputSchema),
            // No execute: Pico owns local tools; provider-native tools run on the server.
          },
        ];
      }),
    );
    const responseOutput: unknown[] = [];
    let nonStreamingUsage: unknown;
    const transport: typeof fetch = async (_url, init) => {
      let body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      body = this.applyOutputBudget(
        this.prepareBody(body, messages, definitions, options),
        options,
      );
      let response: Response;
      let errorText: string | undefined;
      if (this.wire !== "claude") {
        const dispatched = await this.chatPolicy.dispatch(
          body,
          options,
          { ...init, signal },
          (send) => attempts.dispatch(send),
        );
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
        response = await attempts.dispatch(() =>
          fetch(this.endpoint(), {
            ...init,
            headers,
            body: JSON.stringify(body),
            signal,
          }),
        );
        if (!response.ok) errorText = await response.text();
      }
      responseDiagnostic = {
        ...responseDiagnostic,
        httpStatus: response.status,
        headersMs: Math.round(performance.now() - startedAt),
      };
      failureCategory = "unknown";
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
      if (!body.stream) {
        const raw = record(await response.clone().json());
        nonStreamingUsage = raw?.usage;
        if (Array.isArray(raw?.output)) responseOutput.push(...raw.output);
      }
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
    // Abort the transport immediately, while allowing SDK chunks already delivered to
    // this client to drain for a bounded accounting-only window.
    const sdkController = new AbortController();
    const request = {
      model,
      messages: toAiSdkMessages(messages, this.wire, { responsesWebSearchAnchors: true }),
      allowSystemInMessages: true,
      tools,
      ...(this.wire === "claude" ? { maxOutputTokens: this.profile.maxOutputTokens } : {}),
      maxRetries: 0,
      abortSignal: sdkController.signal,
      ...(options?.toolChoice === "none" &&
      definitions.length &&
      (this.wire !== "claude" || !this.requestCapabilities.toolChoiceNoneWithTools)
        ? { toolChoice: "none" as const }
        : {}),
      ...(this.wire === "responses" && !deepseek
        ? { providerOptions: { openai: { store: false, forceReasoning: true } } }
        : {}),
    };
    const execute = async (): Promise<Message> => {
      try {
        if (!onDelta) {
          const result = await generateText(request);
          responseDiagnostic = { ...responseDiagnostic, finishReason: result.finishReason };
          if (result.finishReason === "error") {
            failureCategory = "rejected_completion";
            throw new Error("Model response failed");
          }
          const usage = translateUsage(
            result.steps.at(-1)!.usage,
            this.wire,
            nonStreamingUsage ?? record(result.response.body)?.usage,
          );
          attempts.settle(signal.aborted ? "cancelled" : "succeeded", usage, result.finishReason);
          const message = fromAiSdkContent(result.content, this.wire, responseOutput);
          return {
            ...message,
            providerData: { ...message.providerData, finishReason: result.finishReason },
            ...(usage === undefined ? {} : { usage }),
          };
        }
        const result = streamText({ ...request, includeRawChunks: true, onError: () => {} });
        let finished = false;
        for await (const chunk of result.stream) {
          if (
            (chunk.type === "text-delta" || chunk.type === "reasoning-delta") &&
            chunk.text.length > 0
          )
            attempts.observeOutput();
          if (chunk.type === "tool-input-delta" && chunk.delta.length > 0) attempts.observeOutput();
          if (chunk.type === "tool-call" || chunk.type === "tool-result") attempts.observeOutput();
          if (
            responseDiagnostic.firstChunkMs === undefined &&
            ["raw", "text-delta", "reasoning-delta", "error"].includes(chunk.type)
          )
            responseDiagnostic = {
              ...responseDiagnostic,
              firstChunkMs: Math.round(performance.now() - startedAt),
            };
          if (chunk.type === "raw") {
            const raw = record(chunk.rawValue);
            const choice = Array.isArray(raw?.choices) ? record(raw.choices[0]) : undefined;
            const reason = choice?.finish_reason;
            if (typeof reason === "string")
              responseDiagnostic = {
                ...responseDiagnostic,
                rawFinishReason:
                  reason === "stop" ||
                  reason === "length" ||
                  reason === "tool_calls" ||
                  reason === "content_filter" ||
                  reason === "error"
                    ? reason
                    : "unknown",
              };
            if (raw?.type === "response.output_item.done" && raw.item)
              responseOutput.push(raw.item);
            const value =
              record(raw?.usage) ??
              record(record(raw?.message)?.usage) ??
              record(record(raw?.response)?.usage);
            if (value) {
              rawUsage = { ...rawUsage, ...value };
              // Anthropic message_start already contains output_tokens, but it is only
              // an initial count. Responses can likewise carry snapshots before settlement.
              if (
                (this.wire === "claude" &&
                  raw?.type === "message_delta" &&
                  typeof record(raw.delta)?.stop_reason === "string" &&
                  typeof value.output_tokens === "number") ||
                (this.wire === "responses" &&
                  ["response.completed", "response.incomplete", "response.failed"].includes(
                    String(raw?.type),
                  )) ||
                (this.wire === "openai" && responseDiagnostic.rawFinishReason !== undefined)
              )
                terminalUsageObserved = true;
            }
          } else if (chunk.type === "text-delta" && !signal.aborted) onDelta(chunk.text);
          else if (chunk.type === "reasoning-delta" && !signal.aborted)
            options?.onReasoningDelta?.(chunk.text);
          else if (chunk.type === "error") {
            throw chunk.error;
          } else if (chunk.type === "abort")
            throw signal.reason ?? new DOMException("Aborted", "AbortError");
          else if (chunk.type === "finish") {
            responseDiagnostic = { ...responseDiagnostic, finishReason: chunk.finishReason };
            if (chunk.finishReason === "error" || chunk.finishReason === "other") {
              failureCategory =
                chunk.finishReason === "error" || responseDiagnostic.rawFinishReason === "error"
                  ? "rejected_completion"
                  : "incomplete_stream";
              throw new Error("Model stream ended without a valid completion");
            }
            finished = true;
          }
        }
        signal.throwIfAborted();
        if (!finished) {
          failureCategory = "incomplete_stream";
          throw new Error("Model stream ended before completion");
        }
        const usage = translateUsage((await result.steps).at(-1)!.usage, this.wire, rawUsage);
        attempts.settle(
          signal.aborted ? "cancelled" : "succeeded",
          usage,
          await result.finishReason,
        );
        const message = fromAiSdkContent(await result.content, this.wire, responseOutput);
        return {
          ...message,
          providerData: { ...message.providerData, finishReason: await result.finishReason },
          ...(usage === undefined ? {} : { usage }),
        };
      } catch (error) {
        attempts.settle(
          signal.aborted ? "cancelled" : "failed",
          usageFromRaw(
            rawUsage ?? record(nonStreamingUsage),
            this.wire,
            !onDelta || terminalUsageObserved,
          ),
          responseDiagnostic.finishReason,
          signal.aborted ? "请求已取消或超时" : "模型响应未完成",
        );
        if (signal.aborted) throw signal.reason;
        if (attempts.admissionError) throw attempts.admissionError;
        // Only allowlisted classifications cross the SDK boundary.
        throw modelCommunicationError(
          error,
          {
            ...responseDiagnostic,
            diagnosticId,
            durationMs: Math.round(performance.now() - startedAt),
          },
          failureCategory,
        );
      } finally {
        await attempts.flush();
      }
    };
    return new Promise<Message>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        attempts.settle(
          "cancelled",
          usageFromRaw(
            rawUsage ?? record(nonStreamingUsage),
            this.wire,
            !onDelta || terminalUsageObserved,
          ),
          undefined,
          "请求已取消或超时",
        );
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        timer = setTimeout(() => {
          attempts.close();
          sdkController.abort(signal.reason);
        }, 5_000);
        timer.unref?.();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void execute()
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener("abort", abort);
          if (timer) clearTimeout(timer);
          attempts.close();
        });
    });
  }

  /** Apply a per-call ceiling after route policy so no later rewrite can raise it. */
  private applyOutputBudget(
    body: Record<string, unknown>,
    options?: LLMProviderRequestOptions,
  ): Record<string, unknown> {
    if (options?.maxOutputTokens === undefined || options.promptCachePrewarm) return body;
    const routeLimit =
      this.config.capabilities?.maxOutputTokens ??
      (this.wire === "claude" ? this.profile.maxOutputTokens : undefined);
    const limit = Math.min(options.maxOutputTokens, routeLimit ?? options.maxOutputTokens);
    delete body.max_tokens;
    delete body.max_completion_tokens;
    delete body.max_output_tokens;
    const field =
      this.wire === "responses"
        ? "max_output_tokens"
        : this.wire === "claude"
          ? "max_tokens"
          : (this.config.capabilities?.outputTokenField ?? "max_tokens");
    body[field] = limit;
    const thinking = record(body.thinking);
    if (
      this.wire === "claude" &&
      typeof thinking?.budget_tokens === "number" &&
      thinking.budget_tokens >= limit
    ) {
      // Anthropic requires at least 1024 thinking tokens and budget < max_tokens.
      // A small bounded summary must not silently expand its output allowance.
      body.thinking =
        limit > 1024 ? { ...thinking, budget_tokens: limit - 1 } : { type: "disabled" };
    }
    return body;
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
      body = restoreResponsesWebSearch(body, messages);
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

/** Preserve provider-reported partial usage even when streaming ends in error or cancellation. */
function usageFromRaw(
  raw: Record<string, unknown> | undefined,
  wire: ProviderProtocol,
  terminalUsageObserved: boolean,
): Usage | undefined {
  if (!raw) return undefined;
  if (!terminalUsageObserved) {
    // Never promote an intermediate output counter to a final bill after cancellation.
    const {
      completion_tokens: _completion,
      output_tokens: _output,
      completion_tokens_details: _completionDetails,
      output_tokens_details: _outputDetails,
      ...inputUsage
    } = raw;
    raw = inputUsage;
  }
  const input = wire === "openai" ? raw.prompt_tokens : raw.input_tokens;
  const output = wire === "openai" ? raw.completion_tokens : raw.output_tokens;
  const read =
    wire === "claude" && typeof raw.cache_read_input_tokens === "number"
      ? raw.cache_read_input_tokens
      : 0;
  const write =
    wire === "claude" && typeof raw.cache_creation_input_tokens === "number"
      ? raw.cache_creation_input_tokens
      : 0;
  return translateUsage(
    {
      inputTokens: typeof input === "number" ? input + read + write : undefined,
      outputTokens: typeof output === "number" ? output : undefined,
    } as LanguageModelUsage,
    wire,
    raw,
  );
}
