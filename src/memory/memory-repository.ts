import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { WorkspaceId } from "../paths/pico-paths.js";
import {
  FACT_STATES,
  MEMORY_JOB_STATUSES,
  MEMORY_KINDS,
  PROPOSAL_CONFLICT_STATUSES,
  PROPOSAL_STATUSES,
  SOURCE_AVAILABILITIES,
  type Fact,
  type FactState,
  type Job,
  type MemoryJobCursor,
  type MemoryJobStatus,
  type MemoryKind,
  type Mutation,
  type MutationAction,
  type MutationEntityType,
  type Proposal,
  type ProposalConflictStatus,
  type ProposalStatus,
  type Settings,
  type Source,
  type SourceAvailability,
} from "./domain.js";
import { migrateMemorySchema } from "./memory-schema.js";

const MAX_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 512;
const MAX_CONTENT_LENGTH = 32_000;
const MAX_REASON_LENGTH = 4_000;
const MAX_LIST_LIMIT = 500;

export interface MemoryRepositoryOptions {
  readonly databasePath: string;
  readonly workspaceId: WorkspaceId;
  readonly now?: () => Date;
}

export interface IdempotentWriteOptions {
  readonly idempotencyKey?: string;
}

export interface UpdateSettingsInput extends IdempotentWriteOptions {
  readonly expectedVersion: number;
  readonly enabled?: boolean;
  readonly autoPropose?: boolean;
  readonly autoCommit?: boolean;
  readonly injectionEnabled?: boolean;
}

export interface CreateSourceInput extends IdempotentWriteOptions {
  readonly sourceId?: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly branchId?: string;
  readonly eventIds?: readonly string[];
  readonly startSequence?: number;
  readonly endSequence?: number;
  readonly digest: string;
}

export interface UpdateSourceAvailabilityInput extends IdempotentWriteOptions {
  readonly sourceId: string;
  readonly expectedVersion: number;
  readonly availability: SourceAvailability;
  readonly invalidationCode?: string;
}

export interface CreateFactInput extends IdempotentWriteOptions {
  readonly factId?: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  readonly confidence?: number;
  readonly sourceId?: string;
  readonly state?: Exclude<FactState, "forgotten">;
  readonly pinned?: boolean;
  readonly expiresAt?: string;
  readonly lastUsedAt?: string;
}

export interface UpdateFactInput extends IdempotentWriteOptions {
  readonly factId: string;
  readonly expectedVersion: number;
  readonly kind?: MemoryKind;
  readonly title?: string;
  readonly content?: string;
  readonly confidence?: number;
  readonly sourceId?: string | null;
  readonly state?: Exclude<FactState, "forgotten">;
  readonly pinned?: boolean;
  readonly expiresAt?: string | null;
  readonly lastUsedAt?: string | null;
}

export interface ForgetFactInput extends IdempotentWriteOptions {
  readonly factId: string;
  readonly expectedVersion: number;
}

export interface FactListOptions {
  readonly states?: readonly FactState[];
  readonly kinds?: readonly MemoryKind[];
  readonly limit?: number;
}

export interface CreateProposalInput extends IdempotentWriteOptions {
  readonly proposalId?: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  readonly reason: string;
  readonly confidence?: number;
  readonly sourceId?: string;
  readonly conflictStatus?: ProposalConflictStatus;
  readonly conflictFactId?: string;
}

export interface UpdateProposalInput extends IdempotentWriteOptions {
  readonly proposalId: string;
  readonly expectedVersion: number;
  readonly kind?: MemoryKind;
  readonly title?: string;
  readonly content?: string;
  readonly reason?: string;
  readonly confidence?: number;
  readonly sourceId?: string | null;
  readonly conflictStatus?: ProposalConflictStatus;
  readonly conflictFactId?: string | null;
}

export interface DeleteProposalInput extends IdempotentWriteOptions {
  readonly proposalId: string;
  readonly expectedVersion: number;
}

export interface ResolveProposalInput extends IdempotentWriteOptions {
  readonly proposalId: string;
  readonly expectedVersion: number;
  readonly resolution: "accepted" | "rejected";
  readonly factId?: string;
}

export interface ResolveProposalResult {
  readonly proposal: Proposal;
  readonly fact?: Fact;
}

export interface ProposalListOptions {
  readonly statuses?: readonly ProposalStatus[];
  readonly limit?: number;
}

export interface MutationListOptions {
  readonly afterSequence?: number;
  readonly entityType?: MutationEntityType;
  readonly entityId?: string;
  readonly limit?: number;
}

export interface CreateJobInput extends IdempotentWriteOptions {
  readonly jobId?: string;
  readonly type: string;
  readonly terminalEventId: string;
  readonly extractorVersion: string;
  readonly cursor: MemoryJobCursor;
  readonly sourceId?: string;
  readonly maxAttempts?: number;
  readonly nextAttemptAt?: string;
}

export interface UpdateJobInput extends IdempotentWriteOptions {
  readonly jobId: string;
  readonly expectedVersion: number;
  readonly status?: MemoryJobStatus;
  readonly sourceId?: string | null;
  readonly attemptCount?: number;
  readonly maxAttempts?: number;
  readonly nextAttemptAt?: string | null;
  readonly errorCode?: string | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

export interface JobListOptions {
  readonly statuses?: readonly MemoryJobStatus[];
  readonly type?: string;
  readonly extractorVersion?: string;
  readonly limit?: number;
}

interface SettingsRow {
  readonly workspace_id: string;
  readonly enabled: number;
  readonly auto_propose: number;
  readonly auto_commit: number;
  readonly injection_enabled: number;
  readonly version: number;
  readonly updated_at: string;
}

interface SourceRow {
  readonly source_id: string;
  readonly workspace_id: string;
  readonly session_id: string;
  readonly run_id: string | null;
  readonly branch_id: string | null;
  readonly event_ids_json: string;
  readonly start_sequence: number | null;
  readonly end_sequence: number | null;
  readonly digest: string;
  readonly availability: string;
  readonly invalidated_at: string | null;
  readonly invalidation_code: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface FactRow {
  readonly fact_id: string;
  readonly workspace_id: string;
  readonly kind: string;
  readonly title: string | null;
  readonly content: string | null;
  readonly confidence: number;
  readonly source_id: string | null;
  readonly state: string;
  readonly pinned: number;
  readonly expires_at: string | null;
  readonly last_used_at: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly forgotten_at: string | null;
}

interface ProposalRow {
  readonly proposal_id: string;
  readonly workspace_id: string;
  readonly kind: string;
  readonly title: string | null;
  readonly content: string | null;
  readonly reason: string | null;
  readonly confidence: number;
  readonly source_id: string | null;
  readonly status: string;
  readonly conflict_status: string;
  readonly conflict_fact_id: string | null;
  readonly resolved_fact_id: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly reviewed_at: string | null;
  readonly deleted_at: string | null;
}

interface MutationRow {
  readonly sequence: number;
  readonly mutation_id: string;
  readonly workspace_id: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly action: string;
  readonly from_version: number | null;
  readonly to_version: number;
  readonly idempotency_key_hash: string | null;
  readonly created_at: string;
}

interface JobRow {
  readonly job_id: string;
  readonly workspace_id: string;
  readonly type: string;
  readonly status: string;
  readonly terminal_event_id: string;
  readonly extractor_version: string;
  readonly cursor_json: string;
  readonly source_id: string | null;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly next_attempt_at: string | null;
  readonly error_code: string | null;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_usd: number;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly terminal_at: string | null;
}

interface IdempotencyRow {
  readonly request_hash: string;
  readonly result_json: string;
}

export class MemoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryConflictError";
  }
}

export class MemoryNotFoundError extends Error {
  constructor(
    readonly entityType: string,
    readonly entityId: string,
  ) {
    super(`Unknown memory ${entityType}: ${entityId}`);
    this.name = "MemoryNotFoundError";
  }
}

export class MemoryIdempotencyConflictError extends MemoryConflictError {
  constructor(operation: string) {
    super(`Memory ${operation} idempotency key was used for another request`);
    this.name = "MemoryIdempotencyConflictError";
  }
}

/**
 * Workspace-scoped authority for long-term memory. All text-bearing records, body-free audit
 * mutations and idempotency claims share one SQLite transaction boundary.
 */
export class MemoryRepository {
  readonly databasePath: string;
  readonly workspaceId: WorkspaceId;
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private transactionDepth = 0;
  private secureCheckpointRequested = false;

  constructor(options: MemoryRepositoryOptions) {
    this.databasePath = resolve(options.databasePath);
    this.workspaceId = options.workspaceId;
    this.now = options.now ?? (() => new Date());
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.databasePath), 0o700);
    this.db = new Database(this.databasePath);
    try {
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("secure_delete = ON");
      migrateMemorySchema(this.db, this.workspaceId, () => this.timestamp());
      chmodSync(this.databasePath, 0o600);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  transaction<Result>(operation: (repository: this) => Result): Result {
    if (this.transactionDepth > 0) return operation(this);
    const checkpointWasPending = this.secureCheckpointRequested;
    try {
      const run = this.db.transaction(() => {
        this.transactionDepth += 1;
        try {
          return operation(this);
        } finally {
          this.transactionDepth -= 1;
        }
      });
      const result = run.immediate();
      if (this.secureCheckpointRequested) {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
        this.secureCheckpointRequested = false;
      }
      return result;
    } catch (error) {
      this.secureCheckpointRequested = checkpointWasPending;
      throw error;
    }
  }

  getSettings(): Settings {
    const row = this.db
      .prepare("SELECT * FROM memory_settings WHERE workspace_id = ?")
      .get(this.workspaceId) as SettingsRow | undefined;
    if (!row) throw new MemoryNotFoundError("settings", this.workspaceId);
    return mapSettings(row, this.workspaceId);
  }

  updateSettings(input: UpdateSettingsInput): Settings {
    requireExpectedVersion(input.expectedVersion);
    if (
      input.enabled === undefined &&
      input.autoPropose === undefined &&
      input.autoCommit === undefined &&
      input.injectionEnabled === undefined
    ) {
      throw new Error("Settings update must include at least one field");
    }
    return this.idempotentWrite(
      "settings.update",
      input.idempotencyKey,
      input,
      () => {
        const current = this.getSettings();
        assertVersion("settings", this.workspaceId, current.version, input.expectedVersion);
        const updatedAt = this.timestamp();
        const changed = this.db
          .prepare(
            `UPDATE memory_settings
             SET enabled = ?, auto_propose = ?, auto_commit = ?, injection_enabled = ?,
                 version = version + 1, updated_at = ?
             WHERE workspace_id = ? AND version = ?`,
          )
          .run(
            toSqlBoolean(input.enabled ?? current.enabled),
            toSqlBoolean(input.autoPropose ?? current.autoPropose),
            toSqlBoolean(input.autoCommit ?? current.autoCommit),
            toSqlBoolean(input.injectionEnabled ?? current.injectionEnabled),
            updatedAt,
            this.workspaceId,
            input.expectedVersion,
          );
        assertChanged(changed.changes, "settings", this.workspaceId);
        const result = this.getSettings();
        this.recordMutation(
          "settings",
          this.workspaceId,
          "settings.updated",
          current.version,
          result.version,
          input.idempotencyKey,
          updatedAt,
        );
        return { value: result, marker: { workspaceId: this.workspaceId } };
      },
      () => this.getSettings(),
    );
  }

  createSource(input: CreateSourceInput): Source {
    const normalized = normalizeSourceInput(input);
    return this.idempotentWrite(
      "source.create",
      input.idempotencyKey,
      normalized.request,
      () => {
        const sourceId = normalizeId(input.sourceId ?? `source:${randomUUID()}`, "sourceId");
        const at = this.timestamp();
        this.db
          .prepare(
            `INSERT INTO memory_sources(
               source_id, workspace_id, session_id, run_id, branch_id, event_ids_json,
               start_sequence, end_sequence, digest, availability, invalidated_at,
               invalidation_code, version, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', NULL, NULL, 1, ?, ?)`,
          )
          .run(
            sourceId,
            this.workspaceId,
            normalized.sessionId,
            normalized.runId ?? null,
            normalized.branchId ?? null,
            JSON.stringify(normalized.eventIds),
            normalized.startSequence ?? null,
            normalized.endSequence ?? null,
            normalized.digest,
            at,
            at,
          );
        const source = this.requireSource(sourceId);
        this.recordMutation(
          "source",
          sourceId,
          "source.created",
          undefined,
          source.version,
          input.idempotencyKey,
          at,
        );
        return { value: source, marker: { sourceId } };
      },
      (marker) => this.requireSource(readMarkerId(marker, "sourceId")),
    );
  }

  getSource(sourceId: string): Source | undefined {
    const row = this.db
      .prepare("SELECT * FROM memory_sources WHERE workspace_id = ? AND source_id = ?")
      .get(this.workspaceId, normalizeId(sourceId, "sourceId")) as SourceRow | undefined;
    return row ? mapSource(row, this.workspaceId) : undefined;
  }

  listSources(limit = 100): Source[] {
    const bounded = normalizeLimit(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_sources
         WHERE workspace_id = ? ORDER BY created_at DESC, source_id DESC LIMIT ?`,
      )
      .all(this.workspaceId, bounded) as SourceRow[];
    return rows.map((row) => mapSource(row, this.workspaceId));
  }

  updateSourceAvailability(input: UpdateSourceAvailabilityInput): Source {
    requireExpectedVersion(input.expectedVersion);
    requireEnum(input.availability, SOURCE_AVAILABILITIES, "availability");
    const invalidationCode =
      input.availability === "available"
        ? undefined
        : requireCode(input.invalidationCode, "invalidationCode");
    return this.idempotentWrite(
      "source.availability.update",
      input.idempotencyKey,
      { ...input, invalidationCode },
      () => {
        const current = this.requireSource(input.sourceId);
        assertVersion("source", current.sourceId, current.version, input.expectedVersion);
        const updatedAt = this.timestamp();
        const changed = this.db
          .prepare(
            `UPDATE memory_sources
             SET availability = ?, invalidated_at = ?, invalidation_code = ?,
                 version = version + 1, updated_at = ?
             WHERE workspace_id = ? AND source_id = ? AND version = ?`,
          )
          .run(
            input.availability,
            input.availability === "available" ? null : updatedAt,
            invalidationCode ?? null,
            updatedAt,
            this.workspaceId,
            current.sourceId,
            input.expectedVersion,
          );
        assertChanged(changed.changes, "source", current.sourceId);
        const result = this.requireSource(current.sourceId);
        this.recordMutation(
          "source",
          current.sourceId,
          "source.updated",
          current.version,
          result.version,
          input.idempotencyKey,
          updatedAt,
        );
        return { value: result, marker: { sourceId: current.sourceId } };
      },
      (marker) => this.requireSource(readMarkerId(marker, "sourceId")),
    );
  }

  createFact(input: CreateFactInput): Fact {
    const normalized = normalizeCreateFactInput(input);
    return this.idempotentWrite(
      "fact.create",
      input.idempotencyKey,
      normalized.request,
      () => {
        if (normalized.sourceId) this.requireSource(normalized.sourceId);
        const factId = normalizeId(input.factId ?? `fact:${randomUUID()}`, "factId");
        const at = this.timestamp();
        this.insertFact({ factId, ...normalized, at });
        const fact = this.requireFact(factId);
        this.recordMutation(
          "fact",
          factId,
          "fact.created",
          undefined,
          fact.version,
          input.idempotencyKey,
          at,
        );
        return { value: fact, marker: { factId } };
      },
      (marker) => this.requireFact(readMarkerId(marker, "factId")),
    );
  }

  getFact(factId: string): Fact | undefined {
    const row = this.db
      .prepare("SELECT * FROM memory_facts WHERE workspace_id = ? AND fact_id = ?")
      .get(this.workspaceId, normalizeId(factId, "factId")) as FactRow | undefined;
    return row ? mapFact(row, this.workspaceId) : undefined;
  }

  listFacts(options: FactListOptions = {}): Fact[] {
    const states = options.states?.map((state) => requireEnum(state, FACT_STATES, "state"));
    const kinds = options.kinds?.map((kind) => requireEnum(kind, MEMORY_KINDS, "kind"));
    const clauses = ["workspace_id = ?"];
    const params: Array<string | number> = [this.workspaceId];
    appendInFilter(clauses, params, "state", states);
    appendInFilter(clauses, params, "kind", kinds);
    params.push(normalizeLimit(options.limit));
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_facts WHERE ${clauses.join(" AND ")}
         ORDER BY pinned DESC, updated_at DESC, fact_id DESC LIMIT ?`,
      )
      .all(...params) as FactRow[];
    return rows.map((row) => mapFact(row, this.workspaceId));
  }

  updateFact(input: UpdateFactInput): Fact {
    requireExpectedVersion(input.expectedVersion);
    if (!hasDefinedPatch(input, FACT_PATCH_KEYS)) {
      throw new Error("Fact update must include at least one field");
    }
    const factId = normalizeId(input.factId, "factId");
    return this.idempotentWrite(
      "fact.update",
      input.idempotencyKey,
      input,
      () => {
        const current = this.requireFact(factId);
        if (current.state === "forgotten") {
          throw new MemoryConflictError(`Forgotten fact ${factId} cannot be updated`);
        }
        assertVersion("fact", factId, current.version, input.expectedVersion);
        const sourceId =
          input.sourceId === undefined ? current.sourceId : (input.sourceId ?? undefined);
        if (sourceId) this.requireSource(sourceId);
        const at = this.timestamp();
        const changed = this.db
          .prepare(
            `UPDATE memory_facts
             SET kind = ?, title = ?, content = ?, confidence = ?, source_id = ?, state = ?,
                 pinned = ?, expires_at = ?, last_used_at = ?, version = version + 1,
                 updated_at = ?
             WHERE workspace_id = ? AND fact_id = ? AND version = ? AND state <> 'forgotten'`,
          )
          .run(
            input.kind ? requireEnum(input.kind, MEMORY_KINDS, "kind") : current.kind,
            input.title === undefined
              ? current.title
              : requireText(input.title, "title", MAX_TITLE_LENGTH),
            input.content === undefined
              ? current.content
              : requireText(input.content, "content", MAX_CONTENT_LENGTH),
            input.confidence === undefined
              ? current.confidence
              : normalizeConfidence(input.confidence),
            sourceId ?? null,
            input.state ? requireNonForgottenState(input.state) : current.state,
            toSqlBoolean(input.pinned ?? current.pinned),
            input.expiresAt === undefined
              ? (current.expiresAt ?? null)
              : normalizeOptionalTimestamp(input.expiresAt, "expiresAt"),
            input.lastUsedAt === undefined
              ? (current.lastUsedAt ?? null)
              : normalizeOptionalTimestamp(input.lastUsedAt, "lastUsedAt"),
            at,
            this.workspaceId,
            factId,
            input.expectedVersion,
          );
        assertChanged(changed.changes, "fact", factId);
        const result = this.requireFact(factId);
        this.recordMutation(
          "fact",
          factId,
          "fact.updated",
          current.version,
          result.version,
          input.idempotencyKey,
          at,
        );
        return { value: result, marker: { factId } };
      },
      (marker) => this.requireFact(readMarkerId(marker, "factId")),
    );
  }

  forgetFact(input: ForgetFactInput): Fact {
    requireExpectedVersion(input.expectedVersion);
    const factId = normalizeId(input.factId, "factId");
    const result = this.idempotentWrite(
      "fact.forget",
      input.idempotencyKey,
      input,
      () => {
        const current = this.requireFact(factId);
        if (current.state === "forgotten") {
          throw new MemoryConflictError(`Fact ${factId} is already forgotten`);
        }
        assertVersion("fact", factId, current.version, input.expectedVersion);
        const at = this.timestamp();
        const linkedProposals = this.db
          .prepare(
            `SELECT proposal_id, version FROM memory_proposals
             WHERE workspace_id = ? AND (resolved_fact_id = ? OR conflict_fact_id = ?)
               AND status <> 'deleted'`,
          )
          .all(this.workspaceId, factId, factId) as Array<{
          readonly proposal_id: string;
          readonly version: number;
        }>;
        const changed = this.db
          .prepare(
            `UPDATE memory_facts
             SET title = NULL, content = NULL, state = 'forgotten', pinned = 0,
                 expires_at = NULL, last_used_at = NULL, version = version + 1,
                 updated_at = ?, forgotten_at = ?
             WHERE workspace_id = ? AND fact_id = ? AND version = ? AND state <> 'forgotten'`,
          )
          .run(at, at, this.workspaceId, factId, input.expectedVersion);
        assertChanged(changed.changes, "fact", factId);
        this.db
          .prepare(
            `UPDATE memory_proposals
             SET title = NULL, content = NULL, reason = NULL, status = 'deleted',
                 conflict_status = 'resolved', version = version + 1, updated_at = ?,
                 deleted_at = COALESCE(deleted_at, ?)
             WHERE workspace_id = ? AND (resolved_fact_id = ? OR conflict_fact_id = ?)
               AND status <> 'deleted'`,
          )
          .run(at, at, this.workspaceId, factId, factId);
        for (const proposal of linkedProposals) {
          this.recordMutation(
            "proposal",
            proposal.proposal_id,
            "proposal.deleted",
            proposal.version,
            proposal.version + 1,
            input.idempotencyKey,
            at,
          );
        }
        const forgotten = this.requireFact(factId);
        this.recordMutation(
          "fact",
          factId,
          "fact.forgotten",
          current.version,
          forgotten.version,
          input.idempotencyKey,
          at,
        );
        this.secureCheckpointRequested = true;
        return { value: forgotten, marker: { factId } };
      },
      (marker) => this.requireFact(readMarkerId(marker, "factId")),
    );
    return result;
  }

  createProposal(input: CreateProposalInput): Proposal {
    const normalized = normalizeCreateProposalInput(input);
    return this.idempotentWrite(
      "proposal.create",
      input.idempotencyKey,
      normalized.request,
      () => {
        if (normalized.sourceId) this.requireSource(normalized.sourceId);
        if (normalized.conflictFactId) this.requireFact(normalized.conflictFactId);
        const proposalId = normalizeId(
          input.proposalId ?? `proposal:${randomUUID()}`,
          "proposalId",
        );
        const at = this.timestamp();
        this.db
          .prepare(
            `INSERT INTO memory_proposals(
               proposal_id, workspace_id, kind, title, content, reason, confidence, source_id,
               status, conflict_status, conflict_fact_id, resolved_fact_id, version,
               created_at, updated_at, reviewed_at, deleted_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, 1, ?, ?, NULL, NULL)`,
          )
          .run(
            proposalId,
            this.workspaceId,
            normalized.kind,
            normalized.title,
            normalized.content,
            normalized.reason,
            normalized.confidence,
            normalized.sourceId ?? null,
            normalized.conflictStatus,
            normalized.conflictFactId ?? null,
            at,
            at,
          );
        const proposal = this.requireProposal(proposalId);
        this.recordMutation(
          "proposal",
          proposalId,
          "proposal.created",
          undefined,
          proposal.version,
          input.idempotencyKey,
          at,
        );
        return { value: proposal, marker: { proposalId } };
      },
      (marker) => this.requireProposal(readMarkerId(marker, "proposalId")),
    );
  }

  getProposal(proposalId: string): Proposal | undefined {
    const row = this.db
      .prepare("SELECT * FROM memory_proposals WHERE workspace_id = ? AND proposal_id = ?")
      .get(this.workspaceId, normalizeId(proposalId, "proposalId")) as ProposalRow | undefined;
    return row ? mapProposal(row, this.workspaceId) : undefined;
  }

  listProposals(options: ProposalListOptions = {}): Proposal[] {
    const statuses = options.statuses?.map((status) =>
      requireEnum(status, PROPOSAL_STATUSES, "status"),
    );
    const clauses = ["workspace_id = ?"];
    const params: Array<string | number> = [this.workspaceId];
    appendInFilter(clauses, params, "status", statuses);
    params.push(normalizeLimit(options.limit));
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_proposals WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, proposal_id DESC LIMIT ?`,
      )
      .all(...params) as ProposalRow[];
    return rows.map((row) => mapProposal(row, this.workspaceId));
  }

  updateProposal(input: UpdateProposalInput): Proposal {
    requireExpectedVersion(input.expectedVersion);
    if (!hasDefinedPatch(input, PROPOSAL_PATCH_KEYS)) {
      throw new Error("Proposal update must include at least one field");
    }
    const proposalId = normalizeId(input.proposalId, "proposalId");
    return this.idempotentWrite(
      "proposal.update",
      input.idempotencyKey,
      input,
      () => {
        const current = this.requireProposal(proposalId);
        if (current.status !== "pending") {
          throw new MemoryConflictError(`Proposal ${proposalId} is already ${current.status}`);
        }
        assertVersion("proposal", proposalId, current.version, input.expectedVersion);
        const sourceId =
          input.sourceId === undefined ? current.sourceId : (input.sourceId ?? undefined);
        const conflictFactId =
          input.conflictFactId === undefined
            ? current.conflictFactId
            : (input.conflictFactId ?? undefined);
        if (sourceId) this.requireSource(sourceId);
        if (conflictFactId) this.requireFact(conflictFactId);
        const at = this.timestamp();
        const changed = this.db
          .prepare(
            `UPDATE memory_proposals
             SET kind = ?, title = ?, content = ?, reason = ?, confidence = ?, source_id = ?,
                 conflict_status = ?, conflict_fact_id = ?, version = version + 1, updated_at = ?
             WHERE workspace_id = ? AND proposal_id = ? AND version = ? AND status = 'pending'`,
          )
          .run(
            input.kind ? requireEnum(input.kind, MEMORY_KINDS, "kind") : current.kind,
            input.title === undefined
              ? current.title
              : requireText(input.title, "title", MAX_TITLE_LENGTH),
            input.content === undefined
              ? current.content
              : requireText(input.content, "content", MAX_CONTENT_LENGTH),
            input.reason === undefined
              ? current.reason
              : requireText(input.reason, "reason", MAX_REASON_LENGTH),
            input.confidence === undefined
              ? current.confidence
              : normalizeConfidence(input.confidence),
            sourceId ?? null,
            input.conflictStatus
              ? requireEnum(input.conflictStatus, PROPOSAL_CONFLICT_STATUSES, "conflictStatus")
              : current.conflictStatus,
            conflictFactId ?? null,
            at,
            this.workspaceId,
            proposalId,
            input.expectedVersion,
          );
        assertChanged(changed.changes, "proposal", proposalId);
        const result = this.requireProposal(proposalId);
        this.recordMutation(
          "proposal",
          proposalId,
          "proposal.updated",
          current.version,
          result.version,
          input.idempotencyKey,
          at,
        );
        return { value: result, marker: { proposalId } };
      },
      (marker) => this.requireProposal(readMarkerId(marker, "proposalId")),
    );
  }

  deleteProposal(input: DeleteProposalInput): Proposal {
    requireExpectedVersion(input.expectedVersion);
    const proposalId = normalizeId(input.proposalId, "proposalId");
    const result = this.idempotentWrite(
      "proposal.delete",
      input.idempotencyKey,
      input,
      () => {
        const current = this.requireProposal(proposalId);
        if (current.status === "deleted") {
          throw new MemoryConflictError(`Proposal ${proposalId} is already deleted`);
        }
        assertVersion("proposal", proposalId, current.version, input.expectedVersion);
        const at = this.timestamp();
        const changed = this.db
          .prepare(
            `UPDATE memory_proposals
             SET title = NULL, content = NULL, reason = NULL, status = 'deleted',
                 version = version + 1, updated_at = ?, deleted_at = ?
             WHERE workspace_id = ? AND proposal_id = ? AND version = ? AND status <> 'deleted'`,
          )
          .run(at, at, this.workspaceId, proposalId, input.expectedVersion);
        assertChanged(changed.changes, "proposal", proposalId);
        const deleted = this.requireProposal(proposalId);
        this.recordMutation(
          "proposal",
          proposalId,
          "proposal.deleted",
          current.version,
          deleted.version,
          input.idempotencyKey,
          at,
        );
        this.secureCheckpointRequested = true;
        return { value: deleted, marker: { proposalId } };
      },
      (marker) => this.requireProposal(readMarkerId(marker, "proposalId")),
    );
    return result;
  }

  resolveProposal(input: ResolveProposalInput): ResolveProposalResult {
    requireExpectedVersion(input.expectedVersion);
    const proposalId = normalizeId(input.proposalId, "proposalId");
    if (input.resolution !== "accepted" && input.resolution !== "rejected") {
      throw new Error("Proposal resolution must be accepted or rejected");
    }
    return this.idempotentWrite(
      "proposal.resolve",
      input.idempotencyKey,
      input,
      () => {
        const current = this.requireProposal(proposalId);
        if (current.status !== "pending") {
          throw new MemoryConflictError(`Proposal ${proposalId} is already ${current.status}`);
        }
        assertVersion("proposal", proposalId, current.version, input.expectedVersion);
        const at = this.timestamp();
        let fact: Fact | undefined;
        if (input.resolution === "accepted") {
          const factId = normalizeId(input.factId ?? `fact:${randomUUID()}`, "factId");
          this.insertFact({
            factId,
            kind: current.kind,
            title: requireStoredText(current.title, "proposal title"),
            content: requireStoredText(current.content, "proposal content"),
            confidence: current.confidence,
            sourceId: current.sourceId,
            state: "active",
            pinned: false,
            at,
          });
          fact = this.requireFact(factId);
          this.recordMutation(
            "fact",
            factId,
            "fact.created",
            undefined,
            fact.version,
            input.idempotencyKey,
            at,
          );
        }
        const changed = this.db
          .prepare(
            `UPDATE memory_proposals
             SET status = ?, resolved_fact_id = ?, version = version + 1,
                 updated_at = ?, reviewed_at = ?
             WHERE workspace_id = ? AND proposal_id = ? AND version = ? AND status = 'pending'`,
          )
          .run(
            input.resolution,
            fact?.factId ?? null,
            at,
            at,
            this.workspaceId,
            proposalId,
            input.expectedVersion,
          );
        assertChanged(changed.changes, "proposal", proposalId);
        const proposal = this.requireProposal(proposalId);
        this.recordMutation(
          "proposal",
          proposalId,
          input.resolution === "accepted" ? "proposal.accepted" : "proposal.rejected",
          current.version,
          proposal.version,
          input.idempotencyKey,
          at,
        );
        const value: ResolveProposalResult = fact ? { proposal, fact } : { proposal };
        return {
          value,
          marker: { proposalId, ...(fact ? { factId: fact.factId } : {}) },
        };
      },
      (marker) => {
        const proposal = this.requireProposal(readMarkerId(marker, "proposalId"));
        const factId = readOptionalMarkerId(marker, "factId");
        return factId ? { proposal, fact: this.requireFact(factId) } : { proposal };
      },
    );
  }

  listMutations(options: MutationListOptions = {}): Mutation[] {
    const clauses = ["workspace_id = ?", "sequence > ?"];
    const params: Array<string | number> = [
      this.workspaceId,
      normalizeNonNegativeInteger(options.afterSequence ?? 0, "afterSequence"),
    ];
    if (options.entityType) {
      clauses.push("entity_type = ?");
      params.push(options.entityType);
    }
    if (options.entityId) {
      clauses.push("entity_id = ?");
      params.push(normalizeId(options.entityId, "entityId"));
    }
    params.push(normalizeLimit(options.limit));
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_mutations WHERE ${clauses.join(" AND ")}
         ORDER BY sequence ASC LIMIT ?`,
      )
      .all(...params) as MutationRow[];
    return rows.map((row) => mapMutation(row, this.workspaceId));
  }

  createJob(input: CreateJobInput): Job {
    const normalized = normalizeCreateJobInput(input);
    return this.idempotentWrite(
      "job.create",
      input.idempotencyKey,
      normalized.request,
      () => {
        if (normalized.sourceId) this.requireSource(normalized.sourceId);
        const existing = this.db
          .prepare(
            `SELECT * FROM memory_jobs
             WHERE workspace_id = ? AND terminal_event_id = ? AND extractor_version = ?`,
          )
          .get(this.workspaceId, normalized.terminalEventId, normalized.extractorVersion) as
          | JobRow
          | undefined;
        if (existing) {
          const job = mapJob(existing, this.workspaceId);
          if (!sameJobIdentity(job, normalized)) {
            throw new MemoryConflictError(
              `Terminal event ${normalized.terminalEventId} and extractor ${normalized.extractorVersion} already identify another memory job`,
            );
          }
          return { value: job, marker: { jobId: job.jobId } };
        }
        const jobId = normalizeId(input.jobId ?? `memory-job:${randomUUID()}`, "jobId");
        const at = this.timestamp();
        this.db
          .prepare(
            `INSERT INTO memory_jobs(
               job_id, workspace_id, type, status, terminal_event_id, extractor_version,
               cursor_json, source_id, attempt_count, max_attempts, next_attempt_at, error_code,
               input_tokens, output_tokens, cost_usd, version, created_at, updated_at, terminal_at
             ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?, NULL, 0, 0, 0, 1, ?, ?, NULL)`,
          )
          .run(
            jobId,
            this.workspaceId,
            normalized.type,
            normalized.terminalEventId,
            normalized.extractorVersion,
            JSON.stringify(normalized.cursor),
            normalized.sourceId ?? null,
            normalized.maxAttempts,
            normalized.nextAttemptAt ?? null,
            at,
            at,
          );
        const job = this.requireJob(jobId);
        this.recordMutation(
          "job",
          jobId,
          "job.created",
          undefined,
          job.version,
          input.idempotencyKey,
          at,
        );
        return { value: job, marker: { jobId } };
      },
      (marker) => this.requireJob(readMarkerId(marker, "jobId")),
    );
  }

  getJob(jobId: string): Job | undefined {
    const row = this.db
      .prepare("SELECT * FROM memory_jobs WHERE workspace_id = ? AND job_id = ?")
      .get(this.workspaceId, normalizeId(jobId, "jobId")) as JobRow | undefined;
    return row ? mapJob(row, this.workspaceId) : undefined;
  }

  listJobs(options: JobListOptions = {}): Job[] {
    const statuses = options.statuses?.map((status) =>
      requireEnum(status, MEMORY_JOB_STATUSES, "status"),
    );
    const clauses = ["workspace_id = ?"];
    const params: Array<string | number> = [this.workspaceId];
    appendInFilter(clauses, params, "status", statuses);
    if (options.type !== undefined) {
      clauses.push("type = ?");
      params.push(requireNonEmpty(options.type, "type", 128));
    }
    if (options.extractorVersion !== undefined) {
      clauses.push("extractor_version = ?");
      params.push(requireNonEmpty(options.extractorVersion, "extractorVersion", 128));
    }
    params.push(normalizeLimit(options.limit));
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_jobs WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, job_id DESC LIMIT ?`,
      )
      .all(...params) as JobRow[];
    return rows.map((row) => mapJob(row, this.workspaceId));
  }

  updateJob(input: UpdateJobInput): Job {
    requireExpectedVersion(input.expectedVersion);
    if (!hasDefinedPatch(input, JOB_PATCH_KEYS)) {
      throw new Error("Job update must include at least one field");
    }
    const jobId = normalizeId(input.jobId, "jobId");
    return this.idempotentWrite(
      "job.update",
      input.idempotencyKey,
      input,
      () => {
        const current = this.requireJob(jobId);
        assertVersion("job", jobId, current.version, input.expectedVersion);
        const sourceId =
          input.sourceId === undefined ? current.sourceId : (input.sourceId ?? undefined);
        if (sourceId) this.requireSource(sourceId);
        const status = input.status
          ? requireEnum(input.status, MEMORY_JOB_STATUSES, "status")
          : current.status;
        const terminalAt = isTerminalJobStatus(status) ? this.timestamp() : undefined;
        const updatedAt = terminalAt ?? this.timestamp();
        const changed = this.db
          .prepare(
            `UPDATE memory_jobs
             SET status = ?, source_id = ?, attempt_count = ?, max_attempts = ?,
                 next_attempt_at = ?, error_code = ?, input_tokens = ?, output_tokens = ?,
                 cost_usd = ?, version = version + 1, updated_at = ?, terminal_at = ?
             WHERE workspace_id = ? AND job_id = ? AND version = ?`,
          )
          .run(
            status,
            sourceId ?? null,
            normalizeNonNegativeInteger(input.attemptCount ?? current.attemptCount, "attemptCount"),
            normalizePositiveInteger(input.maxAttempts ?? current.maxAttempts, "maxAttempts"),
            input.nextAttemptAt === undefined
              ? (current.nextAttemptAt ?? null)
              : normalizeOptionalTimestamp(input.nextAttemptAt, "nextAttemptAt"),
            input.errorCode === undefined
              ? (current.errorCode ?? null)
              : normalizeOptionalCode(input.errorCode, "errorCode"),
            normalizeNonNegativeInteger(input.inputTokens ?? current.inputTokens, "inputTokens"),
            normalizeNonNegativeInteger(input.outputTokens ?? current.outputTokens, "outputTokens"),
            normalizeNonNegativeNumber(input.costUsd ?? current.costUsd, "costUsd"),
            updatedAt,
            terminalAt ?? (isTerminalJobStatus(current.status) ? current.terminalAt : null),
            this.workspaceId,
            jobId,
            input.expectedVersion,
          );
        assertChanged(changed.changes, "job", jobId);
        const job = this.requireJob(jobId);
        this.recordMutation(
          "job",
          jobId,
          "job.updated",
          current.version,
          job.version,
          input.idempotencyKey,
          updatedAt,
        );
        return { value: job, marker: { jobId } };
      },
      (marker) => this.requireJob(readMarkerId(marker, "jobId")),
    );
  }

  private insertFact(input: {
    readonly factId: string;
    readonly kind: MemoryKind;
    readonly title: string;
    readonly content: string;
    readonly confidence: number;
    readonly sourceId?: string;
    readonly state: Exclude<FactState, "forgotten">;
    readonly pinned: boolean;
    readonly expiresAt?: string;
    readonly lastUsedAt?: string;
    readonly at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO memory_facts(
           fact_id, workspace_id, kind, title, content, confidence, source_id, state,
           pinned, expires_at, last_used_at, version, created_at, updated_at, forgotten_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      )
      .run(
        input.factId,
        this.workspaceId,
        input.kind,
        input.title,
        input.content,
        input.confidence,
        input.sourceId ?? null,
        input.state,
        toSqlBoolean(input.pinned),
        input.expiresAt ?? null,
        input.lastUsedAt ?? null,
        input.at,
        input.at,
      );
  }

  private requireSource(sourceId: string): Source {
    const source = this.getSource(sourceId);
    if (!source) throw new MemoryNotFoundError("source", sourceId);
    return source;
  }

  private requireFact(factId: string): Fact {
    const fact = this.getFact(factId);
    if (!fact) throw new MemoryNotFoundError("fact", factId);
    return fact;
  }

  private requireProposal(proposalId: string): Proposal {
    const proposal = this.getProposal(proposalId);
    if (!proposal) throw new MemoryNotFoundError("proposal", proposalId);
    return proposal;
  }

  private requireJob(jobId: string): Job {
    const job = this.getJob(jobId);
    if (!job) throw new MemoryNotFoundError("job", jobId);
    return job;
  }

  private recordMutation(
    entityType: MutationEntityType,
    entityId: string,
    action: MutationAction,
    fromVersion: number | undefined,
    toVersion: number,
    idempotencyKey: string | undefined,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_mutations(
           mutation_id, workspace_id, entity_type, entity_id, action, from_version,
           to_version, idempotency_key_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `mutation:${randomUUID()}`,
        this.workspaceId,
        entityType,
        entityId,
        action,
        fromVersion ?? null,
        toVersion,
        idempotencyKey ? hashOpaqueKey(normalizeIdempotencyKey(idempotencyKey)) : null,
        createdAt,
      );
  }

  private idempotentWrite<Result>(
    operation: string,
    idempotencyKey: string | undefined,
    request: unknown,
    execute: () => { readonly value: Result; readonly marker: Readonly<Record<string, string>> },
    replay: (marker: Readonly<Record<string, unknown>>) => Result,
  ): Result {
    return this.transaction(() => {
      if (!idempotencyKey) return execute().value;
      const key = normalizeIdempotencyKey(idempotencyKey);
      const keyHash = hashOpaqueKey(key);
      const requestHash = hashCanonicalJson(request);
      const existing = this.db
        .prepare(
          `SELECT request_hash, result_json FROM memory_idempotency
           WHERE workspace_id = ? AND operation = ? AND idempotency_key_hash = ?`,
        )
        .get(this.workspaceId, operation, keyHash) as IdempotencyRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new MemoryIdempotencyConflictError(operation);
        }
        return replay(parseMarker(existing.result_json));
      }
      const result = execute();
      this.db
        .prepare(
          `INSERT INTO memory_idempotency(
             workspace_id, operation, idempotency_key_hash, request_hash, result_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.workspaceId,
          operation,
          keyHash,
          requestHash,
          JSON.stringify(result.marker),
          this.timestamp(),
        );
      return result.value;
    });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

const FACT_PATCH_KEYS = [
  "kind",
  "title",
  "content",
  "confidence",
  "sourceId",
  "state",
  "pinned",
  "expiresAt",
  "lastUsedAt",
] as const;

const PROPOSAL_PATCH_KEYS = [
  "kind",
  "title",
  "content",
  "reason",
  "confidence",
  "sourceId",
  "conflictStatus",
  "conflictFactId",
] as const;

const JOB_PATCH_KEYS = [
  "status",
  "sourceId",
  "attemptCount",
  "maxAttempts",
  "nextAttemptAt",
  "errorCode",
  "inputTokens",
  "outputTokens",
  "costUsd",
] as const;

function normalizeSourceInput(input: CreateSourceInput): {
  readonly sessionId: string;
  readonly runId?: string;
  readonly branchId?: string;
  readonly eventIds: readonly string[];
  readonly startSequence?: number;
  readonly endSequence?: number;
  readonly digest: string;
  readonly request: unknown;
} {
  const sessionId = normalizeId(input.sessionId, "sessionId");
  const runId = input.runId ? normalizeId(input.runId, "runId") : undefined;
  const branchId = input.branchId ? normalizeId(input.branchId, "branchId") : undefined;
  const eventIds = [...new Set((input.eventIds ?? []).map((id) => normalizeId(id, "eventId")))];
  const startSequence = normalizeOptionalPositiveInteger(input.startSequence, "startSequence");
  const endSequence = normalizeOptionalPositiveInteger(input.endSequence, "endSequence");
  if (startSequence !== undefined && endSequence !== undefined && startSequence > endSequence) {
    throw new Error("startSequence cannot be greater than endSequence");
  }
  const digest = requireDigest(input.digest);
  return {
    sessionId,
    ...(runId ? { runId } : {}),
    ...(branchId ? { branchId } : {}),
    eventIds,
    ...(startSequence === undefined ? {} : { startSequence }),
    ...(endSequence === undefined ? {} : { endSequence }),
    digest,
    request: {
      sourceId: input.sourceId,
      sessionId,
      runId,
      branchId,
      eventIds,
      startSequence,
      endSequence,
      digest,
    },
  };
}

function normalizeCreateFactInput(input: CreateFactInput) {
  const kind = requireEnum(input.kind, MEMORY_KINDS, "kind");
  const title = requireText(input.title, "title", MAX_TITLE_LENGTH);
  const content = requireText(input.content, "content", MAX_CONTENT_LENGTH);
  const confidence = normalizeConfidence(input.confidence ?? 1);
  const sourceId = input.sourceId ? normalizeId(input.sourceId, "sourceId") : undefined;
  const state = requireNonForgottenState(input.state ?? "active");
  const pinned = input.pinned ?? false;
  const expiresAt = input.expiresAt ? normalizeTimestamp(input.expiresAt, "expiresAt") : undefined;
  const lastUsedAt = input.lastUsedAt
    ? normalizeTimestamp(input.lastUsedAt, "lastUsedAt")
    : undefined;
  return {
    kind,
    title,
    content,
    confidence,
    sourceId,
    state,
    pinned,
    expiresAt,
    lastUsedAt,
    request: {
      factId: input.factId,
      kind,
      title,
      content,
      confidence,
      sourceId,
      state,
      pinned,
      expiresAt,
      lastUsedAt,
    },
  };
}

function normalizeCreateProposalInput(input: CreateProposalInput) {
  const kind = requireEnum(input.kind, MEMORY_KINDS, "kind");
  const title = requireText(input.title, "title", MAX_TITLE_LENGTH);
  const content = requireText(input.content, "content", MAX_CONTENT_LENGTH);
  const reason = requireText(input.reason, "reason", MAX_REASON_LENGTH);
  const confidence = normalizeConfidence(input.confidence ?? 1);
  const sourceId = input.sourceId ? normalizeId(input.sourceId, "sourceId") : undefined;
  const conflictStatus = requireEnum(
    input.conflictStatus ?? "none",
    PROPOSAL_CONFLICT_STATUSES,
    "conflictStatus",
  );
  const conflictFactId = input.conflictFactId
    ? normalizeId(input.conflictFactId, "conflictFactId")
    : undefined;
  return {
    kind,
    title,
    content,
    reason,
    confidence,
    sourceId,
    conflictStatus,
    conflictFactId,
    request: {
      proposalId: input.proposalId,
      kind,
      title,
      content,
      reason,
      confidence,
      sourceId,
      conflictStatus,
      conflictFactId,
    },
  };
}

function normalizeCreateJobInput(input: CreateJobInput) {
  const type = requireNonEmpty(input.type, "type", 128);
  const terminalEventId = normalizeId(input.terminalEventId, "terminalEventId");
  const extractorVersion = requireNonEmpty(input.extractorVersion, "extractorVersion", 128);
  const cursor = normalizeJobCursor(input.cursor);
  const sourceId = input.sourceId ? normalizeId(input.sourceId, "sourceId") : undefined;
  const maxAttempts = normalizePositiveInteger(input.maxAttempts ?? 3, "maxAttempts");
  const nextAttemptAt = input.nextAttemptAt
    ? normalizeTimestamp(input.nextAttemptAt, "nextAttemptAt")
    : undefined;
  return {
    type,
    terminalEventId,
    extractorVersion,
    cursor,
    sourceId,
    maxAttempts,
    nextAttemptAt,
    request: {
      jobId: input.jobId,
      type,
      terminalEventId,
      extractorVersion,
      cursor,
      sourceId,
      maxAttempts,
      nextAttemptAt,
    },
  };
}

function mapSettings(row: SettingsRow, workspaceId: WorkspaceId): Settings {
  assertWorkspace(row.workspace_id, workspaceId);
  return {
    workspaceId,
    enabled: fromSqlBoolean(row.enabled, "enabled"),
    autoPropose: fromSqlBoolean(row.auto_propose, "autoPropose"),
    autoCommit: fromSqlBoolean(row.auto_commit, "autoCommit"),
    injectionEnabled: fromSqlBoolean(row.injection_enabled, "injectionEnabled"),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function mapSource(row: SourceRow, workspaceId: WorkspaceId): Source {
  assertWorkspace(row.workspace_id, workspaceId);
  const eventIds = parseStringArray(row.event_ids_json, "source eventIds");
  return {
    sourceId: row.source_id,
    workspaceId,
    sessionId: row.session_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.branch_id ? { branchId: row.branch_id } : {}),
    eventIds,
    ...(row.start_sequence === null ? {} : { startSequence: row.start_sequence }),
    ...(row.end_sequence === null ? {} : { endSequence: row.end_sequence }),
    digest: row.digest,
    availability: requireEnum(row.availability, SOURCE_AVAILABILITIES, "source availability"),
    ...(row.invalidated_at ? { invalidatedAt: row.invalidated_at } : {}),
    ...(row.invalidation_code ? { invalidationCode: row.invalidation_code } : {}),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFact(row: FactRow, workspaceId: WorkspaceId): Fact {
  assertWorkspace(row.workspace_id, workspaceId);
  return {
    factId: row.fact_id,
    workspaceId,
    kind: requireEnum(row.kind, MEMORY_KINDS, "fact kind"),
    title: row.title,
    content: row.content,
    confidence: row.confidence,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    state: requireEnum(row.state, FACT_STATES, "fact state"),
    pinned: fromSqlBoolean(row.pinned, "pinned"),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.forgotten_at ? { forgottenAt: row.forgotten_at } : {}),
  };
}

function mapProposal(row: ProposalRow, workspaceId: WorkspaceId): Proposal {
  assertWorkspace(row.workspace_id, workspaceId);
  return {
    proposalId: row.proposal_id,
    workspaceId,
    kind: requireEnum(row.kind, MEMORY_KINDS, "proposal kind"),
    title: row.title,
    content: row.content,
    reason: row.reason,
    confidence: row.confidence,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    status: requireEnum(row.status, PROPOSAL_STATUSES, "proposal status"),
    conflictStatus: requireEnum(
      row.conflict_status,
      PROPOSAL_CONFLICT_STATUSES,
      "proposal conflictStatus",
    ),
    ...(row.conflict_fact_id ? { conflictFactId: row.conflict_fact_id } : {}),
    ...(row.resolved_fact_id ? { resolvedFactId: row.resolved_fact_id } : {}),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

function mapMutation(row: MutationRow, workspaceId: WorkspaceId): Mutation {
  assertWorkspace(row.workspace_id, workspaceId);
  return {
    sequence: row.sequence,
    mutationId: row.mutation_id,
    workspaceId,
    entityType: row.entity_type as MutationEntityType,
    entityId: row.entity_id,
    action: row.action as MutationAction,
    ...(row.from_version === null ? {} : { fromVersion: row.from_version }),
    toVersion: row.to_version,
    ...(row.idempotency_key_hash ? { idempotencyKeyHash: row.idempotency_key_hash } : {}),
    createdAt: row.created_at,
  };
}

function mapJob(row: JobRow, workspaceId: WorkspaceId): Job {
  assertWorkspace(row.workspace_id, workspaceId);
  return {
    jobId: row.job_id,
    workspaceId,
    type: row.type,
    status: requireEnum(row.status, MEMORY_JOB_STATUSES, "job status"),
    terminalEventId: row.terminal_event_id,
    extractorVersion: row.extractor_version,
    cursor: parseJobCursor(row.cursor_json),
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.terminal_at ? { terminalAt: row.terminal_at } : {}),
  };
}

function sameJobIdentity(job: Job, expected: ReturnType<typeof normalizeCreateJobInput>): boolean {
  return (
    job.type === expected.type &&
    job.sourceId === expected.sourceId &&
    job.maxAttempts === expected.maxAttempts &&
    job.nextAttemptAt === expected.nextAttemptAt &&
    canonicalJson(job.cursor) === canonicalJson(expected.cursor)
  );
}

function normalizeJobCursor(cursor: MemoryJobCursor): MemoryJobCursor {
  const sessionId = normalizeId(cursor.sessionId, "cursor.sessionId");
  const sequence = normalizeOptionalNonNegativeInteger(cursor.sequence, "cursor.sequence");
  const eventId = cursor.eventId ? normalizeId(cursor.eventId, "cursor.eventId") : undefined;
  return {
    sessionId,
    ...(sequence === undefined ? {} : { sequence }),
    ...(eventId ? { eventId } : {}),
  };
}

function parseJobCursor(encoded: string): MemoryJobCursor {
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch (error) {
    throw new Error("Memory job cursor is invalid JSON", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Memory job cursor is invalid");
  }
  const record = value as Record<string, unknown>;
  return normalizeJobCursor({
    sessionId: String(record["sessionId"] ?? ""),
    ...(record["sequence"] === undefined ? {} : { sequence: Number(record["sequence"]) }),
    ...(typeof record["eventId"] === "string" ? { eventId: record["eventId"] } : {}),
  });
}

function parseStringArray(encoded: string, field: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch (error) {
    throw new Error(`${field} is invalid JSON`, { cause: error });
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function parseMarker(encoded: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch (error) {
    throw new Error("Memory idempotency marker is invalid JSON", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Memory idempotency marker is invalid");
  }
  return value as Readonly<Record<string, unknown>>;
}

function readMarkerId(marker: Readonly<Record<string, unknown>>, key: string): string {
  const value = marker[key];
  if (typeof value !== "string") throw new Error(`Memory idempotency marker lacks ${key}`);
  return value;
}

function readOptionalMarkerId(
  marker: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = marker[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Memory idempotency marker has invalid ${key}`);
  return value;
}

function appendInFilter(
  clauses: string[],
  params: Array<string | number>,
  column: string,
  values: readonly string[] | undefined,
): void {
  if (!values?.length) return;
  clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
  params.push(...values);
}

function hasDefinedPatch(value: object, keys: readonly string[]): boolean {
  const record = value as Readonly<Record<string, unknown>>;
  return keys.some((key) => record[key] !== undefined);
}

function assertWorkspace(actual: string, expected: WorkspaceId): void {
  if (actual !== expected) {
    throw new Error(`Memory row belongs to workspace ${actual}, not ${expected}`);
  }
}

function assertVersion(entity: string, id: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new MemoryConflictError(
      `Memory ${entity} ${id} version changed from ${expected} to ${actual}`,
    );
  }
}

function assertChanged(changes: number, entity: string, id: string): void {
  if (changes !== 1) throw new MemoryConflictError(`Memory ${entity} ${id} update lost CAS`);
}

function requireExpectedVersion(value: number): number {
  return normalizePositiveInteger(value, "expectedVersion");
}

function normalizeId(value: string, field: string): string {
  return requireNonEmpty(value, field, MAX_ID_LENGTH);
}

function normalizeIdempotencyKey(value: string): string {
  return requireNonEmpty(value, "idempotencyKey", MAX_ID_LENGTH);
}

function requireText(value: string, field: string, maxLength: number): string {
  return requireNonEmpty(value, field, maxLength);
}

function requireStoredText(value: string | null, field: string): string {
  if (value === null) throw new Error(`Memory ${field} has been cleared`);
  return value;
}

function requireNonEmpty(value: string | undefined, field: string, maxLength: number): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} must be a non-empty string`);
  if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return normalized;
}

function requireEnum<const Value extends string>(
  value: string,
  allowed: readonly Value[],
  field: string,
): Value {
  if (!allowed.includes(value as Value)) throw new Error(`${field} has unsupported value ${value}`);
  return value as Value;
}

function requireNonForgottenState(value: string): Exclude<FactState, "forgotten"> {
  const state = requireEnum(value, FACT_STATES, "state");
  if (state === "forgotten") throw new Error("Only forgetFact may create a forgotten tombstone");
  return state;
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("confidence must be between 0 and 1");
  }
  return value;
}

function normalizeLimit(value = 100): number {
  const normalized = normalizePositiveInteger(value, "limit");
  if (normalized > MAX_LIST_LIMIT) throw new Error(`limit cannot exceed ${MAX_LIST_LIMIT}`);
  return normalized;
}

function normalizePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${field} must be a positive integer`);
  return value;
}

function normalizeNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function normalizeOptionalPositiveInteger(
  value: number | undefined,
  field: string,
): number | undefined {
  return value === undefined ? undefined : normalizePositiveInteger(value, field);
}

function normalizeOptionalNonNegativeInteger(
  value: number | undefined,
  field: string,
): number | undefined {
  return value === undefined ? undefined : normalizeNonNegativeInteger(value, field);
}

function normalizeNonNegativeNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative`);
  return value;
}

function normalizeTimestamp(value: string, field: string): string {
  const timestamp = requireNonEmpty(value, field, 128);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${field} must be an ISO timestamp`);
  return parsed.toISOString();
}

function normalizeOptionalTimestamp(value: string | null, field: string): string | null {
  return value === null ? null : normalizeTimestamp(value, field);
}

function normalizeOptionalCode(value: string | null, field: string): string | null {
  return value === null ? null : requireCode(value, field);
}

function requireCode(value: string | undefined, field: string): string {
  const code = requireNonEmpty(value, field, 256);
  if (!/^[A-Za-z0-9._:-]+$/u.test(code)) {
    throw new Error(`${field} must be an opaque code, not free-form text`);
  }
  return code;
}

function requireDigest(value: string): string {
  const digest = requireNonEmpty(value, "digest", 512);
  if (!/^[A-Za-z0-9._:-]+$/u.test(digest)) {
    throw new Error("digest must be an opaque digest, not source text");
  }
  return digest;
}

function isTerminalJobStatus(status: MemoryJobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function toSqlBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function fromSqlBoolean(value: number, field: string): boolean {
  if (value !== 0 && value !== 1) throw new Error(`Memory ${field} is not a SQLite boolean`);
  return value === 1;
}

function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function hashOpaqueKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Idempotent request contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Idempotent request contains an unsupported value");
}
