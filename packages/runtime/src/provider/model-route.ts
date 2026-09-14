import type { ProviderKind, ModelCapabilityConfig, ModelRouteCapabilities } from "@pico/core";
import { isOfficialEndpoint } from "../model-web-search.js";

export interface ModelProviderConfig {
  protocol: ProviderKind;
  /** Model-specific wire overrides; credentials and connection identity stay provider-scoped. */
  modelProtocols?: Readonly<Record<string, ProviderKind>>;
  baseURL: string;
  apiKeyEnv: string;
  auth?: "api-key" | "none";
  models: readonly string[];
  discoverModels: boolean;
  /** Optional per-model metadata; built-in defaults cover omitted and discovery-only entries. */
  modelCapabilities?: Readonly<Record<string, ModelCapabilityConfig>>;
}

/** A model override always wins; automatic migration is restricted to official DeepSeek V4. */
export function resolveModelProtocol(
  provider: Pick<ModelProviderConfig, "protocol" | "baseURL" | "modelProtocols">,
  model: string,
): ProviderKind {
  const explicit = provider.modelProtocols?.[model];
  if (explicit !== undefined) return explicit;
  if (
    provider.protocol === "openai" &&
    isOfficialEndpoint(provider.baseURL, "api.deepseek.com") &&
    /^deepseek-v4-(?:flash|pro)$/u.test(model)
  )
    return "responses";
  return provider.protocol;
}

export interface ModelRoutingConfig {
  model?: string;
  providers: Readonly<Record<string, ModelProviderConfig>>;
}

export interface ModelRoute {
  /** Stable user-facing identity, following OpenCode's providerID/modelID convention. */
  id: string;
  providerId: string;
  provider: ProviderKind;
  model: string;
  baseURL: string;
  /** Environment variable name only. Secret values never enter session settings or UI data. */
  apiKeyEnv: string;
  auth?: "api-key" | "none";
  source: "config" | "discovered";
  capabilities: ModelRouteCapabilities;
}
