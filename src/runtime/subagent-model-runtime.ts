import { Compactor } from "../context/compactor.js";
import { createContextBudget, estimateTokenBudgetAsChars } from "../context/context-budget.js";
import type { Session } from "../engine/session.js";
import { CostTracker, type CostTrackerOptions } from "../observability/tracker.js";
import type { BillingRoute } from "../observability/pricing.js";
import type { ProviderConfig } from "../provider/config.js";
import { createRawProvider, type ProviderKind } from "../provider/factory.js";
import type { LLMProvider } from "../provider/interface.js";
import type { ModelRoute, ModelRouter } from "../provider/model-router.js";
import { resolveProviderProfile } from "../provider/profile.js";
import type { ResolvedSubagentModelSelection } from "./subagent-model-selection.js";

export type SubagentProviderFactory = (kind: ProviderKind, config: ProviderConfig) => LLMProvider;

export interface SubagentModelRuntime {
  readonly route: ModelRoute;
  readonly provider: LLMProvider;
  readonly compactor: Compactor;
  readonly thinkingEffort?: string;
}

export interface CreateSubagentModelRuntimeOptions {
  readonly router: ModelRouter;
  readonly selection: ResolvedSubagentModelSelection;
  readonly session?: Session;
  readonly providerFactory?: SubagentProviderFactory;
  readonly trackerOptions?: CostTrackerOptions;
}

/**
 * 为一次子代理执行构造独立模型运行时。
 *
 * Provider 与 Compactor 均不复用父 Agent 或兄弟子代理的可变状态。第一版不接入
 * 子代理模型始终由 ModelRouter 解析并校验路由与凭证。
 */
export function createSubagentModelRuntime(
  options: CreateSubagentModelRuntimeOptions,
): SubagentModelRuntime {
  const {
    provider: kind,
    config,
    route,
  } = options.router.providerConfig(options.selection.route.id, options.selection.thinking.level);
  const providerFactory = options.providerFactory ?? createRawProvider;
  const provider = new CostTracker(
    providerFactory(kind, config),
    trackingRoute(kind, config),
    options.session,
    options.trackerOptions,
  );

  return {
    route,
    provider,
    compactor: buildCompactor(kind, config.model),
    ...(options.selection.thinking.level
      ? { thinkingEffort: options.selection.thinking.level }
      : {}),
  };
}

function buildCompactor(kind: ProviderKind, model: string): Compactor {
  const protocol = kind === "openai" ? "openai" : kind;
  const profile = resolveProviderProfile(protocol, model);
  const budget = createContextBudget(profile);
  return new Compactor({
    maxChars: estimateTokenBudgetAsChars(budget.inputBudgetTokens),
    retainLastMsgs: 6,
  });
}

function trackingRoute(kind: ProviderKind, config: ProviderConfig): BillingRoute | string {
  const price = config.capabilities?.price;
  if (!config.capabilities) return config.model;
  return {
    provider: kind,
    model: config.model,
    baseUrl: config.baseURL,
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
