import type { ConfigSource } from "../input/effective-config.js";
import type { ModelProviderConfig, ModelRoute } from "./model-router.js";
import {
  credentialRefForModelRoute,
  credentialRefForProvider,
  importModelRouteCredential,
  importProviderCredential,
  normalizeProviderEndpoint,
  type CredentialRef,
  type CredentialVault,
  type ProviderCredentialIdentity,
} from "./credential-vault.js";

export type AutomationCredentialTarget =
  | {
      readonly kind: "provider";
      readonly ref: CredentialRef;
      readonly provider: ProviderCredentialIdentity;
    }
  | {
      readonly kind: "model-route";
      readonly ref: CredentialRef;
    };

export function resolveAutomationCredentialTarget(input: {
  readonly route: ModelRoute;
  readonly workspacePath: string;
  readonly userProvider?: ModelProviderConfig;
  readonly configSource?: ConfigSource;
}): AutomationCredentialTarget {
  const { route, userProvider } = input;
  if (userProvider && sameProviderAuthority(userProvider, route)) {
    const provider = {
      providerId: route.providerId,
      protocol: route.provider,
      baseURL: route.baseURL,
    } satisfies ProviderCredentialIdentity;
    return {
      kind: "provider",
      provider,
      ref: credentialRefForProvider(provider),
    };
  }
  if (
    input.configSource === "environment" ||
    route.source === "legacy" ||
    route.providerId === "legacy"
  ) {
    throw new Error(
      "持久 Automation 不支持仅由当前进程环境提供的 Provider；请先使用 /provider import-env 导入共享 Provider。",
    );
  }
  return {
    kind: "model-route",
    ref: credentialRefForModelRoute(route, input.workspacePath),
  };
}

export async function importAutomationCredential(input: {
  readonly target: AutomationCredentialTarget;
  readonly route: ModelRoute;
  readonly workspacePath: string;
  readonly vault: CredentialVault;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<void> {
  if (input.target.kind === "model-route") {
    await importModelRouteCredential({
      route: input.route,
      workspacePath: input.workspacePath,
      vault: input.vault,
      env: input.env,
    });
    return;
  }
  const secret = readFirstSecret((input.env ?? process.env)[input.route.apiKeyEnv]);
  if (!secret) {
    throw new Error(`缺少凭证环境变量 ${input.route.apiKeyEnv}，无法导入。`);
  }
  await importProviderCredential({
    provider: input.target.provider,
    secret,
    vault: input.vault,
  });
}

function sameProviderAuthority(provider: ModelProviderConfig, route: ModelRoute): boolean {
  return (
    provider.protocol === route.provider &&
    normalizeProviderEndpoint(provider.baseURL) === normalizeProviderEndpoint(route.baseURL)
  );
}

function readFirstSecret(value: string | undefined): string | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .find(Boolean);
}
