import type {
  LLMProvider,
  LLMProviderRequestOptions,
  ModelRouteCapabilities,
  ToolDefinition,
} from "@pico/core";

export interface RuntimeWebSearchSettings {
  readonly enabled: boolean;
  readonly source: "model" | "external";
}

export const DEFAULT_WEB_SEARCH_SETTINGS: RuntimeWebSearchSettings = Object.freeze({
  enabled: false,
  source: "model",
});

/** Tool-layer callbacks keep Runtime independent from a concrete ToolRegistry implementation. */
export interface RuntimeWebSearchBindings {
  hasWebSearchTool(): boolean;
  disableWebSearchTool(): void;
  enableExternalSearch(): void;
  enableNativeSearch(
    adapter: NonNullable<NonNullable<ModelRouteCapabilities["nativeWebSearch"]>["adapter"]>,
  ): void;
}

/** Resolve only the selected source. A failed source must never broaden the tool surface. */
export function webSearchUnavailableReason(
  settings: RuntimeWebSearchSettings,
  capability: ModelRouteCapabilities["nativeWebSearch"],
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (!settings.enabled) return "联网搜索已关闭。";
  if (settings.source === "external") {
    return env["SEARCH_API_BASE"]?.trim() && env["SEARCH_API_KEY"]?.trim()
      ? undefined
      : "外部搜索未配置 SEARCH_API_BASE / SEARCH_API_KEY。";
  }
  return capability?.available && capability.adapter
    ? undefined
    : (capability?.reason ?? "当前模型连接未确认支持原生搜索。");
}

/** Called after every host/child allowlist has pruned the registry. Never add a missing tool. */
export function routeRuntimeWebSearch(
  bindings: RuntimeWebSearchBindings,
  settings: RuntimeWebSearchSettings,
  capability: ModelRouteCapabilities["nativeWebSearch"],
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const existed = bindings.hasWebSearchTool();
  bindings.disableWebSearchTool();
  if (!existed) return "当前任务的工具权限不包含 web_search。";
  const reason = webSearchUnavailableReason(settings, capability, env);
  if (reason) return reason;
  if (settings.source === "external") {
    bindings.enableExternalSearch();
  } else {
    bindings.enableNativeSearch(capability!.adapter!);
  }
  return undefined;
}

/** Recheck live network authority on every step, including after a boundary expansion. */
export function guardNativeSearchRequests(
  provider: LLMProvider,
  networkAllowed: () => boolean,
): LLMProvider {
  const visible = (tools: ToolDefinition[], options?: LLMProviderRequestOptions) =>
    tools.filter(
      (tool) =>
        !tool.providerTool ||
        (options?.toolChoice !== "none" && !options?.purpose && networkAllowed()),
    );
  return {
    ...(provider.modelName !== undefined ? { modelName: provider.modelName } : {}),
    ...(provider.requestCapabilities ? { requestCapabilities: provider.requestCapabilities } : {}),
    ...(provider.isRetryableError
      ? { isRetryableError: (error: unknown) => provider.isRetryableError!(error) }
      : {}),
    generate: (messages, tools, options) =>
      provider.generate(messages, visible(tools, options), options),
    ...(provider.generateStream
      ? {
          generateStream: (messages, tools, onDelta, options) =>
            provider.generateStream!(messages, visible(tools, options), onDelta, options),
        }
      : {}),
  };
}
