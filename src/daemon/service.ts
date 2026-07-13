import type { JsonValue, RuntimeEvent, RuntimeRequest } from "./protocol.js";

export interface RuntimeEventCursor {
  /** Exclusive event ID cursor. Omit it to read from the oldest retained event. */
  afterEventId?: string;
  /**
   * A durable cursor belongs to one workspace SQLite ledger. Callers observing more
   * than one workspace should replay each ledger independently.
   */
  workspacePath?: string;
}

export interface LocalRuntimeService {
  /** Handles non-subscription control requests. The daemon owns transport concerns. */
  handle(request: RuntimeRequest): Promise<JsonValue>;
  /** Returns retained events after an exclusive cursor, in ascending event order. */
  replayEvents(cursor: RuntimeEventCursor): Promise<readonly RuntimeEvent[]>;
  /** Registers a live event listener and returns an idempotent disposer. */
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
}

/** Optional capability for services that need orderly daemon shutdown. */
export interface DisposableLocalRuntimeService extends LocalRuntimeService {
  close?(): Promise<void> | void;
}
