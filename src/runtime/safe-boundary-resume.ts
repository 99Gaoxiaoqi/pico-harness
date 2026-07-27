import { createHash } from "node:crypto";
import { canonicalizeWorkspacePath } from "../paths/pico-paths.js";
import {
  deriveRecoverableTaskRuntimeLaunchIdentity,
  prepareRecoverableTaskInput,
  validateRecoverableTaskLaunchReceipt,
  type RecoverableTaskAdapter,
  type RecoverableTaskRegistry,
} from "../tasks/recoverable-task.js";
import {
  TASK_RUN_EVENT_SCHEMA_VERSION,
  type RecoverableTaskLaunchReceipt,
  type TaskAttemptExecutionClaimedEvent,
  type TaskAttemptExecutionRenewedEvent,
  type TaskAttemptExecutionReleasedEvent,
  type TaskAttemptFinishedEvent,
  type TaskAttemptLaunchClaimedEvent,
  type TaskAttemptLaunchFailedEvent,
  type TaskAttemptLaunchSucceededEvent,
  type TaskAttemptProjection,
  type TaskAttemptStartedEvent,
  type TaskResumeClaimedEvent,
  type TaskResumeDiagnostic,
  type TaskResumeParkReason,
  type TaskResumePlan,
  type TaskRunEvent,
  type TaskRunParkedEvent,
  type TaskRunProjection,
  type TaskRuntimeBoundary,
} from "../tasks/task-run-contract.js";
import type { JobExecutionClass } from "../tasks/runtime-types.js";

export type RuntimeBoundaryInspection =
  | {
      readonly status: "session_missing";
      readonly sessionId: string;
    }
  | {
      readonly status: "run_missing";
      readonly sessionId: string;
      readonly runId: string;
    }
  | {
      readonly status: "available";
      readonly sessionId: string;
      readonly runId: string;
      readonly sessionWorkspacePath: string;
      readonly runWorkspacePath: string;
      readonly eventHighWater: number;
      readonly sourceRunLastSequence: number;
      readonly terminalSequence?: number;
      readonly terminal?: {
        readonly eventId: string;
        readonly status: "completed" | "failed" | "cancelled" | "interrupted";
      };
      readonly pendingApprovalIds: readonly string[];
      readonly pendingToolCallIds: readonly string[];
      readonly backgroundOperationsSettled: boolean;
      readonly toolCatalogHash?: string;
      readonly availableCheckpointRefs: readonly string[];
    };

export interface RuntimeBoundaryInspector {
  inspect(boundary: TaskRuntimeBoundary): Promise<RuntimeBoundaryInspection>;
  reconcileLaunch(
    source: TaskRuntimeBoundary,
    expected: RuntimeLaunchExpectation,
  ): Promise<RuntimeLaunchReconciliation>;
}

export interface RuntimeLaunchExpectation {
  readonly launchId: string;
  readonly runId: string;
  readonly runStartedEventId: string;
}

export type RuntimeLaunchReconciliation =
  | {
      readonly status: "not_started";
    }
  | {
      readonly status: "verified";
      readonly sessionWorkspacePath: string;
      readonly runWorkspacePath: string;
      readonly currentEventHighWater: number;
      readonly receipt: RecoverableTaskLaunchReceipt;
    }
  | {
      readonly status: "mismatch";
      readonly reason:
        | "runtime_session_missing"
        | "runtime_run_missing"
        | "runtime_high_water_mismatch"
        | "workspace_path_mismatch"
        | "ledger_corrupt";
      readonly message: string;
      readonly detail?: Readonly<Record<string, unknown>>;
    };

export interface TaskResumeLedgerAppendInput {
  readonly taskRunId: string;
  readonly expectedRevision: number;
  readonly transactionId: string;
  readonly events: readonly TaskRunEvent[];
}

export type TaskResumeLedgerAppendResult =
  | {
      readonly status: "committed";
      readonly projection: TaskRunProjection;
    }
  | {
      readonly status: "conflict";
      readonly projection: TaskRunProjection;
    };

/**
 * The concrete TaskRun store must implement appendBatch as one revision-checked
 * atomic transaction. A conflict must return the current projection without
 * partially applying the supplied events.
 */
export interface TaskResumeLedger {
  readProjection(taskRunId: string): Promise<TaskRunProjection | undefined>;
  appendBatch(input: TaskResumeLedgerAppendInput): Promise<TaskResumeLedgerAppendResult>;
}

export interface SafeBoundaryResumeEnvironment {
  readonly storageRootId: string;
  readonly workspacePath: string;
}

interface TaskResumeEvaluationOptions {
  readonly sourceAttemptId?: string;
  readonly creatingSuccessor?: boolean;
  readonly verifiedLaunch?: Extract<RuntimeLaunchReconciliation, { status: "verified" }>;
}

interface PreparedTaskResume {
  readonly plan: Extract<TaskResumePlan, { disposition: "continue" }>;
  readonly source: TaskAttemptProjection;
  readonly adapter: RecoverableTaskAdapter;
  readonly input: Readonly<Record<string, unknown>>;
}

type TaskResumeEvaluation =
  | PreparedTaskResume
  | {
      readonly plan: Extract<TaskResumePlan, { disposition: "park" }>;
    };

export class SafeBoundaryResumePlanner {
  constructor(
    private readonly registry: RecoverableTaskRegistry,
    private readonly runtime: RuntimeBoundaryInspector,
    private readonly environment: SafeBoundaryResumeEnvironment,
  ) {
    if (!environment.storageRootId.trim()) {
      throw new Error("Safe-boundary storageRootId must not be empty");
    }
    if (!environment.workspacePath.trim()) {
      throw new Error("Safe-boundary workspacePath must not be empty");
    }
  }

  async plan(projection: TaskRunProjection): Promise<TaskResumePlan> {
    return (await this.evaluate(projection)).plan;
  }

  async evaluate(
    projection: TaskRunProjection,
    options: TaskResumeEvaluationOptions = {},
  ): Promise<TaskResumeEvaluation> {
    const diagnostics: TaskResumeDiagnostic[] = [];
    const add = (
      reason: TaskResumeParkReason,
      message: string,
      detail?: Readonly<Record<string, unknown>>,
    ): void => {
      if (diagnostics.some((entry) => entry.reason === reason)) return;
      diagnostics.push({ reason, message, ...(detail ? { detail } : {}) });
    };
    const { header } = projection;

    if (projection.terminal) {
      return terminalTaskPlan(projection);
    }

    const source = options.sourceAttemptId
      ? projection.attempts.find((attempt) => attempt.attemptId === options.sourceAttemptId)
      : latestAttempt(projection.attempts);
    if (!source) {
      add("source_attempt_missing", `TaskRun ${header.taskRunId} has no source Attempt`);
      return parkPlan(header.taskRunId, diagnostics);
    }
    if (source.status !== "interrupted") {
      add(
        "source_attempt_not_interrupted",
        `Attempt ${source.attemptId} is ${source.status}, not interrupted`,
        { status: source.status },
      );
    }
    if (options.creatingSuccessor !== false && projection.attempts.length >= header.maxAttempts) {
      add("max_attempts_exhausted", `TaskRun ${header.taskRunId} exhausted maxAttempts`, {
        attempts: projection.attempts.length,
        maxAttempts: header.maxAttempts,
      });
    }

    const resolution = this.registry.resolve(header.adapter.id, header.adapter.version);
    let adapter: RecoverableTaskAdapter | undefined;
    let input: Readonly<Record<string, unknown>> | undefined;
    if (resolution.status === "missing") {
      add("adapter_missing", `Adapter ${header.adapter.id} is not registered`);
    } else if (resolution.status === "version_mismatch") {
      add(
        "adapter_version_mismatch",
        `Adapter ${header.adapter.id}@${header.adapter.version} is not registered`,
        { availableVersions: resolution.availableVersions },
      );
    } else {
      adapter = resolution.adapter;
      try {
        input = prepareRecoverableTaskInput(header.adapter, adapter);
      } catch (error) {
        add("ledger_corrupt", `TaskRun ${header.taskRunId} has invalid immutable adapter input`, {
          error: errorMessage(error),
        });
      }
    }

    const currentWorkspacePath = comparablePath(this.environment.workspacePath);
    const taskRunWorkspacePath = comparablePath(header.workDir);
    if (header.storageRootId !== this.environment.storageRootId) {
      add("storage_root_mismatch", `TaskRun ${header.taskRunId} belongs to another storage root`, {
        expected: header.storageRootId,
        actual: this.environment.storageRootId,
      });
    }
    if (taskRunWorkspacePath !== currentWorkspacePath) {
      add("workspace_path_mismatch", `TaskRun ${header.taskRunId} belongs to another workspace`, {
        expected: header.workDir,
        actual: this.environment.workspacePath,
      });
    }

    const boundary = source.boundary;
    if (!boundary) {
      add("checkpoint_unavailable", `Attempt ${source.attemptId} has no durable safe boundary`);
      add("runtime_session_missing", `Attempt ${source.attemptId} has no Runtime boundary`);
    } else {
      if (
        boundary.storageRootId !== header.storageRootId ||
        boundary.storageRootId !== this.environment.storageRootId
      ) {
        add("storage_root_mismatch", `Attempt ${source.attemptId} storage root identity changed`, {
          taskRunStorageRootId: header.storageRootId,
          boundaryStorageRootId: boundary.storageRootId,
          currentStorageRootId: this.environment.storageRootId,
        });
      }
      const boundaryWorkspacePath = comparablePath(boundary.workspacePath);
      if (
        boundaryWorkspacePath !== currentWorkspacePath ||
        boundaryWorkspacePath !== taskRunWorkspacePath
      ) {
        add("workspace_path_mismatch", `Attempt ${source.attemptId} workspace path changed`, {
          expected: boundary.workspacePath,
          actual: this.environment.workspacePath,
        });
      }
      if (!boundary.backgroundOperationsSettled) {
        add(
          "background_operation_pending",
          `Attempt ${source.attemptId} still has unsettled background operations`,
        );
      }
      if (!boundary.checkpointRef) {
        add("checkpoint_unavailable", `Attempt ${source.attemptId} has no checkpoint reference`);
      }
      if (!boundary.runtime) {
        add("runtime_session_missing", `Attempt ${source.attemptId} has no Runtime session`);
      } else {
        await this.inspectRuntimeBoundary(
          boundary.runtime,
          boundary,
          taskRunWorkspacePath,
          currentWorkspacePath,
          options.verifiedLaunch,
          add,
        );
      }
    }

    if (diagnostics.length > 0 || !boundary || !adapter || !input) {
      return parkPlan(header.taskRunId, diagnostics);
    }
    return {
      plan: {
        disposition: "continue",
        taskRunId: header.taskRunId,
        sourceAttemptId: source.attemptId,
        boundary,
      },
      source,
      adapter,
      input,
    };
  }

  private async inspectRuntimeBoundary(
    runtimeBoundary: TaskRuntimeBoundary,
    boundary: NonNullable<TaskAttemptProjection["boundary"]>,
    taskRunWorkspacePath: string,
    environmentWorkspacePath: string,
    verifiedLaunch: Extract<RuntimeLaunchReconciliation, { status: "verified" }> | undefined,
    add: (
      reason: TaskResumeParkReason,
      message: string,
      detail?: Readonly<Record<string, unknown>>,
    ) => void,
  ): Promise<void> {
    let inspection: RuntimeBoundaryInspection;
    try {
      inspection = await this.runtime.inspect(runtimeBoundary);
    } catch (error) {
      add("ledger_corrupt", `Runtime boundary inspection failed for ${runtimeBoundary.runId}`, {
        error: errorMessage(error),
      });
      return;
    }
    if (inspection.status === "session_missing") {
      add("runtime_session_missing", `Runtime session ${runtimeBoundary.sessionId} is missing`);
      return;
    }
    if (inspection.status === "run_missing") {
      add("runtime_run_missing", `Runtime run ${runtimeBoundary.runId} is missing`);
      return;
    }
    if (
      inspection.sessionId !== runtimeBoundary.sessionId ||
      inspection.runId !== runtimeBoundary.runId
    ) {
      add("ledger_corrupt", "Runtime inspector returned a different session or run identity", {
        expectedSessionId: runtimeBoundary.sessionId,
        actualSessionId: inspection.sessionId,
        expectedRunId: runtimeBoundary.runId,
        actualRunId: inspection.runId,
      });
      return;
    }
    const sessionWorkspacePath = comparablePath(inspection.sessionWorkspacePath);
    const runWorkspacePath = comparablePath(inspection.runWorkspacePath);
    const boundaryWorkspacePath = comparablePath(boundary.workspacePath);
    if (
      sessionWorkspacePath !== taskRunWorkspacePath ||
      sessionWorkspacePath !== boundaryWorkspacePath ||
      sessionWorkspacePath !== environmentWorkspacePath ||
      runWorkspacePath !== sessionWorkspacePath
    ) {
      add(
        "workspace_path_mismatch",
        `Runtime session ${runtimeBoundary.sessionId} belongs to another workspace`,
        {
          taskRunWorkspacePath,
          boundaryWorkspacePath,
          sessionWorkspacePath,
          runWorkspacePath,
          environmentWorkspacePath,
        },
      );
    }
    if (
      verifiedLaunch !== undefined &&
      (verifiedLaunch.receipt.sessionId !== runtimeBoundary.sessionId ||
        verifiedLaunch.receipt.runStartedSequence !== runtimeBoundary.eventHighWater + 1 ||
        verifiedLaunch.currentEventHighWater < verifiedLaunch.receipt.runStartedSequence ||
        inspection.eventHighWater < verifiedLaunch.receipt.runStartedSequence)
    ) {
      add("ledger_corrupt", `Runtime launch proof does not extend source boundary`, {
        sourceSessionId: runtimeBoundary.sessionId,
        sourceEventHighWater: runtimeBoundary.eventHighWater,
        launchSessionId: verifiedLaunch.receipt.sessionId,
        launchSequence: verifiedLaunch.receipt.runStartedSequence,
        reconciledEventHighWater: verifiedLaunch.currentEventHighWater,
        inspectedEventHighWater: inspection.eventHighWater,
      });
    } else if (
      verifiedLaunch === undefined &&
      inspection.eventHighWater !== runtimeBoundary.eventHighWater
    ) {
      add("runtime_high_water_mismatch", `Runtime run ${runtimeBoundary.runId} advanced`, {
        expected: runtimeBoundary.eventHighWater,
        actual: inspection.eventHighWater,
      });
    }
    if (inspection.sourceRunLastSequence !== runtimeBoundary.eventHighWater) {
      add(
        "runtime_high_water_mismatch",
        `Runtime source run ${runtimeBoundary.runId} advanced beyond its safe boundary`,
        {
          expectedSourceRunLastSequence: runtimeBoundary.eventHighWater,
          actualSourceRunLastSequence: inspection.sourceRunLastSequence,
        },
      );
    }
    if (
      !inspection.terminal ||
      inspection.terminal.status !== "interrupted" ||
      inspection.terminalSequence !== runtimeBoundary.eventHighWater ||
      (runtimeBoundary.terminalEventId !== undefined &&
        runtimeBoundary.terminalEventId !== inspection.terminal.eventId)
    ) {
      add(
        "runtime_terminal_missing",
        `Runtime run ${runtimeBoundary.runId} has no matching interrupted terminal fact`,
        {
          expectedTerminalEventId: runtimeBoundary.terminalEventId,
          actualTerminalEventId: inspection.terminal?.eventId,
          actualStatus: inspection.terminal?.status,
          expectedTerminalSequence: runtimeBoundary.eventHighWater,
          actualTerminalSequence: inspection.terminalSequence,
        },
      );
    }
    if (inspection.pendingToolCallIds.length > 0) {
      add(
        "pending_tool_effect",
        `Runtime run ${runtimeBoundary.runId} has unresolved tool effects`,
        { toolCallIds: inspection.pendingToolCallIds },
      );
    }
    if (inspection.pendingApprovalIds.length > 0) {
      add("pending_approval", `Runtime run ${runtimeBoundary.runId} has pending approvals`, {
        approvalIds: inspection.pendingApprovalIds,
      });
    }
    if (!inspection.backgroundOperationsSettled) {
      add(
        "background_operation_pending",
        `Runtime run ${runtimeBoundary.runId} has unsettled background operations`,
      );
    }
    if (
      !boundary.toolCatalogHash ||
      !inspection.toolCatalogHash ||
      boundary.toolCatalogHash !== inspection.toolCatalogHash
    ) {
      add("tool_catalog_mismatch", `Runtime run ${runtimeBoundary.runId} tool catalog changed`, {
        expected: boundary.toolCatalogHash,
        actual: inspection.toolCatalogHash,
      });
    }
    if (
      !boundary.checkpointRef ||
      !inspection.availableCheckpointRefs.includes(boundary.checkpointRef)
    ) {
      add("checkpoint_unavailable", `Runtime checkpoint is unavailable for safe resume`, {
        checkpointRef: boundary.checkpointRef,
      });
    }
  }
}

export interface SafeBoundaryResumeCoordinatorOptions {
  readonly ledger: TaskResumeLedger;
  readonly registry: RecoverableTaskRegistry;
  readonly runtime: RuntimeBoundaryInspector;
  readonly environment: SafeBoundaryResumeEnvironment;
  readonly ownerId: string;
  readonly now?: () => Date;
  readonly launchLeaseTtlMs?: number;
  readonly executionLeaseTtlMs?: number;
  readonly maxContentionRetries?: number;
}

export interface SafeBoundaryResumeInput {
  readonly taskRunId: string;
  readonly executionClass: JobExecutionClass;
}

export type SafeBoundaryResumeResult =
  | {
      readonly status: "ignored";
      readonly taskRunId: string;
      readonly reason: "host_bound" | "attempt_running";
    }
  | {
      readonly status: "parked";
      readonly plan: Extract<TaskResumePlan, { disposition: "park" }>;
    }
  | {
      readonly status: "already_claimed";
      readonly taskRunId: string;
      readonly sourceAttemptId: string;
      readonly successorAttemptId: string;
      readonly launchId: string;
      readonly ownerId: string;
      readonly leaseEpoch: number;
    }
  | {
      readonly status: "launch_failed";
      readonly taskRunId: string;
      readonly sourceAttemptId: string;
      readonly attemptId: string;
      readonly launchId: string;
      readonly ownerId: string;
      readonly leaseEpoch: number;
      readonly error: string;
    }
  | {
      readonly status: "resumed";
      readonly taskRunId: string;
      readonly sourceAttemptId: string;
      readonly attemptId: string;
      readonly attemptNumber: number;
      readonly launchId: string;
      readonly ownerId: string;
      readonly leaseEpoch: number;
    };

export class SafeBoundaryResumeCoordinator {
  private readonly planner: SafeBoundaryResumePlanner;
  private readonly now: () => Date;
  private readonly launchLeaseTtlMs: number;
  private readonly executionLeaseTtlMs: number;
  private readonly maxContentionRetries: number;

  constructor(private readonly options: SafeBoundaryResumeCoordinatorOptions) {
    if (!options.ownerId.trim()) throw new Error("Safe-boundary ownerId must not be empty");
    this.now = options.now ?? (() => new Date());
    this.launchLeaseTtlMs = options.launchLeaseTtlMs ?? 30_000;
    if (!Number.isSafeInteger(this.launchLeaseTtlMs) || this.launchLeaseTtlMs <= 0) {
      throw new Error("launchLeaseTtlMs must be a positive safe integer");
    }
    this.executionLeaseTtlMs = options.executionLeaseTtlMs ?? 30_000;
    if (!Number.isSafeInteger(this.executionLeaseTtlMs) || this.executionLeaseTtlMs <= 0) {
      throw new Error("executionLeaseTtlMs must be a positive safe integer");
    }
    this.maxContentionRetries = options.maxContentionRetries ?? 4;
    if (!Number.isSafeInteger(this.maxContentionRetries) || this.maxContentionRetries < 0) {
      throw new Error("maxContentionRetries must be a non-negative safe integer");
    }
    this.planner = new SafeBoundaryResumePlanner(
      options.registry,
      options.runtime,
      options.environment,
    );
  }

  async recover(input: SafeBoundaryResumeInput): Promise<SafeBoundaryResumeResult> {
    if (input.executionClass === "host_bound") {
      return { status: "ignored", taskRunId: input.taskRunId, reason: "host_bound" };
    }
    for (let retry = 0; retry <= this.maxContentionRetries; retry += 1) {
      const projection = await this.readProjection(input.taskRunId);
      if (!projection) return missingLedgerResult(input.taskRunId);
      if (projection.terminal) {
        return { status: "parked", plan: terminalTaskPlan(projection).plan };
      }

      const active = latestAttempt(projection.attempts);
      if (active?.status === "running") {
        const now = this.now().toISOString();
        const executionLive = active.execution.expiresAt > now;
        if (!active.sourceAttemptId) {
          if (executionLive) {
            return {
              status: "ignored",
              taskRunId: projection.header.taskRunId,
              reason: "attempt_running",
            };
          }
          const interrupted = await this.interruptExpiredAttempt(projection, active);
          if (interrupted.status === "conflict") continue;
          continue;
        }
        if (active.launch?.status === "succeeded") {
          if (executionLive) {
            return alreadyClaimedResult(projection.header.taskRunId, active);
          }
          const interrupted = await this.interruptExpiredAttempt(projection, active);
          if (interrupted.status === "conflict") continue;
          continue;
        }
        if (
          (executionLive && active.execution.ownerId !== this.options.ownerId) ||
          (active.launch?.status === "claimed" && active.launch.expiresAt > now)
        ) {
          return alreadyClaimedResult(projection.header.taskRunId, active);
        }
        if (!active.launch) {
          return {
            status: "ignored",
            taskRunId: projection.header.taskRunId,
            reason: "attempt_running",
          };
        }
        const reconciliation = await this.reconcileExistingLaunch(projection, active);
        if (reconciliation.status === "mismatch") {
          const launchClaim = await this.claimLaunch(projection, active);
          if (launchClaim.status === "conflict") continue;
          const successor = launchClaim.projection.attempts.find(
            (attempt) => attempt.attemptId === active.attemptId,
          );
          if (!successor) {
            throw new Error(`TaskRun ${input.taskRunId} lost Attempt ${active.attemptId}`);
          }
          return this.parkLaunchMismatch(projection.header.taskRunId, successor, reconciliation);
        }
        const evaluation = await this.planner.evaluate(projection, {
          sourceAttemptId: active.sourceAttemptId,
          creatingSuccessor: false,
          ...(reconciliation.status === "verified"
            ? { verifiedLaunch: reconciliation }
            : {}),
        });
        const launchClaim = await this.claimLaunch(projection, active);
        if (launchClaim.status === "conflict") continue;
        const successor = launchClaim.projection.attempts.find(
          (attempt) => attempt.attemptId === active.attemptId,
        );
        if (!successor) {
          throw new Error(`TaskRun ${input.taskRunId} lost Attempt ${active.attemptId}`);
        }
        if (!isPreparedResume(evaluation)) {
          return this.parkClaimedLaunch(
            projection.header.taskRunId,
            successor,
            evaluation.plan,
          );
        }
        return this.executeLaunch(launchClaim.projection, successor, evaluation);
      }

      const evaluation = await this.planner.evaluate(projection);
      if (!isPreparedResume(evaluation)) {
        if (sameParkProjection(projection, evaluation.plan)) {
          return { status: "parked", plan: evaluation.plan };
        }
        const parked = await this.appendPark(projection, evaluation.plan);
        if (parked.status === "committed") {
          return { status: "parked", plan: evaluation.plan };
        }
        continue;
      }

      const claimed = await this.claim(projection, evaluation);
      if (claimed.status === "conflict") {
        continue;
      }

      const successor = successorOf(claimed.projection, evaluation.source.attemptId);
      if (!successor) {
        throw new Error(
          `Task resume ledger committed without successor Attempt for ${evaluation.source.attemptId}`,
        );
      }
      return this.executeLaunch(claimed.projection, successor, evaluation);
    }

    const plan = parkPlan(input.taskRunId, [
      {
        reason: "resume_already_claimed",
        message: `TaskRun ${input.taskRunId} changed during every resume claim attempt`,
      },
    ]).plan;
    return { status: "parked", plan };
  }

  private async readProjection(taskRunId: string): Promise<TaskRunProjection | undefined> {
    try {
      return await this.options.ledger.readProjection(taskRunId);
    } catch {
      return undefined;
    }
  }

  private interruptExpiredAttempt(
    projection: TaskRunProjection,
    attempt: TaskAttemptProjection,
  ): Promise<TaskResumeLedgerAppendResult> {
    const atDate = this.now();
    const at = atDate.toISOString();
    if (attempt.execution.expiresAt > at) {
      throw new Error(`Attempt ${attempt.attemptId} execution lease is still live`);
    }
    const leaseEpoch = attempt.execution.leaseEpoch + 1;
    const claimed: TaskAttemptExecutionClaimedEvent = {
      kind: "attempt.execution.claimed",
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: `event:attempt-execution-takeover:${attempt.attemptId}:${leaseEpoch}`,
      taskRunId: projection.header.taskRunId,
      at,
      data: {
        attemptId: attempt.attemptId,
        ownerId: this.options.ownerId,
        leaseEpoch,
        expiresAt: new Date(atDate.getTime() + this.executionLeaseTtlMs).toISOString(),
      },
    };
    const interrupted: TaskAttemptFinishedEvent = {
      kind: "attempt.finished",
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: `event:attempt-expired-interrupted:${attempt.attemptId}:${leaseEpoch}`,
      taskRunId: projection.header.taskRunId,
      at,
      data: {
        attemptId: attempt.attemptId,
        ownerId: this.options.ownerId,
        leaseEpoch,
        status: "interrupted",
        error: "execution lease expired",
      },
    };
    return this.options.ledger.appendBatch({
      taskRunId: projection.header.taskRunId,
      expectedRevision: projection.revision,
      transactionId: `task-attempt-expired:${attempt.attemptId}:${leaseEpoch}`,
      events: [claimed, interrupted],
    });
  }

  private claim(
    projection: TaskRunProjection,
    prepared: PreparedTaskResume,
  ): Promise<TaskResumeLedgerAppendResult> {
    const attemptNumber =
      Math.max(...projection.attempts.map((attempt) => attempt.attemptNumber), 0) + 1;
    const attemptLeaseEpoch =
      Math.max(...projection.attempts.map((attempt) => attempt.execution.leaseEpoch), 0) + 1;
    const launchLeaseEpoch = 1;
    const identity = resumeIdentity(
      projection.header.taskRunId,
      prepared.source.attemptId,
      attemptNumber,
    );
    const successorAttemptId = `attempt:resume:${identity}`;
    const claimId = `resume-claim:${identity}`;
    const launchId = `launch:${identity}`;
    const atDate = this.now();
    const at = atDate.toISOString();
    const claim: TaskResumeClaimedEvent = {
      kind: "task.resume.claimed",
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: `event:${claimId}`,
      taskRunId: projection.header.taskRunId,
      at,
      data: {
        claimId,
        sourceAttemptId: prepared.source.attemptId,
        successorAttemptId,
        ownerId: this.options.ownerId,
        leaseEpoch: attemptLeaseEpoch,
      },
    };
    const started: TaskAttemptStartedEvent = {
      kind: "attempt.started",
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: `event:attempt-started:${identity}`,
      taskRunId: projection.header.taskRunId,
      at,
      data: {
        attemptId: successorAttemptId,
        attemptNumber,
        sourceAttemptId: prepared.source.attemptId,
      },
    };
    const executionClaim: TaskAttemptExecutionClaimedEvent = {
      kind: "attempt.execution.claimed",
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: `event:attempt-execution-claimed:${identity}:${attemptLeaseEpoch}`,
      taskRunId: projection.header.taskRunId,
      at,
      data: {
        attemptId: successorAttemptId,
        ownerId: this.options.ownerId,
        leaseEpoch: attemptLeaseEpoch,
        expiresAt: new Date(atDate.getTime() + this.executionLeaseTtlMs).toISOString(),
      },
    };
    const launchClaim: TaskAttemptLaunchClaimedEvent = {
      kind: "attempt.launch.claimed",
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: `event:attempt-launch-claimed:${identity}:${launchLeaseEpoch}`,
      taskRunId: projection.header.taskRunId,
      at,
      data: {
        attemptId: successorAttemptId,
        launchId,
        ownerId: this.options.ownerId,
        leaseEpoch: launchLeaseEpoch,
        expiresAt: new Date(atDate.getTime() + this.launchLeaseTtlMs).toISOString(),
      },
    };
    return this.options.ledger.appendBatch({
      taskRunId: projection.header.taskRunId,
      expectedRevision: projection.revision,
      transactionId: `task-resume:${identity}`,
      events: [claim, started, executionClaim, launchClaim],
    });
  }

  private claimLaunch(
    projection: TaskRunProjection,
    attempt: TaskAttemptProjection,
  ): Promise<TaskResumeLedgerAppendResult> {
    if (!attempt.sourceAttemptId) {
      throw new Error(`Attempt ${attempt.attemptId} is not a resume successor`);
    }
    const atDate = this.now();
    const at = atDate.toISOString();
    const identity = resumeIdentity(
      projection.header.taskRunId,
      attempt.sourceAttemptId,
      attempt.attemptNumber,
    );
    const launchId = attempt.launch?.launchId ?? `launch:${identity}`;
    const events: TaskRunEvent[] = [];
    let executionLeaseEpoch = attempt.execution.leaseEpoch;
    if (attempt.execution.expiresAt <= at) {
      executionLeaseEpoch += 1;
      events.push({
        kind: "attempt.execution.claimed",
        schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
        eventId: `event:attempt-execution-claimed:${identity}:${executionLeaseEpoch}`,
        taskRunId: projection.header.taskRunId,
        at,
        data: {
          attemptId: attempt.attemptId,
          ownerId: this.options.ownerId,
          leaseEpoch: executionLeaseEpoch,
          expiresAt: new Date(atDate.getTime() + this.executionLeaseTtlMs).toISOString(),
        },
      });
    } else if (attempt.execution.ownerId !== this.options.ownerId) {
      throw new Error(`Attempt ${attempt.attemptId} execution lease belongs to another host`);
    }
    let launchLeaseEpoch = attempt.launch?.leaseEpoch ?? 0;
    if (attempt.launch?.status !== "succeeded") {
      launchLeaseEpoch += 1;
      events.push({
        kind: "attempt.launch.claimed",
        schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
        eventId: `event:attempt-launch-claimed:${identity}:${launchLeaseEpoch}`,
        taskRunId: projection.header.taskRunId,
        at,
        data: {
          attemptId: attempt.attemptId,
          launchId,
          ownerId: this.options.ownerId,
          leaseEpoch: launchLeaseEpoch,
          expiresAt: new Date(atDate.getTime() + this.launchLeaseTtlMs).toISOString(),
        },
      });
    }
    if (events.length === 0) {
      throw new Error(`Attempt ${attempt.attemptId} has no expired lease to claim`);
    }
    return this.options.ledger.appendBatch({
      taskRunId: projection.header.taskRunId,
      expectedRevision: projection.revision,
      transactionId: `task-launch-claim:${identity}:${executionLeaseEpoch}:${launchLeaseEpoch}`,
      events,
    });
  }

  private async executeLaunch(
    projection: TaskRunProjection,
    successor: TaskAttemptProjection,
    initialPrepared: PreparedTaskResume,
  ): Promise<SafeBoundaryResumeResult> {
    const launch = successor.launch;
    if (!launch) throw new Error(`Attempt ${successor.attemptId} has no launch identity`);
    const sourceRuntime = initialPrepared.plan.boundary.runtime;
    const checkpointRef = initialPrepared.plan.boundary.checkpointRef;
    if (!checkpointRef) {
      throw new Error(
        `Safe resume plan for ${projection.header.taskRunId} lost its checkpoint reference`,
      );
    }
    if (!sourceRuntime) {
      throw new Error(
        `Safe resume plan for ${projection.header.taskRunId} lost its Runtime source`,
      );
    }
    const runtimeIdentity = deriveRecoverableTaskRuntimeLaunchIdentity(launch.launchId);
    const expectation: RuntimeLaunchExpectation = {
      launchId: launch.launchId,
      ...runtimeIdentity,
    };
    const before = await this.reconcileRuntimeLaunch(sourceRuntime, expectation);
    if (before.status === "mismatch") {
      return this.parkLaunchMismatch(projection.header.taskRunId, successor, before);
    }
    if (
      launch.status !== "claimed" ||
      launch.ownerId !== this.options.ownerId ||
      launch.expiresAt <= this.now().toISOString() ||
      successor.execution.ownerId !== this.options.ownerId ||
      successor.execution.expiresAt <= this.now().toISOString()
    ) {
      throw new Error(`Attempt ${successor.attemptId} has no live launch/execution lease`);
    }

    const currentEvaluation = await this.planner.evaluate(projection, {
      sourceAttemptId: initialPrepared.source.attemptId,
      creatingSuccessor: false,
      ...(before.status === "verified" ? { verifiedLaunch: before } : {}),
    });
    if (!isPreparedResume(currentEvaluation)) {
      return this.parkClaimedLaunch(
        projection.header.taskRunId,
        successor,
        currentEvaluation.plan,
      );
    }
    const prepared = currentEvaluation;
    const currentCheckpointRef = prepared.plan.boundary.checkpointRef;
    const currentSourceRuntime = prepared.plan.boundary.runtime;
    if (!currentCheckpointRef || !currentSourceRuntime) {
      throw new Error(`Safe resume plan for ${projection.header.taskRunId} lost durable evidence`);
    }

    let adapterReceipt: RecoverableTaskLaunchReceipt | undefined;
    try {
      adapterReceipt = validateRecoverableTaskLaunchReceipt(
        await prepared.adapter.resume(prepared.input, {
          taskRunId: projection.header.taskRunId,
          sourceAttemptId: prepared.source.attemptId,
          attemptId: successor.attemptId,
          attemptNumber: successor.attemptNumber,
          launchId: launch.launchId,
          ownerId: successor.execution.ownerId,
          leaseEpoch: successor.execution.leaseEpoch,
          executionLeaseExpiresAt: successor.execution.expiresAt,
          runtimeSessionId: currentSourceRuntime.sessionId,
          expectedRuntimeRunId: runtimeIdentity.runId,
          expectedRunStartedEventId: runtimeIdentity.runStartedEventId,
          expectedSessionHighWater: currentSourceRuntime.eventHighWater,
          boundary: prepared.plan.boundary,
          checkpointRef: currentCheckpointRef,
        }),
      );
    } catch (error) {
      const afterError = await this.reconcileRuntimeLaunch(currentSourceRuntime, expectation);
      if (afterError.status === "mismatch") {
        return this.parkLaunchMismatch(projection.header.taskRunId, successor, afterError);
      }
      const message = errorMessage(error) || "Recoverable task adapter launch failed";
      await this.settleLaunch(
        projection.header.taskRunId,
        successor.attemptId,
        launch,
        successor.execution,
        "failed",
        undefined,
        message,
      );
      return {
        status: "launch_failed",
        taskRunId: projection.header.taskRunId,
        sourceAttemptId: prepared.source.attemptId,
        attemptId: successor.attemptId,
        launchId: launch.launchId,
        ownerId: successor.execution.ownerId,
        leaseEpoch: successor.execution.leaseEpoch,
        error: message,
      };
    }
    const after = await this.reconcileRuntimeLaunch(currentSourceRuntime, expectation);
    if (after.status === "mismatch") {
      return this.parkLaunchMismatch(projection.header.taskRunId, successor, after);
    }
    if (after.status === "not_started") {
      const mismatch: RuntimeLaunchReconciliation = {
        status: "mismatch",
        reason: "runtime_run_missing",
        message: `Adapter returned before canonical run.started for ${launch.launchId}`,
      };
      return this.parkLaunchMismatch(projection.header.taskRunId, successor, mismatch);
    }
    if (!adapterReceipt || !sameLaunchReceipt(adapterReceipt, after.receipt)) {
      return this.parkLaunchMismatch(projection.header.taskRunId, successor, {
        status: "mismatch",
        reason: "ledger_corrupt",
        message: `Adapter receipt for ${launch.launchId} does not match canonical RuntimeEvent`,
      });
    }
    const completedEvaluation = await this.planner.evaluate(projection, {
      sourceAttemptId: prepared.source.attemptId,
      creatingSuccessor: false,
      verifiedLaunch: after,
    });
    if (!isPreparedResume(completedEvaluation)) {
      return this.parkClaimedLaunch(
        projection.header.taskRunId,
        successor,
        completedEvaluation.plan,
      );
    }
    await this.settleLaunch(
      projection.header.taskRunId,
      successor.attemptId,
      launch,
      successor.execution,
      "succeeded",
      after.receipt,
    );
    return resumedResult(projection.header.taskRunId, completedEvaluation, successor);
  }

  private async reconcileExistingLaunch(
    projection: TaskRunProjection,
    successor: TaskAttemptProjection,
  ): Promise<RuntimeLaunchReconciliation> {
    const sourceAttemptId = successor.sourceAttemptId;
    const launch = successor.launch;
    if (!sourceAttemptId || !launch) {
      return launchMismatch(
        "ledger_corrupt",
        `Attempt ${successor.attemptId} has no durable resume launch identity`,
      );
    }
    const successors = projection.attempts.filter(
      (attempt) => attempt.sourceAttemptId === sourceAttemptId,
    );
    if (successors.length !== 1 || successors[0]?.attemptId !== successor.attemptId) {
      return launchMismatch(
        "ledger_corrupt",
        `Attempt ${sourceAttemptId} does not have one unique resume successor`,
      );
    }
    const source = projection.attempts.find((attempt) => attempt.attemptId === sourceAttemptId);
    const sourceRuntime = source?.boundary?.runtime;
    if (!source || !sourceRuntime) {
      return launchMismatch(
        "ledger_corrupt",
        `Attempt ${successor.attemptId} lost its source Runtime boundary`,
      );
    }
    const expectedLaunchId = `launch:${resumeIdentity(
      projection.header.taskRunId,
      sourceAttemptId,
      successor.attemptNumber,
    )}`;
    if (launch.launchId !== expectedLaunchId) {
      return launchMismatch(
        "ledger_corrupt",
        `Attempt ${successor.attemptId} launchId does not match its durable resume claim`,
      );
    }
    return this.reconcileRuntimeLaunch(sourceRuntime, {
      launchId: launch.launchId,
      ...deriveRecoverableTaskRuntimeLaunchIdentity(launch.launchId),
    });
  }

  private async reconcileRuntimeLaunch(
    source: TaskRuntimeBoundary,
    expected: RuntimeLaunchExpectation,
  ): Promise<RuntimeLaunchReconciliation> {
    let reconciliation: RuntimeLaunchReconciliation;
    try {
      reconciliation = await this.options.runtime.reconcileLaunch(source, expected);
    } catch (error) {
      return launchMismatch(
        "ledger_corrupt",
        `Runtime launch reconciliation failed for ${expected.launchId}`,
        { error: errorMessage(error) },
      );
    }
    if (reconciliation.status !== "verified") return reconciliation;
    let receipt: RecoverableTaskLaunchReceipt;
    try {
      receipt = validateRecoverableTaskLaunchReceipt(reconciliation.receipt);
    } catch (error) {
      return launchMismatch(
        "ledger_corrupt",
        `Runtime launch reconciliation returned an invalid receipt for ${expected.launchId}`,
        { error: errorMessage(error) },
      );
    }
    if (
      receipt.launchId !== expected.launchId ||
      receipt.sessionId !== source.sessionId ||
      receipt.runId !== expected.runId ||
      receipt.runStartedEventId !== expected.runStartedEventId ||
      receipt.runStartedSequence !== source.eventHighWater + 1 ||
      reconciliation.currentEventHighWater < receipt.runStartedSequence
    ) {
      return launchMismatch(
        "ledger_corrupt",
        `Runtime launch reconciliation returned another launch identity for ${expected.launchId}`,
      );
    }
    return { ...reconciliation, receipt };
  }

  private async settleLaunch(
    taskRunId: string,
    attemptId: string,
    launch: NonNullable<TaskAttemptProjection["launch"]>,
    execution: TaskAttemptProjection["execution"],
    status: "succeeded" | "failed",
    receipt?: RecoverableTaskLaunchReceipt,
    error?: string,
  ): Promise<void> {
    for (let retry = 0; retry <= this.maxContentionRetries; retry += 1) {
      const projection = await this.options.ledger.readProjection(taskRunId);
      const current = projection?.attempts.find((attempt) => attempt.attemptId === attemptId);
      if (
        !projection ||
        !current?.launch ||
        current.launch.status !== "claimed" ||
        current.launch.launchId !== launch.launchId ||
        current.launch.ownerId !== launch.ownerId ||
        current.launch.leaseEpoch !== launch.leaseEpoch ||
        current.launch.expiresAt <= this.now().toISOString() ||
        current.execution.ownerId !== execution.ownerId ||
        current.execution.leaseEpoch !== execution.leaseEpoch ||
        current.execution.expiresAt <= this.now().toISOString()
      ) {
        throw new Error(`Attempt ${attemptId} launch lease was lost before ${status} settlement`);
      }
      if (status === "succeeded" && !receipt) {
        throw new Error(`Attempt ${attemptId} launch success has no receipt`);
      }
      const at = this.now().toISOString();
      const event: TaskAttemptLaunchSucceededEvent | TaskAttemptLaunchFailedEvent =
        status === "succeeded"
          ? {
              kind: "attempt.launch.succeeded",
              schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
              eventId: `event:attempt-launch-succeeded:${launch.launchId}:${launch.leaseEpoch}`,
              taskRunId,
              at,
              data: {
                attemptId,
                launchId: launch.launchId,
                ownerId: launch.ownerId,
                leaseEpoch: launch.leaseEpoch,
                receipt: receipt!,
              },
            }
          : {
              kind: "attempt.launch.failed",
              schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
              eventId: `event:attempt-launch-failed:${launch.launchId}:${launch.leaseEpoch}`,
              taskRunId,
              at,
              data: {
                attemptId,
                launchId: launch.launchId,
                ownerId: launch.ownerId,
                leaseEpoch: launch.leaseEpoch,
                error: error ?? "Recoverable task adapter launch failed",
              },
            };
      const events: TaskRunEvent[] = [event];
      if (status === "failed") {
        const released: TaskAttemptExecutionReleasedEvent = {
          kind: "attempt.execution.released",
          schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
          eventId: `event:attempt-execution-released:${launch.launchId}:${execution.leaseEpoch}`,
          taskRunId,
          at,
          data: {
            attemptId,
            ownerId: execution.ownerId,
            leaseEpoch: execution.leaseEpoch,
          },
        };
        events.push(released);
      } else {
        const renewedExpiresAt = new Date(
          this.now().getTime() + this.executionLeaseTtlMs,
        ).toISOString();
        if (renewedExpiresAt > current.execution.expiresAt) {
          const renewed: TaskAttemptExecutionRenewedEvent = {
            kind: "attempt.execution.renewed",
            schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
            eventId: `event:attempt-execution-renewed:${launch.launchId}:${execution.leaseEpoch}`,
            taskRunId,
            at,
            data: {
              attemptId,
              ownerId: execution.ownerId,
              leaseEpoch: execution.leaseEpoch,
              expiresAt: renewedExpiresAt,
            },
          };
          events.push(renewed);
        }
      }
      const result = await this.options.ledger.appendBatch({
        taskRunId,
        expectedRevision: projection.revision,
        transactionId: `task-launch-${status}:${launch.launchId}:${launch.leaseEpoch}`,
        events,
      });
      if (result.status === "committed") return;
    }
    throw new Error(`Attempt ${attemptId} launch settlement exceeded contention retries`);
  }

  private async parkLaunchMismatch(
    taskRunId: string,
    successor: TaskAttemptProjection,
    mismatch: Extract<RuntimeLaunchReconciliation, { status: "mismatch" }>,
  ): Promise<Extract<SafeBoundaryResumeResult, { status: "parked" }>> {
    const plan = parkPlan(taskRunId, [
      {
        reason: mismatch.reason,
        message: mismatch.message,
        ...(mismatch.detail ? { detail: mismatch.detail } : {}),
      },
    ]).plan;
    return this.parkClaimedLaunch(taskRunId, successor, plan);
  }

  private async parkClaimedLaunch(
    taskRunId: string,
    successor: TaskAttemptProjection,
    plan: Extract<TaskResumePlan, { disposition: "park" }>,
  ): Promise<Extract<SafeBoundaryResumeResult, { status: "parked" }>> {
    const error = plan.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
    for (let retry = 0; retry <= this.maxContentionRetries; retry += 1) {
      const projection = await this.options.ledger.readProjection(taskRunId);
      const current = projection?.attempts.find(
        (attempt) => attempt.attemptId === successor.attemptId,
      );
      if (!projection || !current || current.status !== "running") {
        throw new Error(`Attempt ${successor.attemptId} disappeared before launch parking`);
      }
      const launch = current.launch;
      const at = this.now().toISOString();
      if (launch?.status === "succeeded") {
        return { status: "parked", plan };
      }
      if (
        !launch ||
        launch.status !== "claimed" ||
        launch.ownerId !== this.options.ownerId ||
        launch.expiresAt <= at ||
        current.execution.ownerId !== this.options.ownerId ||
        current.execution.expiresAt <= at
      ) {
        throw new Error(`Attempt ${successor.attemptId} lost its lease before launch parking`);
      }
      const failed: TaskAttemptLaunchFailedEvent = {
        kind: "attempt.launch.failed",
        schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
        eventId: `event:attempt-launch-invalid:${launch.launchId}:${launch.leaseEpoch}`,
        taskRunId,
        at,
        data: {
          attemptId: current.attemptId,
          launchId: launch.launchId,
          ownerId: launch.ownerId,
          leaseEpoch: launch.leaseEpoch,
          error,
        },
      };
      const interrupted: TaskAttemptFinishedEvent = {
        kind: "attempt.finished",
        schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
        eventId: `event:attempt-launch-interrupted:${launch.launchId}:${launch.leaseEpoch}`,
        taskRunId,
        at,
        data: {
          attemptId: current.attemptId,
          ownerId: current.execution.ownerId,
          leaseEpoch: current.execution.leaseEpoch,
          status: "interrupted",
          error,
        },
      };
      const parked: TaskRunParkedEvent = {
        kind: "task.parked",
        schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
        eventId: `event:task-launch-parked:${launch.launchId}:${launch.leaseEpoch}`,
        taskRunId,
        at,
        data: {
          sourceAttemptId: current.attemptId,
          reasons: plan.reasons,
          diagnostics: plan.diagnostics.map((diagnostic) => diagnostic.message),
        },
      };
      const result = await this.options.ledger.appendBatch({
        taskRunId,
        expectedRevision: projection.revision,
        transactionId: `task-launch-park:${launch.launchId}:${launch.leaseEpoch}`,
        events: [failed, interrupted, parked],
      });
      if (result.status === "committed") return { status: "parked", plan };
    }
    throw new Error(`Attempt ${successor.attemptId} launch parking exceeded contention retries`);
  }

  private appendPark(
    projection: TaskRunProjection,
    plan: Extract<TaskResumePlan, { disposition: "park" }>,
  ): Promise<TaskResumeLedgerAppendResult> {
    const sourceAttemptId = latestAttempt(projection.attempts)?.attemptId;
    const at = this.now().toISOString();
    const identity = createHash("sha256")
      .update(
        JSON.stringify([
          "task-resume-park-v1",
          projection.header.taskRunId,
          sourceAttemptId,
          plan.reasons,
        ]),
      )
      .digest("hex");
    const event: TaskRunParkedEvent = {
      kind: "task.parked",
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: `event:task-parked:${identity}`,
      taskRunId: projection.header.taskRunId,
      at,
      data: {
        ...(sourceAttemptId ? { sourceAttemptId } : {}),
        reasons: plan.reasons,
        diagnostics: plan.diagnostics.map((diagnostic) => diagnostic.message),
      },
    };
    return this.options.ledger.appendBatch({
      taskRunId: projection.header.taskRunId,
      expectedRevision: projection.revision,
      transactionId: `task-park:${identity}`,
      events: [event],
    });
  }
}

function parkPlan(
  taskRunId: string,
  diagnostics: readonly TaskResumeDiagnostic[],
): { readonly plan: Extract<TaskResumePlan, { disposition: "park" }> } {
  return {
    plan: {
      disposition: "park",
      taskRunId,
      reasons: diagnostics.map((diagnostic) => diagnostic.reason),
      diagnostics,
    },
  };
}

function terminalTaskPlan(
  projection: TaskRunProjection,
): { readonly plan: Extract<TaskResumePlan, { disposition: "park" }> } {
  if (!projection.terminal) {
    throw new Error(`TaskRun ${projection.header.taskRunId} is not terminal`);
  }
  return parkPlan(projection.header.taskRunId, [
    {
      reason: "task_terminal",
      message: `TaskRun ${projection.header.taskRunId} is already terminal`,
      detail: { status: projection.terminal.status },
    },
  ]);
}

function launchMismatch(
  reason: Extract<RuntimeLaunchReconciliation, { status: "mismatch" }>["reason"],
  message: string,
  detail?: Readonly<Record<string, unknown>>,
): Extract<RuntimeLaunchReconciliation, { status: "mismatch" }> {
  return {
    status: "mismatch",
    reason,
    message,
    ...(detail ? { detail } : {}),
  };
}

function missingLedgerResult(taskRunId: string): SafeBoundaryResumeResult {
  return {
    status: "parked",
    plan: parkPlan(taskRunId, [
      {
        reason: "ledger_corrupt",
        message: `TaskRun ledger ${taskRunId} is missing or unreadable`,
      },
    ]).plan,
  };
}

function latestAttempt(
  attempts: readonly TaskAttemptProjection[],
): TaskAttemptProjection | undefined {
  return attempts.reduce<TaskAttemptProjection | undefined>((latest, candidate) => {
    if (!latest || candidate.attemptNumber > latest.attemptNumber) return candidate;
    return latest;
  }, undefined);
}

function isPreparedResume(evaluation: TaskResumeEvaluation): evaluation is PreparedTaskResume {
  return "source" in evaluation;
}

function successorOf(
  projection: TaskRunProjection,
  sourceAttemptId: string | undefined,
): TaskAttemptProjection | undefined {
  if (!sourceAttemptId) return undefined;
  return projection.attempts.findLast((attempt) => attempt.sourceAttemptId === sourceAttemptId);
}

function alreadyClaimedResult(
  taskRunId: string,
  successor: TaskAttemptProjection,
): Extract<SafeBoundaryResumeResult, { status: "already_claimed" }> {
  if (!successor.sourceAttemptId) {
    throw new Error(`Attempt ${successor.attemptId} is not a resume successor`);
  }
  if (!successor.launch) {
    throw new Error(`Attempt ${successor.attemptId} has no launch fact`);
  }
  return {
    status: "already_claimed",
    taskRunId,
    sourceAttemptId: successor.sourceAttemptId,
    successorAttemptId: successor.attemptId,
    launchId: successor.launch.launchId,
    ownerId: successor.execution.ownerId,
    leaseEpoch: successor.execution.leaseEpoch,
  };
}

function resumedResult(
  taskRunId: string,
  prepared: PreparedTaskResume,
  successor: TaskAttemptProjection,
): Extract<SafeBoundaryResumeResult, { status: "resumed" }> {
  if (!successor.launch) throw new Error(`Attempt ${successor.attemptId} has no launch fact`);
  return {
    status: "resumed",
    taskRunId,
    sourceAttemptId: prepared.source.attemptId,
    attemptId: successor.attemptId,
    attemptNumber: successor.attemptNumber,
    launchId: successor.launch.launchId,
    ownerId: successor.execution.ownerId,
    leaseEpoch: successor.execution.leaseEpoch,
  };
}

function sameLaunchReceipt(
  left: RecoverableTaskLaunchReceipt,
  right: RecoverableTaskLaunchReceipt,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.launchId === right.launchId &&
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.runStartedEventId === right.runStartedEventId &&
    left.runStartedSequence === right.runStartedSequence
  );
}

function sameParkProjection(
  projection: TaskRunProjection,
  plan: Extract<TaskResumePlan, { disposition: "park" }>,
): boolean {
  return (
    projection.status === "parked" &&
    projection.parkReasons.length === plan.reasons.length &&
    projection.parkReasons.every((reason, index) => reason === plan.reasons[index])
  );
}

function resumeIdentity(taskRunId: string, sourceAttemptId: string, attemptNumber: number): string {
  return createHash("sha256")
    .update(JSON.stringify(["task-resume-v1", taskRunId, sourceAttemptId, attemptNumber]))
    .digest("hex");
}

function comparablePath(path: string): string {
  return canonicalizeWorkspacePath(path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
