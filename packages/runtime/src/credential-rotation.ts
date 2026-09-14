import type { LLMProvider, LLMProviderRequestOptions, Message, ToolDefinition } from "@pico/core";
import { CredentialPool } from "./credential-pool.js";
import { registerProviderRequestIdentity, type RateLimitFailure } from "./provider-retry.js";

/** The rotation policy only needs the secret and stable route identity; outer configuration may add fields. */
export interface CredentialRouteConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly routeId?: string;
}

export type CredentialRouteProviderFactory<Config extends CredentialRouteConfig> = (
  config: Config,
) => LLMProvider;

interface CredentialRoute<Config extends CredentialRouteConfig> {
  readonly config: Config;
  readonly provider: LLMProvider;
}

/** Coordinates concurrent 429 failures against the credential that actually made the request. */
export class CredentialRotationCoordinator<Config extends CredentialRouteConfig> {
  private current: CredentialRoute<Config>;

  constructor(
    private readonly pool: CredentialPool,
    initialConfig: Config,
    private readonly providerFactory: CredentialRouteProviderFactory<Config>,
  ) {
    this.current = this.createRoute(initialConfig);
  }

  get provider(): LLMProvider {
    return this.current.provider;
  }

  rotate(failure: RateLimitFailure): LLMProvider | undefined {
    const failedCredential = failure.failedCredential ?? this.current.config.apiKey;
    this.pool.markRateLimited(failedCredential);
    if (this.current.config.apiKey !== failedCredential) return this.current.provider;
    const nextCredential = this.pool.getNextAvailable();
    if (!nextCredential || nextCredential === failedCredential) return undefined;
    this.current = this.createRoute({ ...this.current.config, apiKey: nextCredential } as Config);
    return this.current.provider;
  }

  private createRoute(config: Config): CredentialRoute<Config> {
    const next = this.providerFactory(config);
    const rememberFailure = (error: unknown): void => {
      registerProviderRequestIdentity(error, {
        provider: routed,
        credential: config.apiKey,
        routeId: config.routeId ?? config.model,
        model: next.modelName ?? config.model,
      });
    };
    const routed: LLMProvider = {
      generate: async (
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
      },
      get modelName() {
        return next.modelName;
      },
      get requestCapabilities() {
        return next.requestCapabilities;
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
