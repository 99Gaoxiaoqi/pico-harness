import {
  routeRuntimeWebSearch as routeRuntimeWebSearchFromRuntime,
  type RuntimeWebSearchBindings,
  type RuntimeWebSearchSettings,
} from "@pico/runtime/web-search";
import type { ModelRouteCapabilities } from "@pico/core";
import { WebSearchTool } from "./web-tools.js";
import type { ToolRegistry } from "./tool-registry.js";

export {
  DEFAULT_WEB_SEARCH_SETTINGS,
  guardNativeSearchRequests,
  webSearchUnavailableReason,
} from "@pico/runtime/web-search";
export type { RuntimeWebSearchSettings } from "@pico/runtime/web-search";

/** Compatibility adapter for the concrete ToolRegistry and external search implementation. */
export function routeRuntimeWebSearch(
  registry: ToolRegistry,
  settings: RuntimeWebSearchSettings,
  capability: ModelRouteCapabilities["nativeWebSearch"],
  env: NodeJS.ProcessEnv,
): string | undefined {
  const bindings: RuntimeWebSearchBindings = {
    hasWebSearchTool: () => registry.getTool("web_search") !== undefined,
    disableWebSearchTool: () => registry.unregisterForHostPolicy("web_search"),
    enableExternalSearch: () => registry.register(new WebSearchTool(env)),
    enableNativeSearch: (adapter) =>
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
      }),
  };
  return routeRuntimeWebSearchFromRuntime(bindings, settings, capability, env);
}
