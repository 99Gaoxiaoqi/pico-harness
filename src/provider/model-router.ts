import type { ProviderConfig } from "./config.js";
import type { ProviderKind } from "./factory.js";
import {
  resolveModelRouteCapabilities,
  type ModelCapabilityConfig,
  type ModelRouteCapabilities,
} from "./model-capabilities.js";
import type { ReasoningLevel } from "./reasoning-capability.js";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 3_000;

export interface ModelProviderConfig {
  protocol: ProviderKind;
  baseURL: string;
  apiKeyEnv: string;
  auth?: "api-key" | "none";
  models: readonly string[];
  discoverModels: boolean;
  /** Per-model metadata; absent on legacy configs and discovery-only entries. */
  modelCapabilities?: Readonly<Record<string, ModelCapabilityConfig>>;
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
  source: "config" | "discovered" | "legacy";
  capabilities: ModelRouteCapabilities;
}

export interface LoadModelRouterOptions {
  config: ModelRoutingConfig;
  env?: Readonly<Record<string, string | undefined>>;
  /** @deprecated Retained for host-call compatibility; bare legacy routes are no longer built. */
  legacyProvider: ProviderKind;
  /** @deprecated Retained for host-call compatibility; bare legacy routes are no longer built. */
  legacyModel: string;
  /** @deprecated Retained for host-call compatibility; bare legacy routes are no longer built. */
  legacyModelExplicit?: boolean;
  fetch?: typeof fetch;
  discoveryTimeoutMs?: number;
  /**
   * Host-resolved secrets. Values stay process-local and are never projected into routes,
   * session settings, diagnostics, or persisted configuration.
   */
  resolvedSecrets?: ResolvedModelSecrets;
}

export interface ResolvedModelSecrets {
  /** Provider-level credentials, used by user providers and model discovery. */
  readonly providers?: Readonly<Record<string, string>>;
  /** Provider-scoped rotation candidates resolved only from that user's declared apiKeyEnv. */
  readonly providerPools?: Readonly<Record<string, readonly string[]>>;
  /** Route-level credentials, used by strict legacy workspace credential references. */
  readonly routes?: Readonly<Record<string, string>>;
}

interface ProviderSource {
  id: string;
  config: ModelProviderConfig;
  explicitModels: boolean;
}

export class ModelRouter {
  readonly defaultRouteId?: string;
  private readonly byId: ReadonlyMap<string, ModelRoute>;
  private readonly providerSecrets: ReadonlyMap<string, string>;
  private readonly providerPools: ReadonlyMap<string, readonly string[]>;
  private readonly routeSecrets: ReadonlyMap<string, string>;

  constructor(
    routes: readonly ModelRoute[],
    private readonly env: Readonly<Record<string, string | undefined>>,
    defaultRouteId?: string,
    resolvedSecrets: ResolvedModelSecrets = {},
  ) {
    this.routes = Object.freeze(routes.map((route) => Object.freeze({ ...route })));
    this.byId = new Map(this.routes.map((route) => [route.id, route]));
    this.defaultRouteId = defaultRouteId;
    this.providerSecrets = secretMap(resolvedSecrets.providers);
    this.providerPools = secretListMap(resolvedSecrets.providerPools);
    this.routeSecrets = secretMap(resolvedSecrets.routes);
  }

  readonly routes: readonly ModelRoute[];

  resolve(query: string | undefined): ModelRoute | undefined {
    const normalized = query?.trim();
    if (normalized) {
      const exact = this.byId.get(normalized);
      if (exact) return exact;

      const byModel = this.routes.filter((route) => route.model === normalized);
      if (byModel.length === 1) return byModel[0];
      return undefined;
    }

    if (this.defaultRouteId) {
      const configuredDefault = this.byId.get(this.defaultRouteId);
      if (configuredDefault) return configuredDefault;
    }
    return this.routes[0];
  }

  require(query: string | undefined): ModelRoute {
    if (this.routes.length === 0) {
      throw new Error(
        "没有可用模型路由。请在用户级 $PICO_HOME/config.json 配置 providers.*.models，或先使用 /provider import-env 导入环境变量配置。",
      );
    }
    const route = this.resolve(query);
    if (route) return route;

    const requested = query?.trim() || "(empty)";
    const available = this.routes.map((item) => item.id).join(", ") || "none";
    throw new Error(
      `模型 ${requested} 不在当前可用路由中。可用模型: ${available}。请使用 /model 选择，或检查用户级 $PICO_HOME/config.json 的 providers 配置。`,
    );
  }

  validate(query: string): { ok: true; route: ModelRoute } | { ok: false; message: string } {
    const route = this.resolveExact(query);
    if (!route) {
      const available = this.routes.map((item) => item.id).join(", ") || "none";
      return {
        ok: false,
        message: `模型 ${query.trim() || "(empty)"} 不可用。可用模型: ${available}。`,
      };
    }

    if (!route.baseURL) {
      return {
        ok: false,
        message: `模型路由 ${route.id} 缺少 baseURL。请检查用户级 $PICO_HOME/config.json。`,
      };
    }
    if (route.auth !== "none" && !this.readCredential(route)) {
      return {
        ok: false,
        message: `模型路由 ${route.id} 缺少凭证环境变量 ${route.apiKeyEnv}，且系统凭证库中无可用凭证。`,
      };
    }
    return { ok: true, route };
  }

  providerConfig(
    routeId: string | undefined,
    thinkingEffort?: ReasoningLevel,
  ): { provider: ProviderKind; config: ProviderConfig; route: ModelRoute } {
    const route = this.require(routeId);
    if (!route.baseURL) {
      throw new Error(`模型路由 ${route.id} 缺少 baseURL。请检查用户级 $PICO_HOME/config.json。`);
    }
    const apiKey = this.readCredential(route);
    if (route.auth !== "none" && !apiKey) {
      throw new Error(
        `模型路由 ${route.id} 缺少凭证环境变量 ${route.apiKeyEnv}，且系统凭证库中无可用凭证。`,
      );
    }
    return {
      provider: route.provider,
      config: {
        baseURL: route.baseURL,
        apiKey: apiKey ?? "",
        ...(route.auth ? { auth: route.auth } : {}),
        model: route.model,
        capabilities: route.capabilities,
        routeId: route.id,
        ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
      },
      route,
    };
  }

  /** Process-local credentials for the selected user route; never persist or log the result. */
  credentialCandidates(routeId: string | undefined): readonly string[] {
    const route = this.require(routeId);
    if (route.auth === "none") return Object.freeze([]);
    const routeSecret = this.routeSecrets.get(route.id);
    if (routeSecret) return Object.freeze([routeSecret]);

    const providerPool = this.providerPools.get(route.providerId);
    if (providerPool) return providerPool;

    const providerSecret = this.providerSecrets.get(route.providerId);
    if (providerSecret) return Object.freeze([providerSecret]);

    return Object.freeze(readApiKeys(this.env, route.apiKeyEnv));
  }

  private resolveExact(query: string): ModelRoute | undefined {
    const normalized = query.trim();
    const exact = this.byId.get(normalized);
    if (exact) return exact;
    const byModel = this.routes.filter((route) => route.model === normalized);
    return byModel.length === 1 ? byModel[0] : undefined;
  }

  private readCredential(route: ModelRoute): string | undefined {
    return this.credentialCandidates(route.id)[0];
  }
}

export async function loadModelRouter(options: LoadModelRouterOptions): Promise<ModelRouter> {
  const env = options.env ?? process.env;
  const providers = configuredProviders(options.config);

  const discovered = await Promise.all(
    providers.map((provider) => discoverProviderModels(provider, env, options)),
  );
  const routes = discovered.flatMap(({ provider, models, discoveredModels }) =>
    models.map<ModelRoute>((model) => ({
      id: `${provider.id}/${model}`,
      providerId: provider.id,
      provider: provider.config.protocol,
      model,
      baseURL: provider.config.baseURL,
      apiKeyEnv: provider.config.apiKeyEnv,
      ...(provider.config.auth ? { auth: provider.config.auth } : {}),
      capabilities: resolveModelRouteCapabilities(
        provider.config.protocol,
        model,
        provider.config.modelCapabilities?.[model],
        { baseURL: provider.config.baseURL },
      ),
      source: provider.explicitModels
        ? "config"
        : discoveredModels.has(model)
          ? "discovered"
          : "config",
    })),
  );

  const configuredDefault = options.config.model?.trim();
  return new ModelRouter(routes, env, configuredDefault, options.resolvedSecrets);
}

function configuredProviders(config: ModelRoutingConfig): ProviderSource[] {
  return Object.entries(config.providers).map(([id, provider]) => ({
    id,
    config: provider,
    explicitModels: provider.models.length > 0,
  }));
}

async function discoverProviderModels(
  provider: ProviderSource,
  env: Readonly<Record<string, string | undefined>>,
  options: LoadModelRouterOptions,
): Promise<{ provider: ProviderSource; models: string[]; discoveredModels: Set<string> }> {
  const configured = unique(provider.config.models);
  const apiKey =
    provider.config.auth === "none"
      ? undefined
      : (normalizedSecret(options.resolvedSecrets?.providers?.[provider.id]) ??
        readApiKey(env, provider.config.apiKeyEnv));
  if (
    !provider.config.discoverModels ||
    provider.config.protocol !== "openai" ||
    !provider.config.baseURL ||
    (provider.config.auth !== "none" && !apiKey)
  ) {
    return { provider, models: configured, discoveredModels: new Set() };
  }

  const discovered = await fetchModelIds(
    provider.config.baseURL,
    apiKey,
    options.fetch ?? fetch,
    options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
  );
  if (discovered === undefined) {
    return { provider, models: configured, discoveredModels: new Set() };
  }

  const discoveredSet = new Set(discovered);
  // Explicit models are the provider whitelist and remain authoritative. Discovery fills an
  // otherwise empty catalog; it never widens or removes an explicit allowlist.
  const models = provider.explicitModels ? configured : discovered;
  return { provider, models, discoveredModels: discoveredSet };
}

async function fetchModelIds(
  baseURL: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string[] | undefined> {
  try {
    const response = await fetchImpl(`${baseURL.replace(/\/+$/u, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as unknown;
    if (!isRecord(body) || !Array.isArray(body["data"])) return undefined;
    return unique(
      body["data"].flatMap((item) =>
        isRecord(item) && typeof item["id"] === "string" ? [item["id"]] : [],
      ),
    );
  } catch {
    return undefined;
  }
}

function readApiKey(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return readApiKeys(env, name)[0];
}

function readApiKeys(env: Readonly<Record<string, string | undefined>>, name: string): string[] {
  return unique(env[name]?.split(",") ?? []);
}

function secretMap(
  values: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, string> {
  return new Map(
    Object.entries(values ?? {}).flatMap(([id, value]) => {
      const secret = normalizedSecret(value);
      return id.trim() && secret ? [[id, secret] as const] : [];
    }),
  );
}

function secretListMap(
  values: Readonly<Record<string, readonly string[]>> | undefined,
): ReadonlyMap<string, readonly string[]> {
  return new Map(
    Object.entries(values ?? {}).flatMap(([id, candidates]) => {
      const secrets = unique(candidates);
      return id.trim() && secrets.length > 0 ? [[id, Object.freeze(secrets)] as const] : [];
    }),
  );
}

function normalizedSecret(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
