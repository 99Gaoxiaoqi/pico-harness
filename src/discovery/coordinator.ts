import { randomUUID } from "node:crypto";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeDiscoveryEvent,
} from "../engine/session-runtime-event.js";
import { RuntimeEventStore } from "../storage/runtime-event-store.js";
import {
  DISCOVERY_MAX_CANDIDATES,
  DISCOVERY_MAX_EVIDENCE_REFS,
  DiscoveryConflictError,
  discoveryBudget,
  discoveryOperationFingerprint,
  isDiscoveryDepth,
  isDiscoveryPhase,
  normalizeDiscoveryCandidate,
  normalizeDiscoveryStartInput,
  requiredDiscoveryId,
  type DiscoveryBranchStartInput,
  type DiscoveryBranchStatus,
  type DiscoveryCheckpoint,
  type DiscoveryDepth,
  type DiscoveryHypothesis,
  type DiscoveryProjection,
  type DiscoveryReport,
  type DiscoveryStartInput,
} from "./contract.js";
import {
  projectActiveDiscoveryEntries,
  projectDiscoveryEntries,
  reduceDiscoveryEvent,
} from "./reducer.js";

export interface DiscoveryCoordinatorContext {
  readonly sessionId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly turnId: string;
}

interface OperationInput {
  readonly operationId: string;
  /** External control-plane calls provide CAS; internal branch reports serialize without it. */
  readonly expectedSessionSequence?: number;
}

export class DiscoveryCoordinator {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: RuntimeEventStore,
    private readonly context: DiscoveryCoordinatorContext,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async project(): Promise<DiscoveryProjection> {
    return projectDiscoveryEntries(
      this.context.sessionId,
      await this.store.readSessionEntries(this.context.sessionId),
    );
  }

  start(input: OperationInput & DiscoveryStartInput): Promise<DiscoveryProjection> {
    const normalized = normalizeDiscoveryStartInput(input);
    return this.serial(() =>
      this.commit(input, "discovery.started", normalized, (fact, at) => [
        {
          ...this.baseEvent(input.operationId, "discovery.started", at),
          kind: "discovery.started",
          data: {
            ...fact,
            discoveryId: normalized.discoveryId ?? randomUUID(),
            objective: normalized.objective,
            depth: normalized.depth,
            roots: normalized.roots,
            budget: discoveryBudget(normalized.depth),
          },
        },
      ]),
    );
  }

  checkpoint(
    input: OperationInput & {
      readonly discoveryId: string;
      readonly checkpoint: DiscoveryCheckpoint;
    },
  ): Promise<DiscoveryProjection> {
    const discoveryId = requiredDiscoveryId(input.discoveryId, "Discovery id");
    const checkpoint = normalizeCheckpoint(input.checkpoint);
    const semantic = { discoveryId, checkpoint };
    return this.serial(() =>
      this.commit(input, "discovery.checkpointed", semantic, (fact, at) => [
        {
          ...this.baseEvent(input.operationId, "discovery.checkpointed", at),
          kind: "discovery.checkpointed",
          data: { ...fact, ...semantic },
        },
      ]),
    );
  }

  startBranch(input: OperationInput & DiscoveryBranchStartInput): Promise<DiscoveryProjection> {
    const semantic = normalizeBranchStart(input);
    return this.serial(() =>
      this.commit(input, "discovery.branch.started", semantic, (fact, at) => [
        {
          ...this.baseEvent(input.operationId, "discovery.branch.started", at),
          kind: "discovery.branch.started",
          data: { ...fact, ...semantic },
        },
      ]),
    );
  }

  checkpointBranch(
    input: OperationInput & {
      readonly discoveryId: string;
      readonly branchId: string;
      readonly checkpoint: DiscoveryCheckpoint;
    },
  ): Promise<DiscoveryProjection> {
    const semantic = {
      discoveryId: requiredDiscoveryId(input.discoveryId, "Discovery id"),
      branchId: requiredDiscoveryId(input.branchId, "Discovery branch id"),
      checkpoint: normalizeCheckpoint(input.checkpoint),
    };
    return this.serial(() =>
      this.commit(input, "discovery.branch.checkpointed", semantic, (fact, at) => [
        {
          ...this.baseEvent(input.operationId, "discovery.branch.checkpointed", at),
          kind: "discovery.branch.checkpointed",
          data: { ...fact, ...semantic },
        },
      ]),
    );
  }

  completeBranch(
    input: OperationInput & {
      readonly discoveryId: string;
      readonly branchId: string;
      readonly status: Extract<DiscoveryBranchStatus, "completed" | "partial" | "failed">;
      readonly consumedToolCalls: number;
      readonly inspectedFiles: readonly string[];
      readonly candidates?: DiscoveryCheckpoint["candidates"];
      readonly evidenceRefs?: readonly string[];
      readonly openQuestions?: readonly string[];
      readonly report?: DiscoveryReport;
      readonly reason?: string;
    },
  ): Promise<DiscoveryProjection> {
    if (!(["completed", "partial", "failed"] as const).includes(input.status)) {
      throw new DiscoveryConflictError("Discovery branch status is invalid");
    }
    const semantic = {
      discoveryId: requiredDiscoveryId(input.discoveryId, "Discovery id"),
      branchId: requiredDiscoveryId(input.branchId, "Discovery branch id"),
      status: input.status,
      consumedToolCalls: nonNegativeInteger(input.consumedToolCalls, "consumedToolCalls"),
      inspectedFiles: uniqueTexts(input.inspectedFiles, "inspected file", 80),
      candidates: normalizeCandidates(input.candidates ?? []),
      evidenceRefs: uniqueTexts(input.evidenceRefs ?? [], "evidence reference", 50),
      openQuestions: uniqueTexts(input.openQuestions ?? [], "open question", 20),
      ...(input.report ? { report: normalizeReport(input.report) } : {}),
      ...(optionalText(input.reason) ? { reason: optionalText(input.reason) } : {}),
    };
    return this.serial(() =>
      this.commit(input, "discovery.branch.completed", semantic, (fact, at) => [
        {
          ...this.baseEvent(input.operationId, "discovery.branch.completed", at),
          kind: "discovery.branch.completed",
          data: { ...fact, ...semantic },
        },
      ]),
    );
  }

  cancelBranch(
    input: OperationInput & {
      readonly discoveryId: string;
      readonly branchId: string;
      readonly reason?: string;
    },
  ): Promise<DiscoveryProjection> {
    const semantic = {
      discoveryId: requiredDiscoveryId(input.discoveryId, "Discovery id"),
      branchId: requiredDiscoveryId(input.branchId, "Discovery branch id"),
      ...(optionalText(input.reason) ? { reason: optionalText(input.reason) } : {}),
    };
    return this.serial(() =>
      this.commit(input, "discovery.branch.cancelled", semantic, (fact, at) => [
        {
          ...this.baseEvent(input.operationId, "discovery.branch.cancelled", at),
          kind: "discovery.branch.cancelled",
          data: { ...fact, ...semantic },
        },
      ]),
    );
  }

  complete(
    input: OperationInput & { readonly discoveryId: string; readonly report: DiscoveryReport },
  ): Promise<DiscoveryProjection> {
    const semantic = {
      discoveryId: requiredDiscoveryId(input.discoveryId, "Discovery id"),
      report: normalizeReport(input.report),
    };
    return this.serial(() =>
      this.commit(input, "discovery.completed", semantic, (fact, at) => [
        {
          ...this.baseEvent(input.operationId, "discovery.completed", at),
          kind: "discovery.completed",
          data: { ...fact, ...semantic },
        },
      ]),
    );
  }

  interrupt(
    input: OperationInput & {
      readonly discoveryId: string;
      readonly reason: string;
      readonly limitReason?: "budget_exhausted" | "no_information_gain";
    },
  ): Promise<DiscoveryProjection> {
    const semantic = {
      discoveryId: requiredDiscoveryId(input.discoveryId, "Discovery id"),
      reason: requiredText(input.reason, "Discovery interruption reason"),
      ...(input.limitReason ? { limitReason: input.limitReason } : {}),
    };
    return this.serial(() =>
      this.commit(input, "discovery.interrupted", semantic, (fact, at) => [
        {
          ...this.baseEvent(input.operationId, "discovery.interrupted", at),
          kind: "discovery.interrupted",
          data: { ...fact, ...semantic },
        },
      ]),
    );
  }

  resume(
    input: OperationInput & { readonly discoveryId: string; readonly depth?: DiscoveryDepth },
  ): Promise<DiscoveryProjection> {
    return this.serial(async () => {
      const before = await this.project();
      const run = before.discoveries.find(
        (candidate) => candidate.discoveryId === input.discoveryId,
      );
      if (!run) throw new DiscoveryConflictError("Discovery does not exist");
      const depth = input.depth ?? run.depth;
      if (!isDiscoveryDepth(depth)) throw new DiscoveryConflictError("Discovery depth is invalid");
      const semantic = {
        discoveryId: requiredDiscoveryId(input.discoveryId, "Discovery id"),
        depth,
        budget: discoveryBudget(depth),
      };
      return this.commit(input, "discovery.resumed", semantic, (fact, at) => [
        {
          ...this.baseEvent(input.operationId, "discovery.resumed", at),
          kind: "discovery.resumed",
          data: { ...fact, ...semantic },
        },
      ]);
    });
  }

  cancel(
    input: OperationInput & { readonly discoveryId: string; readonly reason?: string },
  ): Promise<DiscoveryProjection> {
    const semantic = {
      discoveryId: requiredDiscoveryId(input.discoveryId, "Discovery id"),
      ...(optionalText(input.reason) ? { reason: optionalText(input.reason) } : {}),
    };
    return this.serial(() =>
      this.commit(input, "discovery.cancelled", semantic, (fact, at) => [
        {
          ...this.baseEvent(input.operationId, "discovery.cancelled", at),
          kind: "discovery.cancelled",
          data: { ...fact, ...semantic },
        },
      ]),
    );
  }

  private async commit(
    input: OperationInput,
    kind: RuntimeDiscoveryEvent["kind"],
    semantic: unknown,
    build: (
      fact: { readonly operationId: string; readonly fingerprint: string },
      at: string,
    ) => RuntimeDiscoveryEvent[],
  ): Promise<DiscoveryProjection> {
    const operationId = requiredDiscoveryId(input.operationId, "Discovery operation id");
    const fingerprint = discoveryOperationFingerprint(kind, semantic);
    const entries = await this.store.readSessionEntries(this.context.sessionId);
    const replay = projectActiveDiscoveryEntries(entries).find(
      ({ event }) => "operationId" in event.data && event.data.operationId === operationId,
    );
    if (replay) {
      if (!("fingerprint" in replay.event.data) || replay.event.data.fingerprint !== fingerprint) {
        throw new DiscoveryConflictError(`Discovery operation ${operationId} conflicts`);
      }
      return projectDiscoveryEntries(this.context.sessionId, entries);
    }
    const projection = projectDiscoveryEntries(this.context.sessionId, entries);
    const at = this.now().toISOString();
    let events = build({ operationId, fingerprint }, at);
    let candidate = projection;
    for (const event of events) candidate = reduceDiscoveryEvent(candidate, event);
    const active = candidate.active;
    if (active?.limitReason && !events.some((event) => event.kind === "discovery.interrupted")) {
      const interrupted: RuntimeDiscoveryEvent = {
        ...this.baseEvent(operationId, "discovery.interrupted", at),
        eventId: `discovery:${operationId}:auto-interrupted`,
        kind: "discovery.interrupted",
        data: {
          operationId,
          fingerprint,
          discoveryId: active.discoveryId,
          reason:
            active.limitReason === "budget_exhausted"
              ? "Discovery shared budget exhausted"
              : "Discovery produced no information gain for two checkpoints",
          limitReason: active.limitReason,
        },
      };
      reduceDiscoveryEvent(candidate, interrupted);
      events = [...events, interrupted];
    }
    await this.store.appendBatch(events, {
      expectedSessionHighWater: {
        [this.context.sessionId]: input.expectedSessionSequence ?? projection.sessionSequence,
      },
    });
    return this.project();
  }

  private baseEvent(operationId: string, suffix: string, at: string) {
    return {
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      eventId: `discovery:${operationId}:${suffix}`,
      sessionId: this.context.sessionId,
      invocationId: this.context.invocationId,
      runId: this.context.runId,
      turnId: this.context.turnId,
      at,
      partial: false as const,
      visibility: "internal" as const,
    };
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeTail.then(operation, operation);
    this.writeTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function normalizeCheckpoint(input: DiscoveryCheckpoint): DiscoveryCheckpoint {
  if (!isDiscoveryPhase(input.phase))
    throw new DiscoveryConflictError("Discovery phase is invalid");
  return {
    phase: input.phase,
    cycle: positiveInteger(input.cycle, "Discovery cycle"),
    candidates: normalizeCandidates(input.candidates),
    evidenceRefs: uniqueTexts(
      input.evidenceRefs,
      "evidence reference",
      DISCOVERY_MAX_EVIDENCE_REFS,
    ),
    hypotheses: normalizeHypotheses(input.hypotheses),
    openQuestions: uniqueTexts(input.openQuestions, "open question", 20),
    toolCallsUsed: nonNegativeInteger(input.toolCallsUsed, "toolCallsUsed"),
    inspectedFiles: uniqueTexts(input.inspectedFiles, "inspected file", 80),
  };
}

function normalizeBranchStart(input: DiscoveryBranchStartInput) {
  return {
    discoveryId: requiredDiscoveryId(input.discoveryId, "Discovery id"),
    branchId: requiredDiscoveryId(input.branchId, "Discovery branch id"),
    ordinal: nonNegativeInteger(input.ordinal, "Discovery branch ordinal"),
    objective: requiredText(input.objective, "Discovery branch objective"),
    roots: uniqueTexts(input.roots ?? ["."], "Discovery branch root", 8),
    queries: uniqueTexts(input.queries ?? [], "Discovery branch query", 16),
    stoppingCondition: requiredText(input.stoppingCondition, "Discovery branch stopping condition"),
    reserveToolCalls: positiveInteger(input.reserveToolCalls, "reserveToolCalls"),
    reserveFiles: positiveInteger(input.reserveFiles, "reserveFiles"),
  };
}

function normalizeCandidates(candidates: readonly DiscoveryCheckpoint["candidates"][number][]) {
  if (!Array.isArray(candidates) || candidates.length > DISCOVERY_MAX_CANDIDATES) {
    throw new DiscoveryConflictError("Discovery candidate limit exceeded");
  }
  return candidates.map(normalizeDiscoveryCandidate);
}

function normalizeHypotheses(hypotheses: readonly DiscoveryHypothesis[]): DiscoveryHypothesis[] {
  if (!Array.isArray(hypotheses) || hypotheses.length > 20) {
    throw new DiscoveryConflictError("Discovery hypothesis limit exceeded");
  }
  const ids = new Set<string>();
  return hypotheses.map((hypothesis) => {
    const id = requiredDiscoveryId(hypothesis.id, "Discovery hypothesis id");
    if (ids.has(id)) throw new DiscoveryConflictError(`Duplicate Discovery hypothesis: ${id}`);
    ids.add(id);
    if (
      hypothesis.status !== "open" &&
      hypothesis.status !== "supported" &&
      hypothesis.status !== "rejected"
    ) {
      throw new DiscoveryConflictError("Discovery hypothesis status is invalid");
    }
    return {
      id,
      statement: requiredText(hypothesis.statement, "Discovery hypothesis"),
      status: hypothesis.status,
      evidenceRefs: uniqueTexts(hypothesis.evidenceRefs, "hypothesis evidence", 20),
    };
  });
}

function normalizeReport(report: DiscoveryReport): DiscoveryReport {
  const normalized = {
    summary: requiredText(report.summary, "Discovery report summary"),
    confirmedTargets: normalizeCandidates(report.confirmedTargets),
    evidenceRefs: uniqueTexts(report.evidenceRefs, "report evidence", DISCOVERY_MAX_EVIDENCE_REFS),
    remainingRisks: uniqueTexts(report.remainingRisks, "remaining risk", 20),
  };
  if (normalized.evidenceRefs.length === 0) {
    throw new DiscoveryConflictError("Discovery report requires evidence");
  }
  return normalized;
}

function uniqueTexts(values: readonly string[], label: string, max: number): string[] {
  if (!Array.isArray(values) || values.length > max) {
    throw new DiscoveryConflictError(`${label} list exceeds ${max} items`);
  }
  return [...new Set(values.map((value) => requiredText(value, label)))];
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DiscoveryConflictError(`${label} must not be empty`);
  return normalized;
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DiscoveryConflictError(`${label} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DiscoveryConflictError(`${label} is invalid`);
  }
  return value;
}
