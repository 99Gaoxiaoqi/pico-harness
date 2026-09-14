import { RUNTIME_HOST_MAX_FRAME_BYTES } from "@pico/runtime-host";
import {
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  serializeRuntimeNotification,
  type RuntimeNotification,
  type RuntimeNotificationPage,
} from "@pico/protocol";
import { canonicalizeWorkspacePath } from "./workspace-registry.js";
import { transportSafeRuntimeNotificationWithin } from "./runtime-notification-transport.js";
import type { RuntimeNotificationCursor } from "./local-runtime-service.js";
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
 * Event bridge for events.subscribe / events.replay over the Runtime Host protocol.
 *
 * Current semantics:
 * - exclusive eventId cursor per workspace ledger; an expired cursor surfaces as
 *   INVALID_PARAMS (→ invalid_request) so clients reset and replay from scratch;
 * - high-watermark captured by the first page and fixed across pagination;
 *   hasMore means "cursor has not reached the high-watermark";
 * - subscribe = register listener first, then first replay page; live events may
 *   overtake the response — clients dedupe by eventId;
 * - one subscription per connection; connection teardown disposes it;
 * - fence-on-error: a push that cannot be delivered tears the connection down
 *   (kernel-side), the client reconnects and replays from its durable cursor.
 *
 * The Runtime Host wire caps frames at 1 MiB. Live pushes reserve envelope space
 * and trim their payload against the remaining byte budget; replay pages are
 * repacked greedily to fit. A single durable event whose serialized form exceeds
 * the budget fails that replay request explicitly instead of being skipped.
 */

/** 96KB frame cap minus envelope reserve (event/response frame wrapper + safety). */
export const BRIDGE_EVENT_MAX_SERIALIZED_BYTES = RUNTIME_HOST_MAX_FRAME_BYTES - 4 * 1024;

/** Minimal event surface the bridge needs; desktop and test fakes both satisfy it. */
export interface RuntimeHostEventSource {
  subscribe(listener: (notification: RuntimeNotification) => void): () => void;
  replayEvents(cursor: RuntimeNotificationCursor): Promise<RuntimeNotificationPage>;
}

export interface RuntimeHostEventBridge {
  readonly handlers: PicoBridgeEventHandlerMap;
  releaseConnection(connectionId: string): void;
  unsubscribeAll(): void;
}

// serializeRuntimeNotification returns JsonValue in the type system; decoding on the
// client validates the concrete durable notification shape.
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
      const previousDispose = subscriptions.get(connectionId);
      if (previousDispose) {
        subscriptions.delete(connectionId);
        previousDispose();
      }
      const workspacePath = await canonicalizeWorkspacePath(input.workspacePath);
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

function deliverLiveEvent(
  event: RuntimeNotification,
  pushEvent: (event: Record<string, unknown>) => Promise<void>,
  disposeSubscription: () => void,
): void {
  try {
    const safe = transportSafeRuntimeNotificationWithin(event, BRIDGE_EVENT_MAX_SERIALIZED_BYTES);
    void pushEvent(safe as unknown as Record<string, unknown>).catch(() => disposeSubscription());
  } catch {
    // A live event that cannot be represented fences the connection rather than
    // silently advancing a client's durable cursor.
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
 * Repack a daemon service replay page into the smaller runtime-host bridge
 * budget, retaining the original high-watermark pagination contract.
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
  const hasMore = highWatermarkEventId !== undefined && nextAfterEventId !== highWatermarkEventId;
  return {
    events: packed,
    hasMore,
    ...(nextAfterEventId === undefined ? {} : { nextAfterEventId }),
    ...(highWatermarkEventId === undefined ? {} : { highWatermarkEventId }),
  };
}
