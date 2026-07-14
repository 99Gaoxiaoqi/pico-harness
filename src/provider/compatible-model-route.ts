import type { ModelRoute, ModelRouter } from "./model-router.js";

const CLAUDE_MODEL_FAMILIES: ReadonlySet<string> = new Set(["haiku", "opus", "sonnet"]);

/**
 * Resolve Claude-compatible short names without introducing an Anthropic or Claude Code runtime.
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
