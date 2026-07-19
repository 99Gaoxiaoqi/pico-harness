import type { MobileProjectId, MobileRealtimeEvent, MobileRun, SessionId } from "@pico/protocol";
import { normalizeGatewayOrigin, type MobileGatewayConnection } from "./mobile-gateway-client";

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

export type MobileRealtimeState = "connecting" | "connected" | "disconnected";

export interface MobileRealtimeHandlers {
  readonly onEvent: (event: MobileRealtimeEvent) => void;
  readonly onStateChange?: (state: MobileRealtimeState) => void;
  readonly onError?: (error: Error) => void;
}

export interface MobileRealtimeSubscription {
  dispose(): void;
}

export interface MobileWebSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type MobileWebSocketFactory = (url: string) => MobileWebSocket;

export class MobileGatewayRealtimeClient {
  private readonly origin: string;

  constructor(
    private readonly connection: MobileGatewayConnection,
    private readonly createWebSocket: MobileWebSocketFactory = (url) =>
      new WebSocket(url) as unknown as MobileWebSocket,
  ) {
    this.origin = normalizeGatewayOrigin(connection.origin).replace(/^http:/u, "ws:");
  }

  subscribe(
    projectId: MobileProjectId,
    sessionId: SessionId,
    handlers: MobileRealtimeHandlers,
  ): MobileRealtimeSubscription {
    let disposed = false;
    handlers.onStateChange?.("connecting");
    const socket = this.createWebSocket(
      `${this.origin}/v1/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/events`,
    );
    socket.onopen = () => {
      if (disposed) return;
      socket.send(JSON.stringify({ type: "authenticate", token: this.connection.token }));
    };
    socket.onmessage = (message) => {
      if (disposed) return;
      try {
        const event = parseMobileRealtimeEvent(String(message.data));
        if (event.type === "ready") handlers.onStateChange?.("connected");
        handlers.onEvent(event);
      } catch (error) {
        handlers.onError?.(error instanceof Error ? error : new Error("Gateway 实时事件格式无效"));
        socket.close(1003, "Invalid realtime event");
      }
    };
    socket.onerror = () => {
      if (!disposed) handlers.onError?.(new Error("Gateway 实时连接失败"));
    };
    socket.onclose = () => {
      if (!disposed) handlers.onStateChange?.("disconnected");
    };
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        socket.close(1000, "Screen closed");
      },
    };
  }
}

export function parseMobileRealtimeEvent(value: string): MobileRealtimeEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Gateway 实时事件不是合法 JSON");
  }
  if (!isRecord(parsed) || typeof parsed["type"] !== "string" || containsPrivateField(parsed)) {
    throw new Error("Gateway 实时事件格式无效");
  }
  switch (parsed["type"]) {
    case "ready":
      return { type: "ready", sessionId: requireString(parsed["sessionId"]) as SessionId };
    case "run":
      return { type: "run", run: parseRun(parsed["run"]) };
    case "live": {
      const item = parsed["item"];
      if (
        !isRecord(item) ||
        (item["kind"] !== "thinking" && item["kind"] !== "assistantMessage") ||
        (item["operation"] !== "append" &&
          item["operation"] !== "complete" &&
          item["operation"] !== "clear")
      ) {
        throw new Error("Gateway 实时事件格式无效");
      }
      return {
        type: "live",
        runId: requireString(parsed["runId"]),
        item: {
          kind: item["kind"],
          operation: item["operation"],
          ...(typeof item["streamId"] === "string" ? { streamId: item["streamId"] } : {}),
          ...(typeof item["turnId"] === "string" ? { turnId: item["turnId"] } : {}),
          ...(typeof item["delta"] === "string" ? { delta: item["delta"] } : {}),
          ...(item["truncated"] === true ? { truncated: true } : {}),
        },
      };
    }
    case "transcriptUpdated":
      return {
        type: "transcriptUpdated",
        sessionId: requireString(parsed["sessionId"]) as SessionId,
        ...(typeof parsed["revision"] === "string" ? { revision: parsed["revision"] } : {}),
      };
    case "resync":
      if (
        parsed["reason"] !== "overflow" &&
        parsed["reason"] !== "runtime-reconnect" &&
        parsed["reason"] !== "unknown"
      ) {
        throw new Error("Gateway 实时事件格式无效");
      }
      return { type: "resync", reason: parsed["reason"] };
    default:
      throw new Error("Gateway 实时事件类型不受支持");
  }
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
    throw new Error("Gateway 实时 Run 格式无效");
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

function requireString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Gateway 实时事件格式无效");
  return value;
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
