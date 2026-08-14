import { RUNTIME_HOST_MAX_FRAME_BYTES } from "@pico/runtime-host";
import {
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  serializeRuntimeNotification,
  type RuntimeNotification,
  type RuntimeNotificationPage,
} from "./protocol.js";
import { canonicalizeWorkspacePath } from "./workspace-registry.js";
import { transportSafeRuntimeNotificationWithin } from "./workspace-runtime-service.js";
import type { RuntimeNotificationCursor } from "./service.js";
import {
  RUNTIME_HOST_BRIDGE_EVENTS_REPLAY,
  RUNTIME_HOST_BRIDGE_EVENTS_SUBSCRIBE,
  mapRuntimeErrorCode,
  type BridgeNotification,
  type BridgeOperationContext,
  type EventsReplayBridgeInput,
  type EventsReplayBridgeOutput,
  type EventsSubscribeBridgeInput,
  type EventsSubscribeBridgeOutput,
  type PicoBridgeEventHandlerMap,
} from "./runtime-host-operations.js";

/**
 * 3-B-2 event bridge: carries the daemon's events.subscribe / events.replay
 * semantics over the Runtime Host protocol.
 *
 * Daemon semantics preserved (see src/daemon/server.ts + workspace-runtime-service.ts):
 * - exclusive eventId cursor per workspace ledger; an expired cursor surfaces as
 *   INVALID_PARAMS (→ invalid_request) so clients reset and replay from scratch;
 * - high-watermark captured by the first page and fixed across pagination;
 *   hasMore means "cursor has not reached the high-watermark";
 * - subscribe = register listener first, then first replay page; live events may
 *   overtake the response — clients dedupe by eventId (daemon clients already do);
 * - one subscription per connection; connection teardown disposes it;
 * - fence-on-error: a push that cannot be delivered tears the connection down
 *   (kernel-side), the client reconnects and replays from its durable cursor.
 *
 * The one deliberate deviation: the runtime-host wire caps frames at 96KB (the
 * daemon IPC allowed 1MiB). Live pushes trim their payload against a byte
 * budget (same tiered trimming as the daemon's transport-safe notifications);
 * replay pages are repacked greedily to fit. A single durable event whose
 * serialized form exceeds the budget cannot be carried — it fails that replay
 * request with an explicit error instead of silently skipping the event.
 */

/** 96KB frame cap minus envelope reserve (event/response frame wrapper + safety). */
export const BRIDGE_EVENT_MAX_SERIALIZED_BYTES = RUNTIME_HOST_MAX_FRAME_BYTES - 4 * 1024;

/**
 * Minimal event surface the bridge needs. DesktopRuntimeService satisfies it;
 * tests may inject fakes.
 */
export interface RuntimeHostEventSource {
  subscribe(listener: (notification: RuntimeNotification) => void): () => void;
  replayEvents(cursor: RuntimeNotificationCursor): Promise<RuntimeNotificationPage>;
}

export interface RuntimeHostEventBridge {
  /** Handlers for events.subscribe / events.replay (satisfies PicoBridgeEventHandlerMap). */
  readonly handlers: PicoBridgeEventHandlerMap;
  /** Disposes the subscription held by a connection (kernel releaseConnection hook). */
  releaseConnection(connectionId: string): void;
  /** Disposes every subscription (composition beginDrain / close). */
  unsubscribeAll(): void;
}

// serializeRuntimeNotification 的返回在类型层是 JsonValue；运行时形状即
// BridgeNotification（decodeOutput 侧由 durableRuntimeNotificationResult 校验）。
type SerializedNotification = BridgeNotification;

type EventBridgeOutcome<Output> =
  | { ok: true; result: Output }
  | { ok: false; error: { code: ReturnType<typeof mapRuntimeErrorCode>; message: string } };

export function createRuntimeHostEventBridge(
  eventSource: RuntimeHostEventSource,
): RuntimeHostEventBridge {
  const subscriptions = new Map<string, () => void>();

  const releaseConnection = (connectionId: string): void => {
    const dispose = subscriptions.get(connectionId);
    if (!dispose) return;
    subscriptions.delete(connectionId);
    dispose();
  };

  const unsubscribeAll = (): void => {
    for (const dispose of subscriptions.values()) dispose();
    subscriptions.clear();
  };

  const eventsSubscribe = async (
    input: EventsSubscribeBridgeInput,
    context?: BridgeOperationContext,
  ): Promise<EventBridgeOutcome<EventsSubscribeBridgeOutput>> => {
    try {
      if (!context?.pushEvent || !context.connectionId) {
        throw new Error("events.subscribe 需要带推送通道的连接上下文");
      }
      const { pushEvent, connectionId } = context;
      // 每连接至多一个活跃订阅；重订阅覆盖旧的（对齐 daemon server 的 setSubscription
      // 覆盖语义——客户端 cursor 失效重置后的重订流程依赖它，不能拒绝）。
      const previousDispose = subscriptions.get(connectionId);
      if (previousDispose) {
        subscriptions.delete(connectionId);
        previousDispose();
      }
      const workspacePath = await canonicalizeWorkspacePath(input.workspacePath);
      // subscribe-then-replay：先注册 live 监听，再取首页。期间 live 事件可能先于
      // response 到达客户端，靠 eventId 去重衔接（daemon 同款顺序）。
      const dispose = eventSource.subscribe((event) => {
        if (event.scope.workspacePath !== workspacePath) return;
        deliverLiveEvent(event, pushEvent, () => releaseConnection(connectionId));
      });
      subscriptions.set(connectionId, dispose);
      const page = await eventSource.replayEvents({
        workspacePath,
        ...(input.afterEventId === undefined ? {} : { afterEventId: input.afterEventId }),
      });
      return { ok: true, result: { subscribed: true, ...packReplayPageForBridge(page) } };
    } catch (error) {
      return eventBridgeFailure(error);
    }
  };

  const eventsReplay = async (
    input: EventsReplayBridgeInput,
  ): Promise<EventBridgeOutcome<EventsReplayBridgeOutput>> => {
    try {
      const workspacePath = await canonicalizeWorkspacePath(input.workspacePath);
      const page = await eventSource.replayEvents({ ...input, workspacePath });
      return { ok: true, result: packReplayPageForBridge(page) };
    } catch (error) {
      return eventBridgeFailure(error);
    }
  };

  const handlers = {
    [RUNTIME_HOST_BRIDGE_EVENTS_SUBSCRIBE]: eventsSubscribe,
    [RUNTIME_HOST_BRIDGE_EVENTS_REPLAY]: eventsReplay,
  } satisfies PicoBridgeEventHandlerMap;

  return { handlers, releaseConnection, unsubscribeAll };
}

/**
 * Live push path: trim to the bridge byte budget, then hand to the kernel push
 * sink (serialized + flushed by the session). Any failure is a fence — the
 * kernel tears the connection down, so here we only ensure this subscription is
 * disposed and no rejection leaks.
 */
function deliverLiveEvent(
  event: RuntimeNotification,
  pushEvent: (event: Record<string, unknown>) => Promise<void>,
  disposeSubscription: () => void,
): void {
  try {
    const safe = transportSafeRuntimeNotificationWithin(
      event,
      BRIDGE_EVENT_MAX_SERIALIZED_BYTES,
    );
    void pushEvent(safe as unknown as Record<string, unknown>).catch(() =>
      disposeSubscription(),
    );
  } catch {
    // 裁剪失败（超预算的 live 事件）：fence 该连接，绝不静默跳过。
    disposeSubscription();
    void pushEvent({ fenced: true, eventId: event.eventId }).catch(() => undefined);
  }
}

function eventBridgeFailure(error: unknown): {
  ok: false;
  error: { code: ReturnType<typeof mapRuntimeErrorCode>; message: string };
} {
  if (error instanceof RuntimeProtocolError) {
    return {
      ok: false,
      error: { code: mapRuntimeErrorCode(error.code), message: error.message },
    };
  }
  return {
    ok: false,
    error: {
      code: "internal_failure",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * Repacks a service replay page to fit the bridge byte budget. Service pages are
 * bounded for the daemon's 1MiB frames; here events are serialized and packed
 * greedily until the budget, and hasMore is recomputed against the fixed
 * high-watermark so a truncated page simply continues on the next replay call.
 */
export function packReplayPageForBridge(page: RuntimeNotificationPage): {
  events: SerializedNotification[];
  hasMore: boolean;
  nextAfterEventId?: string;
  highWatermarkEventId?: string;
} {
  const packed: SerializedNotification[] = [];
  let packedBytes = 0;
  let nextAfterEventId = page.nextAfterEventId;
  for (const event of page.events) {
    const serialized = serializeRuntimeNotification(event) as unknown as SerializedNotification;
    const bytes = Buffer.byteLength(JSON.stringify(serialized), "utf8");
    if (packed.length === 0 && bytes > BRIDGE_EVENT_MAX_SERIALIZED_BYTES) {
      // 单事件超预算：显式失败（绝不静默跳过——那会让 cursor 越过丢失的事实）。
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.FRAME_TOO_LARGE,
        `事件 ${event.eventId} 序列化后超过 runtime-host 桥接页预算（${BRIDGE_EVENT_MAX_SERIALIZED_BYTES} 字节），无法经 96KB 帧承载`,
      );
    }
    if (packedBytes + bytes > BRIDGE_EVENT_MAX_SERIALIZED_BYTES) break;
    packed.push(serialized);
    packedBytes += bytes;
    nextAfterEventId = event.eventId;
  }
  const highWatermarkEventId = page.highWatermarkEventId;
  const hasMore =
    highWatermarkEventId !== undefined && nextAfterEventId !== highWatermarkEventId;
  return {
    events: packed,
    hasMore,
    ...(nextAfterEventId === undefined ? {} : { nextAfterEventId }),
    ...(highWatermarkEventId === undefined ? {} : { highWatermarkEventId }),
  };
}
