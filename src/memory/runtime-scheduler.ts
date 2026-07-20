import type { Job } from "./domain.js";
import type { MemoryRepository } from "./memory-repository.js";
import {
  MEMORY_PROPOSAL_EXTRACTOR_VERSION,
  MEMORY_PROPOSAL_JOB_TYPE,
  type TerminalMemoryEvidenceRef,
} from "./proposal-contracts.js";

const DEFAULT_MAX_ATTEMPTS = 3;

export interface MemoryReviewSchedulerPort {
  enqueue(input: TerminalMemoryEvidenceRef): Promise<void> | void;
}

/**
 * Durable scheduler over T1's canonical memory_jobs ledger. The cursor's eventId is the exact
 * user message; runId is re-read from the immutable terminal RuntimeEvent by the worker.
 */
export class MemoryReviewScheduler implements MemoryReviewSchedulerPort {
  constructor(
    private readonly repository: Pick<MemoryRepository, "createJob" | "listJobs" | "getSettings">,
  ) {}

  enqueue(input: TerminalMemoryEvidenceRef): void {
    const settings = this.repository.getSettings();
    if (!settings.enabled || !settings.autoPropose) return;
    const ref = normalizeRef(input);
    this.repository.createJob({
      type: MEMORY_PROPOSAL_JOB_TYPE,
      terminalEventId: ref.terminalEventId,
      extractorVersion: MEMORY_PROPOSAL_EXTRACTOR_VERSION,
      cursor: { sessionId: ref.sessionId, eventId: ref.userMessageEventId },
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      idempotencyKey: `memory-review:${ref.terminalEventId}:${ref.userMessageEventId}`,
    });
  }

  pending(): readonly Job[] {
    return this.repository.listJobs({ statuses: ["queued", "failed"], limit: 500 });
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
