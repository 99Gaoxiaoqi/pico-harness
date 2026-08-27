import { planOperationFingerprint, type PlanReviewAction } from "./contract.js";

export interface PlanReviewIdentityInput {
  readonly sessionId: string;
  readonly planId: string;
  readonly revision: number;
  readonly controlEpoch: string;
  readonly action: PlanReviewAction;
  readonly feedback?: string;
}

/** Server-owned identity shared by every product shell for one semantic Plan control action. */
export function planReviewOperationId(input: PlanReviewIdentityInput): string {
  const fingerprint = planOperationFingerprint("plan.review", {
    sessionId: input.sessionId,
    planId: input.planId,
    revision: input.revision,
    controlEpoch: input.controlEpoch,
    action: input.action,
    feedback: input.feedback?.trim() ?? "",
  });
  return `plan-review:${fingerprint.slice("sha256:".length)}`;
}

export function planReviewTransitionOperationId(operationId: string): string {
  return `${operationId}:transition`;
}

export function planReviewRunId(operationId: string): string {
  return `run_plan_${operationId.slice("plan-review:".length, "plan-review:".length + 32)}`;
}
