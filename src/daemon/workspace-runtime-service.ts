import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { logger } from "../observability/logger.js";
import { resolvePicoHome, resolvePicoPaths } from "../paths/pico-paths.js";
import { DEFAULT_EVENT_LOG_RETENTION_POLICY } from "../storage/event-log-retention-policy.js";
import { readEventLogStorageStatus } from "../storage/sqlite/sqlite-event-log-retention-store.js";
import {
  WorkspaceTaskRuntime,
  type WorkspaceRunContext,
  type WorkspaceRunSnapshot,
} from "../runtime/workspace-runtime.js";
import {
  CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
  createRuntimeNotification,
  DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
  DESKTOP_RUNTIME_SCHEMA_REVISION,
  isEphemeralRuntimeNotificationTopic,
  isJsonObject,
  encodeRuntimeFrame,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  MAX_RUNTIME_FRAME_BYTES,
  TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  serializeRuntimeNotification,
  type JsonValue,
  type RuntimeNotification,
  type RuntimeNotificationPage,
  type RuntimeRequest,
  type WorkspaceStatusResult,
} from "./protocol.js";
import type {
  DisposableLocalRuntimeService,
  RuntimeNotificationCursor,
  ShutdownOwnershipFence,
} from "./service.js";
import {
  RuntimeConflictError,
  SqliteRuntimeControlStore,
} from "../storage/sqlite/sqlite-runtime-control-store.js";
import { type DaemonIdempotentCommandResult } from "../tasks/runtime-store-contracts.js";
import type { DaemonRunRecord, RuntimeEventRecord } from "../tasks/runtime-types.js";
import {
  canonicalizeWorkspacePath,
  resolveGitBranch,
  WorkspaceRuntimeRegistry,
} from "./workspace-registry.js";
import { WorkspaceRegistrationStore } from "./workspace-registration.js";
import {
  runWorkspaceBlobGcOnce,
  type WorkspaceBlobGcResult,
} from "../storage/workspace-blob-gc.js";
import type { AgentGraphApplicationService } from "../agent-graph/service.js";

export interface DaemonRunExecutor {
  (input: {
    workspacePath: string;
    workspaceRuntime: WorkspaceTaskRuntime;
    prompt: string;
    sessionId?: string;
    execution?: DaemonRunExecution;
    context: WorkspaceRunContext;
  }): Promise<Record<string, unknown> | void>;
}

export interface DaemonRunExecution {
  readonly requestedModel?: string;
  readonly allowedTools?: readonly string[];
  /** Desktop has already committed the visible user input to the canonical RuntimeEvent ledger. */
  readonly resumeExistingSession?: boolean;
  /** Trusted Plan review admission. Generic IPC clients cannot populate this field. */
  readonly planReview?: {
    readonly action: "execute" | "continue_editing" | "resume_execution" | "replan_execution";
    readonly planId: string;
    readonly expectedRevision: number;
    readonly expectedSessionSequence: number;
    readonly operationId: string;
    readonly feedback?: string;
  };
  readonly skillActivation?: {
    readonly name: string;
    readonly sourcePath?: string;
    readonly hooks?: unknown;
    readonly sourceId?: string;
  };
}

export interface StartDaemonRunInput {
  readonly workspacePath: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly execution?: DaemonRunExecution;
  readonly idempotencyKey?: string;
}

export interface PlanReviewRunIntentInput extends StartDaemonRunInput {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly planId: string;
  readonly revision: number;
  readonly action: DaemonRunExecution["planReview"] extends infer Review
    ? Review extends { readonly action: infer Action }
      ? Action
      : never
    : never;
}

export interface DurablePlanReviewRunIntent {
  readonly input: PlanReviewRunIntentInput;
  readonly runId: string;
}

export interface WorkspaceRuntimeServiceOptions {
  execute: DaemonRunExecutor;
  env?: Readonly<Record<string, string | undefined>>;
  createWorkspaceRuntime?: (workspacePath: string) => Promise<WorkspaceTaskRuntime>;
  createAgentGraphApplicationService?: (
    input: WorkspaceAgentGraphApplicationServiceFactoryInput,
  ) => Promise<AgentGraphApplicationService> | AgentGraphApplicationService;
  now?: () => number;
  registrationStore?: WorkspaceRegistrationStore;
  runBlobGc?: (input: {
    readonly workDir: string;
    readonly picoHome: string;
  }) => Promise<WorkspaceBlobGcResult>;
}

export interface WorkspaceAgentGraphApplicationServiceFactoryInput {
  readonly workspacePath: string;
  readonly workspaceRuntime: WorkspaceTaskRuntime;
  readonly runtimeStore: SqliteRuntimeControlStore;
  readonly picoHome: string;
}

const DEFAULT_REPLAY_EVENT_LIMIT = 1_000;
// Keep one query slot for hasMore detection; the public request limit remains 10_000.
const MAX_REPLAY_EVENT_LIMIT = 9_999;
const MAX_REPLAY_QUERY_LIMIT = 10_000;
const REPLAY_RESPONSE_METADATA_RESERVE_BYTES = 64 * 1024;
const MAX_REPLAY_EVENTS_BYTES = MAX_RUNTIME_FRAME_BYTES - REPLAY_RESPONSE_METADATA_RESERVE_BYTES;
const INTERRUPTED_DAEMON_RUN_ERROR = "daemon 重启前 Run 未进入终态，当前 executor 无法安全恢复";

function planReviewIntentRequest(input: PlanReviewRunIntentInput): Record<string, unknown> {
  return {
    workspacePath: input.workspacePath,
    sessionId: input.sessionId,
    prompt: input.prompt,
    operationId: input.operationId,
    planId: input.planId,
    revision: input.revision,
    action: input.action,
    idempotencyKey: input.idempotencyKey,
    ...(input.execution ? { execution: input.execution } : {}),
  };
}

function parsePlanReviewIntent(value: string): PlanReviewRunIntentInput | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) return undefined;
  const action = parsed["action"];
  const execution = parsed["execution"];
  const review = isJsonObject(execution) ? execution["planReview"] : undefined;
  if (
    typeof parsed["workspacePath"] !== "string" ||
    typeof parsed["sessionId"] !== "string" ||
    typeof parsed["prompt"] !== "string" ||
    typeof parsed["operationId"] !== "string" ||
    typeof parsed["planId"] !== "string" ||
    typeof parsed["revision"] !== "number" ||
    typeof parsed["idempotencyKey"] !== "string" ||
    (action !== "execute" &&
      action !== "continue_editing" &&
      action !== "resume_execution" &&
      action !== "replan_execution") ||
    !Number.isSafeInteger(parsed["revision"]) ||
    parsed["revision"] <= 0 ||
    !isJsonObject(execution) ||
    !isJsonObject(review) ||
    review["action"] !== action ||
    review["planId"] !== parsed["planId"] ||
    review["expectedRevision"] !== parsed["revision"] ||
    review["operationId"] !== parsed["operationId"] ||
    typeof review["expectedSessionSequence"] !== "number" ||
    !Number.isSafeInteger(review["expectedSessionSequence"]) ||
    (review["feedback"] !== undefined && typeof review["feedback"] !== "string")
  ) {
    return undefined;
  }
  return {
    workspacePath: parsed["workspacePath"],
    sessionId: parsed["sessionId"],
    prompt: parsed["prompt"],
    operationId: parsed["operationId"],
    planId: parsed["planId"],
    revision: parsed["revision"],
    action,
    idempotencyKey: parsed["idempotencyKey"],
    execution: {
      resumeExistingSession: execution["resumeExistingSession"] === true,
      planReview: {
        action,
        planId: parsed["planId"],
        expectedRevision: parsed["revision"],
        expectedSessionSequence: review["expectedSessionSequence"],
        operationId: parsed["operationId"],
        ...(typeof review["feedback"] === "string" ? { feedback: review["feedback"] } : {}),
      },
    },
  };
}

/**
 * Concrete daemon-facing owner for workspace Runs. It has no TUI dependency and is
 * intentionally injectable, so the daemon may use AgentRuntime today and another
 * client surface tomorrow without changing the IPC protocol.
 */
export class WorkspaceRuntimeService implements DisposableLocalRuntimeService {
  private readonly registry: WorkspaceRuntimeRegistry<WorkspaceTaskRuntime>;
  private readonly listeners = new Set<(notification: RuntimeNotification) => void>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly eventStores = new Map<string, SqliteRuntimeControlStore>();
  private readonly agentGraphApplications = new Map<string, AgentGraphApplicationService>();
  private readonly registrationStore: WorkspaceRegistrationStore;
  private readonly picoHome: string;
  private registrationChanged?: () => Promise<void>;
  private deferredNotifications?: RuntimeNotification[];
  private lifecycleState: "open" | "closing_runtimes" | "runtimes_closed" | "closed" = "open";
  private runtimeClosePromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private resourceClosePending = false;
  private resourceClosePromise: Promise<void> = Promise.resolve();
  private readonly blobGcTails = new Map<string, Promise<void>>();
  private readonly blobGcRerunRequested = new Set<string>();
  private readonly blobGcGenerations = new Map<string, number>();
  private readonly blobGcTimers = new Map<
    string,
    { readonly wakeAt: number; readonly timer: NodeJS.Timeout }
  >();

  constructor(private readonly options: WorkspaceRuntimeServiceOptions) {
    this.picoHome = resolvePicoHome({ env: options.env });
    this.registrationStore =
      options.registrationStore ??
      new WorkspaceRegistrationStore(join(this.picoHome, "daemon-workspaces.json"));
    this.registry = new WorkspaceRuntimeRegistry({
      create: async (workspacePath) => {
        const runtimeStore = this.eventStore(workspacePath);
        const runtime = await (options.createWorkspaceRuntime?.(workspacePath) ??
          WorkspaceTaskRuntime.create({
            workDir: workspacePath,
            taskHostRuntimeOptions: { picoHome: this.picoHome },
          }));
        const unsubscribe = runtime.subscribe((event) => {
          this.publish(
            createRuntimeNotification({
              topic: event.type,
              scope: {
                workspacePath: event.workspace,
                ...(event.run?.sessionId ? { sessionId: event.run.sessionId } : {}),
                ...(event.run ? { runId: event.run.runId } : {}),
              },
              resourceVersion: event.resourceVersion,
              at: event.at,
              payload: eventPayload(event),
            }),
            event.run ? daemonRunRecord(event.run) : undefined,
          );
          this.scheduleBlobGc(workspacePath);
        });
        this.unsubscribers.set(workspacePath, unsubscribe);
        let graphApplication: AgentGraphApplicationService | undefined;
        try {
          if (options.createAgentGraphApplicationService) {
            graphApplication = await options.createAgentGraphApplicationService({
              workspacePath,
              workspaceRuntime: runtime,
              runtimeStore,
              picoHome: this.picoHome,
            });
            await graphApplication.start();
            this.agentGraphApplications.set(workspacePath, graphApplication);
          }
          return runtime;
        } catch (error) {
          await this.cleanupFailedWorkspaceCreation({
            workspacePath,
            runtime,
            runtimeStore,
            unsubscribe,
            graphApplication,
          });
          throw error;
        }
      },
    });
  }

  async handle(request: RuntimeRequest): Promise<JsonValue> {
    if (request.method === "runtime.ping") {
      return {
        pong: true,
        protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
        desktopSchemaRevision: DESKTOP_RUNTIME_SCHEMA_REVISION,
        picoHome: this.picoHome,
        capabilities: [
          DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
          CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
          TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY,
          "shared-config-v1",
          "session-conversation-v1",
          "session-management-v1",
          "session-settings-v1",
          "session-goal-v1",
          "catalog-activation-v1",
          "workspace-diagnostics-v1",
          "runtime-events-v1",
          "desktop-live-reasoning-v1",
          "workspace-memory-v1",
        ],
      };
    }
    const params = objectParams(request.params);
    if (request.method === "workspace.register") {
      const workspacePath = requiredString(params, "workspacePath");
      const runtime = await this.getRuntime(workspacePath);
      const registered = await this.registrationStore.register(runtime.workspace);
      this.publish(
        createRuntimeNotification({
          topic: "workspace.registered",
          scope: { workspacePath: registered },
          resourceVersion: 1,
          at: this.options.now?.() ?? Date.now(),
          payload: { registered: true },
        }),
      );
      await this.registrationChanged?.();
      return { workspacePath: registered, registered: true };
    }
    if (request.method === "workspace.unregister") {
      const workspacePath = requiredString(params, "workspacePath");
      const registered = await this.registrationStore.unregister(workspacePath);
      this.publish(
        createRuntimeNotification({
          topic: "workspace.unregistered",
          scope: { workspacePath: registered },
          resourceVersion: 1,
          at: this.options.now?.() ?? Date.now(),
          payload: { registered: false },
        }),
      );
      await this.registrationChanged?.();
      await this.releaseWorkspaceResources(registered);
      return { workspacePath: registered, registered: false };
    }
    if (request.method === "workspace.status") {
      const runtime = await this.getRuntime(requiredString(params, "workspacePath"));
      const registered = (await this.registrationStore.list()).includes(runtime.workspace);
      const result = workspaceStatusResult(
        runtime,
        registered,
        runtime.mode === "git" ? await resolveGitBranch(runtime.workspace) : undefined,
      );
      const eventLog = readEventLogStorageStatus({
        storageRoot: resolvePicoPaths(runtime.workspace, { picoHome: this.picoHome }).workspace
          .root,
      });
      return {
        workspacePath: result.workspacePath,
        registered,
        schedulerStatus: result.schedulerStatus,
        mode: result.mode,
        capabilities: result.capabilities,
        branch: result.branch,
        eventLog: {
          logicalBytes: eventLog.logicalBytes,
          hardLimitBytes: DEFAULT_EVENT_LOG_RETENTION_POLICY.hardLimitBytes,
          lowWatermarkBytes: DEFAULT_EVENT_LOG_RETENTION_POLICY.lowWatermarkBytes,
          status: eventLog.plan.status,
          canStartNewWork: eventLog.plan.canStartNewWork,
          canWriteClosure: eventLog.plan.canWriteClosure,
          plannedSessionCount: eventLog.plan.sessionIdsToDelete.length,
          estimatedLogicalBytesReclaimed: eventLog.plan.estimatedLogicalBytesReclaimed,
        },
      };
    }
    if (request.method === "run.start") {
      const workspacePath = requiredString(params, "workspacePath");
      const prompt = requiredString(params, "prompt");
      const sessionId = optionalString(params, "sessionId");
      const idempotencyKey = optionalIdempotencyKey(params);
      return this.startForegroundRun({
        workspacePath,
        prompt,
        ...(sessionId ? { sessionId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    }
    if (request.method === "run.cancel") {
      const runtime = await this.getRuntime(requiredString(params, "workspacePath"));
      return runPayload(
        runtime.cancel(requiredString(params, "runId"), optionalString(params, "reason")),
      );
    }
    if (request.method === "run.pause") {
      const runtime = await this.getRuntime(requiredString(params, "workspacePath"));
      return runPayload(runtime.pause(requiredString(params, "runId")));
    }
    if (request.method === "run.resume") {
      const runtime = await this.getRuntime(requiredString(params, "workspacePath"));
      return runPayload(runtime.resume(requiredString(params, "runId")));
    }
    if (request.method === "run.steer") {
      const runtime = await this.getRuntime(requiredString(params, "workspacePath"));
      return runPayload(
        runtime.steer(requiredString(params, "runId"), requiredString(params, "message")),
      );
    }
    if (request.method === "runs.list") {
      const runtime = await this.getRuntime(requiredString(params, "workspacePath"));
      const sessionId = optionalString(params, "sessionId");
      const runs = new Map(
        this.eventStore(runtime.workspace)
          .listDaemonRuns({
            workspacePath: runtime.workspace,
            ...(sessionId ? { sessionId } : {}),
          })
          .map((run) => [run.runId, workspaceRunSnapshot(run)]),
      );
      for (const run of runtime.listRuns()) {
        if (!sessionId || run.sessionId === sessionId) runs.set(run.runId, run);
      }
      return {
        runs: [...runs.values()]
          .sort(
            (left, right) =>
              left.startedAt - right.startedAt || left.runId.localeCompare(right.runId),
          )
          .map(runPayload),
      };
    }
    if (request.method === "jobs.list") {
      const runtime = await this.getRuntime(requiredString(params, "workspacePath"));
      return {
        jobs: runtime.listTasks().map((task) => ({
          taskId: task.taskId,
          description: task.description,
          status: task.status,
          updatedAt: task.endTime ?? task.startTime,
        })),
      };
    }
    throw new Error(`此 Runtime service 不支持 ${request.method}`);
  }

  /**
   * Trusted server-side adapters may attach ephemeral execution constraints. They are never
   * accepted from the generic run.start IPC request, preventing clients from forging activations.
   */
  async startForegroundRun(input: StartDaemonRunInput): Promise<JsonValue> {
    const runtime = await this.getRuntime(input.workspacePath);
    const start = () => {
      const run = runtime.startRun(
        { description: input.prompt, ...(input.sessionId ? { sessionId: input.sessionId } : {}) },
        (context) =>
          this.options.execute({
            workspacePath: runtime.workspace,
            workspaceRuntime: runtime,
            prompt: input.prompt,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.execution ? { execution: input.execution } : {}),
            context,
          }),
      );
      return { result: runPayload(run), resourceId: run.runId };
    };
    if (!input.idempotencyKey) return start().result;

    let startedRunId: string | undefined;
    let outcome: DaemonIdempotentCommandResult<Record<string, JsonValue>>;
    try {
      outcome = await this.executeIdempotentDaemonCommand(
        runtime.workspace,
        {
          commandType: "run.start",
          idempotencyKey: input.idempotencyKey,
          request: {
            workspacePath: runtime.workspace,
            prompt: input.prompt,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.execution ? { execution: input.execution } : {}),
          },
        },
        () => {
          const started = start();
          startedRunId = started.resourceId;
          return started;
        },
      );
    } catch (error) {
      if (startedRunId) {
        runtime.failBeforeExecution(startedRunId, "run.start 幂等记录持久化失败");
      }
      throw error;
    }
    if (outcome.resourceId) {
      const durable = this.eventStore(runtime.workspace).getDaemonRun(
        runtime.workspace,
        outcome.resourceId,
      );
      if (durable) return runPayload(workspaceRunSnapshot(durable));
    }
    return outcome.result;
  }

  async reservePlanReviewRun(
    input: PlanReviewRunIntentInput,
  ): Promise<{ readonly runId: string; readonly replayed: boolean }> {
    const outcome = await this.executeIdempotentDaemonCommand(
      input.workspacePath,
      {
        commandType: "plan.review.start",
        idempotencyKey: input.idempotencyKey,
        request: planReviewIntentRequest(input),
      },
      () => {
        const runId = `run_plan_${randomUUID()}`;
        return { result: { accepted: true, runId }, resourceId: runId };
      },
    );
    const runId = outcome.resourceId;
    if (!runId) throw new Error("Plan review intent did not reserve a RuntimeRun id");
    return { runId, replayed: outcome.replayed };
  }

  async startReservedPlanReviewRun(intent: DurablePlanReviewRunIntent): Promise<JsonValue> {
    const runtime = await this.getRuntime(intent.input.workspacePath);
    const request = {
      description: intent.input.prompt,
      sessionId: intent.input.sessionId,
    };
    const execute = (context: WorkspaceRunContext) =>
      this.options.execute({
        workspacePath: runtime.workspace,
        workspaceRuntime: runtime,
        prompt: intent.input.prompt,
        sessionId: intent.input.sessionId,
        ...(intent.input.execution ? { execution: intent.input.execution } : {}),
        context,
      });
    const existing = runtime.getRun(intent.runId);
    const run = existing
      ? existing.status === "failed" && existing.error === INTERRUPTED_DAEMON_RUN_ERROR
        ? runtime.reattachExactRun(intent.runId, request, execute)
        : existing
      : runtime.startExactRun(intent.runId, request, execute);
    return runPayload(run);
  }

  async listPlanReviewRunIntents(
    workspacePath: string,
    sessionId?: string,
  ): Promise<readonly DurablePlanReviewRunIntent[]> {
    const canonical = await canonicalizeWorkspacePath(workspacePath);
    return this.eventStore(canonical)
      .listDaemonCommands("plan.review.start")
      .flatMap((command) => {
        if (command.status !== "completed" || !command.resourceId) return [];
        const parsed = parsePlanReviewIntent(command.requestJson);
        if (!parsed || (sessionId !== undefined && parsed.sessionId !== sessionId)) return [];
        return [{ input: parsed, runId: command.resourceId }];
      });
  }

  async replayEvents(cursor: RuntimeNotificationCursor): Promise<RuntimeNotificationPage> {
    const workspacePath = await canonicalizeWorkspacePath(cursor.workspacePath);
    const store = this.eventStore(workspacePath);
    if (cursor.afterEventId && !store.hasRuntimeEvent(cursor.afterEventId, workspacePath)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "Runtime replay afterEventId 已失效，请重置 cursor 后重新回放",
      );
    }
    if (
      cursor.highWatermarkEventId &&
      !store.hasRuntimeEvent(cursor.highWatermarkEventId, workspacePath)
    ) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "Runtime replay highWatermarkEventId 已失效，请重新捕获回放边界",
      );
    }
    const highWatermarkEventId =
      cursor.highWatermarkEventId ?? store.getRuntimeEventHighWatermark(workspacePath)?.eventId;
    if (!highWatermarkEventId) {
      return {
        events: [],
        hasMore: false,
        ...(cursor.afterEventId ? { nextAfterEventId: cursor.afterEventId } : {}),
      };
    }

    const eventLimit = Math.max(
      1,
      Math.min(cursor.limit ?? DEFAULT_REPLAY_EVENT_LIMIT, MAX_REPLAY_EVENT_LIMIT),
    );
    const candidates = store
      .listRuntimeEvents({
        ...(cursor.afterEventId ? { afterEventId: cursor.afterEventId } : {}),
        throughEventId: highWatermarkEventId,
        workspacePath,
        limit: Math.min(eventLimit + 1, MAX_REPLAY_QUERY_LIMIT),
      })
      .map(runtimeNotificationFromLedger);
    if (
      cursor.afterEventId &&
      cursor.afterEventId !== highWatermarkEventId &&
      candidates.length === 0
    ) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "Runtime replay afterEventId 位于 high-watermark 之后",
      );
    }
    const events: RuntimeNotification[] = [];
    let eventsBytes = 2;
    let nextAfterEventId = cursor.afterEventId;
    for (const event of candidates.slice(0, eventLimit)) {
      if (isEphemeralRuntimeNotificationTopic(event.topic)) {
        nextAfterEventId = event.eventId;
        continue;
      }
      const eventBytes = Buffer.byteLength(
        JSON.stringify(serializeRuntimeNotification(event)),
        "utf8",
      );
      const nextBytes = eventsBytes + (events.length === 0 ? 0 : 1) + eventBytes;
      if (nextBytes > MAX_REPLAY_EVENTS_BYTES) {
        if (events.length === 0) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.FRAME_TOO_LARGE,
            `Runtime 事件 ${event.eventId} 无法放入单个 IPC 回放页`,
          );
        }
        break;
      }
      events.push(event);
      nextAfterEventId = event.eventId;
      eventsBytes = nextBytes;
    }
    return {
      events,
      hasMore: nextAfterEventId !== highWatermarkEventId,
      ...(nextAfterEventId ? { nextAfterEventId } : {}),
      highWatermarkEventId,
    };
  }

  subscribe(listener: (notification: RuntimeNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Cron and IPC must share the same per-realpath runtime and active-run lock. */
  async getWorkspaceRuntime(workspacePath: string): Promise<WorkspaceTaskRuntime> {
    return this.getRuntime(workspacePath);
  }

  /** Read-only lookup; unlike getWorkspaceRuntime this never constructs workspace resources. */
  async getWorkspaceAgentGraphApplicationService(
    workspacePath: string,
  ): Promise<AgentGraphApplicationService | undefined> {
    const canonical = await canonicalizeWorkspacePath(workspacePath);
    return this.agentGraphApplications.get(canonical);
  }

  /** Read-only lookup for adapters that project a Run's durable Session state. */
  async getWorkspaceRun(workspacePath: string, runId: string) {
    const runtime = await this.getRuntime(workspacePath);
    const current = runtime.getRun(runId);
    if (current) return current;
    const durable = this.eventStore(runtime.workspace).getDaemonRun(runtime.workspace, runId);
    return durable ? workspaceRunSnapshot(durable) : undefined;
  }

  async executeIdempotentDaemonCommand<Result extends Record<string, unknown>>(
    workspacePath: string,
    input: {
      commandType: string;
      idempotencyKey: string;
      request: Record<string, unknown>;
    },
    execute: () => { result: Result; resourceId?: string },
  ): Promise<DaemonIdempotentCommandResult<Result>> {
    const canonical = await canonicalizeWorkspacePath(workspacePath);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    try {
      const store = this.eventStore(canonical);
      return this.withDeferredNotifications(() =>
        store.executeIdempotentDaemonCommand({ ...input, idempotencyKey }, execute),
      );
    } catch (error) {
      if (error instanceof RuntimeConflictError) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, error.message);
      }
      throw error;
    }
  }

  setRegistrationChangedListener(listener: () => Promise<void>): void {
    this.registrationChanged = listener;
  }

  /** Persists and broadcasts events projected by non-Run desktop adapters. */
  publishDesktopNotification(notification: RuntimeNotification): void {
    if (isEphemeralRuntimeNotificationTopic(notification.topic)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        `Ephemeral Runtime notification ${notification.topic} cannot be persisted`,
      );
    }
    this.publish(notification);
  }

  closeRuntimes(): Promise<void> {
    if (this.runtimeClosePromise) return this.runtimeClosePromise;
    this.lifecycleState = "closing_runtimes";
    this.clearAllBlobGcTimers();
    this.registrationChanged = undefined;
    this.runtimeClosePromise = this.registry.close().then(() => {
      this.lifecycleState = "runtimes_closed";
    });
    return this.runtimeClosePromise;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeOnce();
    return this.closePromise;
  }

  shutdownOwnershipFence(): ShutdownOwnershipFence {
    return {
      pending: this.resourceClosePending,
      released: this.resourceClosePromise,
    };
  }

  private async closeOnce(): Promise<void> {
    // Runtime.close() publishes terminal cancellation events. Keep both the runtime
    // subscriptions and durable ledgers alive until those events have been recorded.
    try {
      await this.closeRuntimes();
      await Promise.allSettled(this.blobGcTails.values());
    } finally {
      this.lifecycleState = "closed";
      const runtimeOwnershipPending = this.registry.hasPendingOwnership();
      this.resourceClosePending = true;
      const resourceClose = this.registry.waitForOwnershipRelease().then(async () => {
        await this.closeAllAgentGraphApplications();
        this.releaseResources();
      });
      this.resourceClosePromise = resourceClose;
      resourceClose.then(
        () => {
          this.resourceClosePending = false;
        },
        () => undefined,
      );
      // Local Runtime users may close a service without constructing a daemon host. Preserve the
      // rejecting fence for ownership decisions while preventing a process-level rejection leak.
      void resourceClose.catch(() => undefined);
      if (!runtimeOwnershipPending) await resourceClose;
    }
  }

  private releaseResources(): void {
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.listeners.clear();
    for (const store of this.eventStores.values()) store.close();
    this.eventStores.clear();
  }

  private async releaseWorkspaceResources(workspacePath: string): Promise<void> {
    this.blobGcGenerations.set(workspacePath, (this.blobGcGenerations.get(workspacePath) ?? 0) + 1);
    this.clearBlobGcTimer(workspacePath);
    this.blobGcRerunRequested.delete(workspacePath);
    await this.registry.release(workspacePath);
    this.unsubscribers.get(workspacePath)?.();
    this.unsubscribers.delete(workspacePath);
    await this.closeAgentGraphApplication(workspacePath);
    const store = this.eventStores.get(workspacePath);
    store?.close();
    this.eventStores.delete(workspacePath);
  }

  private async closeAgentGraphApplication(workspacePath: string): Promise<void> {
    const application = this.agentGraphApplications.get(workspacePath);
    if (!application) return;
    await application.close();
    if (this.agentGraphApplications.get(workspacePath) === application) {
      this.agentGraphApplications.delete(workspacePath);
    }
  }

  private async closeAllAgentGraphApplications(): Promise<void> {
    const applications = [...this.agentGraphApplications.entries()];
    await Promise.all(
      applications.map(([workspacePath]) => this.closeAgentGraphApplication(workspacePath)),
    );
  }

  private async cleanupFailedWorkspaceCreation(input: {
    readonly workspacePath: string;
    readonly runtime: WorkspaceTaskRuntime;
    readonly runtimeStore: SqliteRuntimeControlStore;
    readonly unsubscribe: () => void;
    readonly graphApplication?: AgentGraphApplicationService;
  }): Promise<void> {
    const failures: unknown[] = [];
    try {
      await input.runtime.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await input.runtime.waitForOwnershipRelease();
    } catch (error) {
      failures.push(error);
    }
    if (input.graphApplication) {
      try {
        await input.graphApplication.close();
      } catch (error) {
        failures.push(error);
      }
    }
    input.unsubscribe();
    this.unsubscribers.delete(input.workspacePath);
    try {
      input.runtimeStore.close();
    } catch (error) {
      failures.push(error);
    }
    if (this.eventStores.get(input.workspacePath) === input.runtimeStore) {
      this.eventStores.delete(input.workspacePath);
    }
    if (failures.length > 0) {
      logger.warn(
        { failures, workspacePath: input.workspacePath },
        "Failed workspace Graph application startup cleanup was incomplete",
      );
    }
  }

  private publish(notification: RuntimeNotification, run?: DaemonRunRecord): void {
    if (isEphemeralRuntimeNotificationTopic(notification.topic)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        `Ephemeral Runtime notification ${notification.topic} cannot enter the durable ledger`,
      );
    }
    const transportNotification = transportSafeRuntimeNotification(notification);
    this.eventStore(transportNotification.scope.workspacePath).appendRuntimeEvent(
      {
        eventId: transportNotification.eventId,
        topic: transportNotification.topic,
        workspacePath: transportNotification.scope.workspacePath,
        createdAt: transportNotification.at,
        payload: {
          scope: transportNotification.scope,
          resourceVersion: transportNotification.resourceVersion,
          payload: transportNotification.payload,
        },
      },
      run ? { daemonRun: run } : undefined,
    );
    if (this.deferredNotifications) {
      this.deferredNotifications.push(transportNotification);
      return;
    }
    this.notifyPersisted(transportNotification);
  }

  private notifyPersisted(notification: RuntimeNotification): void {
    this.notifyListeners(notification, "durable");
  }

  private notifyListeners(
    notification: RuntimeNotification,
    delivery: "durable" | "ephemeral",
  ): void {
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch (error) {
        logger.warn(
          { error, eventId: notification.eventId, topic: notification.topic, delivery },
          `Runtime ${delivery} notification listener failed`,
        );
      }
    }
  }

  private async getRuntime(workspacePath: string): Promise<WorkspaceTaskRuntime> {
    if (this.lifecycleState !== "open") {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "Workspace Runtime 正在关闭");
    }
    try {
      const runtime = await this.registry.get(workspacePath);
      this.scheduleBlobGc(runtime.workspace);
      return runtime;
    } catch (error) {
      if (this.lifecycleState !== "open") {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "Workspace Runtime 正在关闭");
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("所选文件夹不是 Git 仓库") || message.startsWith("Pico 未找到 Git")) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, message);
      }
      throw error;
    }
  }

  private scheduleBlobGc(workspacePath: string): void {
    if (this.lifecycleState !== "open") return;
    this.clearBlobGcTimer(workspacePath);
    if (this.blobGcTails.has(workspacePath)) {
      this.blobGcRerunRequested.add(workspacePath);
      return;
    }
    const runBlobGc = this.options.runBlobGc ?? runWorkspaceBlobGcOnce;
    const generation = this.blobGcGenerations.get(workspacePath) ?? 0;
    let nextWakeAt: number | undefined;
    const tail = (async () => {
      do {
        this.blobGcRerunRequested.delete(workspacePath);
        const result = await runBlobGc({ workDir: workspacePath, picoHome: this.picoHome });
        nextWakeAt = result.nextWakeAt;
        if (!result.hasMore && !this.blobGcRerunRequested.has(workspacePath)) break;
      } while (
        this.lifecycleState === "open" &&
        generation === (this.blobGcGenerations.get(workspacePath) ?? 0)
      );
    })()
      .catch((error) => {
        logger.warn({ error, workspacePath }, "Workspace Blob GC maintenance failed");
        nextWakeAt = Date.now() + 60_000;
      })
      .finally(() => {
        if (this.blobGcTails.get(workspacePath) === tail) this.blobGcTails.delete(workspacePath);
        const rerunRequested = this.blobGcRerunRequested.delete(workspacePath);
        if (this.lifecycleState !== "open") return;
        if (rerunRequested) this.scheduleBlobGc(workspacePath);
        else if (
          generation === (this.blobGcGenerations.get(workspacePath) ?? 0) &&
          nextWakeAt !== undefined
        ) {
          this.scheduleBlobGcWake(workspacePath, nextWakeAt);
        }
      });
    this.blobGcTails.set(workspacePath, tail);
  }

  private scheduleBlobGcWake(workspacePath: string, wakeAt: number): void {
    if (this.lifecycleState !== "open" || !Number.isFinite(wakeAt)) return;
    const normalizedWakeAt = Math.max(Date.now(), wakeAt);
    const existing = this.blobGcTimers.get(workspacePath);
    if (existing && existing.wakeAt <= normalizedWakeAt) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const current = this.blobGcTimers.get(workspacePath);
      if (current?.timer !== timer) return;
      this.blobGcTimers.delete(workspacePath);
      this.scheduleBlobGc(workspacePath);
    }, normalizedWakeAt - Date.now());
    timer.unref();
    this.blobGcTimers.set(workspacePath, { wakeAt: normalizedWakeAt, timer });
  }

  private clearBlobGcTimer(workspacePath: string): void {
    const scheduled = this.blobGcTimers.get(workspacePath);
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    this.blobGcTimers.delete(workspacePath);
  }

  private clearAllBlobGcTimers(): void {
    for (const { timer } of this.blobGcTimers.values()) clearTimeout(timer);
    this.blobGcTimers.clear();
  }

  private eventStore(workspacePath: string): SqliteRuntimeControlStore {
    const store = this.eventStores.get(workspacePath);
    if (store) return store;
    if (this.lifecycleState !== "open") {
      throw new Error("Workspace Runtime 已关闭，不能重新打开 RuntimeStore");
    }
    const created = new SqliteRuntimeControlStore({
      storageRoot: resolvePicoPaths(workspacePath, { picoHome: this.picoHome }).workspace.root,
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    try {
      created.recoverInterruptedDaemonRuns(workspacePath, INTERRUPTED_DAEMON_RUN_ERROR);
    } catch (error) {
      created.close();
      throw error;
    }
    this.eventStores.set(workspacePath, created);
    // Recovery events are deterministic and Transcript ingestion is idempotent. Catch up the
    // complete workspace recovery stream once per service lifetime so a prior commit-before-notify
    // crash cannot strand either the terminal projection or a durable queued input.
    for (const event of created.listDaemonRunRecoveryEvents(workspacePath)) {
      this.notifyPersisted(runtimeNotificationFromLedger(event));
    }
    return created;
  }

  private withDeferredNotifications<Result>(execute: () => Result): Result {
    const parent = this.deferredNotifications;
    const notifications = parent ?? [];
    const checkpoint = notifications.length;
    if (!parent) this.deferredNotifications = notifications;

    let result: Result;
    try {
      result = execute();
    } catch (error) {
      notifications.length = checkpoint;
      throw error;
    } finally {
      if (!parent) this.deferredNotifications = undefined;
    }

    if (!parent) {
      for (const notification of notifications) this.notifyPersisted(notification);
    }
    return result;
  }
}

function transportSafeRuntimeNotification(notification: RuntimeNotification): RuntimeNotification {
  if (runtimeNotificationFitsFrame(notification)) return notification;
  for (const budget of [
    { maxString: 64 * 1024, maxArray: 256, maxKeys: 256 },
    { maxString: 16 * 1024, maxArray: 128, maxKeys: 128 },
    { maxString: 4 * 1024, maxArray: 64, maxKeys: 64 },
    { maxString: 512, maxArray: 16, maxKeys: 32 },
  ]) {
    const candidate = {
      ...notification,
      payload: boundedNotificationValue(notification.payload as JsonValue, budget, 0),
    } as RuntimeNotification;
    if (runtimeNotificationFitsFrame(candidate)) return candidate;
  }
  throw new RuntimeProtocolError(
    RUNTIME_ERROR_CODES.FRAME_TOO_LARGE,
    `Runtime notification ${notification.eventId} cannot be represented within the IPC frame limit`,
  );
}

function runtimeNotificationFitsFrame(notification: RuntimeNotification): boolean {
  try {
    encodeRuntimeFrame({
      kind: "event",
      protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
      event: notification,
    });
    return true;
  } catch (error) {
    if (
      error instanceof RuntimeProtocolError &&
      error.code === RUNTIME_ERROR_CODES.FRAME_TOO_LARGE
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Generalized transport-safe trimming: bounds a notification so its JSON
 * serialization fits maxSerializedBytes (callers on transports with a smaller
 * frame limit than the daemon IPC 1MiB — e.g. the 3-B-2 runtime-host bridge
 * with its 96KB frames — reuse the same tiered payload trimming). eventId,
 * topic, and scope are never trimmed, so cursor and dedup semantics survive.
 */
export function transportSafeRuntimeNotificationWithin(
  notification: RuntimeNotification,
  maxSerializedBytes: number,
): RuntimeNotification {
  const fits = (candidate: RuntimeNotification): boolean =>
    Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxSerializedBytes;
  if (fits(notification)) return notification;
  for (const budget of [
    { maxString: 64 * 1024, maxArray: 256, maxKeys: 256 },
    { maxString: 16 * 1024, maxArray: 128, maxKeys: 128 },
    { maxString: 4 * 1024, maxArray: 64, maxKeys: 64 },
    { maxString: 512, maxArray: 16, maxKeys: 32 },
  ]) {
    const candidate = {
      ...notification,
      payload: boundedNotificationValue(notification.payload as JsonValue, budget, 0),
    } as RuntimeNotification;
    if (fits(candidate)) return candidate;
  }
  throw new RuntimeProtocolError(
    RUNTIME_ERROR_CODES.FRAME_TOO_LARGE,
    `Runtime notification ${notification.eventId} cannot be represented within ${maxSerializedBytes} bytes`,
  );
}

function boundedNotificationValue(
  value: JsonValue,
  budget: { readonly maxString: number; readonly maxArray: number; readonly maxKeys: number },
  depth: number,
): JsonValue {
  if (typeof value === "string") {
    if (value.length <= budget.maxString) return value;
    return `${value.slice(0, Math.max(0, budget.maxString - 32))}…[truncated ${value.length} chars]`;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 32) return "[truncated nested value]";
  if (Array.isArray(value)) {
    return value
      .slice(0, budget.maxArray)
      .map((item) => boundedNotificationValue(item, budget, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, budget.maxKeys)
      .map(([key, item]) => [key, boundedNotificationValue(item, budget, depth + 1)]),
  );
}

export function workspaceStatusResult(
  runtime: WorkspaceTaskRuntime,
  registered: boolean,
  branch?: string,
): WorkspaceStatusResult {
  return {
    workspacePath: runtime.workspace,
    registered,
    // The user service may be absent even while a manually started daemon is reachable.
    // Do not claim platform daemon installation from a socket probe.
    schedulerStatus: "unknown",
    mode: runtime.mode,
    capabilities: { ...runtime.capabilities },
    branch: branch ?? "",
    eventLog: null,
  };
}

function objectParams(value: JsonValue): Record<string, JsonValue> {
  if (!isJsonObject(value)) throw new Error("IPC 参数必须是对象");
  return value;
}

function requiredString(params: Record<string, JsonValue>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} 必须是非空字符串`);
  return value;
}

function optionalString(params: Record<string, JsonValue>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} 必须是字符串`);
  return value;
}

function optionalIdempotencyKey(params: Record<string, JsonValue>): string | undefined {
  const value = optionalString(params, "idempotencyKey");
  return value === undefined ? undefined : normalizeIdempotencyKey(value);
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "idempotencyKey 必须是 1 到 512 字符的非空字符串",
    );
  }
  return normalized;
}

function eventPayload(
  event: import("../runtime/workspace-runtime.js").WorkspaceRuntimeEvent,
): JsonValue {
  return {
    ...(event.run ? { run: runPayload(event.run) } : {}),
    ...(event.task
      ? {
          task: {
            taskId: event.task.taskId,
            description: event.task.description,
            status: event.task.status,
          },
        }
      : {}),
  };
}

function runPayload(run: {
  runId: string;
  workspace: string;
  sessionId?: string;
  description: string;
  status: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  result?: Record<string, unknown>;
  version: number;
}): Record<string, JsonValue> {
  return {
    runId: run.runId,
    workspacePath: run.workspace,
    ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
    description: run.description,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.result !== undefined ? { result: run.result as JsonValue } : {}),
    version: run.version,
  };
}

function daemonRunRecord(run: WorkspaceRunSnapshot): DaemonRunRecord {
  return {
    runId: run.runId,
    workspacePath: run.workspace,
    ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
    ...(run.checkpointId !== undefined ? { checkpointId: run.checkpointId } : {}),
    description: run.description,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.result !== undefined ? { result: run.result } : {}),
    version: run.version,
  };
}

function workspaceRunSnapshot(run: DaemonRunRecord): WorkspaceRunSnapshot {
  return {
    runId: run.runId,
    workspace: run.workspacePath,
    ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
    ...(run.checkpointId !== undefined ? { checkpointId: run.checkpointId } : {}),
    description: run.description,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.result !== undefined ? { result: run.result } : {}),
    version: run.version,
  };
}

function runtimeNotificationFromLedger(event: RuntimeEventRecord): RuntimeNotification {
  const envelope = event.payload;
  const scopeValue = envelope?.["scope"];
  const scope = isScope(scopeValue) ? scopeValue : { workspacePath: event.workspacePath };
  const resourceVersion = envelope?.["resourceVersion"];
  const payload = envelope?.["payload"];
  return {
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    eventId: event.eventId,
    topic: event.topic,
    scope,
    resourceVersion:
      typeof resourceVersion === "number" && Number.isFinite(resourceVersion) ? resourceVersion : 1,
    at: event.createdAt,
    payload: isJsonPayload(payload) ? payload : isJsonPayload(event.payload) ? event.payload : {},
  };
}

function isScope(value: unknown): value is RuntimeNotification["scope"] {
  if (!isRecord(value) || typeof value["workspacePath"] !== "string") return false;
  return ["sessionId", "runId", "jobId"].every(
    (key) => value[key] === undefined || typeof value[key] === "string",
  );
}

function isJsonPayload(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonPayload);
  return isRecord(value) && Object.values(value).every(isJsonPayload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
