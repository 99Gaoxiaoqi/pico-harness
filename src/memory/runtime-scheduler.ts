import type { Job } from "./domain.js";
import { MemoryConflictError, type MemoryRepository } from "./memory-repository.js";
import {
  MEMORY_PROPOSAL_EXTRACTOR_VERSION,
  MEMORY_PROPOSAL_JOB_TYPE,
  type TerminalMemoryEvidenceRef,
} from "./proposal-contracts.js";

const DEFAULT_MAX_ATTEMPTS = 3;
export const MEMORY_REVIEW_LEASE_TTL_MS = 15 * 60 * 1_000;
export const MEMORY_REVIEW_PENDING_LIMIT = 500;
export const MEMORY_REVIEW_DEBOUNCE_MS = 60_000;

export interface MemoryReviewSchedulerOptions {
  readonly now?: () => Date;
  readonly leaseTtlMs?: number;
  readonly debounceMs?: number;
}

export interface MemoryReviewSchedulerPort {
  enqueue(input: TerminalMemoryEvidenceRef): Promise<void> | void;
}

/**
 * Durable scheduler over T1's canonical memory_jobs ledger. The cursor's eventId is the exact
 * user message; runId is re-read from the immutable terminal RuntimeEvent by the worker.
 */
export class MemoryReviewScheduler implements MemoryReviewSchedulerPort {
  constructor(
    private readonly repository: Pick<
      MemoryRepository,
      "createJob" | "listJobs" | "getSettings" | "updateJob"
    >,
    private readonly options: MemoryReviewSchedulerOptions = {},
  ) {}

  enqueue(input: TerminalMemoryEvidenceRef): void {
    const settings = this.repository.getSettings();
    if (!settings.enabled || !settings.autoPropose) return;
    const ref = normalizeRef(input);
    const debounceMs = this.options.debounceMs ?? MEMORY_REVIEW_DEBOUNCE_MS;
    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
      throw new Error("Memory review debounce must be non-negative");
    }
    const nextAttemptAt =
      debounceMs > 0
        ? new Date((this.options.now ?? (() => new Date()))().getTime() + debounceMs).toISOString()
        : undefined;
    this.repository.createJob({
      type: MEMORY_PROPOSAL_JOB_TYPE,
      terminalEventId: ref.terminalEventId,
      extractorVersion: MEMORY_PROPOSAL_EXTRACTOR_VERSION,
      cursor: { sessionId: ref.sessionId, eventId: ref.userMessageEventId },
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      ...(nextAttemptAt ? { nextAttemptAt } : {}),
      idempotencyKey: `memory-review:${ref.terminalEventId}:${ref.userMessageEventId}`,
    });
  }

  pending(): readonly Job[] {
    const now = (this.options.now ?? (() => new Date()))();
    this.recoverStaleRunningJobs(now.getTime());
    // Failed reviews are retryable until maxAttempts; delayed retries stay dormant in SQLite so
    // they cannot occupy the bounded page ahead of work that is ready now.
    return this.repository.listJobs({
      statuses: ["queued", "failed"],
      type: MEMORY_PROPOSAL_JOB_TYPE,
      extractorVersion: MEMORY_PROPOSAL_EXTRACTOR_VERSION,
      readyAt: now.toISOString(),
      attemptsRemaining: true,
      order: "oldest",
      limit: MEMORY_REVIEW_PENDING_LIMIT,
    });
  }

  private recoverStaleRunningJobs(now: number): void {
    const leaseTtlMs = this.options.leaseTtlMs ?? MEMORY_REVIEW_LEASE_TTL_MS;
    if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
      throw new Error("Memory review lease TTL must be positive");
    }
    for (const job of this.repository.listJobs({
      statuses: ["running"],
      type: MEMORY_PROPOSAL_JOB_TYPE,
      extractorVersion: MEMORY_PROPOSAL_EXTRACTOR_VERSION,
      limit: MEMORY_REVIEW_PENDING_LIMIT,
    })) {
      const updatedAt = Date.parse(job.updatedAt);
      if (!Number.isFinite(updatedAt) || updatedAt > now - leaseTtlMs) continue;
      try {
        this.repository.updateJob({
          jobId: job.jobId,
          expectedVersion: job.version,
          status: "failed",
          attemptCount: job.attemptCount,
          errorCode: "stale_worker_recovered",
          idempotencyKey: `memory-review-recover:${job.jobId}:${job.version}`,
        });
      } catch (error) {
        // Another process renewed or completed the job after this snapshot.
        if (error instanceof MemoryConflictError) continue;
        throw error;
      }
    }
  }
}

function normalizeRef(input: TerminalMemoryEvidenceRef): TerminalMemoryEvidenceRef {
  return {
    sessionId: requireText(input.sessionId, "sessionId"),
    runId: requireText(input.runId, "runId"),
    terminalEventId: requireText(input.terminalEventId, "terminalEventId"),
    userMessageEventId: requireText(input.userMessageEventId, "userMessageEventId"),
  };
}

function requireText(value: string, field: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 512) throw new Error(`Invalid ${field}`);
  return normalized;
}
