import type { ProviderConfig } from "./config.js";
import { CredentialPool } from "./credential-pool.js";
import type { LLMProvider, LLMProviderRequestOptions } from "./interface.js";
import {
  currentRateLimitFailure,
  registerProviderRequestIdentity,
  type RateLimitFailure,
} from "./retry.js";
import type { Message, ToolDefinition } from "../schema/message.js";

export type CredentialRouteProviderFactory = (config: ProviderConfig) => LLMProvider;

interface CredentialRoute {
  config: ProviderConfig;
  provider: LLMProvider;
}

/**
 * 凭证轮换的并发协调器。每个路由 provider 会把错误绑定到实际 key，
 * 因此晚到的旧 key 429 只会幂等地重复标记旧 key，不会误伤已切换的新 key。
 */
export class CredentialRotationCoordinator {
  private current: CredentialRoute;

  constructor(
    private readonly pool: CredentialPool,
    initialConfig: ProviderConfig,
    private readonly providerFactory: CredentialRouteProviderFactory,
  ) {
    this.current = this.createRoute(initialConfig);
  }

  get provider(): LLMProvider {
    return this.current.provider;
  }

  /**
   * 标记实际失败 key 并轮换。failure 可省略，以兼容 Engine 现有无参回调；
   * 此时从 generateWithRetry 的同步失败上下文中取得同一份路由身份。
   */
  rotate(
    failure: RateLimitFailure | undefined = currentRateLimitFailure(),
  ): LLMProvider | undefined {
    const failedCredential = failure?.failedCredential ?? this.current.config.apiKey;
    this.pool.markRateLimited(failedCredential);

    // 另一个并发失败已经完成切换：复用当前 provider，不再消耗下一个 key。
    if (this.current.config.apiKey !== failedCredential) {
      return this.current.provider;
    }

    const nextCredential = this.pool.getNextAvailable();
    if (!nextCredential || nextCredential === failedCredential) return undefined;

    this.current = this.createRoute({
      ...this.current.config,
      apiKey: nextCredential,
    });
    return this.current.provider;
  }

  private createRoute(config: ProviderConfig): CredentialRoute {
    const next = this.providerFactory(config);

    const rememberFailure = (error: unknown): void => {
      registerProviderRequestIdentity(error, {
        provider: routed,
        credential: config.apiKey,
        routeId: config.routeId ?? config.model,
        model: next.modelName ?? config.model,
      });
    };
    const generate = async (
      messages: Message[],
      tools: ToolDefinition[],
      options?: LLMProviderRequestOptions,
    ): Promise<Message> => {
      try {
        return await next.generate(messages, tools, options);
      } catch (error) {
        rememberFailure(error);
        throw error;
      }
    };

    const routed: LLMProvider = {
      generate,
      get modelName() {
        return next.modelName;
      },
      ...(next.isRetryableError ? { isRetryableError: next.isRetryableError.bind(next) } : {}),
    };

    const generateStream = next.generateStream;
    if (generateStream) {
      routed.generateStream = async (
        messages: Message[],
        tools: ToolDefinition[],
        onDelta: (delta: string) => void,
        options?: LLMProviderRequestOptions,
      ): Promise<Message> => {
        try {
          return await generateStream.call(next, messages, tools, onDelta, options);
        } catch (error) {
          rememberFailure(error);
          throw error;
        }
      };
    }

    return { config, provider: routed };
  }
}
