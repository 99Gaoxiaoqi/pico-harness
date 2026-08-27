import type { RuntimeEvent } from "../engine/session-runtime-event.js";
import type { RuntimeEventStoreEntry } from "../storage/runtime-event-store-contracts.js";
import { isPlanEventKind } from "./events.js";
import {
  PlanConflictError,
  isTerminalPlanStep,
  type PlanProjection,
  type PlanProposal,
  type PlanStep,
} from "./contract.js";

/**
 * 折叠 plan.* 事件切片为 {@link PlanProjection}。
 * `sessionSequence` 默认取传入 entries 的末条 sequence;票 04 起消费方可以用
 * kind 切片查询替代全量读,此时显式传入 `headSequence`(全会话水位)保持
 * CAS 语义与全量口径一致。折叠规则本身不变。
 */
export function projectPlanEntries(
  sessionId: string,
  entries: readonly RuntimeEventStoreEntry[],
  headSequence?: number,
): PlanProjection {
  let state: PlanProjection = {
    sessionId,
    sessionSequence: headSequence ?? entries.at(-1)?.sequence ?? 0,
    proposals: [],
  };
  for (const entry of entries) {
    if (isPlanEventKind(entry.event.kind)) state = reducePlanEvent(state, entry.event);
  }
  return state;
}

/** Active-branch Plan facts frozen by Session fork at one durable cursor. */
export function projectActivePlanEntries(
  entries: readonly RuntimeEventStoreEntry[],
): RuntimeEventStoreEntry[] {
  return entries.filter(({ event }) => isPlanEventKind(event.kind));
}

export function reducePlanEvent(state: PlanProjection, event: RuntimeEvent): PlanProjection {
  if (!isPlanEventKind(event.kind)) return state;
  const proposals = [...state.proposals];
  let pendingProposal = state.pendingProposal;
  let execution = state.execution;
  let revisionRequest = state.revisionRequest;
  let reviewClaim = state.reviewClaim;
  if (event.kind !== "plan.review.claimed" && reviewClaim) {
    assertReviewClaimTransition(reviewClaim, event, pendingProposal, execution);
    reviewClaim = undefined;
  }
  switch (event.kind) {
    case "plan.proposed": {
      if (pendingProposal) conflict("A pending plan proposal already exists");
      if (revisionRequest) conflict("A requested plan revision must be submitted first");
      if (execution && execution.status !== "completed" && execution.status !== "cancelled")
        conflict("A plan execution is still open");
      if (proposals.some((proposal) => proposal.planId === event.data.proposal.planId))
        conflict("Plan id already exists");
      pendingProposal = clone(event.data.proposal);
      proposals.push(pendingProposal);
      break;
    }
    case "plan.revised": {
      const revisionBase = pendingProposal ?? revisionRequestedProposal(proposals, revisionRequest);
      requirePending(revisionBase, event.data.planId, event.data.expectedRevision);
      proposals[proposals.length - 1] = { ...revisionBase!, status: "stale" };
      pendingProposal = clone(event.data.proposal);
      proposals.push(pendingProposal);
      revisionRequest = undefined;
      break;
    }
    case "plan.revision.requested": {
      requirePending(pendingProposal, event.data.planId, event.data.expectedRevision);
      proposals[proposals.length - 1] = { ...pendingProposal!, status: "stale" };
      pendingProposal = undefined;
      revisionRequest = {
        planId: event.data.planId,
        expectedRevision: event.data.expectedRevision,
        feedback: event.data.feedback,
        operationId: event.data.operationId,
        requestedAt: event.at,
      };
      break;
    }
    case "plan.review.claimed": {
      if (reviewClaim) conflict("A Plan review action already owns this control epoch");
      if (state.controlEpoch !== event.data.controlEpoch) {
        conflict("Plan control epoch is stale");
      }
      const pendingAction =
        event.data.action === "execute" ||
        event.data.action === "continue_editing" ||
        event.data.action === "reject_exit";
      if (pendingAction) {
        requirePending(pendingProposal, event.data.planId, event.data.revision);
      } else if (
        !execution ||
        execution.status !== "interrupted" ||
        execution.planId !== event.data.planId ||
        execution.revision !== event.data.revision
      ) {
        conflict("Plan execution is not interrupted");
      }
      reviewClaim = {
        operationId: event.data.operationId,
        planId: event.data.planId,
        revision: event.data.revision,
        controlEpoch: event.data.controlEpoch,
        action: event.data.action,
        ...(event.data.feedback ? { feedback: event.data.feedback } : {}),
        claimedAt: event.at,
      };
      break;
    }
    case "plan.approved":
    case "plan.rejected": {
      requirePending(pendingProposal, event.data.planId, event.data.expectedRevision);
      if (event.kind === "plan.approved" && event.data.reviewedBy === "system") {
        conflict("A plan must be approved by the user");
      }
      const status = event.kind === "plan.approved" ? "approved" : "rejected";
      const reviewed = {
        ...pendingProposal!,
        status,
        reviewedBy: event.data.reviewedBy,
      } as PlanProposal;
      proposals[proposals.length - 1] = reviewed;
      pendingProposal = undefined;
      revisionRequest = undefined;
      break;
    }
    case "plan.execution.started": {
      if (execution && execution.status !== "completed" && execution.status !== "cancelled")
        conflict("A plan execution is still open");
      const approved = [...proposals]
        .reverse()
        .find(
          (proposal) =>
            proposal.planId === event.data.planId &&
            proposal.revision === event.data.revision &&
            proposal.status === "approved",
        );
      if (!approved) conflict("Plan revision is not approved");
      execution = {
        planId: approved.planId,
        revision: approved.revision,
        status: "active",
        steps: clone(approved.steps),
        startedAt: event.at,
        updatedAt: event.at,
      };
      break;
    }
    case "plan.step.updated": {
      if (!execution || execution.planId !== event.data.planId || execution.status !== "active")
        conflict("Plan execution is not active");
      const index = execution.steps.findIndex((step) => step.id === event.data.stepId);
      if (index < 0) conflict("Plan step does not exist");
      const current = execution.steps[index]!;
      if (isTerminalPlanStep(current.status) && current.status !== event.data.status)
        conflict("A terminal plan step cannot be reopened");
      if (
        event.data.status === "in_progress" &&
        execution.steps.some(
          (step, candidate) => candidate !== index && step.status === "in_progress",
        )
      )
        conflict("Only one plan step may be in progress");
      const steps = execution.steps.map((step, candidate) =>
        candidate === index
          ? {
              ...step,
              status: event.data.status,
              ...(event.data.note === undefined ? {} : { note: event.data.note }),
            }
          : step,
      ) as PlanStep[];
      execution = {
        ...execution,
        steps,
        status: steps.every((step) => isTerminalPlanStep(step.status)) ? "completed" : "active",
        updatedAt: event.at,
      };
      break;
    }
    case "plan.step.recovered": {
      if (!execution || execution.planId !== event.data.planId)
        conflict("Plan execution does not exist");
      if (execution.status !== "active" && execution.status !== "interrupted")
        conflict("Plan step can only be recovered from an active or interrupted execution");
      const index = execution.steps.findIndex((step) => step.id === event.data.stepId);
      if (index < 0) conflict("Plan step does not exist");
      const current = execution.steps[index]!;
      if (current.status !== "in_progress")
        conflict("Only an in_progress plan step can be recovered");
      const steps = execution.steps.map((step, candidate) =>
        candidate === index
          ? {
              ...step,
              status: "pending" as const,
              ...(event.data.note === undefined ? {} : { note: event.data.note }),
            }
          : step,
      ) as PlanStep[];
      execution = {
        ...execution,
        steps,
        updatedAt: event.at,
      };
      break;
    }
    case "plan.execution.interrupted":
      if (!execution || execution.planId !== event.data.planId || execution.status !== "active")
        conflict("Plan execution is not active");
      execution = {
        ...execution,
        status: "interrupted",
        updatedAt: event.at,
        ...(event.data.reason ? { reason: event.data.reason } : {}),
      };
      break;
    case "plan.execution.resumed":
      if (
        !execution ||
        execution.planId !== event.data.planId ||
        execution.status !== "interrupted"
      )
        conflict("Plan execution is not interrupted");
      {
        const { reason: _reason, ...resumed } = execution;
        execution = {
          ...resumed,
          status: "active",
          updatedAt: event.at,
        };
      }
      break;
    case "plan.execution.replanned":
      if (
        !execution ||
        execution.planId !== event.data.planId ||
        execution.status !== "interrupted"
      )
        conflict("Plan execution is not interrupted");
      execution = {
        ...execution,
        status: "cancelled",
        updatedAt: event.at,
        ...(event.data.reason ? { reason: event.data.reason } : {}),
      };
      break;
    case "plan.execution.cancelled":
      if (
        !execution ||
        execution.planId !== event.data.planId ||
        (execution.status !== "active" && execution.status !== "interrupted")
      )
        conflict("Plan execution is not open");
      execution = {
        ...execution,
        status: "cancelled",
        updatedAt: event.at,
        ...(event.data.reason ? { reason: event.data.reason } : {}),
      };
      break;
    case "plan.execution.completed":
      if (
        !execution ||
        execution.planId !== event.data.planId ||
        !execution.steps.every((step) => isTerminalPlanStep(step.status))
      )
        conflict("Plan execution has unfinished steps");
      execution = { ...execution, status: "completed", updatedAt: event.at };
      break;
  }
  return {
    sessionId: state.sessionId,
    sessionSequence: state.sessionSequence,
    controlEpoch: event.eventId,
    proposals,
    ...(proposals.at(-1) ? { latestProposal: proposals.at(-1) } : {}),
    ...(pendingProposal ? { pendingProposal } : {}),
    ...(execution ? { execution } : {}),
    ...(revisionRequest ? { revisionRequest } : {}),
    ...(reviewClaim ? { reviewClaim } : {}),
  };
}

function assertReviewClaimTransition(
  claim: NonNullable<PlanProjection["reviewClaim"]>,
  event: RuntimeEvent,
  pendingProposal: PlanProposal | undefined,
  execution: PlanProjection["execution"],
): void {
  if (!("claimOperationId" in event.data) || event.data.claimOperationId !== claim.operationId) {
    conflict("A Plan review action already owns this control epoch");
  }
  const expectedKind = {
    execute: "plan.approved",
    continue_editing: "plan.revision.requested",
    reject_exit: "plan.rejected",
    resume_execution: "plan.execution.resumed",
    cancel_execution: "plan.execution.cancelled",
    replan_execution: "plan.execution.replanned",
  }[claim.action];
  if (
    event.kind !== expectedKind ||
    !("planId" in event.data) ||
    event.data.planId !== claim.planId
  ) {
    conflict("Plan review claim cannot be consumed by a different control action");
  }
  if (
    (claim.action === "execute" ||
      claim.action === "continue_editing" ||
      claim.action === "reject_exit") &&
    (!pendingProposal ||
      pendingProposal.planId !== claim.planId ||
      pendingProposal.revision !== claim.revision ||
      !("expectedRevision" in event.data) ||
      event.data.expectedRevision !== claim.revision)
  ) {
    conflict("Plan review claim revision is stale");
  }
  if (
    (claim.action === "resume_execution" ||
      claim.action === "cancel_execution" ||
      claim.action === "replan_execution") &&
    (!execution ||
      execution.status !== "interrupted" ||
      execution.planId !== claim.planId ||
      execution.revision !== claim.revision)
  ) {
    conflict("Plan review claim execution is stale");
  }
  if (
    claim.action === "continue_editing" &&
    (!("feedback" in event.data) || event.data.feedback !== (claim.feedback ?? ""))
  ) {
    conflict("Plan review claim feedback differs");
  }
}

function revisionRequestedProposal(
  proposals: readonly PlanProposal[],
  request: PlanProjection["revisionRequest"],
): PlanProposal | undefined {
  const latest = proposals.at(-1);
  return request &&
    latest?.planId === request.planId &&
    latest.revision === request.expectedRevision &&
    latest.status === "stale"
    ? latest
    : undefined;
}

function requirePending(
  proposal: PlanProposal | undefined,
  planId: string,
  revision: number,
): void {
  if (!proposal || proposal.planId !== planId || proposal.revision !== revision)
    conflict("Plan proposal revision is stale");
}
function conflict(message: string): never {
  throw new PlanConflictError(message);
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
