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
