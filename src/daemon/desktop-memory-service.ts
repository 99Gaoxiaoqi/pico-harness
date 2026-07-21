import { createHash, randomUUID } from "node:crypto";
import type {
  RuntimeMemoryFact,
  RuntimeMemoryProposal,
  RuntimeMemorySettings,
  RuntimeNotificationMap,
  RuntimeNotificationTopic,
  RuntimeParams,
  RuntimeResult,
} from "./protocol.js";
import { RUNTIME_ERROR_CODES, RuntimeProtocolError } from "./protocol.js";
import type { Fact, Job, Proposal, Settings, Source } from "../memory/domain.js";
import {
  MEMORY_FORGOTTEN_NOTIFICATION_JOB_TYPE,
  MEMORY_FORGOTTEN_NOTIFICATION_VERSION,
  MEMORY_SOURCE_NOTIFICATION_JOB_TYPE,
  MEMORY_SOURCE_REWOUND_NOTIFICATION_VERSION,
  MEMORY_SOURCE_UNAVAILABLE_NOTIFICATION_VERSION,
  MemoryConflictError,
  MemoryIdempotencyConflictError,
  MemoryNotFoundError,
  MemoryRepository,
} from "../memory/memory-repository.js";
import { sanitizeMemoryProposalCandidate } from "../memory/proposal-sanitizer.js";
import { MemorySchemaVersionError, MemoryWorkspaceMismatchError } from "../memory/memory-schema.js";
import {
  MEMORY_CONTEXT_MAX_FACTS,
  MEMORY_CONTEXT_MAX_TOKENS,
  MemoryContextBuilder,
} from "../memory/context-builder.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";

type MemoryNotificationTopic = Extract<RuntimeNotificationTopic, `memory.${string}`>;
type MemoryNotificationPublisher = <Topic extends MemoryNotificationTopic>(
  workspacePath: string,
  topic: Topic,
  payload: RuntimeNotificationMap[Topic],
) => void;

export interface DesktopMemoryServiceOptions {
  readonly picoHome: string;
  readonly publish: MemoryNotificationPublisher;
  readonly now?: () => number;
  /** Test/embedding override; production uses the repository default. */
  readonly repositoryBusyTimeoutMs?: number;
  readonly onDegraded?: (event: {
    readonly code: "lifecycle_deferred" | "notification_delivery_deferred";
    readonly workspaceId: string;
    readonly operationId: string;
    readonly error: unknown;
  }) => void;
}

export interface PreparedMemorySourceInvalidation {
  readonly workspacePath: string;
  readonly workspaceId: string;
  readonly jobId: string;
}

const MEMORY_LIFECYCLE_JOB_TYPE = "source-lifecycle-invalidation" as const;
const MEMORY_LIFECYCLE_UNAVAILABLE_VERSION = "memory-source-lifecycle-v1:unavailable" as const;
const MEMORY_LIFECYCLE_REWOUND_VERSION = "memory-source-lifecycle-v1:rewound" as const;
const MEMORY_LIFECYCLE_BATCH_SIZE = 250;

/** Host-owned workspace repository boundary. Database paths never cross this service. */
export class DesktopMemoryService {
  private readonly repositories = new Map<string, MemoryRepository>();
  private readonly preparedLifecycleJobs = new Set<string>();

  constructor(private readonly options: DesktopMemoryServiceOptions) {}

  list(workspacePath: string, params: RuntimeParams<"memory.list">): RuntimeResult<"memory.list"> {
    return this.safely(() => {
      const repository = this.repository(workspacePath);
      return {
        facts: repository
          .listFacts({ states: params.states, kinds: params.kinds, limit: params.limit })
          .map((fact) => projectFact(repository, fact)),
      };
    });
  }

  get(workspacePath: string, factId: string): RuntimeResult<"memory.get"> {
    return this.safely(() => {
      const repository = this.repository(workspacePath);
      const fact = repository.getFact(factId);
      if (!fact) throw new MemoryNotFoundError("fact", factId);
      return { fact: projectFact(repository, fact) };
    });
  }

  update(
    workspacePath: string,
    params: RuntimeParams<"memory.update">,
  ): RuntimeResult<"memory.update"> {
    return this.safely(() => {
      const repository = this.repository(workspacePath);
      const replay = hasIdempotentMutation(
        repository,
        "fact",
        params.factId,
        params.idempotencyKey,
      );
      const fact = repository.updateFact({
        factId: params.factId,
        expectedVersion: params.expectedVersion,
        idempotencyKey: params.idempotencyKey,
        ...(params.kind !== undefined ? { kind: params.kind } : {}),
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.content !== undefined ? { content: params.content } : {}),
        ...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
        ...(params.state !== undefined ? { state: params.state } : {}),
        ...(params.pinned !== undefined ? { pinned: params.pinned } : {}),
        ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
        ...(params.lastUsedAt !== undefined ? { lastUsedAt: params.lastUsedAt } : {}),
      });
      if (!replay) {
        this.options.publish(workspacePath, "memory.changed", {
          entityType: "fact",
          entityId: fact.factId,
          version: fact.version,
          change: "updated",
        });
      }
      return { fact: projectFact(repository, fact) };
    });
  }

  forget(
    workspacePath: string,
    params: RuntimeParams<"memory.forget">,
  ): RuntimeResult<"memory.forget"> {
    return this.safely(() => {
      const repository = this.repository(workspacePath);
      let fact: Fact;
      try {
        fact = repository.forgetFact(params);
      } catch (error) {
        this.deliverForgottenNotificationsBestEffort(repository, workspacePath);
        throw error;
      }
      this.deliverForgottenNotificationsBestEffort(repository, workspacePath);
      return { fact: projectFact(repository, fact) };
    });
  }

  listReviews(
    workspacePath: string,
    params: RuntimeParams<"memory.review.list">,
  ): RuntimeResult<"memory.review.list"> {
    return this.safely(() => ({
      proposals: this.repository(workspacePath)
        .listProposals({ statuses: params.statuses, limit: params.limit })
        .map(runtimeProposal),
    }));
  }

  resolveReview(
    workspacePath: string,
    params: RuntimeParams<"memory.review.resolve">,
  ): RuntimeResult<"memory.review.resolve"> {
    return this.safely(() => {
      const repository = this.repository(workspacePath);
      const replay = hasIdempotentMutation(
        repository,
        "proposal",
        params.proposalId,
        params.idempotencyKey,
      );
      let patch = params.patch;
      if (params.resolution === "accepted") {
        const current = repository.getProposal(params.proposalId);
        if (!current) throw new MemoryNotFoundError("proposal", params.proposalId);
        const sanitized = sanitizeMemoryProposalCandidate({
          kind: patch?.kind ?? current.kind,
          title: patch?.title ?? requireProposalBody(current.title),
          content: patch?.content ?? requireProposalBody(current.content),
          reason: patch?.reason ?? requireProposalBody(current.reason),
          confidence: patch?.confidence ?? current.confidence,
          evidenceEventIds: [],
        });
        if (sanitized.disposition !== "allow") {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.INVALID_PARAMS,
            "审核编辑内容未通过记忆安全扫描",
          );
        }
        patch = {
          kind: sanitized.kind,
          title: sanitized.title,
          content: sanitized.content,
          reason: sanitized.reason,
          confidence: sanitized.confidence,
        };
      }
      const result = repository.resolveProposal({
        proposalId: params.proposalId,
        resolution: params.resolution,
        expectedVersion: params.expectedVersion,
        idempotencyKey: params.idempotencyKey,
        ...(params.factId !== undefined ? { factId: params.factId } : {}),
        ...(patch !== undefined ? { patch } : {}),
      });
      if (!replay) {
        this.options.publish(workspacePath, "memory.changed", {
          entityType: "proposal",
          entityId: result.proposal.proposalId,
          version: result.proposal.version,
          change: "resolved",
        });
        if (result.fact) {
          this.options.publish(workspacePath, "memory.changed", {
            entityType: "fact",
            entityId: result.fact.factId,
            version: result.fact.version,
            change: "updated",
          });
        }
      }
      return {
        proposal: runtimeProposal(result.proposal),
        ...(result.fact ? { fact: projectFact(repository, result.fact) } : {}),
      };
    });
  }

  getSettings(workspacePath: string): RuntimeResult<"memory.settings.get"> {
    return this.safely(() => ({
      settings: runtimeSettings(this.repository(workspacePath).getSettings()),
    }));
  }

  updateSettings(
    workspacePath: string,
    params: RuntimeParams<"memory.settings.update">,
  ): RuntimeResult<"memory.settings.update"> {
    return this.safely(() => {
      if ((params as { readonly autoCommit?: boolean }).autoCommit === true) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.INVALID_PARAMS,
          "首版记忆不支持自动批准",
        );
      }
      const repository = this.repository(workspacePath);
      const replay = hasIdempotentMutation(
        repository,
        "settings",
        repository.workspaceId,
        params.idempotencyKey,
      );
      const settings = repository.updateSettings({
        expectedVersion: params.expectedVersion,
        idempotencyKey: params.idempotencyKey,
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.autoPropose !== undefined ? { autoPropose: params.autoPropose } : {}),
        ...(params.autoCommit !== undefined ? { autoCommit: params.autoCommit } : {}),
        ...(params.injectionEnabled !== undefined
          ? { injectionEnabled: params.injectionEnabled }
          : {}),
      });
      if (!replay) {
        this.options.publish(workspacePath, "memory.changed", {
          entityType: "settings",
          entityId: "settings",
          version: settings.version,
          change: "updated",
        });
      }
      return { settings: runtimeSettings(settings) };
    });
  }

  previewContext(
    workspacePath: string,
    params: RuntimeParams<"memory.context.preview">,
  ): RuntimeResult<"memory.context.preview"> {
    return this.safely(() => {
      const repository = this.repository(workspacePath);
      const maxFacts = Math.min(
        params.maxFacts ?? MEMORY_CONTEXT_MAX_FACTS,
        MEMORY_CONTEXT_MAX_FACTS,
      );
      const maxTokens = Math.min(
        params.maxTokens ?? MEMORY_CONTEXT_MAX_TOKENS,
        MEMORY_CONTEXT_MAX_TOKENS,
      );
      const result = new MemoryContextBuilder(
        repository,
        () => new Date(this.options.now?.() ?? Date.now()),
      ).buildSync(undefined, { maxFacts, maxTokens });
      return {
        facts: result.facts.map((fact) => projectFact(repository, fact)),
        budget: {
          maxFacts,
          maxTokens,
          usedFacts: result.facts.length,
          usedTokens: result.tokenCount,
          truncated: result.truncated,
        },
      };
    });
  }

  invalidateSessionSources(
    workspacePath: string,
    sessionId: string,
    reason:
      | { readonly availability: "unavailable"; readonly code: string }
      | { readonly availability: "rewound"; readonly code: string; readonly afterSequence: number },
  ): void {
    const prepared = this.prepareSessionSourceInvalidation(workspacePath, sessionId, reason);
    this.commitSessionSourceInvalidation(prepared);
  }

  prepareSessionSourceInvalidation(
    workspacePath: string,
    sessionId: string,
    reason:
      | { readonly availability: "unavailable"; readonly code: string }
      | { readonly availability: "rewound"; readonly code: string; readonly afterSequence: number },
  ): PreparedMemorySourceInvalidation {
    return this.safely(() => {
      const repository = this.repository(workspacePath);
      assertLifecycleReason(reason);
      const operationId = lifecycleOperationId(sessionId, reason, randomUUID());
      const job = repository.transaction(() => {
        const queued = repository.createJob({
          jobId: `lifecycle:${operationId}`,
          type: MEMORY_LIFECYCLE_JOB_TYPE,
          terminalEventId: operationId,
          extractorVersion:
            reason.availability === "rewound"
              ? MEMORY_LIFECYCLE_REWOUND_VERSION
              : MEMORY_LIFECYCLE_UNAVAILABLE_VERSION,
          cursor: {
            sessionId,
            eventId: reason.code,
            ...(reason.availability === "rewound" ? { sequence: reason.afterSequence } : {}),
          },
          maxAttempts: 1,
          idempotencyKey: `lifecycle-enqueue:${operationId}`,
        });
        return repository.updateJob({
          jobId: queued.jobId,
          expectedVersion: queued.version,
          status: "running",
          idempotencyKey: `${queued.jobId}:prepared:${queued.version}`,
        });
      });
      this.preparedLifecycleJobs.add(job.jobId);
      return {
        workspacePath,
        workspaceId: repository.workspaceId,
        jobId: job.jobId,
      };
    });
  }

  commitSessionSourceInvalidation(prepared: PreparedMemorySourceInvalidation): void {
    this.preparedLifecycleJobs.delete(prepared.jobId);
    try {
      const repository = this.repositoryWithoutMaintenance(prepared.workspacePath);
      const job = repository.getJob(prepared.jobId);
      if (!job) throw new MemoryNotFoundError("job", prepared.jobId);
      if (job.status === "running") {
        repository.updateJob({
          jobId: job.jobId,
          expectedVersion: job.version,
          status: "queued",
          idempotencyKey: `${job.jobId}:committed:${job.version}`,
        });
      }
      this.reconcileLifecycleJobs(repository);
      this.deliverSourceNotificationsBestEffort(repository, prepared.workspacePath);
    } catch (error) {
      this.reportDegraded("lifecycle_deferred", prepared.workspaceId, prepared.jobId, error);
    }
  }

  close(): void {
    for (const repository of this.repositories.values()) repository.close();
    this.repositories.clear();
  }

  private repository(workspacePath: string): MemoryRepository {
    const repository = this.repositoryWithoutMaintenance(workspacePath);
    this.runMaintenance(repository, workspacePath);
    return repository;
  }

  private repositoryWithoutMaintenance(workspacePath: string): MemoryRepository {
    const existing = this.repositories.get(workspacePath);
    if (existing) return existing;
    const paths = resolvePicoPaths(workspacePath, { picoHome: this.options.picoHome });
    const repository = new MemoryRepository({
      databasePath: paths.workspace.memoryDatabase,
      workspaceId: paths.workspace.id,
      ...(this.options.repositoryBusyTimeoutMs !== undefined
        ? { busyTimeoutMs: this.options.repositoryBusyTimeoutMs }
        : {}),
    });
    this.repositories.set(workspacePath, repository);
    return repository;
  }

  private runMaintenance(repository: MemoryRepository, workspacePath: string): void {
    this.deliverForgottenNotificationsBestEffort(repository, workspacePath);
    this.deliverSourceNotificationsBestEffort(repository, workspacePath);
    try {
      this.reconcileLifecycleJobs(repository);
    } catch (error) {
      this.reportDegraded(
        "lifecycle_deferred",
        repository.workspaceId,
        "lifecycle-reconcile",
        error,
      );
    }
    this.deliverSourceNotificationsBestEffort(repository, workspacePath);
  }

  private deliverForgottenNotificationsBestEffort(
    repository: MemoryRepository,
    workspacePath: string,
  ): void {
    try {
      this.deliverForgottenNotifications(repository, workspacePath);
    } catch (error) {
      this.reportDegraded(
        "notification_delivery_deferred",
        repository.workspaceId,
        "forgotten-outbox",
        error,
      );
    }
  }

  private deliverForgottenNotifications(repository: MemoryRepository, workspacePath: string): void {
    while (true) {
      const jobs = repository.listJobs({
        statuses: ["queued"],
        type: MEMORY_FORGOTTEN_NOTIFICATION_JOB_TYPE,
        extractorVersion: MEMORY_FORGOTTEN_NOTIFICATION_VERSION,
        limit: 500,
      });
      if (jobs.length === 0) return;
      for (const job of jobs) {
        const factId = job.cursor.eventId;
        const fact = factId ? repository.getFact(factId) : undefined;
        if (!fact || fact.state !== "forgotten") {
          repository.updateJob({
            jobId: job.jobId,
            expectedVersion: job.version,
            status: "failed",
            errorCode: "notification_fact_missing",
            idempotencyKey: `${job.jobId}:invalid:${job.version}`,
          });
          continue;
        }
        this.options.publish(workspacePath, "memory.forgotten", {
          factId: fact.factId,
          version: fact.version,
        });
        repository.updateJob({
          jobId: job.jobId,
          expectedVersion: job.version,
          status: "succeeded",
          errorCode: null,
          idempotencyKey: `${job.jobId}:delivered:${job.version}`,
        });
      }
    }
  }

  private deliverSourceNotificationsBestEffort(
    repository: MemoryRepository,
    workspacePath: string,
  ): void {
    try {
      this.deliverSourceNotifications(repository, workspacePath);
    } catch (error) {
      this.reportDegraded(
        "notification_delivery_deferred",
        repository.workspaceId,
        "source-notification-outbox",
        error,
      );
    }
  }

  private deliverSourceNotifications(repository: MemoryRepository, workspacePath: string): void {
    while (true) {
      const jobs = repository.listJobs({
        statuses: ["queued"],
        type: MEMORY_SOURCE_NOTIFICATION_JOB_TYPE,
        limit: 500,
      });
      if (jobs.length === 0) return;
      for (const job of jobs) {
        const sourceId = job.cursor.eventId;
        const sourceVersion = job.cursor.sequence;
        const change =
          job.extractorVersion === MEMORY_SOURCE_REWOUND_NOTIFICATION_VERSION
            ? "source_rewound"
            : job.extractorVersion === MEMORY_SOURCE_UNAVAILABLE_NOTIFICATION_VERSION
              ? "source_unavailable"
              : undefined;
        const source = sourceId ? repository.getSource(sourceId) : undefined;
        if (!source || sourceVersion === undefined || !change) {
          repository.updateJob({
            jobId: job.jobId,
            expectedVersion: job.version,
            status: "failed",
            errorCode: "notification_source_invalid",
            idempotencyKey: `${job.jobId}:invalid:${job.version}`,
          });
          continue;
        }
        this.options.publish(workspacePath, "memory.changed", {
          entityType: "source",
          entityId: source.sourceId,
          version: sourceVersion,
          change,
        });
        repository.updateJob({
          jobId: job.jobId,
          expectedVersion: job.version,
          status: "succeeded",
          errorCode: null,
          idempotencyKey: `${job.jobId}:delivered:${job.version}`,
        });
      }
    }
  }

  private reconcileLifecycleJobs(repository: MemoryRepository): void {
    while (true) {
      const jobs = [
        ...repository.listJobs({
          statuses: ["queued"],
          type: MEMORY_LIFECYCLE_JOB_TYPE,
          limit: 500,
        }),
        ...repository
          .listJobs({ statuses: ["running"], type: MEMORY_LIFECYCLE_JOB_TYPE, limit: 500 })
          .filter((job) => !this.preparedLifecycleJobs.has(job.jobId)),
      ];
      if (jobs.length === 0) return;
      // A running lifecycle job not owned by this process survived a cross-store crash.
      // Recover fail-closed for privacy: pending proposals may be deleted and sources marked
      // unavailable, while user-approved Facts are deliberately retained.
      for (const job of jobs) this.applyLifecycleJob(repository, job);
    }
  }

  private applyLifecycleJob(repository: MemoryRepository, job: Job): void {
    const availability =
      job.extractorVersion === MEMORY_LIFECYCLE_REWOUND_VERSION
        ? "rewound"
        : job.extractorVersion === MEMORY_LIFECYCLE_UNAVAILABLE_VERSION
          ? "unavailable"
          : undefined;
    const invalidationCode = job.cursor.eventId;
    if (!availability || !invalidationCode) {
      repository.updateJob({
        jobId: job.jobId,
        expectedVersion: job.version,
        status: "failed",
        errorCode: "lifecycle_job_invalid",
        idempotencyKey: `${job.jobId}:invalid:${job.version}`,
      });
      return;
    }

    let afterSourceId: string | undefined;
    while (true) {
      const sources = repository.listSessionSources(job.cursor.sessionId, {
        availability: "available",
        ...(availability === "rewound" ? { afterSequence: job.cursor.sequence ?? 0 } : {}),
        ...(afterSourceId ? { afterSourceId } : {}),
        limit: MEMORY_LIFECYCLE_BATCH_SIZE,
      });
      if (sources.length === 0) break;
      repository.transaction(() => {
        const proposals = repository.listPendingProposalsForSources(
          sources.map((source) => source.sourceId),
        );
        for (const proposal of proposals) {
          repository.deleteProposal({
            proposalId: proposal.proposalId,
            expectedVersion: proposal.version,
            idempotencyKey: `${job.jobId}:proposal:${proposal.proposalId}:${proposal.version}`,
          });
        }
        for (const source of sources) {
          const updated = repository.updateSourceAvailability({
            sourceId: source.sourceId,
            expectedVersion: source.version,
            availability,
            invalidationCode,
            idempotencyKey: `${job.jobId}:source:${source.sourceId}:${source.version}`,
          });
          if (updated.availability !== availability) {
            throw new MemoryConflictError("Source lifecycle update did not persist");
          }
        }
      });
      afterSourceId = sources.at(-1)?.sourceId;
      if (sources.length < MEMORY_LIFECYCLE_BATCH_SIZE) break;
    }

    const current = repository.getJob(job.jobId);
    if (!current || (current.status !== "queued" && current.status !== "running")) return;
    repository.updateJob({
      jobId: current.jobId,
      expectedVersion: current.version,
      status: "succeeded",
      errorCode: null,
      idempotencyKey: `${current.jobId}:complete:${current.version}`,
    });
  }

  private reportDegraded(
    code: "lifecycle_deferred" | "notification_delivery_deferred",
    workspaceId: string,
    operationId: string,
    error: unknown,
  ): void {
    this.options.onDegraded?.({ code, workspaceId, operationId, error });
  }

  private safely<Result>(operation: () => Result): Result {
    try {
      return operation();
    } catch (error) {
      throw mapMemoryError(error);
    }
  }
}

export function mapMemoryError(error: unknown): RuntimeProtocolError {
  if (error instanceof RuntimeProtocolError) return error;
  if (error instanceof MemoryNotFoundError) {
    return new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, "记忆对象不存在");
  }
  if (error instanceof MemoryIdempotencyConflictError || error instanceof MemoryConflictError) {
    return new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      "记忆版本冲突或幂等键已用于其他请求",
    );
  }
  if (error instanceof MemoryWorkspaceMismatchError) {
    return new RuntimeProtocolError(RUNTIME_ERROR_CODES.FORBIDDEN, "记忆不属于当前工作区");
  }
  if (error instanceof MemorySchemaVersionError) {
    return new RuntimeProtocolError(RUNTIME_ERROR_CODES.INTERNAL_ERROR, "记忆存储版本不兼容");
  }
  if (error instanceof Error && error.name === "MemorySecureDeletePendingError") {
    return new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      "记忆安全删除尚未完成，请稍后重试",
    );
  }
  return new RuntimeProtocolError(RUNTIME_ERROR_CODES.INTERNAL_ERROR, "记忆服务暂时不可用");
}

function projectFact(repository: MemoryRepository, fact: Fact): RuntimeMemoryFact {
  const source = fact.sourceId ? repository.getSource(fact.sourceId) : undefined;
  return {
    factId: fact.factId,
    kind: fact.kind,
    title: fact.title,
    content: fact.content,
    confidence: fact.confidence,
    state: fact.state,
    pinned: fact.pinned,
    ...(fact.sourceId ? { sourceId: fact.sourceId } : {}),
    ...(source ? { source: runtimeSource(source) } : {}),
    ...(fact.expiresAt ? { expiresAt: fact.expiresAt } : {}),
    ...(fact.lastUsedAt ? { lastUsedAt: fact.lastUsedAt } : {}),
    version: fact.version,
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
    ...(fact.forgottenAt ? { forgottenAt: fact.forgottenAt } : {}),
  };
}

function runtimeSource(source: Source): RuntimeMemoryFact["source"] {
  return {
    sourceId: source.sourceId,
    sessionId: source.sessionId,
    ...(source.branchId ? { branchId: source.branchId } : {}),
    availability: source.availability,
    ...(source.invalidatedAt ? { invalidatedAt: source.invalidatedAt } : {}),
    ...(source.invalidationCode ? { invalidationCode: source.invalidationCode } : {}),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function runtimeProposal(proposal: Proposal): RuntimeMemoryProposal {
  return {
    proposalId: proposal.proposalId,
    kind: proposal.kind,
    title: proposal.title,
    content: proposal.content,
    reason: proposal.reason,
    confidence: proposal.confidence,
    status: proposal.status,
    conflictStatus: proposal.conflictStatus,
    ...(proposal.sourceId ? { sourceId: proposal.sourceId } : {}),
    ...(proposal.conflictFactId ? { conflictFactId: proposal.conflictFactId } : {}),
    ...(proposal.resolvedFactId ? { resolvedFactId: proposal.resolvedFactId } : {}),
    version: proposal.version,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    ...(proposal.reviewedAt ? { reviewedAt: proposal.reviewedAt } : {}),
    ...(proposal.deletedAt ? { deletedAt: proposal.deletedAt } : {}),
  };
}

function runtimeSettings(settings: Settings): RuntimeMemorySettings {
  return {
    enabled: settings.enabled,
    autoPropose: settings.autoPropose,
    autoCommit: settings.autoCommit,
    injectionEnabled: settings.injectionEnabled,
    version: settings.version,
    updatedAt: settings.updatedAt,
  };
}

function hasIdempotentMutation(
  repository: MemoryRepository,
  entityType: "fact" | "proposal" | "settings",
  entityId: string,
  idempotencyKey: string,
): boolean {
  const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
  return repository
    .listMutations({ entityType, entityId, limit: 500 })
    .some((mutation) => mutation.idempotencyKeyHash === keyHash);
}

function requireProposalBody(value: string | null): string {
  if (value === null) throw new MemoryConflictError("Proposal body is no longer available");
  return value;
}

function lifecycleOperationId(
  sessionId: string,
  reason:
    | { readonly availability: "unavailable"; readonly code: string }
    | { readonly availability: "rewound"; readonly code: string; readonly afterSequence: number },
  nonce: string,
): string {
  return createHash("sha256")
    .update(
      `${sessionId}\0${reason.availability}\0${reason.code}\0${
        reason.availability === "rewound" ? reason.afterSequence : ""
      }\0${nonce}`,
    )
    .digest("hex");
}

function assertLifecycleReason(
  reason:
    | { readonly availability: "unavailable"; readonly code: string }
    | { readonly availability: "rewound"; readonly code: string; readonly afterSequence: number },
): void {
  if (
    reason.code.length === 0 ||
    reason.code.length > 256 ||
    !/^[A-Za-z0-9._:-]+$/u.test(reason.code)
  ) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, "记忆生命周期失效代码无效");
  }
  if (
    reason.availability === "rewound" &&
    (!Number.isSafeInteger(reason.afterSequence) || reason.afterSequence < 0)
  ) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, "记忆回退序列边界无效");
  }
}
