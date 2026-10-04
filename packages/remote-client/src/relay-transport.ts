import { isJsonObject, utf8ByteLength } from "@pico/protocol/mobile";
import { RemoteProtocolError } from "@pico/protocol/remote";
import {
  RELAY_MAX_FRAME_BYTES,
  parseRelayEndpoint,
  type RemoteRelayEndpoint,
} from "@pico/protocol/relay";
import { createRelayClientSession, type RelayRandomBytes } from "./relay-crypto.js";
import type { RemoteSocket } from "./index.js";

export class RelayTransportError extends RemoteProtocolError {}
export interface RelayTransportOptions {
  relay: RemoteRelayEndpoint;
  randomBytes?: RelayRandomBytes;
  createWebSocket: (url: string, headers: Readonly<Record<string, string>>) => RemoteSocket;
  onFatal?: (error: RemoteProtocolError) => void;
}
export function secureRandomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues)
    throw new RemoteProtocolError(
      "RELAY_IDENTITY_ERROR",
      "当前环境缺少安全随机数，无法建立中继连接",
    );
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
type Pending = {
  resolve: (value: Response) => void;
  reject: (error: Error) => void;
  removeAbort: () => void;
};
const unavailable = (notSent = false) =>
  new RelayTransportError(
    "RELAY_UNAVAILABLE",
    "中继或电脑暂不可达，请恢复连接后同步状态",
    true,
    notSent ? "not_executed" : undefined,
  );
function allowedPath(path: string, method: string): boolean {
  return (
    (method === "GET" && ["/v1/capabilities", "/v1/workspaces"].includes(path)) ||
    (method === "POST" && ["/v1/rpc", "/v1/pairings"].includes(path)) ||
    (method === "DELETE" && path === "/v1/device") ||
    (method === "GET" && /^\/v1\/pairings\/[^/]+$/.test(path)) ||
    (method === "POST" && /^\/v1\/pairings\/[^/]+\/ack$/.test(path))
  );
}

/** One encrypted channel carries HTTP replies and the existing event protocol.
 * This adapter never retries a logical request. RemoteRuntimeClient owns recovery.
 */
export class RelayTransport {
  readonly endpoint: RemoteRelayEndpoint;
  readonly #options: RelayTransportOptions;
  #physical?: RemoteSocket;
  #session?: ReturnType<typeof createRelayClientSession>;
  #connection?: Promise<void>;
  #rejectConnection?: (error: RemoteProtocolError) => void;
  #ready = false;
  #closed = false;
  #fatal?: RemoteProtocolError;
  #generation = 0;
  #requestId = 0;
  #pending = new Map<string, Pending>();
  #events?: RemoteSocket;
  constructor(options: RelayTransportOptions) {
    this.endpoint = parseRelayEndpoint(options.relay);
    this.#options = options;
  }
  #send(message: unknown) {
    if (!this.#ready || !this.#session || this.#physical?.readyState !== 1) throw unavailable(true);
    const frame = JSON.stringify({
      version: 1,
      type: "data",
      payload: this.#session.send(message),
    });
    try {
      this.#physical.send(frame);
    } catch {
      const error = unavailable();
      this.#disconnect(error);
      throw error;
    }
  }
  #disconnect(error: RemoteProtocolError, fatal = false) {
    ++this.#generation;
    this.#ready = false;
    this.#connection = undefined;
    this.#rejectConnection?.(error);
    this.#rejectConnection = undefined;
    const physical = this.#physical;
    this.#physical = undefined;
    this.#session?.close();
    this.#session = undefined;
    if (fatal) {
      this.#fatal = error;
      this.#options.onFatal?.(error);
    }
    for (const request of this.#pending.values()) {
      request.removeAbort();
      request.reject(error);
    }
    this.#pending.clear();
    const events = this.#events;
    this.#events = undefined;
    if (events && events.readyState !== 3) {
      events.readyState = 3;
      events.onclose?.({ code: 1006 });
    }
    physical?.close();
  }
  async #connect(): Promise<void> {
    if (this.#fatal) throw this.#fatal;
    if (this.#closed) throw unavailable(true);
    if (this.#ready && this.#physical?.readyState === 1) return;
    if (this.#connection) return this.#connection;
    const generation = ++this.#generation;
    const session = createRelayClientSession(
      this.endpoint,
      this.#options.randomBytes ?? secureRandomBytes,
    );
    this.#session = session;
    const socket = this.#options.createWebSocket(
      this.endpoint.relayUrl.replace(/^https:/, "wss:") + "/v1/relay",
      {},
    );
    this.#physical = socket;
    let joined = false;
    this.#connection = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(unavailable(true)), 15_000);
      this.#rejectConnection = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      const fail = (error: RemoteProtocolError, fatal = false) => {
        clearTimeout(timer);
        if (generation !== this.#generation) return;
        reject(error);
        this.#disconnect(error, fatal);
      };
      socket.onopen = () => {
        if (generation !== this.#generation) return;
        socket.send(
          JSON.stringify({ version: 1, type: "join", gatewayId: this.endpoint.gatewayId }),
        );
      };
      socket.onmessage = (event) => {
        if (generation !== this.#generation) return;
        try {
          if (typeof event.data !== "string" || utf8ByteLength(event.data) > RELAY_MAX_FRAME_BYTES)
            throw new Error("中继帧无效或超出预算");
          const outer: unknown = JSON.parse(event.data);
          if (!isJsonObject(outer) || outer.version !== 1) throw new Error("中继协议无效");
          if (!joined && outer.type === "joined" && typeof outer.channelId === "string") {
            joined = true;
            socket.send(JSON.stringify({ version: 1, type: "data", payload: session.hello() }));
          } else if (joined && outer.type === "data" && typeof outer.payload === "string") {
            const result = session.receive(outer.payload);
            if ("ready" in result) {
              if (this.#ready) throw new Error("中继握手重复");
              this.#ready = true;
              clearTimeout(timer);
              this.#rejectConnection = undefined;
              resolve();
            } else this.#receive(result.message);
          } else if (outer.type === "error" || outer.type === "close") {
            fail(unavailable(!this.#ready));
          } else throw new Error("中继帧顺序无效");
        } catch {
          fail(
            new RelayTransportError(
              "RELAY_IDENTITY_ERROR",
              "电脑身份或加密通道校验失败，请核对原配对内容",
              false,
              this.#ready ? undefined : "not_executed",
            ),
            true,
          );
        }
      };
      socket.onerror = () => fail(unavailable(!this.#ready));
      socket.onclose = () => fail(unavailable(!this.#ready));
    });
    try {
      await this.#connection;
    } finally {
      if (generation === this.#generation) this.#connection = undefined;
    }
  }
  #receive(message: unknown) {
    if (!this.#ready || !isJsonObject(message)) throw new Error("加密响应无效");
    if (message.kind === "response") {
      if (
        typeof message.id !== "string" ||
        !Number.isSafeInteger(message.status) ||
        Number(message.status) < 200 ||
        Number(message.status) > 599 ||
        !("body" in message)
      )
        throw new Error("加密请求响应无效");
      const pending = this.#pending.get(message.id);
      if (!pending) return; // Aborted reads may have a late response.
      this.#pending.delete(message.id);
      pending.removeAbort();
      const text = JSON.stringify(message.body);
      pending.resolve({
        ok: Number(message.status) < 300,
        status: Number(message.status),
        url: this.endpoint.relayUrl,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => text,
      } as Response);
    } else if (message.kind === "event") {
      const events = this.#events;
      if (events?.readyState === 1) events.onmessage?.({ data: JSON.stringify(message.value) });
    } else throw new Error("加密通道消息类型无效");
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    if (
      url.origin !== this.endpoint.relayUrl ||
      url.search ||
      url.hash ||
      !allowedPath(url.pathname, method)
    )
      throw new RemoteProtocolError(
        "INVALID_ENDPOINT",
        "中继只允许远程公开接口",
        false,
        "not_executed",
      );
    if (init?.signal?.aborted) throw unavailable(true);
    await this.#connect();
    if (init?.signal?.aborted) throw unavailable(true);
    const headers = new Headers(init?.headers);
    const authorization = headers.get("Authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const id = `relay-${++this.#requestId}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return new Promise<Response>((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(id);
        init?.signal?.removeEventListener("abort", abort);
        reject(new RelayTransportError("REQUEST_TIMEOUT", "请求已取消，请先同步电脑状态", true));
      };
      const removeAbort = () => init?.signal?.removeEventListener("abort", abort);
      this.#pending.set(id, { resolve, reject, removeAbort });
      init?.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.#send({
          kind: "request",
          id,
          method,
          path: url.pathname,
          ...(token ? { token } : {}),
          ...(body !== undefined ? { body } : {}),
        });
      } catch (error) {
        this.#pending.delete(id);
        removeAbort();
        reject(error);
      }
    });
  };
  readonly createWebSocket = (
    url: string,
    headers: Readonly<Record<string, string>>,
  ): RemoteSocket => {
    if (url !== this.endpoint.relayUrl.replace(/^https:/, "wss:") + "/v1/events")
      throw new RemoteProtocolError("INVALID_ENDPOINT", "中继事件地址无效");
    this.#events?.close();
    const socket: RemoteSocket = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: (data) => {
        if (socket.readyState !== 1) throw unavailable(true);
        this.#send({ kind: "events.send", value: JSON.parse(data) });
      },
      close: (code = 1000) => {
        if (socket.readyState === 3) return;
        socket.readyState = 3;
        if (this.#events === socket) {
          this.#events = undefined;
          if (this.#ready) {
            try {
              this.#send({ kind: "events.close" });
            } catch {
              /* Already disconnected. */
            }
          }
        }
        socket.onclose?.({ code });
      },
    };
    this.#events = socket;
    void this.#connect()
      .then(() => {
        if (this.#events !== socket || socket.readyState !== 0) return;
        socket.readyState = 1;
        socket.onopen?.({});
        const auth = headers.Authorization;
        this.#send({
          kind: "events.open",
          token: auth?.startsWith("Bearer ") ? auth.slice(7) : undefined,
        });
      })
      .catch(() => {
        if (this.#events !== socket || socket.readyState === 3) return;
        socket.onerror?.({});
        socket.close(1006);
      });
    return socket;
  };
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#disconnect(unavailable());
  }
}
