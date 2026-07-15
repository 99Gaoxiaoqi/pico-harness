import type { Message } from "../schema/message.js";

export const DEFAULT_MEMORY_SEARCH_LIMIT = 10;
export const MAX_MEMORY_SEARCH_LIMIT = 100;

/** Normalize the shared search limit contract for every memory backend. */
export function normalizeMemorySearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_MEMORY_SEARCH_LIMIT;
  return Math.min(MAX_MEMORY_SEARCH_LIMIT, Math.max(1, Math.trunc(limit)));
}

export type MemoryBackendKind = "sqlite_fts5" | "in_memory";
export type MemoryBackendState = "healthy" | "degraded";

/** TUI-visible health of the active conversation-search backend. */
export interface MemoryBackendStatus {
  backend: MemoryBackendKind;
  state: MemoryBackendState;
  /** Durable source from which the searchable index can be rebuilt. */
  persistentSource: "sqlite" | "none";
  nodeVersion: string;
  nodeModuleAbi?: string;
  reason?: string;
  recommendation?: string;
}

export interface MemorySearchResult {
  sessionId: string;
  turnIndex: number;
  role: string;
  content: string;
  timestamp: string;
  /** Backend-normalized relevance score; larger values are always more relevant. */
  relevance: number;
}

export interface ConversationProjectionCursor {
  logId: string;
  seq: number;
  epoch: number;
  eventId: string;
}

/**
 * Search index contract; conversation persistence remains owned by RuntimeEventStore.
 * Results are ordered by descending relevance and limit is clamped to 1..100.
 * Query syntax remains backend-specific: SQLite accepts FTS5 operators while
 * the in-memory fallback treats the query as normalized literal text/tokens.
 */
export interface ConversationSearchStore {
  readonly status: MemoryBackendStatus;
  insert(sessionId: string, turnIndex: number, message: Message): void;
  replaceSession(sessionId: string, messages: readonly Message[]): void;
  /** durable event commit 之后的原子投影；索引与 cursor 同一事务。 */
  projectInsert?(
    sessionId: string,
    turnIndex: number,
    message: Message,
    cursor: ConversationProjectionCursor,
  ): void;
  /**
   * Atomically appends one canonical projection delta and advances its cursor.
   * Returns false without changing either side when the stored cursor is stale.
   */
  projectAppend?(
    sessionId: string,
    startTurnIndex: number,
    messages: readonly Message[],
    expectedCursor: ConversationProjectionCursor,
    cursor: ConversationProjectionCursor,
  ): boolean;
  projectReplace?(
    sessionId: string,
    messages: readonly Message[],
    cursor: ConversationProjectionCursor,
  ): void;
  getProjectionCursor?(sessionId: string): ConversationProjectionCursor | undefined;
  search(query: string, limit?: number, sessionId?: string): MemorySearchResult[];
  close(): void;
}

export interface StoredSessionSummary {
  sessionId: string;
  summary: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  basis?: SessionSummaryBasis;
}

export interface SessionSummaryBasis {
  throughEventId: string | null;
  messageCount: number;
  prefixDigest: string | null;
}

/** Summary persistence is independent from the optional native SQLite index. */
export interface SessionSummaryStore {
  readonly persistent: boolean;
  save(sessionId: string, summary: string, messageCount: number, basis?: SessionSummaryBasis): void;
  get(sessionId: string): StoredSessionSummary | null;
  invalidateIfBeyond?(sessionId: string, boundary: SessionSummaryBasis): boolean;
}
