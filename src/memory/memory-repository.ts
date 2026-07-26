import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { WorkspaceId } from "../paths/pico-paths.js";
import {
  assertLocalFileStorageCapabilitiesSync,
  commitFileTransactionSync,
  FileStorageIntegrityError,
  readJsonFileSync,
  recoverFileTransactionSync,
  syncDirectorySync,
  withFileLockSync,
} from "../storage/local-file-storage.js";
import { LeaseConflictError } from "../storage/owner-lease.js";
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
  type MemoryReviewMode,
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
import {
  createMemoryFileState,
  decodeMemoryFileState,
  type MemoryFileState,
  type MemoryIdempotencyRecord,
} from "./memory-file-state.js";

const MAX_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 512;
const MAX_CONTENT_LENGTH = 32_000;
const MAX_REASON_LENGTH = 4_000;
const MAX_LIST_LIMIT = 500;
const memoryLockWait = new Int32Array(new SharedArrayBuffer(4));

export const MEMORY_FORGOTTEN_NOTIFICATION_JOB_TYPE = "notification.memory.forgotten" as const;
export const MEMORY_FORGOTTEN_NOTIFICATION_VERSION = "memory-forgotten-notification-v1" as const;
export const MEMORY_PROPOSED_NOTIFICATION_JOB_TYPE = "notification.memory.proposed" as const;
export const MEMORY_PROPOSED_NOTIFICATION_VERSION_PREFIX =
  "memory-proposed-notification-v1:" as const;
export const MEMORY_SOURCE_NOTIFICATION_JOB_TYPE = "notification.memory.source-changed" as const;
export const MEMORY_SOURCE_UNAVAILABLE_NOTIFICATION_VERSION =
  "memory-source-notification-v1:unavailable" as const;
export const MEMORY_SOURCE_REWOUND_NOTIFICATION_VERSION =
  "memory-source-notification-v1:rewound" as const;

type RejectAsyncTransactionArguments<Result> = [Result] extends [never]
  ? []
  : Result extends PromiseLike<unknown>
    ? ["MemoryRepository.transaction callback must be synchronous"]
    : [];

export interface MemoryRepositoryOptions {
  readonly storageRoot: string;
  readonly workspaceId: WorkspaceId;
  readonly now?: () => Date;
  readonly busyTimeoutMs?: number;
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
  readonly reviewMode?: MemoryReviewMode;
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
  readonly patch?: {
    readonly kind?: MemoryKind;
    readonly title?: string;
    readonly content?: string;
    readonly reason?: string;
    readonly confidence?: number;
  };
}

export interface ResolveProposalResult {
  readonly proposal: Proposal;
  readonly fact?: Fact;
}

export interface ProposalListOptions {
  readonly statuses?: readonly ProposalStatus[];
  readonly limit?: number;
}

export interface SessionSourceListOptions {
  readonly availability?: SourceAvailability;
  readonly afterSequence?: number;
  readonly afterSourceId?: string;
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
  readonly modelCalls?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

export interface JobListOptions {
  readonly statuses?: readonly MemoryJobStatus[];
  readonly type?: string;
  readonly extractorVersion?: string;
  /** Only return jobs whose retry delay has elapsed (or which have no delay). */
  readonly readyAt?: string;
  /** Exclude jobs which have already consumed their configured attempt budget. */
  readonly attemptsRemaining?: true;
  /** Restrict to jobs carrying actual model-call usage, including zero-call batch shares. */
  readonly withModelUsage?: true;
  readonly order?: "newest" | "oldest";
  readonly limit?: number;
}

export interface RescheduleQueuedJobsInput {
  readonly type: string;
  readonly extractorVersion: string;
  readonly requestedAt: string;
  readonly maxWaitMs: number;
  readonly idempotencyKeyPrefix: string;
}

export interface CancelSessionJobsInput {
  readonly sessionId: string;
  readonly type: string;
  readonly extractorVersion: string;
  readonly afterSequence?: number;
  readonly errorCode: string;
  readonly idempotencyKeyPrefix: string;
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

export class MemoryAsyncTransactionError extends TypeError {
  constructor() {
    super("MemoryRepository.transaction callback must return synchronously");
    this.name = "MemoryAsyncTransactionError";
  }
}

export class MemoryFileCleanupError extends FileStorageIntegrityError {
  constructor(path: string, cause: unknown) {
    super(`Failed to clean stale memory temporary file ${path}: ${errorMessage(cause)}`);
    this.name = "MemoryFileCleanupError";
  }
}

export class MemoryPlaintextVerificationError extends FileStorageIntegrityError {
  constructor(path: string, cause?: unknown) {
    super(
      cause === undefined
        ? `Deleted memory text remains in live file ${path}`
        : `Failed to verify deleted memory text in ${path}: ${errorMessage(cause)}`,
    );
    this.name = "MemoryPlaintextVerificationError";
  }
}

interface MemoryTransactionContext {
  readonly workspaceId: WorkspaceId;
  readonly state: MemoryFileState;
  readonly forgottenSecrets: Set<string>;
  readonly forgottenFactIds: Set<string>;
}

const activeMemoryTransactions = new Map<string, MemoryTransactionContext>();

/** Workspace-scoped, file-backed authority for long-term memory. */
export class MemoryRepository {
  readonly storageRoot: string;
  readonly workspaceId: WorkspaceId;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly busyTimeoutMs: number;

  constructor(options: MemoryRepositoryOptions) {
    if (!options.storageRoot.trim()) {
      throw new Error("MemoryRepository storageRoot must not be empty");
    }
    const requestedStorageRoot = resolve(options.storageRoot);
    assertLocalFileStorageCapabilitiesSync(requestedStorageRoot);
    this.storageRoot = realpathSync.native(requestedStorageRoot);
    this.statePath = join(this.storageRoot, "state.json");
    this.lockPath = join(this.storageRoot, "lock");
    this.workspaceId = options.workspaceId;
    this.now = options.now ?? (() => new Date());
    this.busyTimeoutMs = normalizeNonNegativeInteger(
      options.busyTimeoutMs ?? 5_000,
      "busyTimeoutMs",
    );
    if (!statSync(this.storageRoot).isDirectory()) {
      throw new Error(`Memory storage root is not a directory: ${this.storageRoot}`);
    }
    this.withLock(() => {
      recoverFileTransactionSync(this.storageRoot);
      if (!existsSync(this.statePath)) {
        commitFileTransactionSync(this.storageRoot, {
          replacements: [
            {
              relativePath: "state.json",
              content: `${JSON.stringify(createMemoryFileState(this.workspaceId, this.timestamp()), null, 2)}\n`,
            },
          ],
        });
      }
      this.readState();
    });
  }

  close(): void {}

  transaction<Result>(
    operation: (repository: this) => Result,
    ..._rejectAsync: RejectAsyncTransactionArguments<Result>
  ): Result {
    return this.runTransaction(operation);
  }

  private runTransaction<Result>(operation: (repository: this) => Result): Result {
    const existing = activeMemoryTransactions.get(this.storageRoot);
    if (existing) {
      this.assertContextWorkspace(existing);
      return requireSynchronousTransactionResult(operation(this));
    }
    return this.withLock(() => {
      recoverFileTransactionSync(this.storageRoot);
      const context: MemoryTransactionContext = {
        workspaceId: this.workspaceId,
        state: this.readState(),
        forgottenSecrets: new Set(),
        forgottenFactIds: new Set(),
      };
      const initialState = JSON.stringify(context.state);
      activeMemoryTransactions.set(this.storageRoot, context);
      let result: Result;
      try {
        result = requireSynchronousTransactionResult(operation(this));
        if (context.forgottenFactIds.size > 0) this.cleanupTemporaryFiles();
        if (JSON.stringify(context.state) !== initialState) {
          context.state.revision += 1;
          commitFileTransactionSync(this.storageRoot, {
            replacements: [
              {
                relativePath: "state.json",
                content: `${JSON.stringify(context.state, null, 2)}\n`,
              },
            ],
          });
        }
      } finally {
        activeMemoryTransactions.delete(this.storageRoot);
      }
      if (context.forgottenFactIds.size > 0) {
        this.verifyForgottenEntities(this.readState(), context.forgottenFactIds);
        this.verifySecretsRemoved(context.forgottenSecrets);
      }
      return result;
    });
  }

  getSettings(): Settings {
    return this.read((state) => structuredClone(state.settings));
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
        const current = this.getSettings();
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
        this.state().settings = result;
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
        if (this.state().sources[sourceId])
          throw new MemoryConflictError(`Memory source ${sourceId} already exists`);
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
          availability: "available",
          version: 1,
          createdAt: at,
          updatedAt: at,
        };
        this.state().sources[sourceId] = source;
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
    const id = normalizeId(sourceId, "sourceId");
    return this.read((state) => cloneOptional(state.sources[id]));
  }

  listSources(limit = 100): Source[] {
    const bounded = normalizeLimit(limit);
    return this.read((state) =>
      Object.values(state.sources)
        .sort(
          (a, b) => compareDesc(a.createdAt, b.createdAt) || compareDesc(a.sourceId, b.sourceId),
        )
        .slice(0, bounded)
        .map(clone),
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
    return this.read((state) =>
      Object.values(state.sources)
        .filter((source) => source.sessionId === id)
        .filter((source) => availability === undefined || source.availability === availability)
        .filter(
          (source) =>
            afterSequence === undefined ||
            (source.endSequence ?? source.startSequence ?? 0) > afterSequence,
        )
        .filter((source) => afterSourceId === undefined || source.sourceId > afterSourceId)
        .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
        .slice(0, limit)
        .map(clone),
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
        this.state().sources[current.sourceId] = compact(result);
        this.recordMutation(
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
    const id = normalizeId(factId, "factId");
    return this.read((state) => cloneOptional(state.facts[id]));
  }

  listFacts(options: FactListOptions = {}): Fact[] {
    const states = options.states?.map((state) => requireEnum(state, FACT_STATES, "state"));
    const kinds = options.kinds?.map((kind) => requireEnum(kind, MEMORY_KINDS, "kind"));
    const limit = normalizeLimit(options.limit);
    return this.read((state) =>
      Object.values(state.facts)
        .filter((fact) => !states?.length || states.includes(fact.state))
        .filter((fact) => !kinds?.length || kinds.includes(fact.kind))
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            compareDesc(a.updatedAt, b.updatedAt) ||
            compareDesc(a.factId, b.factId),
        )
        .slice(0, limit)
        .map(clone),
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
        this.state().facts[factId] = result;
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
        const linkedProposals = Object.values(this.state().proposals).filter(
          (proposal) =>
            (proposal.resolvedFactId === factId || proposal.conflictFactId === factId) &&
            proposal.status !== "deleted",
        );
        const forgottenTexts = [
          current.title,
          current.content,
          ...linkedProposals.flatMap((proposal) => [
            proposal.title,
            proposal.content,
            proposal.reason,
          ]),
        ].filter((value): value is string => value !== null && value !== undefined);
        this.rememberForgetPostcondition(factId, forgottenTexts);
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
        this.state().facts[factId] = forgotten;
        for (const proposal of linkedProposals) {
          this.state().proposals[proposal.proposalId] = compact({
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
          this.recordMutation(
            "proposal",
            proposal.proposalId,
            "proposal.deleted",
            proposal.version,
            proposal.version + 1,
            input.idempotencyKey,
            at,
          );
        }
        this.recordMutation(
          "fact",
          factId,
          "fact.forgotten",
          current.version,
          forgotten.version,
          input.idempotencyKey,
          at,
        );
        this.enqueueForgottenNotification(forgotten, input.idempotencyKey, at);
        return { value: forgotten, marker: { factId } };
      },
      (marker) => {
        const replayFactId = readMarkerId(marker, "factId");
        this.rememberForgetPostcondition(replayFactId, []);
        return this.requireFact(replayFactId);
      },
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
        if (this.state().proposals[proposalId])
          throw new MemoryConflictError(`Memory proposal ${proposalId} already exists`);
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
        this.state().proposals[proposalId] = proposal;
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
    const id = normalizeId(proposalId, "proposalId");
    return this.read((state) => cloneOptional(state.proposals[id]));
  }

  listProposals(options: ProposalListOptions = {}): Proposal[] {
    const statuses = options.statuses?.map((status) =>
      requireEnum(status, PROPOSAL_STATUSES, "status"),
    );
    const limit = normalizeLimit(options.limit);
    return this.read((state) =>
      Object.values(state.proposals)
        .filter((proposal) => !statuses?.length || statuses.includes(proposal.status))
        .sort(
          (a, b) =>
            compareDesc(a.createdAt, b.createdAt) || compareDesc(a.proposalId, b.proposalId),
        )
        .slice(0, limit)
        .map(clone),
    );
  }

  listPendingProposalsForSources(sourceIds: readonly string[]): Proposal[] {
    if (sourceIds.length === 0) return [];
    if (sourceIds.length > MAX_LIST_LIMIT) {
      throw new Error(`sourceIds cannot exceed ${MAX_LIST_LIMIT}`);
    }
    const normalized = new Set(sourceIds.map((sourceId) => normalizeId(sourceId, "sourceId")));
    return this.read((state) =>
      Object.values(state.proposals)
        .filter(
          (proposal) =>
            proposal.status === "pending" &&
            proposal.sourceId !== undefined &&
            normalized.has(proposal.sourceId),
        )
        .sort((a, b) => a.proposalId.localeCompare(b.proposalId))
        .map(clone),
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
        this.state().proposals[proposalId] = result;
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
        this.state().proposals[proposalId] = deleted;
        this.recordMutation(
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
    return result;
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
            this.state().facts[target.factId] = updatedFact;
            this.recordMutation(
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
            this.insertFact({
              factId,
              kind: finalKind,
              title: finalTitle,
              content: finalContent,
              confidence: finalConfidence,
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
        this.state().proposals[proposalId] = proposal;
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
    const after = normalizeNonNegativeInteger(options.afterSequence ?? 0, "afterSequence");
    const entityId =
      options.entityId === undefined ? undefined : normalizeId(options.entityId, "entityId");
    const limit = normalizeLimit(options.limit);
    return this.read((state) =>
      state.mutations
        .filter((mutation) => mutation.sequence > after)
        .filter(
          (mutation) =>
            options.entityType === undefined || mutation.entityType === options.entityType,
        )
        .filter((mutation) => entityId === undefined || mutation.entityId === entityId)
        .sort((a, b) => a.sequence - b.sequence)
        .slice(0, limit)
        .map(clone),
    );
  }

  createJob(input: CreateJobInput): Job {
    const normalized = normalizeCreateJobInput(input);
    return this.idempotentWrite(
      "job.create",
      input.idempotencyKey,
      normalized.request,
      () => {
        const existing = Object.values(this.state().jobs).find(
          (job) =>
            job.terminalEventId === normalized.terminalEventId &&
            job.extractorVersion === normalized.extractorVersion,
        );
        if (existing) {
          const job = clone(existing);
          return { value: job, marker: { jobId: job.jobId } };
        }
        if (normalized.sourceId) this.requireSource(normalized.sourceId);
        const jobId = normalizeId(input.jobId ?? `memory-job:${randomUUID()}`, "jobId");
        const at = this.timestamp();
        if (this.state().jobs[jobId])
          throw new MemoryConflictError(`Memory job ${jobId} already exists`);
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
        this.state().jobs[jobId] = job;
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
    const id = normalizeId(jobId, "jobId");
    return this.read((state) => cloneOptional(state.jobs[id]));
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
    const readyAt =
      options.readyAt === undefined ? undefined : normalizeTimestamp(options.readyAt, "readyAt");
    const order = options.order ?? "newest";
    if (order !== "newest" && order !== "oldest") {
      throw new Error(`order has unsupported value ${String(order)}`);
    }
    const limit = normalizeLimit(options.limit);
    return this.read((state) =>
      Object.values(state.jobs)
        .filter((job) => !statuses?.length || statuses.includes(job.status))
        .filter((job) => type === undefined || job.type === type)
        .filter(
          (job) => extractorVersion === undefined || job.extractorVersion === extractorVersion,
        )
        .filter(
          (job) =>
            readyAt === undefined ||
            job.nextAttemptAt === undefined ||
            job.nextAttemptAt <= readyAt,
        )
        .filter((job) => options.attemptsRemaining !== true || job.attemptCount < job.maxAttempts)
        .filter(
          (job) =>
            options.withModelUsage !== true ||
            job.modelCalls > 0 ||
            job.inputTokens > 0 ||
            job.outputTokens > 0 ||
            job.costUsd > 0,
        )
        .sort((a, b) => {
          const compared = a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId);
          return order === "oldest" ? compared : -compared;
        })
        .slice(0, limit)
        .map(clone),
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
      const rows = Object.values(this.state().jobs)
        .filter(
          (job) =>
            job.status === "queued" &&
            job.errorCode === undefined &&
            job.type === type &&
            job.extractorVersion === extractorVersion,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId));
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
      const rows = Object.values(this.state().jobs)
        .filter(
          (job) =>
            ["queued", "running", "failed"].includes(job.status) &&
            job.type === type &&
            job.extractorVersion === extractorVersion &&
            job.cursor.sessionId === sessionId,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId));
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
        const terminalAt = isTerminalJobStatus(status) ? this.timestamp() : undefined;
        const updatedAt = terminalAt ?? this.timestamp();
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
          updatedAt,
          terminalAt: isTerminalJobStatus(status) ? (terminalAt ?? current.terminalAt) : undefined,
        });
        this.state().jobs[jobId] = job;
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

  enqueueProposedNotification(proposal: Proposal, idempotencyKey?: string): Job {
    if (proposal.workspaceId !== this.workspaceId || proposal.status !== "pending") {
      throw new Error("Only a pending proposal in this workspace can be published");
    }
    const identity = hashOpaqueKey(`${proposal.proposalId}\0${proposal.version}\0${proposal.kind}`);
    const jobId = `notification:proposed:${identity}`;
    const at = this.timestamp();
    return this.runTransaction(() =>
      this.enqueueNotificationJob({
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
    if (this.state().facts[input.factId])
      throw new MemoryConflictError(`Memory fact ${input.factId} already exists`);
    this.state().facts[input.factId] = {
      factId: input.factId,
      workspaceId: this.workspaceId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      confidence: input.confidence,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      state: input.state,
      pinned: input.pinned,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.lastUsedAt ? { lastUsedAt: input.lastUsedAt } : {}),
      version: 1,
      createdAt: input.at,
      updatedAt: input.at,
    };
  }

  private enqueueForgottenNotification(
    fact: Fact,
    idempotencyKey: string | undefined,
    at: string,
  ): void {
    const identity = hashOpaqueKey(`${fact.factId}\0${fact.version}`);
    const jobId = `notification:forgotten:${identity}`;
    this.enqueueNotificationJob({
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
    this.enqueueNotificationJob({
      jobId,
      type: MEMORY_SOURCE_NOTIFICATION_JOB_TYPE,
      terminalEventId: identity,
      extractorVersion:
        source.availability === "rewound"
          ? MEMORY_SOURCE_REWOUND_NOTIFICATION_VERSION
          : MEMORY_SOURCE_UNAVAILABLE_NOTIFICATION_VERSION,
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

  private requireUnchangedActiveConflictFact(proposal: Proposal): Fact {
    const factId = proposal.conflictFactId;
    if (!factId) {
      throw new MemoryConflictError(`Proposal ${proposal.proposalId} has no conflict fact`);
    }
    const fact = this.requireFact(factId);
    if (fact.state !== "active") {
      throw new MemoryConflictError(`Conflict fact ${factId} is no longer active`);
    }
    const proposalCreated = this.state().mutations.find(
      (mutation) =>
        mutation.entityType === "proposal" &&
        mutation.entityId === proposal.proposalId &&
        mutation.action === "proposal.created",
    );
    if (!proposalCreated) {
      throw new MemoryConflictError(
        `Conflict proposal ${proposal.proposalId} has no creation audit record`,
      );
    }
    const changedAfterProposal = this.state().mutations.some(
      (mutation) =>
        mutation.entityType === "fact" &&
        mutation.entityId === factId &&
        mutation.sequence > proposalCreated.sequence,
    );
    if (changedAfterProposal) {
      throw new MemoryConflictError(
        `Conflict fact ${factId} changed after proposal ${proposal.proposalId} was created`,
      );
    }
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
    const mutations = this.state().mutations;
    mutations.push({
      sequence: mutations.length === 0 ? 1 : mutations[mutations.length - 1]!.sequence + 1,
      mutationId: `mutation:${randomUUID()}`,
      workspaceId: this.workspaceId,
      entityType,
      entityId,
      action,
      ...(fromVersion === undefined ? {} : { fromVersion }),
      toVersion,
      ...(idempotencyKey
        ? { idempotencyKeyHash: hashOpaqueKey(normalizeIdempotencyKey(idempotencyKey)) }
        : {}),
      createdAt,
    });
  }

  private idempotentWrite<Result>(
    operation: string,
    idempotencyKey: string | undefined,
    request: unknown,
    execute: () => { readonly value: Result; readonly marker: Readonly<Record<string, string>> },
    replay: (marker: Readonly<Record<string, unknown>>) => Result,
  ): Result {
    return this.runTransaction(() => {
      if (!idempotencyKey) return execute().value;
      const key = normalizeIdempotencyKey(idempotencyKey);
      const keyHash = hashOpaqueKey(key);
      const requestHash = hashCanonicalJson(request);
      const identity = `${operation}:${keyHash}`;
      const existing = this.state().idempotency[identity];
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new MemoryIdempotencyConflictError(operation);
        }
        return replay(existing.marker);
      }
      const result = execute();
      const record: MemoryIdempotencyRecord = {
        operation,
        keyHash,
        requestHash,
        marker: result.marker,
        createdAt: this.timestamp(),
      };
      this.state().idempotency[identity] = record;
      return result.value;
    });
  }

  private enqueueNotificationJob(input: {
    readonly jobId: string;
    readonly type: string;
    readonly terminalEventId: string;
    readonly extractorVersion: string;
    readonly cursor: MemoryJobCursor;
    readonly idempotencyKey?: string;
    readonly at: string;
  }): Job {
    const existing = this.state().jobs[input.jobId];
    if (existing) return clone(existing);
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
    this.state().jobs[input.jobId] = job;
    this.recordMutation(
      "job",
      input.jobId,
      "job.created",
      undefined,
      1,
      input.idempotencyKey,
      input.at,
    );
    return clone(job);
  }

  private read<Result>(operation: (state: MemoryFileState) => Result): Result {
    const context = activeMemoryTransactions.get(this.storageRoot);
    if (context) {
      this.assertContextWorkspace(context);
      return operation(context.state);
    }
    return this.withLock(() => {
      recoverFileTransactionSync(this.storageRoot);
      return operation(this.readState());
    });
  }

  private state(): MemoryFileState {
    const context = activeMemoryTransactions.get(this.storageRoot);
    if (!context) throw new Error("Memory mutation requires an active transaction");
    this.assertContextWorkspace(context);
    return context.state;
  }

  private readState(): MemoryFileState {
    try {
      return decodeMemoryFileState(readJsonFileSync(this.statePath), this.workspaceId);
    } catch (error) {
      if (error instanceof FileStorageIntegrityError) throw error;
      throw new FileStorageIntegrityError(
        `Cannot read memory state ${this.statePath}: ${errorMessage(error)}`,
      );
    }
  }

  private withLock<Result>(operation: () => Result): Result {
    const deadline = Date.now() + this.busyTimeoutMs;
    for (;;) {
      try {
        return withFileLockSync(
          this.lockPath,
          `memory:${this.workspaceId}:${process.pid}`,
          operation,
          {
            timeoutMs: Math.max(0, deadline - Date.now()),
          },
        );
      } catch (error) {
        if (!(error instanceof LeaseConflictError) || Date.now() >= deadline) throw error;
        // A releasing process can briefly expose the lock directory after owner.json is gone.
        // Treat that unverifiable window as contention, never as permission to steal the lock.
        Atomics.wait(memoryLockWait, 0, 0, 10);
      }
    }
  }

  private assertContextWorkspace(context: MemoryTransactionContext): void {
    if (context.workspaceId !== this.workspaceId) {
      throw new FileStorageIntegrityError(
        `Memory transaction belongs to workspace ${context.workspaceId}, not ${this.workspaceId}`,
      );
    }
  }

  private rememberForgetPostcondition(factId: string, secrets: readonly string[]): void {
    const context = activeMemoryTransactions.get(this.storageRoot);
    if (!context) throw new Error("Memory deletion requires an active transaction");
    context.forgottenFactIds.add(factId);
    for (const secret of secrets) context.forgottenSecrets.add(secret);
  }

  private verifyForgottenEntities(state: MemoryFileState, factIds: ReadonlySet<string>): void {
    for (const factId of factIds) {
      const fact = state.facts[factId];
      if (!fact || fact.state !== "forgotten" || fact.title !== null || fact.content !== null) {
        throw new MemoryPlaintextVerificationError(this.statePath);
      }
      for (const proposal of Object.values(state.proposals)) {
        if (proposal.resolvedFactId !== factId && proposal.conflictFactId !== factId) continue;
        if (
          proposal.status !== "deleted" ||
          proposal.title !== null ||
          proposal.content !== null ||
          proposal.reason !== null
        ) {
          throw new MemoryPlaintextVerificationError(this.statePath);
        }
      }
    }
  }

  private verifySecretsRemoved(secrets: ReadonlySet<string>): void {
    let files: string[];
    try {
      files = listMemoryVerificationFiles(this.storageRoot);
    } catch (error) {
      throw new MemoryPlaintextVerificationError(this.storageRoot, error);
    }
    for (const path of files) {
      if (path.endsWith(".tmp")) {
        throw new MemoryFileCleanupError(path, new Error("temporary file remains after cleanup"));
      }
      let content: string;
      try {
        content = readFileSync(path, "utf8");
      } catch (error) {
        throw new MemoryPlaintextVerificationError(path, error);
      }
      for (const secret of secrets) {
        const escaped = JSON.stringify(secret).slice(1, -1);
        if (content.includes(secret) || content.includes(escaped)) {
          throw new MemoryPlaintextVerificationError(path);
        }
      }
    }
  }

  private cleanupTemporaryFiles(): void {
    let files: string[];
    try {
      files = listMemoryTemporaryFiles(this.storageRoot);
    } catch (error) {
      throw new MemoryFileCleanupError(this.storageRoot, error);
    }
    for (const path of files) {
      try {
        unlinkSync(path);
        syncDirectorySync(dirname(path));
      } catch (error) {
        throw new MemoryFileCleanupError(path, error);
      }
    }
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
  "modelCalls",
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function cloneOptional<Value>(value: Value | undefined): Value | undefined {
  return value === undefined ? undefined : clone(value);
}

function compact<Value extends object>(value: Value): Value {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Value;
}

function compareDesc(left: string, right: string): number {
  return right.localeCompare(left);
}

function listMemoryVerificationFiles(root: string): string[] {
  return listMemoryRootFiles(root)
    .filter(({ name }) => name === "commit.json" || isRepositoryTemporaryFile(name))
    .map(({ path }) => path);
}

function listMemoryTemporaryFiles(root: string): string[] {
  return listMemoryRootFiles(root)
    .filter(({ name }) => isRepositoryTemporaryFile(name))
    .map(({ path }) => path);
}

function listMemoryRootFiles(
  root: string,
): Array<{ readonly name: string; readonly path: string }> {
  if (!existsSync(root)) return [];
  const files: Array<{ readonly name: string; readonly path: string }> = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat?.isFile()) files.push({ name, path });
  }
  return files;
}

function isRepositoryTemporaryFile(name: string): boolean {
  return /^\.(?:state|commit)\.json\..+\.tmp$/u.test(name);
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
