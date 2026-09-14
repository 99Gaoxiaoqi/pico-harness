export interface HookRewakeEntry {
  readonly id: string;
  readonly message: string;
}

/** Bounded, session-scoped queue for asynchronous Hook wake requests. */
export class HookRewakeQueue {
  private readonly pending = new Map<string, HookRewakeEntry>();
  private readonly subscribers = new Set<() => void>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly deliver: (entries: readonly HookRewakeEntry[]) => Promise<void>,
    private readonly capacity = 32,
  ) {}

  enqueue(message: string): boolean {
    if (this.closed || this.pending.size >= this.capacity) return false;
    const id = `hook-rewake-${this.nextId++}`;
    const notify = this.pending.size === 0;
    this.pending.set(id, { id, message });
    if (notify) for (const subscriber of this.subscribers) subscriber();
    return true;
  }

  pendingIds(): readonly string[] {
    return [...this.pending.keys()];
  }

  async deliverPending(ids: readonly string[]): Promise<readonly HookRewakeEntry[]> {
    const entries = ids.flatMap((id) => {
      const entry = this.pending.get(id);
      return entry ? [entry] : [];
    });
    if (entries.length === 0) return [];
    await this.deliver(entries);
    for (const entry of entries) this.pending.delete(entry.id);
    return entries;
  }

  subscribe(subscriber: () => void): () => void {
    if (this.closed) return () => undefined;
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
    this.subscribers.clear();
  }
}

export interface HookRewakeCoordinatorOptions {
  readonly queue: HookRewakeQueue;
  isIdle(): boolean;
  resume(ids: readonly string[], deliver: () => Promise<readonly HookRewakeEntry[]>): Promise<void>;
  onError?(error: unknown): void;
}

/** Coalesces a pending batch and resumes it only through the Host's serialized guard. */
export class HookRewakeCoordinator {
  private readonly unsubscribe: () => void;
  private scheduled = false;
  private running = false;
  private disposed = false;

  constructor(private readonly options: HookRewakeCoordinatorOptions) {
    this.unsubscribe = options.queue.subscribe(() => this.request());
    if (options.queue.hasPending) this.request();
  }

  notifyIdle(): void {
    this.request();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
  }

  private request(): void {
    if (this.disposed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.resumePending();
    });
  }

  private async resumePending(): Promise<void> {
    if (this.disposed || this.running || !this.options.isIdle()) return;
    const ids = this.options.queue.pendingIds();
    if (ids.length === 0) return;
    this.running = true;
    let delivered: readonly HookRewakeEntry[] | undefined;
    try {
      await this.options.resume(ids, async () => {
        delivered ??= await this.options.queue.deliverPending(ids);
        return delivered;
      });
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.running = false;
      if (delivered !== undefined && this.options.queue.hasPending) this.request();
    }
  }
}
