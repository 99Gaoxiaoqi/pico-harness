import type { Session } from "../engine/session.js";
import type { ProviderConfig } from "../provider/config.js";
import {
  createRawProvider,
  type ProviderKind,
  type ProviderRuntimeDependencies,
} from "../provider/factory.js";
import type { ReasoningLevel } from "../provider/reasoning-capability.js";
import { CredentialRotationCoordinator } from "../provider/credential-rotation.js";
import { CredentialPool } from "../provider/credential-pool.js";
import type { LLMProvider } from "../provider/interface.js";
import { CostTracker, type CostTrackerOptions } from "../observability/tracker.js";
import type { BillingRoute } from "../observability/pricing.js";
import {
  PromptCachePrewarmCoordinator,
  withPromptCachePrewarm,
} from "../provider/prompt-cache-prewarm.js";

/** Runtime-owned provider factory. Network configuration stays outside this assembly boundary. */
export type RuntimeProviderFactory = (
  kind: ProviderKind,
  config: ProviderConfig,
  thinkingEffort?: ReasoningLevel,
  dependencies?: ProviderRuntimeDependencies,
) => LLMProvider;
export type RuntimeProviderDecorator = (provider: LLMProvider) => LLMProvider;

/**
 * The smallest input required to assemble the provider used by an AgentEngine.
 *
 * Keeping this contract independent from AgentRuntime makes credential rotation,
 * injected providers, and usage tracking testable without constructing a full
 * SessionRuntime/tool graph.
 */
export interface RuntimeProviderAssemblyContext {
  readonly kind: ProviderKind;
  readonly config: ProviderConfig;
  readonly session: Session;
  readonly trackerOptions: CostTrackerOptions;
  readonly provider?: LLMProvider;
  readonly providerFactory?: RuntimeProviderFactory;
  readonly providerDecorator?: RuntimeProviderDecorator;
  readonly credentialPool?: CredentialPool;
  /** Runtime-owned non-secret provider dependencies, such as workspace cache metadata. */
  readonly providerDependencies?: ProviderRuntimeDependencies;
}

export interface RuntimeProviderAssembly {
  /** Provider wrapped with the runtime's usage and durable-call tracking. */
  readonly provider: LLMProvider;
  /** Rebuilds the tracked route after a rate-limit failure, when rotation is enabled. */
  readonly rebuildProvider?: () => LLMProvider | undefined;
}

/**
 * Assemble one tracked provider route without owning any external resources.
 *
 * Ownership remains with executeAgentRuntime: this helper only creates the
 * provider/decorator pair and the optional rotation callback. That makes the
 * assembly boundary explicit while preserving the existing cleanup lifecycle.
 */
export function assembleRuntimeProvider(
  context: RuntimeProviderAssemblyContext,
): RuntimeProviderAssembly {
  const providerFactory = context.providerFactory ?? createRawProvider;
  const decorate = context.providerDecorator ?? ((provider: LLMProvider) => provider);
  const promptCachePrewarm =
    context.providerDependencies?.promptCachePrewarm ?? new PromptCachePrewarmCoordinator();
  const buildTrackedProvider = (config: ProviderConfig): LLMProvider =>
    withPromptCachePrewarm(
      context.kind,
      new CostTracker(
        decorate(providerFactory(context.kind, config, undefined, context.providerDependencies)),
        billingRouteForProvider(context.kind, config),
        context.session,
        context.trackerOptions,
      ),
      config,
      promptCachePrewarm,
    );

  if (context.provider !== undefined) {
    return {
      provider: new CostTracker(
        decorate(context.provider),
        billingRouteForProvider(context.kind, context.config),
        context.session,
        context.trackerOptions,
      ),
    };
  }

  if (context.credentialPool && context.credentialPool.size > 1) {
    const rotation = new CredentialRotationCoordinator(
      context.credentialPool,
      context.config,
      buildTrackedProvider,
    );
    return {
      provider: rotation.provider,
      rebuildProvider: () => rotation.rotate(),
    };
  }

  return { provider: buildTrackedProvider(context.config) };
}

/** Resolve the billing identity without constructing a provider. */
export function billingRouteForProvider(
  kind: ProviderKind,
  config: ProviderConfig,
): BillingRoute | string {
  const price = config.capabilities?.price;
  if (!config.capabilities) return config.model;
  return {
    provider: kind,
    model: config.model,
    baseUrl: config.baseURL,
    cacheSupported: config.capabilities.cache,
    pricing:
      price?.source === "config"
        ? {
            inputPerMillion: price.inputPerMillion,
            outputPerMillion: price.outputPerMillion,
            cacheReadPerMillion: price.cacheReadPerMillion,
            cacheWritePerMillion: price.cacheWritePerMillion,
            source: "configured",
          }
        : null,
  };
}
