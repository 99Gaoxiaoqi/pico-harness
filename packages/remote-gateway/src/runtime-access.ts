import {
  MODEL_CATALOG_RUNTIME_CAPABILITY,
  REVIEW_IDEMPOTENCY_RUNTIME_CAPABILITY,
  MEMORY_PAGINATION_RUNTIME_CAPABILITY,
  parseRuntimeResult,
  type RuntimeSessionSubscriptionFrame,
} from "@pico/protocol";
import {
  parseRemoteRequest,
  REMOTE_MAX_FRAME_BYTES,
  type RemoteRequest,
} from "@pico/protocol/remote";
import { GatewayError, safeGatewayError } from "./errors.js";
import {
  authorizeRuntimeRequest,
  requirePermission,
  resolveDeviceWorkspace,
  type GatewayRuntimeClient,
} from "./policy.js";
import { projectRemoteResult } from "./access-projection.js";
import type {
  RuntimeAccessConfig,
  RuntimeAccessPrincipal,
  RuntimeAccessEventSink,
  RuntimeAccessEvents,
} from "./access-types.js";

export interface RuntimeAccessSessionOptions {
  readonly config: RuntimeAccessConfig;
  readonly principal: RuntimeAccessPrincipal;
  /** The client must be bound to principal.terminalOwnerId by the trusted adapter. */
  readonly client: GatewayRuntimeClient;
  /** Rechecked after awaits; changing or revoking a grant invalidates this session. */
  readonly isCurrent: () => boolean;
  readonly onReachable?: () => void;
}

type SessionScope = { workspaceId: string; sessionId: string };
interface EventBinding {
  readonly sink: RuntimeAccessEventSink;
  chain: Promise<void>;
  pending: number;
}

/**
 * One authenticated principal's access to Runtime. Adapters own authentication,
 * platform conversation bindings, wire encoding and delivery; this service owns
 * authorization, dispatch and subscriptions. It has no HTTP/WebSocket dependency.
 */
export class RuntimeAccessSession {
  private closed = false;
  private requests = 0;
  private eventGeneration = 0;
  private events?: EventBinding;
  private frameDispose?: () => void;
  private readonly sessionSubscriptions = new Map<string, SessionScope>();
  private readonly pendingSessionOpens = new Map<string, number>();
  private readonly pendingFrames: RuntimeSessionSubscriptionFrame[] = [];
  private pendingFrameBytes = 0;
  private readonly eventSubscriptions = new Map<string, () => void>();
  private readonly resources = new Set<() => void>();

  constructor(private readonly options: RuntimeAccessSessionOptions) {}

  private get current(): boolean {
    return !this.closed && !this.options.principal.revokedAt && this.options.isCurrent();
  }

  assertCurrent(dispatched = false): void {
    if (!this.current)
      throw new GatewayError(
        "DEVICE_REVOKED",
        "接入授权已失效",
        401,
        false,
        dispatched ? "unknown" : "not_executed",
      );
  }

  async withRequest<T>(operation: () => Promise<T>): Promise<T> {
    this.assertCurrent();
    if (this.requests >= 16) throw new GatewayError("RATE_LIMITED", "并发请求过多", 429, true);
    this.requests++;
    try {
      return await operation();
    } finally {
      this.requests--;
    }
  }

  trackResource(dispose: () => void): () => void {
    this.assertCurrent();
    this.resources.add(dispose);
    return () => this.resources.delete(dispose);
  }

  async runtimeCapabilities(): Promise<ReadonlySet<string>> {
    this.assertCurrent();
    try {
      const ping = parseRuntimeResult(
        "runtime.ping",
        await this.options.client.request("runtime.ping", {}),
      );
      this.assertCurrent();
      return new Set(ping.capabilities);
    } catch (error) {
      this.assertCurrent();
      if (error instanceof GatewayError) throw error;
      return new Set();
    }
  }

  /** Publish the result before releasing frames that arrived during subscription open. */
  async dispatch(input: unknown, publishResult: (value: unknown) => void): Promise<void> {
    return this.withRequest(async () => {
      let dispatched = false;
      let rpc: RemoteRequest | undefined;
      const generation = this.eventGeneration;
      try {
        rpc = parseRemoteRequest(input);
        const { config, principal, client } = this.options;
        const authorized = await authorizeRuntimeRequest(config, principal, client, rpc);
        this.assertCurrent();
        const params = authorized.params as Record<string, unknown>;
        if (
          rpc.method === "catalog.models" &&
          !(await this.runtimeCapabilities()).has(MODEL_CATALOG_RUNTIME_CAPABILITY)
        )
          throw new GatewayError(
            "METHOD_NOT_FOUND",
            "电脑尚未支持模型目录，请更新并重启 Pico",
            404,
          );
        if (
          (rpc.method === "changes.review" && params.idempotencyKey) ||
          (rpc.method === "memory.list" && params.paged)
        ) {
          const required =
            rpc.method === "changes.review"
              ? REVIEW_IDEMPOTENCY_RUNTIME_CAPABILITY
              : MEMORY_PAGINATION_RUNTIME_CAPABILITY;
          if (!(await this.runtimeCapabilities()).has(required))
            throw new GatewayError(
              "METHOD_NOT_FOUND",
              "电脑尚未支持此操作的可靠恢复，请更新并重启 Pico",
              404,
            );
        }
        if (
          rpc.method === "session.subscription.open" &&
          this.sessionSubscriptions.size +
            [...this.pendingSessionOpens.values()].reduce((a, b) => a + b, 0) >=
            16
        )
          throw new GatewayError("RATE_LIMITED", "会话订阅过多", 429);
        if (rpc.method === "session.subscription.close") {
          const owned = this.sessionSubscriptions.get(String(params["subscriptionId"]));
          if (
            !owned ||
            owned.workspaceId !== rpc.workspaceId ||
            owned.sessionId !== params["sessionId"]
          )
            throw new GatewayError("FORBIDDEN", "会话订阅不属于此接入身份", 403);
        }
        this.assertCurrent();
        if (rpc.method.startsWith("session.subscription.") && generation !== this.eventGeneration)
          throw new GatewayError("RUNTIME_DISCONNECTED", "事件连接已更换，请重新同步", 503, true);
        const opening =
          rpc.method === "session.subscription.open" ? String(params["sessionId"]) : undefined;
        if (opening)
          this.pendingSessionOpens.set(opening, (this.pendingSessionOpens.get(opening) ?? 0) + 1);
        dispatched = true;
        let value: unknown;
        try {
          value = projectRemoteResult(
            rpc.method,
            parseRuntimeResult(rpc.method, await client.request(rpc.method, authorized.params)),
          );
        } finally {
          // An older connection must not decrement a new connection's pending opens.
          if (opening && generation === this.eventGeneration) {
            const left = (this.pendingSessionOpens.get(opening) ?? 1) - 1;
            if (left) this.pendingSessionOpens.set(opening, left);
            else this.pendingSessionOpens.delete(opening);
          }
        }
        this.options.onReachable?.();
        if (
          opening &&
          rpc.workspaceId &&
          value &&
          typeof value === "object" &&
          "subscriptionId" in value &&
          typeof value.subscriptionId === "string"
        ) {
          const scope = { workspaceId: rpc.workspaceId, sessionId: opening };
          if (!this.current || generation !== this.eventGeneration) {
            this.releaseSession(value.subscriptionId, scope);
            this.assertCurrent(true);
            throw new GatewayError(
              "RUNTIME_DISCONNECTED",
              "事件连接已更换，请重新同步",
              503,
              true,
              "unknown",
            );
          }
          this.sessionSubscriptions.set(value.subscriptionId, scope);
        }
        this.assertCurrent(true);
        if (rpc.method === "session.subscription.close")
          this.sessionSubscriptions.delete(String(params["subscriptionId"]));
        publishResult(value);
        if (opening) this.flushFrames();
      } catch (error) {
        throw safeGatewayError(error, dispatched);
      }
    });
  }

  attachEvents(sink: RuntimeAccessEventSink): RuntimeAccessEvents {
    this.assertCurrent();
    this.detachEvents();
    const binding: EventBinding = { sink, chain: Promise.resolve(), pending: 0 };
    this.events = binding;
    const publish = (event: Parameters<RuntimeAccessEventSink["publish"]>[0]): void => {
      if (this.current && this.events === binding) sink.publish(event);
    };
    const frames = this.options.client.subscribeSessionFrames(
      (frame) => {
        if (!this.current || this.events !== binding) return;
        const scope = this.sessionSubscriptions.get(frame.subscriptionId);
        if (!scope && this.pendingSessionOpens.has(frame.sessionId)) {
          const bytes = Buffer.byteLength(JSON.stringify(frame));
          if (
            this.pendingFrames.length >= 64 ||
            this.pendingFrameBytes + bytes > REMOTE_MAX_FRAME_BYTES
          ) {
            this.pendingFrames.length = 0;
            this.pendingFrameBytes = 0;
            publish({ type: "disconnected", reason: "会话建立期间事件超过预算，请重新同步" });
          } else {
            this.pendingFrames.push(frame);
            this.pendingFrameBytes += bytes;
          }
        } else if (scope) this.publishFrame(scope, frame);
      },
      () => publish({ type: "disconnected", reason: "电脑 Runtime 连接中断，请重新同步会话" }),
    );
    this.frameDispose = frames.dispose;
    return {
      receive: (message) => {
        if (this.events !== binding || !this.current) return Promise.resolve();
        if (binding.pending >= 16) {
          this.detachEvents();
          return Promise.resolve();
        }
        binding.pending++;
        const task = binding.chain
          .then(async () => {
            if (this.events !== binding || !this.current) return;
            let subscriptionId: string | undefined;
            try {
              if (!message || typeof message !== "object" || Array.isArray(message))
                throw new GatewayError("INVALID_PARAMS", "订阅消息无效");
              const input = message as Record<string, unknown>;
              if (
                typeof input.subscriptionId !== "string" ||
                !/^[a-zA-Z0-9_-]{1,128}$/.test(input.subscriptionId)
              )
                throw new GatewayError("INVALID_PARAMS", "订阅标识无效");
              subscriptionId = input.subscriptionId;
              requirePermission(this.options.principal, "workspace.read");
              if (
                input.type === "unsubscribe" &&
                Object.keys(input).every((key) => ["type", "subscriptionId"].includes(key))
              ) {
                this.eventSubscriptions.get(subscriptionId)?.();
                this.eventSubscriptions.delete(subscriptionId);
                return;
              }
              if (
                input.type !== "subscribe" ||
                typeof input.workspaceId !== "string" ||
                (input.afterEventId !== undefined && typeof input.afterEventId !== "string") ||
                Object.keys(input).some(
                  (key) => !["type", "subscriptionId", "workspaceId", "afterEventId"].includes(key),
                )
              )
                throw new GatewayError("INVALID_PARAMS", "订阅消息无效");
              if (
                this.eventSubscriptions.size >= 16 &&
                !this.eventSubscriptions.has(subscriptionId)
              )
                throw new GatewayError("RATE_LIMITED", "工作区订阅过多", 429);
              const workspaceId = input.workspaceId;
              const workspace = resolveDeviceWorkspace(
                this.options.config,
                this.options.principal,
                workspaceId,
              );
              this.eventSubscriptions.get(subscriptionId)?.();
              this.eventSubscriptions.delete(subscriptionId);
              const subscription = await this.options.client.subscribe(
                {
                  workspacePath: workspace.path,
                  ...(typeof input.afterEventId === "string"
                    ? { afterEventId: input.afterEventId }
                    : {}),
                },
                (event) =>
                  publish({
                    type: "notification",
                    subscriptionId: subscriptionId!,
                    workspaceId,
                    event,
                  }),
              );
              if (!this.current || this.events !== binding) {
                subscription.dispose();
                return;
              }
              this.eventSubscriptions.set(subscriptionId, subscription.dispose);
              publish({
                type: "subscribed",
                subscriptionId,
                workspaceId,
                replay: subscription.replay,
              });
            } catch (error) {
              const safe = safeGatewayError(error);
              publish({
                type: "error",
                ...(subscriptionId ? { subscriptionId } : {}),
                error: { code: safe.code, message: safe.message, retryable: safe.retryable },
              });
            }
          })
          .finally(() => {
            binding.pending--;
          });
        binding.chain = task.catch(() => undefined);
        return task;
      },
      close: () => {
        // The adapter reports an already closed event stream; do not close its RPC transport.
        if (this.events === binding) this.detachEvents(false);
      },
    };
  }

  private publishFrame(scope: SessionScope, frame: RuntimeSessionSubscriptionFrame): void {
    if (
      !this.current ||
      scope.sessionId !== frame.sessionId ||
      !this.options.principal.workspaceIds.includes(scope.workspaceId)
    )
      return;
    this.events?.sink.publish({ type: "session_frame", workspaceId: scope.workspaceId, frame });
    if (frame.type === "subscription.closed")
      this.sessionSubscriptions.delete(frame.subscriptionId);
  }

  private flushFrames(): void {
    const frames = this.pendingFrames.splice(0);
    this.pendingFrameBytes = 0;
    for (const frame of frames) {
      const scope = this.sessionSubscriptions.get(frame.subscriptionId);
      if (scope) this.publishFrame(scope, frame);
      else if (this.pendingSessionOpens.has(frame.sessionId)) {
        this.pendingFrames.push(frame);
        this.pendingFrameBytes += Buffer.byteLength(JSON.stringify(frame));
      }
    }
  }

  private releaseSession(subscriptionId: string, scope: SessionScope): void {
    const workspace = this.options.config.workspaces.find(
      (entry) => entry.id === scope.workspaceId,
    );
    if (workspace)
      void this.options.client
        .request("session.subscription.close", {
          workspacePath: workspace.path,
          sessionId: scope.sessionId,
          subscriptionId,
        })
        .catch(() => undefined);
  }

  private detachEvents(closeSink = true): void {
    const previous = this.events;
    this.events = undefined;
    this.eventGeneration++;
    this.frameDispose?.();
    this.frameDispose = undefined;
    for (const dispose of this.eventSubscriptions.values()) dispose();
    this.eventSubscriptions.clear();
    for (const [id, scope] of this.sessionSubscriptions) this.releaseSession(id, scope);
    this.sessionSubscriptions.clear();
    this.pendingSessionOpens.clear();
    this.pendingFrames.length = 0;
    this.pendingFrameBytes = 0;
    if (closeSink) previous?.sink.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachEvents();
    for (const dispose of this.resources) dispose();
    this.resources.clear();
    this.options.client.close();
  }
}
