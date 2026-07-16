import { join } from "node:path";
import { logger } from "../observability/logger.js";
import { resolvePicoHome } from "../paths/pico-paths.js";
import {
  WorkspaceTaskRuntime,
  type WorkspaceRunContext,
  type WorkspaceRunSnapshot,
} from "../runtime/workspace-runtime.js";
import {
  createRuntimeNotification,
  DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
  DESKTOP_RUNTIME_SCHEMA_REVISION,
  isJsonObject,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  MAX_RUNTIME_FRAME_BYTES,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  serializeRuntimeNotification,
  type JsonValue,
  type RuntimeNotification,
  type RuntimeNotificationPage,
  type RuntimeRequest,
  type WorkspaceStatusResult,
} from "./protocol.js";
import type { LocalRuntimeService, RuntimeNotificationCursor } from "./service.js";
import {
  RuntimeConflictError,
  RuntimeStore,
  type DaemonIdempotentCommandResult,
} from "../tasks/runtime-store.js";
import type { DaemonRunRecord, RuntimeEventRecord } from "../tasks/runtime-types.js";
import { canonicalizeWorkspacePath, WorkspaceRuntimeRegistry } from "./workspace-registry.js";
import { WorkspaceRegistrationStore } from "./workspace-registration.js";

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
  readonly skillActivation?: {
    readonly name: string;
    readonly sourcePath?: string;
    readonly hooks?: unknown;
  };
}

export interface StartDaemonRunInput {
  readonly workspacePath: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly execution?: DaemonRunExecution;
  readonly idempotencyKey?: string;
  /** Trusted in-process admission check, evaluated synchronously at the actual start boundary. */
  readonly assertCanStart?: () => void;
}

export interface WorkspaceRuntimeServiceOptions {
  execute: DaemonRunExecutor;
  env?: Readonly<Record<string, string | undefined>>;
  createWorkspaceRuntime?: (workspacePath: string) => Promise<WorkspaceTaskRuntime>;
  now?: () => number;
  registrationStore?: WorkspaceRegistrationStore;
}

const DEFAULT_REPLAY_EVENT_LIMIT = 1_000;
// Keep one query slot for hasMore detection; the public request limit remains 10_000.
const MAX_REPLAY_EVENT_LIMIT = 9_999;
const MAX_REPLAY_QUERY_LIMIT = 10_000;
const REPLAY_RESPONSE_METADATA_RESERVE_BYTES = 64 * 1024;
const MAX_REPLAY_EVENTS_BYTES = MAX_RUNTIME_FRAME_BYTES - REPLAY_RESPONSE_METADATA_RESERVE_BYTES;

/**
 * Concrete daemon-facing owner for workspace Runs. It has no TUI dependency and is
 * intentionally injectable, so the daemon may use AgentRuntime today and another
 * client surface tomorrow without changing the IPC protocol.
 */
export class WorkspaceRuntimeService implements LocalRuntimeService {
  private readonly registry: WorkspaceRuntimeRegistry<WorkspaceTaskRuntime>;
  private readonly listeners = new Set<(notification: RuntimeNotification) => void>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly eventStores = new Map<string, RuntimeStore>();
  private readonly registrationStore: WorkspaceRegistrationStore;
  private readonly picoHome: string;
  private registrationChanged?: () => Promise<void>;
  private deferredNotifications?: RuntimeNotification[];
  private lifecycleState: "open" | "closing_runtimes" | "runtimes_closed" | "closed" = "open";
  private runtimeClosePromise?: Promise<void>;
  private closePromise?: Promise<void>;

  constructor(private readonly options: WorkspaceRuntimeServiceOptions) {
    this.picoHome = resolvePicoHome({ env: options.env });
    this.registrationStore =
      options.registrationStore ??
      new WorkspaceRegistrationStore(join(this.picoHome, "daemon-workspaces.json"));
    this.registry = new WorkspaceRuntimeRegistry({
      create: async (workspacePath) => {
        this.eventStore(workspacePath);
        const runtime = await (options.createWorkspaceRuntime?.(workspacePath) ??
          WorkspaceTaskRuntime.create({
            workDir: workspacePath,
            taskHostRuntimeOptions: { picoHome: this.picoHome },
          }));
        this.unsubscribers.set(
          workspacePath,
          runtime.subscribe((event) => {
            if (event.run) {
              this.eventStore(event.workspace).upsertDaemonRun(daemonRunRecord(event.run));
            }
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
            );
          }),
        );
        return runtime;
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
          "shared-config-v1",
          "session-conversation-v1",
          "session-management-v1",
          "session-settings-v1",
          "session-goal-v1",
          "catalog-activation-v1",
          "workspace-diagnostics-v1",
          "runtime-events-v1",
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
      return { workspacePath: registered, registered: false };
    }
    if (request.method === "workspace.status") {
      const runtime = await this.getRuntime(requiredString(params, "workspacePath"));
      const registered = (await this.registrationStore.list()).includes(runtime.workspace);
      const result = workspaceStatusResult(runtime, registered);
      return {
        workspacePath: result.workspacePath,
        registered,
        schedulerStatus: result.schedulerStatus,
        mode: result.mode,
        capabilities: result.capabilities,
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
      input.assertCanStart?.();
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

  async replayEvents(cursor: RuntimeNotificationCursor): Promise<RuntimeNotificationPage> {
    const workspacePath = await canonicalizeWorkspacePath(cursor.workspacePath);
    const store = this.eventStore(workspacePath);
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
    const events: RuntimeNotification[] = [];
    let eventsBytes = 2;
    for (const event of candidates.slice(0, eventLimit)) {
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
      eventsBytes = nextBytes;
    }
    const nextAfterEventId = events.at(-1)?.eventId ?? cursor.afterEventId;
    return {
      events,
      hasMore: events.length < candidates.length,
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
    this.publish(notification);
  }

  closeRuntimes(): Promise<void> {
    if (this.runtimeClosePromise) return this.runtimeClosePromise;
    this.lifecycleState = "closing_runtimes";
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

  private async closeOnce(): Promise<void> {
    // Runtime.close() publishes terminal cancellation events. Keep both the runtime
    // subscriptions and durable ledgers alive until those events have been recorded.
    try {
      await this.closeRuntimes();
    } finally {
      for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
      this.unsubscribers.clear();
      this.listeners.clear();
      for (const store of this.eventStores.values()) store.close();
      this.eventStores.clear();
      this.lifecycleState = "closed";
    }
  }

  private publish(notification: RuntimeNotification): void {
    this.eventStore(notification.scope.workspacePath).appendRuntimeEvent({
      eventId: notification.eventId,
      topic: notification.topic,
      workspacePath: notification.scope.workspacePath,
      createdAt: notification.at,
      payload: {
        scope: notification.scope,
        resourceVersion: notification.resourceVersion,
        payload: notification.payload,
      },
    });
    if (this.deferredNotifications) {
      this.deferredNotifications.push(notification);
      return;
    }
    this.notifyPersisted(notification);
  }

  private notifyPersisted(notification: RuntimeNotification): void {
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch (error) {
        logger.warn(
          { error, eventId: notification.eventId, topic: notification.topic },
          "Runtime notification listener failed after durable commit",
        );
      }
    }
  }

  private async getRuntime(workspacePath: string): Promise<WorkspaceTaskRuntime> {
    if (this.lifecycleState !== "open") {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "Workspace Runtime 正在关闭");
    }
    try {
      return await this.registry.get(workspacePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("所选文件夹不是 Git 仓库") || message.startsWith("Pico 未找到 Git")) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, message);
      }
      throw error;
    }
  }

  private eventStore(workspacePath: string): RuntimeStore {
    const store = this.eventStores.get(workspacePath);
    if (store) return store;
    if (this.lifecycleState !== "open") {
      throw new Error("Workspace Runtime 已关闭，不能重新打开 RuntimeStore");
    }
    const created = new RuntimeStore({
      workDir: workspacePath,
      picoHome: this.picoHome,
      now: this.options.now,
    });
    try {
      created.recoverInterruptedDaemonRuns(
        workspacePath,
        "daemon 重启前 Run 未进入终态，当前 executor 无法安全恢复",
      );
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

export function workspaceStatusResult(
  runtime: WorkspaceTaskRuntime,
  registered: boolean,
): WorkspaceStatusResult {
  return {
    workspacePath: runtime.workspace,
    registered,
    // The user service may be absent even while a manually started daemon is reachable.
    // Do not claim platform daemon installation from a socket probe.
    schedulerStatus: "unknown",
    mode: runtime.mode,
    capabilities: { ...runtime.capabilities },
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
