import { createServer, type Server, type Socket } from "node:net";
import {
  createRuntimeError,
  encodeRuntimeFrame,
  type RuntimeEvent,
  RuntimeFrameDecoder,
  RuntimeProtocolError,
  type RuntimeRequest,
  type RuntimeResponse,
  type JsonValue,
  serializeRuntimeEvent,
  isJsonObject,
} from "./protocol.js";
import {
  prepareLocalDaemonEndpoint,
  removeLocalDaemonEndpoint,
  secureLocalDaemonEndpoint,
  type LocalDaemonEndpoint,
} from "./endpoint.js";
import type { LocalRuntimeService, RuntimeEventCursor } from "./service.js";

export interface LocalRuntimeDaemonOptions {
  endpoint: LocalDaemonEndpoint;
  service: LocalRuntimeService;
}

/** Versioned, current-user local IPC daemon. It intentionally exposes no network transport. */
export class LocalRuntimeDaemon {
  private readonly server: Server;
  private listening = false;

  constructor(private readonly options: LocalRuntimeDaemonOptions) {
    this.server = createServer((socket) => this.handleConnection(socket));
    this.server.on("error", () => undefined);
  }

  async start(): Promise<void> {
    if (this.listening) return;
    await prepareLocalDaemonEndpoint(this.options.endpoint);
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
      this.server.listen(this.options.endpoint.address);
    });
    try {
      await secureLocalDaemonEndpoint(this.options.endpoint);
      this.listening = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.listening) {
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => (error ? reject(error) : resolve()));
      });
      this.listening = false;
    }
    await removeLocalDaemonEndpoint(this.options.endpoint);
  }

  private handleConnection(socket: Socket): void {
    const decoder = new RuntimeFrameDecoder();
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
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

  private async handleRequest(
    socket: Socket,
    request: RuntimeRequest,
    setSubscription: (dispose: () => void) => void,
  ): Promise<void> {
    try {
      if (request.method === "events.replay") {
        const events = await this.options.service.replayEvents(readCursor(request.params));
        this.write(socket, success(request, { events: events.map(serializeRuntimeEvent) }));
        return;
      }
      if (request.method === "events.subscribe") {
        const cursor = readCursor(request.params);
        const dispose = this.options.service.subscribe((event) => this.writeEvent(socket, event));
        setSubscription(dispose);
        const events = await this.options.service.replayEvents(cursor);
        this.write(
          socket,
          success(request, {
            subscribed: true,
            events: events.map(serializeRuntimeEvent),
          }),
        );
        return;
      }
      const result = await this.options.service.handle(request);
      this.write(socket, success(request, result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof RuntimeProtocolError ? "invalid_request" : "runtime_error";
      this.write(socket, createRuntimeError(request.requestId, code, message));
    }
  }

  private write(socket: Socket, message: RuntimeResponse): void {
    if (!socket.destroyed) socket.write(encodeRuntimeFrame(message));
  }

  private writeEvent(socket: Socket, event: RuntimeEvent): void {
    if (!socket.destroyed) {
      socket.write(encodeRuntimeFrame({ kind: "event", protocolVersion: 1, event }));
    }
  }
}

function success(request: RuntimeRequest, result: JsonValue): RuntimeResponse {
  return { kind: "response", protocolVersion: 1, requestId: request.requestId, ok: true, result };
}

function readCursor(params: import("./protocol.js").JsonValue): RuntimeEventCursor {
  if (!isJsonObject(params)) {
    throw new RuntimeProtocolError("事件 cursor 必须是对象");
  }
  const afterEventId = params.afterEventId;
  if (afterEventId !== undefined && typeof afterEventId !== "string") {
    throw new RuntimeProtocolError("afterEventId 必须是字符串");
  }
  const workspacePath = params.workspacePath;
  if (workspacePath !== undefined && typeof workspacePath !== "string") {
    throw new RuntimeProtocolError("workspacePath 必须是字符串");
  }
  return {
    ...(afterEventId === undefined ? {} : { afterEventId }),
    ...(workspacePath === undefined ? {} : { workspacePath }),
  };
}
