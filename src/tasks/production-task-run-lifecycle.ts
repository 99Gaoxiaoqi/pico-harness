import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalizeWorkspacePath } from "../paths/pico-paths.js";
import type { JobExecutionClass } from "./runtime-types.js";
import {
  TASK_RUN_EVENT_SCHEMA_VERSION,
  type TaskAttemptProjection,
  type TaskRunEvent,
  type TaskRunProjection,
  type TaskRunTerminalStatus,
  type TaskRuntimeBoundary,
  type TaskSafeBoundary,
} from "./task-run-contract.js";
import {
  hashTaskRunInput,
  TaskRunStore,
  TaskRunStoreIntegrityError,
  TaskRunStoreRevisionConflictError,
  type TaskRunSnapshot,
} from "./task-run-store.js";

export interface ProductionAgentTaskRecovery {
  /** No production Agent run is recoverable without this explicit marker. */
  readonly executionClass: "recoverable";
  readonly adapter: {
    readonly id: string;
    readonly version: number;
    readonly input: Readonly<Record<string, unknown>>;
  };
  readonly maxAttempts: number;
}

export interface StartProductionTaskRunInput {
  /** Use the durable Job identity here when a Job/outbox is also composed. */
  readonly taskRunId: string;
  /** Use the durable Job Attempt identity here when one is also composed. */
  readonly attemptId: string;
  readonly workDir: string;
  readonly recovery?: ProductionAgentTaskRecovery;
}

export interface ProductionTaskRunClaim {
  readonly taskRunId: string;
  readonly attemptId: string;
  readonly ownerId: string;
  readonly leaseEpoch: number;
  readonly expiresAt: string;
}

export type StartProductionTaskRunResult =
  | {
      readonly status: "host_bound";
      readonly executionClass: "host_bound";
      readonly taskRunId: string;
    }
  | {
      readonly status: "started" | "replayed";
      readonly executionClass: "recoverable";
      readonly projection: TaskRunProjection;
      readonly claim: ProductionTaskRunClaim;
    }
  | {
      readonly status: "inactive";
      readonly executionClass: "recoverable";
      readonly reason: "recovery_required" | "owned_elsewhere";
      readonly projection: TaskRunProjection;
    }
  | {
      readonly status: "terminal";
      readonly executionClass: "recoverable";
      readonly projection: TaskRunProjection;
    };

export interface ProductionTaskRunHeartbeatInput {
  readonly claim: ProductionTaskRunClaim;
  /** Stable and unique for one logical heartbeat retry. */
  readonly idempotencyKey: string;
}

export interface ProductionTaskRunCheckpointInput {
  readonly claim: ProductionTaskRunClaim;
  /** Stable and unique for one logical checkpoint retry. */
  readonly idempotencyKey: string;
  readonly workspacePath: string;
  readonly runtime: TaskRuntimeBoundary;
  readonly checkpointRef: string;
  readonly toolCatalogHash: string;
  readonly backgroundOperationsSettled: boolean;
}

export interface ReconcileExpiredProductionTaskRunAttemptInput {
  readonly taskRunId: string;
  readonly attemptId: string;
  /** Stable and unique for one Runtime reconciliation result. */
  readonly idempotencyKey: string;
  /** Prevents a completed/failed/cancelled Runtime from entering the continuation path. */
  readonly runtimeStatus: "interrupted";
  readonly workspacePath: string;
  readonly runtime: TaskRuntimeBoundary;
  readonly checkpointRef: string;
  readonly toolCatalogHash: string;
  readonly backgroundOperationsSettled: boolean;
  readonly error?: string;
}

export type ProductionRuntimeTerminalStatus = "completed" | "failed" | "cancelled";

export interface ReconcileExpiredProductionTaskRunTerminalInput {
  readonly taskRunId: string;
  readonly attemptId: string;
  /** Stable and unique for one canonical Runtime terminal reconciliation. */
  readonly idempotencyKey: string;
  readonly completionId: string;
  readonly runtimeStatus: ProductionRuntimeTerminalStatus;
  readonly workspacePath: string;
  readonly runtime: TaskRuntimeBoundary;
  readonly checkpointRef: string;
  readonly toolCatalogHash: string;
  readonly backgroundOperationsSettled: boolean;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface InterruptProductionTaskRunAttemptInput {
  readonly claim: ProductionTaskRunClaim;
  /** Stable and unique for one logical interruption retry. */
  readonly idempotencyKey: string;
  readonly error?: string;
}

export interface FinishProductionTaskRunInput {
  readonly claim: ProductionTaskRunClaim;
  /**
   * Stable completion/outbox identity. The same value is also the lifecycle idempotency key.
   */
  readonly completionId: string;
  readonly status: TaskRunTerminalStatus;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface SettleProductionTaskRunCompletionInput {
  readonly taskRunId: string;
  readonly completionId: string;
}

export interface ProductionTaskRunCompletion {
  readonly executionClass: "recoverable";
  readonly completionId: string;
  readonly taskRunId: string;
  readonly attemptId: string;
  readonly status: TaskRunTerminalStatus;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

/**
 * Composition-owned bridge to Job/outbox settlement.
 *
 * Implementations must deduplicate by completionId. The lifecycle invokes this only after the
 * TaskRun terminal batch is durable, and may invoke it again after an uncertain callback result.
 */
export interface ProductionTaskRunCompletionPort {
  settle(completion: ProductionTaskRunCompletion): void | Promise<void>;
}

export interface ProductionTaskRunLifecycleOptions {
  readonly store: TaskRunStore;
  readonly ownerId: string;
  readonly leaseTtlMs?: number;
  readonly now?: () => Date;
  readonly completionPort?: ProductionTaskRunCompletionPort;
}

export interface ProductionTaskRunMutationResult {
  readonly inserted: boolean;
  readonly projection: TaskRunProjection;
}

export interface ProductionTaskRunHeartbeatResult extends ProductionTaskRunMutationResult {
  readonly claim: ProductionTaskRunClaim;
}

export interface ReconcileExpiredProductionTaskRunAttemptResult extends ProductionTaskRunMutationResult {
  readonly sourceAttemptId: string;
  readonly leaseEpoch: number;
}

export interface ReconcileExpiredProductionTaskRunTerminalResult extends FinishProductionTaskRunResult {
  readonly leaseEpoch: number;
}

export interface FinishProductionTaskRunResult extends ProductionTaskRunMutationResult {
  readonly completionId: string;
  readonly completion: "settled" | "not_configured";
}

export class ProductionTaskRunConflictError extends Error {
  constructor(
    message: string,
    readonly projection: TaskRunProjection,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProductionTaskRunConflictError";
  }
}

export class ProductionTaskRunCompletionError extends Error {
  constructor(
    readonly completionId: string,
    readonly projection: TaskRunProjection,
    options?: ErrorOptions,
  ) {
    super(
      `TaskRun ${projection.header.taskRunId} is terminal but completion ${completionId} did not settle`,
      options,
    );
    this.name = "ProductionTaskRunCompletionError";
  }
}

/**
 * Durable lifecycle bridge for explicitly recoverable production Agent runs.
 *
 * TaskRunStore remains the only owner of JSON/JSONL state and transition validation. This class
 * supplies stable event identities, revision CAS, execution fencing, and the narrow composition
 * callback needed to converge an optional Job/outbox after the TaskRun terminal fact is durable.
 */
export class ProductionTaskRunLifecycle {
  private readonly store: TaskRunStore;
  private readonly ownerId: string;
  private readonly leaseTtlMs: number;
  private readonly now: () => Date;
  private readonly completionPort?: ProductionTaskRunCompletionPort;

  constructor(options: ProductionTaskRunLifecycleOptions) {
    this.store = options.store;
    this.ownerId = nonEmpty(options.ownerId, "ownerId");
    this.leaseTtlMs = positiveSafeInteger(options.leaseTtlMs ?? 30_000, "leaseTtlMs");
    this.now = options.now ?? (() => new Date());
    this.completionPort = options.completionPort;
  }

  async start(input: StartProductionTaskRunInput): Promise<StartProductionTaskRunResult> {
    const taskRunId = nonEmpty(input.taskRunId, "taskRunId");
    if (!input.recovery) {
      return {
        status: "host_bound",
        executionClass: "host_bound",
        taskRunId,
      };
    }
    const attemptId = nonEmpty(input.attemptId, "attemptId");
    const recovery = validateRecovery(input.recovery);
    const atDate = this.currentDate();
    const at = atDate.toISOString();

    await this.store.initializeTaskRun({
      taskRunId,
      workDir: input.workDir,
      adapter: {
        id: recovery.adapter.id,
        version: recovery.adapter.version,
        input: recovery.adapter.input,
        inputHash: hashTaskRunInput(recovery.adapter.input),
      },
      maxAttempts: recovery.maxAttempts,
      now: () => atDate,
    });

    const snapshot = await this.requireSnapshot(taskRunId);
    if (snapshot.projection.terminal) {
      return {
        status: "terminal",
        executionClass: "recoverable",
        projection: snapshot.projection,
      };
    }

    const events = initialAttemptEvents({
      taskRunId,
      attemptId,
      ownerId: this.ownerId,
      at,
      expiresAt: addMilliseconds(atDate, this.leaseTtlMs).toISOString(),
    });
    const replayed = replayedEvents(snapshot, events);
    if (replayed) return this.classifyExistingStart(snapshot.projection, attemptId, at, "replayed");

    if (snapshot.projection.attempts.length > 0) {
      return this.classifyExistingStart(snapshot.projection, attemptId, at, "replayed");
    }

    const appended = await this.appendWithCas(
      snapshot,
      events,
      operationId("production-task-run:start", taskRunId, attemptId),
    );
    if (!appended.inserted) {
      return this.classifyExistingStart(appended.snapshot.projection, attemptId, at, "replayed");
    }
    return {
      status: "started",
      executionClass: "recoverable",
      projection: appended.snapshot.projection,
      claim: claimForAttempt(appended.snapshot.projection, attemptId, this.ownerId, 1),
    };
  }

  async heartbeat(
    input: ProductionTaskRunHeartbeatInput,
  ): Promise<ProductionTaskRunHeartbeatResult> {
    const idempotencyKey = nonEmpty(input.idempotencyKey, "heartbeat idempotencyKey");
    const atDate = this.currentDate();
    const at = atDate.toISOString();
    const snapshot = await this.requireSnapshot(input.claim.taskRunId);
    const attempt = findAttempt(snapshot.projection, input.claim.attemptId);
    const currentExpiry = new Date(attempt.execution.expiresAt);
    const expiresAt = new Date(
      Math.max(atDate.getTime() + this.leaseTtlMs, currentExpiry.getTime() + 1),
    ).toISOString();
    const event: TaskRunEvent = {
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: operationId(
        "production-task-run:heartbeat:event",
        input.claim.taskRunId,
        input.claim.attemptId,
        String(input.claim.leaseEpoch),
        idempotencyKey,
      ),
      taskRunId: input.claim.taskRunId,
      at,
      kind: "attempt.execution.renewed",
      data: {
        attemptId: input.claim.attemptId,
        ownerId: input.claim.ownerId,
        leaseEpoch: input.claim.leaseEpoch,
        expiresAt,
      },
    };
    const replayed = replayedEvents(snapshot, [event]);
    if (replayed) {
      return {
        inserted: false,
        projection: snapshot.projection,
        claim: claimForAttempt(
          snapshot.projection,
          input.claim.attemptId,
          input.claim.ownerId,
          input.claim.leaseEpoch,
        ),
      };
    }
    requireLiveClaim(snapshot.projection, input.claim, this.ownerId, at);
    const appended = await this.appendWithCas(
      snapshot,
      [event],
      operationId(
        "production-task-run:heartbeat",
        input.claim.taskRunId,
        input.claim.attemptId,
        String(input.claim.leaseEpoch),
        idempotencyKey,
      ),
    );
    return {
      inserted: appended.inserted,
      projection: appended.snapshot.projection,
      claim: claimForAttempt(
        appended.snapshot.projection,
        input.claim.attemptId,
        input.claim.ownerId,
        input.claim.leaseEpoch,
      ),
    };
  }

  async checkpoint(
    input: ProductionTaskRunCheckpointInput,
  ): Promise<ProductionTaskRunMutationResult> {
    const idempotencyKey = nonEmpty(input.idempotencyKey, "checkpoint idempotencyKey");
    const atDate = this.currentDate();
    const at = atDate.toISOString();
    const snapshot = await this.requireSnapshot(input.claim.taskRunId);
    const boundary = this.safeBoundary(input, snapshot.projection);
    const event: TaskRunEvent = {
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: operationId(
        "production-task-run:checkpoint:event",
        input.claim.taskRunId,
        input.claim.attemptId,
        String(input.claim.leaseEpoch),
        idempotencyKey,
      ),
      taskRunId: input.claim.taskRunId,
      at,
      kind: "attempt.checkpointed",
      data: {
        attemptId: input.claim.attemptId,
        ownerId: input.claim.ownerId,
        leaseEpoch: input.claim.leaseEpoch,
        boundary,
      },
    };
    const replayed = replayedEvents(snapshot, [event]);
    if (replayed) return { inserted: false, projection: snapshot.projection };
    requireLiveClaim(snapshot.projection, input.claim, this.ownerId, at);
    const appended = await this.appendWithCas(
      snapshot,
      [event],
      operationId(
        "production-task-run:checkpoint",
        input.claim.taskRunId,
        input.claim.attemptId,
        String(input.claim.leaseEpoch),
        idempotencyKey,
      ),
    );
    return {
      inserted: appended.inserted,
      projection: appended.snapshot.projection,
    };
  }

  /**
   * Takes over one expired Attempt after RuntimeRun reconciliation.
   *
   * The refreshed Runtime high-water/checkpoint and the interrupted Attempt become visible in one
   * TaskRun revision. A recovery coordinator can therefore never observe the old boundary paired
   * with the new interrupted status.
   */
  async reconcileExpiredAttempt(
    input: ReconcileExpiredProductionTaskRunAttemptInput,
  ): Promise<ReconcileExpiredProductionTaskRunAttemptResult> {
    const taskRunId = nonEmpty(input.taskRunId, "taskRunId");
    const attemptId = nonEmpty(input.attemptId, "attemptId");
    const idempotencyKey = nonEmpty(
      input.idempotencyKey,
      "expired-attempt reconciliation idempotencyKey",
    );
    const atDate = this.currentDate();
    const at = atDate.toISOString();
    const snapshot = await this.requireSnapshot(taskRunId);
    const boundary = this.safeBoundary(input, snapshot.projection);
    if (input.runtimeStatus !== "interrupted" || !boundary.runtime?.terminalEventId) {
      throw new ProductionTaskRunConflictError(
        `TaskRun ${taskRunId} interrupted reconciliation requires a canonical interrupted Runtime terminal`,
        snapshot.projection,
      );
    }
    const eventIds = expiredAttemptEventIds(taskRunId, attemptId, idempotencyKey);
    const persisted = eventsByIds(snapshot, eventIds);
    if (persisted) {
      const leaseEpoch = assertExpiredAttemptReplay(
        snapshot.projection,
        persisted,
        attemptId,
        this.ownerId,
        boundary,
        input.error,
      );
      return {
        inserted: false,
        projection: snapshot.projection,
        sourceAttemptId: attemptId,
        leaseEpoch,
      };
    }

    const source = findAttempt(snapshot.projection, attemptId);
    if (source.status !== "running" || source.execution.expiresAt > at) {
      throw new ProductionTaskRunConflictError(
        `TaskRun Attempt ${attemptId} is not an expired running Attempt`,
        snapshot.projection,
      );
    }
    const leaseEpoch = source.execution.leaseEpoch + 1;
    const expiresAt = addMilliseconds(atDate, this.leaseTtlMs).toISOString();
    const events: readonly TaskRunEvent[] = [
      {
        schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
        eventId: eventIds[0],
        taskRunId,
        at,
        kind: "attempt.execution.claimed",
        data: {
          attemptId,
          ownerId: this.ownerId,
          leaseEpoch,
          expiresAt,
        },
      },
      {
        schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
        eventId: eventIds[1],
        taskRunId,
        at,
        kind: "attempt.checkpointed",
        data: {
          attemptId,
          ownerId: this.ownerId,
          leaseEpoch,
          boundary,
        },
      },
      {
        schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
        eventId: eventIds[2],
        taskRunId,
        at,
        kind: "attempt.finished",
        data: {
          attemptId,
          ownerId: this.ownerId,
          leaseEpoch,
          status: "interrupted",
          ...(input.error !== undefined ? { error: input.error } : {}),
        },
      },
    ];
    const appended = await this.appendWithCas(
      snapshot,
      events,
      operationId(
        "production-task-run:expired-attempt-reconciled",
        taskRunId,
        attemptId,
        idempotencyKey,
      ),
    );
    return {
      inserted: appended.inserted,
      projection: appended.snapshot.projection,
      sourceAttemptId: attemptId,
      leaseEpoch,
    };
  }

  /**
   * Closes an expired Attempt from a canonical non-interrupted Runtime terminal.
   *
   * A completed/failed/cancelled Runtime must never be converted to interrupted and relaunched.
   * The takeover claim, final boundary, Attempt terminal, and TaskRun terminal are one revision.
   */
  async reconcileExpiredTerminalAttempt(
    input: ReconcileExpiredProductionTaskRunTerminalInput,
  ): Promise<ReconcileExpiredProductionTaskRunTerminalResult> {
    const taskRunId = nonEmpty(input.taskRunId, "taskRunId");
    const attemptId = nonEmpty(input.attemptId, "attemptId");
    const idempotencyKey = nonEmpty(
      input.idempotencyKey,
      "expired terminal reconciliation idempotencyKey",
    );
    const completionId = nonEmpty(input.completionId, "completionId");
    const status = taskStatusFromRuntimeTerminal(input.runtimeStatus);
    const atDate = this.currentDate();
    const at = atDate.toISOString();
    const snapshot = await this.requireSnapshot(taskRunId);
    const boundary = this.safeBoundary(input, snapshot.projection);
    if (!boundary.runtime?.terminalEventId) {
      throw new ProductionTaskRunConflictError(
        `TaskRun ${taskRunId} Runtime terminal reconciliation requires terminalEventId`,
        snapshot.projection,
      );
    }
    const eventIds = expiredTerminalEventIds(taskRunId, attemptId, idempotencyKey);
    const persisted = eventsByIds(snapshot, eventIds);
    let terminalSnapshot = snapshot;
    let inserted = false;
    let leaseEpoch: number;
    if (persisted) {
      leaseEpoch = assertExpiredTerminalReplay({
        projection: snapshot.projection,
        events: persisted,
        attemptId,
        ownerId: this.ownerId,
        boundary,
        completionId,
        status,
        result: input.result,
        error: input.error,
      });
    } else {
      const source = findAttempt(snapshot.projection, attemptId);
      if (source.status !== "running" || source.execution.expiresAt > at) {
        throw new ProductionTaskRunConflictError(
          `TaskRun Attempt ${attemptId} is not an expired running Attempt`,
          snapshot.projection,
        );
      }
      leaseEpoch = source.execution.leaseEpoch + 1;
      const events: readonly TaskRunEvent[] = [
        {
          schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
          eventId: eventIds[0],
          taskRunId,
          at,
          kind: "attempt.execution.claimed",
          data: {
            attemptId,
            ownerId: this.ownerId,
            leaseEpoch,
            expiresAt: addMilliseconds(atDate, this.leaseTtlMs).toISOString(),
          },
        },
        {
          schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
          eventId: eventIds[1],
          taskRunId,
          at,
          kind: "attempt.checkpointed",
          data: {
            attemptId,
            ownerId: this.ownerId,
            leaseEpoch,
            boundary,
          },
        },
        {
          schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
          eventId: eventIds[2],
          taskRunId,
          at,
          kind: "attempt.finished",
          data: {
            attemptId,
            ownerId: this.ownerId,
            leaseEpoch,
            status,
            ...(input.result !== undefined ? { result: input.result } : {}),
            ...(input.error !== undefined ? { error: input.error } : {}),
          },
        },
        {
          schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
          eventId: eventIds[3],
          taskRunId,
          at,
          kind: "task.finished",
          data: {
            status,
            attemptId,
            completionId,
            ...(input.result !== undefined ? { result: input.result } : {}),
            ...(input.error !== undefined ? { error: input.error } : {}),
          },
        },
      ];
      const appended = await this.appendWithCas(
        snapshot,
        events,
        operationId(
          "production-task-run:expired-terminal-reconciled",
          taskRunId,
          attemptId,
          idempotencyKey,
        ),
      );
      terminalSnapshot = appended.snapshot;
      inserted = appended.inserted;
    }
    const completion: ProductionTaskRunCompletion = {
      executionClass: "recoverable",
      completionId,
      taskRunId,
      attemptId,
      status,
      ...(input.result !== undefined ? { result: structuredClone(input.result) } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    };
    await this.settleCompletion(completion, terminalSnapshot.projection);
    return {
      inserted,
      projection: terminalSnapshot.projection,
      completionId,
      completion: this.completionPort ? "settled" : "not_configured",
      leaseEpoch,
    };
  }

  async interruptAttempt(
    input: InterruptProductionTaskRunAttemptInput,
  ): Promise<ProductionTaskRunMutationResult> {
    const idempotencyKey = nonEmpty(input.idempotencyKey, "interruption idempotencyKey");
    const atDate = this.currentDate();
    const at = atDate.toISOString();
    const snapshot = await this.requireSnapshot(input.claim.taskRunId);
    const event: TaskRunEvent = {
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: operationId(
        "production-task-run:interrupted:event",
        input.claim.taskRunId,
        input.claim.attemptId,
        String(input.claim.leaseEpoch),
        idempotencyKey,
      ),
      taskRunId: input.claim.taskRunId,
      at,
      kind: "attempt.finished",
      data: {
        attemptId: input.claim.attemptId,
        ownerId: input.claim.ownerId,
        leaseEpoch: input.claim.leaseEpoch,
        status: "interrupted",
        ...(input.error !== undefined ? { error: input.error } : {}),
      },
    };
    const replayed = replayedEvents(snapshot, [event]);
    if (replayed) return { inserted: false, projection: snapshot.projection };
    requireLiveClaim(snapshot.projection, input.claim, this.ownerId, at);
    const appended = await this.appendWithCas(
      snapshot,
      [event],
      operationId(
        "production-task-run:interrupted",
        input.claim.taskRunId,
        input.claim.attemptId,
        String(input.claim.leaseEpoch),
        idempotencyKey,
      ),
    );
    return {
      inserted: appended.inserted,
      projection: appended.snapshot.projection,
    };
  }

  async finishTask(input: FinishProductionTaskRunInput): Promise<FinishProductionTaskRunResult> {
    const completionId = nonEmpty(input.completionId, "completionId");
    const atDate = this.currentDate();
    const at = atDate.toISOString();
    const snapshot = await this.requireSnapshot(input.claim.taskRunId);
    const identity = [
      input.claim.taskRunId,
      input.claim.attemptId,
      String(input.claim.leaseEpoch),
      completionId,
    ] as const;
    const events: readonly TaskRunEvent[] = [
      {
        schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
        eventId: operationId("production-task-run:attempt-terminal:event", ...identity),
        taskRunId: input.claim.taskRunId,
        at,
        kind: "attempt.finished",
        data: {
          attemptId: input.claim.attemptId,
          ownerId: input.claim.ownerId,
          leaseEpoch: input.claim.leaseEpoch,
          status: input.status,
          ...(input.result !== undefined ? { result: input.result } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
        },
      },
      {
        schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
        eventId: operationId("production-task-run:task-terminal:event", ...identity),
        taskRunId: input.claim.taskRunId,
        at,
        kind: "task.finished",
        data: {
          status: input.status,
          attemptId: input.claim.attemptId,
          completionId,
          ...(input.result !== undefined ? { result: input.result } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
        },
      },
    ];
    const replayed = replayedEvents(snapshot, events);
    let terminalSnapshot = snapshot;
    let inserted = false;
    if (!replayed) {
      requireLiveClaim(snapshot.projection, input.claim, this.ownerId, at);
      const appended = await this.appendWithCas(
        snapshot,
        events,
        operationId("production-task-run:terminal", ...identity),
      );
      terminalSnapshot = appended.snapshot;
      inserted = appended.inserted;
    }
    if (!terminalSnapshot.projection.terminal) {
      throw new TaskRunStoreIntegrityError(
        `TaskRun ${input.claim.taskRunId} terminal transaction did not publish a terminal fact`,
      );
    }
    const completion = completionFromInput(input);
    await this.settleCompletion(completion, terminalSnapshot.projection);
    return {
      inserted,
      projection: terminalSnapshot.projection,
      completionId,
      completion: this.completionPort ? "settled" : "not_configured",
    };
  }

  /**
   * Replays the composition settlement from a durable TaskRun terminal fact after restart.
   */
  async settleTerminalCompletion(
    input: SettleProductionTaskRunCompletionInput,
  ): Promise<FinishProductionTaskRunResult> {
    const taskRunId = nonEmpty(input.taskRunId, "taskRunId");
    const completionId = nonEmpty(input.completionId, "completionId");
    const snapshot = await this.requireSnapshot(taskRunId);
    const terminal = snapshot.projection.terminal;
    if (!terminal || !terminal.attemptId || terminal.completionId !== completionId) {
      throw new ProductionTaskRunConflictError(
        `TaskRun ${taskRunId} has no matching durable completion ${completionId}`,
        snapshot.projection,
      );
    }
    const completion: ProductionTaskRunCompletion = {
      executionClass: "recoverable",
      completionId,
      taskRunId,
      attemptId: terminal.attemptId,
      status: terminal.status,
      ...(terminal.result !== undefined ? { result: structuredClone(terminal.result) } : {}),
      ...(terminal.error !== undefined ? { error: terminal.error } : {}),
    };
    await this.settleCompletion(completion, snapshot.projection);
    return {
      inserted: false,
      projection: snapshot.projection,
      completionId,
      completion: this.completionPort ? "settled" : "not_configured",
    };
  }

  private classifyExistingStart(
    projection: TaskRunProjection,
    attemptId: string,
    now: string,
    status: "replayed",
  ): StartProductionTaskRunResult {
    if (projection.terminal) {
      return {
        status: "terminal",
        executionClass: "recoverable",
        projection,
      };
    }
    const attempt = projection.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (
      attempt?.status === "running" &&
      attempt.execution.ownerId === this.ownerId &&
      attempt.execution.leaseEpoch === 1 &&
      attempt.execution.expiresAt > now
    ) {
      return {
        status,
        executionClass: "recoverable",
        projection,
        claim: claimForAttempt(projection, attemptId, this.ownerId, 1),
      };
    }
    const active = projection.attempts.find((candidate) => candidate.status === "running");
    return {
      status: "inactive",
      executionClass: "recoverable",
      reason: active ? "owned_elsewhere" : "recovery_required",
      projection,
    };
  }

  private async appendWithCas(
    snapshot: TaskRunSnapshot,
    events: readonly TaskRunEvent[],
    transactionId: string,
  ): Promise<{ readonly inserted: boolean; readonly snapshot: TaskRunSnapshot }> {
    try {
      const results = await this.store.appendBatch(snapshot.projection.header.taskRunId, events, {
        transactionId,
        expectedRevision: snapshot.projection.revision,
        now: () => new Date(events[0]!.at),
      });
      const current = await this.requireSnapshot(snapshot.projection.header.taskRunId);
      return {
        inserted: results.some((result) => result.inserted),
        snapshot: current,
      };
    } catch (error) {
      if (!(error instanceof TaskRunStoreRevisionConflictError)) throw error;
      const current = await this.requireSnapshot(snapshot.projection.header.taskRunId);
      if (replayedEvents(current, events)) {
        return { inserted: false, snapshot: current };
      }
      throw new ProductionTaskRunConflictError(
        `TaskRun ${snapshot.projection.header.taskRunId} changed during ${transactionId}`,
        current.projection,
        { cause: error },
      );
    }
  }

  private async requireSnapshot(taskRunId: string): Promise<TaskRunSnapshot> {
    const snapshot = await this.store.readTaskRun(taskRunId);
    if (!snapshot) throw new Error(`TaskRun ${taskRunId} disappeared after initialization`);
    return snapshot;
  }

  private currentDate(): Date {
    const date = this.now();
    if (!Number.isFinite(date.getTime())) throw new Error("Production TaskRun clock is invalid");
    return new Date(date.getTime());
  }

  private async settleCompletion(
    completion: ProductionTaskRunCompletion,
    projection: TaskRunProjection,
  ): Promise<void> {
    if (!this.completionPort) return;
    try {
      await this.completionPort.settle(completion);
    } catch (error) {
      throw new ProductionTaskRunCompletionError(completion.completionId, projection, {
        cause: error,
      });
    }
  }

  private safeBoundary(
    input: Pick<
      ProductionTaskRunCheckpointInput,
      | "workspacePath"
      | "runtime"
      | "checkpointRef"
      | "toolCatalogHash"
      | "backgroundOperationsSettled"
    >,
    projection: TaskRunProjection,
  ): TaskSafeBoundary {
    const checkpointRef = nonEmpty(input.checkpointRef, "checkpointRef");
    const toolCatalogHash = nonEmpty(input.toolCatalogHash, "toolCatalogHash");
    const runtime = validateRuntimeBoundary(input.runtime);
    const workspacePath = canonicalizeWorkspacePath(input.workspacePath);
    if (workspacePath !== projection.header.workDir) {
      throw new ProductionTaskRunConflictError(
        `TaskRun ${projection.header.taskRunId} checkpoint belongs to another workspace`,
        projection,
      );
    }
    return {
      storageRootId: this.store.storageRootId,
      workspacePath,
      backgroundOperationsSettled: input.backgroundOperationsSettled,
      runtime,
      toolCatalogHash,
      checkpointRef,
    };
  }
}

export function productionAgentExecutionClass(
  recovery?: ProductionAgentTaskRecovery,
): JobExecutionClass {
  return recovery?.executionClass === "recoverable" ? "recoverable" : "host_bound";
}

function validateRecovery(recovery: ProductionAgentTaskRecovery): ProductionAgentTaskRecovery {
  if (recovery.executionClass !== "recoverable") {
    throw new Error("Production Agent recovery requires explicit executionClass=recoverable");
  }
  nonEmpty(recovery.adapter.id, "adapter.id");
  positiveSafeInteger(recovery.adapter.version, "adapter.version");
  positiveSafeInteger(recovery.maxAttempts, "maxAttempts");
  return recovery;
}

function validateRuntimeBoundary(runtime: TaskRuntimeBoundary): TaskRuntimeBoundary {
  const sessionId = nonEmpty(runtime.sessionId, "runtime.sessionId");
  const runId = nonEmpty(runtime.runId, "runtime.runId");
  const eventHighWater = nonNegativeSafeInteger(runtime.eventHighWater, "runtime.eventHighWater");
  const terminalEventId =
    runtime.terminalEventId === undefined
      ? undefined
      : nonEmpty(runtime.terminalEventId, "runtime.terminalEventId");
  return {
    sessionId,
    runId,
    eventHighWater,
    ...(terminalEventId ? { terminalEventId } : {}),
  };
}

function initialAttemptEvents(input: {
  readonly taskRunId: string;
  readonly attemptId: string;
  readonly ownerId: string;
  readonly at: string;
  readonly expiresAt: string;
}): readonly TaskRunEvent[] {
  const identity = [input.taskRunId, input.attemptId] as const;
  return [
    {
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: operationId("production-task-run:attempt-started:event", ...identity),
      taskRunId: input.taskRunId,
      at: input.at,
      kind: "attempt.started",
      data: {
        attemptId: input.attemptId,
        attemptNumber: 1,
      },
    },
    {
      schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
      eventId: operationId("production-task-run:execution-claimed:event", ...identity),
      taskRunId: input.taskRunId,
      at: input.at,
      kind: "attempt.execution.claimed",
      data: {
        attemptId: input.attemptId,
        ownerId: input.ownerId,
        leaseEpoch: 1,
        expiresAt: input.expiresAt,
      },
    },
  ];
}

function replayedEvents(snapshot: TaskRunSnapshot, requested: readonly TaskRunEvent[]): boolean {
  const persistedById = new Map(snapshot.events.map(({ event }) => [event.eventId, event]));
  const persisted = requested.map((event) => persistedById.get(event.eventId));
  if (persisted.every((event) => event === undefined)) return false;
  if (persisted.some((event) => event === undefined)) {
    throw new TaskRunStoreIntegrityError(
      `TaskRun ${snapshot.projection.header.taskRunId} has a partial lifecycle transaction`,
    );
  }
  for (let index = 0; index < requested.length; index += 1) {
    const existing = persisted[index]!;
    const candidate = requested[index]!;
    if (!sameEventIntent(existing, candidate)) {
      throw new TaskRunStoreIntegrityError(
        `TaskRun event ${candidate.eventId} is already bound to another lifecycle operation`,
      );
    }
  }
  return true;
}

function expiredAttemptEventIds(
  taskRunId: string,
  attemptId: string,
  idempotencyKey: string,
): readonly [string, string, string] {
  const identity = [taskRunId, attemptId, idempotencyKey] as const;
  return [
    operationId("production-task-run:expired-claim:event", ...identity),
    operationId("production-task-run:expired-checkpoint:event", ...identity),
    operationId("production-task-run:expired-interrupted:event", ...identity),
  ];
}

function expiredTerminalEventIds(
  taskRunId: string,
  attemptId: string,
  idempotencyKey: string,
): readonly [string, string, string, string] {
  const identity = [taskRunId, attemptId, idempotencyKey] as const;
  return [
    operationId("production-task-run:expired-terminal-claim:event", ...identity),
    operationId("production-task-run:expired-terminal-checkpoint:event", ...identity),
    operationId("production-task-run:expired-terminal-attempt:event", ...identity),
    operationId("production-task-run:expired-terminal-task:event", ...identity),
  ];
}

function eventsByIds(
  snapshot: TaskRunSnapshot,
  eventIds: readonly string[],
): readonly TaskRunEvent[] | undefined {
  const persistedById = new Map(snapshot.events.map(({ event }) => [event.eventId, event]));
  const persisted = eventIds.map((eventId) => persistedById.get(eventId));
  if (persisted.every((event) => event === undefined)) return undefined;
  if (persisted.some((event) => event === undefined)) {
    throw new TaskRunStoreIntegrityError(
      `TaskRun ${snapshot.projection.header.taskRunId} has a partial lifecycle transaction`,
    );
  }
  return persisted as readonly TaskRunEvent[];
}

function assertExpiredAttemptReplay(
  projection: TaskRunProjection,
  events: readonly TaskRunEvent[],
  attemptId: string,
  ownerId: string,
  boundary: TaskSafeBoundary,
  error: string | undefined,
): number {
  const [claimed, checkpointed, interrupted] = events;
  if (
    claimed?.kind !== "attempt.execution.claimed" ||
    checkpointed?.kind !== "attempt.checkpointed" ||
    interrupted?.kind !== "attempt.finished" ||
    interrupted.data.status !== "interrupted" ||
    claimed.data.attemptId !== attemptId ||
    checkpointed.data.attemptId !== attemptId ||
    interrupted.data.attemptId !== attemptId ||
    claimed.data.ownerId !== ownerId ||
    checkpointed.data.ownerId !== ownerId ||
    interrupted.data.ownerId !== ownerId ||
    claimed.data.leaseEpoch !== checkpointed.data.leaseEpoch ||
    claimed.data.leaseEpoch !== interrupted.data.leaseEpoch ||
    !isDeepStrictEqual(checkpointed.data.boundary, boundary) ||
    interrupted.data.error !== error
  ) {
    throw new TaskRunStoreIntegrityError(
      `TaskRun ${projection.header.taskRunId} expired-attempt idempotency key changed payload`,
    );
  }
  return claimed.data.leaseEpoch;
}

function assertExpiredTerminalReplay(input: {
  readonly projection: TaskRunProjection;
  readonly events: readonly TaskRunEvent[];
  readonly attemptId: string;
  readonly ownerId: string;
  readonly boundary: TaskSafeBoundary;
  readonly completionId: string;
  readonly status: TaskRunTerminalStatus;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}): number {
  const [claimed, checkpointed, attemptFinished, taskFinished] = input.events;
  if (
    claimed?.kind !== "attempt.execution.claimed" ||
    checkpointed?.kind !== "attempt.checkpointed" ||
    attemptFinished?.kind !== "attempt.finished" ||
    taskFinished?.kind !== "task.finished" ||
    claimed.data.attemptId !== input.attemptId ||
    checkpointed.data.attemptId !== input.attemptId ||
    attemptFinished.data.attemptId !== input.attemptId ||
    taskFinished.data.attemptId !== input.attemptId ||
    claimed.data.ownerId !== input.ownerId ||
    checkpointed.data.ownerId !== input.ownerId ||
    attemptFinished.data.ownerId !== input.ownerId ||
    claimed.data.leaseEpoch !== checkpointed.data.leaseEpoch ||
    claimed.data.leaseEpoch !== attemptFinished.data.leaseEpoch ||
    attemptFinished.data.status !== input.status ||
    taskFinished.data.status !== input.status ||
    taskFinished.data.completionId !== input.completionId ||
    !isDeepStrictEqual(checkpointed.data.boundary, input.boundary) ||
    !isDeepStrictEqual(attemptFinished.data.result, input.result) ||
    !isDeepStrictEqual(taskFinished.data.result, input.result) ||
    attemptFinished.data.error !== input.error ||
    taskFinished.data.error !== input.error
  ) {
    throw new TaskRunStoreIntegrityError(
      `TaskRun ${input.projection.header.taskRunId} expired terminal idempotency key changed payload`,
    );
  }
  return claimed.data.leaseEpoch;
}

function sameEventIntent(left: TaskRunEvent, right: TaskRunEvent): boolean {
  if (
    left.schemaVersion !== right.schemaVersion ||
    left.eventId !== right.eventId ||
    left.taskRunId !== right.taskRunId ||
    left.kind !== right.kind
  ) {
    return false;
  }
  if (
    (left.kind === "attempt.execution.claimed" || left.kind === "attempt.execution.renewed") &&
    (right.kind === "attempt.execution.claimed" || right.kind === "attempt.execution.renewed")
  ) {
    return (
      left.data.attemptId === right.data.attemptId &&
      left.data.ownerId === right.data.ownerId &&
      left.data.leaseEpoch === right.data.leaseEpoch
    );
  }
  return isDeepStrictEqual(left.data, right.data);
}

function requireLiveClaim(
  projection: TaskRunProjection,
  claim: ProductionTaskRunClaim,
  lifecycleOwnerId: string,
  now: string,
): TaskAttemptProjection {
  if (claim.taskRunId !== projection.header.taskRunId || claim.ownerId !== lifecycleOwnerId) {
    throw new ProductionTaskRunConflictError(
      `TaskRun ${projection.header.taskRunId} rejected a claim from another lifecycle owner`,
      projection,
    );
  }
  const attempt = findAttempt(projection, claim.attemptId);
  if (
    attempt.status !== "running" ||
    attempt.execution.ownerId !== claim.ownerId ||
    attempt.execution.leaseEpoch !== claim.leaseEpoch ||
    attempt.execution.expiresAt !== claim.expiresAt ||
    attempt.execution.expiresAt <= now
  ) {
    throw new ProductionTaskRunConflictError(
      `TaskRun Attempt ${claim.attemptId} rejected a stale execution claim`,
      projection,
    );
  }
  return attempt;
}

function claimForAttempt(
  projection: TaskRunProjection,
  attemptId: string,
  ownerId: string,
  leaseEpoch: number,
): ProductionTaskRunClaim {
  const attempt = findAttempt(projection, attemptId);
  if (attempt.execution.ownerId !== ownerId || attempt.execution.leaseEpoch !== leaseEpoch) {
    throw new ProductionTaskRunConflictError(
      `TaskRun Attempt ${attemptId} belongs to another execution claim`,
      projection,
    );
  }
  return {
    taskRunId: projection.header.taskRunId,
    attemptId,
    ownerId,
    leaseEpoch,
    expiresAt: attempt.execution.expiresAt,
  };
}

function findAttempt(projection: TaskRunProjection, attemptId: string): TaskAttemptProjection {
  const attempt = projection.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (!attempt) {
    throw new ProductionTaskRunConflictError(
      `TaskRun ${projection.header.taskRunId} has no Attempt ${attemptId}`,
      projection,
    );
  }
  return attempt;
}

function completionFromInput(input: FinishProductionTaskRunInput): ProductionTaskRunCompletion {
  return {
    executionClass: "recoverable",
    completionId: input.completionId,
    taskRunId: input.claim.taskRunId,
    attemptId: input.claim.attemptId,
    status: input.status,
    ...(input.result !== undefined ? { result: structuredClone(input.result) } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

function taskStatusFromRuntimeTerminal(
  status: ProductionRuntimeTerminalStatus,
): TaskRunTerminalStatus {
  if (status === "completed") return "succeeded";
  return status;
}

function operationId(namespace: string, ...parts: readonly string[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([namespace, ...parts]))
    .digest("hex");
  return `${namespace}:${digest}`;
}

function addMilliseconds(date: Date, milliseconds: number): Date {
  const value = new Date(date.getTime() + milliseconds);
  if (!Number.isFinite(value.getTime()))
    throw new Error("Production TaskRun lease expiry is invalid");
  return value;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Production TaskRun ${field} must not be empty`);
  return normalized;
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Production TaskRun ${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Production TaskRun ${field} must be a non-negative safe integer`);
  }
  return value;
}
