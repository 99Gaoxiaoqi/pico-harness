import type { JsonValue, RuntimeNotification, RuntimeRequest } from "./protocol.js";

export interface RuntimeNotificationCursor {
  /** Exclusive event ID cursor. Omit it to read from the oldest retained event. */
  afterEventId?: string;
  /**
   * A durable cursor belongs to one workspace SQLite ledger. Callers observing more
   * than one workspace should replay each ledger independently.
   */
  workspacePath?: string;
  /** Maximum number of events returned after filtering. */
  limit?: number;
}

export interface LocalRuntimeService {
  /** Handles non-subscription control requests. The daemon owns transport concerns. */
  handle(request: RuntimeRequest): Promise<JsonValue>;
  /** Returns retained events after an exclusive cursor, in ascending event order. */
  replayEvents(cursor: RuntimeNotificationCursor): Promise<readonly RuntimeNotification[]>;
  /** Registers a live event listener and returns an idempotent disposer. */
  subscribe(listener: (notification: RuntimeNotification) => void): () => void;
}

/** Optional capability for services that need orderly daemon shutdown. */
export interface DisposableLocalRuntimeService extends LocalRuntimeService {
  close?(): Promise<void> | void;
}
