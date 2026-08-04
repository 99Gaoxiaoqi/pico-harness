import type { RuntimeEvent } from "../engine/session-runtime-event.js";
import type { RuntimeEventStoreEntry } from "../storage/runtime-event-store.js";
import { isPlanEventKind } from "./events.js";
import {
  PlanConflictError,
  isTerminalPlanStep,
  type PlanProjection,
  type PlanProposal,
  type PlanStep,
} from "./contract.js";

export function projectPlanEntries(
  sessionId: string,
  entries: readonly RuntimeEventStoreEntry[],
): PlanProjection {
  const active = projectActiveBranch(entries);
  let state: PlanProjection = { sessionId, sessionSequence: entries.at(-1)?.sequence ?? 0, proposals: [] };
  for (const entry of active) {
    if (isPlanEventKind(entry.event.kind)) state = reducePlanEvent(state, entry.event);
  }
  return state;
}

/** Active-branch Plan facts frozen by Session fork at one durable cursor. */
export function projectActivePlanEntries(
  entries: readonly RuntimeEventStoreEntry[],
): RuntimeEventStoreEntry[] {
  return projectActiveBranch(entries).filter(({ event }) => isPlanEventKind(event.kind));
}

export function reducePlanEvent(state: PlanProjection, event: RuntimeEvent): PlanProjection {
  if (!isPlanEventKind(event.kind)) return state;
  const proposals = [...state.proposals];
  let pendingProposal = state.pendingProposal;
  let execution = state.execution;
  switch (event.kind) {
    case "plan.proposed": {
      if (pendingProposal) conflict("A pending plan proposal already exists");
      if (execution && execution.status !== "completed" && execution.status !== "cancelled") conflict("A plan execution is still open");
      if (proposals.some((proposal) => proposal.planId === event.data.proposal.planId)) conflict("Plan id already exists");
      pendingProposal = clone(event.data.proposal);
      proposals.push(pendingProposal);
      break;
    }
    case "plan.revised": {
      requirePending(pendingProposal, event.data.planId, event.data.expectedRevision);
      proposals[proposals.length - 1] = { ...pendingProposal!, status: "stale" };
      pendingProposal = clone(event.data.proposal);
      proposals.push(pendingProposal);
      break;
    }
    case "plan.approved":
    case "plan.rejected": {
      requirePending(pendingProposal, event.data.planId, event.data.expectedRevision);
      if (event.kind === "plan.approved" && event.data.reviewedBy === "system") {
        conflict("A plan must be approved by the user");
      }
      const status = event.kind === "plan.approved" ? "approved" : "rejected";
      const reviewed = { ...pendingProposal!, status, reviewedBy: event.data.reviewedBy } as PlanProposal;
      proposals[proposals.length - 1] = reviewed;
      pendingProposal = undefined;
      break;
    }
    case "plan.execution.started": {
      if (execution && execution.status !== "completed" && execution.status !== "cancelled") conflict("A plan execution is still open");
      const approved = [...proposals].reverse().find((proposal) => proposal.planId === event.data.planId && proposal.revision === event.data.revision && proposal.status === "approved");
      if (!approved) conflict("Plan revision is not approved");
      execution = { planId: approved.planId, revision: approved.revision, status: "active", steps: clone(approved.steps), startedAt: event.at, updatedAt: event.at };
      break;
    }
    case "plan.step.updated": {
      if (!execution || execution.planId !== event.data.planId || execution.status !== "active") conflict("Plan execution is not active");
      const index = execution.steps.findIndex((step) => step.id === event.data.stepId);
      if (index < 0) conflict("Plan step does not exist");
      const current = execution.steps[index]!;
      if (isTerminalPlanStep(current.status) && current.status !== event.data.status) conflict("A terminal plan step cannot be reopened");
      if (event.data.status === "in_progress" && execution.steps.some((step, candidate) => candidate !== index && step.status === "in_progress")) conflict("Only one plan step may be in progress");
      const steps = execution.steps.map((step, candidate) => candidate === index ? { ...step, status: event.data.status, ...(event.data.note === undefined ? {} : { note: event.data.note }) } : step) as PlanStep[];
      execution = { ...execution, steps, status: steps.every((step) => isTerminalPlanStep(step.status)) ? "completed" : "active", updatedAt: event.at };
      break;
    }
    case "plan.execution.interrupted":
      if (!execution || execution.planId !== event.data.planId || execution.status !== "active") conflict("Plan execution is not active");
      execution = { ...execution, status: "interrupted", updatedAt: event.at, ...(event.data.reason ? { reason: event.data.reason } : {}) };
      break;
    case "plan.execution.cancelled":
      if (!execution || execution.planId !== event.data.planId || (execution.status !== "active" && execution.status !== "interrupted")) conflict("Plan execution is not open");
      execution = { ...execution, status: "cancelled", updatedAt: event.at, ...(event.data.reason ? { reason: event.data.reason } : {}) };
      break;
    case "plan.execution.completed":
      if (!execution || execution.planId !== event.data.planId || !execution.steps.every((step) => isTerminalPlanStep(step.status))) conflict("Plan execution has unfinished steps");
      execution = { ...execution, status: "completed", updatedAt: event.at };
      break;
  }
  return { sessionId: state.sessionId, sessionSequence: state.sessionSequence, proposals, ...(proposals.at(-1) ? { latestProposal: proposals.at(-1) } : {}), ...(pendingProposal ? { pendingProposal } : {}), ...(execution ? { execution } : {}) };
}

function projectActiveBranch(entries: readonly RuntimeEventStoreEntry[]): RuntimeEventStoreEntry[] {
  let projected: RuntimeEventStoreEntry[] = [];
  for (const entry of entries) {
    if (entry.event.kind === "history.rewound") {
      const through = entry.event.data.throughEventId;
      if (!through) projected = [];
      else {
        const index = projected.findIndex(({ event }) => event.eventId === through);
        if (index < 0) conflict(`Rewind boundary ${through} is not on the active branch`);
        projected = projected.slice(0, index + 1);
      }
    }
    projected.push(entry);
  }
  return projected;
}
function requirePending(proposal: PlanProposal | undefined, planId: string, revision: number): void {
  if (!proposal || proposal.planId !== planId || proposal.revision !== revision) conflict("Plan proposal revision is stale");
}
function conflict(message: string): never { throw new PlanConflictError(message); }
function clone<T>(value: T): T { return structuredClone(value); }
