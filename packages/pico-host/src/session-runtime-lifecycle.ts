import { randomUUID } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { BackgroundTaskPort } from "@pico/runtime/background-task-tools";
import { HookRewakeQueue } from "@pico/runtime/hook-rewake";
import {
  isTerminalTaskStatus,
  type TaskRegistry,
  type TaskSnapshot,
} from "@pico/runtime/task-registry";
import type { TaskHostRuntime } from "./task-host-runtime.js";
import { resolvePicoHome } from "./pico-paths.js";

export interface HostSessionProcessSandboxConfig<Profile = unknown, Config = unknown> {
  readonly profile?: Profile;
  readonly config?: Partial<Config>;
  readonly scratchRoot?: string;
  readonly generation?: number;
  readonly workspaceRoots?: readonly string[];
  readonly readRoots?: readonly string[];
  readonly writeRoots?: readonly string[];
  readonly readFiles?: readonly string[];
  readonly writeFiles?: readonly string[];
}

export type SessionLifecycleHookEvent =
  | "SessionStart"
  | "SessionEnd"
  | "TaskCreated"
  | "TaskCompleted"
  | "SubagentStart"
  | "SubagentStop"
  | "WorktreeCreate"
  | "WorktreeRemove";

export type SessionLifecycleHookPayload = Readonly<Record<string, unknown>>;

export interface SessionLifecycleHookPort {
  dispatch(
    event: SessionLifecycleHookEvent,
    payload: SessionLifecycleHookPayload,
  ): Promise<unknown>;
}

export interface SessionRuntimeLifecycleDiagnostics {
  warn(context: Readonly<Record<string, unknown>>, message: string): void;
}

export interface SessionRuntimeIdentityPort {
  readonly id: string;
  readonly workDir: string;
  readonly picoHome: string;
}

export interface SessionRuntimeLifecycleCodePort<ProcessSandbox> {
  setEnabled(enabled: boolean): Promise<unknown>;
  applyProcessSandbox(processSandbox: ProcessSandbox): Promise<void>;
  close(): Promise<unknown>;
}

export interface SessionRuntimeComponentHookPort<ComponentSource> {
  activate(source: ComponentSource): Promise<() => Promise<void>>;
  clearSources(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SessionRuntimeLifecycleOptions<ProcessSandbox, ComponentSource> {
  readonly session: SessionRuntimeIdentityPort;
  readonly taskRegistry: Pick<TaskRegistry, "subscribe">;
  readonly taskHostRuntime?: Pick<TaskHostRuntime, "supervisor">;
  readonly backgroundManager: BackgroundTaskPort;
  readonly hookRewakeQueue: HookRewakeQueue;
  readonly code: SessionRuntimeLifecycleCodePort<ProcessSandbox>;
  readonly componentHooks?: SessionRuntimeComponentHookPort<ComponentSource>;
  readonly codeIntelligenceEnabled: boolean;
  readonly sessionStartSource: "startup" | "resume";
  readonly unbindGoalManager: () => void;
  readonly releaseSessionPin: () => void;
  readonly diagnostics: SessionRuntimeLifecycleDiagnostics;
}

/**
 * Pico Host owner for one Session's process-backed resources and Hook lifecycle.
 * Concrete Hook/LSP/Sandbox implementations are supplied by the source adapter.
 */
export class SessionRuntimeLifecycle<ProcessSandbox, ComponentSource> {
  readonly workDir: string;
  readonly sessionId: string;
  readonly picoHome: string;

  private hookService: SessionLifecycleHookPort | undefined;
  private readonly pendingHookEvents = new Set<Promise<unknown>>();
  private readonly componentHookDisposers: Array<() => Promise<void>> = [];
  private readonly taskStatuses = new Map<string, TaskSnapshot["status"]>();
  private readonly startedSubagents = new Set<string>();
  private sessionStartDispatched = false;
  private readonly unsubscribeTaskHooks: () => void;
  private readonly unsubscribeWorktreeHooks: (() => void) | undefined;
  private disposePromise: Promise<void> | undefined;
  private codeIntelligenceTransition: Promise<void> = Promise.resolve();
  private codeIntelligenceDisposing = false;
  private codeIntelligenceEnabled: boolean;

  constructor(
    private readonly options: SessionRuntimeLifecycleOptions<ProcessSandbox, ComponentSource>,
  ) {
    this.workDir = resolve(options.session.workDir);
    this.sessionId = options.session.id;
    this.picoHome = resolvePicoHome({ picoHome: options.session.picoHome });
    this.codeIntelligenceEnabled = options.codeIntelligenceEnabled;
    this.unsubscribeTaskHooks = options.taskRegistry.subscribe((snapshot) =>
      this.onTaskTransition(snapshot),
    );
    this.unsubscribeWorktreeHooks = options.taskHostRuntime?.supervisor.subscribeLifecycle(
      (event) => {
        if (!this.hookService) return;
        this.ensureSessionStart();
        this.enqueueHook(
          event.type === "created"
            ? this.hookService.dispatch("WorktreeCreate", {
                path: event.path,
                branch: event.branch,
              })
            : this.hookService.dispatch("WorktreeRemove", {
                path: event.path,
                branch: event.branch,
              }),
          event.type === "created" ? "WorktreeCreate" : "WorktreeRemove",
        );
      },
    );
  }

  attachHookService(service: SessionLifecycleHookPort): void {
    if (this.hookService === service) return;
    if (this.hookService) {
      throw new Error("SessionRuntime 已挂载不同 HookService，禁止运行中替换。");
    }
    this.hookService = service;
    this.ensureSessionStart();
  }

  ensureSessionStart(): void {
    if (!this.hookService || this.sessionStartDispatched) return;
    this.sessionStartDispatched = true;
    this.enqueueHook(
      this.hookService.dispatch("SessionStart", { source: this.options.sessionStartSource }),
      "SessionStart",
    );
  }

  async drainHookEvents(): Promise<void> {
    while (this.pendingHookEvents.size > 0) {
      await Promise.allSettled([...this.pendingHookEvents]);
    }
  }

  async setCodeIntelligenceEnabled(enabled: boolean): Promise<void> {
    await this.withCodeIntelligenceTransition(async () => {
      if (this.codeIntelligenceDisposing) throw new Error("SessionRuntime is disposing");
      if (enabled === this.codeIntelligenceEnabled) return;
      await this.options.code.setEnabled(enabled);
      this.codeIntelligenceEnabled = enabled;
    });
  }

  async refreshProcessSandbox(processSandbox: ProcessSandbox): Promise<void> {
    await this.withCodeIntelligenceTransition(async () => {
      if (this.codeIntelligenceDisposing) throw new Error("SessionRuntime is disposing");
      await this.options.code.applyProcessSandbox(processSandbox);
    });
  }

  async activateComponentHookLease(source: ComponentSource): Promise<() => Promise<void>> {
    if (!this.options.componentHooks) return async () => undefined;
    return this.options.componentHooks.activate(source);
  }

  async activateComponentHooks(source: ComponentSource): Promise<void> {
    this.componentHookDisposers.push(await this.activateComponentHookLease(source));
  }

  async clearComponentHooks(): Promise<void> {
    const disposers = this.componentHookDisposers.splice(0).reverse();
    for (const dispose of disposers) {
      try {
        await dispose();
      } catch (error) {
        this.options.diagnostics.warn({ error: String(error) }, "[Hook] 组件 Hook source 释放失败");
      }
    }
  }

  assertCompatible(session: SessionRuntimeIdentityPort): void {
    if (session === this.options.session) return;
    const workDir = resolve(session.workDir);
    const picoHome = resolvePicoHome({ picoHome: session.picoHome });
    if (picoHome !== this.picoHome) {
      throw new Error(
        `SessionRuntime picoHome mismatch: expected ${this.picoHome}, received ${picoHome}`,
      );
    }
    if (workDir !== this.workDir) {
      throw new Error(
        `SessionRuntime workDir mismatch: expected ${this.workDir}, received ${workDir}`,
      );
    }
    if (session.id !== this.sessionId) {
      throw new Error(
        `SessionRuntime session mismatch: expected ${this.sessionId}, received ${session.id}`,
      );
    }
    throw new Error(`SessionRuntime is bound to a different Session instance: ${this.sessionId}`);
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce();
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    this.codeIntelligenceDisposing = true;
    const failures: unknown[] = [];
    const attempt = async (cleanup: () => unknown | Promise<unknown>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    };

    await attempt(() => this.unsubscribeTaskHooks());
    await attempt(() => this.unsubscribeWorktreeHooks?.());
    await attempt(() => this.clearComponentHooks());
    await attempt(() => this.options.componentHooks?.clearSources());
    await attempt(() => this.ensureSessionStart());
    await attempt(() => this.drainHookEvents());

    let runningTasks: ReturnType<BackgroundTaskPort["list"]> = [];
    await attempt(() => {
      runningTasks = this.options.backgroundManager
        .list()
        .filter((task) => task.status === "running");
    });
    const ownedCleanup = await Promise.allSettled([
      this.withCodeIntelligenceTransition(() => this.options.code.close()),
      ...runningTasks.map((task) => this.options.backgroundManager.stop(task.taskId)),
    ]);
    for (const result of ownedCleanup) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    await attempt(() => this.drainHookEvents());
    if (this.hookService) {
      await attempt(() => this.hookService!.dispatch("SessionEnd", { reason: "runtime_dispose" }));
    }

    await attempt(() => this.options.componentHooks?.dispose());
    await attempt(() =>
      detachSessionSandboxRoot(this.picoHome, this.sessionId, this.options.diagnostics),
    );
    await attempt(() => this.options.hookRewakeQueue.close());
    await attempt(() => this.options.unbindGoalManager());
    await attempt(() => this.options.releaseSessionPin());
    if (failures.length > 0) {
      throw new AggregateError(failures, `SessionRuntime ${this.sessionId} cleanup failed`);
    }
  }

  private async withCodeIntelligenceTransition<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.codeIntelligenceTransition;
    let release!: () => void;
    this.codeIntelligenceTransition = new Promise<void>((resolveTransition) => {
      release = resolveTransition;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private onTaskTransition(snapshot: TaskSnapshot): void {
    const previous = this.taskStatuses.get(snapshot.taskId);
    this.taskStatuses.set(snapshot.taskId, snapshot.status);
    if (!this.hookService) return;
    this.ensureSessionStart();
    if (previous === undefined) {
      this.enqueueHook(
        this.hookService.dispatch("TaskCreated", {
          taskId: snapshot.taskId,
          subject: snapshot.description,
        }),
        "TaskCreated",
      );
    }
    if (
      snapshot.type === "local_agent" &&
      snapshot.status === "running" &&
      !this.startedSubagents.has(snapshot.taskId)
    ) {
      this.startedSubagents.add(snapshot.taskId);
      this.enqueueHook(
        this.hookService.dispatch("SubagentStart", {
          agentId: snapshot.taskId,
          agentType: typeof snapshot.data?.["mode"] === "string" ? snapshot.data["mode"] : "worker",
          prompt: snapshot.description,
        }),
        "SubagentStart",
      );
    }
    if (isTerminalTaskStatus(snapshot.status) && !isTerminalTaskStatus(previous ?? "pending")) {
      this.enqueueHook(
        this.hookService.dispatch("TaskCompleted", {
          taskId: snapshot.taskId,
          status: snapshot.status,
        }),
        "TaskCompleted",
      );
      if (this.startedSubagents.has(snapshot.taskId)) {
        this.enqueueHook(
          this.hookService.dispatch("SubagentStop", {
            agentId: snapshot.taskId,
            status: snapshot.status,
            ...(snapshot.error ? { result: snapshot.error } : {}),
          }),
          "SubagentStop",
        );
      }
    }
  }

  private enqueueHook(promise: Promise<unknown>, event: SessionLifecycleHookEvent): void {
    const tracked = promise.catch((error) => {
      this.options.diagnostics.warn(
        { event, sessionId: this.sessionId, error: String(error) },
        "[Hook] 会话生命周期事件执行失败",
      );
    });
    this.pendingHookEvents.add(tracked);
    void tracked.finally(() => this.pendingHookEvents.delete(tracked));
  }
}

function detachSessionSandboxRoot(
  picoHome: string,
  sessionId: string,
  diagnostics: SessionRuntimeLifecycleDiagnostics,
): void {
  const parent = resolve(picoHome, "sandboxes");
  const target = resolve(parent, sessionId);
  const child = relative(parent, target);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`拒绝清理非会话沙箱目录: ${target}`);
  }
  if (!existsSync(target)) return;
  const detached = resolve(parent, `.cleanup-${randomUUID()}`);
  renameSync(target, detached);
  setImmediate(() => {
    void rm(detached, { recursive: true, force: true }).catch((error: unknown) =>
      diagnostics.warn({ detached, error: String(error) }, "[沙箱] 会话隔离目录后台清理失败"),
    );
  });
}
