import { WorkspaceTaskRuntime, type WorkspaceRunContext } from "../runtime/workspace-runtime.js";
import {
  createRuntimeEvent,
  isJsonObject,
  type JsonValue,
  type RuntimeEvent,
  type RuntimeRequest,
} from "./protocol.js";
import type { LocalRuntimeService } from "./service.js";
import { WorkspaceRuntimeRegistry } from "./workspace-registry.js";

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
  private readonly maxRetainedEvents: number;

  constructor(private readonly options: WorkspaceRuntimeServiceOptions) {
    this.maxRetainedEvents = Math.max(1, options.maxRetainedEvents ?? 2_000);
    this.registry = new WorkspaceRuntimeRegistry({
      create: async (workspacePath) => {
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
      return runPayload(runtime.cancel(requiredString(params, "runId"), optionalString(params, "reason")));
    }
    if (request.method === "run.steer") {
      const runtime = await this.registry.get(requiredString(params, "workspacePath"));
      return runPayload(runtime.steer(requiredString(params, "runId"), requiredString(params, "message")));
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

  async replayEvents(cursor: { afterEventId?: string }): Promise<readonly RuntimeEvent[]> {
    if (!cursor.afterEventId) return [...this.events];
    const index = this.events.findIndex((event) => event.eventId === cursor.afterEventId);
    return index < 0 ? [] : this.events.slice(index + 1);
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
  }

  private publish(event: RuntimeEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxRetainedEvents) this.events.splice(0, this.events.length - this.maxRetainedEvents);
    for (const listener of this.listeners) listener(event);
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

function eventPayload(event: import("../runtime/workspace-runtime.js").WorkspaceRuntimeEvent): JsonValue {
  return {
    ...(event.run ? { run: runPayload(event.run) } : {}),
    ...(event.task
      ? { task: { taskId: event.task.taskId, description: event.task.description, status: event.task.status } }
      : {}),
  };
}

function runPayload(run: { runId: string; workspace: string; description: string; status: string; startedAt: number; updatedAt: number; finishedAt?: number; error?: string; result?: Record<string, unknown>; version: number }): JsonValue {
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
