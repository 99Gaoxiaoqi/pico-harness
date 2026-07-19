import type { MobileProject, MobileProjectId, MobileSession } from "@pico/protocol";

const DEFAULT_TIMEOUT_MS = 10_000;
const SIMULATOR_HOSTS = new Set(["127.0.0.1", "localhost", "10.0.2.2"]);

export interface MobileGatewayConnection {
  readonly origin: string;
  readonly token: string;
}

export class MobileGatewayClient {
  private readonly origin: string;

  constructor(
    private readonly connection: MobileGatewayConnection,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.origin = normalizeGatewayOrigin(connection.origin);
    if (!connection.token.trim()) throw new Error("请输入 Gateway Token");
  }

  async listProjects(): Promise<readonly MobileProject[]> {
    return this.get("/v1/projects", parseProjects);
  }

  async listSessions(projectId: MobileProjectId): Promise<readonly MobileSession[]> {
    return this.get(`/v1/projects/${encodeURIComponent(projectId)}/sessions`, parseSessions);
  }

  private async get<Result>(path: string, parse: (value: unknown) => Result): Promise<Result> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.fetcher(`${this.origin}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.connection.token}` },
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status === 401) throw new Error("Gateway Token 无效或已过期");
      if (!response.ok) throw new Error(`Gateway 连接失败 (${response.status})`);
      return parse(await response.json());
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Gateway 连接超时", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function normalizeGatewayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Gateway 地址格式无效");
  }
  if (url.protocol !== "http:" || !SIMULATOR_HOSTS.has(url.hostname)) {
    throw new Error("Gateway 首版仅支持本机模拟器回环地址");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Gateway 地址只能包含协议、主机和端口");
  }
  return url.origin;
}

function parseProjects(value: unknown): readonly MobileProject[] {
  if (!isRecord(value) || !Array.isArray(value["projects"])) {
    throw new Error("Gateway 项目响应格式无效");
  }
  return value["projects"].map((project) => {
    if (
      !isRecord(project) ||
      typeof project["projectId"] !== "string" ||
      typeof project["name"] !== "string"
    ) {
      throw new Error("Gateway 项目响应格式无效");
    }
    return { projectId: project["projectId"], name: project["name"] };
  });
}

function parseSessions(value: unknown): readonly MobileSession[] {
  if (!isRecord(value) || !Array.isArray(value["sessions"])) {
    throw new Error("Gateway 会话响应格式无效");
  }
  return value["sessions"].map((session) => {
    if (
      !isRecord(session) ||
      typeof session["sessionId"] !== "string" ||
      typeof session["title"] !== "string" ||
      (session["status"] !== "active" && session["status"] !== "archived") ||
      typeof session["pinned"] !== "boolean" ||
      typeof session["createdAt"] !== "number" ||
      typeof session["updatedAt"] !== "number"
    ) {
      throw new Error("Gateway 会话响应格式无效");
    }
    return {
      sessionId: session["sessionId"],
      title: session["title"],
      status: session["status"],
      pinned: session["pinned"],
      createdAt: session["createdAt"],
      updatedAt: session["updatedAt"],
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
