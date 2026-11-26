/**
 * Streaming Markdown data source.
 *
 * The source owns the raw text buffer and is the only place text accumulates.
 * Views subscribe with `useSyncExternalStore` and render the parsed snapshot, so
 * playback timing never blocks on rendering.
 *
 * Mechanism 2 of the reference implementation: text is merged before the view
 * is notified. `append` calls made in the same microtask produce a single
 * notification instead of one render per token.
 */

export interface StreamingMarkdownSnapshot {
  /** Full Markdown text committed so far. */
  readonly text: string;
  /** Monotonic commit counter; unchanged while appends are still merged. */
  readonly revision: number;
  /** True once `finish()` has been called. */
  readonly finished: boolean;
}

const EMPTY_SNAPSHOT: StreamingMarkdownSnapshot = { text: "", revision: 0, finished: false };

export class StreamingMarkdownSource {
  private text: string;
  private finished = false;
  private revision: number;
  private pending: string[] = [];
  private flushScheduled = false;
  private snapshot: StreamingMarkdownSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(initialText = "") {
    this.text = initialText;
    this.revision = initialText.length > 0 ? 1 : 0;
    this.snapshot =
      this.revision === 0
        ? EMPTY_SNAPSHOT
        : { text: this.text, revision: this.revision, finished: false };
  }

  /** Append a streamed chunk. Empty chunks are ignored. */
  readonly append = (chunk: string): void => {
    if (chunk.length === 0) return;
    if (this.finished) throw new Error("StreamingMarkdownSource is already finished");
    this.pending.push(chunk);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(this.commitPending);
  };

  /** Mark the stream complete and publish the final text synchronously. */
  readonly finish = (): void => {
    if (this.finished) return;
    this.flushScheduled = false;
    if (this.pending.length > 0) {
      this.text += this.pending.join("");
      this.pending = [];
      this.revision += 1;
    }
    this.finished = true;
    this.publish();
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Current committed snapshot; identity is stable until the next commit. */
  readonly getSnapshot = (): StreamingMarkdownSnapshot => this.snapshot;

  private readonly commitPending = (): void => {
    this.flushScheduled = false;
    if (this.pending.length === 0) {
      if (!this.finished) return;
      // finish() commits synchronously and publishes itself.
      return;
    }
    this.text += this.pending.join("");
    this.pending = [];
    this.revision += 1;
    this.publish();
  };

  private publish(): void {
    this.snapshot = { text: this.text, revision: this.revision, finished: this.finished };
    for (const listener of this.listeners) listener();
  }
}
