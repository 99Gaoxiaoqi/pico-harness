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

interface DurableSession {
  readonly filePath: string;
  readonly authorityEpoch: string;
  readonly keys: Set<string>;
}

/** Durable, workspace-scoped grants. A changed authority epoch never reuses old approvals. */
export class DurableClientCapabilityGrants {
  private readonly sessions = new Map<string, DurableSession>();
  private readonly writes = new Map<string, Promise<void>>();

  async bindSession(
    sessionId: string,
    workspaceRoot: string,
    authorityEpoch: string,
  ): Promise<void> {
    if (!sessionId.trim() || !workspaceRoot || !authorityEpoch) {
      throw new Error("客户端能力授权缺少可信 Session 身份");
    }
    const filePath = this.filePath(sessionId, workspaceRoot);
    const current = this.sessions.get(sessionId);
    if (current?.filePath === filePath && current.authorityEpoch === authorityEpoch) return;
    await this.writes.get(sessionId);
    let keys = new Set<string>();
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      if (
        raw &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        (raw as Record<string, unknown>)["version"] === 1 &&
        (raw as Record<string, unknown>)["sessionId"] === sessionId &&
        (raw as Record<string, unknown>)["authorityEpoch"] === authorityEpoch
      ) {
        const grants = (raw as Record<string, unknown>)["grants"];
        if (
          Array.isArray(grants) &&
          grants.every((item) => typeof item === "string" && item.length <= 512)
        ) {
          keys = new Set(grants);
        }
      }
    } catch {
      // Missing or corrupt grant state fails closed.
    }
    this.sessions.set(sessionId, { filePath, authorityEpoch, keys });
  }

  allows(sessionId: string, scope: ClientCapabilityScope): boolean {
    return this.sessions.get(sessionId)?.keys.has(scopeKey(scope)) ?? false;
  }

  async grant(sessionId: string, scope: ClientCapabilityScope): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("客户端能力授权尚未绑定 Session");
    session.keys.add(scopeKey(scope));
    await this.persist(sessionId, session);
  }

  async revokeSession(sessionId: string, workspaceRoot?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    await this.writes.get(sessionId);
    const filePath =
      session?.filePath ?? (workspaceRoot ? this.filePath(sessionId, workspaceRoot) : undefined);
    if (filePath) await rm(filePath, { force: true });
  }

  private filePath(sessionId: string, workspaceRoot: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return join(workspaceRoot, "client-capabilities", `${digest}.json`);
  }

  private async persist(sessionId: string, session: DurableSession): Promise<void> {
    const previous = this.writes.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(join(session.filePath, ".."), { recursive: true, mode: 0o700 });
      const temporary = `${session.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            version: 1,
            sessionId,
            authorityEpoch: session.authorityEpoch,
            grants: [...session.keys].sort(),
          }),
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporary, session.filePath);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.writes.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.writes.get(sessionId) === next) this.writes.delete(sessionId);
    }
  }
}

export const globalDurableClientCapabilityGrants = new DurableClientCapabilityGrants();
export const globalClientCapabilityGrants = globalDurableClientCapabilityGrants;
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
