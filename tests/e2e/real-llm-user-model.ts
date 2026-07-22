import { EffectiveConfigResolver } from "../../src/input/effective-config.js";
import { UserConfigStore } from "../../src/input/user-config-store.js";
import { resolvePicoHome } from "../../src/paths/pico-paths.js";
import {
  loadEffectiveModelRuntime,
  type EffectiveModelRuntime,
} from "../../src/provider/effective-model-runtime.js";
import type { ProviderConfig } from "../../src/provider/config.js";
import type { ProviderKind } from "../../src/provider/factory.js";
import type { ModelRoute } from "../../src/provider/model-router.js";

export interface RealModel {
  readonly runtime: EffectiveModelRuntime;
  readonly provider: ProviderKind;
  /** Contains the process-local credential and must never be logged or persisted. */
  readonly config: ProviderConfig;
  readonly route: ModelRoute;
}

export interface LoadUserDefaultRealModelOptions {
  readonly picoHome?: string;
  readonly workDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

let configuredModelPromise: Promise<RealModel> | undefined;

export function configuredUserDefaultRealModel(): Promise<RealModel> {
  configuredModelPromise ??= loadUserDefaultRealModel();
  return configuredModelPromise;
}

export async function loadUserDefaultRealModel(
  options: LoadUserDefaultRealModelOptions = {},
): Promise<RealModel> {
  const picoHome = options.picoHome ?? resolvePicoHome();
  const env = options.env ?? process.env;
  const userConfigStore = new UserConfigStore({ picoHome });
  const userSnapshot = await userConfigStore.read();
  const routeId = userSnapshot.config.defaults?.modelRouteId;
  if (!routeId) {
    throw new Error("真实模型 E2E 要求用户配置提供 defaults.modelRouteId");
  }
  const separator = routeId.indexOf("/");
  const providerId = routeId.slice(0, separator);
  const model = routeId.slice(separator + 1);
  const userProvider = userSnapshot.config.providers[providerId];
  if (!userProvider) {
    throw new Error(`用户默认模型路由 ${routeId} 未引用用户 Provider`);
  }
  if (!userProvider.discoverModels && !userProvider.models.includes(model)) {
    throw new Error(`用户默认模型路由 ${routeId} 不在用户 Provider 模型列表中`);
  }

  const configResolver = new EffectiveConfigResolver({ userConfigStore });
  const runtime = await loadEffectiveModelRuntime({
    workDir: options.workDir ?? picoHome,
    // Real-model tests intentionally select the user default. Repository project.model must not
    // participate even when the business workspace itself is trusted by the behavior under test.
    projectTrusted: false,
    legacyProvider: "openai",
    legacyModel: "unused-real-model-e2e-legacy-route",
    legacyModelExplicit: false,
    env,
    userConfigStore,
    configResolver,
  });
  if (
    runtime.config.defaultModelRouteId !== routeId ||
    runtime.config.sources["defaults.modelRouteId"] !== "user" ||
    runtime.config.sources[`providers.${providerId}`] !== "user"
  ) {
    throw new Error("真实模型 E2E 未解析到用户级默认模型路由");
  }
  const configured = runtime.router.providerConfig(routeId);
  if (configured.route.id !== routeId || configured.route.providerId !== providerId) {
    throw new Error("真实模型 E2E Provider 配置与用户默认路由不一致");
  }
  return { runtime, ...configured };
}
