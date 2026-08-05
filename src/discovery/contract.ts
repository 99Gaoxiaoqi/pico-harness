import { createHash } from "node:crypto";

export type DiscoveryDepth = "quick" | "balanced" | "deep";
export type DiscoveryPhase = "forage" | "focus" | "deepen" | "verify";
export type DiscoveryStatus = "active" | "interrupted" | "completed" | "cancelled";
export type DiscoveryBranchStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";
export type DiscoveryHypothesisStatus = "open" | "supported" | "rejected";

export const DISCOVERY_EVENT_MAX_BYTES = 64 * 1024;
export const DISCOVERY_MAX_CANDIDATES = 20;
export const DISCOVERY_MAX_EVIDENCE_REFS = 50;
export const DISCOVERY_MAX_OPEN_QUESTIONS = 20;

export interface DiscoveryBudgetLimits {
  readonly maxBranches: number;
  readonly maxCycles: number;
  readonly maxToolCalls: number;
  readonly maxFiles: number;
}

export interface DiscoveryBudget extends DiscoveryBudgetLimits {
  readonly consumedToolCalls: number;
  readonly consumedFiles: number;
  readonly reservedToolCalls: number;
  readonly reservedFiles: number;
}

export const DISCOVERY_DEPTH_BUDGETS: Readonly<Record<DiscoveryDepth, DiscoveryBudgetLimits>> =
  Object.freeze({
    quick: Object.freeze({ maxBranches: 1, maxCycles: 1, maxToolCalls: 12, maxFiles: 15 }),
    balanced: Object.freeze({ maxBranches: 2, maxCycles: 2, maxToolCalls: 24, maxFiles: 30 }),
    deep: Object.freeze({ maxBranches: 3, maxCycles: 4, maxToolCalls: 48, maxFiles: 80 }),
  });

export interface DiscoveryCandidate {
  readonly path: string;
  readonly symbol?: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface DiscoveryHypothesis {
  readonly id: string;
  readonly statement: string;
  readonly status: DiscoveryHypothesisStatus;
  readonly evidenceRefs: readonly string[];
}

export interface DiscoveryReport {
  readonly summary: string;
  readonly confirmedTargets: readonly DiscoveryCandidate[];
  readonly evidenceRefs: readonly string[];
  readonly remainingRisks: readonly string[];
}

export interface DiscoveryBranch {
  readonly branchId: string;
  readonly ordinal: number;
  readonly objective: string;
  readonly roots: readonly string[];
  readonly queries: readonly string[];
  readonly stoppingCondition: string;
  readonly status: DiscoveryBranchStatus;
  readonly reservedToolCalls: number;
  readonly reservedFiles: number;
  readonly consumedToolCalls: number;
  readonly inspectedFiles: readonly string[];
  readonly candidates: readonly DiscoveryCandidate[];
  readonly evidenceRefs: readonly string[];
  readonly openQuestions: readonly string[];
  readonly startedAt?: string;
  readonly updatedAt?: string;
  readonly reason?: string;
  readonly report?: DiscoveryReport;
}

export interface DiscoveryCheckpoint {
  readonly phase: DiscoveryPhase;
  readonly cycle: number;
  readonly candidates: readonly DiscoveryCandidate[];
  readonly evidenceRefs: readonly string[];
  readonly hypotheses: readonly DiscoveryHypothesis[];
  readonly openQuestions: readonly string[];
  readonly toolCallsUsed: number;
  readonly inspectedFiles: readonly string[];
}

export interface DiscoveryRun {
  readonly discoveryId: string;
  readonly objective: string;
  readonly depth: DiscoveryDepth;
  readonly roots: readonly string[];
  readonly phase: DiscoveryPhase;
  readonly status: DiscoveryStatus;
  readonly cycle: number;
  readonly budget: DiscoveryBudget;
  readonly branches: readonly DiscoveryBranch[];
  readonly candidates: readonly DiscoveryCandidate[];
  readonly evidenceRefs: readonly string[];
  readonly inspectedFiles: readonly string[];
  readonly hypotheses: readonly DiscoveryHypothesis[];
  readonly openQuestions: readonly string[];
  readonly consecutiveNoInformationGain: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly reason?: string;
  readonly limitReason?: "budget_exhausted" | "no_information_gain";
  readonly report?: DiscoveryReport;
}

export interface DiscoveryProjection {
  readonly sessionId: string;
  readonly sessionSequence: number;
  readonly discoveries: readonly DiscoveryRun[];
  readonly latest?: DiscoveryRun;
  readonly active?: DiscoveryRun;
}

export interface DiscoveryOperationFact {
  readonly operationId: string;
  readonly fingerprint: string;
}

export interface DiscoveryStartInput {
  readonly discoveryId?: string;
  readonly objective: string;
  readonly depth?: DiscoveryDepth;
  readonly roots?: readonly string[];
}

export interface DiscoveryBranchStartInput {
  readonly discoveryId: string;
  readonly branchId: string;
  readonly ordinal: number;
  readonly objective: string;
  readonly roots?: readonly string[];
  readonly queries?: readonly string[];
  readonly stoppingCondition: string;
  readonly reserveToolCalls: number;
  readonly reserveFiles: number;
}

export function discoveryBudget(depth: DiscoveryDepth): DiscoveryBudget {
  return {
    ...DISCOVERY_DEPTH_BUDGETS[depth],
    consumedToolCalls: 0,
    consumedFiles: 0,
    reservedToolCalls: 0,
    reservedFiles: 0,
  };
}

export function normalizeDiscoveryStartInput(input: DiscoveryStartInput): Required<
  Pick<DiscoveryStartInput, "objective" | "depth" | "roots">
> & { readonly discoveryId?: string } {
  const objective = requiredText(input.objective, "Discovery objective");
  const depth = input.depth ?? "balanced";
  if (!isDiscoveryDepth(depth)) throw new DiscoveryConflictError("Discovery depth is invalid");
  const roots = uniqueTexts(input.roots ?? ["."], "Discovery root", 8);
  const normalized = {
    ...(input.discoveryId
      ? { discoveryId: requiredId(input.discoveryId, "Discovery id") }
      : {}),
    objective,
    depth,
    roots,
  };
  assertDiscoveryValueSize(normalized, "Discovery start input");
  return normalized;
}

export function normalizeDiscoveryCandidate(candidate: DiscoveryCandidate): DiscoveryCandidate {
  const normalized: DiscoveryCandidate = {
    path: requiredText(candidate.path, "Discovery candidate path"),
    ...(optionalText(candidate.symbol) ? { symbol: optionalText(candidate.symbol) } : {}),
    score: finiteNumber(candidate.score, "Discovery candidate score"),
    reasons: uniqueTexts(candidate.reasons, "Discovery candidate reason", 20),
    evidenceRefs: uniqueTexts(candidate.evidenceRefs, "Discovery candidate evidence", 20),
  };
  return normalized;
}

export function discoveryOperationFingerprint(kind: string, input: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson({ kind, input })).digest("hex")}`;
}

export function assertDiscoveryValueSize(value: unknown, label = "Discovery event"): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > DISCOVERY_EVENT_MAX_BYTES) {
    throw new DiscoveryConflictError(`${label} exceeds ${DISCOVERY_EVENT_MAX_BYTES} bytes`);
  }
}

export function isDiscoveryDepth(value: unknown): value is DiscoveryDepth {
  return value === "quick" || value === "balanced" || value === "deep";
}

export function isDiscoveryPhase(value: unknown): value is DiscoveryPhase {
  return value === "forage" || value === "focus" || value === "deepen" || value === "verify";
}

export function isDiscoveryBranchStatus(value: unknown): value is DiscoveryBranchStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "partial" ||
    value === "failed" ||
    value === "cancelled"
  );
}

export class DiscoveryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryConflictError";
  }
}

function uniqueTexts(values: readonly string[], label: string, max: number): readonly string[] {
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

export function requiredDiscoveryId(value: string, label: string): string {
  return requiredId(value, label);
}

function requiredId(value: string, label: string): string {
  const normalized = requiredText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized)) {
    throw new DiscoveryConflictError(`${label} is invalid`);
  }
  return normalized;
}

function finiteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new DiscoveryConflictError(`${label} is invalid`);
  return value;
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
