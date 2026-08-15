import { realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  connectOrSpawnRuntimeHost,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type RuntimeHostConnection,
  RuntimeHostOperationError,
} from "@pico/runtime-host";
import {
  isEphemeralRuntimeNotificationTopic,
  RuntimeNotificationBuffer,
  type RuntimeNotificationBufferOptions,
  type RuntimeNotification,
  type RuntimeMethod,
  type RuntimeParams,
  type RuntimeResult,
} from "./protocol.js";
import { resolveCanonicalPicoHome } from "./endpoint.js";
import {
  ensurePicoRuntimeHostEventOperationsRegistered,
  ensurePicoRuntimeHostOperationsRegistered,
  ensurePicoRuntimeHostShutdownOperationRegistered,
} from "./runtime-host-operations.js";

const CONNECT_TIMEOUT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
/** 杀 daemon 重生路径的重试时间预算（吸收冷启动环境波动与将死残留竞态）。 */
const KERNEL_RETRY_WINDOW_MS = 30_000;

/**
 * 幂等方法白名单（3-B-4 / P1-2）：仅这些方法在传输级失败（连接已 terminal）后
 * 走"丢弃死连接 → 重生 daemon → 重发"循环。读方法重发无副作用；events.*
 * 走类型化桥接且 daemon 订阅是覆盖语义，重订等价。其余写方法（session.send /
 * run.start / rewind.apply / jobs.runNow 等）的失败窗口无法区分"daemon 死亡"
 * 与"响应在途丢失"——自动重发可能双执行（双 LLM turn / 双提交），一律立即
 * 上抛 RUNTIME_DISCONNECTED（retryable=true），由调用方决策是否人工重试。
 * 有意排除：diagnostics.run（doctor 执行检查，副作用未证伪）、一切状态变更方法。
 */
const KERNEL_RETRY_SAFE_METHODS: ReadonlySet<RuntimeMethod> = new Set<RuntimeMethod>([
  "runtime.ping",
  "diagnostics.resources",
  "session.list",
  "session.get",
  "session.settings.get",
  "session.transcript",
  "session.evidence.read",
  "goal.get",
  "discovery.get",
  "runs.list",
  "changes.list",
  "changes.diff",
  "rewind.list",
  "rewind.preview",
  // 幂等取消：重发已解析的 prompt 返回 cancelled=false，不产生第二次副作用。
  "prompt.cancel",
  "memory.list",
  "memory.get",
  "memory.review.list",
  "memory.settings.get",
  "memory.context.preview",
  "jobs.list",
  "jobs.history",
  "config.get",
  "config.providers",
  "config.user.get",
  "config.effective.get",
  "provider.list",
  "provider.credential.status",
  "catalog.agents",
  "catalog.skills",
  "config.skills",
  "config.mcpServers",
  "skills.user.list",
  "skills.effective.list",
  "mcp.user.list",
  "mcp.effective.list",
  "usage.get",
  "workspace.status",
  "workspace.list",
  "workspace.trustStatus",
  // 幂等写（重复执行同态）：工作区注册/信任——重复 register/trust 返回同态
  // 结果，冷启动窗口（connectOrSpawn 拉起慢）内可安全自动重试。unregister
  // 重复执行的返回形态未证伪，保守不入（P1-2 测试以其为非幂等代表）。
  "workspace.register",
  "workspace.trust",
  "events.subscribe",
  "events.replay",
]);
const KERNEL_RETRY_BACKOFF_MS = 200;

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
const DEFAULT_RECONNECT_DELAY_MS = 100;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 2_000;
const MAX_REMEMBERED_EVENT_IDS = 10_000;

function positiveDelay(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface LocalRuntimeClientOptions {
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  /** Bounded replay overlap queue; injectable for constrained hosts and integration tests. */
  readonly replayBufferOptions?: RuntimeNotificationBufferOptions;
  /** runtime-host 交互根（默认 canonical PICO_HOME）。 */
  readonly runtimeHostRootPath?: string;
}

export interface RuntimeClient {
  request<Method extends RuntimeMethod>(
    method: Method,
    params: RuntimeParams<Method>,
  ): Promise<RuntimeResult<Method>>;
  subscribe(
    params: RuntimeParams<"events.subscribe">,
    listener: (notification: RuntimeNotification) => void,
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

/** 连接级能力面：订阅环与请求路径只依赖这四个成员，传输实现可替换。 */
interface RuntimeTransportConnection {
  setEventListener(listener: (notification: RuntimeNotification) => void): void;
  setDisconnectListener(listener: () => void): void;
  open(): Promise<void>;
  request<Method extends RuntimeMethod>(
    method: Method,
    params: RuntimeParams<Method>,
  ): Promise<RuntimeResult<Method>>;
  /** 请求常驻 daemon 优雅关停（仅 kernel 承载传输支持；旧 socket 注入面不提供）。 */
  shutdownHost?(): Promise<void>;
  close(): void;
}

/**
 * Shared local Runtime transport. Requests reuse one connection; every
 * long-lived subscription owns its own connection（kernel 承载下一连接一订阅）。
 *
 * 3-D Phase 5（2026-08-16）：唯一承载是 runtime-host kernel（connectOrSpawn 拉起
 * daemon candidate，runtime.request 通用桥接 + events.* 类型化桥接）。旧 socket
 * 传输（显式 endpoint 注入面 + LocalRuntimeDaemon）已随 in-process 路径退役。
 */
export class LocalRuntimeClient implements RuntimeClient {
  private readonly requestConnection: RuntimeTransportConnection;
  private readonly subscriptions = new Set<RuntimeSubscription>();
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly replayBufferOptions?: RuntimeNotificationBufferOptions;
  private readonly runtimeHostRootPath?: string;
  private closed = false;

  constructor(
    _endpoint?: unknown,
    options: LocalRuntimeClientOptions = {},
  ) {
    if (_endpoint !== undefined && _endpoint !== null) {
      throw new Error(
        "显式 endpoint 注入已退役（3-D Phase 5）：LocalRuntimeClient 唯一承载是 runtime-host kernel，用 options.runtimeHostRootPath 指定根路径。",
      );
    }
    this.reconnectDelayMs = positiveDelay(options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS);
    this.maxReconnectDelayMs = Math.max(
      this.reconnectDelayMs,
      positiveDelay(options.maxReconnectDelayMs, DEFAULT_MAX_RECONNECT_DELAY_MS),
    );
    this.replayBufferOptions = options.replayBufferOptions;
    this.runtimeHostRootPath = options.runtimeHostRootPath;
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
    listener: (notification: RuntimeNotification) => void,
  ): Promise<{
    readonly replay: RuntimeResult<"events.subscribe">;
    readonly dispose: () => void;
  }> {
    this.assertOpen();
    const workspacePath = await realpath(params.workspacePath);
    this.assertOpen();
    const subscription = new RuntimeSubscription({
      connection: this.createConnection(),
      params: {
        ...params,
        workspacePath,
      },
      listener,
      reconnectDelayMs: this.reconnectDelayMs,
      maxReconnectDelayMs: this.maxReconnectDelayMs,
      ...(this.replayBufferOptions ? { replayBufferOptions: this.replayBufferOptions } : {}),
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

  /** 请求常驻 daemon 优雅关停（3-B-4）。仅在 kernel 承载模式可用；旧 socket
   *  注入面不提供（对应 daemon 没有 kernel 生命周期可关）。 */
  async shutdownDaemon(): Promise<void> {
    this.assertOpen();
    if (!this.requestConnection.shutdownHost) {
      throw new RuntimeClientError(
        "RUNTIME_UNAVAILABLE",
        "当前连接模式不支持 daemon 关停（kernel 承载专属）",
        false,
      );
    }
    await this.requestConnection.open();
    await this.requestConnection.shutdownHost();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.requestConnection.close();
    for (const subscription of [...this.subscriptions]) subscription.dispose();
    this.subscriptions.clear();
  }

  private createConnection(): RuntimeTransportConnection {
    return new KernelRuntimeConnection(this.runtimeHostRootPath ?? resolveCanonicalPicoHome());
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new RuntimeClientError("RUNTIME_CLIENT_CLOSED", "本机 Runtime 连接已关闭", true);
    }
  }
}

interface RuntimeSubscriptionOptions {
  readonly connection: RuntimeTransportConnection;
  readonly params: RuntimeParams<"events.subscribe">;
  readonly listener: (notification: RuntimeNotification) => void;
  readonly reconnectDelayMs: number;
  readonly maxReconnectDelayMs: number;
  readonly replayBufferOptions?: RuntimeNotificationBufferOptions;
  readonly onDispose: () => void;
}

interface RuntimeReplayCycle {
  /** Only concurrent durable live events need replay overlap tracking; the queue bounds this set. */
  readonly pendingDurableEventIds: Set<string>;
  readonly replayedPendingEventIds: Set<string>;
  readonly pendingLiveEvents: RuntimeNotificationBuffer;
  overflowed: boolean;
}

class RuntimeSubscription {
  private readonly seenEventIds = new Set<string>();
  private replayCycle?: RuntimeReplayCycle;
  private lastEventId?: string;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private recoveryFenced = false;
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
    this.discardReplayCycle();
    this.options.onDispose();
  }

  private async connectAndSubscribe(
    deliverReplay: boolean,
    allowCursorReset = true,
  ): Promise<RuntimeResult<"events.subscribe">> {
    try {
      return await this.connectAndSubscribeOnce(deliverReplay);
    } catch (error) {
      if (
        allowCursorReset &&
        this.lastEventId &&
        error instanceof RuntimeClientError &&
        error.code === "INVALID_PARAMS"
      ) {
        this.lastEventId = undefined;
        this.seenEventIds.clear();
        return this.connectAndSubscribe(deliverReplay, false);
      }
      if (deliverReplay && !this.disposed) this.scheduleReconnect();
      throw error;
    }
  }

  private async connectAndSubscribeOnce(
    deliverReplay: boolean,
  ): Promise<RuntimeResult<"events.subscribe">> {
    if (this.disposed) {
      throw new RuntimeClientError("RUNTIME_CLIENT_CLOSED", "Runtime 事件订阅已关闭", true);
    }
    const replayCycle = this.beginReplayCycle();
    let replayComplete = false;
    try {
      const firstPage = await this.options.connection.request("events.subscribe", {
        workspacePath: this.options.params.workspacePath,
        ...(this.lastEventId ? { afterEventId: this.lastEventId } : {}),
      });
      const events: RuntimeNotification[] = [];
      let page: RuntimeResult<"events.replay"> = firstPage;
      let first = true;
      const highWatermarkEventId = firstPage.highWatermarkEventId;
      while (true) {
        for (const event of page.events) {
          if (isEphemeralRuntimeNotificationTopic(event.topic)) {
            throw this.invalidReplayPage("Runtime durable 回放页包含 ephemeral 事件");
          }
          if (replayCycle.pendingDurableEventIds.has(event.eventId)) {
            replayCycle.replayedPendingEventIds.add(event.eventId);
          }
          if (!this.acceptEvent(event)) continue;
          if (!deliverReplay && first) events.push(event);
          else this.notify(event);
        }
        if (replayCycle.overflowed) {
          throw this.invalidReplayPage("Runtime 回放期间 durable 实时事件超过缓冲预算，请重新订阅");
        }
        if (!page.hasMore) break;
        const nextAfterEventId = page.nextAfterEventId;
        if (!nextAfterEventId || !highWatermarkEventId) {
          throw this.invalidReplayPage("Runtime 回放页缺少 next cursor 或 high-watermark");
        }
        const nextPage = await this.options.connection.request("events.replay", {
          workspacePath: this.options.params.workspacePath,
          afterEventId: nextAfterEventId,
          highWatermarkEventId,
        });
        if (nextPage.highWatermarkEventId !== highWatermarkEventId) {
          throw this.invalidReplayPage("Runtime 回放页 high-watermark 发生变化");
        }
        if (nextPage.hasMore && nextPage.nextAfterEventId === nextAfterEventId) {
          throw this.invalidReplayPage("Runtime 回放 cursor 未向前推进");
        }
        page = nextPage;
        first = false;
      }
      this.reconnectAttempt = 0;
      replayComplete = true;
      return {
        subscribed: true,
        events,
        hasMore: false,
        ...(page.nextAfterEventId ? { nextAfterEventId: page.nextAfterEventId } : {}),
        ...(highWatermarkEventId ? { highWatermarkEventId } : {}),
      };
    } finally {
      this.finishReplayCycle(replayCycle, replayComplete);
    }
  }

  private handleEvent(event: RuntimeNotification): void {
    if (this.disposed || !this.matchesWorkspace(event)) return;
    if (this.replayCycle) {
      const accepted = this.replayCycle.pendingLiveEvents.push(event);
      this.replayCycle.overflowed ||= !accepted;
      if (accepted && !isEphemeralRuntimeNotificationTopic(event.topic)) {
        this.replayCycle.pendingDurableEventIds.add(event.eventId);
      }
      return;
    }
    if (this.recoveryFenced) return;
    this.deliverLiveEvent(event);
  }

  private deliverLiveEvent(event: RuntimeNotification): void {
    if (this.acceptEvent(event)) this.notify(event);
  }

  private acceptEvent(event: RuntimeNotification): boolean {
    if (this.disposed || !this.matchesWorkspace(event) || !this.rememberEventId(event.eventId)) {
      return false;
    }
    // Best-effort live events are deliberately absent from the durable ledger. Advancing the
    // replay cursor to their event ID would make the next reconnect start from a non-existent
    // durable position and could skip retained notifications.
    if (!isEphemeralRuntimeNotificationTopic(event.topic)) this.lastEventId = event.eventId;
    return true;
  }

  private matchesWorkspace(event: RuntimeNotification): boolean {
    return event.scope.workspacePath === this.options.params.workspacePath;
  }

  private notify(event: RuntimeNotification): void {
    try {
      this.options.listener(event);
    } catch {
      // A renderer listener cannot break the authenticated transport or replay cursor.
    }
  }

  private beginReplayCycle(): RuntimeReplayCycle {
    if (this.replayCycle) {
      throw this.invalidReplayPage("Runtime 回放周期发生重叠");
    }
    const replayCycle: RuntimeReplayCycle = {
      pendingDurableEventIds: new Set<string>(),
      replayedPendingEventIds: new Set<string>(),
      pendingLiveEvents: new RuntimeNotificationBuffer(this.options.replayBufferOptions),
      overflowed: false,
    };
    this.replayCycle = replayCycle;
    return replayCycle;
  }

  private finishReplayCycle(replayCycle: RuntimeReplayCycle, replayComplete: boolean): void {
    if (this.replayCycle !== replayCycle) {
      replayCycle.pendingLiveEvents.clear();
      replayCycle.pendingDurableEventIds.clear();
      replayCycle.replayedPendingEventIds.clear();
      return;
    }
    this.replayCycle = undefined;
    this.recoveryFenced = !replayComplete;
    const pendingLiveEvents = replayComplete ? replayCycle.pendingLiveEvents.drain() : [];
    replayCycle.pendingLiveEvents.clear();
    if (replayComplete && !this.disposed) {
      for (const event of pendingLiveEvents) {
        if (replayCycle.replayedPendingEventIds.has(event.eventId)) continue;
        this.deliverLiveEvent(event);
      }
      this.recoveryFenced = false;
    }
    replayCycle.pendingDurableEventIds.clear();
    replayCycle.replayedPendingEventIds.clear();
  }

  private discardReplayCycle(): void {
    const replayCycle = this.replayCycle;
    this.replayCycle = undefined;
    this.recoveryFenced = false;
    if (!replayCycle) return;
    replayCycle.pendingLiveEvents.clear();
    replayCycle.pendingDurableEventIds.clear();
    replayCycle.replayedPendingEventIds.clear();
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

  private invalidReplayPage(message: string): RuntimeClientError {
    return new RuntimeClientError("RUNTIME_INVALID_RESPONSE", message, true);
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

class KernelRuntimeConnection implements RuntimeTransportConnection {
  private hostConnection?: RuntimeHostConnection;
  private connecting?: Promise<void>;
  private eventListener?: (notification: RuntimeNotification) => void;
  private disconnectListener?: () => void;
  private closed = false;

  constructor(private readonly rootPath: string) {}

  setEventListener(listener: (notification: RuntimeNotification) => void): void {
    this.eventListener = listener;
  }

  setDisconnectListener(listener: () => void): void {
    this.disconnectListener = listener;
  }

  async shutdownHost(): Promise<void> {
    await this.open();
    const connection = this.hostConnection;
    if (!connection) {
      throw new RuntimeClientError("RUNTIME_DISCONNECTED", "本机 Runtime daemon 连接已断开", true);
    }
    // daemon 收到请求后进入排空：kernel 等本操作响应写出后 destroy 连接并退出。
    await connection.requestRegistered("runtime.shutdown", {});
  }

  async open(): Promise<void> {
    if (this.closed) {
      throw new RuntimeClientError("RUNTIME_CLIENT_CLOSED", "本机 Runtime 连接已关闭", true);
    }
    const current = this.hostConnection;
    if (current && current.terminalError === undefined) return;
    if (current) {
      this.hostConnection = undefined;
      await current.close().catch(() => undefined);
    }
    if (!this.connecting) {
      this.connecting = this.openKernel().finally(() => {
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
    const connection = this.hostConnection;
    if (!connection) {
      throw new RuntimeClientError("RUNTIME_DISCONNECTED", "本机 Runtime daemon 连接已断开", true);
    }
    try {
      return await requestOverKernelConnection(connection, method, params);
    } catch (error) {
      if (error instanceof RuntimeHostOperationError || this.closed) {
        throw translateKernelRequestError(error);
      }
      // 传输级失败且连接已 terminal（如 daemon 被杀后断连传播慢于本次请求的
      // 竞态窗口）：仅幂等方法（KERNEL_RETRY_SAFE_METHODS）丢弃死连接，open()
      // 经 connectOrSpawn 重生 daemon 后重试。重生过程可能连到将死进程的残留
      // socket（handshake 成功但进程随即死透），且冷启动受环境波动影响可达数十
      // 秒——按时间预算循环而非固定次数，兑现"下一次请求拉起 daemon"的 kernel
      // 承载语义。非幂等写方法不自动重发（P1-2：失败窗口无法排除响应在途丢失，
      // 重发可能双执行），立即上抛交由调用方决策。操作级错误（host_not_ready
      // 等）与本地 decodeInput 失败同样不在此循环内。
      if (connection.terminalError === undefined || !KERNEL_RETRY_SAFE_METHODS.has(method)) {
        throw translateKernelRequestError(error);
      }
      const retryDeadline = performance.now() + KERNEL_RETRY_WINDOW_MS;
      let lastError: unknown = error;
      while (performance.now() < retryDeadline) {
        if (this.closed) break;
        if (this.hostConnection === connection) this.hostConnection = undefined;
        await connection.close().catch(() => undefined);
        try {
          await this.open();
        } catch {
          break;
        }
        const revived = this.hostConnection;
        if (!revived) break;
        try {
          return await requestOverKernelConnection(revived, method, params);
        } catch (retryError) {
          if (retryError instanceof RuntimeHostOperationError || this.closed) {
            throw translateKernelRequestError(retryError);
          }
          lastError = retryError;
          // 给断连传播与新 daemon 注册留出稳定窗口，避免在同一竞态上空转。
          await sleep(Math.min(KERNEL_RETRY_BACKOFF_MS, retryDeadline - performance.now()));
        }
      }
      throw translateKernelRequestError(lastError);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const connection = this.hostConnection;
    this.hostConnection = undefined;
    void connection?.close().catch(() => undefined);
  }

  private async openKernel(): Promise<void> {
    if (this.closed) {
      throw new RuntimeClientError("RUNTIME_CLIENT_CLOSED", "本机 Runtime 连接已关闭", true);
    }
    // 动态 spec 注册表是进程级的：client 侧的 decodeInput/decodeOutput 同样要能
    // 解析桥接操作（daemon 进程的注册不能代替本进程）。幂等。
    ensurePicoRuntimeHostOperationsRegistered();
    ensurePicoRuntimeHostEventOperationsRegistered();
    ensurePicoRuntimeHostShutdownOperationRegistered();
    const result = await connectOrSpawnRuntimeHost({
      rootPath: this.rootPath,
      surface: "tui",
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
      clientInstanceId: `pico-client-${randomUUID()}`,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      candidateEntrypoint: resolveDaemonCandidateEntrypoint(),
    });
    if (result.kind !== "connected") {
      throw new RuntimeClientError(
        "RUNTIME_UNAVAILABLE",
        "无法连接本机 Runtime daemon（runtime-host 选举失败）",
        true,
      );
    }
    const connection = result.connection;
    connection.setEventListener((event) => {
      this.eventListener?.(event as unknown as RuntimeNotification);
    });
    void connection.closed.then(
      () => this.handleKernelDisconnect(connection),
      () => this.handleKernelDisconnect(connection),
    );
    this.hostConnection = connection;
  }

  private handleKernelDisconnect(connection: RuntimeHostConnection): void {
    if (this.hostConnection !== connection) return;
    this.hostConnection = undefined;
    this.disconnectListener?.();
  }
}

function resolveDaemonCandidateEntrypoint(): string {
  const sourcePath = fileURLToPath(new URL("./main.ts", import.meta.url));
  if (existsSync(sourcePath)) return sourcePath;
  return fileURLToPath(new URL("./main.js", import.meta.url));
}

/** 单次桥接请求：events.* 走类型化桥接，其余方法走 runtime.request 通用桥接。 */
async function requestOverKernelConnection<Method extends RuntimeMethod>(
  connection: RuntimeHostConnection,
  method: Method,
  params: RuntimeParams<Method>,
): Promise<RuntimeResult<Method>> {
  if (method === "events.subscribe" || method === "events.replay") {
    return await connection.requestRegistered<RuntimeResult<Method>>(method, params);
  }
  const response = await connection.requestRegistered<{ result: RuntimeResult<Method> }>(
    "runtime.request",
    { method, params: params as Record<string, unknown> },
  );
  return response.result;
}

function translateKernelRequestError(error: unknown): RuntimeClientError {
  if (!(error instanceof RuntimeHostOperationError)) {
    // 传输/超时类失败按可重试断连处理：订阅环据此走重连退避。
    return new RuntimeClientError(
      "RUNTIME_DISCONNECTED",
      "本机 Runtime daemon 连接已断开",
      true,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  const code = mapHostOperationErrorCode(error.code);
  return new RuntimeClientError(code, error.message, code === "RUNTIME_UNAVAILABLE");
}

/** runtime-host 操作错误码 → daemon 协议错误码（桥接映射的逆向）。 */
function mapHostOperationErrorCode(code: string): string {
  switch (code) {
    case "invalid_request":
      return "INVALID_PARAMS";
    case "not_found":
      return "NOT_FOUND";
    case "operation_conflict":
      return "CONFLICT";
    case "capability_unavailable":
      return "FORBIDDEN";
    case "operation_unavailable":
      return "METHOD_NOT_FOUND";
    case "internal_failure":
      return "INTERNAL_ERROR";
    default:
      return "RUNTIME_UNAVAILABLE";
  }
}
