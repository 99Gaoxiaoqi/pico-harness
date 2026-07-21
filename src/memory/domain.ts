import type { WorkspaceId } from "../paths/pico-paths.js";

export const MEMORY_KINDS = ["preference", "correction", "project_fact", "reference"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const FACT_STATES = ["active", "disabled", "archived", "forgotten"] as const;
export type FactState = (typeof FACT_STATES)[number];

export interface Fact {
  readonly factId: string;
  readonly workspaceId: WorkspaceId;
  readonly kind: MemoryKind;
  /** Cleared together with content when the fact is forgotten. */
  readonly title: string | null;
  /** A forgotten fact is an identity-only tombstone and never retains this body. */
  readonly content: string | null;
  readonly confidence: number;
  readonly sourceId?: string;
  readonly state: FactState;
  readonly pinned: boolean;
  readonly expiresAt?: string;
  readonly lastUsedAt?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly forgottenAt?: string;
}

export const PROPOSAL_STATUSES = ["pending", "accepted", "rejected", "deleted"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_CONFLICT_STATUSES = ["none", "potential", "confirmed", "resolved"] as const;
export type ProposalConflictStatus = (typeof PROPOSAL_CONFLICT_STATUSES)[number];

export interface Proposal {
  readonly proposalId: string;
  readonly workspaceId: WorkspaceId;
  readonly kind: MemoryKind;
  /** Deleted proposals keep only a no-body audit tombstone. */
  readonly title: string | null;
  readonly content: string | null;
  /** Human/model rationale; cleared when the proposal is deleted or its fact is forgotten. */
  readonly reason: string | null;
  readonly confidence: number;
  readonly sourceId?: string;
  readonly status: ProposalStatus;
  readonly conflictStatus: ProposalConflictStatus;
  readonly conflictFactId?: string;
  readonly resolvedFactId?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedAt?: string;
  readonly deletedAt?: string;
}

/**
 * Durable provenance contains identities and a digest only. Raw transcript excerpts belong in
 * runtime.sqlite and are deliberately not duplicated into memory.sqlite.
 */
export const SOURCE_AVAILABILITIES = ["available", "unavailable", "rewound"] as const;
export type SourceAvailability = (typeof SOURCE_AVAILABILITIES)[number];

export interface Source {
  readonly sourceId: string;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: string;
  readonly runId?: string;
  readonly branchId?: string;
  readonly eventIds: readonly string[];
  readonly startSequence?: number;
  readonly endSequence?: number;
  readonly digest: string;
  readonly availability: SourceAvailability;
  readonly invalidatedAt?: string;
  readonly invalidationCode?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const MUTATION_ENTITY_TYPES = ["settings", "fact", "proposal", "source", "job"] as const;
export type MutationEntityType = (typeof MUTATION_ENTITY_TYPES)[number];

export const MUTATION_ACTIONS = [
  "settings.updated",
  "fact.created",
  "fact.updated",
  "fact.forgotten",
  "proposal.created",
  "proposal.updated",
  "proposal.accepted",
  "proposal.rejected",
  "proposal.deleted",
  "source.created",
  "source.updated",
  "job.created",
  "job.updated",
] as const;
export type MutationAction = (typeof MUTATION_ACTIONS)[number];

/** Append-only, body-free audit record. */
export interface Mutation {
  readonly sequence: number;
  readonly mutationId: string;
  readonly workspaceId: WorkspaceId;
  readonly entityType: MutationEntityType;
  readonly entityId: string;
  readonly action: MutationAction;
  readonly fromVersion?: number;
  readonly toVersion: number;
  /** SHA-256 digest only; caller-provided keys never enter the audit ledger. */
  readonly idempotencyKeyHash?: string;
  readonly createdAt: string;
}

export const MEMORY_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type MemoryJobStatus = (typeof MEMORY_JOB_STATUSES)[number];

export interface MemoryJobCursor {
  readonly sessionId: string;
  readonly sequence?: number;
  readonly eventId?: string;
}

/** A body-free durable job cursor for future extraction/consolidation workers. */
export interface Job {
  readonly jobId: string;
  readonly workspaceId: WorkspaceId;
  readonly type: string;
  readonly status: MemoryJobStatus;
  /** Deduplication identity for post-terminal extraction. */
  readonly terminalEventId: string;
  readonly extractorVersion: string;
  readonly cursor: MemoryJobCursor;
  readonly sourceId?: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt?: string;
  readonly errorCode?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
}

/** Workspace-only behavior settings. Runtime trust gating remains an upper-layer responsibility. */
export interface Settings {
  readonly workspaceId: WorkspaceId;
  readonly enabled: boolean;
  readonly autoPropose: boolean;
  readonly autoCommit: boolean;
  readonly injectionEnabled: boolean;
  readonly reviewMode: MemoryReviewMode;
  readonly version: number;
  readonly updatedAt: string;
}

export const MEMORY_REVIEW_MODES = ["eco", "balanced", "quality"] as const;
export type MemoryReviewMode = (typeof MEMORY_REVIEW_MODES)[number];

export type MemoryFact = Fact;
export type MemoryProposal = Proposal;
export type MemorySource = Source;
export type MemoryMutation = Mutation;
export type MemoryJob = Job;
export type MemorySettings = Settings;
