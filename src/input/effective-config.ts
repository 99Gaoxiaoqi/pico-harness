import { createHash } from "node:crypto";
import type { ProviderKind } from "../provider/factory.js";
import type { ModelProviderConfig } from "../provider/model-router.js";
import { loadPicoProjectConfig, type PicoProjectConfig } from "./pico-config.js";
import {
  UserConfigStore,
  type PicoInteractionMode,
  type PicoUserConfigDefaults,
} from "./user-config-store.js";

export type ConfigSource =
  | "user"
  | "project"
  | "project-legacy"
  | "environment"
  | "session"
  | "cli";

export interface EffectiveConfigDefaults {
  readonly modelRouteId?: string;
  readonly mode?: PicoInteractionMode;
  readonly thinkingEffort?: string;
}

export interface EffectiveConfigSnapshot {
  readonly defaults: EffectiveConfigDefaults;
  /** Convenience alias used by ModelRouter callers. */
  readonly defaultModelRouteId?: string;
  readonly providers: Readonly<Record<string, ModelProviderConfig>>;
  /** Keys use `defaults.*` and `providers.<id>` paths. */
  readonly sources: Readonly<Record<string, ConfigSource>>;
  readonly revisions: {
    readonly user: string;
    readonly project: string;
  };
}

export interface ResolveEffectiveConfigOptions {
  readonly workDir: string;
  /** Project config must not even be read until the host has established trust. */
  readonly projectTrusted: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly legacyProvider?: ProviderKind;
}

export interface EffectiveConfigResolverOptions {
  readonly userConfigStore?: UserConfigStore;
  readonly picoHome?: string;
}

export class ProviderIdConflictError extends Error {
  readonly code = "PROVIDER_ID_CONFLICT" as const;

  constructor(
    readonly providerId: string,
    readonly existingSource: ConfigSource,
    readonly incomingSource: ConfigSource,
  ) {
    super(
      `Provider ${providerId} 在 ${existingSource} 与 ${incomingSource} 中的 protocol 或 endpoint 不一致，已按安全策略拒绝合并`,
    );
    this.name = "ProviderIdConflictError";
  }
}

/** Resolves durable configuration. CLI and Session overrides remain the caller's responsibility. */
export class EffectiveConfigResolver {
  private readonly userConfigStore: UserConfigStore;

  constructor(options: EffectiveConfigResolverOptions = {}) {
    this.userConfigStore =
      options.userConfigStore ?? new UserConfigStore({ picoHome: options.picoHome });
  }

  async resolve(options: ResolveEffectiveConfigOptions): Promise<EffectiveConfigSnapshot> {
    const env = options.env ?? process.env;
    const user = await this.userConfigStore.read();
    const project = options.projectTrusted
      ? await loadPicoProjectConfig(options.workDir)
      : undefined;
    const environment = legacyEnvironmentProvider(env, options.legacyProvider ?? "openai");

    const providers: Record<string, ModelProviderConfig> = {};
    const providerSources: Record<string, ConfigSource> = {};
    if (environment !== undefined) {
      mergeProvider(providers, providerSources, "legacy", environment.config, "environment");
    }
    for (const [id, provider] of Object.entries(user.config.providers)) {
      mergeProvider(providers, providerSources, id, provider, "user");
    }
    if (project !== undefined) {
      for (const [id, provider] of Object.entries(project.providers)) {
        mergeProvider(providers, providerSources, id, provider, "project-legacy");
      }
    }

    const sources: Record<string, ConfigSource> = {};
    for (const [id, source] of Object.entries(providerSources)) {
      sources[`providers.${id}`] = source;
    }
    const defaults = resolveDefaults(user.config.defaults, project, environment, sources);
    const defaultModelRouteId = defaults.modelRouteId;
    const frozenProviders = Object.freeze(
      Object.fromEntries(
        Object.entries(providers).map(([id, provider]) => [id, freezeProvider(provider)]),
      ),
    );

    return Object.freeze({
      defaults: Object.freeze(defaults),
      ...(defaultModelRouteId !== undefined ? { defaultModelRouteId } : {}),
      providers: frozenProviders,
      sources: Object.freeze({ ...sources }),
      revisions: Object.freeze({
        user: user.revision,
        project: project === undefined ? emptyRevision() : projectRevision(project),
      }),
    });
  }
}

function resolveDefaults(
  userDefaults: PicoUserConfigDefaults | undefined,
  project: PicoProjectConfig | undefined,
  environment: LegacyEnvironmentProvider | undefined,
  sources: Record<string, ConfigSource>,
): EffectiveConfigDefaults {
  const defaults: {
    modelRouteId?: string;
    mode?: PicoInteractionMode;
    thinkingEffort?: string;
  } = {};
  if (userDefaults?.modelRouteId !== undefined) {
    defaults.modelRouteId = userDefaults.modelRouteId;
    sources["defaults.modelRouteId"] = "user";
  } else if (environment !== undefined) {
    defaults.modelRouteId = `legacy/${environment.defaultModel}`;
    sources["defaults.modelRouteId"] = "environment";
  }
  if (userDefaults?.mode !== undefined) {
    defaults.mode = userDefaults.mode;
    sources["defaults.mode"] = "user";
  }
  if (userDefaults?.thinkingEffort !== undefined) {
    defaults.thinkingEffort = userDefaults.thinkingEffort;
    sources["defaults.thinkingEffort"] = "user";
  }
  if (project?.model !== undefined) {
    defaults.modelRouteId = project.model;
    sources["defaults.modelRouteId"] = "project";
  }
  return defaults;
}

function mergeProvider(
  providers: Record<string, ModelProviderConfig>,
  sources: Record<string, ConfigSource>,
  id: string,
  incoming: ModelProviderConfig,
  incomingSource: ConfigSource,
): void {
  const existing = providers[id];
  const existingSource = sources[id];
  if (
    existing !== undefined &&
    existingSource !== undefined &&
    !sameProviderAuthority(existing, incoming)
  ) {
    throw new ProviderIdConflictError(id, existingSource, incomingSource);
  }
  providers[id] = incoming;
  sources[id] = incomingSource;
}

function sameProviderAuthority(left: ModelProviderConfig, right: ModelProviderConfig): boolean {
  return (
    left.protocol === right.protocol &&
    normalizeEndpoint(left.baseURL) === normalizeEndpoint(right.baseURL)
  );
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

interface LegacyEnvironmentProvider {
  readonly config: ModelProviderConfig;
  readonly defaultModel: string;
}

function legacyEnvironmentProvider(
  env: Readonly<Record<string, string | undefined>>,
  protocol: ProviderKind,
): LegacyEnvironmentProvider | undefined {
  const baseURL = env["LLM_BASE_URL"]?.trim();
  const defaultModel = env["LLM_MODEL"]?.trim();
  const multiKey = splitNonEmpty(env["LLM_API_KEYS"]);
  const singleKey = env["LLM_API_KEY"]?.trim();
  if (!baseURL || !defaultModel || (multiKey.length === 0 && !singleKey)) return undefined;

  const models = unique([defaultModel, ...splitNonEmpty(env["LLM_MODELS"])]);
  return {
    defaultModel,
    config: {
      protocol,
      baseURL,
      apiKeyEnv: multiKey.length > 0 ? "LLM_API_KEYS" : "LLM_API_KEY",
      models,
      discoverModels: protocol === "openai",
    },
  };
}

function splitNonEmpty(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function freezeProvider(provider: ModelProviderConfig): ModelProviderConfig {
  return Object.freeze({
    ...provider,
    models: Object.freeze([...provider.models]),
    ...(provider.modelCapabilities !== undefined
      ? { modelCapabilities: Object.freeze({ ...provider.modelCapabilities }) }
      : {}),
  });
}

function projectRevision(config: PicoProjectConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function emptyRevision(): string {
  return createHash("sha256").update("").digest("hex");
}
