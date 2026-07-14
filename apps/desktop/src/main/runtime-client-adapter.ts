import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  createRuntimeAuthRequest,
  createRuntimeRequest,
  encodeRuntimeFrame,
  RuntimeFrameDecoder,
  type RuntimeEvent,
  type RuntimeMethod,
  type RuntimeParams,
  type RuntimeResponse,
  type RuntimeResult,
} from "@pico/protocol";

const CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_RECONNECT_DELAY_MS = 100;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 2_000;
const MAX_REMEMBERED_EVENT_IDS = 10_000;

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

export interface RuntimeClientAdapter {
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

export interface DaemonEndpoint {
  readonly address: string;
  readonly authTokenPath: string;
}

export interface LocalDaemonRuntimeClientAdapterOptions {
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
}

interface StoredToken {
  readonly version: 1;
  readonly token: string;
}

interface RuntimeSubscriptionState {
  readonly params: RuntimeParams<"events.subscribe">;
  readonly listener: (event: RuntimeEvent) => void;
  readonly seenEventIds: Set<string>;
  readonly pendingLiveEvents: RuntimeEvent[];
  lastEventId?: string;
  bufferingLiveEvents: boolean;
  disposed: boolean;
}

export class LocalDaemonRuntimeClientAdapter implements RuntimeClientAdapter {
  private socket: Socket | undefined;
  private decoder = new RuntimeFrameDecoder();
  private readonly pending = new Map<
    string,
    { resolve: (response: RuntimeResponse) => void; reject: (error: RuntimeClientError) => void }
  >();
  private readonly subscriptions = new Map<number, RuntimeSubscriptionState>();
  private connecting: Promise<void> | undefined;
  private authentication:
    | { resolve: () => void; reject: (error: RuntimeClientError) => void }
    | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private nextSubscriptionId = 1;
  private connectedOnce = false;
  private closed = false;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;

  constructor(
    private readonly endpoint: DaemonEndpoint = resolveDaemonEndpoint(),
    options: LocalDaemonRuntimeClientAdapterOptions = {},
  ) {
    this.reconnectDelayMs = positiveDelay(options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS);
    this.maxReconnectDelayMs = Math.max(
      this.reconnectDelayMs,
      positiveDelay(options.maxReconnectDelayMs, DEFAULT_MAX_RECONNECT_DELAY_MS),
    );
  }

  async request<Method extends RuntimeMethod>(
    method: Method,
    params: RuntimeParams<Method>,
  ): Promise<RuntimeResult<Method>> {
    await this.ensureConnected();
    const request = createRuntimeRequest(method, params);
    const response = await new Promise<RuntimeResponse>((resolve, reject) => {
      this.pending.set(request.requestId, { resolve, reject });
      this.socket?.write(encodeRuntimeFrame(request));
    });
    if (!response.ok) {
      throw new RuntimeClientError(response.error.code, response.error.message, false);
    }
    // The protocol package validates the response envelope. Method/result correlation is preserved
    // by requestId and by the generic request factory, so this is the transport boundary cast.
    return response.result as RuntimeResult<Method>;
  }

  async subscribe(
    params: RuntimeParams<"events.subscribe">,
    listener: (event: RuntimeEvent) => void,
  ): Promise<{
    readonly replay: RuntimeResult<"events.subscribe">;
    readonly dispose: () => void;
  }> {
    const normalizedParams = params.workspacePath
      ? { ...params, workspacePath: await realpath(params.workspacePath) }
      : params;
    const subscriptionId = this.nextSubscriptionId++;
    const state: RuntimeSubscriptionState = {
      params: normalizedParams,
      listener,
      seenEventIds: new Set(),
      pendingLiveEvents: [],
      ...(normalizedParams.afterEventId ? { lastEventId: normalizedParams.afterEventId } : {}),
      bufferingLiveEvents: false,
      disposed: false,
    };
    if (normalizedParams.afterEventId) rememberEventId(state, normalizedParams.afterEventId);
    this.subscriptions.set(subscriptionId, state);
    try {
      const replay = await this.subscribeTransport(state, false);
      let disposed = false;
      return {
        replay,
        dispose: () => {
          if (disposed) return;
          disposed = true;
          state.disposed = true;
          this.subscriptions.delete(subscriptionId);
          if (this.subscriptions.size === 0) this.cancelReconnect();
        },
      };
    } catch (error) {
      state.disposed = true;
      this.subscriptions.delete(subscriptionId);
      if (this.subscriptions.size === 0) this.cancelReconnect();
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.cancelReconnect();
    this.socket?.destroy();
    this.socket = undefined;
    this.subscriptions.clear();
    this.rejectAll(
      new RuntimeClientError("RUNTIME_CLIENT_CLOSED", "本机 Runtime 连接已关闭", true),
    );
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) {
      throw new RuntimeClientError("RUNTIME_CLIENT_CLOSED", "本机 Runtime 连接已关闭", true);
    }
    if (this.socket && !this.socket.destroyed) return;
    this.cancelReconnect();
    if (!this.connecting) {
      this.connecting = this.connectAuthenticated()
        .then(() => {
          this.reconnectAttempt = 0;
        })
        .catch((error: unknown) => {
          if (this.subscriptions.size > 0) this.scheduleReconnect();
          throw normalizeClientError(error);
        })
        .finally(() => {
          this.connecting = undefined;
        });
    }
    return await this.connecting;
  }

  private async connectAuthenticated(): Promise<void> {
    const restoreSubscriptions = this.connectedOnce;
    const token = await readAuthToken(this.endpoint.authTokenPath);
    this.decoder = new RuntimeFrameDecoder();
    const socket = await connectWithTimeout(this.endpoint.address);
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
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
      this.connectedOnce = true;
      if (restoreSubscriptions) await this.restoreSubscriptions();
    } catch (error) {
      socket.destroy();
      if (this.socket === socket) this.socket = undefined;
      throw normalizeClientError(error);
    }
  }

  private handleData(chunk: Buffer): void {
    try {
      for (const message of this.decoder.push(chunk)) {
        if (message.kind === "auth_result") {
          const authentication = this.authentication;
          this.authentication = undefined;
          if (!authentication) continue;
          if (message.ok) authentication.resolve();
          else
            authentication.reject(
              new RuntimeClientError("RUNTIME_AUTH_FAILED", "本机 Runtime IPC 认证失败", false),
            );
        } else if (message.kind === "event") {
          this.handleEvent(message.event);
        } else if (message.kind === "response") {
          const pending = this.pending.get(message.requestId);
          if (!pending) continue;
          this.pending.delete(message.requestId);
          pending.resolve(message);
        }
      }
    } catch (error) {
      const socket = this.socket;
      if (socket) {
        this.handleDisconnect(socket, normalizeClientError(error));
        socket.destroy();
      }
    }
  }

  private handleDisconnect(socket: Socket, error: RuntimeClientError): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.rejectAll(error);
    if (!this.closed && this.subscriptions.size > 0) this.scheduleReconnect();
  }

  private rejectAll(error: RuntimeClientError): void {
    this.authentication?.reject(error);
    this.authentication = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private handleEvent(event: RuntimeEvent): void {
    for (const state of this.subscriptions.values()) {
      if (!matchesWorkspace(state, event)) continue;
      if (state.bufferingLiveEvents) {
        state.pendingLiveEvents.push(event);
        continue;
      }
      this.deliverEvent(state, event);
    }
  }

  private deliverEvent(state: RuntimeSubscriptionState, event: RuntimeEvent): boolean {
    if (state.disposed || !matchesWorkspace(state, event) || !rememberEventId(state, event.eventId))
      return false;
    state.lastEventId = event.eventId;
    state.listener(event);
    return true;
  }

  private async subscribeTransport(
    state: RuntimeSubscriptionState,
    deliverReplay: boolean,
  ): Promise<RuntimeResult<"events.subscribe">> {
    state.bufferingLiveEvents = true;
    try {
      const replay = await this.request("events.subscribe", {
        ...(state.params.workspacePath ? { workspacePath: state.params.workspacePath } : {}),
        ...(state.lastEventId ? { afterEventId: state.lastEventId } : {}),
      });
      const events: RuntimeEvent[] = [];
      for (const event of replay.events) {
        if (
          state.disposed ||
          !matchesWorkspace(state, event) ||
          !rememberEventId(state, event.eventId)
        )
          continue;
        state.lastEventId = event.eventId;
        events.push(event);
        if (deliverReplay) state.listener(event);
      }
      return { subscribed: true, events };
    } finally {
      state.bufferingLiveEvents = false;
      for (const event of state.pendingLiveEvents.splice(0)) this.deliverEvent(state, event);
    }
  }

  private async restoreSubscriptions(): Promise<void> {
    for (const state of [...this.subscriptions.values()]) {
      if (state.disposed) continue;
      await this.subscribeTransport(state, true);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || this.subscriptions.size === 0) return;
    const delay = Math.min(
      this.maxReconnectDelayMs,
      this.reconnectDelayMs * 2 ** Math.min(this.reconnectAttempt++, 10),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed || this.subscriptions.size === 0) return;
      void this.ensureConnected().catch(() => undefined);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private cancelReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}

function matchesWorkspace(state: RuntimeSubscriptionState, event: RuntimeEvent): boolean {
  return !state.params.workspacePath || event.scope.workspacePath === state.params.workspacePath;
}

function rememberEventId(state: RuntimeSubscriptionState, eventId: string): boolean {
  if (state.seenEventIds.has(eventId)) return false;
  state.seenEventIds.add(eventId);
  if (state.seenEventIds.size > MAX_REMEMBERED_EVENT_IDS) {
    const oldest = state.seenEventIds.values().next().value;
    if (oldest !== undefined) state.seenEventIds.delete(oldest);
  }
  return true;
}

function positiveDelay(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveDaemonEndpoint(
  targetPlatform: NodeJS.Platform = platform(),
): DaemonEndpoint {
  const identity = currentUserIdentity();
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  if (targetPlatform === "win32") {
    const runtimeDir = join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "Pico",
      "runtime",
    );
    return {
      address: `\\\\.\\pipe\\pico-runtime-${digest}-v1`,
      authTokenPath: join(runtimeDir, `runtime-${digest}-v1.auth`),
    };
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `pico-${digest}`);
  return {
    address: join(runtimeDir, "runtime-v1.sock"),
    authTokenPath: join(runtimeDir, "runtime-v1.auth"),
  };
}

async function readAuthToken(path: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isStoredToken(parsed)) throw new Error("invalid auth material");
    return parsed.token;
  } catch (error) {
    throw new RuntimeClientError(
      "RUNTIME_UNAVAILABLE",
      "本机 Runtime daemon 未运行或认证材料不可用",
      true,
      { cause: error },
    );
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

function isStoredToken(value: unknown): value is StoredToken {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredToken>;
  return (
    candidate.version === 1 && typeof candidate.token === "string" && candidate.token.length >= 43
  );
}

function currentUserIdentity(): string {
  try {
    return `${userInfo().username}:${homedir()}`;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "unknown-user";
  }
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
