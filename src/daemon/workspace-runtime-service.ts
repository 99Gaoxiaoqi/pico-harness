import { join } from "node:path";
import { resolvePicoHome } from "../paths/pico-paths.js";
import {
  WorkspaceTaskRuntime,
  type WorkspaceRunContext,
  type WorkspaceRunSnapshot,
} from "../runtime/workspace-runtime.js";
import {
  createRuntimeEvent,
  DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
  DESKTOP_RUNTIME_SCHEMA_REVISION,
  isJsonObject,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type JsonValue,
  type RuntimeEvent,
  type RuntimeRequest,
  type WorkspaceStatusResult,
} from "./protocol.js";
import type { LocalRuntimeService, RuntimeEventCursor } from "./service.js";
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
}

export interface WorkspaceRuntimeServiceOptions {
  execute: DaemonRunExecutor;
  env?: Readonly<Record<string, string | undefined>>;
  createWorkspaceRuntime?: (workspacePath: string) => Promise<WorkspaceTaskRuntime>;
  now?: () => number;
  maxRetainedEvents?: number;
  registrationStore?: WorkspaceRegistrationStore;
}

/**
 * Concrete daemon-facing owner for workspace Runs. It has no TUI dependency and is
 * intentionally injectable, so the daemon may use AgentRuntime today and another
 * client surface tomorrow without changing the IPC protocol.
 */
export class WorkspaceRuntimeService implements LocalRuntimeService {
  private readonly registry: WorkspaceRuntimeRegistry<WorkspaceTaskRuntime>;
  private readonly events: RuntimeEvent[] = [];
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly eventStores = new Map<string, RuntimeStore>();
  private readonly maxRetainedEvents: number;
  private readonly registrationStore: WorkspaceRegistrationStore;
  private readonly picoHome: string;
  private registrationChanged?: () => Promise<void>;

  constructor(private readonly options: WorkspaceRuntimeServiceOptions) {
    this.maxRetainedEvents = Math.max(1, options.maxRetainedEvents ?? 2_000);
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
              createRuntimeEvent({
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
        createRuntimeEvent({
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
        createRuntimeEvent({
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
    try {
      const outcome = await this.executeIdempotentDaemonCommand(
        runtime.workspace,
        {
          commandType: "run.start",
          idempotencyKey: input.idempotencyKey,
          request: {
            workspacePath: runtime.workspace,
            prompt: input.prompt,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          },
        },
        () => {
          const started = start();
          startedRunId = started.resourceId;
          return started;
        },
      );
      if (outcome.resourceId) {
        const durable = this.eventStore(runtime.workspace).getDaemonRun(
          runtime.workspace,
          outcome.resourceId,
        );
        if (durable) return runPayload(workspaceRunSnapshot(durable));
      }
      return outcome.result;
    } catch (error) {
      if (startedRunId) {
        runtime.failBeforeExecution(startedRunId, "run.start 幂等记录持久化失败");
      }
      throw error;
    }
  }

  async replayEvents(cursor: RuntimeEventCursor): Promise<readonly RuntimeEvent[]> {
    const paths = cursor.workspacePath
      ? [await canonicalizeWorkspacePath(cursor.workspacePath)]
      : await this.knownWorkspacePaths();
    const events: RuntimeEvent[] = [];
    for (const workspacePath of paths) {
      const store = this.eventStore(workspacePath);
      events.push(
        ...store
          .listRuntimeEvents({
            ...(cursor.afterEventId ? { afterEventId: cursor.afterEventId } : {}),
            workspacePath,
            limit: cursor.limit ?? 10_000,
          })
          .map(runtimeEventFromLedger),
      );
    }
    // A single workspace ledger is already in durable rowid order. Preserve it: random
    // event IDs are not a valid causal tie-breaker for start/finish events in the same ms.
    if (paths.length === 1) {
      return cursor.limit === undefined ? events : events.slice(0, cursor.limit);
    }
    // Cross-workspace replay has no shared durable sequence yet. Timestamp plus ID only
    // provides deterministic presentation order; resumable callers scope to a workspace.
    const sorted = events.sort(
      (left, right) => left.at - right.at || left.eventId.localeCompare(right.eventId),
    );
    return cursor.limit === undefined ? sorted : sorted.slice(0, cursor.limit);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
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
      return this.eventStore(canonical).executeIdempotentDaemonCommand(
        { ...input, idempotencyKey },
        execute,
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
  publishDesktopEvent(event: RuntimeEvent): void {
    this.publish(event);
  }

  async close(): Promise<void> {
    // Runtime.close() publishes terminal cancellation events. Keep both the runtime
    // subscriptions and durable ledgers alive until those events have been recorded.
    this.registrationChanged = undefined;
    await this.registry.close();
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.listeners.clear();
    for (const store of this.eventStores.values()) store.close();
    this.eventStores.clear();
  }

  private publish(event: RuntimeEvent): void {
    this.eventStore(event.scope.workspacePath).appendRuntimeEvent({
      eventId: event.eventId,
      topic: event.topic,
      workspacePath: event.scope.workspacePath,
      createdAt: event.at,
      payload: {
        scope: event.scope,
        resourceVersion: event.resourceVersion,
        payload: event.payload,
      },
    });
    this.events.push(event);
    if (this.events.length > this.maxRetainedEvents)
      this.events.splice(0, this.events.length - this.maxRetainedEvents);
    for (const listener of this.listeners) listener(event);
  }

  private async getRuntime(workspacePath: string): Promise<WorkspaceTaskRuntime> {
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
    const created = new RuntimeStore({
      workDir: workspacePath,
      picoHome: this.picoHome,
      now: this.options.now,
    });
    created.recoverInterruptedDaemonRuns(
      workspacePath,
      "daemon 重启前 Run 未进入终态，当前 executor 无法安全恢复",
    );
    this.eventStores.set(workspacePath, created);
    return created;
  }

  private async knownWorkspacePaths(): Promise<string[]> {
    const registered = await this.registrationStore.list();
    return [...new Set([...registered, ...this.eventStores.keys()])];
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

function runtimeEventFromLedger(event: RuntimeEventRecord): RuntimeEvent {
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

function isScope(value: unknown): value is RuntimeEvent["scope"] {
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
