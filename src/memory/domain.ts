import type { WorkspaceId } from "../paths/pico-paths.js";
import type { EvidenceRef } from "../engine/evidence-ref.js";

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
 * Runtime logs and are deliberately not duplicated into the Memory state projection.
 *
 * Note on availability: rewind is now non-destructive (it forks into a new Session), so the
 * source Session's RuntimeEvents never change and a Source's ref stays valid forever. Only
 * `available` and `unavailable` (used by deleteSession) remain.
 */
export const SOURCE_AVAILABILITIES = ["available", "unavailable"] as const;
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
  /**
   * 统一溯源 overlay：把离散 eventIds 升级为带流身份的区间 cursor。
   * 可选字段，旧数据无此字段时平滑兼容。详见 engine/evidence-ref.ts。
   */
  readonly evidenceRef?: EvidenceRef;
  readonly availability: SourceAvailability;
  /**
   * 提取抑制标记（D11 forget 复活链收口）：该 Source 派生过的 Fact 被 forgetFact 后，
   * 账本仍保留原始证据（append-only），同证据重提取（extractor 版本升级 / 派生层重建
   * 补 Job）会绕过 forget postcondition 生成新 Fact。标记后提取链路对此 Source 一律
   * 抑制（取消 Job、不建提案）。隐私优先：与该 Source 关联的其余 Fact 也停止从同一
   * 证据更新——已遗忘内容绝不回流。仅抑制同证据（sourceId 由证据内容哈希决定）；
   * 用户在后续对话中重新陈述的信息走新 Source，属正常再学习。
   */
  readonly extractionSuppressedAt?: string;
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
  /** Actual provider calls attributed to this job; a microbatch records one call only once. */
  readonly modelCalls: number;
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
