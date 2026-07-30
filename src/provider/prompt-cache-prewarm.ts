import { logger } from "../observability/logger.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import type { ProviderConfig } from "./config.js";
import type { LLMProvider, LLMProviderRequestOptions } from "./interface.js";
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
  private readonly attempted = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();

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
    if (this.attempted.has(key)) return;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = this.run(provider, messages, stableTools, options)
      .catch((error: unknown) => {
        logger.warn(
          {
            model: config.model,
            errorName: error instanceof Error ? error.name : typeof error,
            statusCode: statusCode(error),
          },
          "[PromptCache] Claude 预热失败，正式请求继续执行",
        );
      })
      .finally(() => {
        this.attempted.add(key);
        this.pending.delete(key);
      });
    this.pending.set(key, task);
    return task;
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
