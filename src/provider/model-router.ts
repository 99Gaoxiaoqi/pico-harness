import type { ProviderConfig } from "./config.js";
import type { ProviderKind } from "./factory.js";
import {
  resolveModelRouteCapabilities,
  type ModelCapabilityConfig,
  type ModelRouteCapabilities,
} from "./model-capabilities.js";
import type { ThinkingEffort } from "./thinking.js";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 3_000;

export interface ModelProviderConfig {
  protocol: ProviderKind;
  baseURL: string;
  apiKeyEnv: string;
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
  source: "config" | "discovered" | "legacy";
  capabilities: ModelRouteCapabilities;
}

export interface LoadModelRouterOptions {
  config: ModelRoutingConfig;
  env?: Readonly<Record<string, string | undefined>>;
  legacyProvider: ProviderKind;
  legacyModel: string;
  /** True only for an explicit --model value; protocol defaults are not trusted route catalog data. */
  legacyModelExplicit?: boolean;
  fetch?: typeof fetch;
  discoveryTimeoutMs?: number;
}

interface ProviderSource {
  id: string;
  config: ModelProviderConfig;
  source: "config" | "legacy";
  explicitModels: boolean;
}

export class ModelRouter {
  readonly defaultRouteId?: string;
  private readonly byId: ReadonlyMap<string, ModelRoute>;

  constructor(
    routes: readonly ModelRoute[],
    private readonly env: Readonly<Record<string, string | undefined>>,
    defaultRouteId?: string,
  ) {
    this.routes = Object.freeze(routes.map((route) => Object.freeze({ ...route })));
    this.byId = new Map(this.routes.map((route) => [route.id, route]));
    this.defaultRouteId = defaultRouteId;
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
        "没有可用模型路由。请在 .pico/config.json 配置 providers.*.models，或设置 LLM_BASE_URL、LLM_API_KEY[S] 和 LLM_MODEL。",
      );
    }
    const route = this.resolve(query);
    if (route) return route;

    const requested = query?.trim() || "(empty)";
    const available = this.routes.map((item) => item.id).join(", ") || "none";
    throw new Error(
      `模型 ${requested} 不在当前可用路由中。可用模型: ${available}。请使用 /model 选择，或检查 .pico/config.json 的 providers 配置。`,
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
        message: `模型路由 ${route.id} 缺少 baseURL。请检查 .pico/config.json 或 LLM_BASE_URL。`,
      };
    }
    if (!readApiKey(this.env, route.apiKeyEnv)) {
      return {
        ok: false,
        message: `模型路由 ${route.id} 缺少凭证环境变量 ${route.apiKeyEnv}。`,
      };
    }
    return { ok: true, route };
  }

  providerConfig(
    routeId: string | undefined,
    thinkingEffort?: ThinkingEffort,
  ): { provider: ProviderKind; config: ProviderConfig; route: ModelRoute } {
    const route = this.require(routeId);
    if (!route.baseURL) {
      throw new Error(
        `模型路由 ${route.id} 缺少 baseURL。请检查 .pico/config.json 或 LLM_BASE_URL。`,
      );
    }
    const apiKey = readApiKey(this.env, route.apiKeyEnv);
    if (!apiKey) {
      throw new Error(`模型路由 ${route.id} 缺少凭证环境变量 ${route.apiKeyEnv}。`);
    }
    return {
      provider: route.provider,
      config: {
        baseURL: route.baseURL,
        apiKey,
        model: route.model,
        capabilities: route.capabilities,
        routeId: route.id,
        ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
      },
      route,
    };
  }

  private resolveExact(query: string): ModelRoute | undefined {
    const normalized = query.trim();
    const exact = this.byId.get(normalized);
    if (exact) return exact;
    const byModel = this.routes.filter((route) => route.model === normalized);
    return byModel.length === 1 ? byModel[0] : undefined;
  }
}

export async function loadModelRouter(options: LoadModelRouterOptions): Promise<ModelRouter> {
  const env = options.env ?? process.env;
  const providers = configuredProviders(options.config);
  if (!providers.some((provider) => provider.id === "legacy")) {
    const legacy = legacyProvider(options, env);
    if (legacy) providers.push(legacy);
  }

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
      capabilities: resolveModelRouteCapabilities(
        provider.config.protocol,
        model,
        provider.config.modelCapabilities?.[model],
      ),
      source:
        provider.source === "legacy"
          ? "legacy"
          : provider.explicitModels
            ? "config"
            : discoveredModels.has(model)
              ? "discovered"
              : "config",
    })),
  );

  const configuredDefault = options.config.model?.trim();
  const legacyDefault = routes.find(
    (route) => route.provider === options.legacyProvider && route.model === options.legacyModel,
  )?.id;
  return new ModelRouter(routes, env, configuredDefault || legacyDefault);
}

function configuredProviders(config: ModelRoutingConfig): ProviderSource[] {
  return Object.entries(config.providers).map(([id, provider]) => ({
    id,
    config: provider,
    source: "config",
    explicitModels: provider.models.length > 0,
  }));
}

function legacyProvider(
  options: LoadModelRouterOptions,
  env: Readonly<Record<string, string | undefined>>,
): ProviderSource | undefined {
  const baseURL = env["LLM_BASE_URL"]?.trim() ?? "";
  const models = unique([
    ...(options.legacyModelExplicit ? [options.legacyModel] : []),
    env["LLM_MODEL"] ?? "",
    ...splitModels(env["LLM_MODELS"]),
  ]);
  const canDiscover =
    options.legacyProvider === "openai" &&
    baseURL.length > 0 &&
    readApiKey(env, env["LLM_API_KEYS"]?.trim() ? "LLM_API_KEYS" : "LLM_API_KEY") !== undefined;
  if (models.length === 0 && !canDiscover) return undefined;

  return {
    id: "legacy",
    source: "legacy",
    explicitModels: false,
    config: {
      protocol: options.legacyProvider,
      baseURL,
      apiKeyEnv: env["LLM_API_KEYS"]?.trim() ? "LLM_API_KEYS" : "LLM_API_KEY",
      models,
      discoverModels: options.legacyProvider === "openai",
    },
  };
}

async function discoverProviderModels(
  provider: ProviderSource,
  env: Readonly<Record<string, string | undefined>>,
  options: LoadModelRouterOptions,
): Promise<{ provider: ProviderSource; models: string[]; discoveredModels: Set<string> }> {
  const configured = unique(provider.config.models);
  if (
    !provider.config.discoverModels ||
    provider.config.protocol !== "openai" ||
    !provider.config.baseURL ||
    !readApiKey(env, provider.config.apiKeyEnv)
  ) {
    return { provider, models: configured, discoveredModels: new Set() };
  }

  const discovered = await fetchModelIds(
    provider.config.baseURL,
    readApiKey(env, provider.config.apiKeyEnv)!,
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
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string[] | undefined> {
  try {
    const response = await fetchImpl(`${baseURL.replace(/\/+$/u, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
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
  const value = env[name]?.trim();
  if (!value) return undefined;
  return value
    .split(",")
    .map((part) => part.trim())
    .find(Boolean);
}

function splitModels(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean)
    : [];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
