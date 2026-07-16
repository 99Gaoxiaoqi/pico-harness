import type {
  JsonValue,
  RuntimeNotification,
  RuntimeNotificationPage,
  RuntimeRequest,
} from "./protocol.js";

export interface RuntimeNotificationCursor {
  /** Exclusive event ID cursor. Omit it to read from the oldest retained event. */
  afterEventId?: string;
  /**
   * A durable cursor belongs to one workspace SQLite ledger. Callers observing more
   * than one workspace should replay each ledger independently.
   */
  workspacePath: string;
  /** Inclusive upper bound captured by the first replay page. */
  highWatermarkEventId?: string;
  /** Maximum number of events returned after filtering. */
  limit?: number;
}

export interface LocalRuntimeService {
  /** Handles non-subscription control requests. The daemon owns transport concerns. */
  handle(request: RuntimeRequest): Promise<JsonValue>;
  /** Returns retained events after an exclusive cursor, in ascending event order. */
  replayEvents(cursor: RuntimeNotificationCursor): Promise<RuntimeNotificationPage>;
  /** Registers a live event listener and returns an idempotent disposer. */
  subscribe(listener: (notification: RuntimeNotification) => void): () => void;
}

/** Separates bounded API shutdown from the point where another daemon may safely take ownership. */
export interface ShutdownOwnershipFence {
  /** True when callers must not wait inline for `released`. */
  readonly pending: boolean;
  /** Rejects when safe ownership release cannot be proven; callers must then fail closed. */
  readonly released: Promise<void>;
}

/** Optional capability for services that need orderly daemon shutdown. */
export interface DisposableLocalRuntimeService extends LocalRuntimeService {
  close?(): Promise<void> | void;
  shutdownOwnershipFence?(): ShutdownOwnershipFence;
}
