import type { Message } from "../schema/message.js";
import type {
  ConversationSearchStore,
  MemoryBackendStatus,
  MemorySearchResult,
} from "./memory-store.js";

export const DEFAULT_JSONL_MEMORY_MAX_ENTRIES = 10_000;
export const DEFAULT_JSONL_MEMORY_MAX_CONTENT_LENGTH = 32_000;
export const DEFAULT_JSONL_MEMORY_SEARCH_LIMIT = 10;
export const MAX_JSONL_MEMORY_SEARCH_LIMIT = 100;

export interface JsonlMemoryStoreOptions {
  maxEntries?: number;
  maxContentLength?: number;
  reason?: string;
  recommendation?: string;
  nodeVersion?: string;
  nodeModuleAbi?: string;
}

interface IndexedMessage {
  sessionId: string;
  turnIndex: number;
  role: string;
  content: string;
  normalizedContent: string;
  timestamp: string;
  sequence: number;
}

interface ScoredMessage {
  entry: IndexedMessage;
  relevance: number;
}

/**
 * Searchable in-process index rebuilt from Session JSONL messages.
 *
 * This store deliberately performs no file I/O. SessionStore remains the sole
 * owner of durable JSONL writes; this index is disposable and can be rebuilt by
 * calling replaceSession after Session recovery.
 */
export class JsonlMemoryStore implements ConversationSearchStore {
  readonly status: MemoryBackendStatus;

  private readonly maxEntries: number;
  private readonly maxContentLength: number;
  private entries: IndexedMessage[] = [];
  private nextSequence = 0;

  constructor(options: JsonlMemoryStoreOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_JSONL_MEMORY_MAX_ENTRIES);
    this.maxContentLength = positiveInteger(
      options.maxContentLength,
      DEFAULT_JSONL_MEMORY_MAX_CONTENT_LENGTH,
    );
    this.status = {
      backend: "jsonl_memory",
      state: "degraded",
      persistentSource: "session_jsonl",
      nodeVersion: options.nodeVersion ?? process.version,
      nodeModuleAbi: options.nodeModuleAbi ?? process.versions.modules,
      reason:
        options.reason ??
        "SQLite FTS5 unavailable; the search index is rebuilt from Session JSONL and is not stored separately.",
      ...(options.recommendation ? { recommendation: options.recommendation } : {}),
    };
  }

  insert(sessionId: string, turnIndex: number, message: Message): void {
    this.entries.push(this.toIndexedMessage(sessionId, turnIndex, message));
    this.evictOldestEntries();
  }

  replaceSession(sessionId: string, messages: readonly Message[]): void {
    this.entries = this.entries.filter((entry) => entry.sessionId !== sessionId);
    for (const [turnIndex, message] of messages.entries()) {
      this.entries.push(this.toIndexedMessage(sessionId, turnIndex, message));
    }
    this.evictOldestEntries();
  }

  search(
    query: string,
    limit = DEFAULT_JSONL_MEMORY_SEARCH_LIMIT,
    sessionId?: string,
  ): MemorySearchResult[] {
    const normalizedQuery = normalize(query).trim();
    if (!normalizedQuery) return [];

    const tokens = uniqueTokens(normalizedQuery);
    const effectiveLimit = clampLimit(limit);
    const scored: ScoredMessage[] = [];

    for (const entry of this.entries) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      const relevance = scoreContent(entry.normalizedContent, normalizedQuery, tokens);
      if (relevance <= 0) continue;
      scored.push({ entry, relevance });
    }

    return scored
      .sort(compareScoredMessages)
      .slice(0, effectiveLimit)
      .map(({ entry, relevance }) => ({
        sessionId: entry.sessionId,
        turnIndex: entry.turnIndex,
        role: entry.role,
        content: entry.content,
        timestamp: entry.timestamp,
        relevance,
      }));
  }

  close(): void {
    this.entries = [];
  }

  private toIndexedMessage(sessionId: string, turnIndex: number, message: Message): IndexedMessage {
    const content = truncateContent(message.content, this.maxContentLength);
    return {
      sessionId,
      turnIndex,
      role: message.role,
      content,
      normalizedContent: normalize(content),
      timestamp: new Date().toISOString(),
      sequence: this.nextSequence++,
    };
  }

  private evictOldestEntries(): void {
    const overflow = this.entries.length - this.maxEntries;
    if (overflow > 0) this.entries.splice(0, overflow);
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.trunc(value));
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_JSONL_MEMORY_SEARCH_LIMIT;
  return Math.min(MAX_JSONL_MEMORY_SEARCH_LIMIT, Math.max(1, Math.trunc(limit)));
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

function uniqueTokens(query: string): readonly string[] {
  return [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])];
}

function scoreContent(content: string, query: string, tokens: readonly string[]): number {
  let relevance = 0;
  const phraseOccurrences = countOccurrences(content, query);
  if (phraseOccurrences > 0) relevance += 1_000 + Math.min(phraseOccurrences, 20);

  let matchedTokens = 0;
  let tokenOccurrences = 0;
  for (const token of tokens) {
    const occurrences = countOccurrences(content, token);
    if (occurrences === 0) continue;
    matchedTokens++;
    tokenOccurrences += Math.min(occurrences, 10);
  }
  if (matchedTokens > 0) {
    relevance += matchedTokens * 100 + tokenOccurrences;
    if (matchedTokens === tokens.length && tokens.length > 1) relevance += 250;
  }

  return relevance;
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let fromIndex = 0;
  while (fromIndex < content.length) {
    const index = content.indexOf(needle, fromIndex);
    if (index < 0) break;
    count++;
    fromIndex = index + Math.max(1, needle.length);
  }
  return count;
}

function compareScoredMessages(left: ScoredMessage, right: ScoredMessage): number {
  if (left.relevance !== right.relevance) return right.relevance - left.relevance;
  if (left.entry.sessionId !== right.entry.sessionId) {
    return left.entry.sessionId < right.entry.sessionId ? -1 : 1;
  }
  if (left.entry.turnIndex !== right.entry.turnIndex) {
    return left.entry.turnIndex - right.entry.turnIndex;
  }
  return left.entry.sequence - right.entry.sequence;
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  let truncated = content.slice(0, maxLength);
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) truncated = truncated.slice(0, -1);
  return truncated;
}
