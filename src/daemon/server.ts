import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import {
  createRuntimeAuthResult,
  createRuntimeError,
  encodeRuntimeFrame,
  type RuntimeNotification,
  type RuntimeNotificationPage,
  RuntimeFrameDecoder,
  RuntimeProtocolError,
  type RuntimeRequest,
  type RuntimeResponse,
  type JsonValue,
  type JsonObject,
  serializeRuntimeNotification,
  parseStrictRuntimeParams,
  isJsonObject,
} from "./protocol.js";
import {
  prepareLocalDaemonEndpoint,
  removeLocalDaemonEndpoint,
  secureLocalDaemonEndpoint,
  type LocalDaemonEndpoint,
} from "./endpoint.js";
import { createLocalIpcAuthTokenStore, type LocalIpcAuthTokenStore } from "./ipc-auth.js";
import type { LocalRuntimeService, RuntimeNotificationCursor } from "./service.js";
import { canonicalizeWorkspacePath } from "./workspace-registry.js";

export interface LocalRuntimeDaemonOptions {
  endpoint: LocalDaemonEndpoint;
  service: LocalRuntimeService;
  authTokenStore?: LocalIpcAuthTokenStore;
}

/** Versioned, current-user local IPC daemon. It intentionally exposes no network transport. */
export class LocalRuntimeDaemon {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private listening = false;
  private ownsEndpoint = false;
  private authToken?: string;
  private readonly authTokenStore: LocalIpcAuthTokenStore;

  constructor(private readonly options: LocalRuntimeDaemonOptions) {
    this.authTokenStore = options.authTokenStore ?? createLocalIpcAuthTokenStore(options.endpoint);
    this.server = createServer((socket) => this.handleConnection(socket));
    this.server.on("error", () => undefined);
  }

  async start(): Promise<void> {
    if (this.listening) return;
    await prepareLocalDaemonEndpoint(this.options.endpoint);
    this.authToken = await this.authTokenStore.rotate();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen({
        path: this.options.endpoint.address,
        exclusive: true,
        // Node does not expose a Windows SECURITY_DESCRIPTOR. Keep its broadening switches
        // explicitly disabled and require the application-layer auth handshake below.
        readableAll: false,
        writableAll: false,
      });
    });
    this.listening = true;
    this.ownsEndpoint = true;
    try {
      await secureLocalDaemonEndpoint(this.options.endpoint);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.listening) {
      for (const socket of this.sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => (error ? reject(error) : resolve()));
      });
      this.listening = false;
    }
    if (this.ownsEndpoint) {
      await removeLocalDaemonEndpoint(this.options.endpoint);
      this.ownsEndpoint = false;
    }
    this.authToken = undefined;
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    const decoder = new RuntimeFrameDecoder();
    let unsubscribe: (() => void) | undefined;
    let authenticated = false;
    let closed = false;
    const authenticationTimeout = setTimeout(() => socket.destroy(), 5_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(authenticationTimeout);
      this.sockets.delete(socket);
      unsubscribe?.();
      unsubscribe = undefined;
    };
    socket.on("close", close);
    socket.on("error", close);
    socket.on("data", (chunk: Buffer) => {
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch (_error) {
        socket.end();
        return;
      }
      for (const message of messages) {
        if (!authenticated) {
          if (message.kind !== "auth" || !this.verifyAuthToken(message.token)) {
            socket.end(encodeRuntimeFrame(createRuntimeAuthResult(false)));
            return;
          }
          authenticated = true;
          clearTimeout(authenticationTimeout);
          socket.write(encodeRuntimeFrame(createRuntimeAuthResult(true)));
          continue;
        }
        if (message.kind !== "request") {
          socket.write(
            encodeRuntimeFrame(
              createRuntimeError("unknown", "invalid_message", "只接受 request 消息"),
            ),
          );
          continue;
        }
        void this.handleRequest(socket, message, (dispose) => {
          unsubscribe?.();
          unsubscribe = dispose;
        });
      }
    });
  }

  private verifyAuthToken(candidate: string): boolean {
    if (!this.authToken) return false;
    const expected = Buffer.from(this.authToken, "utf8");
    const received = Buffer.from(candidate, "utf8");
    return expected.byteLength === received.byteLength && timingSafeEqual(expected, received);
  }

  private async handleRequest(
    socket: Socket,
    request: RuntimeRequest,
    setSubscription: (dispose: () => void) => void,
  ): Promise<void> {
    try {
      const validatedRequest = {
        ...request,
        params: parseStrictRuntimeParams(request.method, request.params),
      } as RuntimeRequest;
      if (validatedRequest.method === "events.replay") {
        const page = await this.options.service.replayEvents(readCursor(validatedRequest.params));
        this.write(socket, success(request, serializeReplayPage(page)));
        return;
      }
      if (validatedRequest.method === "events.subscribe") {
        const cursor = readCursor(validatedRequest.params);
        const workspacePath = await canonicalizeWorkspacePath(cursor.workspacePath);
        const scopedCursor = { ...cursor, workspacePath };
        const dispose = this.options.service.subscribe((event) => {
          if (event.scope.workspacePath === workspacePath) this.writeEvent(socket, event);
        });
        setSubscription(dispose);
        const page = await this.options.service.replayEvents(scopedCursor);
        this.write(
          socket,
          success(request, {
            subscribed: true,
            ...serializeReplayPage(page),
          }),
        );
        return;
      }
      const result = await this.options.service.handle(validatedRequest);
      this.write(socket, success(request, result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof RuntimeProtocolError ? error.code : "INTERNAL_ERROR";
      this.write(socket, createRuntimeError(request.requestId, code, message));
    }
  }

  private write(socket: Socket, message: RuntimeResponse): void {
    if (!socket.destroyed) socket.write(encodeRuntimeFrame(message));
  }

  private writeEvent(socket: Socket, event: RuntimeNotification): void {
    if (!socket.destroyed) {
      socket.write(encodeRuntimeFrame({ kind: "event", protocolVersion: 1, event }));
    }
  }
}

function success(request: RuntimeRequest, result: JsonValue): RuntimeResponse {
  return { kind: "response", protocolVersion: 1, requestId: request.requestId, ok: true, result };
}

function serializeReplayPage(page: RuntimeNotificationPage): JsonObject {
  return {
    events: page.events.map(serializeRuntimeNotification),
    hasMore: page.hasMore,
    ...(page.nextAfterEventId ? { nextAfterEventId: page.nextAfterEventId } : {}),
    ...(page.highWatermarkEventId ? { highWatermarkEventId: page.highWatermarkEventId } : {}),
  };
}

function readCursor(params: import("./protocol.js").JsonValue): RuntimeNotificationCursor {
  if (!isJsonObject(params)) {
    throw new RuntimeProtocolError("事件 cursor 必须是对象");
  }
  const afterEventId = params.afterEventId;
  if (afterEventId !== undefined && typeof afterEventId !== "string") {
    throw new RuntimeProtocolError("afterEventId 必须是字符串");
  }
  const workspacePath = params.workspacePath;
  if (typeof workspacePath !== "string" || !workspacePath) {
    throw new RuntimeProtocolError("INVALID_PARAMS", "workspacePath 必须是非空字符串");
  }
  const highWatermarkEventId = params.highWatermarkEventId;
  if (highWatermarkEventId !== undefined && typeof highWatermarkEventId !== "string") {
    throw new RuntimeProtocolError("INVALID_PARAMS", "highWatermarkEventId 必须是字符串");
  }
  const limit = params.limit;
  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
  ) {
    throw new RuntimeProtocolError("INVALID_PARAMS", "limit 必须是 1 到 10000 的整数");
  }
  return {
    ...(afterEventId === undefined ? {} : { afterEventId }),
    workspacePath,
    ...(highWatermarkEventId === undefined ? {} : { highWatermarkEventId }),
    ...(limit === undefined ? {} : { limit }),
  };
}
