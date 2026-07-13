import { WorkspaceTaskRuntime, type WorkspaceRunContext } from "../runtime/workspace-runtime.js";
import {
  createRuntimeEvent,
  isJsonObject,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  type JsonValue,
  type RuntimeEvent,
  type RuntimeRequest,
  type WorkspaceStatusResult,
} from "./protocol.js";
import type { LocalRuntimeService, RuntimeEventCursor } from "./service.js";
import { RuntimeStore } from "../tasks/runtime-store.js";
import type { RuntimeEventRecord } from "../tasks/runtime-types.js";
import { canonicalizeWorkspacePath, WorkspaceRuntimeRegistry } from "./workspace-registry.js";
import { WorkspaceRegistrationStore } from "./workspace-registration.js";

export interface DaemonRunExecutor {
  (input: {
    workspacePath: string;
    prompt: string;
    context: WorkspaceRunContext;
  }): Promise<Record<string, unknown> | void>;
}

export interface WorkspaceRuntimeServiceOptions {
  execute: DaemonRunExecutor;
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

  constructor(private readonly options: WorkspaceRuntimeServiceOptions) {
    this.maxRetainedEvents = Math.max(1, options.maxRetainedEvents ?? 2_000);
    this.registrationStore = options.registrationStore ?? new WorkspaceRegistrationStore();
    this.registry = new WorkspaceRuntimeRegistry({
      create: async (workspacePath) => {
        this.eventStore(workspacePath);
        const runtime = await (options.createWorkspaceRuntime?.(workspacePath) ??
          WorkspaceTaskRuntime.create({ workDir: workspacePath }));
        this.unsubscribers.set(
          workspacePath,
          runtime.subscribe((event) => {
            this.publish(
              createRuntimeEvent({
                topic: event.type,
                scope: {
                  workspacePath: event.workspace,
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
    if (request.method === "runtime.ping") return { pong: true };
    const params = objectParams(request.params);
    if (request.method === "workspace.register") {
      const workspacePath = requiredString(params, "workspacePath");
      const registered = await this.registrationStore.register(workspacePath);
      this.publish(
        createRuntimeEvent({
          topic: "workspace.registered",
          scope: { workspacePath: registered },
          resourceVersion: 1,
          at: this.options.now?.() ?? Date.now(),
          payload: { registered: true },
        }),
      );
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
      return { workspacePath: registered, registered: false };
    }
    if (request.method === "workspace.status") {
      const workspacePath = await canonicalizeWorkspacePath(
        requiredString(params, "workspacePath"),
      );
      const registered = (await this.registrationStore.list()).includes(workspacePath);
      const result: WorkspaceStatusResult = {
        workspacePath,
        registered,
        // The user service may be absent even while a manually started daemon is reachable.
        // Do not claim platform daemon installation from a socket probe.
        schedulerStatus: "unknown",
      };
      return {
        workspacePath: result.workspacePath,
        registered: result.registered,
        schedulerStatus: result.schedulerStatus,
      };
    }
    if (request.method === "run.start") {
      const workspacePath = requiredString(params, "workspacePath");
      const prompt = requiredString(params, "prompt");
      const runtime = await this.registry.get(workspacePath);
      const run = runtime.startRun({ description: prompt }, (context) =>
        this.options.execute({ workspacePath: runtime.workspace, prompt, context }),
      );
      return runPayload(run);
    }
    if (request.method === "run.cancel") {
      const runtime = await this.registry.get(requiredString(params, "workspacePath"));
      return runPayload(
        runtime.cancel(requiredString(params, "runId"), optionalString(params, "reason")),
      );
    }
    if (request.method === "run.steer") {
      const runtime = await this.registry.get(requiredString(params, "workspacePath"));
      return runPayload(
        runtime.steer(requiredString(params, "runId"), requiredString(params, "message")),
      );
    }
    if (request.method === "runs.list") {
      const runtime = await this.registry.get(requiredString(params, "workspacePath"));
      return { runs: runtime.listRuns().map(runPayload) };
    }
    if (request.method === "jobs.list") {
      const runtime = await this.registry.get(requiredString(params, "workspacePath"));
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
            limit: 10_000,
          })
          .map(runtimeEventFromLedger),
      );
    }
    // Event IDs are random. Timestamp plus ID gives a deterministic cross-workspace
    // presentation order; callers needing a resumable cursor use workspacePath.
    return events.sort(
      (left, right) => left.at - right.at || left.eventId.localeCompare(right.eventId),
    );
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.listeners.clear();
    await this.registry.close();
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

  private eventStore(workspacePath: string): RuntimeStore {
    const store = this.eventStores.get(workspacePath);
    if (store) return store;
    const created = new RuntimeStore({ workDir: workspacePath, now: this.options.now });
    this.eventStores.set(workspacePath, created);
    return created;
  }

  private async knownWorkspacePaths(): Promise<string[]> {
    const registered = await this.registrationStore.list();
    return [...new Set([...registered, ...this.eventStores.keys()])];
  }
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
  description: string;
  status: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  result?: Record<string, unknown>;
  version: number;
}): JsonValue {
  return {
    runId: run.runId,
    workspace: run.workspace,
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
