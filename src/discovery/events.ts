import {
  DISCOVERY_EVENT_MAX_BYTES,
  DISCOVERY_MAX_CANDIDATES,
  DISCOVERY_MAX_EVIDENCE_REFS,
  isDiscoveryBranchStatus,
  isDiscoveryDepth,
  isDiscoveryPhase,
  type DiscoveryCandidate,
  type DiscoveryCheckpoint,
  type DiscoveryReport,
} from "./contract.js";

export const DISCOVERY_EVENT_KINDS = [
  "discovery.started",
  "discovery.checkpointed",
  "discovery.branch.started",
  "discovery.branch.checkpointed",
  "discovery.branch.completed",
  "discovery.branch.cancelled",
  "discovery.completed",
  "discovery.interrupted",
  "discovery.resumed",
  "discovery.cancelled",
] as const;

export type DiscoveryEventKind = (typeof DISCOVERY_EVENT_KINDS)[number];

export function isDiscoveryEventKind(value: unknown): value is DiscoveryEventKind {
  return typeof value === "string" && (DISCOVERY_EVENT_KINDS as readonly string[]).includes(value);
}

export function assertDiscoveryEventData(kind: DiscoveryEventKind, data: unknown): void {
  if (!isRecord(data)) throw new Error("Discovery event data must be an object");
  assertId(data.operationId, "operationId");
  if (typeof data.fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(data.fingerprint)) {
    throw new Error("Discovery event fingerprint is invalid");
  }
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > DISCOVERY_EVENT_MAX_BYTES) {
    throw new Error(`Discovery event exceeds ${DISCOVERY_EVENT_MAX_BYTES} bytes`);
  }
  if (kind === "discovery.started") {
    assertId(data.discoveryId, "discoveryId");
    assertText(data.objective, "objective");
    if (!isDiscoveryDepth(data.depth)) throw new Error("Discovery depth is invalid");
    assertTextArray(data.roots, "roots", 8);
    assertBudget(data.budget);
    return;
  }
  assertId(data.discoveryId, "discoveryId");
  if (kind === "discovery.checkpointed") {
    assertCheckpoint(data.checkpoint);
    return;
  }
  if (kind === "discovery.branch.started") {
    assertId(data.branchId, "branchId");
    assertPositiveInteger(data.ordinal, "ordinal", true);
    assertText(data.objective, "objective");
    assertTextArray(data.roots, "roots", 8);
    assertTextArray(data.queries, "queries", 16);
    assertText(data.stoppingCondition, "stoppingCondition");
    assertPositiveInteger(data.reserveToolCalls, "reserveToolCalls");
    assertPositiveInteger(data.reserveFiles, "reserveFiles");
    return;
  }
  if (kind === "discovery.branch.checkpointed") {
    assertId(data.branchId, "branchId");
    assertCheckpoint(data.checkpoint);
    return;
  }
  if (kind === "discovery.branch.completed") {
    assertId(data.branchId, "branchId");
    if (
      !isDiscoveryBranchStatus(data.status) ||
      !["completed", "partial", "failed"].includes(data.status)
    ) {
      throw new Error("Discovery branch terminal status is invalid");
    }
    assertNonNegativeInteger(data.consumedToolCalls, "consumedToolCalls");
    assertTextArray(data.inspectedFiles, "inspectedFiles", 80);
    assertCandidates(data.candidates);
    assertTextArray(data.evidenceRefs, "evidenceRefs", DISCOVERY_MAX_EVIDENCE_REFS);
    assertTextArray(data.openQuestions, "openQuestions", 20);
    if (data.report !== undefined) assertReport(data.report);
    if (data.reason !== undefined) assertText(data.reason, "reason");
    return;
  }
  if (kind === "discovery.branch.cancelled") {
    assertId(data.branchId, "branchId");
    if (data.reason !== undefined) assertText(data.reason, "reason");
    return;
  }
  if (kind === "discovery.completed") {
    assertReport(data.report);
    return;
  }
  if (kind === "discovery.interrupted") {
    assertText(data.reason, "reason");
    if (
      data.limitReason !== undefined &&
      data.limitReason !== "budget_exhausted" &&
      data.limitReason !== "no_information_gain"
    ) {
      throw new Error("Discovery limit reason is invalid");
    }
    return;
  }
  if (kind === "discovery.resumed") {
    if (!isDiscoveryDepth(data.depth)) throw new Error("Discovery depth is invalid");
    assertBudget(data.budget);
    return;
  }
  if (kind === "discovery.cancelled" && data.reason !== undefined) {
    assertText(data.reason, "reason");
  }
}

function assertCheckpoint(value: unknown): asserts value is DiscoveryCheckpoint {
  if (!isRecord(value)) throw new Error("Discovery checkpoint is invalid");
  if (!isDiscoveryPhase(value.phase)) throw new Error("Discovery checkpoint phase is invalid");
  assertPositiveInteger(value.cycle, "cycle");
  assertCandidates(value.candidates);
  assertTextArray(value.evidenceRefs, "evidenceRefs", DISCOVERY_MAX_EVIDENCE_REFS);
  if (!Array.isArray(value.hypotheses) || value.hypotheses.length > 20) {
    throw new Error("Discovery hypotheses are invalid");
  }
  for (const hypothesis of value.hypotheses) {
    if (!isRecord(hypothesis)) throw new Error("Discovery hypothesis is invalid");
    assertId(hypothesis.id, "hypothesisId");
    assertText(hypothesis.statement, "hypothesis");
    if (
      hypothesis.status !== "open" &&
      hypothesis.status !== "supported" &&
      hypothesis.status !== "rejected"
    ) {
      throw new Error("Discovery hypothesis status is invalid");
    }
    assertTextArray(hypothesis.evidenceRefs, "hypothesis evidence", 20);
  }
  assertTextArray(value.openQuestions, "openQuestions", 20);
  assertNonNegativeInteger(value.toolCallsUsed, "toolCallsUsed");
  assertTextArray(value.inspectedFiles, "inspectedFiles", 80);
}

function assertCandidates(value: unknown): asserts value is readonly DiscoveryCandidate[] {
  if (!Array.isArray(value) || value.length > DISCOVERY_MAX_CANDIDATES) {
    throw new Error("Discovery candidates are invalid");
  }
  for (const candidate of value) {
    if (!isRecord(candidate)) throw new Error("Discovery candidate is invalid");
    assertText(candidate.path, "candidate path");
    if (candidate.symbol !== undefined) assertText(candidate.symbol, "candidate symbol");
    if (typeof candidate.score !== "number" || !Number.isFinite(candidate.score)) {
      throw new Error("Discovery candidate score is invalid");
    }
    assertTextArray(candidate.reasons, "candidate reasons", 20);
    assertTextArray(candidate.evidenceRefs, "candidate evidence", 20);
  }
}

function assertReport(value: unknown): asserts value is DiscoveryReport {
  if (!isRecord(value)) throw new Error("Discovery report is invalid");
  assertText(value.summary, "summary");
  assertCandidates(value.confirmedTargets);
  assertTextArray(value.evidenceRefs, "report evidence", DISCOVERY_MAX_EVIDENCE_REFS);
  assertTextArray(value.remainingRisks, "remainingRisks", 20);
}

function assertBudget(value: unknown): void {
  if (!isRecord(value)) throw new Error("Discovery budget is invalid");
  for (const key of ["maxBranches", "maxCycles", "maxToolCalls", "maxFiles"]) {
    assertPositiveInteger(value[key], key);
  }
  for (const key of ["consumedToolCalls", "consumedFiles", "reservedToolCalls", "reservedFiles"]) {
    assertNonNegativeInteger(value[key], key);
  }
}

function assertTextArray(value: unknown, label: string, max: number): void {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} is invalid`);
  for (const item of value) assertText(item, label);
}

function assertPositiveInteger(value: unknown, name: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    throw new Error(`${name} is invalid`);
  }
}

function assertNonNegativeInteger(value: unknown, name: string): void {
  assertPositiveInteger(value, name, true);
}

function assertText(value: unknown, name: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is invalid`);
}

function assertId(value: unknown, name: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
