import type { MobileProjectId, MobileRealtimeEvent, MobileRun, SessionId } from "@pico/protocol";
import { AppState } from "react-native";
import { normalizeGatewayOrigin, type MobileGatewayConnection } from "./mobile-gateway-client";

/** 连接（TCP+WS 握手）超时：onclose 不触发时强制 close 进入重连。 */
const CONNECT_TIMEOUT_MS = 8_000;
/** 指数退避（封顶 10s）；切回前台会重置 attempts 立即重连。 */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;
/** 重连次数封顶（约 78s 后放弃，避免 gateway 真死时无限耗电/流量）。 */
const RECONNECT_MAX_ATTEMPTS = 10;
/** 客户端主动 close 的码：这些不视为服务端认证拒绝，应进入重连而非停止。 */
const CLIENT_CLOSE_CODES = new Set([1000, 1001, 1003, 4000]);

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
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
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
    let attempts = 0;
    let receivedReady = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let connectTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let currentSocket: MobileWebSocket | undefined;
    const url = `${this.origin}/v1/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/events`;

    const openSocket = (): void => {
      if (disposed) return;
      receivedReady = false;
      currentSocket?.close(1000, "reconnect");
      const socket = this.createWebSocket(url);
      currentSocket = socket;
      connectTimeoutTimer = setTimeout(() => {
        if (!disposed) socket.close(4000, "connect timeout");
      }, CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        if (disposed) return;
        clearTimeout(connectTimeoutTimer);
        connectTimeoutTimer = undefined;
        socket.send(JSON.stringify({ type: "authenticate", token: this.connection.token }));
      };
      socket.onmessage = (message) => {
        if (disposed) return;
        try {
          const event = parseMobileRealtimeEvent(String(message.data));
          if (event.type === "ready") {
            receivedReady = true;
            attempts = 0;
            handlers.onStateChange?.("connected");
          }
          handlers.onEvent(event);
        } catch (error) {
          handlers.onError?.(error instanceof Error ? error : new Error("Gateway 实时事件格式无效"));
          socket.close(1003, "Invalid realtime event");
        }
      };
      socket.onerror = () => {
        if (!disposed) handlers.onError?.(new Error("Gateway 实时连接失败"));
      };
      socket.onclose = (closeEvent) => {
        if (disposed) return;
        clearTimeout(connectTimeoutTimer);
        connectTimeoutTimer = undefined;
        // 认证/握手失败（连上却没收到 ready 即被服务端关闭）→ 停止重连，避免 token
        // 过期时反复重连形成请求风暴。客户端主动 close 的码不在此列，走重连。
        const isAuthFailure = !receivedReady && !CLIENT_CLOSE_CODES.has(closeEvent.code);
        if (isAuthFailure) {
          handlers.onError?.(new Error("Gateway Token 无效或已过期，请返回重新连接"));
          handlers.onStateChange?.("disconnected");
          return;
        }
        void scheduleReconnect();
      };
    };

    const scheduleReconnect = (): void => {
      if (disposed) return;
      if (attempts >= RECONNECT_MAX_ATTEMPTS) {
        handlers.onError?.(new Error("实时重连次数耗尽，请返回会话列表重进"));
        handlers.onStateChange?.("disconnected");
        return;
      }
      const delay = RECONNECT_BACKOFF_MS[Math.min(attempts, RECONNECT_BACKOFF_MS.length - 1)];
      attempts += 1;
      handlers.onStateChange?.("connecting");
      reconnectTimer = setTimeout(() => {
        if (disposed) return;
        openSocket();
      }, delay);
    };

    // 前台回归时若未连上，重置 backoff 立即重连（覆盖切后台/锁屏 socket 被系统挂起或杀死）。
    const appStateSub = AppState.addEventListener("change", (nextState) => {
      if (disposed || nextState !== "active" || receivedReady) return;
      attempts = 0;
      clearTimeout(reconnectTimer);
      openSocket();
    });

    handlers.onStateChange?.("connecting");
    openSocket();
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        clearTimeout(reconnectTimer);
        clearTimeout(connectTimeoutTimer);
        appStateSub.remove();
        currentSocket?.close(1000, "Screen closed");
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
