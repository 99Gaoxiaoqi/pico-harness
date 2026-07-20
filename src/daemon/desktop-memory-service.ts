import { createHash } from "node:crypto";
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
import type { Fact, Proposal, Settings, Source } from "../memory/domain.js";
import {
  MemoryConflictError,
  MemoryIdempotencyConflictError,
  MemoryNotFoundError,
  MemoryRepository,
} from "../memory/memory-repository.js";
import { MemorySchemaVersionError, MemoryWorkspaceMismatchError } from "../memory/memory-schema.js";
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
}

/** Host-owned workspace repository boundary. Database paths never cross this service. */
export class DesktopMemoryService {
  private readonly repositories = new Map<string, MemoryRepository>();

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
      const replay = hasIdempotentMutation(
        repository,
        "fact",
        params.factId,
        params.idempotencyKey,
      );
      const fact = repository.forgetFact(params);
      if (!replay) {
        this.options.publish(workspacePath, "memory.forgotten", {
          factId: fact.factId,
          version: fact.version,
        });
      }
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
      const result = repository.resolveProposal({
        proposalId: params.proposalId,
        resolution: params.resolution,
        expectedVersion: params.expectedVersion,
        idempotencyKey: params.idempotencyKey,
        ...(params.factId !== undefined ? { factId: params.factId } : {}),
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
      const maxFacts = Math.min(params.maxFacts ?? 6, 6);
      const maxTokens = Math.min(params.maxTokens ?? 800, 800);
      const now = this.options.now?.() ?? Date.now();
      const candidates = repository
        .listFacts({ states: ["active"], limit: 500 })
        .filter((fact) => !fact.expiresAt || Date.parse(fact.expiresAt) > now)
        .toSorted(compareContextFacts);
      const selected: RuntimeMemoryFact[] = [];
      let usedTokens = 0;
      for (const fact of candidates) {
        if (selected.length >= maxFacts) break;
        const tokens = conservativeTokenEstimate(fact);
        if (usedTokens + tokens > maxTokens) continue;
        selected.push(projectFact(repository, fact));
        usedTokens += tokens;
      }
      return {
        facts: selected,
        budget: {
          maxFacts,
          maxTokens,
          usedFacts: selected.length,
          usedTokens,
          truncated: selected.length < candidates.length,
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
    this.safely(() => {
      const repository = this.repository(workspacePath);
      const sources = repository
        .listSources(500)
        .filter(
          (source) =>
            source.sessionId === sessionId &&
            source.availability === "available" &&
            (reason.availability !== "rewound" ||
              sourceFallsAfterSequence(source, reason.afterSequence)),
        );
      const changedSources: Array<{ readonly sourceId: string; readonly version: number }> = [];
      repository.transaction(() => {
        for (const source of sources) {
          const updated = repository.updateSourceAvailability({
            sourceId: source.sourceId,
            expectedVersion: source.version,
            availability: reason.availability,
            invalidationCode: reason.code,
            idempotencyKey: `${reason.code}:${source.sourceId}:${source.version}`,
          });
          for (const proposal of repository.listProposals({ statuses: ["pending"], limit: 500 })) {
            if (proposal.sourceId !== source.sourceId) continue;
            repository.deleteProposal({
              proposalId: proposal.proposalId,
              expectedVersion: proposal.version,
              idempotencyKey: `${reason.code}:${proposal.proposalId}:${proposal.version}`,
            });
          }
          changedSources.push({ sourceId: updated.sourceId, version: updated.version });
        }
      });
      for (const source of changedSources) {
        this.options.publish(workspacePath, "memory.changed", {
          entityType: "source",
          entityId: source.sourceId,
          version: source.version,
          change: reason.availability === "rewound" ? "source_rewound" : "source_unavailable",
        });
      }
    });
  }

  close(): void {
    for (const repository of this.repositories.values()) repository.close();
    this.repositories.clear();
  }

  private repository(workspacePath: string): MemoryRepository {
    const existing = this.repositories.get(workspacePath);
    if (existing) return existing;
    const paths = resolvePicoPaths(workspacePath, { picoHome: this.options.picoHome });
    const repository = new MemoryRepository({
      databasePath: paths.workspace.memoryDatabase,
      workspaceId: paths.workspace.id,
    });
    this.repositories.set(workspacePath, repository);
    return repository;
  }

  private safely<Result>(operation: () => Result): Result {
    try {
      return operation();
    } catch (error) {
      throw mapMemoryError(error);
    }
  }
}

function sourceFallsAfterSequence(source: Source, sequence: number): boolean {
  if (source.endSequence !== undefined) return source.endSequence > sequence;
  if (source.startSequence !== undefined) return source.startSequence > sequence;
  return false;
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

function compareContextFacts(left: Fact, right: Fact): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const kindDifference = contextKindPriority(left.kind) - contextKindPriority(right.kind);
  if (kindDifference !== 0) return kindDifference;
  const lastUsedDifference = timestampValue(right.lastUsedAt) - timestampValue(left.lastUsedAt);
  if (lastUsedDifference !== 0) return lastUsedDifference;
  const updatedDifference = timestampValue(right.updatedAt) - timestampValue(left.updatedAt);
  return updatedDifference !== 0 ? updatedDifference : left.factId.localeCompare(right.factId);
}

function contextKindPriority(kind: Fact["kind"]): number {
  if (kind === "correction") return 0;
  if (kind === "project_fact") return 1;
  return 2;
}

function timestampValue(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** One Unicode code point per token is intentionally conservative for mixed CJK/source text. */
function conservativeTokenEstimate(fact: Fact): number {
  return [...`${fact.title ?? ""}\n${fact.content ?? ""}`].length;
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
