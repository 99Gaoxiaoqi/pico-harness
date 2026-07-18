import type { ConfigSource, EffectiveConfigSnapshot } from "../input/effective-config.js";
import type { PicoUserConfig } from "../input/user-config-store.js";
import {
  createPlatformCredentialVault,
  CredentialNotFoundError,
  credentialRefForModelRoute,
  credentialRefForProvider,
  normalizeProviderEndpoint,
  type CredentialVault,
} from "./credential-vault.js";
import type { ProviderKind } from "./factory.js";
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

export type EffectiveCredentialState = "environment" | "keychain" | "missing" | "unsupported";

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
  readonly legacyProvider: ProviderKind;
  readonly legacyModel: string;
  readonly legacyModelExplicit?: boolean;
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
    env,
  );
  const vault = options.credentialVault ?? createPlatformCredentialVault();
  const resolved = await resolveSecrets(config, userConfig.providers, options.workDir, env, vault);
  const router = await loadModelRouter({
    config: {
      ...(config.defaultModelRouteId ? { model: config.defaultModelRouteId } : {}),
      providers: config.providers,
    },
    env,
    legacyProvider: options.legacyProvider,
    legacyModel: options.legacyModel,
    ...(options.legacyModelExplicit !== undefined
      ? { legacyModelExplicit: options.legacyModelExplicit }
      : {}),
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
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ config: EffectiveConfigSnapshot; userConfig: PicoUserConfig }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const config = await resolver.resolve({
      workDir: options.workDir,
      projectTrusted: options.projectTrusted,
      env,
      legacyProvider: options.legacyProvider,
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
  userProviders: Readonly<Record<string, ModelProviderConfig>>,
  workDir: string,
  env: Readonly<Record<string, string | undefined>>,
  vault: CredentialVault,
): Promise<{
  secrets: ResolvedModelSecrets;
  statuses: Record<string, EffectiveProviderCredentialStatus>;
}> {
  const providerSecrets: Record<string, string> = {};
  const routeSecrets: Record<string, string> = {};
  const statuses: Record<string, EffectiveProviderCredentialStatus> = {};

  await Promise.all(
    Object.entries(config.providers).map(async ([providerId, provider]) => {
      const configSource = config.sources[`providers.${providerId}`] ?? "user";
      const environmentSecret = readFirstSecret(env[provider.apiKeyEnv]);
      if (environmentSecret) {
        providerSecrets[providerId] = environmentSecret;
        statuses[providerId] = { providerId, configSource, state: "environment" };
        return;
      }

      const userProvider = userProviders[providerId];
      if (
        configSource === "user" ||
        (userProvider !== undefined && sameProviderAuthority(userProvider, provider))
      ) {
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
        if (configSource === "user") {
          statuses[providerId] = {
            providerId,
            configSource,
            state: unavailableState(vault),
          };
          return;
        }
      }

      if (configSource === "project-legacy") {
        let found = false;
        for (const model of provider.models) {
          const routeId = `${providerId}/${model}`;
          const secret = await resolveVaultSecret(
            vault,
            credentialRefForModelRoute(legacyCredentialRoute(routeId, provider, model), workDir),
          );
          if (!secret) continue;
          routeSecrets[routeId] = secret;
          found = true;
        }
        statuses[providerId] = {
          providerId,
          configSource,
          state: found ? "keychain" : unavailableState(vault),
        };
        return;
      }

      statuses[providerId] = { providerId, configSource, state: "missing" };
    }),
  );

  return {
    secrets: {
      providers: providerSecrets,
      routes: routeSecrets,
    },
    statuses,
  };
}

function legacyCredentialRoute(routeId: string, provider: ModelProviderConfig, model: string) {
  return {
    id: routeId,
    provider: provider.protocol,
    baseURL: provider.baseURL,
    model,
    apiKeyEnv: provider.apiKeyEnv,
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
  return value
    ?.split(",")
    .map((item) => item.trim())
    .find(Boolean);
}

function sameProviderAuthority(left: ModelProviderConfig, right: ModelProviderConfig): boolean {
  return (
    left.protocol === right.protocol &&
    normalizeProviderEndpoint(left.baseURL) === normalizeProviderEndpoint(right.baseURL)
  );
}
