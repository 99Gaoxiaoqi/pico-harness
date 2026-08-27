import { createHash } from "node:crypto";

export type CollaborationMode = "agent" | "plan";
export type PermissionMode = "default" | "auto" | "yolo";
export type PlanReviewedBy = "user" | "system";
export type PlanProposalStatus = "pending" | "stale" | "approved" | "rejected";
export type PlanStepStatus = "pending" | "in_progress" | "completed" | "skipped";
export type PlanExecutionStatus = "active" | "interrupted" | "completed" | "cancelled";
export type PlanReviewAction =
  | "execute"
  | "continue_editing"
  | "reject_exit"
  | "resume_execution"
  | "cancel_execution"
  | "replan_execution";

export const PLAN_MAX_STEPS = 50;
export const PLAN_EVENT_MAX_BYTES = 64 * 1024;

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: PlanStepStatus;
  readonly note?: string;
}

export interface PlanProposal {
  readonly planId: string;
  readonly revision: number;
  readonly title: string;
  readonly overview?: string;
  readonly steps: readonly PlanStep[];
  readonly risks?: readonly string[];
  readonly status: PlanProposalStatus;
  readonly proposedAt: string;
  readonly reviewedBy?: PlanReviewedBy;
}

export interface PlanExecution {
  readonly planId: string;
  readonly revision: number;
  readonly status: PlanExecutionStatus;
  readonly steps: readonly PlanStep[];
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly reason?: string;
}

export interface PlanProjection {
  readonly sessionId: string;
  readonly sessionSequence: number;
  /** Stable identity of the latest durable plan.* control fact. */
  readonly controlEpoch?: string;
  readonly proposals: readonly PlanProposal[];
  readonly latestProposal?: PlanProposal;
  readonly pendingProposal?: PlanProposal;
  readonly execution?: PlanExecution;
  readonly revisionRequest?: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly feedback: string;
    readonly operationId: string;
    readonly requestedAt: string;
  };
  readonly reviewClaim?: {
    readonly operationId: string;
    readonly planId: string;
    readonly revision: number;
    readonly controlEpoch: string;
    readonly action: PlanReviewAction;
    readonly feedback?: string;
    readonly claimedAt: string;
  };
}

export interface PlanOperationFact {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly claimOperationId?: string;
}

export interface PlanProposalInput {
  readonly planId?: string;
  readonly title: string;
  readonly overview?: string;
  readonly steps: readonly Omit<PlanStep, "status" | "note">[];
  readonly risks?: readonly string[];
}

export class PlanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanConflictError";
  }
}

export function normalizePlanProposalInput(input: PlanProposalInput): PlanProposalInput {
  const title = requiredText(input.title, "Plan title");
  if (
    !Array.isArray(input.steps) ||
    input.steps.length < 1 ||
    input.steps.length > PLAN_MAX_STEPS
  ) {
    throw new PlanConflictError(`Plan steps must contain between 1 and ${PLAN_MAX_STEPS} items`);
  }
  const ids = new Set<string>();
  const steps = input.steps.map((step) => {
    const id = requiredId(step.id, "Plan step id");
    if (ids.has(id)) throw new PlanConflictError(`Plan step id is duplicated: ${id}`);
    ids.add(id);
    return {
      id,
      title: requiredText(step.title, "Plan step title"),
      description: requiredText(step.description, "Plan step description"),
    };
  });
  const normalized: PlanProposalInput = {
    ...(input.planId ? { planId: requiredId(input.planId, "Plan id") } : {}),
    title,
    ...(optionalText(input.overview) ? { overview: optionalText(input.overview) } : {}),
    steps,
    ...(input.risks?.length
      ? { risks: input.risks.map((risk) => requiredText(risk, "Plan risk")) }
      : {}),
  };
  assertPlanValueSize(normalized, "Plan proposal input");
  return normalized;
}

export function planOperationFingerprint(kind: string, input: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson({ kind, input })).digest("hex")}`;
}

export function assertPlanValueSize(value: unknown, label = "Plan event"): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > PLAN_EVENT_MAX_BYTES) {
    throw new PlanConflictError(`${label} exceeds ${PLAN_EVENT_MAX_BYTES} bytes`);
  }
}

export function isPlanStepStatus(value: unknown): value is PlanStepStatus {
  return (
    value === "pending" || value === "in_progress" || value === "completed" || value === "skipped"
  );
}

export function isTerminalPlanStep(status: PlanStepStatus): boolean {
  return status === "completed" || status === "skipped";
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new PlanConflictError(`${label} must not be empty`);
  return normalized;
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function requiredId(value: string, label: string): string {
  const normalized = requiredText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized)) {
    throw new PlanConflictError(`${label} is invalid`);
  }
  return normalized;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
