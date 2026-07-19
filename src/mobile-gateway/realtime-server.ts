import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import type {
  MobileProjectId,
  MobileRealtimeAuthenticate,
  MobileRealtimeEvent,
  SessionId,
} from "@pico/protocol";
import WebSocket, { WebSocketServer } from "ws";
import type { MobileGatewayRealtimeApi } from "./service.js";

const AUTHENTICATION_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 32;
const MAX_UNAUTHENTICATED_CONNECTIONS = 16;
const MAX_INCOMING_FRAME_BYTES = 4 * 1024;
const MAX_PENDING_EVENTS = 256;
const MAX_BUFFERED_SEND_BYTES = 512 * 1024;

interface MobileRealtimeServerOptions {
  readonly server: Server;
  readonly api: Partial<MobileGatewayRealtimeApi>;
  readonly token: string;
  readonly host: string;
}

export interface MobileRealtimeServerHandle {
  close(): Promise<void>;
}

export function attachMobileRealtimeServer(
  options: MobileRealtimeServerOptions,
): MobileRealtimeServerHandle {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    maxPayload: MAX_INCOMING_FRAME_BYTES,
    perMessageDeflate: false,
  });
  let unauthenticatedConnections = 0;

  const handleUpgrade = (
    request: import("node:http").IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    let target: MobileRealtimeTarget;
    try {
      target = parseRealtimeTarget(request.url, options.host);
    } catch {
      socket.destroy();
      return;
    }
    if (
      webSocketServer.clients.size >= MAX_CONNECTIONS ||
      unauthenticatedConnections >= MAX_UNAUTHENTICATED_CONNECTIONS
    ) {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      unauthenticatedConnections += 1;
      handleRealtimeConnection(webSocket, target, options, () => {
        unauthenticatedConnections = Math.max(0, unauthenticatedConnections - 1);
      });
    });
  };
  options.server.on("upgrade", handleUpgrade);

  return {
    async close() {
      options.server.off("upgrade", handleUpgrade);
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    },
  };
}

interface MobileRealtimeTarget {
  readonly projectId: MobileProjectId;
  readonly sessionId: SessionId;
}

function handleRealtimeConnection(
  webSocket: WebSocket,
  target: MobileRealtimeTarget,
  options: MobileRealtimeServerOptions,
  leaveUnauthenticated: () => void,
): void {
  let unauthenticated = true;
  let authenticationStarted = false;
  let closed = false;
  let subscription: { readonly dispose: () => void } | undefined;
  let pendingEvents: MobileRealtimeEvent[] = [];
  let pendingOverflow = false;
  const leaveAuthenticationPool = () => {
    if (!unauthenticated) return;
    unauthenticated = false;
    leaveUnauthenticated();
  };
  const authenticationTimer = setTimeout(() => {
    leaveAuthenticationPool();
    webSocket.close(1008, "Authentication timeout");
  }, AUTHENTICATION_TIMEOUT_MS);
  authenticationTimer.unref();

  webSocket.on("error", () => undefined);
  webSocket.on("close", () => {
    closed = true;
    clearTimeout(authenticationTimer);
    leaveAuthenticationPool();
    subscription?.dispose();
  });
  webSocket.on("message", (raw, isBinary) => {
    if (authenticationStarted || isBinary) {
      webSocket.close(1008, "Unexpected client message");
      return;
    }
    authenticationStarted = true;
    const authentication = parseAuthentication(raw.toString());
    if (!authentication || !tokensEqual(authentication.token, options.token)) {
      leaveAuthenticationPool();
      webSocket.close(1008, "Unauthorized");
      return;
    }
    clearTimeout(authenticationTimer);
    leaveAuthenticationPool();
    if (!options.api.subscribeEvents) {
      webSocket.close(1011, "Realtime unavailable");
      return;
    }

    void options.api
      .subscribeEvents(target.projectId, target.sessionId, (event) => {
        if (closed) return;
        if (!subscription) {
          if (pendingEvents.length >= MAX_PENDING_EVENTS) {
            pendingOverflow = true;
            pendingEvents = [];
            return;
          }
          pendingEvents.push(event);
          return;
        }
        sendEvent(webSocket, event);
      })
      .then((activeSubscription) => {
        if (closed) {
          activeSubscription.dispose();
          return;
        }
        subscription = activeSubscription;
        sendEvent(webSocket, { type: "ready", sessionId: target.sessionId });
        if (pendingOverflow) {
          sendEvent(webSocket, { type: "resync", reason: "overflow" });
        } else {
          for (const event of pendingEvents) sendEvent(webSocket, event);
        }
        pendingEvents = [];
      })
      .catch(() => webSocket.close(1011, "Subscription failed"));
  });
}

function parseRealtimeTarget(rawUrl: string | undefined, host: string): MobileRealtimeTarget {
  const url = new URL(rawUrl ?? "/", `http://${host}`);
  if (url.search) throw new Error("Realtime URL must not include a query");
  const match = /^\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/events$/u.exec(url.pathname);
  if (!match) throw new Error("Realtime URL was not found");
  return {
    projectId: decodePathSegment(match[1]) as MobileProjectId,
    sessionId: decodePathSegment(match[2]) as SessionId,
  };
}

function parseAuthentication(value: string): MobileRealtimeAuthenticate | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 2 ||
      (parsed as { type?: unknown }).type !== "authenticate" ||
      typeof (parsed as { token?: unknown }).token !== "string"
    ) {
      return undefined;
    }
    return parsed as MobileRealtimeAuthenticate;
  } catch {
    return undefined;
  }
}

function tokensEqual(receivedToken: string, expectedToken: string): boolean {
  const received = Buffer.from(receivedToken, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function sendEvent(webSocket: WebSocket, event: MobileRealtimeEvent): void {
  if (webSocket.readyState !== WebSocket.OPEN) return;
  if (webSocket.bufferedAmount > MAX_BUFFERED_SEND_BYTES) {
    webSocket.close(1013, "Client is too slow");
    return;
  }
  webSocket.send(JSON.stringify(event));
}

function decodePathSegment(value: string | undefined): string {
  const decoded = decodeURIComponent(value ?? "");
  if (!decoded || decoded.length > 256 || decoded.includes("/") || decoded.includes("\\")) {
    throw new Error("Invalid Mobile Gateway path segment");
  }
  return decoded;
}
