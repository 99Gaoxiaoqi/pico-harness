// Pico request policy around the SDK transport: cache routing, compatibility fallback and budgets.
import { providerRequestSignal, type LLMProviderRequestOptions } from "./interface.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import type { ProviderConfig } from "./config.js";
import { type ProviderProfile } from "./profile.js";
import { isLegacyThinkingEffort, toOpenAIReasoningEffort } from "./thinking.js";
import { applyReasoningRequestPatch } from "./reasoning-capability.js";
import { logger } from "../observability/logger.js";
import {
  openAIPromptCacheKey,
  promptCacheRouteIdentity,
  promptCacheRevisions,
} from "./prompt-cache.js";
import { openCodeClientHeaders } from "./opencode-headers.js";
import { appendProviderEndpointPath } from "./provider-endpoint.js";

export class OpenAIRequestPolicy {
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
  private readonly thinkingEffort: string;
  private readonly promptCacheFieldRoute: string | undefined;
  private readonly promptCacheRoutingIdentity: string | undefined;
  private promptCacheKeyEnabled: boolean;
  private promptCacheBreakpointsEnabled: boolean;
  private promptCacheRetentionEnabled: boolean;

  constructor(
    private readonly config: ProviderConfig,
    _profile?: ProviderProfile,
    private readonly wire: "openai" | "responses" = "openai",
  ) {
    this.thinkingEffort = config.thinkingEffort ?? "off";
    this.promptCacheFieldRoute =
      config.capabilities?.cache === true
        ? promptCacheRouteIdentity({
            provider: this.wire,
            model: config.model,
            baseURL: config.baseURL,
            policy: { activeCacheFields: true },
          })
        : undefined;
    this.promptCacheRoutingIdentity =
      config.capabilities?.cache === true
        ? promptCacheRouteIdentity({
            provider: this.wire,
            model: config.model,
            baseURL: config.baseURL,
            policy: config.capabilities.promptCache,
          })
        : undefined;
    this.promptCacheKeyEnabled =
      this.promptCacheFieldRoute === undefined ||
      !OpenAIRequestPolicy.unsupportedPromptCacheKeyRoutes.has(this.promptCacheFieldRoute);
    this.promptCacheBreakpointsEnabled =
      this.promptCacheFieldRoute === undefined ||
      !OpenAIRequestPolicy.unsupportedPromptCacheBreakpointRoutes.has(this.promptCacheFieldRoute);
    this.promptCacheRetentionEnabled =
      this.promptCacheFieldRoute === undefined ||
      !OpenAIRequestPolicy.unsupportedPromptCacheRetentionRoutes.has(this.promptCacheFieldRoute);
    this.requestCapabilities = {
      toolChoiceNoneWithTools: config.capabilities?.toolChoiceNoneWithTools === true,
      ...(this.promptCacheRoutingIdentity && (config.capabilities?.promptCache.keyShards ?? 1) > 1
        ? {
            promptCacheRouteIdentity: this.promptCacheRoutingIdentity,
            preparePromptCacheSharding: () =>
              OpenAIRequestPolicy.recordPromptCacheRouteTraffic(
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

  private endpoint(): string {
    const url = new URL(this.config.baseURL);
    if (this.wire === "responses" && url.pathname.replace(/\/+$/u, "").endsWith("/responses"))
      return url.toString();
    return appendProviderEndpointPath(
      this.config.baseURL,
      this.wire === "responses" ? "responses" : "chat/completions",
    );
  }

  get modelName(): string {
    return this.config.model;
  }

  async dispatch(
    requestBody: Record<string, unknown>,
    options?: LLMProviderRequestOptions,
    init?: RequestInit,
  ): Promise<{ response: Response; bodyJson: string; errorText?: string }> {
    const dispatch = async (body: Record<string, unknown>): Promise<Response> => {
      options?.onRequestPrepared?.({
        provider: this.wire,
        model: this.config.model,
        body,
      });
      return fetch(this.endpoint(), {
        ...init,
        method: "POST",
        headers: {
          ...(this.config.auth === "none" ? {} : { Authorization: `Bearer ${this.config.apiKey}` }),
          ...openCodeClientHeaders(this.config),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: init?.signal ?? providerRequestSignal(options?.signal, options?.timeoutMs),
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
          OpenAIRequestPolicy.unsupportedPromptCacheKeyRoutes.add(this.promptCacheFieldRoute);
        }
      }
      if (rejected.breakpoints) {
        this.promptCacheBreakpointsEnabled = false;
        if (this.promptCacheFieldRoute) {
          OpenAIRequestPolicy.unsupportedPromptCacheBreakpointRoutes.add(
            this.promptCacheFieldRoute,
          );
        }
      }
      if (rejected.retention) {
        this.promptCacheRetentionEnabled = false;
        if (this.promptCacheFieldRoute) {
          OpenAIRequestPolicy.unsupportedPromptCacheRetentionRoutes.add(this.promptCacheFieldRoute);
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
  finalizeRequestBody(
    body: Record<string, unknown>,
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Record<string, unknown> {
    const requestBody = { ...(this.wire === "openai" ? this.applyThinkingLevel(body) : body) };
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
          provider: this.wire,
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
    } else {
      delete requestBody[outputTokenField];
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
