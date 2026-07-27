import { createHash } from "node:crypto";
import { canonicalizeWorkspacePath } from "../paths/pico-paths.js";
import {
  prepareRecoverableTaskInput,
  type RecoverableTaskAdapter,
  type RecoverableTaskRegistry,
} from "../tasks/recoverable-task.js";
import {
  TASK_RUN_EVENT_SCHEMA_VERSION,
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
}

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
      add("task_terminal", `TaskRun ${header.taskRunId} is already terminal`, {
        status: projection.terminal.status,
      });
      return parkPlan(header.taskRunId, diagnostics);
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
    if (inspection.eventHighWater !== runtimeBoundary.eventHighWater) {
      add("runtime_high_water_mismatch", `Runtime run ${runtimeBoundary.runId} advanced`, {
        expected: runtimeBoundary.eventHighWater,
        actual: inspection.eventHighWater,
      });
    }
    if (
      !inspection.terminal ||
      inspection.terminal.status !== "interrupted" ||
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
  private readonly maxContentionRetries: number;

  constructor(private readonly options: SafeBoundaryResumeCoordinatorOptions) {
    if (!options.ownerId.trim()) throw new Error("Safe-boundary ownerId must not be empty");
    this.now = options.now ?? (() => new Date());
    this.launchLeaseTtlMs = options.launchLeaseTtlMs ?? 30_000;
    if (!Number.isSafeInteger(this.launchLeaseTtlMs) || this.launchLeaseTtlMs <= 0) {
      throw new Error("launchLeaseTtlMs must be a positive safe integer");
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

      const active = latestAttempt(projection.attempts);
      if (active?.status === "running") {
        if (!active.sourceAttemptId) {
          return {
            status: "ignored",
            taskRunId: projection.header.taskRunId,
            reason: "attempt_running",
          };
        }
        if (
          active.launch?.status === "succeeded" ||
          (active.launch?.status === "claimed" &&
            active.launch.expiresAt > this.now().toISOString())
        ) {
          return alreadyClaimedResult(projection.header.taskRunId, active);
        }
        const evaluation = await this.planner.evaluate(projection, {
          sourceAttemptId: active.sourceAttemptId,
          creatingSuccessor: false,
        });
        if (!isPreparedResume(evaluation)) {
          return { status: "parked", plan: evaluation.plan };
        }
        const launchClaim = await this.claimLaunch(projection, active);
        if (launchClaim.status === "conflict") continue;
        const successor = launchClaim.projection.attempts.find(
          (attempt) => attempt.attemptId === active.attemptId,
        );
        if (!successor) {
          throw new Error(`TaskRun ${input.taskRunId} lost Attempt ${active.attemptId}`);
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

  private claim(
    projection: TaskRunProjection,
    prepared: PreparedTaskResume,
  ): Promise<TaskResumeLedgerAppendResult> {
    const attemptNumber =
      Math.max(...projection.attempts.map((attempt) => attempt.attemptNumber), 0) + 1;
    const attemptLeaseEpoch =
      Math.max(...projection.attempts.map((attempt) => attempt.leaseEpoch), 0) + 1;
    const launchLeaseEpoch = attemptLeaseEpoch + 1;
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
        ownerId: this.options.ownerId,
        leaseEpoch: attemptLeaseEpoch,
        sourceAttemptId: prepared.source.attemptId,
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
      events: [claim, started, launchClaim],
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
    const leaseEpoch =
      Math.max(...projection.attempts.map((candidate) => candidate.leaseEpoch), 0) + 1;
    const identity = resumeIdentity(
      projection.header.taskRunId,
      attempt.sourceAttemptId,
      attempt.attemptNumber,
    );
    const launchId = attempt.launch?.launchId ?? `launch:${identity}`;
    const event: TaskAttemptLaunchClaimedEvent = {
      kind: "attempt.launch.claimed",
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: `event:attempt-launch-claimed:${identity}:${leaseEpoch}`,
      taskRunId: projection.header.taskRunId,
      at,
      data: {
        attemptId: attempt.attemptId,
        launchId,
        ownerId: this.options.ownerId,
        leaseEpoch,
        expiresAt: new Date(atDate.getTime() + this.launchLeaseTtlMs).toISOString(),
      },
    };
    return this.options.ledger.appendBatch({
      taskRunId: projection.header.taskRunId,
      expectedRevision: projection.revision,
      transactionId: `task-launch-claim:${identity}:${leaseEpoch}`,
      events: [event],
    });
  }

  private async executeLaunch(
    projection: TaskRunProjection,
    successor: TaskAttemptProjection,
    prepared: PreparedTaskResume,
  ): Promise<SafeBoundaryResumeResult> {
    const launch = successor.launch;
    if (
      !launch ||
      launch.status !== "claimed" ||
      launch.ownerId !== this.options.ownerId ||
      launch.expiresAt <= this.now().toISOString()
    ) {
      throw new Error(`Attempt ${successor.attemptId} has no live launch lease for this host`);
    }
    const checkpointRef = prepared.plan.boundary.checkpointRef;
    if (!checkpointRef) {
      throw new Error(
        `Safe resume plan for ${projection.header.taskRunId} lost its checkpoint reference`,
      );
    }
    try {
      await prepared.adapter.resume(prepared.input, {
        taskRunId: projection.header.taskRunId,
        sourceAttemptId: prepared.source.attemptId,
        attemptId: successor.attemptId,
        attemptNumber: successor.attemptNumber,
        launchId: launch.launchId,
        ownerId: launch.ownerId,
        leaseEpoch: launch.leaseEpoch,
        boundary: prepared.plan.boundary,
        checkpointRef,
      });
    } catch (error) {
      const message = errorMessage(error) || "Recoverable task adapter launch failed";
      await this.settleLaunch(
        projection.header.taskRunId,
        successor.attemptId,
        launch,
        "failed",
        message,
      );
      return {
        status: "launch_failed",
        taskRunId: projection.header.taskRunId,
        sourceAttemptId: prepared.source.attemptId,
        attemptId: successor.attemptId,
        launchId: launch.launchId,
        ownerId: launch.ownerId,
        leaseEpoch: launch.leaseEpoch,
        error: message,
      };
    }
    await this.settleLaunch(projection.header.taskRunId, successor.attemptId, launch, "succeeded");
    return {
      status: "resumed",
      taskRunId: projection.header.taskRunId,
      sourceAttemptId: prepared.source.attemptId,
      attemptId: successor.attemptId,
      attemptNumber: successor.attemptNumber,
      launchId: launch.launchId,
      ownerId: launch.ownerId,
      leaseEpoch: launch.leaseEpoch,
    };
  }

  private async settleLaunch(
    taskRunId: string,
    attemptId: string,
    launch: NonNullable<TaskAttemptProjection["launch"]>,
    status: "succeeded" | "failed",
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
        current.launch.expiresAt <= this.now().toISOString()
      ) {
        throw new Error(`Attempt ${attemptId} launch lease was lost before ${status} settlement`);
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
      const result = await this.options.ledger.appendBatch({
        taskRunId,
        expectedRevision: projection.revision,
        transactionId: `task-launch-${status}:${launch.launchId}:${launch.leaseEpoch}`,
        events: [event],
      });
      if (result.status === "committed") return;
    }
    throw new Error(`Attempt ${attemptId} launch settlement exceeded contention retries`);
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
    ownerId: successor.ownerId,
    leaseEpoch: successor.leaseEpoch,
  };
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
