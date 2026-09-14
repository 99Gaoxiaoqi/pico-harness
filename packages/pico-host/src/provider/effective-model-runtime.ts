import type { ConfigSource, EffectiveConfigSnapshot } from "../input/effective-config.js";
import type { PicoUserConfig, UserModelProviderConfig } from "../input/user-config-store.js";
import {
  createPlatformCredentialVault,
  CredentialNotFoundError,
  credentialRefForProvider,
  normalizeProviderEndpoint,
  type CredentialVault,
} from "./credential-vault.js";
import {
  loadModelRouter,
  type ModelProviderConfig,
  type ModelRouter,
  type ResolvedModelSecrets,
} from "./model-router.js";
import type {
  ModelRuntimeConfigResolver,
  ModelRuntimeUserConfigStore,
} from "./model-runtime-config-contract.js";

export type EffectiveCredentialState =
  | "none"
  | "config"
  | "environment"
  | "keychain"
  | "missing"
  | "unsupported";

export interface EffectiveProviderCredentialStatus {
  readonly providerId: string;
  readonly configSource: ConfigSource;
  readonly state: EffectiveCredentialState;
}

export interface EffectiveModelRuntime {
  readonly config: EffectiveConfigSnapshot;
  readonly router: ModelRouter;
  readonly credentials: Readonly<Record<string, EffectiveProviderCredentialStatus>>;
}

export interface LoadEffectiveModelRuntimeOptions {
  readonly workDir: string;
  readonly projectTrusted: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Read-only durable config dependency supplied by the host composition root. */
  readonly userConfigStore: ModelRuntimeUserConfigStore;
  /** Effective config resolver supplied by the host composition root. */
  readonly configResolver: ModelRuntimeConfigResolver;
  readonly credentialVault?: CredentialVault;
  readonly fetch?: typeof fetch;
  readonly discoveryTimeoutMs?: number;
}

/**
 * Single model-runtime assembly path shared by interactive TUI, line mode, compaction and
 * subagents. Durable configuration is resolved before secrets; plaintext credentials remain
 * process-local inside ModelRouter.
 */
export async function loadEffectiveModelRuntime(
  options: LoadEffectiveModelRuntimeOptions,
): Promise<EffectiveModelRuntime> {
  const env = options.env ?? process.env;
  const { config, userConfig } = await resolveStableConfiguration(
    options.configResolver,
    options.userConfigStore,
    options,
  );
  const vault = options.credentialVault ?? createPlatformCredentialVault();
  const resolved = await resolveSecrets(config, userConfig.providers, env, vault);
  const router = await loadModelRouter({
    config: {
      ...(config.defaultModelRouteId ? { model: config.defaultModelRouteId } : {}),
      providers: config.providers,
    },
    env,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.discoveryTimeoutMs !== undefined
      ? { discoveryTimeoutMs: options.discoveryTimeoutMs }
      : {}),
    resolvedSecrets: resolved.secrets,
  });

  return Object.freeze({
    config,
    router,
    credentials: Object.freeze({ ...resolved.statuses }),
  });
}

async function resolveStableConfiguration(
  resolver: ModelRuntimeConfigResolver,
  userConfigStore: ModelRuntimeUserConfigStore,
  options: LoadEffectiveModelRuntimeOptions,
): Promise<{ config: EffectiveConfigSnapshot; userConfig: PicoUserConfig }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const config = await resolver.resolve({
      workDir: options.workDir,
      projectTrusted: options.projectTrusted,
    });
    const user = await userConfigStore.read();
    if (user.revision === config.revisions.user) {
      return { config, userConfig: user.config };
    }
  }
  throw new Error("用户 Provider 配置在 Runtime 启动期间持续变化，请稍后重试。");
}

async function resolveSecrets(
  config: EffectiveConfigSnapshot,
  userProviders: Readonly<Record<string, UserModelProviderConfig>>,
  env: Readonly<Record<string, string | undefined>>,
  vault: CredentialVault,
): Promise<{
  secrets: ResolvedModelSecrets;
  statuses: Record<string, EffectiveProviderCredentialStatus>;
}> {
  const providerSecrets: Record<string, string> = {};
  const providerPools: Record<string, readonly string[]> = {};
  const statuses: Record<string, EffectiveProviderCredentialStatus> = {};

  await Promise.all(
    Object.entries(config.providers).map(async ([providerId, provider]) => {
      const configSource = config.sources[`providers.${providerId}`] ?? "user";
      if (provider.auth === "none") {
        statuses[providerId] = { providerId, configSource, state: "none" };
        return;
      }
      const userProvider = userProviders[providerId];
      const userProviderMatches =
        configSource === "user" ||
        (userProvider !== undefined && sameProviderAuthority(userProvider, provider));
      const configuredSecret = userProviderMatches
        ? normalizeConfiguredSecret(userProvider?.apiKey)
        : undefined;
      if (configuredSecret) {
        providerSecrets[providerId] = configuredSecret;
        statuses[providerId] = { providerId, configSource, state: "config" };
        return;
      }

      if (userProviderMatches) {
        const secret = await resolveVaultSecret(
          vault,
          credentialRefForProvider({
            providerId,
            protocol: provider.protocol,
            baseURL: provider.baseURL,
          }),
        );
        if (secret) {
          providerSecrets[providerId] = secret;
          statuses[providerId] = { providerId, configSource, state: "keychain" };
          return;
        }
      }

      // A configured user key or an existing keychain entry always wins. Environment credentials
      // remain available only through the apiKeyEnv declared by an effective Provider.
      const environmentSecrets = readSecrets(env[provider.apiKeyEnv]);
      const environmentSecret = environmentSecrets[0];
      if (environmentSecret) {
        providerSecrets[providerId] = environmentSecret;
        providerPools[providerId] = environmentSecrets;
        statuses[providerId] = { providerId, configSource, state: "environment" };
        return;
      }

      statuses[providerId] = {
        providerId,
        configSource,
        state: userProviderMatches ? unavailableState(vault) : "missing",
      };
    }),
  );

  return {
    secrets: {
      providers: providerSecrets,
      providerPools,
    },
    statuses,
  };
}

async function resolveVaultSecret(
  vault: CredentialVault,
  ref: Parameters<CredentialVault["resolve"]>[0],
): Promise<string | undefined> {
  if (!vault.capability().available) return undefined;
  try {
    return readFirstSecret(await vault.resolve(ref));
  } catch (error) {
    if (error instanceof CredentialNotFoundError) return undefined;
    throw error;
  }
}

function unavailableState(vault: CredentialVault): "missing" | "unsupported" {
  return vault.capability().available ? "missing" : "unsupported";
}

function readFirstSecret(value: string | undefined): string | undefined {
  return readSecrets(value)[0];
}

function readSecrets(value: string | undefined): string[] {
  return [...new Set((value?.split(",") ?? []).map((item) => item.trim()).filter(Boolean))];
}

function normalizeConfiguredSecret(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function sameProviderAuthority(left: ModelProviderConfig, right: ModelProviderConfig): boolean {
  return (
    left.protocol === right.protocol &&
    normalizeProviderEndpoint(left.baseURL) === normalizeProviderEndpoint(right.baseURL)
  );
}
