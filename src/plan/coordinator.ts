import { randomUUID } from "node:crypto";
import {
  SESSION_RUNTIME_STATE_VERSION,
  normalizeSessionRuntimeStateWritePatch,
  type PersistedSessionSettings,
} from "../engine/session-runtime.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
  type RuntimePlanEvent,
} from "../engine/session-runtime-event.js";
import {
  RuntimeEventStore,
  RuntimeEventStorePlanOperationConflictError,
} from "../storage/runtime-event-store.js";
import {
  PlanConflictError,
  normalizePlanProposalInput,
  planOperationFingerprint,
  type PlanProjection,
  type PlanProposalInput,
  type PlanReviewedBy,
  type PlanStepStatus,
} from "./contract.js";
import { projectPlanEntries, reducePlanEvent } from "./reducer.js";

export interface PlanCoordinatorContext {
  readonly sessionId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly turnId: string;
}
interface OperationInput { readonly operationId: string; readonly expectedSessionSequence: number }

export class PlanCoordinator {
  constructor(
    private readonly store: RuntimeEventStore,
    private readonly context: PlanCoordinatorContext,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async project(): Promise<PlanProjection> {
    return projectPlanEntries(this.context.sessionId, await this.store.readSessionEntries(this.context.sessionId));
  }

  async propose(input: OperationInput & { readonly proposal: PlanProposalInput }): Promise<PlanProjection> {
    const proposalInput = normalizePlanProposalInput(input.proposal);
    const semantic = { proposal: proposalInput };
    return this.commit(input, "plan.proposed", semantic, (fact, at) => [{
      ...this.baseEvent(input.operationId, "plan.proposed", at),
      kind: "plan.proposed",
      data: { ...fact, proposal: { ...proposalInput, planId: proposalInput.planId ?? randomUUID(), revision: 1, steps: proposalInput.steps.map((step) => ({ ...step, status: "pending" as const })), status: "pending" as const, proposedAt: at } },
    }]);
  }

  async revise(input: OperationInput & { readonly planId: string; readonly expectedRevision: number; readonly proposal: Omit<PlanProposalInput, "planId"> }): Promise<PlanProjection> {
    const proposalInput = normalizePlanProposalInput({ ...input.proposal, planId: input.planId });
    const semantic = { planId: input.planId, expectedRevision: input.expectedRevision, proposal: proposalInput };
    return this.commit(input, "plan.revised", semantic, (fact, at) => [{ ...this.baseEvent(input.operationId, "plan.revised", at), kind: "plan.revised", data: { ...fact, planId: input.planId, expectedRevision: input.expectedRevision, proposal: { ...proposalInput, planId: input.planId, revision: input.expectedRevision + 1, steps: proposalInput.steps.map((step) => ({ ...step, status: "pending" as const })), status: "pending" as const, proposedAt: at } } }]);
  }

  async approve(input: OperationInput & { readonly planId: string; readonly expectedRevision: number; readonly reviewedBy: PlanReviewedBy; readonly settings: PersistedSessionSettings }): Promise<PlanProjection> {
    const semantic = { planId: input.planId, expectedRevision: input.expectedRevision, reviewedBy: input.reviewedBy };
    return this.commit(input, "plan.approved", semantic, (fact, at) => {
      const patch = normalizeSessionRuntimeStateWritePatch({ settings: { ...input.settings, collaborationMode: "agent", permissionMode: input.settings.permissionMode ?? input.settings.prePlanMode ?? (input.settings.mode === "plan" ? "yolo" : input.settings.mode) } });
      if (!patch) throw new PlanConflictError("Session settings are invalid");
      return [
        { ...this.baseEvent(input.operationId, "plan.approved", at), kind: "plan.approved", data: { ...fact, planId: input.planId, expectedRevision: input.expectedRevision, reviewedBy: input.reviewedBy } },
        { ...this.baseEvent(input.operationId, "session.state.committed", at), kind: "session.state.committed", data: { stateVersion: SESSION_RUNTIME_STATE_VERSION, patch } },
      ];
    });
  }

  async reject(input: OperationInput & { readonly planId: string; readonly expectedRevision: number; readonly reviewedBy: PlanReviewedBy; readonly reason?: string }): Promise<PlanProjection> {
    return this.simple(input, "plan.rejected", { planId: input.planId, expectedRevision: input.expectedRevision, reviewedBy: input.reviewedBy, ...(input.reason ? { reason: input.reason } : {}) });
  }
  async startExecution(input: OperationInput & { readonly planId: string; readonly revision: number }): Promise<PlanProjection> { return this.simple(input, "plan.execution.started", { planId: input.planId, revision: input.revision }); }
  async interrupt(input: OperationInput & { readonly planId: string; readonly reason?: string }): Promise<PlanProjection> { return this.simple(input, "plan.execution.interrupted", { planId: input.planId, ...(input.reason ? { reason: input.reason } : {}) }); }
  async cancel(input: OperationInput & { readonly planId: string; readonly reason?: string }): Promise<PlanProjection> { return this.simple(input, "plan.execution.cancelled", { planId: input.planId, ...(input.reason ? { reason: input.reason } : {}) }); }
  async complete(input: OperationInput & { readonly planId: string }): Promise<PlanProjection> { return this.simple(input, "plan.execution.completed", { planId: input.planId }); }

  async updateStep(input: OperationInput & { readonly planId: string; readonly stepId: string; readonly status: PlanStepStatus; readonly note?: string }): Promise<PlanProjection> {
    const data = { planId: input.planId, stepId: input.stepId, status: input.status, ...(input.note === undefined ? {} : { note: input.note }) };
    return this.commit(input, "plan.step.updated", data, (fact, at, projection) => {
      const step = { ...this.baseEvent(input.operationId, "plan.step.updated", at), kind: "plan.step.updated" as const, data: { ...fact, ...data } };
      const afterStep = reducePlanEvent(projection, step);
      if (afterStep.execution?.status !== "completed") return [step];
      return [step, { ...this.baseEvent(input.operationId, "plan.execution.completed", at), eventId: `plan:${input.operationId}:completed`, kind: "plan.execution.completed" as const, data: { ...fact, planId: input.planId } }];
    });
  }

  private simple(input: OperationInput, kind: RuntimePlanEvent["kind"], data: Record<string, unknown>): Promise<PlanProjection> {
    return this.commit(input, kind, data, (fact, at) => [{ ...this.baseEvent(input.operationId, kind, at), kind, data: { ...fact, ...data } } as RuntimePlanEvent]);
  }

  private async commit(input: OperationInput, kind: string, semantic: unknown, build: (fact: { operationId: string; fingerprint: string }, at: string, projection: PlanProjection) => RuntimeEvent[]): Promise<PlanProjection> {
    const fingerprint = planOperationFingerprint(kind, semantic);
    const entries = await this.store.readSessionEntries(this.context.sessionId);
    const replay = entries.find(({ event }) => event.kind.startsWith("plan.") && "operationId" in event.data && event.data.operationId === input.operationId);
    if (replay) {
      if (!("fingerprint" in replay.event.data) || replay.event.data.fingerprint !== fingerprint) throw new RuntimeEventStorePlanOperationConflictError(input.operationId);
      return projectPlanEntries(this.context.sessionId, entries);
    }
    const projection = projectPlanEntries(this.context.sessionId, entries);
    const events = build({ operationId: input.operationId, fingerprint }, this.now().toISOString(), projection);
    let candidate = projection;
    for (const event of events) candidate = reducePlanEvent(candidate, event);
    await this.store.appendPlanOperation(events, { operationId: input.operationId, fingerprint, expectedSessionSequence: input.expectedSessionSequence });
    return this.project();
  }

  private baseEvent(operationId: string, suffix: string, at: string) {
    return { schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION, eventId: `plan:${operationId}:${suffix}`, sessionId: this.context.sessionId, invocationId: this.context.invocationId, runId: this.context.runId, turnId: this.context.turnId, at, partial: false as const, visibility: "internal" as const };
  }
}
