import { randomUUID } from "node:crypto";
import {
  MODEL_CATALOG_RUNTIME_CAPABILITY,
  REVIEW_IDEMPOTENCY_RUNTIME_CAPABILITY,
  MEMORY_PAGINATION_RUNTIME_CAPABILITY,
  parseRuntimeResult,
  type RuntimeSessionSubscriptionFrame,
  type RuntimeTerminalFrame,
  TERMINAL_STREAM_RUNTIME_CAPABILITY,
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
const MAX_TERMINAL_LEASES = 32;
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
  private terminalStreamId: string = randomUUID();
  private terminalFrameDispose?: () => void;
  // UI view IDs may survive reconnects; Host lease IDs belong to one event generation.
  private readonly terminalLeaseIds = new Map<string, string>();
  private readonly terminalClientIds = new Map<string, string>();
  private readonly terminalScopes = new Map<
    string,
    SessionScope & {
      terminalId: string;
      resourceEpoch: string;
      streamId: string;
      clientStreamId: string;
    }
  >();
  private readonly pendingTerminalLeases = new Map<string, number>();
  private readonly pendingTerminalOpens = new Map<string, number>();
  private readonly pendingTerminalFrames: RuntimeTerminalFrame[] = [];
  private pendingTerminalBytes = 0;
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
      let terminalStreamId = this.terminalStreamId;
      let terminalLeaseId: string | undefined;
      let terminalAdmission: string | undefined;
      try {
        rpc = parseRemoteRequest(input);
        const { config, principal, client } = this.options;
        const authorized = await authorizeRuntimeRequest(config, principal, client, rpc);
        this.assertCurrent();
        const params = authorized.params as Record<string, unknown>;
        if (typeof params["streamId"] === "string") terminalStreamId = params["streamId"];
        const terminalKey = `${terminalStreamId}:${String(params["terminalId"])}`;
        if (rpc.method === "terminal.detach") {
          const scope = this.terminalScopes.get(terminalKey);
          if (generation !== this.eventGeneration || !scope) {
            publishResult({ detached: true });
            return;
          }
          terminalLeaseId = scope.streamId;
        }
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
        const terminalOpening = ["terminal.attach", "terminal.create"].includes(rpc.method)
          ? String(params["sessionId"])
          : undefined;
        if (terminalOpening && (!this.events || generation !== this.eventGeneration))
          throw new GatewayError(
            "RUNTIME_DISCONNECTED",
            "终端事件连接尚未就绪，请重新连接",
            503,
            true,
          );
        if (
          terminalOpening &&
          (!client.subscribeTerminalFrames ||
            !(await this.runtimeCapabilities()).has(TERMINAL_STREAM_RUNTIME_CAPABILITY))
        )
          throw new GatewayError(
            "UNSUPPORTED_CAPABILITY",
            "电脑尚未支持终端实时输出，请更新并重启 Pico",
            409,
          );
        this.assertCurrent();
        if (terminalOpening && (!this.events || generation !== this.eventGeneration))
          throw new GatewayError(
            "RUNTIME_DISCONNECTED",
            "终端事件连接已更换，请重新同步",
            503,
            true,
          );
        if (terminalOpening) {
          terminalAdmission =
            rpc.method === "terminal.attach" ? terminalKey : `create:${randomUUID()}`;
          const pending = [...this.pendingTerminalLeases.keys()].filter(
            (key) => !this.terminalScopes.has(key),
          ).length;
          if (
            !this.terminalScopes.has(terminalAdmission) &&
            !this.pendingTerminalLeases.has(terminalAdmission) &&
            this.terminalScopes.size + pending >= MAX_TERMINAL_LEASES
          )
            throw new GatewayError("RATE_LIMITED", "终端显示订阅过多", 429, true);
          this.pendingTerminalLeases.set(
            terminalAdmission,
            (this.pendingTerminalLeases.get(terminalAdmission) ?? 0) + 1,
          );
          terminalLeaseId = this.terminalLeaseIds.get(terminalStreamId);
          if (!terminalLeaseId) {
            terminalLeaseId = randomUUID();
            this.terminalLeaseIds.set(terminalStreamId, terminalLeaseId);
            this.terminalClientIds.set(terminalLeaseId, terminalStreamId);
          }
          this.pendingTerminalOpens.set(
            terminalLeaseId,
            (this.pendingTerminalOpens.get(terminalLeaseId) ?? 0) + 1,
          );
        }
        const opening =
          rpc.method === "session.subscription.open" ? String(params["sessionId"]) : undefined;
        if (opening)
          this.pendingSessionOpens.set(opening, (this.pendingSessionOpens.get(opening) ?? 0) + 1);
        dispatched = true;
        let value: unknown;
        try {
          value = projectRemoteResult(
            rpc.method,
            parseRuntimeResult(
              rpc.method,
              await client.request(
                rpc.method,
                ["terminal.create", "terminal.attach", "terminal.detach"].includes(rpc.method)
                  ? { ...authorized.params, streamId: terminalLeaseId! }
                  : authorized.params,
              ),
            ),
          );
        } finally {
          if (terminalOpening && generation === this.eventGeneration) {
            const left = (this.pendingTerminalOpens.get(terminalLeaseId!) ?? 1) - 1;
            if (left) this.pendingTerminalOpens.set(terminalLeaseId!, left);
            else this.pendingTerminalOpens.delete(terminalLeaseId!);
            const admissions = (this.pendingTerminalLeases.get(terminalAdmission!) ?? 1) - 1;
            if (admissions) this.pendingTerminalLeases.set(terminalAdmission!, admissions);
            else this.pendingTerminalLeases.delete(terminalAdmission!);
          }
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
        if (
          terminalOpening &&
          rpc.workspaceId &&
          value &&
          typeof value === "object" &&
          "terminal" in value &&
          value.terminal &&
          typeof value.terminal === "object" &&
          "terminalId" in value.terminal &&
          typeof value.terminal.terminalId === "string" &&
          "resourceEpoch" in value &&
          typeof value.resourceEpoch === "string"
        ) {
          if (!this.current || generation !== this.eventGeneration) {
            this.releaseTerminal(value.terminal.terminalId, {
              workspaceId: rpc.workspaceId,
              sessionId: terminalOpening,
              resourceEpoch: value.resourceEpoch,
              streamId: terminalLeaseId!,
            });
            this.assertCurrent(true);
            throw new GatewayError(
              "RUNTIME_DISCONNECTED",
              "终端事件连接已更换，请重新同步",
              503,
              true,
              "unknown",
            );
          }
          this.terminalScopes.set(`${terminalStreamId}:${value.terminal.terminalId}`, {
            terminalId: value.terminal.terminalId,
            workspaceId: rpc.workspaceId,
            sessionId: terminalOpening,
            resourceEpoch: value.resourceEpoch,
            streamId: terminalLeaseId!,
            clientStreamId: terminalStreamId,
          });
        }
        this.assertCurrent(true);
        if (
          rpc.method === "terminal.detach" &&
          generation === this.eventGeneration &&
          this.terminalScopes.get(terminalKey)?.streamId === terminalLeaseId
        )
          this.terminalScopes.delete(terminalKey);
        if (rpc.method === "session.subscription.close")
          this.sessionSubscriptions.delete(String(params["subscriptionId"]));
        publishResult(value);
        if (opening) this.flushFrames();
        if (terminalOpening) this.flushTerminalFrames();
        if (generation === this.eventGeneration) this.pruneTerminalLeaseIds();
      } catch (error) {
        if (generation === this.eventGeneration) {
          this.flushTerminalFrames();
          this.pruneTerminalLeaseIds();
        }
        throw safeGatewayError(error, dispatched);
      }
    });
  }

  attachEvents(sink: RuntimeAccessEventSink): RuntimeAccessEvents {
    this.assertCurrent();
    this.detachEvents();
    this.terminalStreamId = randomUUID();
    const binding: EventBinding = { sink, chain: Promise.resolve(), pending: 0 };
    this.events = binding;
    const publish = (event: Parameters<RuntimeAccessEventSink["publish"]>[0]): void => {
      if (this.current && this.events === binding) sink.publish(event);
    };
    const terminalFrames = this.options.client.subscribeTerminalFrames?.(
      (frame) => {
        if (!this.current || this.events !== binding) return;
        if (this.pendingTerminalOpens.has(frame.streamId ?? "")) {
          const bytes = Buffer.byteLength(JSON.stringify(frame));
          if (
            this.pendingTerminalFrames.length >= 128 ||
            this.pendingTerminalBytes + bytes > REMOTE_MAX_FRAME_BYTES
          ) {
            publish({ type: "disconnected", reason: "终端建立期间输出超过预算，请重新同步" });
            this.detachEvents();
            return;
          }
          this.pendingTerminalFrames.push(frame);
          this.pendingTerminalBytes += bytes;
        } else this.publishTerminalFrame(frame);
      },
      () => publish({ type: "disconnected", reason: "终端连接中断，请重新同步" }),
    );
    this.terminalFrameDispose = terminalFrames?.dispose;
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

  private publishTerminalFrame(frame: RuntimeTerminalFrame): void {
    const clientStreamId = this.terminalClientIds.get(frame.streamId ?? "");
    const scope = this.terminalScopes.get(`${clientStreamId}:${frame.terminalId}`);
    const principal = this.options.principal;
    if (
      !this.current ||
      !scope ||
      scope.sessionId !== frame.sessionId ||
      scope.resourceEpoch !== frame.resourceEpoch ||
      scope.streamId !== frame.streamId ||
      !principal.permissions.includes("terminal.control") ||
      !principal.workspaceIds.includes(scope.workspaceId)
    )
      return;
    this.events?.sink.publish({
      type: "terminal_frame",
      workspaceId: scope.workspaceId,
      frame: { ...frame, streamId: scope.clientStreamId },
    });
  }

  private pruneTerminalLeaseIds(): void {
    const active = new Set([...this.terminalScopes.values()].map((scope) => scope.streamId));
    for (const [clientId, leaseId] of this.terminalLeaseIds) {
      if (active.has(leaseId) || this.pendingTerminalOpens.has(leaseId)) continue;
      this.terminalLeaseIds.delete(clientId);
      this.terminalClientIds.delete(leaseId);
    }
  }

  private flushTerminalFrames(): void {
    const frames = this.pendingTerminalFrames.splice(0);
    this.pendingTerminalBytes = 0;
    for (const frame of frames) {
      if (this.pendingTerminalOpens.has(frame.streamId ?? "")) {
        this.pendingTerminalFrames.push(frame);
        this.pendingTerminalBytes += Buffer.byteLength(JSON.stringify(frame));
      } else this.publishTerminalFrame(frame);
    }
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

  private releaseTerminal(
    terminalId: string,
    scope: SessionScope & { resourceEpoch: string; streamId: string },
  ): void {
    const workspace = this.options.config.workspaces.find(
      (entry) => entry.id === scope.workspaceId,
    );
    if (workspace)
      void this.options.client
        .request("terminal.detach", {
          workspacePath: workspace.path,
          sessionId: scope.sessionId,
          terminalId,
          resourceEpoch: scope.resourceEpoch,
          streamId: scope.streamId,
        })
        .catch(() => undefined);
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
    this.terminalFrameDispose?.();
    this.terminalFrameDispose = undefined;
    for (const scope of this.terminalScopes.values()) this.releaseTerminal(scope.terminalId, scope);
    this.terminalScopes.clear();
    this.terminalLeaseIds.clear();
    this.terminalClientIds.clear();
    this.pendingTerminalLeases.clear();
    this.pendingTerminalOpens.clear();
    this.pendingTerminalFrames.length = 0;
    this.pendingTerminalBytes = 0;
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
