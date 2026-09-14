import type { ModelProviderConfig, ModelRoute } from "./model-route.js";
import {
  credentialRefForProvider,
  normalizeProviderEndpoint,
  type CredentialRef,
  type ProviderCredentialIdentity,
} from "@pico/core/provider-identity";

export interface AutomationCredentialTarget {
  readonly kind: "provider";
  readonly ref: CredentialRef;
  readonly provider: ProviderCredentialIdentity;
}

export function resolveAutomationCredentialTarget(input: {
  readonly route: ModelRoute;
  readonly userProvider?: ModelProviderConfig;
  readonly configSource?: "user" | "environment" | "session" | "cli";
}): AutomationCredentialTarget {
  const { route, userProvider } = input;
  if (userProvider && sameProviderAuthority(userProvider, route)) {
    const provider = {
      providerId: route.providerId,
      protocol: userProvider.protocol,
      baseURL: route.baseURL,
    } satisfies ProviderCredentialIdentity;
    return {
      kind: "provider",
      provider,
      ref: credentialRefForProvider(provider),
    };
  }
  const source = input.configSource === "environment" ? "当前进程环境" : "非用户配置";
  throw new Error(
    `持久 Automation 不支持由${source}提供的 Provider；请先使用 /provider import-env 导入共享 Provider。`,
  );
}

function sameProviderAuthority(provider: ModelProviderConfig, route: ModelRoute): boolean {
  return (
    (provider.modelProtocols?.[route.model] ?? provider.protocol) === route.provider &&
    normalizeProviderEndpoint(provider.baseURL) === normalizeProviderEndpoint(route.baseURL)
  );
}
