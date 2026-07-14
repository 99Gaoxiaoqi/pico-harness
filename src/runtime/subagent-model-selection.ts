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
    ? options.router.require(requested.routeId)
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
  const thinking = coordinateReasoningLevel(
    route.capabilities.reasoningProfile,
    requestedThinking,
  );

  return {
    route,
    source: requested.source,
    inheritsParentRoute: route.id === parentRoute.id,
    thinking,
  };
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
