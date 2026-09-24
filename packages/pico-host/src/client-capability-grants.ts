import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

/** Changes on any mode or boundary transition, including equal-looking boundary profiles. */
export function clientCapabilityAuthorityEpoch(input: {
  readonly boundary: unknown;
  readonly permissionMode: string;
  readonly collaborationMode: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
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

/** In-memory implementation for callers that intentionally do not persist approvals. */
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
  readonly workspaceRoot: string;
  readonly authorityEpoch: string;
  keys: Set<string>;
  revoked: boolean;
}

/** Durable, workspace-scoped grants. A changed authority epoch never reuses old approvals. */
export class DurableClientCapabilityGrants {
  private readonly sessions = new Map<string, DurableSession>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly revisions = new Map<string, number>();

  constructor(
    private readonly publish: (path: string, contents: string) => Promise<void> = publishGrantFile,
  ) {}

  async bindSession(
    sessionId: string,
    workspaceRoot: string,
    authorityEpoch: string,
  ): Promise<void> {
    if (!sessionId.trim() || !workspaceRoot || !authorityEpoch) {
      throw new Error("客户端能力授权缺少可信 Session 身份");
    }
    const filePath = this.filePath(sessionId, workspaceRoot);
    const identity = this.identity(sessionId, workspaceRoot);
    const revision = this.revisions.get(identity) ?? 0;
    const current = this.sessions.get(identity);
    if (current?.filePath === filePath && current.authorityEpoch === authorityEpoch) return;
    await this.writes.get(identity);
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
        if (Array.isArray(grants) && grants.every(isValidScopeKey)) {
          keys = new Set(grants);
        }
      }
    } catch {
      // Missing or corrupt grant state fails closed.
    }
    if ((this.revisions.get(identity) ?? 0) !== revision) {
      throw new Error("客户端能力授权在恢复期间已撤销");
    }
    this.sessions.set(identity, { filePath, workspaceRoot, authorityEpoch, keys, revoked: false });
  }

  allows(sessionId: string, scope: ClientCapabilityScope, workspaceRoot: string): boolean {
    return (
      this.sessions.get(this.identity(sessionId, workspaceRoot))?.keys.has(scopeKey(scope)) ?? false
    );
  }

  async grant(
    sessionId: string,
    scope: ClientCapabilityScope,
    workspaceRoot: string,
  ): Promise<void> {
    const identity = this.identity(sessionId, workspaceRoot);
    const session = this.sessions.get(identity);
    if (!session) throw new Error("客户端能力授权尚未绑定 Session");
    const key = scopeKey(scope);
    await this.serialize(identity, async () => {
      if (session.revoked || this.sessions.get(identity) !== session) {
        throw new Error("客户端能力授权已撤销");
      }
      const staged = new Set(session.keys);
      staged.add(key);
      await this.publish(
        session.filePath,
        JSON.stringify({
          version: 1,
          sessionId,
          authorityEpoch: session.authorityEpoch,
          grants: [...staged].sort(),
        }),
      );
      if (session.revoked || this.sessions.get(identity) !== session) {
        throw new Error("客户端能力授权已撤销");
      }
      session.keys = staged;
    });
  }

  async revokeSession(sessionId: string, workspaceRoot?: string): Promise<void> {
    const identities = workspaceRoot
      ? [this.identity(sessionId, workspaceRoot)]
      : [...this.sessions.keys()].filter((key) => key.endsWith(`\0${sessionId}`));
    for (const identity of identities) {
      const session = this.sessions.get(identity);
      if (session) session.revoked = true;
      this.sessions.delete(identity);
      this.revisions.set(identity, (this.revisions.get(identity) ?? 0) + 1);
      const filePath =
        session?.filePath ?? (workspaceRoot ? this.filePath(sessionId, workspaceRoot) : undefined);
      if (filePath) await this.serialize(identity, async () => rm(filePath, { force: true }));
    }
  }

  private identity(sessionId: string, workspaceRoot: string): string {
    return `${workspaceRoot}\0${sessionId}`;
  }

  private filePath(sessionId: string, workspaceRoot: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return join(workspaceRoot, "client-capabilities", `${digest}.json`);
  }

  private async serialize(identity: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(identity) ?? Promise.resolve();
    const next = previous.then(operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.writes.set(identity, settled);
    try {
      await next;
    } finally {
      if (this.writes.get(identity) === settled) this.writes.delete(identity);
    }
  }
}

async function publishGrantFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export const globalDurableClientCapabilityGrants = new DurableClientCapabilityGrants();
export const globalClientCapabilityGrants = globalDurableClientCapabilityGrants;

function isValidScopeKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  if (value === "computer_use") return true;
  if (value.startsWith("browser_origin:")) {
    const origin = value.slice("browser_origin:".length);
    return browserHttpOrigin(origin) === origin;
  }
  if (value.startsWith("desktop_mcp:")) {
    try {
      const pair = JSON.parse(value.slice("desktop_mcp:".length)) as unknown;
      return (
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every((item) => typeof item === "string" && item.trim().length > 0) &&
        value === scopeKey({ kind: "desktop_mcp", server: pair[0], tool: pair[1] })
      );
    } catch {
      return false;
    }
  }
  return false;
}
