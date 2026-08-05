import { createHash } from "node:crypto";
import {
  DISCOVERY_DEPTH_BUDGETS,
  DiscoveryConflictError,
  requiredDiscoveryId,
  type DiscoveryBranchStatus,
  type DiscoveryCheckpoint,
  type DiscoveryDepth,
  type DiscoveryProjection,
  type DiscoveryReport,
} from "./contract.js";
import type { DiscoveryCoordinator } from "./coordinator.js";

export type DiscoveryBranchStrategy = "entry_path" | "symbol_reference" | "boundary_verification";

export interface DiscoveryBranchPlan {
  readonly objective?: string;
  readonly roots?: readonly string[];
  readonly queries?: readonly string[];
  readonly stoppingCondition?: string;
}

export interface DiscoveryWorkerBudget {
  readonly maxToolCalls: number;
  readonly maxFiles: number;
}

export interface DiscoveryWorkerInput {
  readonly discoveryId: string;
  readonly branchId: string;
  readonly ordinal: number;
  readonly strategy: DiscoveryBranchStrategy;
  readonly objective: string;
  readonly roots: readonly string[];
  readonly queries: readonly string[];
  readonly stoppingCondition: string;
  readonly budget: DiscoveryWorkerBudget;
  readonly signal: AbortSignal;
}

export interface DiscoveryWorkerResult {
  readonly status: Extract<DiscoveryBranchStatus, "completed" | "partial" | "failed">;
  readonly checkpoint: DiscoveryCheckpoint;
  readonly report?: DiscoveryReport;
  readonly reason?: string;
  /** The branch has enough direct evidence; sibling results must no longer be committed. */
  readonly stop?: boolean;
}

export type DiscoveryWorker = (input: DiscoveryWorkerInput) => Promise<DiscoveryWorkerResult>;

export interface DiscoveryOrchestrationInput {
  readonly coordinator: DiscoveryCoordinator;
  /** Stable caller-owned idempotency namespace for the whole orchestration. */
  readonly operationId: string;
  readonly discoveryId?: string;
  readonly objective: string;
  readonly depth: DiscoveryDepth;
  readonly roots?: readonly string[];
  readonly queries?: readonly string[];
  /** Optional ordinal overrides; its length must match the selected depth preset. */
  readonly branches?: readonly DiscoveryBranchPlan[];
  readonly worker: DiscoveryWorker;
  readonly signal?: AbortSignal;
}

export interface DiscoveryOrchestrationResult {
  readonly discoveryId: string;
  readonly projection: DiscoveryProjection;
  readonly stoppedEarly: boolean;
  readonly cancelled: boolean;
}

interface PreparedBranch {
  readonly branchId: string;
  readonly ordinal: number;
  readonly strategy: DiscoveryBranchStrategy;
  readonly objective: string;
  readonly roots: readonly string[];
  readonly queries: readonly string[];
  readonly stoppingCondition: string;
  readonly budget: DiscoveryWorkerBudget;
  readonly controller: AbortController;
}

interface WorkerSuccess {
  readonly kind: "result";
  readonly branch: PreparedBranch;
  readonly result: DiscoveryWorkerResult;
}

interface WorkerFailure {
  readonly kind: "error";
  readonly branch: PreparedBranch;
  readonly error: unknown;
}

type WorkerSettlement = WorkerSuccess | WorkerFailure;

const BRANCH_PRESETS: readonly {
  readonly strategy: DiscoveryBranchStrategy;
  readonly objectiveSuffix: string;
  readonly stoppingCondition: string;
}[] = [
  {
    strategy: "entry_path",
    objectiveSuffix: "从入口和调用路径定位所有者",
    stoppingCondition: "找到入口到实现的直接调用证据，或证明该路径不成立",
  },
  {
    strategy: "symbol_reference",
    objectiveSuffix: "按符号定义与引用交叉定位",
    stoppingCondition: "找到定义、关键引用和对应源码证据，或证明候选不成立",
  },
  {
    strategy: "boundary_verification",
    objectiveSuffix: "从测试、配置与边界适配反向核验",
    stoppingCondition: "找到可核验目标归属的边界证据，或排除该验证路径",
  },
];

/**
 * Start the preset Discovery branches, run workers concurrently, and durably fold their facts
 * through one Coordinator-owned writer. Workers never receive the writer capability.
 */
export async function orchestrateDiscovery(
  input: DiscoveryOrchestrationInput,
): Promise<DiscoveryOrchestrationResult> {
  const operationNamespace = operationIdNamespace(input.operationId);
  if (input.signal?.aborted) throw abortReason(input.signal);

  let externallyCancelled = false;
  let resolveCancellation: (() => void) | undefined;
  const cancellation = new Promise<{ readonly kind: "cancel" }>((resolve) => {
    resolveCancellation = () => resolve({ kind: "cancel" });
  });
  const controllers = new Set<AbortController>();
  const cancelWorkers = () => {
    externallyCancelled = true;
    resolveCancellation?.();
    const reason = input.signal ? abortReason(input.signal) : new Error("Discovery cancelled");
    for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  };
  input.signal?.addEventListener("abort", cancelWorkers, { once: true });

  let discoveryId: string | undefined;
  try {
    let projection = await input.coordinator.start({
      operationId: operationId(operationNamespace, "start"),
      ...(input.discoveryId ? { discoveryId: input.discoveryId } : {}),
      objective: input.objective,
      depth: input.depth,
      roots: input.roots,
    });
    const run = projection.active;
    if (!run) throw new DiscoveryConflictError("Discovery orchestration is no longer active");
    discoveryId = run.discoveryId;
    const activeDiscoveryId = run.discoveryId;

    const prepared = prepareBranches(input, activeDiscoveryId, run.objective, run.roots);
    for (const branch of prepared) {
      controllers.add(branch.controller);
      if (externallyCancelled) break;
      const existing = projection.active?.branches.find(
        (candidate) => candidate.branchId === branch.branchId,
      );
      if (existing) {
        assertExistingBranch(existing, branch);
        continue;
      }
      projection = await input.coordinator.startBranch({
        operationId: operationId(operationNamespace, `branch-${number(branch.ordinal)}-start`),
        discoveryId: activeDiscoveryId,
        branchId: branch.branchId,
        ordinal: branch.ordinal,
        objective: branch.objective,
        roots: branch.roots,
        queries: branch.queries,
        stoppingCondition: branch.stoppingCondition,
        reserveToolCalls: branch.budget.maxToolCalls,
        reserveFiles: branch.budget.maxFiles,
      });
    }

    if (externallyCancelled) {
      projection = await persistCancellation(
        input.coordinator,
        operationNamespace,
        activeDiscoveryId,
      );
      return { discoveryId: activeDiscoveryId, projection, stoppedEarly: false, cancelled: true };
    }

    const runnable = prepared.filter((branch) =>
      projection.active?.branches.some(
        (candidate) => candidate.branchId === branch.branchId && candidate.status === "running",
      ),
    );
    const settlements = runnable.map((branch) =>
      Promise.resolve()
        .then(() =>
          input.worker({
            discoveryId: activeDiscoveryId,
            branchId: branch.branchId,
            ordinal: branch.ordinal,
            strategy: branch.strategy,
            objective: branch.objective,
            roots: branch.roots,
            queries: branch.queries,
            stoppingCondition: branch.stoppingCondition,
            budget: branch.budget,
            signal: branch.controller.signal,
          }),
        )
        .then(
          (result): WorkerSettlement => ({ kind: "result", branch, result }),
          (error: unknown): WorkerSettlement => ({ kind: "error", branch, error }),
        ),
    );
    const pending = new Map(
      runnable.map((branch, index) => [branch.branchId, settlements[index]!]),
    );
    let stoppedEarly = false;

    while (pending.size > 0) {
      const settlement = await Promise.race([...pending.values(), cancellation]);
      if (settlement.kind === "cancel") {
        projection = await persistCancellation(
          input.coordinator,
          operationNamespace,
          activeDiscoveryId,
        );
        return {
          discoveryId: activeDiscoveryId,
          projection,
          stoppedEarly: false,
          cancelled: true,
        };
      }
      pending.delete(settlement.branch.branchId);
      if (externallyCancelled) {
        projection = await persistCancellation(
          input.coordinator,
          operationNamespace,
          activeDiscoveryId,
        );
        return {
          discoveryId: activeDiscoveryId,
          projection,
          stoppedEarly: false,
          cancelled: true,
        };
      }

      projection =
        settlement.kind === "result"
          ? await persistWorkerResult(
              input.coordinator,
              operationNamespace,
              activeDiscoveryId,
              settlement.branch,
              settlement.result,
            )
          : await persistWorkerFailure(
              input.coordinator,
              operationNamespace,
              activeDiscoveryId,
              settlement.branch,
              settlement.error,
            );

      if (externallyCancelled) {
        projection = await persistCancellation(
          input.coordinator,
          operationNamespace,
          activeDiscoveryId,
        );
        return {
          discoveryId: activeDiscoveryId,
          projection,
          stoppedEarly: false,
          cancelled: true,
        };
      }

      const discoveryStillActive = projection.active?.discoveryId === activeDiscoveryId;
      if (!discoveryStillActive || (settlement.kind === "result" && settlement.result.stop)) {
        stoppedEarly = pending.size > 0;
        for (const branch of runnable) {
          if (pending.has(branch.branchId) && !branch.controller.signal.aborted) {
            branch.controller.abort(new Error("Discovery stopped after sufficient evidence"));
          }
        }
        if (discoveryStillActive) {
          projection = await cancelRunningBranches(
            input.coordinator,
            operationNamespace,
            activeDiscoveryId,
            "Discovery stopped after sufficient evidence",
          );
        }
        break;
      }
    }

    return { discoveryId: activeDiscoveryId, projection, stoppedEarly, cancelled: false };
  } catch (error) {
    for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort(error);
    }
    if (discoveryId) {
      await interruptAfterFailure(input.coordinator, operationNamespace, discoveryId, error);
    }
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", cancelWorkers);
  }
}

function prepareBranches(
  input: DiscoveryOrchestrationInput,
  discoveryId: string,
  objective: string,
  roots: readonly string[],
): PreparedBranch[] {
  const limits = DISCOVERY_DEPTH_BUDGETS[input.depth];
  if (input.branches && input.branches.length !== limits.maxBranches) {
    throw new DiscoveryConflictError(
      `Discovery ${input.depth} orchestration requires ${limits.maxBranches} branch plans`,
    );
  }
  return BRANCH_PRESETS.slice(0, limits.maxBranches).map((preset, ordinal) => {
    const override = input.branches?.[ordinal];
    return {
      branchId: stableBranchId(discoveryId, ordinal),
      ordinal,
      strategy: preset.strategy,
      objective: requiredText(
        override?.objective ?? `${objective}；${preset.objectiveSuffix}`,
        "Discovery branch objective",
      ),
      roots: uniqueTexts(override?.roots ?? roots, "Discovery branch root"),
      queries: uniqueTexts(override?.queries ?? input.queries ?? [], "Discovery branch query"),
      stoppingCondition: requiredText(
        override?.stoppingCondition ?? preset.stoppingCondition,
        "Discovery branch stopping condition",
      ),
      budget: {
        maxToolCalls: allocation(limits.maxToolCalls, limits.maxBranches, ordinal),
        maxFiles: allocation(limits.maxFiles, limits.maxBranches, ordinal),
      },
      controller: new AbortController(),
    };
  });
}

async function persistWorkerResult(
  coordinator: DiscoveryCoordinator,
  operationNamespace: string,
  discoveryId: string,
  branch: PreparedBranch,
  result: DiscoveryWorkerResult,
): Promise<DiscoveryProjection> {
  let projection = await coordinator.project();
  const current = projection.active?.branches.find(
    (candidate) => candidate.branchId === branch.branchId,
  );
  if (!current || current.status !== "running") return projection;

  if (!wouldExhaustSharedBudget(projection, current.consumedToolCalls, result.checkpoint)) {
    projection = await coordinator.checkpointBranch({
      operationId: operationId(operationNamespace, `branch-${number(branch.ordinal)}-checkpoint`),
      discoveryId,
      branchId: branch.branchId,
      checkpoint: result.checkpoint,
    });
  }
  if (projection.active?.discoveryId !== discoveryId) return projection;
  return coordinator.completeBranch({
    operationId: operationId(operationNamespace, `branch-${number(branch.ordinal)}-complete`),
    discoveryId,
    branchId: branch.branchId,
    status: result.status,
    consumedToolCalls: result.checkpoint.toolCallsUsed,
    inspectedFiles: result.checkpoint.inspectedFiles,
    candidates: result.checkpoint.candidates,
    evidenceRefs: result.checkpoint.evidenceRefs,
    openQuestions: result.checkpoint.openQuestions,
    report: result.report,
    reason: result.reason,
  });
}

async function persistWorkerFailure(
  coordinator: DiscoveryCoordinator,
  operationNamespace: string,
  discoveryId: string,
  branch: PreparedBranch,
  error: unknown,
): Promise<DiscoveryProjection> {
  const projection = await coordinator.project();
  const current = projection.active?.branches.find(
    (candidate) => candidate.branchId === branch.branchId,
  );
  if (!current || current.status !== "running") return projection;
  return coordinator.completeBranch({
    operationId: operationId(operationNamespace, `branch-${number(branch.ordinal)}-complete`),
    discoveryId,
    branchId: branch.branchId,
    status: "failed",
    consumedToolCalls: current.consumedToolCalls,
    inspectedFiles: current.inspectedFiles,
    reason: errorMessage(error),
  });
}

async function persistCancellation(
  coordinator: DiscoveryCoordinator,
  operationNamespace: string,
  discoveryId: string,
): Promise<DiscoveryProjection> {
  let projection = await cancelRunningBranches(
    coordinator,
    operationNamespace,
    discoveryId,
    "Discovery orchestration cancelled",
  );
  const run = projection.discoveries.find((candidate) => candidate.discoveryId === discoveryId);
  if (run?.status === "active" || run?.status === "interrupted") {
    projection = await coordinator.cancel({
      operationId: operationId(operationNamespace, "cancel"),
      discoveryId,
      reason: "Discovery orchestration cancelled",
    });
  }
  return projection;
}

async function cancelRunningBranches(
  coordinator: DiscoveryCoordinator,
  operationNamespace: string,
  discoveryId: string,
  reason: string,
): Promise<DiscoveryProjection> {
  let projection = await coordinator.project();
  const running = projection.discoveries
    .find((candidate) => candidate.discoveryId === discoveryId)
    ?.branches.filter((branch) => branch.status === "running");
  for (const branch of running ?? []) {
    if (projection.active?.discoveryId !== discoveryId) break;
    projection = await coordinator.cancelBranch({
      operationId: operationId(operationNamespace, `branch-${number(branch.ordinal)}-cancel`),
      discoveryId,
      branchId: branch.branchId,
      reason,
    });
  }
  return projection;
}

async function interruptAfterFailure(
  coordinator: DiscoveryCoordinator,
  operationNamespace: string,
  discoveryId: string,
  error: unknown,
): Promise<void> {
  try {
    await cancelRunningBranches(
      coordinator,
      operationNamespace,
      discoveryId,
      "Discovery orchestration failed",
    );
    const projection = await coordinator.project();
    if (projection.active?.discoveryId === discoveryId) {
      await coordinator.interrupt({
        operationId: operationId(operationNamespace, "interrupt"),
        discoveryId,
        reason: `Discovery orchestration failed: ${errorMessage(error)}`,
      });
    }
  } catch {
    // Preserve the first error; Coordinator/CAS failures remain observable in the event log.
  }
}

function wouldExhaustSharedBudget(
  projection: DiscoveryProjection,
  alreadyConsumedByBranch: number,
  checkpoint: DiscoveryCheckpoint,
): boolean {
  const run = projection.active;
  if (!run) return true;
  const toolCalls =
    run.budget.consumedToolCalls + checkpoint.toolCallsUsed - alreadyConsumedByBranch;
  const files = new Set([...run.inspectedFiles, ...checkpoint.inspectedFiles]).size;
  return toolCalls >= run.budget.maxToolCalls || files >= run.budget.maxFiles;
}

function assertExistingBranch(
  existing: {
    readonly ordinal: number;
    readonly objective: string;
    readonly roots: readonly string[];
    readonly queries: readonly string[];
    readonly stoppingCondition: string;
    readonly reservedToolCalls: number;
    readonly reservedFiles: number;
  },
  expected: PreparedBranch,
): void {
  if (
    existing.ordinal !== expected.ordinal ||
    existing.objective !== expected.objective ||
    !sameList(existing.roots, expected.roots) ||
    !sameList(existing.queries, expected.queries) ||
    existing.stoppingCondition !== expected.stoppingCondition ||
    existing.reservedToolCalls !== expected.budget.maxToolCalls ||
    existing.reservedFiles !== expected.budget.maxFiles
  ) {
    throw new DiscoveryConflictError(`Discovery branch ${expected.branchId} conflicts`);
  }
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueTexts(values: readonly string[], label: string): string[] {
  return [...new Set(values.map((value) => requiredText(value, label)))];
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DiscoveryConflictError(`${label} must not be empty`);
  return normalized;
}

function allocation(total: number, branches: number, ordinal: number): number {
  return Math.floor(total / branches) + (ordinal < total % branches ? 1 : 0);
}

function stableBranchId(discoveryId: string, ordinal: number): string {
  const suffix = `branch:${number(ordinal)}`;
  const candidate = `${discoveryId}:${suffix}`;
  if (candidate.length <= 128) return candidate;
  return `discovery:${createHash("sha256").update(discoveryId).digest("hex")}:${suffix}`;
}

function operationIdNamespace(value: string): string {
  const normalized = requiredDiscoveryId(value, "Discovery orchestration operation id");
  if (normalized.length <= 80) return normalized;
  return `orchestrator:${createHash("sha256").update(normalized).digest("hex")}`;
}

function operationId(namespace: string, suffix: string): string {
  return `${namespace}:${suffix}`;
}

function number(ordinal: number): string {
  return String(ordinal + 1).padStart(2, "0");
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 1_000) || "Discovery worker failed";
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Discovery orchestration aborted", "AbortError");
}
