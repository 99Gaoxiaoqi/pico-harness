/**
 * Coalescing trailing-edge throttle for visible streaming updates.
 *
 * Multiple requests inside one window collapse into the latest commit; the
 * pending commit runs once the window elapses. The reference implementation
 * throttles visible updates to ~50ms (configurable 50-120ms).
 */
export class VisibleUpdateScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: (() => void) | null = null;

  constructor(readonly delayMs: number) {}

  /** Register the latest commit; earlier pending commits in this window are dropped. */
  request(commit: () => void): void {
    this.pending = commit;
    if (this.timer !== null) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.runPending();
      },
      Math.max(0, this.delayMs),
    );
  }

  /** Run the latest pending commit now, e.g. when the stream finishes. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.runPending();
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  get isPending(): boolean {
    return this.timer !== null;
  }

  private runPending(): void {
    const commit = this.pending;
    this.pending = null;
    commit?.();
  }
}
