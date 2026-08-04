import {
  PLAN_EVENT_MAX_BYTES,
  PLAN_MAX_STEPS,
  isPlanStepStatus,
  type PlanProposal,
} from "./contract.js";

export const PLAN_EVENT_KINDS = [
  "plan.proposed",
  "plan.revised",
  "plan.approved",
  "plan.rejected",
  "plan.execution.started",
  "plan.step.updated",
  "plan.execution.interrupted",
  "plan.execution.completed",
  "plan.execution.cancelled",
] as const;

export type PlanEventKind = (typeof PLAN_EVENT_KINDS)[number];

export function isPlanEventKind(value: unknown): value is PlanEventKind {
  return typeof value === "string" && (PLAN_EVENT_KINDS as readonly string[]).includes(value);
}

export function assertPlanEventData(kind: PlanEventKind, data: unknown): void {
  if (!isRecord(data)) throw new Error("Plan event data must be an object");
  assertId(data.operationId, "operationId");
  if (typeof data.fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(data.fingerprint)) {
    throw new Error("Plan event fingerprint is invalid");
  }
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > PLAN_EVENT_MAX_BYTES) {
    throw new Error(`Plan event exceeds ${PLAN_EVENT_MAX_BYTES} bytes`);
  }
  if (kind === "plan.proposed") return assertProposal(data.proposal, 1);
  if (kind === "plan.revised") {
    assertId(data.planId, "planId");
    assertPositiveInteger(data.expectedRevision, "expectedRevision");
    assertProposal(data.proposal, (data.expectedRevision as number) + 1);
    if ((data.proposal as PlanProposal).planId !== data.planId)
      throw new Error("Revised plan id differs");
    return;
  }
  assertId(data.planId, "planId");
  if (kind === "plan.approved" || kind === "plan.rejected") {
    assertPositiveInteger(data.expectedRevision, "expectedRevision");
    if (data.reviewedBy !== "user" && data.reviewedBy !== "system")
      throw new Error("reviewedBy is invalid");
  } else if (kind === "plan.execution.started") {
    assertPositiveInteger(data.revision, "revision");
  } else if (kind === "plan.step.updated") {
    assertId(data.stepId, "stepId");
    if (!isPlanStepStatus(data.status)) throw new Error("Plan step status is invalid");
  }
  if (data.reason !== undefined && typeof data.reason !== "string")
    throw new Error("reason is invalid");
  if (data.note !== undefined && typeof data.note !== "string") throw new Error("note is invalid");
}

function assertProposal(value: unknown, revision: number): asserts value is PlanProposal {
  if (!isRecord(value)) throw new Error("Plan proposal is invalid");
  assertId(value.planId, "planId");
  if (value.revision !== revision || value.status !== "pending")
    throw new Error("Plan proposal revision/status is invalid");
  if (typeof value.title !== "string" || !value.title.trim())
    throw new Error("Plan title is invalid");
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > PLAN_MAX_STEPS)
    throw new Error("Plan steps are invalid");
  const ids = new Set<string>();
  for (const step of value.steps) {
    if (!isRecord(step)) throw new Error("Plan step is invalid");
    assertId(step.id, "stepId");
    if (ids.has(step.id as string)) throw new Error("Plan step id is duplicated");
    ids.add(step.id as string);
    if (
      typeof step.title !== "string" ||
      !step.title.trim() ||
      typeof step.description !== "string" ||
      !step.description.trim() ||
      step.status !== "pending"
    )
      throw new Error("Plan step is invalid");
  }
}

function assertPositiveInteger(value: unknown, name: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${name} is invalid`);
}
function assertId(value: unknown, name: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value))
    throw new Error(`${name} is invalid`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
