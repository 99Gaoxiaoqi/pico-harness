import type { RuntimeDiscoveryEvent, RuntimeEvent } from "../engine/session-runtime-event.js";
import type { RuntimeEventStoreEntry } from "../storage/runtime-event-store.js";
import {
  DiscoveryConflictError,
  type DiscoveryBranch,
  type DiscoveryCandidate,
  type DiscoveryCheckpoint,
  type DiscoveryHypothesis,
  type DiscoveryProjection,
  type DiscoveryRun,
} from "./contract.js";
import { isDiscoveryEventKind } from "./events.js";

const PHASE_ORDINAL = { forage: 0, focus: 1, deepen: 2, verify: 3 } as const;

export function projectDiscoveryEntries(
  sessionId: string,
  entries: readonly RuntimeEventStoreEntry[],
): DiscoveryProjection {
  const activeEntries = projectActiveBranch(entries);
  let state: DiscoveryProjection = {
    sessionId,
    sessionSequence: entries.at(-1)?.sequence ?? 0,
    discoveries: [],
  };
  for (const entry of activeEntries) {
    if (isDiscoveryEventKind(entry.event.kind)) state = reduceDiscoveryEvent(state, entry.event);
  }
  return state;
}

export function projectActiveDiscoveryEntries(
  entries: readonly RuntimeEventStoreEntry[],
): RuntimeEventStoreEntry[] {
  return projectActiveBranch(entries).filter(({ event }) => isDiscoveryEventKind(event.kind));
}

export function reduceDiscoveryEvent(
  state: DiscoveryProjection,
  event: RuntimeEvent,
): DiscoveryProjection {
  if (!isDiscoveryEventKind(event.kind)) return state;
  const discoveryEvent = event as RuntimeDiscoveryEvent;
  const discoveries = state.discoveries.map(clone);
  if (discoveryEvent.kind === "discovery.started") {
    if (discoveries.some((run) => run.status === "active")) {
      conflict("A Discovery is already active");
    }
    if (discoveries.some((run) => run.discoveryId === discoveryEvent.data.discoveryId)) {
      conflict("Discovery id already exists");
    }
    discoveries.push({
      discoveryId: discoveryEvent.data.discoveryId,
      objective: discoveryEvent.data.objective,
      depth: discoveryEvent.data.depth,
      roots: [...discoveryEvent.data.roots],
      phase: "forage",
      status: "active",
      cycle: 1,
      budget: clone(discoveryEvent.data.budget),
      branches: [],
      candidates: [],
      evidenceRefs: [],
      inspectedFiles: [],
      hypotheses: [],
      openQuestions: [],
      consecutiveNoInformationGain: 0,
      startedAt: discoveryEvent.at,
      updatedAt: discoveryEvent.at,
    });
    return projection(state, discoveries);
  }

  const index = discoveries.findIndex((run) => run.discoveryId === discoveryEvent.data.discoveryId);
  if (index < 0) conflict("Discovery does not exist");
  let run = discoveries[index]!;
  switch (discoveryEvent.kind) {
    case "discovery.checkpointed":
      requireActive(run);
      run = applyCheckpoint(run, discoveryEvent.data.checkpoint, discoveryEvent.at, false);
      break;
    case "discovery.branch.started":
      requireActive(run);
      run = startBranch(run, discoveryEvent.data, discoveryEvent.at);
      break;
    case "discovery.branch.checkpointed":
      requireActive(run);
      run = checkpointBranch(
        run,
        discoveryEvent.data.branchId,
        discoveryEvent.data.checkpoint,
        discoveryEvent.at,
      );
      break;
    case "discovery.branch.completed":
      requireActive(run);
      run = completeBranch(run, discoveryEvent.data, discoveryEvent.at);
      break;
    case "discovery.branch.cancelled":
      requireActive(run);
      run = cancelBranch(
        run,
        discoveryEvent.data.branchId,
        discoveryEvent.data.reason,
        discoveryEvent.at,
      );
      break;
    case "discovery.completed":
      requireActive(run);
      if (run.phase !== "verify") conflict("Discovery must reach verify before completion");
      if (discoveryEvent.data.report.evidenceRefs.length === 0) {
        conflict("Discovery completion requires direct evidence");
      }
      run = {
        ...cancelOpenBranches(run, "Discovery completed", discoveryEvent.at),
        status: "completed",
        report: clone(discoveryEvent.data.report),
        updatedAt: discoveryEvent.at,
      };
      break;
    case "discovery.interrupted":
      requireActive(run);
      run = {
        ...cancelOpenBranches(run, discoveryEvent.data.reason, discoveryEvent.at),
        status: "interrupted",
        reason: discoveryEvent.data.reason,
        ...(discoveryEvent.data.limitReason
          ? { limitReason: discoveryEvent.data.limitReason }
          : {}),
        updatedAt: discoveryEvent.at,
      };
      break;
    case "discovery.resumed": {
      if (run.status !== "interrupted") conflict("Discovery is not interrupted");
      if (
        discoveries.some(
          (candidate, candidateIndex) => candidateIndex !== index && candidate.status === "active",
        )
      ) {
        conflict("Another Discovery is active");
      }
      if (
        discoveryEvent.data.budget.maxToolCalls < run.budget.consumedToolCalls ||
        discoveryEvent.data.budget.maxFiles < run.budget.consumedFiles ||
        discoveryEvent.data.budget.maxCycles < run.cycle
      ) {
        conflict("Resumed Discovery budget is below consumed usage");
      }
      const { reason: _reason, limitReason: _limitReason, ...resumable } = run;
      run = {
        ...resumable,
        depth: discoveryEvent.data.depth,
        budget: {
          ...clone(discoveryEvent.data.budget),
          consumedToolCalls: run.budget.consumedToolCalls,
          consumedFiles: run.budget.consumedFiles,
          reservedToolCalls: 0,
          reservedFiles: 0,
        },
        status: "active",
        branches: run.branches.map((branch) =>
          isOpenBranch(branch)
            ? { ...branch, status: "cancelled", reason: "Interrupted before resume" }
            : branch,
        ),
        consecutiveNoInformationGain: 0,
        updatedAt: discoveryEvent.at,
      };
      break;
    }
    case "discovery.cancelled":
      if (run.status !== "active" && run.status !== "interrupted") {
        conflict("Discovery is not open");
      }
      run = {
        ...cancelOpenBranches(
          run,
          discoveryEvent.data.reason ?? "Discovery cancelled",
          discoveryEvent.at,
        ),
        status: "cancelled",
        ...(discoveryEvent.data.reason ? { reason: discoveryEvent.data.reason } : {}),
        updatedAt: discoveryEvent.at,
      };
      break;
  }
  discoveries[index] = run;
  return projection(state, discoveries);
}

function applyCheckpoint(
  run: DiscoveryRun,
  checkpoint: DiscoveryCheckpoint,
  at: string,
  branchCheckpoint: boolean,
): DiscoveryRun {
  assertPhaseTransition(run, checkpoint);
  const inspectedFiles = unique([...run.inspectedFiles, ...checkpoint.inspectedFiles]);
  const budget = consumeBudget(run, checkpoint.toolCallsUsed, inspectedFiles);
  const candidates = mergeCandidates(run.candidates, checkpoint.candidates);
  const evidenceRefs = unique([...run.evidenceRefs, ...checkpoint.evidenceRefs]);
  const hypotheses = mergeHypotheses(run.hypotheses, checkpoint.hypotheses);
  const openQuestions = unique(checkpoint.openQuestions);
  const informationGain =
    candidates.length > run.candidates.length ||
    evidenceRefs.length > run.evidenceRefs.length ||
    hypothesisDigest(hypotheses) !== hypothesisDigest(run.hypotheses);
  const consecutiveNoInformationGain = branchCheckpoint
    ? run.consecutiveNoInformationGain
    : informationGain
      ? 0
      : run.consecutiveNoInformationGain + 1;
  const limitReason =
    budget.consumedToolCalls >= budget.maxToolCalls || budget.consumedFiles >= budget.maxFiles
      ? "budget_exhausted"
      : consecutiveNoInformationGain >= 2
        ? "no_information_gain"
        : undefined;
  return {
    ...run,
    phase: branchCheckpoint ? run.phase : checkpoint.phase,
    cycle: branchCheckpoint ? run.cycle : checkpoint.cycle,
    budget,
    candidates,
    evidenceRefs,
    inspectedFiles,
    hypotheses,
    openQuestions,
    consecutiveNoInformationGain,
    ...(limitReason ? { limitReason } : {}),
    updatedAt: at,
  };
}

function startBranch(
  run: DiscoveryRun,
  data: Extract<RuntimeDiscoveryEvent, { kind: "discovery.branch.started" }>["data"],
  at: string,
): DiscoveryRun {
  if (run.branches.some((branch) => branch.branchId === data.branchId)) {
    conflict("Discovery branch id already exists");
  }
  if (run.branches.filter(occupiesBranchSlot).length >= run.budget.maxBranches) {
    conflict("Discovery branch limit reached");
  }
  if (
    run.branches.some((branch) => occupiesBranchSlot(branch) && branch.ordinal === data.ordinal)
  ) {
    conflict("Discovery branch ordinal already exists");
  }
  if (
    run.budget.consumedToolCalls + run.budget.reservedToolCalls + data.reserveToolCalls >
      run.budget.maxToolCalls ||
    run.budget.consumedFiles + run.budget.reservedFiles + data.reserveFiles > run.budget.maxFiles
  ) {
    conflict("Discovery branch reservation exceeds shared budget");
  }
  const branch: DiscoveryBranch = {
    branchId: data.branchId,
    ordinal: data.ordinal,
    objective: data.objective,
    roots: [...data.roots],
    queries: [...data.queries],
    stoppingCondition: data.stoppingCondition,
    status: "running",
    reservedToolCalls: data.reserveToolCalls,
    reservedFiles: data.reserveFiles,
    consumedToolCalls: 0,
    inspectedFiles: [],
    candidates: [],
    evidenceRefs: [],
    openQuestions: [],
    startedAt: at,
    updatedAt: at,
  };
  return {
    ...run,
    budget: {
      ...run.budget,
      reservedToolCalls: run.budget.reservedToolCalls + data.reserveToolCalls,
      reservedFiles: run.budget.reservedFiles + data.reserveFiles,
    },
    branches: [...run.branches, branch].sort((left, right) => left.ordinal - right.ordinal),
    updatedAt: at,
  };
}

function checkpointBranch(
  run: DiscoveryRun,
  branchId: string,
  checkpoint: DiscoveryCheckpoint,
  at: string,
): DiscoveryRun {
  const index = branchIndex(run, branchId);
  const branch = run.branches[index]!;
  requireRunningBranch(branch);
  if (
    checkpoint.toolCallsUsed < branch.consumedToolCalls ||
    checkpoint.toolCallsUsed > branch.reservedToolCalls ||
    checkpoint.inspectedFiles.length > branch.reservedFiles ||
    branch.inspectedFiles.some((path) => !checkpoint.inspectedFiles.includes(path))
  ) {
    conflict("Discovery branch usage is invalid");
  }
  const deltaToolCalls = checkpoint.toolCallsUsed - branch.consumedToolCalls;
  const normalizedCheckpoint = {
    ...checkpoint,
    toolCallsUsed: deltaToolCalls,
  };
  const merged = applyCheckpoint(run, normalizedCheckpoint, at, true);
  const branches = merged.branches.map((candidate, candidateIndex) =>
    candidateIndex === index
      ? {
          ...candidate,
          consumedToolCalls: checkpoint.toolCallsUsed,
          inspectedFiles: unique([...candidate.inspectedFiles, ...checkpoint.inspectedFiles]),
          candidates: mergeCandidates(candidate.candidates, checkpoint.candidates),
          evidenceRefs: unique([...candidate.evidenceRefs, ...checkpoint.evidenceRefs]),
          openQuestions: unique(checkpoint.openQuestions),
          updatedAt: at,
        }
      : candidate,
  );
  return { ...merged, branches };
}

function completeBranch(
  run: DiscoveryRun,
  data: Extract<RuntimeDiscoveryEvent, { kind: "discovery.branch.completed" }>["data"],
  at: string,
): DiscoveryRun {
  const index = branchIndex(run, data.branchId);
  const branch = run.branches[index]!;
  requireRunningBranch(branch);
  if (
    data.consumedToolCalls < branch.consumedToolCalls ||
    data.consumedToolCalls > branch.reservedToolCalls ||
    data.inspectedFiles.length > branch.reservedFiles ||
    branch.inspectedFiles.some((path) => !data.inspectedFiles.includes(path))
  ) {
    conflict("Discovery branch terminal usage is invalid");
  }
  const deltaToolCalls = data.consumedToolCalls - branch.consumedToolCalls;
  const inspectedFiles = unique([...run.inspectedFiles, ...data.inspectedFiles]);
  const budget = consumeBudget(run, deltaToolCalls, inspectedFiles);
  const branches = run.branches.map((candidate, candidateIndex) =>
    candidateIndex === index
      ? {
          ...candidate,
          status: data.status,
          consumedToolCalls: data.consumedToolCalls,
          inspectedFiles: unique([...candidate.inspectedFiles, ...data.inspectedFiles]),
          candidates: mergeCandidates(candidate.candidates, data.candidates),
          evidenceRefs: unique([...candidate.evidenceRefs, ...data.evidenceRefs]),
          openQuestions: unique(data.openQuestions),
          ...(data.report ? { report: clone(data.report) } : {}),
          ...(data.reason ? { reason: data.reason } : {}),
          updatedAt: at,
        }
      : candidate,
  ) as DiscoveryBranch[];
  return {
    ...run,
    budget: {
      ...budget,
      reservedToolCalls: budget.reservedToolCalls - branch.reservedToolCalls,
      reservedFiles: budget.reservedFiles - branch.reservedFiles,
    },
    branches,
    candidates: mergeCandidates(run.candidates, data.candidates),
    evidenceRefs: unique([...run.evidenceRefs, ...data.evidenceRefs]),
    inspectedFiles,
    openQuestions: unique([...run.openQuestions, ...data.openQuestions]),
    ...(budget.consumedToolCalls >= budget.maxToolCalls || budget.consumedFiles >= budget.maxFiles
      ? { limitReason: "budget_exhausted" as const }
      : {}),
    updatedAt: at,
  };
}

function cancelBranch(
  run: DiscoveryRun,
  branchId: string,
  reason: string | undefined,
  at: string,
): DiscoveryRun {
  const index = branchIndex(run, branchId);
  const branch = run.branches[index]!;
  requireRunningBranch(branch);
  return {
    ...run,
    budget: {
      ...run.budget,
      reservedToolCalls: run.budget.reservedToolCalls - branch.reservedToolCalls,
      reservedFiles: run.budget.reservedFiles - branch.reservedFiles,
    },
    branches: run.branches.map((candidate, candidateIndex) =>
      candidateIndex === index
        ? {
            ...candidate,
            status: "cancelled",
            ...(reason ? { reason } : {}),
            updatedAt: at,
          }
        : candidate,
    ),
    updatedAt: at,
  };
}

function cancelOpenBranches(run: DiscoveryRun, reason: string, at: string): DiscoveryRun {
  return {
    ...run,
    budget: { ...run.budget, reservedToolCalls: 0, reservedFiles: 0 },
    branches: run.branches.map((branch) =>
      isOpenBranch(branch) ? { ...branch, status: "cancelled", reason, updatedAt: at } : branch,
    ),
  };
}

function consumeBudget(run: DiscoveryRun, toolCalls: number, inspectedFiles: readonly string[]) {
  const consumedToolCalls = run.budget.consumedToolCalls + toolCalls;
  const consumedFiles = inspectedFiles.length;
  if (consumedToolCalls > run.budget.maxToolCalls || consumedFiles > run.budget.maxFiles) {
    conflict("Discovery usage exceeds shared budget");
  }
  return { ...run.budget, consumedToolCalls, consumedFiles };
}

function assertPhaseTransition(run: DiscoveryRun, checkpoint: DiscoveryCheckpoint): void {
  if (checkpoint.cycle === run.cycle) {
    if (PHASE_ORDINAL[checkpoint.phase] < PHASE_ORDINAL[run.phase]) {
      conflict("Discovery phase cannot move backwards within one cycle");
    }
    return;
  }
  if (
    run.phase !== "verify" ||
    checkpoint.phase !== "forage" ||
    checkpoint.cycle !== run.cycle + 1 ||
    checkpoint.cycle > run.budget.maxCycles
  ) {
    conflict("Discovery cycle transition is invalid");
  }
}

function mergeCandidates(
  current: readonly DiscoveryCandidate[],
  additions: readonly DiscoveryCandidate[],
): DiscoveryCandidate[] {
  const candidates = new Map<string, DiscoveryCandidate>();
  for (const candidate of [...current, ...additions]) {
    const key = `${candidate.path}\u0000${candidate.symbol ?? ""}`;
    const existing = candidates.get(key);
    candidates.set(
      key,
      existing
        ? {
            ...existing,
            score: Math.max(existing.score, candidate.score),
            reasons: unique([...existing.reasons, ...candidate.reasons]),
            evidenceRefs: unique([...existing.evidenceRefs, ...candidate.evidenceRefs]),
          }
        : clone(candidate),
    );
  }
  return [...candidates.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.path.localeCompare(right.path) ||
        (left.symbol ?? "").localeCompare(right.symbol ?? ""),
    )
    .slice(0, 20);
}

function mergeHypotheses(
  current: readonly DiscoveryHypothesis[],
  additions: readonly DiscoveryHypothesis[],
): DiscoveryHypothesis[] {
  const hypotheses = new Map(current.map((hypothesis) => [hypothesis.id, clone(hypothesis)]));
  for (const hypothesis of additions) {
    const existing = hypotheses.get(hypothesis.id);
    hypotheses.set(hypothesis.id, {
      ...hypothesis,
      evidenceRefs: unique([...(existing?.evidenceRefs ?? []), ...hypothesis.evidenceRefs]),
    });
  }
  return [...hypotheses.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function hypothesisDigest(hypotheses: readonly DiscoveryHypothesis[]): string {
  return hypotheses
    .map(
      (hypothesis) => `${hypothesis.id}:${hypothesis.status}:${hypothesis.evidenceRefs.join(",")}`,
    )
    .join("|");
}

function projection(
  state: DiscoveryProjection,
  discoveries: readonly DiscoveryRun[],
): DiscoveryProjection {
  const latest = discoveries.at(-1);
  const active = [...discoveries].reverse().find((run) => run.status === "active");
  return {
    sessionId: state.sessionId,
    sessionSequence: state.sessionSequence,
    discoveries,
    ...(latest ? { latest } : {}),
    ...(active ? { active } : {}),
  };
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

function branchIndex(run: DiscoveryRun, branchId: string): number {
  const index = run.branches.findIndex((branch) => branch.branchId === branchId);
  if (index < 0) conflict("Discovery branch does not exist");
  return index;
}

function requireActive(run: DiscoveryRun): void {
  if (run.status !== "active") conflict("Discovery is not active");
}

function requireRunningBranch(branch: DiscoveryBranch): void {
  if (branch.status !== "running") conflict("Discovery branch is not running");
}

function isOpenBranch(branch: DiscoveryBranch): boolean {
  return branch.status === "queued" || branch.status === "running";
}

function occupiesBranchSlot(branch: DiscoveryBranch): boolean {
  return branch.status !== "cancelled";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function conflict(message: string): never {
  throw new DiscoveryConflictError(message);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
