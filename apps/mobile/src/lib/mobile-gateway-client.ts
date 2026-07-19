import type {
  MobileConversationItem,
  MobileProject,
  MobileProjectId,
  MobileRun,
  MobileSendMessageBody,
  MobileSendMessageResult,
  MobileSession,
  MobileTranscript,
  SessionId,
} from "@pico/protocol";

const DEFAULT_TIMEOUT_MS = 10_000;
const SIMULATOR_HOSTS = new Set(["127.0.0.1", "localhost", "10.0.2.2"]);
const RUN_STATUSES = new Set<MobileRun["status"]>([
  "queued",
  "running",
  "pause_requested",
  "paused",
  "cancelling",
  "cancelled",
  "failed",
  "succeeded",
]);

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

  async getTranscript(
    projectId: MobileProjectId,
    sessionId: SessionId,
    before?: string,
  ): Promise<MobileTranscript> {
    const path = `/v1/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/transcript`;
    return this.get(
      before ? `${path}?before=${encodeURIComponent(before)}` : path,
      parseTranscript,
    );
  }

  async sendMessage(
    projectId: MobileProjectId,
    body: MobileSendMessageBody,
  ): Promise<MobileSendMessageResult> {
    return this.request(
      `/v1/projects/${encodeURIComponent(projectId)}/messages`,
      "POST",
      parseSendMessageResult,
      JSON.stringify(body),
    );
  }

  private async get<Result>(path: string, parse: (value: unknown) => Result): Promise<Result> {
    return this.request(path, "GET", parse);
  }

  private async request<Result>(
    path: string,
    method: "GET" | "POST",
    parse: (value: unknown) => Result,
    body?: string,
  ): Promise<Result> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.fetcher(`${this.origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.connection.token}`,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body } : {}),
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status === 401) throw new Error("Gateway Token 无效或已过期");
      if (response.status === 409) throw new Error("消息请求与已有幂等记录冲突");
      if (response.status === 413) throw new Error("消息内容超出 Gateway 限制");
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
  return value["sessions"].map(parseSession);
}

function parseTranscript(value: unknown): MobileTranscript {
  if (!isRecord(value) || !Array.isArray(value["items"]) || typeof value["revision"] !== "string") {
    throw new Error("Gateway 会话记录响应格式无效");
  }
  return {
    session: parseSession(value["session"]),
    items: value["items"].map(parseConversationItem),
    ...(value["activeRun"] !== undefined ? { activeRun: parseRun(value["activeRun"]) } : {}),
    ...(typeof value["nextBefore"] === "string" ? { nextBefore: value["nextBefore"] } : {}),
    revision: value["revision"],
  };
}

function parseSendMessageResult(value: unknown): MobileSendMessageResult {
  const dispositions = new Set(["started", "steered", "queued", "replaced"]);
  if (
    !isRecord(value) ||
    typeof value["disposition"] !== "string" ||
    !dispositions.has(value["disposition"])
  ) {
    throw new Error("Gateway 发送响应格式无效");
  }
  return {
    session: parseSession(value["session"]),
    ...(value["run"] !== undefined ? { run: parseRun(value["run"]) } : {}),
    disposition: value["disposition"] as MobileSendMessageResult["disposition"],
  };
}

function parseSession(value: unknown): MobileSession {
  if (
    !isRecord(value) ||
    typeof value["sessionId"] !== "string" ||
    typeof value["title"] !== "string" ||
    (value["status"] !== "active" && value["status"] !== "archived") ||
    typeof value["pinned"] !== "boolean" ||
    typeof value["createdAt"] !== "number" ||
    typeof value["updatedAt"] !== "number"
  ) {
    throw new Error("Gateway 会话响应格式无效");
  }
  return {
    sessionId: value["sessionId"],
    title: value["title"],
    status: value["status"],
    pinned: value["pinned"],
    createdAt: value["createdAt"],
    updatedAt: value["updatedAt"],
  };
}

function parseRun(value: unknown): MobileRun {
  if (
    !isRecord(value) ||
    typeof value["runId"] !== "string" ||
    typeof value["description"] !== "string" ||
    typeof value["status"] !== "string" ||
    !RUN_STATUSES.has(value["status"] as MobileRun["status"]) ||
    typeof value["startedAt"] !== "number" ||
    typeof value["updatedAt"] !== "number"
  ) {
    throw new Error("Gateway 运行响应格式无效");
  }
  return {
    runId: value["runId"],
    ...(typeof value["sessionId"] === "string" ? { sessionId: value["sessionId"] } : {}),
    description: value["description"],
    status: value["status"] as MobileRun["status"],
    startedAt: value["startedAt"],
    updatedAt: value["updatedAt"],
    ...(typeof value["finishedAt"] === "number" ? { finishedAt: value["finishedAt"] } : {}),
    ...(typeof value["error"] === "string" ? { error: value["error"] } : {}),
  };
}

function parseConversationItem(value: unknown): MobileConversationItem {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["kind"] !== "string" ||
    containsPrivateField(value)
  ) {
    throw new Error("Gateway 会话条目响应格式无效");
  }
  const kind = value["kind"];
  const contentKinds = new Set([
    "userMessage",
    "assistantMessage",
    "thinking",
    "systemNotice",
    "error",
  ]);
  const titledKinds = new Set(["plan", "approval", "prompt", "changes", "goal", "subagent"]);
  const valid =
    (contentKinds.has(kind) && typeof value["content"] === "string") ||
    (titledKinds.has(kind) && typeof value["title"] === "string") ||
    (kind === "skill" && typeof value["name"] === "string" && typeof value["args"] === "string") ||
    (kind === "tool" && typeof value["name"] === "string" && typeof value["status"] === "string") ||
    (kind === "runBoundary" && typeof value["status"] === "string");
  if (!valid) throw new Error("Gateway 会话条目响应格式无效");
  return value as unknown as MobileConversationItem;
}

function containsPrivateField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      key === "workspacePath" ||
      key === "sourcePath" ||
      key === "data" ||
      containsPrivateField(child),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
