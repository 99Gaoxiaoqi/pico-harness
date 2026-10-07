import {
  isRuntimeTerminalFrame,
  type RuntimeTerminalFrame,
  isJsonObject,
  parseRuntimeNotification,
  parseRuntimeResult,
  utf8ByteLength,
  type RuntimeNotification,
  type RuntimeResult,
  type RuntimeSessionSubscriptionFrame,
} from "@pico/protocol/mobile";
import {
  REMOTE_METHOD_SPECS,
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_PERMISSIONS,
  isRemoteMethod,
  parsePairingOffer,
  parseRemoteRequest,
  RemoteProtocolError,
  type RemoteMethod,
  type RemoteParams,
  type RemoteResult,
  type RemoteCapabilities,
  type RemoteWorkspace,
  type RemotePairingOffer,
  type RemotePairingSubmitted,
  type RemotePairingStatus,
  type RemotePairingSubmission,
  type RemoteServerMessage,
  type RemoteSecretEdits,
} from "@pico/protocol/remote";
import type { RemoteRelayEndpoint } from "@pico/protocol/relay";
import type { RelayRandomBytes } from "./relay-crypto.js";
import { RelayTransport, RelayTransportError } from "./relay-transport.js";
export { RemoteProtocolError } from "@pico/protocol/remote";
export type RemoteConnectionState =
  | "disconnected"
  | "connecting"
  | "syncing"
  | "connected"
  | "reconnecting"
  | "unauthorized"
  | "incompatible"
  | "error";
export interface RemoteSocket {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export interface RemoteClientOptions {
  publicUrl: string;
  deviceToken: string;
  gatewayId?: string;
  relay?: RemoteRelayEndpoint;
  randomBytes?: RelayRandomBytes;
  fetch?: typeof fetch;
  createWebSocket?: (url: string, headers: Readonly<Record<string, string>>) => RemoteSocket;
  onState?: (state: RemoteConnectionState, error?: RemoteProtocolError) => void;
  makeRequestId?: () => string;
}
export interface RemoteRequestOptions {
  workspaceId?: string;
  idempotencyKey?: string;
  secretEdits?: RemoteSecretEdits;
}
export type RemotePairingTransportOptions = Pick<
  RemoteClientOptions,
  "relay" | "randomBytes" | "createWebSocket"
>;
interface Subscription {
  id: string;
  workspaceId: string;
  lastEventId?: string;
  listener: (event: RuntimeNotification) => void;
  seen: Set<string>;
  pending: RuntimeNotification[];
  replayed: boolean;
  replayCycle: number;
  pendingBytes: number;
  resolve?: (replay: RuntimeResult<"events.subscribe">) => void;
  reject?: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}
let counter = 0;
function requestId(): string {
  return `remote-${Date.now().toString(36)}-${(++counter).toString(36)}-${Math.random().toString(36).slice(2)}`;
}
function origin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new RemoteProtocolError("INVALID_ENDPOINT", "连接地址必须是 HTTPS origin");
  return url.origin;
}
function protocolError(value: unknown, fallback = "请求失败"): RemoteProtocolError {
  if (isJsonObject(value) && typeof value.code === "string" && typeof value.message === "string")
    return new RemoteProtocolError(
      value.code,
      value.message,
      value.retryable === true,
      value.outcome === "unknown"
        ? "unknown"
        : value.outcome === "not_executed"
          ? "not_executed"
          : undefined,
    );
  return new ResponseValidationError("INVALID_RESPONSE", fallback);
}
// Keep transport provenance private: a server's retryable business error does not
// mean that either connection has stopped working.
class HttpTransportError extends RemoteProtocolError {}
// A request can execute before its reply becomes unreadable. Keep that failure
// separate from local validation and a valid server-side business rejection.
class ResponseValidationError extends RemoteProtocolError {}
function blockedState(error: RemoteProtocolError): "unauthorized" | "incompatible" | undefined {
  if (["UNAUTHORIZED", "INVALID_AUTH", "DEVICE_REVOKED"].includes(error.code))
    return "unauthorized";
  if (
    ["VERSION_MISMATCH", "GATEWAY_MISMATCH", "CERTIFICATE_ERROR", "RELAY_IDENTITY_ERROR"].includes(
      error.code,
    )
  )
    return "incompatible";
  return undefined;
}
function transportFailure(error: unknown, timedOut: boolean): RemoteProtocolError {
  if (timedOut)
    return new HttpTransportError("REQUEST_TIMEOUT", "请求超时，请确认电脑端状态", true);
  const record =
    error && typeof error === "object"
      ? (error as { code?: unknown; message?: unknown; cause?: unknown })
      : undefined;
  const cause =
    record?.cause && typeof record.cause === "object"
      ? (record.cause as { code?: unknown; message?: unknown })
      : undefined;
  const hint = [record?.code, record?.message, cause?.code, cause?.message]
    .filter((x) => typeof x === "string")
    .join(" ");
  if (/CERT_|ERR_TLS|certificate|self[- ]signed|SSL|NSURLErrorServerCertificate/i.test(hint))
    return new HttpTransportError(
      "CERTIFICATE_ERROR",
      "HTTPS 证书验证失败，请检查域名、证书链和有效期",
      false,
      "not_executed",
    );
  if (/ENOTFOUND|EAI_AGAIN|UnknownHostException|DNS|NSURLErrorCannotFindHost/i.test(hint))
    return new HttpTransportError(
      "DNS_ERROR",
      "公网域名解析失败，请检查电脑网关地址和 DNS",
      true,
      "not_executed",
    );
  return new HttpTransportError(
    "CONNECTION_FAILED",
    "公网连接失败，请检查入口、防火墙、DNS 和证书",
    true,
  );
}
async function jsonRequest(
  fetcher: typeof fetch,
  publicUrl: string,
  path: string,
  token?: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload && utf8ByteLength(payload) > REMOTE_MAX_FRAME_BYTES)
    throw new RemoteProtocolError("FRAME_TOO_LARGE", "请求超过远程预算");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetcher(origin(publicUrl) + path, {
      method,
      headers,
      body: payload,
      redirect: "error",
      signal: controller.signal,
    });
    if (response.url && new URL(response.url).origin !== origin(publicUrl))
      throw new ResponseValidationError("INVALID_RESPONSE", "服务器返回了其他地址");
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > REMOTE_MAX_FRAME_BYTES)
      throw new ResponseValidationError("FRAME_TOO_LARGE", "响应超过远程预算");
    const text = await response.text();
    if (utf8ByteLength(text) > REMOTE_MAX_FRAME_BYTES)
      throw new ResponseValidationError("FRAME_TOO_LARGE", "响应超过远程预算");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ResponseValidationError("INVALID_RESPONSE", "服务器响应不是有效 JSON");
    }
    if (!response.ok) {
      if (isJsonObject(value) && value.error) throw protocolError(value.error);
      if (response.status === 401)
        throw new RemoteProtocolError("UNAUTHORIZED", "设备授权已失效，请重新配对");
      if (response.status === 403) throw new RemoteProtocolError("FORBIDDEN", "当前设备未获授权");
      throw protocolError(value, "服务器无法完成请求");
    }
    return value;
  } catch (error) {
    if (error instanceof RemoteProtocolError) throw error;
    throw transportFailure(error, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}
function defaultSocket(url: string, headers: Readonly<Record<string, string>>): RemoteSocket {
  const Constructor = globalThis.WebSocket as unknown as new (
    url: string,
    protocols: undefined,
    options: { headers: Readonly<Record<string, string>> },
  ) => RemoteSocket;
  return new Constructor(url, undefined, { headers });
}
async function pairingRequest<T>(
  publicUrl: string,
  fetcher: typeof fetch,
  options: RemotePairingTransportOptions,
  request: (fetcher: typeof fetch) => Promise<T>,
): Promise<T> {
  if (!options.relay) return request(fetcher);
  const transport = new RelayTransport({
    ...options,
    relay: options.relay,
    createWebSocket: options.createWebSocket ?? defaultSocket,
  });
  try {
    if (transport.endpoint.relayUrl !== origin(publicUrl))
      throw new RemoteProtocolError("INVALID_ENDPOINT", "配对中继地址不匹配");
    return await request(transport.fetch);
  } finally {
    transport.close();
  }
}
export class RemoteRuntimeClient {
  readonly publicUrl: string;
  readonly #options: RemoteClientOptions;
  readonly #fetch: typeof fetch;
  readonly #relay?: RelayTransport;
  #socket: RemoteSocket | undefined;
  #connecting: Promise<void> | undefined;
  #cancelConnect: (() => void) | undefined;
  #closed = false;
  #foreground = true;
  #generation = 0;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #subscriptions = new Map<string, Subscription>();
  #terminalFrames = new Set<(frame: RuntimeTerminalFrame) => void>();
  #frames = new Set<(frame: RuntimeSessionSubscriptionFrame) => void>();
  #disconnects = new Set<() => void>();
  constructor(options: RemoteClientOptions) {
    this.publicUrl = origin(options.publicUrl);
    if (!options.deviceToken) throw new RemoteProtocolError("UNAUTHORIZED", "缺少设备凭据");
    this.#options = options.relay
      ? { ...options, gatewayId: options.gatewayId ?? options.relay.gatewayId }
      : options;
    if (options.relay) {
      this.#relay = new RelayTransport({
        relay: options.relay,
        randomBytes: options.randomBytes,
        createWebSocket: options.createWebSocket ?? defaultSocket,
        onFatal: (error) => this.#block("incompatible", error),
      });
      if (
        this.#relay.endpoint.relayUrl !== this.publicUrl ||
        (options.gatewayId && this.#relay.endpoint.gatewayId !== options.gatewayId)
      )
        throw new RemoteProtocolError("GATEWAY_MISMATCH", "中继连接与配对电脑身份不一致");
    }
    this.#fetch = this.#relay?.fetch ?? options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  get isRelay(): boolean {
    return !!this.#relay;
  }
  authorizationHeaders(): Readonly<Record<string, string>> {
    return { Authorization: `Bearer ${this.#options.deviceToken}` };
  }
  #state(state: RemoteConnectionState, error?: RemoteProtocolError): void {
    this.#options.onState?.(state, error);
  }
  #retireConnection(): void {
    this.#generation++;
    this.#cancelConnect?.();
    this.#cancelConnect = undefined;
    this.#connecting = undefined;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
    for (const subscription of this.#subscriptions.values()) subscription.replayCycle++;
    for (const callback of this.#disconnects) callback();
  }
  #block(state: "unauthorized" | "incompatible" | "error", error: RemoteProtocolError): void {
    this.#foreground = false;
    this.#retireConnection();
    this.#state(state, error);
  }
  async #observeHttp<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.#generation;
    try {
      return await operation();
    } catch (error) {
      if (
        !this.#closed &&
        this.#foreground &&
        generation === this.#generation &&
        error instanceof RemoteProtocolError
      ) {
        const blocked = blockedState(error);
        if (blocked) this.#block(blocked, error);
        else if (error instanceof HttpTransportError || error instanceof RelayTransportError) {
          // A live WSS cannot prove HTTP health. Retire it and verify both paths
          // on one new connection, without replaying the failed operation.
          this.#retireConnection();
          this.#state("reconnecting", error);
          this.#scheduleReconnect();
        }
      }
      throw error;
    }
  }
  async capabilities(): Promise<RemoteCapabilities> {
    return this.#observeHttp(() => this.#capabilities());
  }
  async #capabilities(): Promise<RemoteCapabilities> {
    const value = await jsonRequest(
      this.#fetch,
      this.publicUrl,
      "/v1/capabilities",
      this.#options.deviceToken,
    );
    if (
      !isJsonObject(value) ||
      value.version !== 1 ||
      typeof value.gatewayId !== "string" ||
      typeof value.platform !== "string" ||
      !Array.isArray(value.permissions) ||
      !value.permissions.every(
        (p) => typeof p === "string" && (REMOTE_PERMISSIONS as readonly string[]).includes(p),
      ) ||
      !Array.isArray(value.methods) ||
      !value.methods.every((method) => typeof method === "string") ||
      !isJsonObject(value.features) ||
      typeof value.maxFrameBytes !== "number" ||
      !Number.isSafeInteger(value.maxFrameBytes) ||
      value.maxFrameBytes <= 0 ||
      value.maxFrameBytes > REMOTE_MAX_FRAME_BYTES
    )
      throw new RemoteProtocolError("VERSION_MISMATCH", "电脑返回的远程协议不兼容");
    if (this.#options.gatewayId && value.gatewayId !== this.#options.gatewayId)
      throw new RemoteProtocolError("GATEWAY_MISMATCH", "当前电脑与配对身份不一致");
    // An additive method on a newer host must not disable this client's known
    // surface. Requests still use the client's explicit method allowlist.
    return {
      ...value,
      methods: value.methods.filter(isRemoteMethod),
    } as unknown as RemoteCapabilities;
  }
  async workspaces(): Promise<RemoteWorkspace[]> {
    return this.#observeHttp(async () => {
      const value = await jsonRequest(
        this.#fetch,
        this.publicUrl,
        "/v1/workspaces",
        this.#options.deviceToken,
      );
      const list = Array.isArray(value)
        ? value
        : isJsonObject(value) && Array.isArray(value.workspaces)
          ? value.workspaces
          : undefined;
      if (
        !list ||
        !list.every(
          (item) =>
            isJsonObject(item) && typeof item.id === "string" && typeof item.label === "string",
        )
      )
        throw new RemoteProtocolError("INVALID_RESPONSE", "授权工作区列表无效");
      return list as RemoteWorkspace[];
    });
  }
  async request<M extends RemoteMethod>(
    method: M,
    params: RemoteParams<M>,
    options: RemoteRequestOptions = {},
  ): Promise<RemoteResult<M>> {
    if (this.#closed) throw new RemoteProtocolError("CLIENT_CLOSED", "连接已关闭");
    const id = (this.#options.makeRequestId ?? requestId)();
    const input = parseRemoteRequest({
      version: 1,
      requestId: id,
      method,
      params: {
        ...params,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      },
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.secretEdits ? { secretEdits: options.secretEdits } : {}),
    });
    try {
      return await this.#observeHttp(async () => {
        const value = await jsonRequest(
          this.#fetch,
          this.publicUrl,
          "/v1/rpc",
          this.#options.deviceToken,
          input,
        );
        if (!isJsonObject(value) || value.requestId !== id || typeof value.ok !== "boolean")
          throw new ResponseValidationError("INVALID_RESPONSE", "请求响应不匹配");
        if (!value.ok) throw protocolError(value.error);
        try {
          return parseRuntimeResult(method, value.value);
        } catch (error) {
          throw new ResponseValidationError(
            "INVALID_RESPONSE",
            error instanceof Error ? error.message : "请求结果无效",
          );
        }
      });
    } catch (error) {
      if (
        (error instanceof ResponseValidationError ||
          (error instanceof HttpTransportError && error.retryable) ||
          error instanceof RelayTransportError) &&
        error.outcome !== "not_executed" &&
        REMOTE_METHOD_SPECS[method].mode === "command"
      )
        throw new RemoteProtocolError(
          error.code,
          "操作结果未确认，请先同步电脑状态",
          false,
          "unknown",
        );
      throw error;
    }
  }
  connect(): Promise<void> {
    if (this.#closed) return Promise.reject(new RemoteProtocolError("CLIENT_CLOSED", "连接已关闭"));
    if (!this.#foreground)
      return Promise.reject(new RemoteProtocolError("CLIENT_BACKGROUND", "应用当前不在前台"));
    if (this.#connecting) return this.#connecting;
    if (this.#socket?.readyState === 1) return Promise.resolve();
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    const generation = ++this.#generation;
    this.#state(this.#attempt ? "reconnecting" : "connecting");
    this.#connecting = this.#open(generation).finally(() => {
      if (generation === this.#generation) this.#connecting = undefined;
    });
    return this.#connecting;
  }
  async #open(generation: number): Promise<void> {
    try {
      // Recovery failures belong to this attempt; do not recursively retire it
      // through the public HTTP health observer.
      await this.#capabilities();
      if (this.#closed || !this.#foreground || generation !== this.#generation)
        throw new RemoteProtocolError("CLIENT_CLOSED", "旧连接已失效");
      await new Promise<void>((resolve, reject) => {
        const socket = (
          this.#relay?.createWebSocket ??
          this.#options.createWebSocket ??
          defaultSocket
        )(this.publicUrl.replace(/^https:/, "wss:") + "/v1/events", this.authorizationHeaders());
        this.#socket = socket;
        let ready = false;
        const timer = setTimeout(() => {
          socket.close();
          reject(new RemoteProtocolError("CONNECTION_FAILED", "事件连接超时", true));
        }, 15_000);
        this.#cancelConnect = () => {
          clearTimeout(timer);
          reject(new RemoteProtocolError("CLIENT_BACKGROUND", "连接已暂停"));
        };
        socket.onopen = () => {
          if (generation === this.#generation && this.#foreground) this.#state("syncing");
        };
        socket.onmessage = (event) => {
          if (generation !== this.#generation) return;
          try {
            if (
              typeof event.data !== "string" ||
              utf8ByteLength(event.data) > REMOTE_MAX_FRAME_BYTES
            )
              throw new RemoteProtocolError("FRAME_TOO_LARGE", "事件消息无效或超出预算");
            const message = JSON.parse(event.data) as RemoteServerMessage;
            if (!isJsonObject(message) || typeof message.type !== "string")
              throw new RemoteProtocolError("INVALID_RESPONSE", "事件消息无效");
            if (message.type === "ready") {
              if (
                message.version !== REMOTE_PROTOCOL_VERSION ||
                typeof message.gatewayId !== "string" ||
                (this.#options.gatewayId && message.gatewayId !== this.#options.gatewayId)
              )
                throw new RemoteProtocolError("VERSION_MISMATCH", "事件连接协议或电脑身份不匹配");
              ready = true;
              clearTimeout(timer);
              this.#cancelConnect = undefined;
              this.#attempt = 0;
              resolve();
              for (const subscription of this.#subscriptions.values())
                this.#sendSubscribe(subscription);
              this.#state("connected");
            } else if (!ready)
              throw new RemoteProtocolError("INVALID_RESPONSE", "事件连接尚未协商");
            else this.#message(message);
          } catch (error) {
            clearTimeout(timer);
            const failure =
              error instanceof RemoteProtocolError
                ? error
                : new RemoteProtocolError("INVALID_RESPONSE", "事件协议无效");
            reject(failure);
            this.#block(blockedState(failure) ?? "error", failure);
            socket.close(1002);
          }
        };
        socket.onerror = () => {
          if (generation !== this.#generation) return;
          if (!ready) {
            clearTimeout(timer);
            reject(new RemoteProtocolError("CONNECTION_FAILED", "事件连接失败", true));
          }
        };
        socket.onclose = (event) => {
          clearTimeout(timer);
          if (generation !== this.#generation) {
            if (!ready) reject(new RemoteProtocolError("CLIENT_BACKGROUND", "旧连接已暂停"));
            return;
          }
          this.#socket = undefined;
          if (!ready)
            reject(
              new RemoteProtocolError(
                event.code === 4001 ? "UNAUTHORIZED" : "CONNECTION_FAILED",
                event.code === 4001 ? "设备授权已失效" : "事件连接中断",
                event.code !== 4001,
              ),
            );
          if (event.code === 4001) {
            this.#block("unauthorized", new RemoteProtocolError("UNAUTHORIZED", "设备授权已失效"));
            return;
          }
          for (const callback of this.#disconnects) callback();
          this.#state("disconnected");
          this.#scheduleReconnect();
        };
      });
    } catch (error) {
      const failure =
        error instanceof RemoteProtocolError
          ? error
          : new RemoteProtocolError("CONNECTION_FAILED", "无法连接电脑", true);
      if (this.#closed || !this.#foreground || generation !== this.#generation) throw failure;
      const blocked = blockedState(failure);
      if (blocked) {
        this.#block(blocked, failure);
      } else {
        this.#state(failure.retryable ? "reconnecting" : "error", failure);
        if (failure.retryable) this.#scheduleReconnect();
      }
      throw failure;
    }
  }
  #scheduleReconnect(): void {
    if (this.#closed || !this.#foreground || this.#reconnectTimer) return;
    const delay =
      Math.min(30_000, 1000 * 2 ** Math.min(this.#attempt++, 5)) * (0.9 + Math.random() * 0.2);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.connect().catch(() => undefined);
    }, delay);
  }
  #sendSubscribe(subscription: Subscription): void {
    subscription.pending = [];
    subscription.pendingBytes = 0;
    subscription.replayed = false;
    subscription.replayCycle++;
    this.#socket?.send(
      JSON.stringify({
        type: "subscribe",
        subscriptionId: subscription.id,
        workspaceId: subscription.workspaceId,
        ...(subscription.lastEventId ? { afterEventId: subscription.lastEventId } : {}),
      }),
    );
  }
  #deliver(subscription: Subscription, event: RuntimeNotification): void {
    if (subscription.seen.has(event.eventId)) return;
    subscription.seen.add(event.eventId);
    subscription.lastEventId = event.eventId;
    if (subscription.seen.size > 2048)
      subscription.seen.delete(subscription.seen.values().next().value!);
    subscription.listener(event);
  }
  #message(message: RemoteServerMessage): void {
    if (message.type === "notification") {
      const subscription = this.#subscriptions.get(message.subscriptionId);
      if (!subscription || message.workspaceId !== subscription.workspaceId) return;
      const event = parseRuntimeNotification(message.event);
      if (!subscription.replayed) {
        const bytes = utf8ByteLength(JSON.stringify(event));
        if (
          subscription.pending.length >= 512 ||
          subscription.pendingBytes + bytes > 4 * REMOTE_MAX_FRAME_BYTES
        )
          throw new RemoteProtocolError("FRAME_TOO_LARGE", "事件重放缓冲已满");
        subscription.pending.push(event);
        subscription.pendingBytes += bytes;
      } else this.#deliver(subscription, event);
    } else if (message.type === "subscribed") {
      const subscription = this.#subscriptions.get(message.subscriptionId);
      if (!subscription || message.workspaceId !== subscription.workspaceId) return;
      const replay = parseRuntimeResult("events.subscribe", message.replay);
      const cycle = subscription.replayCycle;
      void this.#completeReplay(subscription, replay, cycle).catch((error: unknown) => {
        if (subscription.replayCycle !== cycle || !this.#subscriptions.has(subscription.id)) return;
        const failure =
          error instanceof RemoteProtocolError
            ? error
            : new RemoteProtocolError("INVALID_RESPONSE", "事件回放无法完成");
        subscription.reject?.(failure);
        this.#state("error", failure);
        this.#socket?.close(1011);
      });
    } else if (message.type === "terminal_frame") {
      if (typeof message.workspaceId !== "string" || !isRuntimeTerminalFrame(message.frame))
        throw new RemoteProtocolError("INVALID_RESPONSE", "终端事件无效");
      for (const callback of this.#terminalFrames) callback(message.frame);
    } else if (message.type === "session_frame") {
      if (
        !isJsonObject(message.frame) ||
        typeof message.frame.subscriptionId !== "string" ||
        typeof message.frame.sessionId !== "string" ||
        typeof message.frame.hostEpoch !== "string" ||
        !Number.isSafeInteger(message.frame.sequence) ||
        typeof message.frame.type !== "string" ||
        !message.frame.type.startsWith("subscription.")
      )
        throw new RemoteProtocolError("INVALID_RESPONSE", "会话帧无效");
      for (const callback of this.#frames) callback(message.frame);
    } else if (message.type === "disconnected") {
      for (const callback of this.#disconnects) callback();
      this.#socket?.close();
    } else if (message.type === "error") {
      const error = protocolError(message.error);
      if (message.subscriptionId) {
        const subscription = this.#subscriptions.get(message.subscriptionId);
        subscription?.reject?.(error);
        if (subscription) clearTimeout(subscription.timer);
        this.#subscriptions.delete(message.subscriptionId);
      }
      this.#state("error", error);
    } else throw new RemoteProtocolError("INVALID_RESPONSE", "未知事件消息");
  }
  async #completeReplay(
    subscription: Subscription,
    first: RuntimeResult<"events.subscribe">,
    cycle: number,
  ): Promise<void> {
    const active = () =>
      this.#subscriptions.get(subscription.id) === subscription &&
      subscription.replayCycle === cycle &&
      this.#foreground &&
      this.#socket?.readyState === 1 &&
      !this.#closed;
    // Match the local client: the initial page is returned, subsequent pages are delivered
    // to the listener. Never accumulate an entire workspace history in one array.
    if (subscription.resolve) {
      subscription.resolve({ ...first, hasMore: false });
      subscription.resolve = undefined;
      subscription.reject = undefined;
      clearTimeout(subscription.timer);
      for (const event of first.events) {
        subscription.seen.add(event.eventId);
        subscription.lastEventId = event.eventId;
      }
      await Promise.resolve();
    } else for (const event of first.events) this.#deliver(subscription, event);
    let page: RuntimeResult<"events.replay"> = first;
    const highWatermarkEventId = first.highWatermarkEventId;
    const cursors = new Set<string>();
    while (page.hasMore && active()) {
      const cursor = page.nextAfterEventId;
      if (!cursor || !highWatermarkEventId || cursors.has(cursor))
        throw new RemoteProtocolError("INVALID_RESPONSE", "回放游标无效，请重新同步");
      cursors.add(cursor);
      page = await this.request(
        "events.replay",
        { afterEventId: cursor, highWatermarkEventId },
        { workspaceId: subscription.workspaceId },
      );
      if (!active()) return;
      if (page.highWatermarkEventId !== highWatermarkEventId)
        throw new RemoteProtocolError("INVALID_RESPONSE", "回放水位发生变化，请重新同步");
      for (const event of page.events) this.#deliver(subscription, event);
    }
    if (!active()) return;
    subscription.replayed = true;
    const pending = subscription.pending;
    subscription.pending = [];
    subscription.pendingBytes = 0;
    for (const event of pending) this.#deliver(subscription, event);
  }
  async subscribe(
    params: { workspaceId: string; afterEventId?: string },
    listener: (event: RuntimeNotification) => void,
  ): Promise<{ replay: RuntimeResult<"events.subscribe">; dispose: () => void }> {
    await this.connect();
    const subscription: Subscription = {
      id: requestId(),
      workspaceId: params.workspaceId,
      lastEventId: params.afterEventId,
      listener,
      seen: new Set(),
      pending: [],
      replayed: false,
      replayCycle: 0,
      pendingBytes: 0,
    };
    this.#subscriptions.set(subscription.id, subscription);
    const replay = await new Promise<RuntimeResult<"events.subscribe">>((resolve, reject) => {
      subscription.resolve = resolve;
      subscription.reject = reject;
      subscription.timer = setTimeout(() => {
        this.#subscriptions.delete(subscription.id);
        if (this.#socket?.readyState === 1)
          this.#socket.send(
            JSON.stringify({ type: "unsubscribe", subscriptionId: subscription.id }),
          );
        reject(new RemoteProtocolError("REQUEST_TIMEOUT", "事件订阅超时", true));
      }, 15_000);
      this.#sendSubscribe(subscription);
    });
    return {
      replay,
      dispose: () => {
        clearTimeout(subscription.timer);
        this.#subscriptions.delete(subscription.id);
        if (this.#socket?.readyState === 1)
          this.#socket.send(
            JSON.stringify({ type: "unsubscribe", subscriptionId: subscription.id }),
          );
      },
    };
  }
  subscribeTerminalFrames(
    listener: (frame: RuntimeTerminalFrame) => void,
    onDisconnect?: () => void,
  ): { dispose: () => void } {
    this.#terminalFrames.add(listener);
    if (onDisconnect) this.#disconnects.add(onDisconnect);
    return {
      dispose: () => {
        this.#terminalFrames.delete(listener);
        if (onDisconnect) this.#disconnects.delete(onDisconnect);
      },
    };
  }
  subscribeSessionFrames(
    listener: (frame: RuntimeSessionSubscriptionFrame) => void,
    onDisconnect?: () => void,
  ): { dispose: () => void } {
    this.#frames.add(listener);
    if (onDisconnect) this.#disconnects.add(onDisconnect);
    return {
      dispose: () => {
        this.#frames.delete(listener);
        if (onDisconnect) this.#disconnects.delete(onDisconnect);
      },
    };
  }
  setForeground(value: boolean): void {
    if (this.#closed) return;
    this.#foreground = value;
    if (!value) {
      this.#retireConnection();
      this.#state("disconnected");
    } else void this.connect().catch(() => undefined);
  }
  close(): void {
    if (this.#closed) return;
    this.setForeground(false);
    this.#closed = true;
    this.#relay?.close();
    for (const subscription of this.#subscriptions.values()) {
      clearTimeout(subscription.timer);
      subscription.reject?.(new RemoteProtocolError("CLIENT_CLOSED", "连接已关闭"));
    }
    this.#subscriptions.clear();
    this.#terminalFrames.clear();
    this.#frames.clear();
    this.#disconnects.clear();
  }
  artifactUrl(workspaceId: string, sessionId: string, artifactId: string): string {
    if (this.#relay)
      throw new RemoteProtocolError("INVALID_ENDPOINT", "中继成果必须通过加密分块读取");
    return `${this.publicUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/content`;
  }
  async revoke(): Promise<void> {
    const value = await jsonRequest(
      this.#fetch,
      this.publicUrl,
      "/v1/device",
      this.#options.deviceToken,
      undefined,
      "DELETE",
    );
    if (!isJsonObject(value) || value.revoked !== true)
      throw new ResponseValidationError("INVALID_RESPONSE", "设备撤销响应无效");
    this.close();
  }
  static async submitPairing(
    offer: RemotePairingOffer,
    device: Pick<RemotePairingSubmission, "deviceName" | "platform">,
    fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    transport: RemotePairingTransportOptions = {},
  ): Promise<RemotePairingSubmitted> {
    const checked = parsePairingOffer(offer);
    const value = await pairingRequest(
      checked.publicUrl,
      fetcher,
      { ...transport, relay: checked.relay },
      (fetcher) =>
        jsonRequest(fetcher, checked.publicUrl, "/v1/pairings", undefined, {
          version: 1,
          gatewayId: checked.gatewayId,
          secret: checked.secret,
          ...device,
        }),
    );
    if (
      !isJsonObject(value) ||
      typeof value.pairingId !== "string" ||
      typeof value.pairingToken !== "string" ||
      typeof value.expiresAt !== "number"
    )
      throw new RemoteProtocolError("INVALID_RESPONSE", "配对申请响应无效");
    return value as unknown as RemotePairingSubmitted;
  }
  static async pairingStatus(
    publicUrl: string,
    pairing: RemotePairingSubmitted,
    fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    transport: RemotePairingTransportOptions = {},
  ): Promise<RemotePairingStatus> {
    const value = await pairingRequest(publicUrl, fetcher, transport, (fetcher) =>
      jsonRequest(
        fetcher,
        publicUrl,
        `/v1/pairings/${encodeURIComponent(pairing.pairingId)}`,
        pairing.pairingToken,
      ),
    );
    if (
      !isJsonObject(value) ||
      !["pending", "approved", "rejected", "expired"].includes(String(value.status))
    )
      throw new RemoteProtocolError("INVALID_RESPONSE", "配对状态无效");
    if (
      value.status === "approved" &&
      (typeof value.deviceId !== "string" ||
        typeof value.deviceToken !== "string" ||
        typeof value.publicUrl !== "string" ||
        origin(value.publicUrl) !== origin(publicUrl) ||
        typeof value.gatewayId !== "string" ||
        !Array.isArray(value.permissions) ||
        !Array.isArray(value.workspaceIds))
    )
      throw new RemoteProtocolError("INVALID_RESPONSE", "配对凭据无效");
    return value as unknown as RemotePairingStatus;
  }
  static async acknowledgePairing(
    publicUrl: string,
    pairing: RemotePairingSubmitted,
    fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    transport: RemotePairingTransportOptions = {},
  ): Promise<void> {
    const value = await pairingRequest(publicUrl, fetcher, transport, (fetcher) =>
      jsonRequest(
        fetcher,
        publicUrl,
        `/v1/pairings/${encodeURIComponent(pairing.pairingId)}/ack`,
        pairing.pairingToken,
        {},
      ),
    );
    if (!isJsonObject(value) || value.acknowledged !== true)
      throw new ResponseValidationError("INVALID_RESPONSE", "配对确认响应无效");
  }
}
