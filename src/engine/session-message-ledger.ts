import type { Message } from "../schema/message.js";
import { hasIncompleteToolExchange } from "../context/safe-compaction-boundary.js";

/** Metadata kept alongside a tool result without changing the Message schema. */
export interface SessionToolResultMeta {
  readonly cachedAt: number;
  accessCount: number;
}

export interface SessionMessageLedgerOptions {
  readonly now?: () => number;
  readonly messages?: readonly Message[];
}

export interface SessionMessageAppendResult {
  /** True when the incoming message was held behind an incomplete tool exchange. */
  readonly deferred: boolean;
  /** True when the incoming message is a tool result. */
  readonly toolResult: boolean;
  /** Messages appended by this operation, including released deferred messages. */
  readonly appended: readonly Message[];
}

/**
 * Disposable in-memory message projection owned by Session.
 *
 * Durable RuntimeEvent writes stay in Session/RuntimeRun. This class only owns
 * ordering state needed while a Session is live: model history, deferred
 * messages, pending tool calls, and tool-result access metadata.
 */
export class SessionMessageLedger {
  private history: Message[] = [];
  private deferredMessages: Message[] = [];
  private pendingToolCallIds = new Set<string>();
  private toolResultMeta = new Map<string, SessionToolResultMeta>();
  private readonly now: () => number;

  constructor(options: SessionMessageLedgerOptions = {}) {
    this.now = options.now ?? Date.now;
    if (options.messages !== undefined) this.replace(options.messages);
  }

  /** Read-only live view for Session's digest/index calculations. */
  readHistory(): readonly Message[] {
    return this.history;
  }

  get length(): number {
    return this.history.length;
  }

  get deferredCount(): number {
    return this.deferredMessages.length;
  }

  get pendingToolCallCount(): number {
    return this.pendingToolCallIds.size;
  }

  /**
   * Whether appending this message would be deferred. This is a pure check used
   * by exactly-once callers before they mutate the ledger.
   */
  wouldDefer(message: Message): boolean {
    const hasToolCalls =
      message.role === "assistant" &&
      message.toolCalls !== undefined &&
      message.toolCalls.length > 0;
    const isToolResult = message.role === "user" && message.toolCallId !== undefined;
    return !isToolResult && !hasToolCalls && this.pendingToolCallIds.size > 0;
  }

  /** Append one message while preserving assistant-tool-result ordering. */
  append(message: Message): SessionMessageAppendResult {
    const appended: Message[] = [];
    const prepared = this.prepareAppend(message);
    if (prepared.deferred) {
      return { ...prepared, appended };
    }

    this.appendPrepared(message, prepared, appended);
    return { ...prepared, appended };
  }

  /**
   * Apply messages already ordered by the durable RuntimeEvent projection.
   * This intentionally bypasses deferral because canonical projection is the
   * source of truth and must be replayed exactly as stored.
   */
  appendProjected(messages: readonly Message[]): void {
    for (const message of messages) {
      this.history.push(message);
      this.applyMessageState(message);
    }
  }

  /** Replace the complete disposable projection and rebuild all derived state. */
  replace(messages: readonly Message[]): void {
    this.history = structuredClone([...messages]);
    this.deferredMessages = [];
    this.rebuildPendingToolState();
    this.rebuildToolResultMeta();
  }

  /** Remove all messages before `fromIndex`, preserving only the suffix. */
  truncateTo(fromIndex: number): void {
    const start = Math.max(0, Math.trunc(fromIndex));
    this.history = structuredClone(start >= this.history.length ? [] : this.history.slice(start));
    // Keep ordering state compatible with the legacy Session hard-reset path:
    // truncate only removes metadata for results that no longer exist.
    this.pruneToolResultMeta();
  }

  /** Replace the history with an explicit prefix, optionally clearing ordering state. */
  retainPrefix(
    messageIndex: number,
    options: { readonly resetOrderingState?: boolean } = {},
  ): void {
    const end = Math.max(0, Math.trunc(messageIndex));
    this.history = structuredClone(this.history.slice(0, end));
    this.pruneToolResultMeta();
    if (options.resetOrderingState) {
      this.deferredMessages = [];
      this.pendingToolCallIds.clear();
    }
  }

  /** Replace a history prefix with one summary message. */
  compact(summary: Message, compactedCount: number): void {
    const count = Math.max(0, Math.min(this.history.length, Math.trunc(compactedCount)));
    this.history = structuredClone([summary, ...this.history.slice(count)]);
    this.pruneToolResultMeta();
  }

  /** Return a shallow message projection and count tool-result context accesses. */
  getModelContext(): Message[] {
    const context = this.history.map((message) => ({ ...message }));
    for (const message of context) {
      if (message.role !== "user" || message.toolCallId === undefined) continue;
      const meta = this.toolResultMeta.get(message.toolCallId);
      if (meta) meta.accessCount++;
    }
    return context;
  }

  getToolResultMeta(): ReadonlyMap<string, SessionToolResultMeta> {
    return this.toolResultMeta;
  }

  hasPendingToolResults(): boolean {
    return hasIncompleteToolExchange(this.history);
  }

  private prepareAppend(message: Message): {
    readonly deferred: boolean;
    readonly toolResult: boolean;
  } {
    const hasToolCalls =
      message.role === "assistant" &&
      message.toolCalls !== undefined &&
      message.toolCalls.length > 0;
    const toolResult = message.role === "user" && message.toolCallId !== undefined;

    // Tool calls are the ordering source and must enter history immediately.
    if (hasToolCalls) {
      for (const toolCall of message.toolCalls ?? []) this.pendingToolCallIds.add(toolCall.id);
    }

    // A result releases one pending call and starts its metadata lifetime.
    if (toolResult && message.toolCallId) {
      this.pendingToolCallIds.delete(message.toolCallId);
      if (!this.toolResultMeta.has(message.toolCallId)) {
        this.toolResultMeta.set(message.toolCallId, { cachedAt: this.now(), accessCount: 0 });
      }
    }

    const deferred = !toolResult && !hasToolCalls && this.pendingToolCallIds.size > 0;
    if (deferred) this.deferredMessages.push(message);
    return { deferred, toolResult };
  }

  private appendPrepared(
    message: Message,
    prepared: { readonly deferred: boolean; readonly toolResult: boolean },
    appended: Message[],
  ): void {
    if (prepared.deferred) return;
    this.history.push(message);
    appended.push(message);

    if (!prepared.toolResult || this.pendingToolCallIds.size !== 0) return;
    const deferred = this.deferredMessages;
    this.deferredMessages = [];
    for (const next of deferred) {
      const nextPrepared = this.prepareAppend(next);
      this.appendPrepared(next, nextPrepared, appended);
    }
  }

  private applyMessageState(message: Message): void {
    if (message.role === "assistant") {
      for (const toolCall of message.toolCalls ?? []) this.pendingToolCallIds.add(toolCall.id);
      return;
    }
    if (message.role !== "user" || !message.toolCallId) return;
    this.pendingToolCallIds.delete(message.toolCallId);
    if (!this.toolResultMeta.has(message.toolCallId)) {
      this.toolResultMeta.set(message.toolCallId, { cachedAt: this.now(), accessCount: 0 });
    }
  }

  private rebuildPendingToolState(): void {
    this.pendingToolCallIds.clear();
    for (const message of this.history) {
      if (message.role === "assistant") {
        for (const toolCall of message.toolCalls ?? []) this.pendingToolCallIds.add(toolCall.id);
      } else if (message.role === "user" && message.toolCallId) {
        this.pendingToolCallIds.delete(message.toolCallId);
      }
    }
  }

  private rebuildToolResultMeta(): void {
    this.toolResultMeta = new Map();
    const now = this.now();
    for (const message of this.history) {
      if (message.role !== "user" || !message.toolCallId) continue;
      if (!this.toolResultMeta.has(message.toolCallId)) {
        this.toolResultMeta.set(message.toolCallId, { cachedAt: now, accessCount: 0 });
      }
    }
  }

  /** Drop metadata for results no longer present after a suffix/prefix rewrite. */
  private pruneToolResultMeta(): void {
    if (this.toolResultMeta.size === 0) return;
    const live = new Set<string>();
    for (const message of this.history) {
      if (message.role === "user" && message.toolCallId) live.add(message.toolCallId);
    }
    for (const id of this.toolResultMeta.keys()) {
      if (!live.has(id)) this.toolResultMeta.delete(id);
    }
  }
}
