import { realpath } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import {
  createRuntimeAuthRequest,
  createRuntimeRequest,
  encodeRuntimeFrame,
  type RuntimeEvent,
  RuntimeFrameDecoder,
  type RuntimeMethod,
  type RuntimeParams,
  type RuntimeResponse,
  type RuntimeResult,
} from "./protocol.js";
import { resolveLocalDaemonEndpoint, type LocalDaemonEndpoint } from "./endpoint.js";
import { createLocalIpcAuthTokenStore, type LocalIpcAuthTokenStore } from "./ipc-auth.js";

const CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_RECONNECT_DELAY_MS = 100;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 2_000;
const MAX_REMEMBERED_EVENT_IDS = 10_000;

export type DaemonEndpoint = Pick<LocalDaemonEndpoint, "address" | "authTokenPath">;

export interface LocalRuntimeClientOptions {
  readonly authTokenStore?: LocalIpcAuthTokenStore;
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
}

export interface RuntimeClient {
  request<Method extends RuntimeMethod>(
    method: Method,
    params: RuntimeParams<Method>,
  ): Promise<RuntimeResult<Method>>;
  subscribe(
    params: RuntimeParams<"events.subscribe">,
    listener: (event: RuntimeEvent) => void,
  ): Promise<{
    readonly replay: RuntimeResult<"events.subscribe">;
    readonly dispose: () => void;
  }>;
  close(): void;
}

export class RuntimeClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeClientError";
  }
}

/**
 * Shared local Runtime transport. Requests reuse one authenticated connection;
 * every long-lived subscription owns its own connection because the daemon
 * intentionally supports one event cursor per socket.
 */
export class LocalRuntimeClient implements RuntimeClient {
  private readonly authTokenStore: LocalIpcAuthTokenStore;
  private readonly requestConnection: RuntimeConnection;
  private readonly subscriptions = new Set<RuntimeSubscription>();
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private closed = false;

  constructor(
    private readonly endpoint: DaemonEndpoint = resolveLocalDaemonEndpoint(),
    options: LocalRuntimeClientOptions = {},
  ) {
    this.authTokenStore =
      options.authTokenStore ??
      createLocalIpcAuthTokenStore({
        transport: this.endpoint.address.startsWith("\\\\.\\pipe\\") ? "pipe" : "unix",
        ...this.endpoint,
      });
    this.reconnectDelayMs = positiveDelay(options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS);
    this.maxReconnectDelayMs = Math.max(
      this.reconnectDelayMs,
      positiveDelay(options.maxReconnectDelayMs, DEFAULT_MAX_RECONNECT_DELAY_MS),
    );
    this.requestConnection = this.createConnection();
  }

  async connect(): Promise<void> {
    this.assertOpen();
    await this.requestConnection.open();
  }

  async request<Method extends RuntimeMethod>(
    method: Method,
    params: RuntimeParams<Method>,
  ): Promise<RuntimeResult<Method>> {
    this.assertOpen();
    return this.requestConnection.request(method, params);
  }

  async subscribe(
    params: RuntimeParams<"events.subscribe">,
    listener: (event: RuntimeEvent) => void,
  ): Promise<{
    readonly replay: RuntimeResult<"events.subscribe">;
    readonly dispose: () => void;
  }> {
    this.assertOpen();
    const subscription = new RuntimeSubscription({
      connection: this.createConnection(),
      params: {
        ...params,
        workspacePath: await realpath(params.workspacePath),
      },
      listener,
      reconnectDelayMs: this.reconnectDelayMs,
      maxReconnectDelayMs: this.maxReconnectDelayMs,
      onDispose: () => this.subscriptions.delete(subscription),
    });
    this.subscriptions.add(subscription);
    try {
      const replay = await subscription.start();
      return { replay, dispose: () => subscription.dispose() };
    } catch (error) {
      subscription.dispose();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.requestConnection.close();
    for (const subscription of [...this.subscriptions]) subscription.dispose();
    this.subscriptions.clear();
  }

  private createConnection(): RuntimeConnection {
    return new RuntimeConnection(this.endpoint, this.authTokenStore);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new RuntimeClientError("RUNTIME_CLIENT_CLOSED", "本机 Runtime 连接已关闭", true);
    }
  }
}

interface RuntimeSubscriptionOptions {
  readonly connection: RuntimeConnection;
  readonly params: RuntimeParams<"events.subscribe">;
  readonly listener: (event: RuntimeEvent) => void;
  readonly reconnectDelayMs: number;
  readonly maxReconnectDelayMs: number;
  readonly onDispose: () => void;
}

class RuntimeSubscription {
  private readonly seenEventIds = new Set<string>();
  private readonly pendingLiveEvents: RuntimeEvent[] = [];
  private lastEventId?: string;
  private bufferingLiveEvents = false;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private disposed = false;

  constructor(private readonly options: RuntimeSubscriptionOptions) {
    this.lastEventId = options.params.afterEventId;
    if (this.lastEventId) this.rememberEventId(this.lastEventId);
    options.connection.setEventListener((event) => this.handleEvent(event));
    options.connection.setDisconnectListener(() => this.scheduleReconnect());
  }

  async start(): Promise<RuntimeResult<"events.subscribe">> {
    return this.connectAndSubscribe(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelReconnect();
    this.options.connection.close();
    this.pendingLiveEvents.length = 0;
    this.options.onDispose();
  }

  private async connectAndSubscribe(
    deliverReplay: boolean,
  ): Promise<RuntimeResult<"events.subscribe">> {
    if (this.disposed) {
      throw new RuntimeClientError("RUNTIME_CLIENT_CLOSED", "Runtime 事件订阅已关闭", true);
    }
    this.bufferingLiveEvents = true;
    try {
      const replay = await this.options.connection.request("events.subscribe", {
        workspacePath: this.options.params.workspacePath,
        ...(this.lastEventId ? { afterEventId: this.lastEventId } : {}),
      });
      const events: RuntimeEvent[] = [];
      for (const event of replay.events) {
        if (!this.acceptEvent(event)) continue;
        events.push(event);
        if (deliverReplay) this.notify(event);
      }
      this.reconnectAttempt = 0;
      return { subscribed: true, events };
    } finally {
      this.bufferingLiveEvents = false;
      for (const event of this.pendingLiveEvents.splice(0)) this.deliverLiveEvent(event);
    }
  }

  private handleEvent(event: RuntimeEvent): void {
    if (this.disposed || !this.matchesWorkspace(event)) return;
    if (this.bufferingLiveEvents) {
      this.pendingLiveEvents.push(event);
      return;
    }
    this.deliverLiveEvent(event);
  }

  private deliverLiveEvent(event: RuntimeEvent): void {
    if (this.acceptEvent(event)) this.notify(event);
  }

  private acceptEvent(event: RuntimeEvent): boolean {
    if (this.disposed || !this.matchesWorkspace(event) || !this.rememberEventId(event.eventId)) {
      return false;
    }
    this.lastEventId = event.eventId;
    return true;
  }

  private matchesWorkspace(event: RuntimeEvent): boolean {
    return event.scope.workspacePath === this.options.params.workspacePath;
  }

  private notify(event: RuntimeEvent): void {
    try {
      this.options.listener(event);
    } catch {
      // A renderer listener cannot break the authenticated transport or replay cursor.
    }
  }

  private rememberEventId(eventId: string): boolean {
    if (this.seenEventIds.has(eventId)) return false;
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size > MAX_REMEMBERED_EVENT_IDS) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }
    return true;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = Math.min(
      this.options.maxReconnectDelayMs,
      this.options.reconnectDelayMs * 2 ** Math.min(this.reconnectAttempt++, 10),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed) return;
      void this.connectAndSubscribe(true).catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private cancelReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}

type PendingResponse = {
  readonly resolve: (response: RuntimeResponse) => void;
  readonly reject: (error: RuntimeClientError) => void;
};

class RuntimeConnection {
  private socket?: Socket;
  private decoder = new RuntimeFrameDecoder();
  private readonly pending = new Map<string, PendingResponse>();
  private connecting?: Promise<void>;
  private authentication?: {
    readonly resolve: () => void;
    readonly reject: (error: RuntimeClientError) => void;
  };
  private eventListener?: (event: RuntimeEvent) => void;
  private disconnectListener?: () => void;
  private closed = false;

  constructor(
    private readonly endpoint: DaemonEndpoint,
    private readonly authTokenStore: LocalIpcAuthTokenStore,
  ) {}

  setEventListener(listener: (event: RuntimeEvent) => void): void {
    this.eventListener = listener;
  }

  setDisconnectListener(listener: () => void): void {
    this.disconnectListener = listener;
  }

  async open(): Promise<void> {
    if (this.closed) {
      throw new RuntimeClientError("RUNTIME_CLIENT_CLOSED", "本机 Runtime 连接已关闭", true);
    }
    if (this.socket && !this.socket.destroyed) return;
    if (!this.connecting) {
      this.connecting = this.openAuthenticated().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  async request<Method extends RuntimeMethod>(
    method: Method,
    params: RuntimeParams<Method>,
  ): Promise<RuntimeResult<Method>> {
    await this.open();
    if (this.closed) {
      throw new RuntimeClientError("RUNTIME_CLIENT_CLOSED", "本机 Runtime 连接已关闭", true);
    }
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new RuntimeClientError("RUNTIME_DISCONNECTED", "本机 Runtime daemon 连接已断开", true);
    }
    const request = createRuntimeRequest(method, params);
    const response = await new Promise<RuntimeResponse>((resolve, reject) => {
      const pending = { resolve, reject };
      this.pending.set(request.requestId, pending);
      try {
        socket.write(encodeRuntimeFrame(request), (error) => {
          if (!error || this.pending.get(request.requestId) !== pending) return;
          this.pending.delete(request.requestId);
          reject(toUnavailableError(error));
        });
      } catch (error) {
        this.pending.delete(request.requestId);
        reject(toUnavailableError(error));
      }
    });
    if (!response.ok) {
      throw new RuntimeClientError(response.error.code, response.error.message, false);
    }
    return response.result as RuntimeResult<Method>;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    this.rejectAll(
      new RuntimeClientError("RUNTIME_CLIENT_CLOSED", "本机 Runtime 连接已关闭", true),
    );
  }

  private async openAuthenticated(): Promise<void> {
    let token: string;
    try {
      token = await this.authTokenStore.read();
    } catch (error) {
      throw new RuntimeClientError(
        "RUNTIME_UNAVAILABLE",
        "本机 Runtime daemon 未运行或认证材料不可用",
        true,
        error instanceof Error ? { cause: error } : undefined,
      );
    }
    if (this.closed) {
      throw new RuntimeClientError("RUNTIME_CLIENT_CLOSED", "本机 Runtime 连接已关闭", true);
    }
    this.decoder = new RuntimeFrameDecoder();
    const socket = await connectWithTimeout(this.endpoint.address);
    if (this.closed) {
      socket.destroy();
      throw new RuntimeClientError("RUNTIME_CLIENT_CLOSED", "本机 Runtime 连接已关闭", true);
    }
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.handleData(socket, chunk));
    socket.once("error", (error) => this.handleDisconnect(socket, toUnavailableError(error)));
    socket.once("close", () =>
      this.handleDisconnect(
        socket,
        new RuntimeClientError("RUNTIME_DISCONNECTED", "本机 Runtime daemon 连接已断开", true),
      ),
    );
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          this.authentication = { resolve, reject };
          socket.write(encodeRuntimeFrame(createRuntimeAuthRequest(token)));
        }),
        CONNECT_TIMEOUT_MS,
        "本机 Runtime IPC 认证超时",
      );
    } catch (error) {
      socket.destroy();
      if (this.socket === socket) this.socket = undefined;
      throw normalizeClientError(error);
    }
  }

  private handleData(socket: Socket, chunk: Buffer): void {
    if (this.socket !== socket) return;
    try {
      for (const message of this.decoder.push(chunk)) {
        if (message.kind === "auth_result") {
          const authentication = this.authentication;
          this.authentication = undefined;
          if (!authentication) continue;
          if (message.ok) authentication.resolve();
          else {
            authentication.reject(
              new RuntimeClientError("RUNTIME_AUTH_FAILED", "本机 Runtime IPC 认证失败", false),
            );
          }
        } else if (message.kind === "event") {
          this.eventListener?.(message.event);
        } else if (message.kind === "response") {
          const pending = this.pending.get(message.requestId);
          if (!pending) continue;
          this.pending.delete(message.requestId);
          pending.resolve(message);
        }
      }
    } catch (error) {
      this.handleDisconnect(socket, normalizeClientError(error));
      socket.destroy();
    }
  }

  private handleDisconnect(socket: Socket, error: RuntimeClientError): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.rejectAll(error);
    if (!this.closed) this.disconnectListener?.();
  }

  private rejectAll(error: RuntimeClientError): void {
    this.authentication?.reject(error);
    this.authentication = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function connectWithTimeout(address: string): Promise<Socket> {
  try {
    return await new Promise<Socket>((resolve, reject) => {
      const socket = connect(address);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new RuntimeClientError("RUNTIME_TIMEOUT", "连接本机 Runtime daemon 超时", true));
      }, CONNECT_TIMEOUT_MS);
      const onError = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        clearTimeout(timeout);
        socket.off("error", onError);
        resolve(socket);
      });
    });
  } catch (error) {
    throw toUnavailableError(error);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new RuntimeClientError("RUNTIME_TIMEOUT", message, true)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function positiveDelay(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeClientError(error: unknown): RuntimeClientError {
  if (error instanceof RuntimeClientError) return error;
  return new RuntimeClientError(
    "RUNTIME_PROTOCOL_ERROR",
    error instanceof Error ? error.message : "本机 Runtime IPC 发生未知错误",
    false,
    error instanceof Error ? { cause: error } : undefined,
  );
}

function toUnavailableError(error: unknown): RuntimeClientError {
  return new RuntimeClientError(
    "RUNTIME_UNAVAILABLE",
    "无法连接本机 Runtime daemon",
    true,
    error instanceof Error ? { cause: error } : undefined,
  );
}

/** @deprecated Import resolveLocalDaemonEndpoint from the shared daemon package. */
export const resolveDaemonEndpoint = resolveLocalDaemonEndpoint;
