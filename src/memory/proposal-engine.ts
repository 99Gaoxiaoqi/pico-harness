import { createHash } from "node:crypto";
import type { Fact, Job, Proposal } from "./domain.js";
import { MemoryRepository } from "./memory-repository.js";
import {
  MEMORY_PROPOSAL_EXTRACTOR_VERSION,
  MEMORY_PROPOSAL_JOB_TYPE,
  type CommitMemoryProposalExtractionInput,
  type CommitMemoryProposalExtractionResult,
  type CreateMemoryProposalJobInput,
  type MemoryEvidenceReaderPort,
  type MemoryProposalJobMetrics,
  type MemoryProposalModelPort,
  type MemoryProposalProcessResult,
  type MemoryProposalStorePort,
  type ProcessMemoryProposalInput,
  type ProposalWriteCandidate,
  type RawMemoryProposalCandidate,
  type SanitizedMemoryProposalCandidate,
} from "./proposal-contracts.js";
import {
  MEMORY_PROPOSAL_TOOL,
  MemoryProposalParseError,
  parseMemoryProposalResponse,
} from "./proposal-parser.js";
import {
  normalizeMemoryIdentityText,
  sanitizeMemoryProposalCandidate,
} from "./proposal-sanitizer.js";
import { detectStableMemorySignal } from "./proposal-signal.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const QUARANTINE_PREFIX = "[SAFETY_REVIEW_REQUIRED]";

export interface MemoryProposalEngineOptions {
  readonly store: MemoryProposalStorePort;
  readonly evidenceReader: MemoryEvidenceReaderPort;
  readonly model: MemoryProposalModelPort;
  readonly extractorVersion?: string;
}

/**
 * Explicit worker operation. It never starts detached work and advances the caller cursor only
 * after Source, Proposal and Job success are committed together.
 */
export class MemoryProposalEngine {
  private readonly extractorVersion: string;

  constructor(private readonly options: MemoryProposalEngineOptions) {
    this.extractorVersion = options.extractorVersion ?? MEMORY_PROPOSAL_EXTRACTOR_VERSION;
  }

  async process(input: ProcessMemoryProposalInput): Promise<MemoryProposalProcessResult> {
    const settings = this.options.store.getSettings();
    if (!settings.enabled || !settings.autoPropose) {
      return { status: "disabled", proposals: [] };
    }
    const targetCursor = input.cursor ?? {
      sessionId: input.sessionId,
      eventId: input.terminalEventId,
    };
    let job = this.options.store.createOrGetJob({
      terminalEventId: input.terminalEventId,
      extractorVersion: this.extractorVersion,
      cursor: targetCursor,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    });
    if (job.status === "succeeded") {
      return {
        status: "already_succeeded",
        job,
        proposals: proposalsForJob(this.options.store.listPendingProposals(), job),
        advanceCursorTo: job.cursor,
        rejectedCandidates: 0,
        quarantinedCandidates: 0,
      };
    }
    if (job.status === "running") {
      return { status: "in_progress", job, proposals: [] };
    }
    if (job.status === "cancelled" || job.attemptCount >= job.maxAttempts) {
      return { status: "attempts_exhausted", job, proposals: [] };
    }

    job = this.options.store.markJobRunning(job);
    let metrics = emptyMetrics();
    try {
      input.signal?.throwIfAborted();
      const evidence = await this.options.evidenceReader.read(input);
      const decision = detectStableMemorySignal(evidence.content);
      if (!decision.eligible) {
        const committed = this.options.store.commitExtraction({
          job,
          evidence,
          candidates: [],
          metrics,
        });
        return successResult(committed, job.cursor, 0, 0);
      }

      const extraction = await this.options.model.extract(
        {
          workspaceId: this.options.store.workspaceId,
          evidence,
          tool: MEMORY_PROPOSAL_TOOL,
        },
        input.signal,
      );
      metrics = {
        inputTokens: nonNegativeInteger(extraction.inputTokens),
        outputTokens: nonNegativeInteger(extraction.outputTokens),
        costUsd: nonNegativeNumber(extraction.costUsd),
      };
      input.signal?.throwIfAborted();
      const activeFacts = this.options.store.listActiveFacts();
      const parsed = parseMemoryProposalResponse(extraction.response, evidence.eventIds).map(
        (candidate) =>
          stabilizeCandidateKind(
            candidate,
            evidence.content,
            decision.signals.includes("correction"),
            activeFacts,
          ),
      );
      const prepared = prepareCandidates(
        parsed.map(sanitizeMemoryProposalCandidate),
        activeFacts,
        this.options.store.listPendingProposals(),
      );
      const committed = this.options.store.commitExtraction({
        job,
        evidence,
        candidates: prepared.candidates,
        metrics,
      });
      return successResult(
        committed,
        job.cursor,
        prepared.rejectedCandidates,
        prepared.quarantinedCandidates,
      );
    } catch (error) {
      const errorCode = safeErrorCode(error);
      const failed = this.options.store.markJobFailed(job, errorCode, metrics);
      return { status: "retryable_failure", job: failed, proposals: [], errorCode };
    }
  }
}

const NAMED_BRANCH_REFERENCE_RE =
  /(?:\bfrom\s+(?:the\s+)?[A-Za-z0-9._/-]+\s+branch\b|(?:从|基于).{1,48}分支(?:发布|准备|构建)|(?:发布|发行).{0,24}(?:分支|branch))/iu;

/** Keep a narrow class of durable pointers deterministic when the model chooses project_fact. */
function stabilizeCandidateKind(
  candidate: RawMemoryProposalCandidate,
  evidence: string,
  explicitCorrection: boolean,
  activeFacts: readonly Fact[],
): RawMemoryProposalCandidate {
  const titleKey = normalizeMemoryIdentityText(candidate.title);
  const updatesExistingKind = activeFacts.some(
    (fact) => fact.title !== null && normalizeMemoryIdentityText(fact.title) === titleKey,
  );
  if (explicitCorrection && !updatesExistingKind && candidate.kind !== "correction") {
    return { ...candidate, kind: "correction" };
  }
  if (candidate.kind !== "project_fact" || !NAMED_BRANCH_REFERENCE_RE.test(evidence)) {
    return candidate;
  }
  return { ...candidate, kind: "reference" };
}

/** Foundation adapter. No model/runtime concern enters MemoryRepository. */
export class MemoryRepositoryProposalStore implements MemoryProposalStorePort {
  readonly workspaceId;

  constructor(private readonly repository: MemoryRepository) {
    this.workspaceId = repository.workspaceId;
  }

  getSettings() {
    return this.repository.getSettings();
  }

  createOrGetJob(input: CreateMemoryProposalJobInput): Job {
    return this.repository.createJob({
      type: MEMORY_PROPOSAL_JOB_TYPE,
      terminalEventId: input.terminalEventId,
      extractorVersion: input.extractorVersion,
      cursor: input.cursor,
      maxAttempts: input.maxAttempts,
      idempotencyKey: `proposal-job:${input.terminalEventId}:${input.extractorVersion}`,
    });
  }

  markJobRunning(job: Job): Job {
    return this.repository.updateJob({
      jobId: job.jobId,
      expectedVersion: job.version,
      status: "running",
      attemptCount: job.attemptCount + 1,
      nextAttemptAt: null,
      errorCode: null,
    });
  }

  markJobFailed(job: Job, errorCode: string, metrics: MemoryProposalJobMetrics): Job {
    return this.repository.updateJob({
      jobId: job.jobId,
      expectedVersion: job.version,
      status: "failed",
      errorCode,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      costUsd: metrics.costUsd,
    });
  }

  listActiveFacts(): readonly Fact[] {
    return this.repository.listFacts({ states: ["active"], limit: 500 });
  }

  listPendingProposals(): readonly Proposal[] {
    return this.repository.listProposals({ statuses: ["pending"], limit: 500 });
  }

  commitExtraction(
    input: CommitMemoryProposalExtractionInput,
  ): CommitMemoryProposalExtractionResult {
    return this.repository.transaction((repository) => {
      const source =
        input.candidates.length === 0
          ? undefined
          : repository.createSource({
              sourceId: input.evidence.sourceId,
              sessionId: input.evidence.sessionId,
              runId: input.evidence.runId,
              eventIds: input.evidence.eventIds,
              startSequence: input.evidence.startSequence,
              endSequence: input.evidence.endSequence,
              digest: input.evidence.digest,
              idempotencyKey: `proposal-source:${input.job.jobId}`,
            });
      const proposals = input.candidates.map((candidate) => {
        const identity = proposalIdentity(input.job, candidate);
        const proposal = repository.createProposal({
          proposalId: `proposal:${identity}`,
          kind: candidate.kind,
          title: candidate.title,
          content: candidate.content,
          reason: candidate.reason,
          confidence: candidate.confidence,
          ...(source ? { sourceId: source.sourceId } : {}),
          conflictStatus: candidate.conflictStatus,
          ...(candidate.conflictFactId ? { conflictFactId: candidate.conflictFactId } : {}),
          idempotencyKey: `proposal-create:${identity}`,
        });
        repository.enqueueProposedNotification(
          proposal,
          `proposal-notification:${proposal.proposalId}:${proposal.version}`,
        );
        return proposal;
      });
      const job = repository.updateJob({
        jobId: input.job.jobId,
        expectedVersion: input.job.version,
        status: "succeeded",
        ...(source ? { sourceId: source.sourceId } : {}),
        errorCode: null,
        inputTokens: input.metrics.inputTokens,
        outputTokens: input.metrics.outputTokens,
        costUsd: input.metrics.costUsd,
      });
      return { job, proposals };
    });
  }
}

function prepareCandidates(
  sanitized: ReturnType<typeof sanitizeMemoryProposalCandidate>[],
  activeFacts: readonly Fact[],
  pendingProposals: readonly Proposal[],
): {
  readonly candidates: ProposalWriteCandidate[];
  readonly rejectedCandidates: number;
  readonly quarantinedCandidates: number;
} {
  const candidates: ProposalWriteCandidate[] = [];
  const seenContents = new Set<string>();
  for (const fact of activeFacts) {
    if (fact.content) seenContents.add(normalizeMemoryIdentityText(fact.content));
  }
  for (const proposal of pendingProposals) {
    if (proposal.content) seenContents.add(normalizeMemoryIdentityText(proposal.content));
  }
  let rejectedCandidates = 0;
  let quarantinedCandidates = 0;
  for (const candidate of sanitized) {
    if (candidate.disposition === "reject") {
      rejectedCandidates++;
      continue;
    }
    const contentKey = normalizeMemoryIdentityText(candidate.content);
    if (!contentKey || seenContents.has(contentKey)) continue;
    seenContents.add(contentKey);
    const conflict = findConflict(candidate, activeFacts);
    const quarantined = candidate.disposition === "quarantine";
    if (quarantined) quarantinedCandidates++;
    candidates.push({
      kind: candidate.kind,
      title: candidate.title,
      content: candidate.content,
      reason: quarantined
        ? `${QUARANTINE_PREFIX} ${candidate.safetyCodes.join(",")}: ${candidate.reason}`
        : candidate.reason,
      confidence: candidate.confidence,
      conflictStatus: conflict ? "potential" : "none",
      ...(conflict ? { conflictFactId: conflict.factId } : {}),
    });
  }
  return { candidates, rejectedCandidates, quarantinedCandidates };
}

function findConflict(
  candidate: SanitizedMemoryProposalCandidate,
  activeFacts: readonly Fact[],
): Fact | undefined {
  const titleKey = normalizeMemoryIdentityText(candidate.title);
  const contentKey = normalizeMemoryIdentityText(candidate.content);
  if (!titleKey) return undefined;
  return activeFacts.find(
    (fact) =>
      fact.title !== null &&
      fact.content !== null &&
      normalizeMemoryIdentityText(fact.title) === titleKey &&
      normalizeMemoryIdentityText(fact.content) !== contentKey,
  );
}

function successResult(
  committed: CommitMemoryProposalExtractionResult,
  cursor: Job["cursor"],
  rejectedCandidates: number,
  quarantinedCandidates: number,
): MemoryProposalProcessResult {
  return {
    status: "succeeded",
    job: committed.job,
    proposals: committed.proposals,
    advanceCursorTo: cursor,
    rejectedCandidates,
    quarantinedCandidates,
  };
}

function proposalsForJob(proposals: readonly Proposal[], job: Job): Proposal[] {
  if (!job.sourceId) return [];
  return proposals.filter((proposal) => proposal.sourceId === job.sourceId);
}

function proposalIdentity(job: Job, candidate: ProposalWriteCandidate): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        jobId: job.jobId,
        kind: candidate.kind,
        title: normalizeMemoryIdentityText(candidate.title),
        content: normalizeMemoryIdentityText(candidate.content),
      }),
    )
    .digest("hex");
}

function safeErrorCode(error: unknown): string {
  if (error instanceof MemoryProposalParseError) return `parse_${error.code}`;
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof Reflect.get(error, "code") === "string"
  ) {
    return normalizeErrorCode(String(Reflect.get(error, "code")));
  }
  return "proposal_extraction_failed";
}

function normalizeErrorCode(value: string): string {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, "_")
    .slice(0, 120);
  return normalized || "proposal_extraction_failed";
}

function emptyMetrics(): MemoryProposalJobMetrics {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function nonNegativeInteger(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 0 ? value : 0;
}

function nonNegativeNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
