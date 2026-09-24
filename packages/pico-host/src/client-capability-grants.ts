/**
 * Client-side capabilities are separate from the host process network boundary. A grant
 * belongs to one task session and never implies network access for Shell or File Worker.
 */
export type ClientCapabilityScope =
  | { readonly kind: "browser_origin"; readonly origin: string }
  | { readonly kind: "desktop_mcp"; readonly server: string; readonly tool: string }
  | { readonly kind: "computer_use" };

export function browserHttpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function browserNavigationOrigin(address: string): string | undefined {
  const trimmed = address.trim();
  if (!trimmed) return undefined;
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  return browserHttpOrigin(candidate);
}

function scopeKey(scope: ClientCapabilityScope): string {
  switch (scope.kind) {
    case "browser_origin": {
      const origin = browserHttpOrigin(scope.origin);
      if (!origin || origin !== scope.origin) throw new Error("浏览器授权必须是 HTTP/HTTPS origin");
      return `browser_origin:${origin}`;
    }
    case "desktop_mcp":
      if (!scope.server.trim() || !scope.tool.trim()) throw new Error("Desktop MCP 授权范围无效");
      return `desktop_mcp:${JSON.stringify([scope.server, scope.tool])}`;
    case "computer_use":
      return "computer_use";
  }
}

/** In-memory grants: approval must be repeated after process restart or mode rollback. */
export class ClientCapabilityGrants {
  private readonly grants = new Map<string, Set<string>>();

  allows(sessionId: string, scope: ClientCapabilityScope): boolean {
    return this.grants.get(sessionId)?.has(scopeKey(scope)) ?? false;
  }

  grant(sessionId: string, scope: ClientCapabilityScope): void {
    if (!sessionId.trim()) throw new Error("客户端能力授权缺少 Session");
    const keys = this.grants.get(sessionId) ?? new Set<string>();
    keys.add(scopeKey(scope));
    this.grants.set(sessionId, keys);
  }

  revokeSession(sessionId: string, scope?: ClientCapabilityScope): void {
    if (!scope) {
      this.grants.delete(sessionId);
      return;
    }
    const keys = this.grants.get(sessionId);
    if (!keys) return;
    keys.delete(scopeKey(scope));
    if (keys.size === 0) this.grants.delete(sessionId);
  }
}

export const globalClientCapabilityGrants = new ClientCapabilityGrants();
