import { hasIncompleteToolExchange, type Message } from "@pico/core";

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
  readonly deferred: boolean;
  readonly toolResult: boolean;
  readonly appended: readonly Message[];
}

/** Disposable in-memory message projection owned by a live Runtime Session. */
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

  wouldDefer(message: Message): boolean {
    const hasToolCalls =
      message.role === "assistant" &&
      message.toolCalls !== undefined &&
      message.toolCalls.length > 0;
    const isToolResult = message.role === "user" && message.toolCallId !== undefined;
    return !isToolResult && !hasToolCalls && this.pendingToolCallIds.size > 0;
  }

  append(message: Message): SessionMessageAppendResult {
    const appended: Message[] = [];
    const prepared = this.prepareAppend(message);
    if (prepared.deferred) return { ...prepared, appended };
    this.appendPrepared(message, prepared, appended);
    return { ...prepared, appended };
  }

  appendProjected(messages: readonly Message[]): void {
    for (const message of messages) {
      this.history.push(message);
      this.applyMessageState(message);
    }
  }

  replace(messages: readonly Message[]): void {
    this.history = structuredClone([...messages]);
    this.deferredMessages = [];
    this.rebuildPendingToolState();
    this.rebuildToolResultMeta();
  }

  truncateTo(fromIndex: number): void {
    const start = Math.max(0, Math.trunc(fromIndex));
    this.history = structuredClone(start >= this.history.length ? [] : this.history.slice(start));
    this.pruneToolResultMeta();
  }

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

  compact(summary: Message, compactedCount: number): void {
    const count = Math.max(0, Math.min(this.history.length, Math.trunc(compactedCount)));
    this.history = structuredClone([summary, ...this.history.slice(count)]);
    this.pruneToolResultMeta();
  }

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
    if (hasToolCalls) {
      for (const toolCall of message.toolCalls ?? []) this.pendingToolCallIds.add(toolCall.id);
    }
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
