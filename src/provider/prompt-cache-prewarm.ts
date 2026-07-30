import { logger } from "../observability/logger.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import type { ProviderConfig } from "./config.js";
import type { LLMProvider, LLMProviderRequestOptions } from "./interface.js";
import { coordinateReasoningLevel } from "./reasoning-capability.js";
import {
  promptCacheRevisions,
  promptCacheRouteIdentity,
  snapshotToolDefinitions,
} from "./prompt-cache.js";

/**
 * Runtime-scoped prewarm dedupe. One instance is shared by a parent route, credential rotations,
 * and its subagents; unrelated workspaces receive independent instances.
 */
export class PromptCachePrewarmCoordinator {
  private static readonly MAX_SHARED_SCOPES = 128;
  private static readonly MAX_ATTEMPTED_REVISIONS = 1_024;
  private static readonly sharedScopes = new Map<string, PromptCachePrewarmCoordinator>();
  private readonly attemptedUntil = new Map<string, number>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Persist dedupe across short-lived AgentRuntime executions in the same workspace process. */
  static shared(scope: string): PromptCachePrewarmCoordinator {
    const existing = this.sharedScopes.get(scope);
    if (existing) {
      this.sharedScopes.delete(scope);
      this.sharedScopes.set(scope, existing);
      return existing;
    }
    const created = new PromptCachePrewarmCoordinator();
    this.sharedScopes.set(scope, created);
    if (this.sharedScopes.size > this.MAX_SHARED_SCOPES) {
      const oldest = this.sharedScopes.keys().next().value;
      if (oldest !== undefined) this.sharedScopes.delete(oldest);
    }
    return created;
  }

  async ensure(
    provider: LLMProvider,
    config: ProviderConfig,
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<void> {
    const stableTools = snapshotToolDefinitions(tools);
    const revisions = promptCacheRevisions(messages, stableTools);
    const routeIdentity = promptCacheRouteIdentity({
      provider: "claude",
      model: config.model,
      baseURL: config.baseURL,
      policy: config.capabilities?.promptCache,
    });
    const key = `${routeIdentity}:${revisions.prefix}`;
    const now = this.now();
    const attemptedUntil = this.attemptedUntil.get(key);
    if (attemptedUntil !== undefined && attemptedUntil > now) return;
    if (attemptedUntil !== undefined) this.attemptedUntil.delete(key);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const ttlMs = promptCacheTtlMs(config);
    const task = this.run(provider, messages, stableTools, options)
      .then(() => {
        this.rememberAttempt(key, this.now() + ttlMs);
      })
      .catch((error: unknown) => {
        logger.warn(
          {
            model: config.model,
            errorName: error instanceof Error ? error.name : typeof error,
            statusCode: statusCode(error),
          },
          "[PromptCache] Claude 预热失败，正式请求继续执行",
        );
        // Avoid hammering a failing endpoint in one run, but never suppress a revision forever.
        this.rememberAttempt(key, this.now() + Math.min(30_000, Math.ceil(ttlMs * 0.1)));
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, task);
    return task;
  }

  private rememberAttempt(key: string, expireAt: number): void {
    this.attemptedUntil.delete(key);
    this.attemptedUntil.set(key, expireAt);
    if (this.attemptedUntil.size > PromptCachePrewarmCoordinator.MAX_ATTEMPTED_REVISIONS) {
      const oldest = this.attemptedUntil.keys().next().value;
      if (oldest !== undefined) this.attemptedUntil.delete(oldest);
    }
  }

  private async run(
    provider: LLMProvider,
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<void> {
    const stableSystem = messages.filter((message) => message.role === "system");
    // Anthropic Messages requires a message. This constant tail carries no user/task content and
    // receives no history breakpoint, so only tools/system are warmed.
    const prewarmMessages: Message[] = [...stableSystem, { role: "user", content: "." }];
    await provider.generate(prewarmMessages, [...tools], {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(provider.requestCapabilities?.toolChoiceNoneWithTools === true
        ? { toolChoice: "none" as const }
        : {}),
      purpose: "prewarm",
      promptCachePrewarm: true,
    });
  }
}

/** Wrap a tracked Claude route; all other routes and disabled policies are returned unchanged. */
export function withPromptCachePrewarm(
  providerKind: string,
  provider: LLMProvider,
  config: ProviderConfig,
  coordinator: PromptCachePrewarmCoordinator,
): LLMProvider {
  if (providerKind !== "claude" || config.capabilities?.promptCache.prewarm !== true) {
    return provider;
  }
  const cacheSupport = config.capabilities.cache;
  if (
    cacheSupport === false ||
    (cacheSupport !== true && !isOfficialAnthropicEndpoint(config.baseURL))
  ) {
    return provider;
  }
  const reasoningLevel =
    config.thinkingEffort ??
    (config.capabilities
      ? coordinateReasoningLevel(config.capabilities.reasoningProfile).level
      : undefined);
  if (reasoningLevel !== undefined && reasoningLevel.trim().toLowerCase() !== "off") {
    logger.warn(
      { model: config.model, reasoningLevel },
      "[PromptCache] Claude 预热与当前 thinking/reasoning 不兼容，已禁用预热",
    );
    return provider;
  }
  const wrapped: LLMProvider = {
    get modelName() {
      return provider.modelName;
    },
    get requestCapabilities() {
      return provider.requestCapabilities;
    },
    generate: async (messages, tools, options) => {
      await coordinator.ensure(provider, config, messages, tools, options);
      return provider.generate(messages, tools, options);
    },
    ...(provider.isRetryableError
      ? { isRetryableError: provider.isRetryableError.bind(provider) }
      : {}),
  };
  if (provider.generateStream) {
    wrapped.generateStream = async (messages, tools, onDelta, options) => {
      await coordinator.ensure(provider, config, messages, tools, options);
      return provider.generateStream!(messages, tools, onDelta, options);
    };
  }
  return wrapped;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

function promptCacheTtlMs(config: ProviderConfig): number {
  return config.capabilities?.promptCache.ttl === "1h" ? 3_600_000 : 300_000;
}

function isOfficialAnthropicEndpoint(baseURL: string): boolean {
  try {
    const endpoint = new URL(baseURL);
    return (
      endpoint.protocol === "https:" && endpoint.hostname.toLowerCase() === "api.anthropic.com"
    );
  } catch {
    return false;
  }
}
