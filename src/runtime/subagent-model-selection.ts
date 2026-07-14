import type { ModelRoute, ModelRouter } from "../provider/model-router.js";
import {
  coordinateReasoningLevel,
  type ReasoningLevelSelection,
} from "../provider/reasoning-capability.js";

export type SubagentModelSelectionSource = "ephemeral" | "profile" | "parent";

export interface ResolveSubagentModelSelectionOptions {
  router: ModelRouter;
  parentRouteId: string;
  ephemeralRouteId?: string | "inherit";
  profileRouteId?: string | "inherit";
  parentThinkingEffort?: string;
  ephemeralThinkingEffort?: string;
  profileThinkingEffort?: string;
  /** Claude Agent short model names mapped to Pico route ids or unique model ids. */
  modelAliases?: Readonly<Record<string, string>>;
  /** 后台 credentialRef 绑定单一路由时必须为 false。 */
  allowRouteOverride: boolean;
}

export interface ResolvedSubagentModelSelection {
  route: ModelRoute;
  source: SubagentModelSelectionSource;
  inheritsParentRoute: boolean;
  thinking: ReasoningLevelSelection;
}

/**
 * 解析子代理模型选择，不读取环境变量或凭证。
 * Provider 创建前必须先经过这里，确保后台任务不能借委派越过父路由授权。
 */
export function resolveSubagentModelSelection(
  options: ResolveSubagentModelSelectionOptions,
): ResolvedSubagentModelSelection {
  const parentRoute = options.router.require(options.parentRouteId);
  const requested = requestedRoute(options);
  const route = requested.routeId
    ? resolveCompatibleModelRoute(options.router, requested.routeId, options.modelAliases)
    : parentRoute;

  if (!options.allowRouteOverride && route.id !== parentRoute.id) {
    throw new Error(
      `当前运行边界只允许子代理继承父模型路由 ${parentRoute.id}，拒绝切换到 ${route.id}`,
    );
  }

  const requestedThinking =
    options.ephemeralThinkingEffort ??
    options.profileThinkingEffort ??
    options.parentThinkingEffort;
  const thinking = coordinateReasoningLevel(route.capabilities.reasoningProfile, requestedThinking);

  return {
    route,
    source: requested.source,
    inheritsParentRoute: route.id === parentRoute.id,
    thinking,
  };
}

const CLAUDE_MODEL_FAMILIES: ReadonlySet<string> = new Set(["haiku", "opus", "sonnet"]);

/**
 * Resolve Claude-compatible short names without introducing an Anthropic runtime dependency.
 * Explicit Pico aliases win; otherwise family names are accepted only for one unique route.
 */
export function resolveCompatibleModelRoute(
  router: ModelRouter,
  requested: string,
  aliases: Readonly<Record<string, string>> = {},
): ModelRoute {
  const normalized = requested.trim();
  const alias = aliases[normalized.toLowerCase()];
  if (alias) return router.require(alias);

  const direct = router.resolve(normalized);
  if (direct) return direct;
  if (!CLAUDE_MODEL_FAMILIES.has(normalized.toLowerCase())) return router.require(normalized);

  const family = normalized.toLowerCase();
  const matches = router.routes.filter((route) => {
    const searchable = `${route.id}\n${route.model}`.toLowerCase();
    return searchable.includes(family);
  });
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `Claude 模型别名 ${requested} 匹配多个 Pico 路由: ${matches.map((route) => route.id).join(", ")}。请在 .pico/config.json 的 compatibility.claude.modelAliases 中显式指定。`,
    );
  }
  return router.require(normalized);
}

function requestedRoute(options: ResolveSubagentModelSelectionOptions): {
  routeId?: string;
  source: SubagentModelSelectionSource;
} {
  if (options.ephemeralRouteId !== undefined) {
    return options.ephemeralRouteId === "inherit"
      ? { source: "ephemeral" }
      : { routeId: options.ephemeralRouteId, source: "ephemeral" };
  }
  if (options.profileRouteId !== undefined) {
    return options.profileRouteId === "inherit"
      ? { source: "profile" }
      : { routeId: options.profileRouteId, source: "profile" };
  }
  return { source: "parent" };
}
