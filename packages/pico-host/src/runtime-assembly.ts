import type { LLMProvider, ProviderKind, ReasoningLevel, RequestContextFacts } from "@pico/core";
import type { Session } from "@pico/pico-host/session";
import type { ProviderConfig } from "@pico/runtime/provider-config";
import {
  createRawProvider,
  type ProviderRuntimeDependencies,
} from "@pico/pico-host/provider/factory";
import { CredentialRotationCoordinator } from "@pico/runtime/credential-rotation";
import { CredentialPool } from "@pico/runtime/credential-pool";
import type { RateLimitFailure } from "@pico/runtime/provider-retry";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import { billingRouteForProvider } from "@pico/runtime/provider-billing-route";
import { ModelRouter } from "@pico/pico-host/provider/model-router";
import { CostTracker, type CostTrackerOptions } from "@pico/pico-host/cost-tracker";
import {
  PromptCachePrewarmCoordinator,
  withPromptCachePrewarm,
} from "@pico/pico-host/product-prompt-cache-prewarm";

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
  readonly rebuildProvider?: (failure: RateLimitFailure) => LLMProvider | undefined;
}

export interface RuntimeModelAssemblyContext extends RuntimeProviderAssemblyContext {
  readonly sessionStorageRoot: string;
  readonly modelRouteId?: string;
  readonly modelRouter?: ModelRouter;
}

export interface RuntimeModelAssembly extends RuntimeProviderAssembly {
  readonly providerFactory: RuntimeProviderFactory;
  readonly providerDecorator: RuntimeProviderDecorator;
  readonly providerDependencies: ProviderRuntimeDependencies;
  readonly subagentModelRouter?: ModelRouter;
  readonly parentModelRouteId?: string;
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
        {
          ...context.trackerOptions,
          contextFacts: requestContextForProvider(context.kind, config),
        },
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
        {
          ...context.trackerOptions,
          contextFacts: requestContextForProvider(context.kind, context.config),
        },
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
      rebuildProvider: (failure) => rotation.rotate(failure),
    };
  }

  return { provider: buildTrackedProvider(context.config) };
}

/** Assemble the fixed main route and the router used by configured child sessions. */
export function assembleRuntimeModels(context: RuntimeModelAssemblyContext): RuntimeModelAssembly {
  const providerFactory = context.providerFactory ?? createRawProvider;
  const providerDecorator = context.providerDecorator ?? ((provider: LLMProvider) => provider);
  const providerDependencies: ProviderRuntimeDependencies = {
    promptCachePrewarm: PromptCachePrewarmCoordinator.shared(context.sessionStorageRoot),
  };
  const routeCredentials =
    context.provider === undefined && context.modelRouter && context.config.routeId
      ? context.modelRouter.credentialCandidates(context.config.routeId)
      : [];
  const credentialPool =
    routeCredentials.length > 1 ? new CredentialPool([...routeCredentials]) : undefined;
  const subagentModelRouter =
    context.modelRouter ??
    (context.modelRouteId && context.provider === undefined
      ? activeRouteModelRouter(context.kind, context.config, context.modelRouteId)
      : undefined);
  const parentModelRouteId = context.modelRouteId;
  const providerAssembly = assembleRuntimeProvider({
    kind: context.kind,
    config: context.config,
    session: context.session,
    trackerOptions: context.trackerOptions,
    ...(context.provider !== undefined ? { provider: context.provider } : {}),
    providerFactory,
    providerDecorator,
    ...(credentialPool ? { credentialPool } : {}),
    providerDependencies,
  });
  return {
    ...providerAssembly,
    providerFactory,
    providerDecorator,
    providerDependencies,
    ...(subagentModelRouter ? { subagentModelRouter } : {}),
    ...(parentModelRouteId ? { parentModelRouteId } : {}),
  };
}

function activeRouteModelRouter(
  kind: ProviderKind,
  config: ProviderConfig,
  routeId: string,
): ModelRouter {
  const apiKeyEnv = "PICO_ACTIVE_MODEL_API_KEY";
  return new ModelRouter(
    [
      {
        id: routeId,
        providerId: routeId.split("/", 1)[0] || "active",
        provider: kind,
        model: config.model,
        baseURL: config.baseURL,
        apiKeyEnv,
        ...(config.auth ? { auth: config.auth } : {}),
        source: "config",
        capabilities:
          config.capabilities ??
          resolveModelRouteCapabilities(kind, config.model, undefined, {
            baseURL: config.baseURL,
          }),
      },
    ],
    { [apiKeyEnv]: config.apiKey },
    routeId,
  );
}

/** @deprecated Billing-route projection now belongs to @pico/runtime. */
export { billingRouteForProvider } from "@pico/runtime/provider-billing-route";

/** Public model metadata is frozen by the tracker alongside the admitted request. */
export function requestContextForProvider(
  kind: ProviderKind,
  config: ProviderConfig,
): RequestContextFacts {
  const capabilities =
    config.capabilities ??
    resolveModelRouteCapabilities(kind, config.model, undefined, { baseURL: config.baseURL });
  return {
    version: 1,
    ...(config.routeId
      ? { routeId: config.routeId, connectionId: config.routeId.split("/", 1)[0]! }
      : {}),
    contextWindow: capabilities.contextWindowTokens,
    contextWindowSource: capabilities.contextSource,
  };
}
