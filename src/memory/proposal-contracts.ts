import type { WorkspaceId } from "../paths/pico-paths.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import type { Fact, Job, MemoryJobCursor, MemoryKind, Proposal, Settings } from "./domain.js";

export const MEMORY_PROPOSAL_EXTRACTOR_VERSION = "memory-proposal-v1" as const;
export const MEMORY_PROPOSAL_JOB_TYPE = "terminal-extraction" as const;

export interface TerminalMemoryEvidenceRef {
  readonly sessionId: string;
  readonly runId: string;
  readonly terminalEventId: string;
  readonly userMessageEventId: string;
}

/** Exact, user-authored evidence. Raw text stays in runtime.sqlite. */
export interface UserMemoryEvidence extends TerminalMemoryEvidenceRef {
  readonly content: string;
  readonly eventIds: readonly string[];
  readonly startSequence: number;
  readonly endSequence: number;
  readonly terminalSequence: number;
  readonly digest: string;
  readonly sourceId: string;
  readonly cursor: MemoryJobCursor;
}

export type MemorySignalKind = "explicit" | "preference" | "correction" | "project_fact";

export interface MemorySignalDecision {
  readonly eligible: boolean;
  readonly signals: readonly MemorySignalKind[];
  readonly reason: "durable_signal" | "one_time_request" | "no_stable_signal";
}

export interface RawMemoryProposalCandidate {
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  readonly reason: string;
  readonly confidence: number;
  readonly evidenceEventIds: readonly string[];
}

export type MemorySafetyDisposition = "allow" | "quarantine" | "reject";

export interface SanitizedMemoryProposalCandidate extends RawMemoryProposalCandidate {
  readonly disposition: Exclude<MemorySafetyDisposition, "reject">;
  readonly safetyCodes: readonly string[];
}

export interface RejectedMemoryProposalCandidate {
  readonly disposition: "reject";
  readonly safetyCodes: readonly string[];
}

export type MemoryProposalSanitization =
  SanitizedMemoryProposalCandidate | RejectedMemoryProposalCandidate;

export interface MemoryProposalExtractionRequest {
  readonly workspaceId: WorkspaceId;
  readonly evidence: UserMemoryEvidence;
  readonly tool: ToolDefinition;
}

export interface MemoryProposalExtractionResult {
  readonly response: Message;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

/** Implemented by a host-owned worker; the proposal engine never detaches model work. */
export interface MemoryProposalModelPort {
  extract(
    request: MemoryProposalExtractionRequest,
    signal?: AbortSignal,
  ): Promise<MemoryProposalExtractionResult>;
  /** Optional host-side optimization; each returned item still belongs to exactly one evidence. */
  extractBatch?(
    requests: readonly MemoryProposalExtractionRequest[],
    signal?: AbortSignal,
  ): Promise<readonly MemoryProposalExtractionResult[]>;
}

export interface MemoryEvidenceReaderPort {
  read(ref: TerminalMemoryEvidenceRef): Promise<UserMemoryEvidence>;
}

export interface ProposalWriteCandidate {
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  readonly reason: string;
  readonly confidence: number;
  readonly conflictStatus: "none" | "potential";
  readonly conflictFactId?: string;
}

export interface CreateMemoryProposalJobInput {
  readonly terminalEventId: string;
  readonly extractorVersion: string;
  readonly cursor: MemoryJobCursor;
  readonly maxAttempts: number;
}

export interface MemoryProposalJobMetrics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface CommitMemoryProposalExtractionInput {
  readonly job: Job;
  readonly evidence: UserMemoryEvidence;
  readonly candidates: readonly ProposalWriteCandidate[];
  readonly metrics: MemoryProposalJobMetrics;
}

export interface CommitMemoryProposalExtractionResult {
  readonly job: Job;
  readonly proposals: readonly Proposal[];
}

/** Narrow storage port implemented over the Foundation repository. */
export interface MemoryProposalStorePort {
  readonly workspaceId: WorkspaceId;
  getSettings(): Settings;
  createOrGetJob(input: CreateMemoryProposalJobInput): Job;
  markJobRunning(job: Job): Job;
  markJobFailed(job: Job, errorCode: string, metrics: MemoryProposalJobMetrics): Job;
  listActiveFacts(): readonly Fact[];
  listPendingProposals(): readonly Proposal[];
  commitExtraction(
    input: CommitMemoryProposalExtractionInput,
  ): CommitMemoryProposalExtractionResult;
}

export interface ProcessMemoryProposalInput extends TerminalMemoryEvidenceRef {
  /** Host-preloaded evidence avoids duplicate runtime reads and permits lazy model acquisition. */
  readonly evidence?: UserMemoryEvidence;
  /** Cursor is returned to the worker only after a fully committed success. */
  readonly cursor?: MemoryJobCursor;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
}

export type MemoryProposalProcessResult =
  | {
      readonly status: "disabled" | "in_progress" | "attempts_exhausted";
      readonly job?: Job;
      readonly proposals: readonly Proposal[];
    }
  | {
      readonly status: "succeeded" | "already_succeeded";
      readonly job: Job;
      readonly proposals: readonly Proposal[];
      readonly advanceCursorTo: MemoryJobCursor;
      readonly rejectedCandidates: number;
      readonly quarantinedCandidates: number;
    }
  | {
      readonly status: "retryable_failure";
      readonly job: Job;
      readonly proposals: readonly Proposal[];
      readonly errorCode: string;
    };
