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
  RuntimeEventStoreHighWaterConflictError,
  RuntimeEventStoreIntegrityError,
  RuntimeEventStorePlanOperationConflictError,
  type RuntimeEventStoreEntry,
  type RuntimeOwnerFence,
} from "../storage/runtime-event-store-contracts.js";
import type { EngineRuntimeWriteGuard } from "../engine/runtime-port.js";
import {
  PlanConflictError,
  normalizePlanProposalInput,
  planOperationFingerprint,
  type PlanProjection,
  type PlanProposalInput,
  type PlanReviewAction,
  type PlanReviewedBy,
  type PlanStepStatus,
} from "./contract.js";
import { projectActivePlanEntries, projectPlanEntries, reducePlanEvent } from "./reducer.js";
import { PLAN_EVENT_KINDS } from "./events.js";
import { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";

export interface PlanCoordinatorContext {
  readonly sessionId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly writeGuard?: EngineRuntimeWriteGuard;
}
interface OperationInput {
  readonly operationId: string;
  readonly expectedSessionSequence: number;
  readonly claimOperationId?: string;
}

export type PlanOperationStatus = "missing" | "matching";

export class PlanCoordinator {
  constructor(
    private readonly store: SqliteRuntimeEventStore,
    private readonly context: PlanCoordinatorContext,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * plan.* 事件切片 + 全会话水位(票 04):折叠输入只含 plan 事件,
   * sessionSequence 由水位显式传入,保持 CAS 口径与全量读一致。
   */
  private async readPlanEntries(): Promise<{
    readonly entries: readonly RuntimeEventStoreEntry[];
    readonly headSequence: number;
  }> {
    const slice = await this.store.readSessionEntriesOfKinds(
      this.context.sessionId,
      PLAN_EVENT_KINDS,
    );
    return slice;
  }

  private projectPlan(
    slice: Awaited<ReturnType<PlanCoordinator["readPlanEntries"]>>,
  ): PlanProjection {
    return projectPlanEntries(this.context.sessionId, slice.entries, slice.headSequence);
  }

  async project(): Promise<PlanProjection> {
    return this.projectPlan(await this.readPlanEntries());
  }

  async operationStatus(
    operationId: string,
    kind: string,
    semantic: unknown,
    claimOperationId?: string,
  ): Promise<PlanOperationStatus> {
    const fingerprint = planOperationFingerprint(
      kind,
      claimOperationId ? { semantic, claimOperationId } : semantic,
    );
    const replay = projectActivePlanEntries((await this.readPlanEntries()).entries).find(
      ({ event }) =>
        event.kind.startsWith("plan.") &&
        "operationId" in event.data &&
        event.data.operationId === operationId,
    );
    if (!replay) return "missing";
    if (!("fingerprint" in replay.event.data) || replay.event.data.fingerprint !== fingerprint) {
      throw new RuntimeEventStorePlanOperationConflictError(operationId);
    }
    return "matching";
  }

  async claimReview(
    input: OperationInput & {
      readonly planId: string;
      readonly revision: number;
      readonly controlEpoch: string;
      readonly action: PlanReviewAction;
      readonly feedback?: string;
    },
  ): Promise<PlanProjection> {
    const semantic = {
      planId: input.planId,
      revision: input.revision,
      controlEpoch: input.controlEpoch,
      action: input.action,
      ...(input.feedback?.trim() ? { feedback: input.feedback.trim() } : {}),
    };
    return this.simple(input, "plan.review.claimed", semantic);
  }

  async claimAndReject(
    input: OperationInput & {
      readonly planId: string;
      readonly revision: number;
      readonly controlEpoch: string;
      readonly settings: PersistedSessionSettings;
      readonly feedback?: string;
    },
  ): Promise<PlanProjection> {
    const feedback = input.feedback?.trim();
    const semantic = {
      claim: {
        planId: input.planId,
        revision: input.revision,
        controlEpoch: input.controlEpoch,
        action: "reject_exit" as const,
        ...(feedback ? { feedback } : {}),
      },
      transition: {
        planId: input.planId,
        expectedRevision: input.revision,
        reviewedBy: "user" as const,
        ...(feedback ? { reason: feedback } : {}),
      },
    };
    return this.commit(input, "plan.review.reject", semantic, (fact, at) => {
      const patch = normalizeSessionRuntimeStateWritePatch({
        settings: {
          ...input.settings,
          collaborationMode: "agent",
          permissionMode:
            input.settings.permissionMode ??
            input.settings.prePlanMode ??
            (input.settings.mode === "plan" ? "yolo" : input.settings.mode),
        },
      });
      if (!patch) throw new PlanConflictError("Session settings are invalid");
      return [
        {
          ...this.baseEvent(input.operationId, "plan.review.claimed", at),
          kind: "plan.review.claimed",
          data: { ...fact, ...semantic.claim },
        },
        {
          ...this.baseEvent(input.operationId, "plan.rejected", at),
          kind: "plan.rejected",
          data: { ...fact, claimOperationId: input.operationId, ...semantic.transition },
        },
        {
          ...this.baseEvent(input.operationId, "session.state.committed", at),
          kind: "session.state.committed",
          data: { stateVersion: SESSION_RUNTIME_STATE_VERSION, patch },
        },
      ];
    });
  }

  async claimAndCancel(
    input: OperationInput & {
      readonly planId: string;
      readonly revision: number;
      readonly controlEpoch: string;
      readonly feedback?: string;
    },
  ): Promise<PlanProjection> {
    const feedback = input.feedback?.trim();
    const semantic = {
      claim: {
        planId: input.planId,
        revision: input.revision,
        controlEpoch: input.controlEpoch,
        action: "cancel_execution" as const,
        ...(feedback ? { feedback } : {}),
      },
      transition: {
        planId: input.planId,
        ...(feedback ? { reason: feedback } : {}),
      },
    };
    return this.commit(input, "plan.review.cancel", semantic, (fact, at) => [
      {
        ...this.baseEvent(input.operationId, "plan.review.claimed", at),
        kind: "plan.review.claimed",
        data: { ...fact, ...semantic.claim },
      },
      {
        ...this.baseEvent(input.operationId, "plan.execution.cancelled", at),
        kind: "plan.execution.cancelled",
        data: { ...fact, claimOperationId: input.operationId, ...semantic.transition },
      },
    ]);
  }

  async propose(
    input: OperationInput & { readonly proposal: PlanProposalInput },
  ): Promise<PlanProjection> {
    const proposalInput = normalizePlanProposalInput(input.proposal);
    const semantic = { proposal: proposalInput };
    return this.commit(input, "plan.proposed", semantic, (fact, at) => [
      {
        ...this.baseEvent(input.operationId, "plan.proposed", at),
        kind: "plan.proposed",
        data: {
          ...fact,
          proposal: {
            ...proposalInput,
            planId: proposalInput.planId ?? randomUUID(),
            revision: 1,
            steps: proposalInput.steps.map((step) => ({ ...step, status: "pending" as const })),
            status: "pending" as const,
            proposedAt: at,
          },
        },
      },
    ]);
  }

  async revise(
    input: OperationInput & {
      readonly planId: string;
      readonly expectedRevision: number;
      readonly proposal: Omit<PlanProposalInput, "planId">;
    },
  ): Promise<PlanProjection> {
    const proposalInput = normalizePlanProposalInput({ ...input.proposal, planId: input.planId });
    const semantic = {
      planId: input.planId,
      expectedRevision: input.expectedRevision,
      proposal: proposalInput,
    };
    return this.commit(input, "plan.revised", semantic, (fact, at) => [
      {
        ...this.baseEvent(input.operationId, "plan.revised", at),
        kind: "plan.revised",
        data: {
          ...fact,
          planId: input.planId,
          expectedRevision: input.expectedRevision,
          proposal: {
            ...proposalInput,
            planId: input.planId,
            revision: input.expectedRevision + 1,
            steps: proposalInput.steps.map((step) => ({ ...step, status: "pending" as const })),
            status: "pending" as const,
            proposedAt: at,
          },
        },
      },
    ]);
  }

  async requestRevision(
    input: OperationInput & {
      readonly planId: string;
      readonly expectedRevision: number;
      readonly feedback: string;
    },
  ): Promise<PlanProjection> {
    const feedback = input.feedback.trim();
    if (!feedback) throw new PlanConflictError("Plan revision feedback must not be empty");
    return this.simple(input, "plan.revision.requested", {
      planId: input.planId,
      expectedRevision: input.expectedRevision,
      feedback,
    });
  }

  async approve(
    input: OperationInput & {
      readonly planId: string;
      readonly expectedRevision: number;
      readonly reviewedBy: PlanReviewedBy;
      readonly settings: PersistedSessionSettings;
    },
  ): Promise<PlanProjection> {
    const semantic = {
      planId: input.planId,
      expectedRevision: input.expectedRevision,
      reviewedBy: input.reviewedBy,
    };
    return this.commit(input, "plan.approved", semantic, (fact, at) => {
      const patch = normalizeSessionRuntimeStateWritePatch({
        settings: {
          ...input.settings,
          collaborationMode: "agent",
          permissionMode:
            input.settings.permissionMode ??
            input.settings.prePlanMode ??
            (input.settings.mode === "plan" ? "yolo" : input.settings.mode),
        },
      });
      if (!patch) throw new PlanConflictError("Session settings are invalid");
      return [
        {
          ...this.baseEvent(input.operationId, "plan.approved", at),
          kind: "plan.approved",
          data: {
            ...fact,
            planId: input.planId,
            expectedRevision: input.expectedRevision,
            reviewedBy: input.reviewedBy,
          },
        },
        {
          ...this.baseEvent(input.operationId, "session.state.committed", at),
          kind: "session.state.committed",
          data: { stateVersion: SESSION_RUNTIME_STATE_VERSION, patch },
        },
      ];
    });
  }

  async reject(
    input: OperationInput & {
      readonly planId: string;
      readonly expectedRevision: number;
      readonly reviewedBy: PlanReviewedBy;
      readonly reason?: string;
    },
  ): Promise<PlanProjection> {
    return this.simple(input, "plan.rejected", {
      planId: input.planId,
      expectedRevision: input.expectedRevision,
      reviewedBy: input.reviewedBy,
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }
  async rejectAndExit(
    input: OperationInput & {
      readonly planId: string;
      readonly expectedRevision: number;
      readonly reviewedBy: PlanReviewedBy;
      readonly settings: PersistedSessionSettings;
      readonly reason?: string;
    },
  ): Promise<PlanProjection> {
    const semantic = {
      planId: input.planId,
      expectedRevision: input.expectedRevision,
      reviewedBy: input.reviewedBy,
      ...(input.reason ? { reason: input.reason } : {}),
    };
    return this.commit(input, "plan.rejected", semantic, (fact, at) => {
      const patch = normalizeSessionRuntimeStateWritePatch({
        settings: {
          ...input.settings,
          collaborationMode: "agent",
          permissionMode:
            input.settings.permissionMode ??
            input.settings.prePlanMode ??
            (input.settings.mode === "plan" ? "yolo" : input.settings.mode),
        },
      });
      if (!patch) throw new PlanConflictError("Session settings are invalid");
      return [
        {
          ...this.baseEvent(input.operationId, "plan.rejected", at),
          kind: "plan.rejected",
          data: { ...fact, ...semantic },
        },
        {
          ...this.baseEvent(input.operationId, "session.state.committed", at),
          kind: "session.state.committed",
          data: { stateVersion: SESSION_RUNTIME_STATE_VERSION, patch },
        },
      ];
    });
  }
  async startExecution(
    input: OperationInput & { readonly planId: string; readonly revision: number },
  ): Promise<PlanProjection> {
    return this.simple(input, "plan.execution.started", {
      planId: input.planId,
      revision: input.revision,
    });
  }
  async interrupt(
    input: OperationInput & { readonly planId: string; readonly reason?: string },
  ): Promise<PlanProjection> {
    return this.simple(input, "plan.execution.interrupted", {
      planId: input.planId,
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }
  async resume(input: OperationInput & { readonly planId: string }): Promise<PlanProjection> {
    return this.simple(input, "plan.execution.resumed", { planId: input.planId });
  }
  async replan(
    input: OperationInput & {
      readonly planId: string;
      readonly settings: PersistedSessionSettings;
      readonly reason?: string;
    },
  ): Promise<PlanProjection> {
    const semantic = {
      planId: input.planId,
      ...(input.reason ? { reason: input.reason } : {}),
    };
    return this.commit(input, "plan.execution.replanned", semantic, (fact, at) => {
      const patch = normalizeSessionRuntimeStateWritePatch({
        settings: {
          ...input.settings,
          collaborationMode: "plan",
          permissionMode: input.settings.permissionMode,
        },
      });
      if (!patch) throw new PlanConflictError("Session settings are invalid");
      return [
        {
          ...this.baseEvent(input.operationId, "plan.execution.replanned", at),
          kind: "plan.execution.replanned",
          data: { ...fact, ...semantic },
        },
        {
          ...this.baseEvent(input.operationId, "session.state.committed", at),
          kind: "session.state.committed",
          data: { stateVersion: SESSION_RUNTIME_STATE_VERSION, patch },
        },
      ];
    });
  }
  async cancel(
    input: OperationInput & { readonly planId: string; readonly reason?: string },
  ): Promise<PlanProjection> {
    return this.simple(input, "plan.execution.cancelled", {
      planId: input.planId,
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }
  async complete(input: OperationInput & { readonly planId: string }): Promise<PlanProjection> {
    return this.simple(input, "plan.execution.completed", { planId: input.planId });
  }

  async updateStep(
    input: OperationInput & {
      readonly planId: string;
      readonly stepId: string;
      readonly status: PlanStepStatus;
      readonly note?: string;
    },
  ): Promise<PlanProjection> {
    const data = {
      planId: input.planId,
      stepId: input.stepId,
      status: input.status,
      ...(input.note === undefined ? {} : { note: input.note }),
    };
    return this.commit(input, "plan.step.updated", data, (fact, at, projection) => {
      const step = {
        ...this.baseEvent(input.operationId, "plan.step.updated", at),
        kind: "plan.step.updated" as const,
        data: { ...fact, ...data },
      };
      const afterStep = reducePlanEvent(projection, step);
      if (afterStep.execution?.status !== "completed") return [step];
      return [
        step,
        {
          ...this.baseEvent(input.operationId, "plan.execution.completed", at),
          eventId: `plan:${this.context.sessionId}:${input.operationId}:completed`,
          kind: "plan.execution.completed" as const,
          data: { ...fact, planId: input.planId },
        },
      ];
    });
  }

  private simple(
    input: OperationInput,
    kind: RuntimePlanEvent["kind"],
    data: Record<string, unknown>,
  ): Promise<PlanProjection> {
    return this.commit(input, kind, data, (fact, at) => [
      {
        ...this.baseEvent(input.operationId, kind, at),
        kind,
        data: { ...fact, ...data },
      } as RuntimePlanEvent,
    ]);
  }

  private async commit(
    input: OperationInput,
    kind: string,
    semantic: unknown,
    build: (
      fact: { operationId: string; fingerprint: string; claimOperationId?: string },
      at: string,
      projection: PlanProjection,
    ) => RuntimeEvent[],
  ): Promise<PlanProjection> {
    const ownerFence = await this.ownerFence();
    let slice = await this.readPlanEntries();
    const callerSequence = input.expectedSessionSequence;
    const assertNoConcurrentPlanMutation = (): void => {
      if (input.claimOperationId) {
        const claim = this.projectPlan(slice).reviewClaim;
        if (claim?.operationId !== input.claimOperationId) {
          throw new PlanConflictError("Plan review claim is no longer active");
        }
        return;
      }
      if (
        callerSequence > slice.headSequence ||
        slice.entries.some(({ sequence }) => sequence > callerSequence)
      ) {
        throw new RuntimeEventStoreHighWaterConflictError(
          this.context.sessionId,
          callerSequence,
          slice.headSequence,
        );
      }
    };
    const fingerprint = planOperationFingerprint(
      kind,
      input.claimOperationId ? { semantic, claimOperationId: input.claimOperationId } : semantic,
    );
    const replayProjection = (): PlanProjection | undefined => {
      const replay = projectActivePlanEntries(slice.entries).find(
        ({ event }) =>
          event.kind.startsWith("plan.") &&
          "operationId" in event.data &&
          event.data.operationId === input.operationId,
      );
      if (!replay) return undefined;
      if (!("fingerprint" in replay.event.data) || replay.event.data.fingerprint !== fingerprint)
        throw new RuntimeEventStorePlanOperationConflictError(input.operationId);
      return this.projectPlan(slice);
    };
    const replay = replayProjection();
    if (replay) return replay;
    assertNoConcurrentPlanMutation();
    const at = this.now().toISOString();
    for (let attempt = 0; ; attempt++) {
      const projection = this.projectPlan(slice);
      const events = build(
        {
          operationId: input.operationId,
          fingerprint,
          ...(input.claimOperationId ? { claimOperationId: input.claimOperationId } : {}),
        },
        at,
        projection,
      );
      let candidate = projection;
      for (const event of events) {
        candidate = reducePlanEvent(candidate, event);
      }
      try {
        await this.store.appendPlanOperation(events, {
          operationId: input.operationId,
          fingerprint,
          expectedSessionSequence: slice.headSequence,
          ...(ownerFence ? { ownerFence } : {}),
        });
        break;
      } catch (error) {
        if (!(error instanceof RuntimeEventStoreIntegrityError)) throw error;
        slice = await this.readPlanEntries();
        const concurrentReplay = replayProjection();
        if (concurrentReplay) {
          await this.confirmOwnerFence(ownerFence);
          return concurrentReplay;
        }
        if (!(error instanceof RuntimeEventStoreHighWaterConflictError) || attempt >= 7)
          throw error;
        assertNoConcurrentPlanMutation();
      }
    }
    await this.confirmOwnerFence(ownerFence);
    return this.project();
  }

  private async ownerFence(): Promise<RuntimeOwnerFence | undefined> {
    const writeGuard = this.context.writeGuard;
    if (!writeGuard) {
      const current = await this.store.readOwnerFence(this.context.sessionId);
      if (current.epoch > 0) {
        throw new Error(
          `Plan mutation for Session ${this.context.sessionId} requires its Runtime write guard`,
        );
      }
      return undefined;
    }
    const ownerFence = await writeGuard.assertRuntimeEventWriteAllowed();
    if (ownerFence.sessionId !== this.context.sessionId || ownerFence.epoch <= 0) {
      throw new Error(`Plan write guard is not bound to Session ${this.context.sessionId}`);
    }
    return ownerFence;
  }

  private async confirmOwnerFence(expected: RuntimeOwnerFence | undefined): Promise<void> {
    if (!expected || !this.context.writeGuard) return;
    const actual = await this.context.writeGuard.assertRuntimeEventWriteAllowed();
    if (actual.sessionId !== expected.sessionId || actual.epoch !== expected.epoch) {
      throw new Error(`Plan owner fence changed during Session ${this.context.sessionId} write`);
    }
  }

  private baseEvent(operationId: string, suffix: string, at: string) {
    return {
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      // 事件 id 需在库级唯一(runtime_events.event_id 是 pico.sqlite 主键):
      // 同一 operationId 在不同会话重试时必须命中各自会话的幂等分支,
      // 因此把 sessionId 织入 id;同会话同 operationId 的重试仍得到相同 id。
      eventId: `plan:${this.context.sessionId}:${operationId}:${suffix}`,
      sessionId: this.context.sessionId,
      invocationId: this.context.invocationId,
      runId: this.context.runId,
      turnId: this.context.turnId,
      at,
      partial: false as const,
      visibility: "internal" as const,
    };
  }
}
