import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import type { WorkspaceId } from "../../paths/pico-paths.js";
import { FileStorageIntegrityError } from "../local-file-storage.js";
import { validateEvidenceRef, type EvidenceRef } from "../../engine/evidence-ref.js";
import {
  FACT_STATES,
  MEMORY_JOB_STATUSES,
  MEMORY_KINDS,
  MEMORY_REVIEW_MODES,
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
  type Settings,
  type Source,
} from "../../memory/domain.js";
import {
  MEMORY_FORGOTTEN_NOTIFICATION_JOB_TYPE,
  MEMORY_FORGOTTEN_NOTIFICATION_VERSION,
  MEMORY_PROPOSED_NOTIFICATION_JOB_TYPE,
  MEMORY_PROPOSED_NOTIFICATION_VERSION_PREFIX,
  MEMORY_SOURCE_NOTIFICATION_JOB_TYPE,
  MEMORY_SOURCE_UNAVAILABLE_NOTIFICATION_VERSION,
  MemoryAsyncTransactionError,
  MemoryConflictError,
  MemoryIdempotencyConflictError,
  MemoryNotFoundError,
  type CancelSessionJobsInput,
  type CreateFactInput,
  type CreateJobInput,
  type CreateProposalInput,
  type CreateSourceInput,
  type DeleteProposalInput,
  type FactListOptions,
  type ForgetFactInput,
  type JobListOptions,
  type MemoryRepositoryContract,
  type MutationListOptions,
  type ProposalListOptions,
  type RejectAsyncTransactionArguments,
  type RescheduleQueuedJobsInput,
  type ResolveProposalInput,
  type ResolveProposalResult,
  type SessionSourceListOptions,
  type UpdateFactInput,
  type UpdateJobInput,
  type UpdateProposalInput,
  type UpdateSettingsInput,
  type UpdateSourceAvailabilityInput,
} from "../../memory/memory-repository.js";
import type { OperationalDatabaseLease } from "./sqlite-database.js";
import { prepareCurrentWorkspaceSqliteStorageSync } from "./workspace-scopes.js";

/**
 * SQLite 纪元的 memory 事实权威(ADR 24 §4.4,票 07)。
 *
 * 语义对齐旧文件实现(src/memory/memory-repository.ts,产线基准):
 * - 六实体表全量落库;旧"state.json 整写 + memory/lock + commit.json 事务命名空间"
 *   收敛为单个 BEGIN IMMEDIATE,memory_metadata.revision 在事务内读改写(CAS)。
 * - 写操作逐方法照抄旧语义(校验顺序、错误类型、mutations 审计行、幂等
 *   `${operation}:${keyHash}` 键、13 个 action 枚举、fromVersion/toVersion)。
 * - Fact/Proposal 墓碑状态机由表 CHECK 兜底(forgotten/deleted 必须清空正文)。
 * - mutations.sequence 从 1 连续:写事务内 MAX+1 分配(BEGIN IMMEDIATE 独占)。
 *
 * 与旧实现的差异:排序从 localeCompare 变为 SQLite BINARY(程序生成的 id 均为
 * 小写 ASCII,实践等价);forget 的明文残留文件校验随"无明文文件"退役(CHECK
 * 即 postcondition);嵌套事务用 SAVEPOINT 划回滚边界。
 */

const MAX_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 512;
const MAX_CONTENT_LENGTH = 32_000;
const MAX_REASON_LENGTH = 4_000;
const MAX_LIST_LIMIT = 500;

const METADATA_WORKSPACE_KEY = "workspaceId";
const METADATA_REVISION_KEY = "revision";
const METADATA_SETTINGS_KEY = "settings";

interface MemorySqliteWriteTx {
  dirty: boolean;
  savepointCounter: number;
}

const activeMemorySqliteWrites = new Map<string, MemorySqliteWriteTx>();

export interface SqliteMemoryRepositoryOptions {
  /** Canonical workspace storage root(pico.sqlite 所在目录)。 */
  readonly storageRoot: string;
  readonly workspaceId: WorkspaceId;
  readonly now?: () => Date;
  /**
   * 兼容旧构造面的保留项:锁等待统一由引擎 busy_timeout(5s)管辖,此处仅校验。
   */
  readonly busyTimeoutMs?: number;
}

export class SqliteMemoryRepository implements MemoryRepositoryContract {
  readonly storageRoot: string;
  readonly workspaceId: WorkspaceId;
  private readonly lease: OperationalDatabaseLease;
  private readonly now: () => Date;
  private closed = false;

  constructor(options: SqliteMemoryRepositoryOptions) {
    if (!options.storageRoot.trim()) {
      throw new Error("MemoryRepository storageRoot must not be empty");
    }
    if (options.busyTimeoutMs !== undefined) {
      normalizeNonNegativeInteger(options.busyTimeoutMs, "busyTimeoutMs");
    }
    this.workspaceId = options.workspaceId;
    this.now = options.now ?? (() => new Date());
    // 单一 scope 组合点:与同库其它 store 一致传全量(少传 scope 会漏迁移)。
    const preparation = prepareCurrentWorkspaceSqliteStorageSync(resolve(options.storageRoot));
    this.lease = preparation.lease;
    this.storageRoot = this.lease.storageRoot;
    try {
      // 首次打开播种 memory_metadata(等价旧实现的空 state.json 落盘)。
      this.write(() => this.ensureMetadataLocked());
    } catch (error) {
      // 构造失败必须归还 lease,否则进程内 Owners 泄漏打开的句柄(Windows rm EBUSY)。
      this.closed = true;
      this.lease.release();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lease.release();
  }

  transaction<Result>(
    operation: (repository: this) => Result,
    ..._rejectAsync: RejectAsyncTransactionArguments<Result>
  ): Result {
    return requireSynchronousTransactionResult(this.write(() => operation(this)));
  }

  getSettings(): Settings {
    return this.read(() => this.readSettingsLocked());
  }

  updateSettings(input: UpdateSettingsInput): Settings {
    requireExpectedVersion(input.expectedVersion);
    if (
      input.enabled === undefined &&
      input.autoPropose === undefined &&
      input.autoCommit === undefined &&
      input.injectionEnabled === undefined &&
      input.reviewMode === undefined
    ) {
      throw new Error("Settings update must include at least one field");
    }
    return this.idempotentWrite(
      "settings.update",
      input.idempotencyKey,
      input,
      () => {
        const current = this.readSettingsLocked();
        assertVersion("settings", this.workspaceId, current.version, input.expectedVersion);
        const updatedAt = this.timestamp();
        const result: Settings = {
          ...current,
          enabled: input.enabled ?? current.enabled,
          autoPropose: input.autoPropose ?? current.autoPropose,
          autoCommit: input.autoCommit ?? current.autoCommit,
          injectionEnabled: input.injectionEnabled ?? current.injectionEnabled,
          reviewMode: requireEnum(
            input.reviewMode ?? current.reviewMode,
            MEMORY_REVIEW_MODES,
            "reviewMode",
          ),
          version: current.version + 1,
          updatedAt,
        };
        this.putMetadataLocked(METADATA_SETTINGS_KEY, result);
        this.recordMutationLocked(
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
      () => this.readSettingsLocked(),
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
        if (this.getSourceRow(sourceId)) {
          throw new MemoryConflictError(`Memory source ${sourceId} already exists`);
        }
        const source: Source = {
          sourceId,
          workspaceId: this.workspaceId,
          sessionId: normalized.sessionId,
          ...(normalized.runId ? { runId: normalized.runId } : {}),
          ...(normalized.branchId ? { branchId: normalized.branchId } : {}),
          eventIds: normalized.eventIds,
          ...(normalized.startSequence === undefined
            ? {}
            : { startSequence: normalized.startSequence }),
          ...(normalized.endSequence === undefined ? {} : { endSequence: normalized.endSequence }),
          digest: normalized.digest,
          ...(normalized.evidenceRef ? { evidenceRef: normalized.evidenceRef } : {}),
          availability: "available",
          version: 1,
          createdAt: at,
          updatedAt: at,
        };
        this.insertSourceRow(source);
        this.recordMutationLocked(
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
    const id = normalizeId(sourceId, "sourceId");
    return this.read(() => {
      const row = this.getSourceRow(id);
      return row === undefined ? undefined : rowToSource(row, this.workspaceId);
    });
  }

  listSources(limit = 100): Source[] {
    const bounded = normalizeLimit(limit);
    return this.read(() =>
      this.allRows(
        `SELECT * FROM memory_sources ORDER BY created_at DESC, source_id DESC LIMIT ?`,
        bounded,
      ).map((row) => rowToSource(row, this.workspaceId)),
    );
  }

  /** Bounded, SQL-filtered lifecycle scan; callers advance with the last sourceId. */
  listSessionSources(sessionId: string, options: SessionSourceListOptions = {}): Source[] {
    const id = normalizeId(sessionId, "sessionId");
    const availability =
      options.availability === undefined
        ? undefined
        : requireEnum(options.availability, SOURCE_AVAILABILITIES, "availability");
    const afterSequence =
      options.afterSequence === undefined
        ? undefined
        : normalizeNonNegativeInteger(options.afterSequence, "afterSequence");
    const afterSourceId =
      options.afterSourceId === undefined
        ? undefined
        : normalizeId(options.afterSourceId, "afterSourceId");
    const limit = normalizeLimit(options.limit);
    return this.read(() =>
      this.allRows(
        `SELECT * FROM memory_sources WHERE session_id = ?
           ${availability === undefined ? "" : "AND availability = ?"}
           ${afterSequence === undefined ? "" : "AND COALESCE(end_sequence, start_sequence, 0) > ?"}
           ${afterSourceId === undefined ? "" : "AND source_id > ?"}
         ORDER BY source_id ASC LIMIT ?`,
        ...[
          id,
          ...(availability === undefined ? [] : [availability]),
          ...(afterSequence === undefined ? [] : [afterSequence]),
          ...(afterSourceId === undefined ? [] : [afterSourceId]),
          limit,
        ],
      ).map((row) => rowToSource(row, this.workspaceId)),
    );
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
        const result: Source = {
          ...current,
          availability: input.availability,
          ...(input.availability === "available"
            ? { invalidatedAt: undefined, invalidationCode: undefined }
            : { invalidatedAt: updatedAt, invalidationCode }),
          version: current.version + 1,
          updatedAt,
        };
        this.insertSourceRow(compact(result));
        this.recordMutationLocked(
          "source",
          current.sourceId,
          "source.updated",
          current.version,
          result.version,
          input.idempotencyKey,
          updatedAt,
        );
        if (result.availability !== "available") {
          this.enqueueSourceChangedNotification(result, input.idempotencyKey, updatedAt);
        }
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
        const fact: Fact = compact({
          factId,
          workspaceId: this.workspaceId,
          kind: normalized.kind,
          title: normalized.title,
          content: normalized.content,
          confidence: normalized.confidence,
          ...(normalized.sourceId ? { sourceId: normalized.sourceId } : {}),
          state: normalized.state,
          pinned: normalized.pinned,
          ...(normalized.expiresAt ? { expiresAt: normalized.expiresAt } : {}),
          ...(normalized.lastUsedAt ? { lastUsedAt: normalized.lastUsedAt } : {}),
          version: 1,
          createdAt: at,
          updatedAt: at,
        });
        this.insertFactRow(fact);
        this.recordMutationLocked(
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
    const id = normalizeId(factId, "factId");
    return this.read(() => {
      const row = this.getFactRow(id);
      return row === undefined ? undefined : rowToFact(row, this.workspaceId);
    });
  }

  listFacts(options: FactListOptions = {}): Fact[] {
    const states = options.states?.map((state) => requireEnum(state, FACT_STATES, "state"));
    const kinds = options.kinds?.map((kind) => requireEnum(kind, MEMORY_KINDS, "kind"));
    const limit = normalizeLimit(options.limit);
    return this.read(() =>
      this.allRows(
        `SELECT * FROM memory_facts
         ${buildWhereClause([
           ...(states?.length ? [`state IN (${placeholders(states.length)})`] : []),
           ...(kinds?.length ? [`kind IN (${placeholders(kinds.length)})`] : []),
         ])}
         ORDER BY pinned DESC, updated_at DESC, fact_id DESC LIMIT ?`,
        ...[...(states ?? []), ...(kinds ?? []), limit],
      ).map((row) => rowToFact(row, this.workspaceId)),
    );
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
        const result: Fact = compact({
          ...current,
          kind: input.kind ? requireEnum(input.kind, MEMORY_KINDS, "kind") : current.kind,
          title:
            input.title === undefined
              ? current.title
              : requireText(input.title, "title", MAX_TITLE_LENGTH),
          content:
            input.content === undefined
              ? current.content
              : requireText(input.content, "content", MAX_CONTENT_LENGTH),
          confidence:
            input.confidence === undefined
              ? current.confidence
              : normalizeConfidence(input.confidence),
          sourceId,
          state: input.state ? requireNonForgottenState(input.state) : current.state,
          pinned: input.pinned ?? current.pinned,
          expiresAt:
            input.expiresAt === undefined
              ? current.expiresAt
              : (normalizeOptionalTimestamp(input.expiresAt, "expiresAt") ?? undefined),
          lastUsedAt:
            input.lastUsedAt === undefined
              ? current.lastUsedAt
              : (normalizeOptionalTimestamp(input.lastUsedAt, "lastUsedAt") ?? undefined),
          version: current.version + 1,
          updatedAt: at,
        });
        this.insertFactRow(result);
        this.recordMutationLocked(
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
    return this.idempotentWrite(
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
        const linkedProposals = this.allRows(
          `SELECT * FROM memory_proposals
           WHERE status <> 'deleted' AND (resolved_fact_id = ? OR conflict_fact_id = ?)`,
          factId,
          factId,
        ).map((row) => rowToProposal(row, this.workspaceId));
        const forgotten: Fact = compact({
          ...current,
          title: null,
          content: null,
          state: "forgotten",
          pinned: false,
          expiresAt: undefined,
          lastUsedAt: undefined,
          version: current.version + 1,
          updatedAt: at,
          forgottenAt: at,
        });
        this.insertFactRow(forgotten);
        for (const proposal of linkedProposals) {
          const deleted: Proposal = compact({
            ...proposal,
            title: null,
            content: null,
            reason: null,
            status: "deleted",
            conflictStatus: "resolved",
            version: proposal.version + 1,
            updatedAt: at,
            deletedAt: proposal.deletedAt ?? at,
          });
          this.insertProposalRow(deleted);
          this.recordMutationLocked(
            "proposal",
            proposal.proposalId,
            "proposal.deleted",
            proposal.version,
            proposal.version + 1,
            input.idempotencyKey,
            at,
          );
        }
        this.recordMutationLocked(
          "fact",
          factId,
          "fact.forgotten",
          current.version,
          forgotten.version,
          input.idempotencyKey,
          at,
        );
        // D11 forget 复活链收口:账本 append-only 保留原始证据,在 Source 上打提取
        // 抑制标记,同证据重提取(extractor 升级/重建补 Job)即取消,不建提案。
        if (current.sourceId) {
          const sourceRow = this.getSourceRow(current.sourceId);
          if (sourceRow) {
            const source = rowToSource(sourceRow, this.workspaceId);
            if (!source.extractionSuppressedAt) {
              const suppressed: Source = compact({
                ...source,
                extractionSuppressedAt: at,
                version: source.version + 1,
                updatedAt: at,
              });
              this.insertSourceRow(suppressed);
              this.recordMutationLocked(
                "source",
                source.sourceId,
                "source.updated",
                source.version,
                suppressed.version,
                input.idempotencyKey,
                at,
              );
            }
          }
        }
        this.enqueueForgottenNotification(forgotten, input.idempotencyKey, at);
        return { value: forgotten, marker: { factId } };
      },
      (marker) => this.requireFact(readMarkerId(marker, "factId")),
    );
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
        if (this.getProposalRow(proposalId)) {
          throw new MemoryConflictError(`Memory proposal ${proposalId} already exists`);
        }
        const proposal: Proposal = {
          proposalId,
          workspaceId: this.workspaceId,
          kind: normalized.kind,
          title: normalized.title,
          content: normalized.content,
          reason: normalized.reason,
          confidence: normalized.confidence,
          ...(normalized.sourceId ? { sourceId: normalized.sourceId } : {}),
          status: "pending",
          conflictStatus: normalized.conflictStatus,
          ...(normalized.conflictFactId ? { conflictFactId: normalized.conflictFactId } : {}),
          version: 1,
          createdAt: at,
          updatedAt: at,
        };
        this.insertProposalRow(proposal);
        this.recordMutationLocked(
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
    const id = normalizeId(proposalId, "proposalId");
    return this.read(() => {
      const row = this.getProposalRow(id);
      return row === undefined ? undefined : rowToProposal(row, this.workspaceId);
    });
  }

  listProposals(options: ProposalListOptions = {}): Proposal[] {
    const statuses = options.statuses?.map((status) =>
      requireEnum(status, PROPOSAL_STATUSES, "status"),
    );
    const limit = normalizeLimit(options.limit);
    return this.read(() =>
      this.allRows(
        `SELECT * FROM memory_proposals
         ${buildWhereClause(
           statuses?.length ? [`status IN (${placeholders(statuses.length)})`] : [],
         )}
         ORDER BY created_at DESC, proposal_id DESC LIMIT ?`,
        ...[...(statuses ?? []), limit],
      ).map((row) => rowToProposal(row, this.workspaceId)),
    );
  }

  listPendingProposalsForSources(sourceIds: readonly string[]): Proposal[] {
    if (sourceIds.length === 0) return [];
    if (sourceIds.length > MAX_LIST_LIMIT) {
      throw new Error(`sourceIds cannot exceed ${MAX_LIST_LIMIT}`);
    }
    const normalized = [...new Set(sourceIds.map((sourceId) => normalizeId(sourceId, "sourceId")))];
    return this.read(() =>
      this.allRows(
        `SELECT * FROM memory_proposals
         WHERE status = 'pending' AND source_id IN (${placeholders(normalized.length)})
         ORDER BY proposal_id`,
        ...normalized,
      ).map((row) => rowToProposal(row, this.workspaceId)),
    );
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
        const result: Proposal = compact({
          ...current,
          kind: input.kind ? requireEnum(input.kind, MEMORY_KINDS, "kind") : current.kind,
          title:
            input.title === undefined
              ? current.title
              : requireText(input.title, "title", MAX_TITLE_LENGTH),
          content:
            input.content === undefined
              ? current.content
              : requireText(input.content, "content", MAX_CONTENT_LENGTH),
          reason:
            input.reason === undefined
              ? current.reason
              : requireText(input.reason, "reason", MAX_REASON_LENGTH),
          confidence:
            input.confidence === undefined
              ? current.confidence
              : normalizeConfidence(input.confidence),
          sourceId,
          conflictStatus: input.conflictStatus
            ? requireEnum(input.conflictStatus, PROPOSAL_CONFLICT_STATUSES, "conflictStatus")
            : current.conflictStatus,
          conflictFactId,
          version: current.version + 1,
          updatedAt: at,
        });
        this.insertProposalRow(result);
        this.recordMutationLocked(
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
    return this.idempotentWrite(
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
        const deleted: Proposal = {
          ...current,
          title: null,
          content: null,
          reason: null,
          status: "deleted",
          version: current.version + 1,
          updatedAt: at,
          deletedAt: at,
        };
        this.insertProposalRow(deleted);
        this.recordMutationLocked(
          "proposal",
          proposalId,
          "proposal.deleted",
          current.version,
          deleted.version,
          input.idempotencyKey,
          at,
        );
        return { value: deleted, marker: { proposalId } };
      },
      (marker) => this.requireProposal(readMarkerId(marker, "proposalId")),
    );
  }

  resolveProposal(input: ResolveProposalInput): ResolveProposalResult {
    requireExpectedVersion(input.expectedVersion);
    const proposalId = normalizeId(input.proposalId, "proposalId");
    if (input.resolution !== "accepted" && input.resolution !== "rejected") {
      throw new Error("Proposal resolution must be accepted or rejected");
    }
    if (input.resolution === "rejected" && input.patch !== undefined) {
      throw new Error("Proposal patch is only valid for accepted resolutions");
    }
    const patch = normalizeResolveProposalPatch(input.patch);
    return this.idempotentWrite(
      "proposal.resolve",
      input.idempotencyKey,
      { ...input, proposalId, ...(patch ? { patch } : {}) },
      () => {
        const current = this.requireProposal(proposalId);
        if (current.status !== "pending") {
          throw new MemoryConflictError(`Proposal ${proposalId} is already ${current.status}`);
        }
        assertVersion("proposal", proposalId, current.version, input.expectedVersion);
        const at = this.timestamp();
        const finalKind = patch?.kind ?? current.kind;
        const finalTitle = patch?.title ?? requireStoredText(current.title, "proposal title");
        const finalContent =
          patch?.content ?? requireStoredText(current.content, "proposal content");
        const finalReason = patch?.reason ?? requireStoredText(current.reason, "proposal reason");
        const finalConfidence = patch?.confidence ?? current.confidence;
        let fact: Fact | undefined;
        if (input.resolution === "accepted") {
          if (current.conflictStatus !== "none" && !current.conflictFactId) {
            throw new MemoryConflictError(
              `Conflict proposal ${proposalId} no longer has its conflict fact`,
            );
          }
          if (current.conflictFactId) {
            const target = this.requireUnchangedActiveConflictFact(current);
            if (input.factId !== undefined) {
              const requestedFactId = normalizeId(input.factId, "factId");
              if (requestedFactId !== target.factId) {
                throw new MemoryConflictError(
                  `Conflict proposal ${proposalId} must replace fact ${target.factId}`,
                );
              }
            }
            const updatedFact: Fact = compact({
              ...target,
              kind: finalKind,
              title: finalTitle,
              content: finalContent,
              confidence: finalConfidence,
              sourceId: current.sourceId,
              state: "active" as const,
              version: target.version + 1,
              updatedAt: at,
            });
            fact = updatedFact;
            this.insertFactRow(updatedFact);
            this.recordMutationLocked(
              "fact",
              target.factId,
              "fact.updated",
              target.version,
              updatedFact.version,
              input.idempotencyKey,
              at,
            );
          } else {
            const factId = normalizeId(input.factId ?? `fact:${randomUUID()}`, "factId");
            const created: Fact = compact({
              factId,
              workspaceId: this.workspaceId,
              kind: finalKind,
              title: finalTitle,
              content: finalContent,
              confidence: finalConfidence,
              ...(current.sourceId ? { sourceId: current.sourceId } : {}),
              state: "active" as const,
              pinned: false,
              version: 1,
              createdAt: at,
              updatedAt: at,
            });
            this.insertFactRow(created);
            fact = created;
            this.recordMutationLocked(
              "fact",
              factId,
              "fact.created",
              undefined,
              fact.version,
              input.idempotencyKey,
              at,
            );
          }
        }
        const proposal: Proposal = compact({
          ...current,
          kind: finalKind,
          title: finalTitle,
          content: finalContent,
          reason: finalReason,
          confidence: finalConfidence,
          status: input.resolution,
          conflictStatus:
            input.resolution === "accepted" && current.conflictFactId
              ? "resolved"
              : current.conflictStatus,
          resolvedFactId: fact?.factId,
          version: current.version + 1,
          updatedAt: at,
          reviewedAt: at,
        });
        this.insertProposalRow(proposal);
        this.recordMutationLocked(
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
    const after = normalizeNonNegativeInteger(options.afterSequence ?? 0, "afterSequence");
    const entityId =
      options.entityId === undefined ? undefined : normalizeId(options.entityId, "entityId");
    const limit = normalizeLimit(options.limit);
    return this.read(() =>
      this.allRows(
        `SELECT * FROM memory_mutations WHERE sequence > ?
           ${options.entityType === undefined ? "" : "AND entity_type = ?"}
           ${entityId === undefined ? "" : "AND entity_id = ?"}
         ORDER BY sequence LIMIT ?`,
        ...[
          after,
          ...(options.entityType === undefined ? [] : [options.entityType]),
          ...(entityId === undefined ? [] : [entityId]),
          limit,
        ],
      ).map((row) => rowToMutation(row, this.workspaceId)),
    );
  }

  createJob(input: CreateJobInput): Job {
    const normalized = normalizeCreateJobInput(input);
    return this.idempotentWrite(
      "job.create",
      input.idempotencyKey,
      normalized.request,
      () => {
        const existing = this.getRow(
          `SELECT * FROM memory_jobs WHERE terminal_event_id = ? AND extractor_version = ?`,
          normalized.terminalEventId,
          normalized.extractorVersion,
        );
        if (existing) {
          const job = rowToJob(existing, this.workspaceId);
          return { value: job, marker: { jobId: job.jobId } };
        }
        if (normalized.sourceId) this.requireSource(normalized.sourceId);
        const jobId = normalizeId(input.jobId ?? `memory-job:${randomUUID()}`, "jobId");
        const at = this.timestamp();
        if (this.getJobRow(jobId)) {
          throw new MemoryConflictError(`Memory job ${jobId} already exists`);
        }
        const job: Job = {
          jobId,
          workspaceId: this.workspaceId,
          type: normalized.type,
          status: "queued",
          terminalEventId: normalized.terminalEventId,
          extractorVersion: normalized.extractorVersion,
          cursor: normalized.cursor,
          ...(normalized.sourceId ? { sourceId: normalized.sourceId } : {}),
          attemptCount: 0,
          maxAttempts: normalized.maxAttempts,
          ...(normalized.nextAttemptAt ? { nextAttemptAt: normalized.nextAttemptAt } : {}),
          modelCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          version: 1,
          createdAt: at,
          updatedAt: at,
        };
        this.insertJobRow(job);
        this.recordMutationLocked(
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
    const id = normalizeId(jobId, "jobId");
    return this.read(() => {
      const row = this.getJobRow(id);
      return row === undefined ? undefined : rowToJob(row, this.workspaceId);
    });
  }

  listJobs(options: JobListOptions = {}): Job[] {
    const statuses = options.statuses?.map((status) =>
      requireEnum(status, MEMORY_JOB_STATUSES, "status"),
    );
    const type =
      options.type === undefined ? undefined : requireNonEmpty(options.type, "type", 128);
    const extractorVersion =
      options.extractorVersion === undefined
        ? undefined
        : requireNonEmpty(options.extractorVersion, "extractorVersion", 128);
    const terminalEventId =
      options.terminalEventId === undefined
        ? undefined
        : requireNonEmpty(options.terminalEventId, "terminalEventId", MAX_ID_LENGTH);
    const readyAt =
      options.readyAt === undefined ? undefined : normalizeTimestamp(options.readyAt, "readyAt");
    const order = options.order ?? "newest";
    if (order !== "newest" && order !== "oldest") {
      throw new Error(`order has unsupported value ${String(order)}`);
    }
    const limit = normalizeLimit(options.limit);
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (statuses?.length) {
      clauses.push(`status IN (${placeholders(statuses.length)})`);
      params.push(...statuses);
    }
    if (type !== undefined) {
      clauses.push("type = ?");
      params.push(type);
    }
    if (extractorVersion !== undefined) {
      clauses.push("extractor_version = ?");
      params.push(extractorVersion);
    }
    if (terminalEventId !== undefined) {
      clauses.push("terminal_event_id = ?");
      params.push(terminalEventId);
    }
    if (readyAt !== undefined) {
      clauses.push("(next_attempt_at IS NULL OR next_attempt_at <= ?)");
      params.push(readyAt);
    }
    if (options.attemptsRemaining === true) {
      clauses.push("attempt_count < max_attempts");
    }
    if (options.withModelUsage === true) {
      clauses.push("(model_calls > 0 OR input_tokens > 0 OR output_tokens > 0 OR cost_usd > 0)");
    }
    return this.read(() =>
      this.allRows(
        `SELECT * FROM memory_jobs ${buildWhereClause(clauses)}
         ORDER BY created_at ${order === "oldest" ? "ASC" : "DESC"},
                  job_id ${order === "oldest" ? "ASC" : "DESC"} LIMIT ?`,
        ...[...params, limit],
      ).map((row) => rowToJob(row, this.workspaceId)),
    );
  }

  rescheduleQueuedJobs(input: RescheduleQueuedJobsInput): number {
    const type = requireNonEmpty(input.type, "type", 128);
    const extractorVersion = requireNonEmpty(input.extractorVersion, "extractorVersion", 128);
    const requestedAt = normalizeTimestamp(input.requestedAt, "requestedAt");
    const requestedTime = Date.parse(requestedAt);
    const maxWaitMs = normalizePositiveInteger(input.maxWaitMs, "maxWaitMs");
    const prefix = requireNonEmpty(input.idempotencyKeyPrefix, "idempotencyKeyPrefix", 512);
    return this.transaction(() => {
      const rows = this.read(() =>
        this.allRows(
          `SELECT * FROM memory_jobs
           WHERE status = 'queued' AND error_code IS NULL AND type = ? AND extractor_version = ?
           ORDER BY created_at, job_id`,
          type,
          extractorVersion,
        ),
      ).map((row) => rowToJob(row, this.workspaceId));
      let changed = 0;
      for (const job of rows) {
        const deadline = new Date(
          Math.min(requestedTime, Date.parse(job.createdAt) + maxWaitMs),
        ).toISOString();
        if (job.nextAttemptAt === deadline) continue;
        this.updateJob({
          jobId: job.jobId,
          expectedVersion: job.version,
          nextAttemptAt: deadline,
          idempotencyKey: `${prefix}:${job.jobId}:${job.version}:${deadline}`,
        });
        changed++;
      }
      return changed;
    });
  }

  cancelSessionJobs(input: CancelSessionJobsInput): number {
    const sessionId = requireNonEmpty(input.sessionId, "sessionId", MAX_ID_LENGTH);
    const type = requireNonEmpty(input.type, "type", 128);
    const extractorVersion = requireNonEmpty(input.extractorVersion, "extractorVersion", 128);
    const afterSequence = normalizeOptionalNonNegativeInteger(input.afterSequence, "afterSequence");
    const errorCode = normalizeOptionalCode(input.errorCode, "errorCode");
    if (!errorCode) throw new Error("errorCode is required");
    const prefix = requireNonEmpty(input.idempotencyKeyPrefix, "idempotencyKeyPrefix", 512);
    return this.transaction(() => {
      const rows = this.read(() =>
        this.allRows(
          `SELECT * FROM memory_jobs
           WHERE status IN ('queued','running','failed') AND type = ? AND extractor_version = ?
           ORDER BY created_at, job_id`,
          type,
          extractorVersion,
        ),
      )
        .map((row) => rowToJob(row, this.workspaceId))
        .filter((job) => job.cursor.sessionId === sessionId);
      let changed = 0;
      for (const job of rows) {
        if (
          afterSequence !== undefined &&
          job.cursor.sequence !== undefined &&
          job.cursor.sequence <= afterSequence
        ) {
          continue;
        }
        this.updateJob({
          jobId: job.jobId,
          expectedVersion: job.version,
          status: "cancelled",
          nextAttemptAt: null,
          errorCode,
          idempotencyKey: `${prefix}:${job.jobId}:${job.version}`,
        });
        changed++;
      }
      return changed;
    });
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
        const at = this.timestamp();
        const terminal = isTerminalJobStatus(status);
        const job: Job = compact({
          ...current,
          status,
          sourceId,
          attemptCount: normalizeNonNegativeInteger(
            input.attemptCount ?? current.attemptCount,
            "attemptCount",
          ),
          maxAttempts: normalizePositiveInteger(
            input.maxAttempts ?? current.maxAttempts,
            "maxAttempts",
          ),
          nextAttemptAt:
            input.nextAttemptAt === undefined
              ? current.nextAttemptAt
              : (normalizeOptionalTimestamp(input.nextAttemptAt, "nextAttemptAt") ?? undefined),
          errorCode:
            input.errorCode === undefined
              ? current.errorCode
              : (normalizeOptionalCode(input.errorCode, "errorCode") ?? undefined),
          modelCalls: normalizeNonNegativeInteger(
            input.modelCalls ?? current.modelCalls,
            "modelCalls",
          ),
          inputTokens: normalizeNonNegativeInteger(
            input.inputTokens ?? current.inputTokens,
            "inputTokens",
          ),
          outputTokens: normalizeNonNegativeInteger(
            input.outputTokens ?? current.outputTokens,
            "outputTokens",
          ),
          costUsd: normalizeNonNegativeNumber(input.costUsd ?? current.costUsd, "costUsd"),
          version: current.version + 1,
          updatedAt: at,
          terminalAt: terminal ? (at as string | undefined) : undefined,
        });
        this.insertJobRow(job);
        this.recordMutationLocked(
          "job",
          jobId,
          "job.updated",
          current.version,
          job.version,
          input.idempotencyKey,
          at,
        );
        return { value: job, marker: { jobId } };
      },
      (marker) => this.requireJob(readMarkerId(marker, "jobId")),
    );
  }

  enqueueProposedNotification(proposal: Proposal, idempotencyKey?: string): Job {
    if (proposal.workspaceId !== this.workspaceId || proposal.status !== "pending") {
      throw new Error("Only a pending proposal in this workspace can be published");
    }
    const identity = hashOpaqueKey(`${proposal.proposalId}\0${proposal.version}\0${proposal.kind}`);
    const jobId = `notification:proposed:${identity}`;
    const at = this.timestamp();
    return this.write(() =>
      this.enqueueNotificationJobLocked({
        jobId,
        type: MEMORY_PROPOSED_NOTIFICATION_JOB_TYPE,
        terminalEventId: identity,
        extractorVersion: `${MEMORY_PROPOSED_NOTIFICATION_VERSION_PREFIX}${proposal.kind}`,
        cursor: {
          sessionId: "memory-service",
          eventId: proposal.proposalId,
          sequence: proposal.version,
        },
        idempotencyKey,
        at,
      }),
    );
  }

  // ------------------------------------------------------------------
  // 内部:行读写与事务基础设施
  // ------------------------------------------------------------------

  private ensureMetadataLocked(): void {
    const existing = this.getMetadataValueLocked(METADATA_WORKSPACE_KEY);
    if (existing === undefined) {
      this.putMetadataRawLocked(METADATA_WORKSPACE_KEY, this.workspaceId);
      this.putMetadataRawLocked(METADATA_REVISION_KEY, 0);
      this.putMetadataRawLocked(
        METADATA_SETTINGS_KEY,
        defaultSettings(this.workspaceId, this.timestamp()),
      );
      return;
    }
    if (existing !== this.workspaceId) {
      throw new FileStorageIntegrityError(
        `Memory state belongs to workspace ${String(existing)}, not ${this.workspaceId}`,
      );
    }
    for (const key of [METADATA_REVISION_KEY, METADATA_SETTINGS_KEY]) {
      if (this.getMetadataValueLocked(key) === undefined) {
        throw new FileStorageIntegrityError(`Memory metadata row ${key} is missing`);
      }
    }
  }

  private readSettingsLocked(): Settings {
    const value = this.getMetadataValueLocked(METADATA_SETTINGS_KEY);
    if (!isRecord(value)) {
      throw new FileStorageIntegrityError("Memory settings row is invalid");
    }
    if (value["workspaceId"] !== this.workspaceId) {
      throw new FileStorageIntegrityError(
        `Memory state belongs to workspace ${String(value["workspaceId"])}, not ${this.workspaceId}`,
      );
    }
    return structuredClone(value) as unknown as Settings;
  }

  private getMetadataValueLocked(key: string): unknown {
    const row = this.getRow(`SELECT value_json FROM memory_metadata WHERE key = ?`, key) as
      | { value_json?: unknown }
      | undefined;
    if (row === undefined) return undefined;
    const json = row["value_json"];
    if (typeof json !== "string") {
      throw new FileStorageIntegrityError(`Memory metadata row ${key} is invalid`);
    }
    try {
      return JSON.parse(json);
    } catch (error) {
      throw new FileStorageIntegrityError(
        `Memory metadata row ${key} is not valid JSON: ${errorMessage(error)}`,
      );
    }
  }

  private putMetadataLocked(key: string, value: unknown): void {
    this.putMetadataRawLocked(key, value);
    this.markDirty();
  }

  private putMetadataRawLocked(key: string, value: unknown): void {
    this.database()
      .prepare(
        `INSERT INTO memory_metadata (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(key, JSON.stringify(value));
  }

  /** revision CAS:BEGIN IMMEDIATE 内读改写,等价旧 state.json 的 revision 递增。 */
  private bumpRevisionLocked(): void {
    const current = this.getMetadataValueLocked(METADATA_REVISION_KEY);
    if (typeof current !== "number" || !Number.isSafeInteger(current) || current < 0) {
      throw new FileStorageIntegrityError("Memory revision row is invalid");
    }
    this.putMetadataRawLocked(METADATA_REVISION_KEY, current + 1);
  }

  private getSourceRow(sourceId: string): Record<string, unknown> | undefined {
    return this.getRow(`SELECT * FROM memory_sources WHERE source_id = ?`, sourceId);
  }

  private getFactRow(factId: string): Record<string, unknown> | undefined {
    return this.getRow(`SELECT * FROM memory_facts WHERE fact_id = ?`, factId);
  }

  private getProposalRow(proposalId: string): Record<string, unknown> | undefined {
    return this.getRow(`SELECT * FROM memory_proposals WHERE proposal_id = ?`, proposalId);
  }

  private getJobRow(jobId: string): Record<string, unknown> | undefined {
    return this.getRow(`SELECT * FROM memory_jobs WHERE job_id = ?`, jobId);
  }

  /** 行级 UPSERT:写路径先校验版本/CAS,再整行覆盖(version 是主路径,PK 恒定)。 */
  private insertSourceRow(source: Source): void {
    this.mutate(
      `INSERT INTO memory_sources (
         source_id, session_id, run_id, branch_id, event_ids_json, start_sequence, end_sequence,
         digest, evidence_ref_json, availability, extraction_suppressed_at, invalidated_at,
         invalidation_code, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         session_id = excluded.session_id, run_id = excluded.run_id, branch_id = excluded.branch_id,
         event_ids_json = excluded.event_ids_json, start_sequence = excluded.start_sequence,
         end_sequence = excluded.end_sequence, digest = excluded.digest,
         evidence_ref_json = excluded.evidence_ref_json, availability = excluded.availability,
         extraction_suppressed_at = excluded.extraction_suppressed_at,
         invalidated_at = excluded.invalidated_at, invalidation_code = excluded.invalidation_code,
         version = excluded.version, created_at = excluded.created_at, updated_at = excluded.updated_at`,
      source.sourceId,
      source.sessionId,
      source.runId ?? null,
      source.branchId ?? null,
      canonicalJson([...source.eventIds]),
      source.startSequence ?? null,
      source.endSequence ?? null,
      source.digest,
      source.evidenceRef ? canonicalJson(source.evidenceRef) : null,
      source.availability,
      source.extractionSuppressedAt ?? null,
      source.invalidatedAt ?? null,
      source.invalidationCode ?? null,
      source.version,
      source.createdAt,
      source.updatedAt,
    );
  }

  private insertFactRow(fact: {
    readonly factId: string;
    readonly kind: MemoryKind;
    readonly title: string | null;
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
  }): void {
    this.mutate(
      `INSERT INTO memory_facts (
         fact_id, kind, title, content, confidence, source_id, state, pinned, expires_at,
         last_used_at, version, created_at, updated_at, forgotten_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fact_id) DO UPDATE SET
         kind = excluded.kind, title = excluded.title, content = excluded.content,
         confidence = excluded.confidence, source_id = excluded.source_id, state = excluded.state,
         pinned = excluded.pinned, expires_at = excluded.expires_at,
         last_used_at = excluded.last_used_at, version = excluded.version,
         created_at = excluded.created_at, updated_at = excluded.updated_at,
         forgotten_at = excluded.forgotten_at`,
      fact.factId,
      fact.kind,
      fact.title,
      fact.content,
      fact.confidence,
      fact.sourceId ?? null,
      fact.state,
      fact.pinned ? 1 : 0,
      fact.expiresAt ?? null,
      fact.lastUsedAt ?? null,
      fact.version,
      fact.createdAt,
      fact.updatedAt,
      fact.forgottenAt ?? null,
    );
  }

  private insertProposalRow(proposal: Proposal): void {
    this.mutate(
      `INSERT INTO memory_proposals (
         proposal_id, kind, title, content, reason, confidence, source_id, status,
         conflict_status, conflict_fact_id, resolved_fact_id, version, created_at, updated_at,
         reviewed_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(proposal_id) DO UPDATE SET
         kind = excluded.kind, title = excluded.title, content = excluded.content,
         reason = excluded.reason, confidence = excluded.confidence,
         source_id = excluded.source_id, status = excluded.status,
         conflict_status = excluded.conflict_status,
         conflict_fact_id = excluded.conflict_fact_id,
         resolved_fact_id = excluded.resolved_fact_id, version = excluded.version,
         created_at = excluded.created_at, updated_at = excluded.updated_at,
         reviewed_at = excluded.reviewed_at, deleted_at = excluded.deleted_at`,
      proposal.proposalId,
      proposal.kind,
      proposal.title,
      proposal.content,
      proposal.reason,
      proposal.confidence,
      proposal.sourceId ?? null,
      proposal.status,
      proposal.conflictStatus,
      proposal.conflictFactId ?? null,
      proposal.resolvedFactId ?? null,
      proposal.version,
      proposal.createdAt,
      proposal.updatedAt,
      proposal.reviewedAt ?? null,
      proposal.deletedAt ?? null,
    );
  }

  private insertJobRow(job: Job): void {
    this.mutate(
      `INSERT INTO memory_jobs (
         job_id, type, status, terminal_event_id, extractor_version, cursor_json, source_id,
         attempt_count, max_attempts, next_attempt_at, error_code, model_calls, input_tokens,
         output_tokens, cost_usd, version, created_at, updated_at, terminal_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         type = excluded.type, status = excluded.status,
         terminal_event_id = excluded.terminal_event_id,
         extractor_version = excluded.extractor_version, cursor_json = excluded.cursor_json,
         source_id = excluded.source_id, attempt_count = excluded.attempt_count,
         max_attempts = excluded.max_attempts, next_attempt_at = excluded.next_attempt_at,
         error_code = excluded.error_code, model_calls = excluded.model_calls,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cost_usd = excluded.cost_usd, version = excluded.version,
         created_at = excluded.created_at, updated_at = excluded.updated_at,
         terminal_at = excluded.terminal_at`,
      job.jobId,
      job.type,
      job.status,
      job.terminalEventId,
      job.extractorVersion,
      canonicalJson(job.cursor),
      job.sourceId ?? null,
      job.attemptCount,
      job.maxAttempts,
      job.nextAttemptAt ?? null,
      job.errorCode ?? null,
      job.modelCalls,
      job.inputTokens,
      job.outputTokens,
      job.costUsd,
      job.version,
      job.createdAt,
      job.updatedAt,
      job.terminalAt ?? null,
    );
  }

  private recordMutationLocked(
    entityType: MutationEntityType,
    entityId: string,
    action: MutationAction,
    fromVersion: number | undefined,
    toVersion: number,
    idempotencyKey: string | undefined,
    createdAt: string,
  ): void {
    const keyHash = idempotencyKey
      ? hashOpaqueKey(normalizeIdempotencyKey(idempotencyKey))
      : undefined;
    this.mutate(
      `INSERT INTO memory_mutations (
         sequence, mutation_id, entity_type, entity_id, action, from_version, to_version,
         idempotency_key_hash, created_at
       ) VALUES (
         (SELECT COALESCE(MAX(sequence), 0) + 1 FROM memory_mutations),
         ?, ?, ?, ?, ?, ?, ?, ?
       )`,
      `mutation:${randomUUID()}`,
      entityType,
      entityId,
      action,
      fromVersion ?? null,
      toVersion,
      keyHash ?? null,
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
    return this.write(() => {
      if (!idempotencyKey) return execute().value;
      const key = normalizeIdempotencyKey(idempotencyKey);
      const keyHash = hashOpaqueKey(key);
      const requestHash = hashCanonicalJson(request);
      const identity = `${operation}:${keyHash}`;
      const existing = this.getRow(
        `SELECT request_hash, marker_json FROM memory_idempotency WHERE operation_key = ?`,
        identity,
      ) as { request_hash?: unknown; marker_json?: unknown } | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new MemoryIdempotencyConflictError(operation);
        }
        return replay(decodeMarker(existing.marker_json, identity));
      }
      const result = execute();
      this.mutate(
        `INSERT INTO memory_idempotency (operation_key, request_hash, marker_json, created_at)
         VALUES (?, ?, ?, ?)`,
        identity,
        requestHash,
        canonicalJson(result.marker),
        this.timestamp(),
      );
      return result.value;
    });
  }

  private enqueueNotificationJobLocked(input: {
    readonly jobId: string;
    readonly type: string;
    readonly terminalEventId: string;
    readonly extractorVersion: string;
    readonly cursor: MemoryJobCursor;
    readonly idempotencyKey?: string;
    readonly at: string;
  }): Job {
    const existingRow = this.getJobRow(input.jobId);
    if (existingRow) return rowToJob(existingRow, this.workspaceId);
    const job: Job = {
      jobId: input.jobId,
      workspaceId: this.workspaceId,
      type: input.type,
      status: "queued",
      terminalEventId: input.terminalEventId,
      extractorVersion: input.extractorVersion,
      cursor: input.cursor,
      attemptCount: 0,
      maxAttempts: 1,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      version: 1,
      createdAt: input.at,
      updatedAt: input.at,
    };
    this.insertJobRow(job);
    this.recordMutationLocked(
      "job",
      input.jobId,
      "job.created",
      undefined,
      1,
      input.idempotencyKey,
      input.at,
    );
    return job;
  }

  private enqueueForgottenNotification(
    fact: Fact,
    idempotencyKey: string | undefined,
    at: string,
  ): void {
    const identity = hashOpaqueKey(`${fact.factId}\0${fact.version}`);
    const jobId = `notification:forgotten:${identity}`;
    this.enqueueNotificationJobLocked({
      jobId,
      type: MEMORY_FORGOTTEN_NOTIFICATION_JOB_TYPE,
      terminalEventId: identity,
      extractorVersion: MEMORY_FORGOTTEN_NOTIFICATION_VERSION,
      cursor: { sessionId: "memory-service", eventId: fact.factId },
      idempotencyKey,
      at,
    });
  }

  private enqueueSourceChangedNotification(
    source: Source,
    idempotencyKey: string | undefined,
    at: string,
  ): void {
    const identity = hashOpaqueKey(`${source.sourceId}\0${source.version}\0${source.availability}`);
    const jobId = `notification:source:${identity}`;
    this.enqueueNotificationJobLocked({
      jobId,
      type: MEMORY_SOURCE_NOTIFICATION_JOB_TYPE,
      terminalEventId: identity,
      extractorVersion: MEMORY_SOURCE_UNAVAILABLE_NOTIFICATION_VERSION,
      cursor: { sessionId: "memory-service", eventId: source.sourceId, sequence: source.version },
      idempotencyKey,
      at,
    });
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

  private requireUnchangedActiveConflictFact(proposal: Proposal): Fact {
    const factId = proposal.conflictFactId;
    if (!factId) {
      throw new MemoryConflictError(`Proposal ${proposal.proposalId} has no conflict fact`);
    }
    const fact = this.requireFact(factId);
    if (fact.state !== "active") {
      throw new MemoryConflictError(`Conflict fact ${factId} is no longer active`);
    }
    const proposalCreated = this.getNumber(
      `SELECT MAX(sequence) AS seq FROM memory_mutations
       WHERE entity_type = 'proposal' AND entity_id = ? AND action = 'proposal.created'`,
      proposal.proposalId,
    );
    if (proposalCreated === undefined) {
      throw new MemoryConflictError(
        `Conflict proposal ${proposal.proposalId} has no creation audit record`,
      );
    }
    const changedAfterProposal = this.getRow(
      `SELECT 1 AS one FROM memory_mutations
       WHERE entity_type = 'fact' AND entity_id = ? AND sequence > ? LIMIT 1`,
      factId,
      proposalCreated,
    );
    if (changedAfterProposal) {
      throw new MemoryConflictError(
        `Conflict fact ${factId} changed after proposal ${proposal.proposalId} was created`,
      );
    }
    return fact;
  }

  private getRow(sql: string, ...params: SQLInputValue[]): Record<string, unknown> | undefined {
    return this.database()
      .prepare(sql)
      .get(...params) as Record<string, unknown> | undefined;
  }

  private getNumber(sql: string, ...params: SQLInputValue[]): number | undefined {
    const row = this.getRow(sql, ...params) as { seq?: unknown } | undefined;
    return typeof row?.["seq"] === "number" ? row["seq"] : undefined;
  }

  private allRows(sql: string, ...params: SQLInputValue[]): Array<Record<string, unknown>> {
    return this.database()
      .prepare(sql)
      .all(...params) as Array<Record<string, unknown>>;
  }

  private mutate(sql: string, ...params: SQLInputValue[]): void {
    this.database()
      .prepare(sql)
      .run(...params);
    this.markDirty();
  }

  private markDirty(): void {
    const active = activeMemorySqliteWrites.get(this.storageRoot);
    if (active) active.dirty = true;
  }

  private write<Result>(operation: () => Result): Result {
    this.assertNotClosed();
    const active = activeMemorySqliteWrites.get(this.storageRoot);
    if (active) {
      // 嵌套写(同根活跃事务):SAVEPOINT 划回滚边界,失败只回滚嵌套段的行变更。
      const savepoint = `memory_sp_${active.savepointCounter++}`;
      this.database().exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = operation();
        this.database().exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        try {
          this.database().exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.database().exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          // 保留原始错误
        }
        throw error;
      }
    }
    return this.lease.transaction("write", () => {
      const tx: MemorySqliteWriteTx = { dirty: false, savepointCounter: 0 };
      activeMemorySqliteWrites.set(this.storageRoot, tx);
      try {
        const result = operation();
        if (tx.dirty) this.bumpRevisionLocked();
        return result;
      } finally {
        activeMemorySqliteWrites.delete(this.storageRoot);
      }
    });
  }

  private read<Result>(operation: () => Result): Result {
    this.assertNotClosed();
    // 同根活跃写事务内:同连接直读,未提交写入可见(与 control store 口径一致)。
    if (activeMemorySqliteWrites.has(this.storageRoot)) return operation();
    return this.lease.transaction("read", operation);
  }

  private database() {
    return this.lease.database;
  }

  private assertNotClosed(): void {
    if (this.closed) throw new Error("SqliteMemoryRepository is closed");
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

// ---------------------------------------------------------------------------
// 行 decode:列类型校验 fail-closed 为 FileStorageIntegrityError
// ---------------------------------------------------------------------------

function rowToSource(row: Record<string, unknown>, workspaceId: WorkspaceId): Source {
  const sourceId = requireRowString(row["source_id"], "memory_sources.source_id");
  const evidenceRefJson = optionalRowString(
    row["evidence_ref_json"],
    `memory_sources[${sourceId}].evidence_ref_json`,
  );
  // evidenceRef overlay 读路径 soft 降级:校验失败剥离字段,不阻断整个 memory。
  let evidenceRef: EvidenceRef | undefined;
  if (evidenceRefJson !== undefined) {
    try {
      const candidate = JSON.parse(evidenceRefJson);
      const validation = validateEvidenceRef(candidate);
      if (validation.ok) evidenceRef = validation.ref;
    } catch {
      // 剥离即可
    }
  }
  return {
    sourceId,
    workspaceId,
    sessionId: requireRowString(row["session_id"], `memory_sources[${sourceId}].session_id`),
    ...optionalField(
      optionalRowString(row["run_id"], `memory_sources[${sourceId}].run_id`),
      "runId",
    ),
    ...optionalField(
      optionalRowString(row["branch_id"], `memory_sources[${sourceId}].branch_id`),
      "branchId",
    ),
    eventIds: decodeEventIds(row["event_ids_json"], sourceId),
    ...optionalPositiveField(
      optionalRowInteger(row["start_sequence"], `memory_sources[${sourceId}].start_sequence`),
      "startSequence",
    ),
    ...optionalPositiveField(
      optionalRowInteger(row["end_sequence"], `memory_sources[${sourceId}].end_sequence`),
      "endSequence",
    ),
    digest: requireRowString(row["digest"], `memory_sources[${sourceId}].digest`),
    ...(evidenceRef ? { evidenceRef } : {}),
    availability: requireRowEnum(
      row["availability"],
      SOURCE_AVAILABILITIES,
      `memory_sources[${sourceId}].availability`,
    ),
    ...optionalTimestampField(
      optionalRowString(
        row["extraction_suppressed_at"],
        `memory_sources[${sourceId}].extraction_suppressed_at`,
      ),
      "extractionSuppressedAt",
    ),
    ...optionalTimestampField(
      optionalRowString(row["invalidated_at"], `memory_sources[${sourceId}].invalidated_at`),
      "invalidatedAt",
    ),
    ...optionalField(
      optionalRowString(row["invalidation_code"], `memory_sources[${sourceId}].invalidation_code`),
      "invalidationCode",
    ),
    version: requireRowPositiveInteger(row["version"], `memory_sources[${sourceId}].version`),
    createdAt: requireRowTimestamp(row["created_at"], `memory_sources[${sourceId}].created_at`),
    updatedAt: requireRowTimestamp(row["updated_at"], `memory_sources[${sourceId}].updated_at`),
  };
}

function rowToFact(row: Record<string, unknown>, workspaceId: WorkspaceId): Fact {
  const factId = requireRowString(row["fact_id"], "memory_facts.fact_id");
  return {
    factId,
    workspaceId,
    kind: requireRowEnum(row["kind"], MEMORY_KINDS, `memory_facts[${factId}].kind`),
    title:
      row["title"] === null
        ? null
        : requireRowString(row["title"], `memory_facts[${factId}].title`),
    content:
      row["content"] === null
        ? null
        : requireRowString(row["content"], `memory_facts[${factId}].content`),
    confidence: requireRowNumber(row["confidence"], `memory_facts[${factId}].confidence`),
    ...optionalField(
      optionalRowString(row["source_id"], `memory_facts[${factId}].source_id`),
      "sourceId",
    ),
    state: requireRowEnum(row["state"], FACT_STATES, `memory_facts[${factId}].state`),
    pinned: row["pinned"] === 1,
    ...optionalTimestampField(
      optionalRowString(row["expires_at"], `memory_facts[${factId}].expires_at`),
      "expiresAt",
    ),
    ...optionalTimestampField(
      optionalRowString(row["last_used_at"], `memory_facts[${factId}].last_used_at`),
      "lastUsedAt",
    ),
    version: requireRowPositiveInteger(row["version"], `memory_facts[${factId}].version`),
    createdAt: requireRowTimestamp(row["created_at"], `memory_facts[${factId}].created_at`),
    updatedAt: requireRowTimestamp(row["updated_at"], `memory_facts[${factId}].updated_at`),
    ...optionalTimestampField(
      optionalRowString(row["forgotten_at"], `memory_facts[${factId}].forgotten_at`),
      "forgottenAt",
    ),
  };
}

function rowToProposal(row: Record<string, unknown>, workspaceId: WorkspaceId): Proposal {
  const proposalId = requireRowString(row["proposal_id"], "memory_proposals.proposal_id");
  return {
    proposalId,
    workspaceId,
    kind: requireRowEnum(row["kind"], MEMORY_KINDS, `memory_proposals[${proposalId}].kind`),
    title:
      row["title"] === null
        ? null
        : requireRowString(row["title"], `memory_proposals[${proposalId}].title`),
    content:
      row["content"] === null
        ? null
        : requireRowString(row["content"], `memory_proposals[${proposalId}].content`),
    reason:
      row["reason"] === null
        ? null
        : requireRowString(row["reason"], `memory_proposals[${proposalId}].reason`),
    confidence: requireRowNumber(row["confidence"], `memory_proposals[${proposalId}].confidence`),
    ...optionalField(
      optionalRowString(row["source_id"], `memory_proposals[${proposalId}].source_id`),
      "sourceId",
    ),
    status: requireRowEnum(
      row["status"],
      PROPOSAL_STATUSES,
      `memory_proposals[${proposalId}].status`,
    ),
    conflictStatus: requireRowEnum(
      row["conflict_status"],
      PROPOSAL_CONFLICT_STATUSES,
      `memory_proposals[${proposalId}].conflict_status`,
    ),
    ...optionalField(
      optionalRowString(
        row["conflict_fact_id"],
        `memory_proposals[${proposalId}].conflict_fact_id`,
      ),
      "conflictFactId",
    ),
    ...optionalField(
      optionalRowString(
        row["resolved_fact_id"],
        `memory_proposals[${proposalId}].resolved_fact_id`,
      ),
      "resolvedFactId",
    ),
    version: requireRowPositiveInteger(row["version"], `memory_proposals[${proposalId}].version`),
    createdAt: requireRowTimestamp(row["created_at"], `memory_proposals[${proposalId}].created_at`),
    updatedAt: requireRowTimestamp(row["updated_at"], `memory_proposals[${proposalId}].updated_at`),
    ...optionalTimestampField(
      optionalRowString(row["reviewed_at"], `memory_proposals[${proposalId}].reviewed_at`),
      "reviewedAt",
    ),
    ...optionalTimestampField(
      optionalRowString(row["deleted_at"], `memory_proposals[${proposalId}].deleted_at`),
      "deletedAt",
    ),
  };
}

function rowToJob(row: Record<string, unknown>, workspaceId: WorkspaceId): Job {
  const jobId = requireRowString(row["job_id"], "memory_jobs.job_id");
  return {
    jobId,
    workspaceId,
    type: requireRowString(row["type"], `memory_jobs[${jobId}].type`),
    status: requireRowEnum(row["status"], MEMORY_JOB_STATUSES, `memory_jobs[${jobId}].status`),
    terminalEventId: requireRowString(
      row["terminal_event_id"],
      `memory_jobs[${jobId}].terminal_event_id`,
    ),
    extractorVersion: requireRowString(
      row["extractor_version"],
      `memory_jobs[${jobId}].extractor_version`,
    ),
    cursor: decodeJobCursor(row["cursor_json"], jobId),
    ...optionalField(
      optionalRowString(row["source_id"], `memory_jobs[${jobId}].source_id`),
      "sourceId",
    ),
    attemptCount: requireRowNonNegativeInteger(
      row["attempt_count"],
      `memory_jobs[${jobId}].attempt_count`,
    ),
    maxAttempts: requireRowPositiveInteger(
      row["max_attempts"],
      `memory_jobs[${jobId}].max_attempts`,
    ),
    ...optionalTimestampField(
      optionalRowString(row["next_attempt_at"], `memory_jobs[${jobId}].next_attempt_at`),
      "nextAttemptAt",
    ),
    ...optionalField(
      optionalRowString(row["error_code"], `memory_jobs[${jobId}].error_code`),
      "errorCode",
    ),
    modelCalls: requireRowNonNegativeInteger(
      row["model_calls"],
      `memory_jobs[${jobId}].model_calls`,
    ),
    inputTokens: requireRowNonNegativeInteger(
      row["input_tokens"],
      `memory_jobs[${jobId}].input_tokens`,
    ),
    outputTokens: requireRowNonNegativeInteger(
      row["output_tokens"],
      `memory_jobs[${jobId}].output_tokens`,
    ),
    costUsd: requireRowNumber(row["cost_usd"], `memory_jobs[${jobId}].cost_usd`),
    version: requireRowPositiveInteger(row["version"], `memory_jobs[${jobId}].version`),
    createdAt: requireRowTimestamp(row["created_at"], `memory_jobs[${jobId}].created_at`),
    updatedAt: requireRowTimestamp(row["updated_at"], `memory_jobs[${jobId}].updated_at`),
    ...optionalTimestampField(
      optionalRowString(row["terminal_at"], `memory_jobs[${jobId}].terminal_at`),
      "terminalAt",
    ),
  };
}

function rowToMutation(row: Record<string, unknown>, workspaceId: WorkspaceId): Mutation {
  const sequence = requireRowPositiveInteger(row["sequence"], "memory_mutations.sequence");
  return {
    sequence,
    mutationId: requireRowString(row["mutation_id"], `memory_mutations[${sequence}].mutation_id`),
    workspaceId,
    entityType: requireRowEnum(
      row["entity_type"],
      ["settings", "fact", "proposal", "source", "job"],
      `memory_mutations[${sequence}].entity_type`,
    ) as Mutation["entityType"],
    entityId: requireRowString(row["entity_id"], `memory_mutations[${sequence}].entity_id`),
    action: requireRowEnum(
      row["action"],
      [
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
      ],
      `memory_mutations[${sequence}].action`,
    ) as Mutation["action"],
    ...optionalPositiveField(
      optionalRowInteger(row["from_version"], `memory_mutations[${sequence}].from_version`),
      "fromVersion",
    ),
    toVersion: requireRowPositiveInteger(
      row["to_version"],
      `memory_mutations[${sequence}].to_version`,
    ),
    ...optionalField(
      optionalRowString(
        row["idempotency_key_hash"],
        `memory_mutations[${sequence}].idempotency_key_hash`,
      ),
      "idempotencyKeyHash",
    ),
    createdAt: requireRowTimestamp(row["created_at"], `memory_mutations[${sequence}].created_at`),
  };
}

function decodeEventIds(value: unknown, sourceId: string): readonly string[] {
  const json = requireRowString(value, `memory_sources[${sourceId}].event_ids_json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new FileStorageIntegrityError(
      `Memory source ${sourceId} eventIds is not valid JSON: ${errorMessage(error)}`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new FileStorageIntegrityError(`Memory source ${sourceId} eventIds is invalid`);
  }
  return parsed as readonly string[];
}

function decodeJobCursor(value: unknown, jobId: string): MemoryJobCursor {
  const json = requireRowString(value, `memory_jobs[${jobId}].cursor_json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new FileStorageIntegrityError(
      `Memory job ${jobId} cursor is not valid JSON: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new FileStorageIntegrityError(`Memory job ${jobId} cursor is invalid`);
  }
  const sessionId = requireRowString(parsed["sessionId"], `memory_jobs[${jobId}].cursor.sessionId`);
  const sequence = parsed["sequence"];
  const eventId = parsed["eventId"];
  if (sequence !== undefined && !Number.isSafeInteger(sequence) && (sequence as number) < 0) {
    throw new FileStorageIntegrityError(`Memory job ${jobId} cursor.sequence is invalid`);
  }
  if (eventId !== undefined && typeof eventId !== "string") {
    throw new FileStorageIntegrityError(`Memory job ${jobId} cursor.eventId is invalid`);
  }
  return {
    sessionId,
    ...(sequence === undefined ? {} : { sequence: sequence as number }),
    ...(eventId === undefined ? {} : { eventId: eventId as string }),
  };
}

function decodeMarker(value: unknown, identity: string): Readonly<Record<string, unknown>> {
  const json = requireRowString(value, `memory_idempotency[${identity}].marker_json`);
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!isRecord(parsed)) throw new Error("marker is not an object");
    return parsed;
  } catch (error) {
    throw new FileStorageIntegrityError(
      `Memory idempotency ${identity} marker is invalid: ${errorMessage(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 归一化与校验(与旧实现同款语义)
// ---------------------------------------------------------------------------

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
  "modelCalls",
  "inputTokens",
  "outputTokens",
  "costUsd",
] as const;

function defaultSettings(workspaceId: WorkspaceId, at: string): Settings {
  return {
    workspaceId,
    enabled: true,
    autoPropose: true,
    autoCommit: true,
    injectionEnabled: true,
    reviewMode: "balanced",
    version: 1,
    updatedAt: at,
  };
}

function normalizeSourceInput(input: CreateSourceInput): {
  readonly sessionId: string;
  readonly runId?: string;
  readonly branchId?: string;
  readonly eventIds: readonly string[];
  readonly startSequence?: number;
  readonly endSequence?: number;
  readonly digest: string;
  readonly evidenceRef?: EvidenceRef;
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
  // evidenceRef overlay:校验失败时静默降级(不阻断 source 创建)。
  const evidenceRefValidation = input.evidenceRef
    ? validateEvidenceRef(input.evidenceRef)
    : undefined;
  const evidenceRef = evidenceRefValidation?.ok ? evidenceRefValidation.ref : undefined;
  return {
    sessionId,
    ...(runId ? { runId } : {}),
    ...(branchId ? { branchId } : {}),
    eventIds,
    ...(startSequence === undefined ? {} : { startSequence }),
    ...(endSequence === undefined ? {} : { endSequence }),
    digest,
    ...(evidenceRef ? { evidenceRef } : {}),
    request: {
      sourceId: input.sourceId,
      sessionId,
      runId,
      branchId,
      eventIds,
      startSequence,
      endSequence,
      digest,
      // evidenceRef 刻意不纳入 request——overlay 元数据不参与幂等 requestHash。
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

function normalizeResolveProposalPatch(
  patch: ResolveProposalInput["patch"],
): ResolveProposalInput["patch"] {
  if (patch === undefined) return undefined;
  if (!hasDefinedPatch(patch, ["kind", "title", "content", "reason", "confidence"] as const)) {
    throw new Error("Proposal resolution patch must include at least one field");
  }
  return {
    ...(patch.kind !== undefined ? { kind: requireEnum(patch.kind, MEMORY_KINDS, "kind") } : {}),
    ...(patch.title !== undefined
      ? { title: requireText(patch.title, "title", MAX_TITLE_LENGTH) }
      : {}),
    ...(patch.content !== undefined
      ? { content: requireText(patch.content, "content", MAX_CONTENT_LENGTH) }
      : {}),
    ...(patch.reason !== undefined
      ? { reason: requireText(patch.reason, "reason", MAX_REASON_LENGTH) }
      : {}),
    ...(patch.confidence !== undefined
      ? { confidence: normalizeConfidence(patch.confidence) }
      : {}),
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

function hasDefinedPatch(value: object, keys: readonly string[]): boolean {
  const record = value as Readonly<Record<string, unknown>>;
  return keys.some((key) => record[key] !== undefined);
}

function assertVersion(entity: string, id: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new MemoryConflictError(
      `Memory ${entity} ${id} version changed from ${expected} to ${actual}`,
    );
  }
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

function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function hashOpaqueKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireSynchronousTransactionResult<Result>(result: Result): Result {
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    typeof (result as { readonly then?: unknown }).then === "function"
  ) {
    throw new MemoryAsyncTransactionError();
  }
  return result;
}

function compact<Value extends object>(value: Value): Value {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

function buildWhereClause(clauses: readonly string[]): string {
  return clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function optionalField<T>(value: T | undefined, key: string): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function optionalPositiveField(
  value: number | undefined,
  key: "startSequence" | "endSequence" | "fromVersion",
): Record<string, number> {
  return value === undefined ? {} : { [key]: value };
}

function optionalTimestampField(value: string | undefined, key: string): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

function requireRowString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FileStorageIntegrityError(`SQLite memory row ${field} is invalid`);
  }
  return value;
}

function optionalRowString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireRowString(value, field);
}

function optionalRowInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new FileStorageIntegrityError(`SQLite memory row ${field} is invalid`);
  }
  return value;
}

function requireRowPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new FileStorageIntegrityError(`SQLite memory row ${field} is invalid`);
  }
  return value;
}

function requireRowNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new FileStorageIntegrityError(`SQLite memory row ${field} is invalid`);
  }
  return value;
}

function requireRowNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FileStorageIntegrityError(`SQLite memory row ${field} is invalid`);
  }
  return value;
}

function requireRowTimestamp(value: unknown, field: string): string {
  const timestamp = requireRowString(value, field);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new FileStorageIntegrityError(`SQLite memory row ${field} is invalid`);
  }
  return timestamp;
}

function requireRowEnum<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  field: string,
): Value {
  const raw = requireRowString(value, field);
  if (!allowed.includes(raw as Value)) {
    throw new FileStorageIntegrityError(`SQLite memory row ${field} is invalid`);
  }
  return raw as Value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
