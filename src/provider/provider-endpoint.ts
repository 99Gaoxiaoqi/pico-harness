const SENSITIVE_QUERY_NAME =
  /(?:^key$|api.?key$|access.?key$|subscription.?key$|token|secret|passw|credential|signature|^sig$|^auth(?:orization)?$)/iu;

/**
 * Canonical cache-routing identity. Safe routing queries are significant; credential-like
 * parameters are omitted so cache keys remain stable across credential rotation and never derive
 * from keys.
 */
export function normalizePromptCacheEndpoint(baseURL: string): string {
  const parsed = parseProviderEndpoint(baseURL);
  for (const name of new Set(parsed.searchParams.keys())) {
    if (!SENSITIVE_QUERY_NAME.test(name)) continue;
    parsed.searchParams.delete(name);
  }
  parsed.hash = "";
  parsed.searchParams.sort();
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/u, "");
  return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
}

/** Append an API path before an existing query string and optionally merge protocol query fields. */
export function appendProviderEndpointPath(
  baseURL: string,
  path: string,
  query: Readonly<Record<string, string>> = {},
): string {
  const parsed = parseProviderEndpoint(baseURL);
  const basePath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/u, "");
  const suffix = path.replace(/^\/+/u, "");
  parsed.pathname = `${basePath}/${suffix}`;
  parsed.hash = "";
  for (const [name, value] of Object.entries(query)) parsed.searchParams.set(name, value);
  return parsed.toString();
}

function parseProviderEndpoint(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Provider Endpoint 不能为空");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Provider Endpoint 必须是有效 URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Provider Endpoint 仅支持 http 或 https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Provider Endpoint 不得包含用户名或密码");
  }
  return parsed;
}
