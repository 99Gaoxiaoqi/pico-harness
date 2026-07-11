import type { Message } from "../schema/message.js";

export type MemoryBackendKind = "sqlite_fts5" | "jsonl_memory";
export type MemoryBackendState = "healthy" | "degraded";

/** TUI-visible health of the active conversation-search backend. */
export interface MemoryBackendStatus {
  backend: MemoryBackendKind;
  state: MemoryBackendState;
  /** Durable source from which the searchable index can be rebuilt. */
  persistentSource: "sqlite" | "session_jsonl";
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
  relevance: number;
}

/** Search index contract; persistence remains owned by SQLite or Session JSONL. */
export interface ConversationSearchStore {
  readonly status: MemoryBackendStatus;
  insert(sessionId: string, turnIndex: number, message: Message): void;
  replaceSession(sessionId: string, messages: readonly Message[]): void;
  search(query: string, limit?: number, sessionId?: string): MemorySearchResult[];
  close(): void;
}

export interface StoredSessionSummary {
  sessionId: string;
  summary: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Summary persistence is independent from the optional native SQLite index. */
export interface SessionSummaryStore {
  readonly persistent: boolean;
  save(sessionId: string, summary: string, messageCount: number): void;
  get(sessionId: string): StoredSessionSummary | null;
}
