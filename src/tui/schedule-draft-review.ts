import type {
  CronDraft,
  CronDraftDecision,
  CronDraftId,
  CronDraftReviewer,
} from "../tasks/cron-draft.js";

export type ScheduleDraftReviewOutcome = CronDraftDecision["kind"] | "aborted";

export type ScheduleDraftReviewEvent =
  | { readonly kind: "pending"; readonly draft: CronDraft }
  | {
      readonly kind: "settled";
      readonly draft: CronDraft;
      readonly outcome: ScheduleDraftReviewOutcome;
      readonly decision?: CronDraftDecision;
    };

export type ScheduleDraftReviewListener = (event: ScheduleDraftReviewEvent) => void;

export interface ScheduleDraftReviewHandlerOptions {
  /** UI listener failures must never leave a review Promise pending. */
  readonly onListenerError?: (error: unknown) => void;
}

interface PendingScheduleDraftReview {
  readonly draft: CronDraft;
  readonly resolve: (decision: CronDraftDecision) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  readonly abortListener?: () => void;
}

/** Foreground review queue; durable scheduling remains outside this TUI boundary. */
export class ScheduleDraftReviewHandler implements CronDraftReviewer {
  private readonly pending = new Map<CronDraftId, PendingScheduleDraftReview>();
  private readonly listeners = new Set<ScheduleDraftReviewListener>();

  constructor(private readonly options: ScheduleDraftReviewHandlerOptions = {}) {}

  subscribe(listener: ScheduleDraftReviewListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  review(draft: CronDraft, signal?: AbortSignal): Promise<CronDraftDecision> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.pending.has(draft.draftId)) {
      return Promise.reject(new Error(`Schedule draftId already pending: ${draft.draftId}`));
    }

    return new Promise<CronDraftDecision>((resolve, reject) => {
      const abortListener = signal
        ? () => {
            const pending = this.take(draft.draftId);
            if (!pending) return;
            this.emit({ kind: "settled", draft: pending.draft, outcome: "aborted" });
            pending.reject(abortReason(signal));
          }
        : undefined;
      const pending: PendingScheduleDraftReview = {
        draft,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        ...(abortListener ? { abortListener } : {}),
      };

      this.pending.set(draft.draftId, pending);
      if (signal && abortListener) signal.addEventListener("abort", abortListener, { once: true });
      this.emit({ kind: "pending", draft });
    });
  }

  confirm(draftId: CronDraftId): boolean {
    return this.decide(draftId, "confirm");
  }

  modify(draftId: CronDraftId): boolean {
    return this.decide(draftId, "modify");
  }

  cancel(draftId: CronDraftId): boolean {
    return this.decide(draftId, "cancel");
  }

  decide(draftId: CronDraftId, kind: CronDraftDecision["kind"]): boolean {
    const pending = this.take(draftId);
    if (!pending) return false;
    const decision: CronDraftDecision = { kind, draftId: pending.draft.draftId };
    this.emit({ kind: "settled", draft: pending.draft, outcome: kind, decision });
    pending.resolve(decision);
    return true;
  }

  cancelAll(): number {
    const draftIds = [...this.pending.keys()];
    let cancelled = 0;
    for (const draftId of draftIds) {
      if (this.cancel(draftId)) cancelled++;
    }
    return cancelled;
  }

  getPendingDrafts(): readonly CronDraft[] {
    return [...this.pending.values()].map((entry) => entry.draft);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private take(draftId: CronDraftId): PendingScheduleDraftReview | undefined {
    const pending = this.pending.get(draftId);
    if (!pending) return undefined;
    this.pending.delete(draftId);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    return pending;
  }

  private emit(event: ScheduleDraftReviewEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        try {
          this.options.onListenerError?.(error);
        } catch {
          // Observability callbacks must not change review settlement semantics.
        }
      }
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Schedule draft review aborted", "AbortError");
}
