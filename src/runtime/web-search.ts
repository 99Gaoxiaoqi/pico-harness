import type { LLMProvider, LLMProviderRequestOptions } from "../provider/interface.js";
import type { ModelRouteCapabilities } from "../provider/model-capabilities.js";
import type { ToolDefinition } from "../schema/message.js";
import type { ToolRegistry } from "../tools/registry-impl.js";
import { WebSearchTool } from "../tools/web.js";

export interface RuntimeWebSearchSettings {
  readonly enabled: boolean;
  readonly source: "model" | "external";
}

export const DEFAULT_WEB_SEARCH_SETTINGS: RuntimeWebSearchSettings = Object.freeze({
  enabled: false,
  source: "model",
});

/** Resolve only the selected source. A failed source must never broaden the tool surface. */
export function webSearchUnavailableReason(
  settings: RuntimeWebSearchSettings,
  capability: ModelRouteCapabilities["nativeWebSearch"],
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!settings.enabled) return "联网搜索已关闭。";
  if (settings.source === "external") {
    return env.SEARCH_API_BASE?.trim() && env.SEARCH_API_KEY?.trim()
      ? undefined
      : "外部搜索未配置 SEARCH_API_BASE / SEARCH_API_KEY。";
  }
  return capability?.available && capability.adapter
    ? undefined
    : (capability?.reason ?? "当前模型连接未确认支持原生搜索。");
}

/** Called after every host/child allowlist has pruned the registry. Never add a missing tool. */
export function routeRuntimeWebSearch(
  registry: ToolRegistry,
  settings: RuntimeWebSearchSettings,
  capability: ModelRouteCapabilities["nativeWebSearch"],
  env: NodeJS.ProcessEnv,
): string | undefined {
  const existed = registry.getTool("web_search") !== undefined;
  registry.unregisterForHostPolicy("web_search");
  if (!existed) return "当前任务的工具权限不包含 web_search。";
  const reason = webSearchUnavailableReason(settings, capability, env);
  if (reason) return reason;
  if (settings.source === "external") {
    registry.register(new WebSearchTool(env));
  } else {
    const adapter = capability!.adapter!;
    registry.register({
      name: () => "web_search",
      readOnly: true,
      permissionCategory: "web_read",
      nesting: "direct_only",
      definition: () => ({
        name: "web_search",
        description: "由当前模型供应商执行联网搜索，返回搜索证据和来源。",
        inputSchema: { type: "object", properties: {} },
        providerTool: { kind: adapter },
      }),
      execute: async () => {
        throw new Error("原生搜索只能由模型供应商执行，不能作为本地工具调用。");
      },
    });
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
