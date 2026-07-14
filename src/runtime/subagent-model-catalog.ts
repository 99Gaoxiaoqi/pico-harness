import type { ModelRoute, ModelRouter } from "../provider/model-router.js";

const DEFAULT_MAX_ROUTES = 64;

/**
 * 子代理模型目录是 ModelRouter 面向 Agent 工具层的脱敏、会话级只读投影。
 * 它只公开稳定选择标识与模型能力，不包含 endpoint、凭证引用或密钥状态。
 */
export interface SubagentModelCatalogRoute {
  readonly id: string;
  readonly model: string;
  readonly aliases: readonly string[];
  readonly reasoning: boolean | "unknown";
}

export interface SubagentModelCatalog {
  readonly routes: readonly SubagentModelCatalogRoute[];
  readonly parentRouteId: string;
  readonly allowRouteOverride: boolean;
  readonly totalSelectableRoutes: number;
  readonly truncated: boolean;
}

export interface BuildSubagentModelCatalogOptions {
  readonly router: ModelRouter;
  readonly parentRouteId: string;
  readonly aliases?: Readonly<Record<string, string>>;
  readonly allowRouteOverride: boolean;
  readonly maxRoutes?: number;
}

/**
 * 从完整 ModelRouter 构建一份当前会话不可变的脱敏目录。
 *
 * 目录只接受 `ModelRouter.validate` 已确认可执行的路由；工具层因此不需要也
 * 不应读取 Provider endpoint 或凭证配置。
 */
export function buildSubagentModelCatalog(
  options: BuildSubagentModelCatalogOptions,
): SubagentModelCatalog {
  const availableRoutes = validatedUniqueRoutes(options.router);
  const aliasesByRoute = reverseValidAliases(options.router, options.aliases ?? {});
  const selectableRoutes = options.allowRouteOverride
    ? availableRoutes
    : availableRoutes.filter((route) => route.id === options.parentRouteId);
  const sortedRoutes = selectableRoutes.toSorted((left, right) =>
    compareRoutes(left, right, options.parentRouteId, aliasesByRoute),
  );
  const maxRoutes = normalizeMaxRoutes(options.maxRoutes);
  const routes = sortedRoutes.slice(0, maxRoutes).map((route) =>
    Object.freeze<SubagentModelCatalogRoute>({
      id: route.id,
      model: route.model,
      aliases: Object.freeze([...(aliasesByRoute.get(route.id) ?? [])]),
      reasoning: route.capabilities.reasoning,
    }),
  );

  return Object.freeze({
    routes: Object.freeze(routes),
    parentRouteId: options.parentRouteId,
    allowRouteOverride: options.allowRouteOverride,
    totalSelectableRoutes: sortedRoutes.length,
    truncated: routes.length < sortedRoutes.length,
  });
}

function validatedUniqueRoutes(router: ModelRouter): ModelRoute[] {
  const byId = new Map<string, ModelRoute>();
  for (const candidate of router.routes) {
    const validation = router.validate(candidate.id);
    if (validation.ok && !byId.has(validation.route.id)) {
      byId.set(validation.route.id, validation.route);
    }
  }
  return [...byId.values()];
}

function reverseValidAliases(
  router: ModelRouter,
  aliases: Readonly<Record<string, string>>,
): ReadonlyMap<string, readonly string[]> {
  const reversed = new Map<string, Set<string>>();
  for (const [rawAlias, rawTarget] of Object.entries(aliases)) {
    const alias = rawAlias.trim().toLowerCase();
    const target = rawTarget.trim();
    if (!alias || !target) continue;

    const validation = router.validate(target);
    if (!validation.ok) continue;
    const routeAliases = reversed.get(validation.route.id) ?? new Set<string>();
    routeAliases.add(alias);
    reversed.set(validation.route.id, routeAliases);
  }

  return new Map(
    [...reversed].map(([routeId, routeAliases]) => [
      routeId,
      Object.freeze([...routeAliases].toSorted(compareText)),
    ]),
  );
}

function compareRoutes(
  left: ModelRoute,
  right: ModelRoute,
  parentRouteId: string,
  aliasesByRoute: ReadonlyMap<string, readonly string[]>,
): number {
  const priorityDifference =
    routePriority(left, parentRouteId, aliasesByRoute) -
    routePriority(right, parentRouteId, aliasesByRoute);
  return priorityDifference || compareText(left.id, right.id);
}

function routePriority(
  route: ModelRoute,
  parentRouteId: string,
  aliasesByRoute: ReadonlyMap<string, readonly string[]>,
): number {
  if (route.id === parentRouteId) return 0;
  if (aliasesByRoute.has(route.id)) return 1;
  if (route.source === "config" || route.source === "legacy") return 2;
  return 3;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeMaxRoutes(maxRoutes: number | undefined): number {
  if (maxRoutes === undefined) return DEFAULT_MAX_ROUTES;
  if (!Number.isFinite(maxRoutes) || maxRoutes < 0) {
    throw new RangeError("maxRoutes 必须是大于或等于 0 的有限数字");
  }
  return Math.floor(maxRoutes);
}
