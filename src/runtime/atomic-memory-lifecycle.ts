/** Host ownership covers snapshot preparation, queued execution and model disposal. */
export class AtomicMemoryLifecycle {
  private readonly tasks = new Set<Promise<unknown>>();
  private draining = false;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(private readonly acquireResidency?: () => { release(): void }) {}

  get isDraining(): boolean {
    return this.draining;
  }

  beginDrain(): void {
    this.draining = true;
  }

  run<T>(
    trigger: "remember" | "extract" | "compaction",
    operation: () => Promise<T>,
    unavailable: () => T,
  ): Promise<T> {
    // Late compaction may still record a disabled-policy barrier during shutdown.
    if (this.closed || (this.draining && trigger !== "compaction"))
      return Promise.resolve(unavailable());
    const residency = this.draining ? undefined : this.acquireResidency?.();
    const task = Promise.resolve()
      .then(operation)
      .finally(() => {
        try {
          residency?.release();
        } finally {
          this.tasks.delete(task);
        }
      });
    this.tasks.add(task);
    return task;
  }

  close(): Promise<void> {
    this.beginDrain();
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
    this.closed = true;
  }
}
