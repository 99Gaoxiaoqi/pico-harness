import { randomUUID } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { TodoStore } from "../context/todo-store.js";
import { GoalManager } from "../engine/goal-manager.js";
import { globalSessionManager, type Session, type SessionManager } from "../engine/session.js";
import type { SessionManagerLease } from "../engine/session-manager.js";
import { SteerQueue } from "../engine/steer-queue.js";
import { FileIndex } from "../input/file-index.js";
import { logger } from "../observability/logger.js";
import { TaskRegistry } from "../tasks/task-registry.js";
import type { TaskHostRuntime } from "../tasks/task-runtime.js";
import { BackgroundManager } from "../tools/background-manager.js";
import { ToolDisclosure } from "../tools/tool-disclosure.js";
import {
  CodeIntelligenceManager,
  type CodeIntelligenceService,
  type LspServerConfig,
} from "../code-intelligence/index.js";
import { HookService } from "../hooks/service.js";
import {
  createSessionHookRuntime,
  type HookRuntimeBinding,
  type SessionHookRuntime,
} from "../hooks/runtime.js";
import type { SlashCommand } from "../input/types.js";
import type { HookConfigSourceSpec } from "../hooks/config.js";
import { WorkspaceTrustStore } from "../security/workspace-trust.js";
import type { HookManagementService } from "../hooks/management/service.js";
import type {
  HookEvent,
  HookEventPayloadMap,
  HookExecutionContext,
  HookOutput,
} from "../hooks/types.js";
import { isTerminalTaskStatus, type TaskSnapshot } from "../tasks/task-registry.js";
import { resolvePicoHome } from "../paths/pico-paths.js";
import {
  createSandboxPolicy,
  type SandboxConfig,
  type SandboxProfile,
} from "../safety/process-sandbox/index.js";

/** UI-independent services scoped to one persisted session. */
export interface SessionProcessSandboxConfig {
  profile?: SandboxProfile;
  config?: Partial<SandboxConfig>;
  scratchRoot?: string;
  generation?: number;
  workspaceRoots?: readonly string[];
  readRoots?: readonly string[];
  writeRoots?: readonly string[];
  readFiles?: readonly string[];
  writeFiles?: readonly string[];
}

export interface SessionRuntimeOptions {
  /** Exact persisted Session that owns every session-scoped runtime service. */
  session: Session;
  /** Manager that owns the exact Session; defaults to the product-wide manager. */
  sessionManager?: SessionManager;
  /** Atomic acquisition pin transferred into this runtime's dispose lifecycle. */
  sessionLease?: SessionManagerLease;
  /** Host-owned environment inherited by the session Hook executor. */
  env?: Readonly<NodeJS.ProcessEnv>;
  toolDisclosure?: ToolDisclosure;
  lspEnabled?: boolean;
  lspServers?: readonly LspServerConfig[];
  processSandbox?: SessionProcessSandboxConfig;
  taskHostRuntime?: TaskHostRuntime;
  sessionStartSource?: "startup" | "resume";
  /** 后台/Cron 显式关闭前台 HookService，继续走严格 command-only policy。 */
  hooks?: false;
  /** 测试或宿主可注入自管 HookService；注入时不创建默认 watcher/management。 */
  hookService?: HookService;
  /** 已由 Plugin 信任层冻结的扩展 Hook 来源。 */
  hookExtensionSources?: readonly HookConfigSourceSpec[];
  /**
   * workspace trust 锚：executable hooks 在每次 dispatch 边界复验工作区
   * 信任（撤销信任即失效）。daemon 装配链注入宿主共享实例；其他宿主使用
   * Session 已固定的 picoHome 构造当前权威。
   */
  workspaceTrustStore?: WorkspaceTrustStore;
}

export interface SessionRuntime {
  readonly workDir: string;
  readonly sessionId: string;
  readonly picoHome: string;
  readonly goalManager: GoalManager;
  readonly todoStore: TodoStore;
  readonly toolDisclosure: ToolDisclosure;
  readonly taskRegistry: TaskRegistry;
  readonly taskHostRuntime?: TaskHostRuntime;
  readonly backgroundManager: BackgroundManager;
  readonly hookRewakeQueue: HookRewakeQueue;
  readonly fileIndex: FileIndex;
  readonly steerQueue: SteerQueue;
  readonly codeIntelligence: CodeIntelligenceService;
  readonly codeIntelligenceManager: CodeIntelligenceManager;
  /** Keep code-intelligence processes aligned with persisted collaboration mode. */
  setCodeIntelligenceEnabled(enabled: boolean): Promise<void>;
  /**
   * Replace the complete subprocess boundary. Callers must not update only roots:
   * permission-mode changes also need to restart LSP/Hook processes under the new profile.
   */
  refreshProcessSandbox(processSandbox: SessionProcessSandboxConfig): Promise<void>;
  readonly hookService?: HookService;
  readonly hookCommands: readonly SlashCommand[];
  readonly hookManagement?: HookManagementService;
  /** 同一实例可幂等挂载；运行中替换实例会抛错。 */
  attachHookService(service: HookService): void;
  bindHookRuntime(dependencies: HookRuntimeBinding): void;
  /** 按单次运行持有组件 Hook，调用方必须在 finally 释放返回的租约。 */
  activateComponentHookLease(source: HookConfigSourceSpec): Promise<() => Promise<void>>;
  activateComponentHooks(source: HookConfigSourceSpec): Promise<void>;
  clearComponentHooks(): Promise<void>;
  dispatchHook<E extends HookEvent>(
    event: E,
    payload: HookEventPayloadMap[E],
    context?: HookExecutionContext,
  ): Promise<HookOutput>;
  drainHookEvents(): Promise<void>;
  assertCompatible(session: Session): void;
  dispose(): Promise<void>;
}

export interface HookRewakeEntry {
  id: string;
  message: string;
}

/** asyncRewake 的有界会话队列；会话关闭后拒绝迟到回调。 */
export class HookRewakeQueue {
  private readonly pending = new Map<string, HookRewakeEntry>();
  private readonly subscribers = new Set<() => void>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly deliver: (entries: readonly HookRewakeEntry[]) => Promise<void>,
    private readonly capacity = 32,
  ) {}

  enqueue(message: string): boolean {
    if (this.closed || this.pending.size >= this.capacity) return false;
    const id = `hook-rewake-${this.nextId++}`;
    const notify = this.pending.size === 0;
    this.pending.set(id, { id, message });
    if (notify) for (const subscriber of this.subscribers) subscriber();
    return true;
  }

  pendingIds(): readonly string[] {
    return [...this.pending.keys()];
  }

  async deliverPending(ids: readonly string[]): Promise<readonly HookRewakeEntry[]> {
    const entries = ids.flatMap((id) => {
      const entry = this.pending.get(id);
      return entry ? [entry] : [];
    });
    if (entries.length === 0) return [];
    await this.deliver(entries);
    for (const entry of entries) this.pending.delete(entry.id);
    return entries;
  }

  subscribe(subscriber: () => void): () => void {
    if (this.closed) return () => undefined;
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
    this.subscribers.clear();
  }
}

export interface HookRewakeCoordinatorOptions {
  queue: HookRewakeQueue;
  isIdle(): boolean;
  resume(ids: readonly string[], deliver: () => Promise<readonly HookRewakeEntry[]>): Promise<void>;
  onError?(error: unknown): void;
}

/** 空闲时合并一批 asyncRewake，通过 QueryGuard 宿主串行续跑。 */
export class HookRewakeCoordinator {
  private readonly unsubscribe: () => void;
  private scheduled = false;
  private running = false;
  private disposed = false;

  constructor(private readonly options: HookRewakeCoordinatorOptions) {
    this.unsubscribe = options.queue.subscribe(() => this.request());
    if (options.queue.hasPending) this.request();
  }

  notifyIdle(): void {
    this.request();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
  }

  private request(): void {
    if (this.disposed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.resumePending();
    });
  }

  private async resumePending(): Promise<void> {
    if (this.disposed || this.running || !this.options.isIdle()) return;
    const ids = this.options.queue.pendingIds();
    if (ids.length === 0) return;
    this.running = true;
    let delivered: readonly HookRewakeEntry[] | undefined;
    try {
      await this.options.resume(ids, async () => {
        delivered ??= await this.options.queue.deliverPending(ids);
        return delivered;
      });
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.running = false;
      if (delivered !== undefined && this.options.queue.hasPending) this.request();
    }
  }
}

export async function createSessionRuntime(
  options: SessionRuntimeOptions,
): Promise<SessionRuntime> {
  if (options.sessionLease && options.sessionLease.session !== options.session) {
    throw new Error("sessionLease must own the exact Session used by SessionRuntime");
  }
  const releaseSessionPin =
    options.sessionLease?.release ??
    (options.sessionManager ?? globalSessionManager).pin(options.session);
  try {
    return await createPinnedSessionRuntime(options, releaseSessionPin);
  } catch (error) {
    releaseSessionPin();
    throw error;
  }
}

async function createPinnedSessionRuntime(
  options: SessionRuntimeOptions,
  releaseSessionPin: () => void,
): Promise<SessionRuntime> {
  const session = options.session;
  const workDir = resolve(session.workDir);
  const sessionId = session.id;
  const picoHome = resolvePicoHome({ picoHome: session.picoHome });

  const taskRegistry = options.taskHostRuntime?.taskRegistry ?? new TaskRegistry();
  const goalManager = new GoalManager();
  const unbindGoalManager = session.bindGoalManager(goalManager);
  const persistedPlanMode =
    session.getRuntimeStateSnapshot().settings?.collaborationMode === "plan";
  const codeIntelligenceEnabled = options.lspEnabled ?? !persistedPlanMode;
  const codeIntelligenceManager = new CodeIntelligenceManager({
    rootDir: workDir,
    lspEnabled: codeIntelligenceEnabled,
    ...(options.lspServers ? { lspServers: options.lspServers } : {}),
    ...(options.processSandbox ? { processSandbox: options.processSandbox } : {}),
  });
  await codeIntelligenceManager.start();
  const codeIntelligence = codeIntelligenceManager.service();
  if (!codeIntelligence) {
    await codeIntelligenceManager.close();
    unbindGoalManager();
    throw new Error("代码智能服务启动后未提供 LSP 或 Repo Map 后端");
  }

  const steerQueue = new SteerQueue();
  const hookRewakeQueue = new HookRewakeQueue(async (entries) => {
    await session.commitMessages({
      role: "user",
      content: entries.map((entry) => entry.message).join("\n\n"),
      providerData: {
        picoKind: "hook_async_rewake",
        picoHiddenFromTranscript: true,
        picoHookRewakeIds: entries.map((entry) => entry.id),
      },
    });
  });
  const hookRuntime =
    options.hooks === false || options.hookService
      ? undefined
      : await createSessionHookRuntime({
          workDir,
          sessionId,
          picoHome,
          ...(options.env ? { env: options.env } : {}),
          ...(options.processSandbox ? { processSandbox: options.processSandbox } : {}),
          ...(options.hookExtensionSources
            ? { extensionSources: options.hookExtensionSources }
            : {}),
          workspaceTrustStore:
            options.workspaceTrustStore ??
            new WorkspaceTrustStore({ userStateDirectory: picoHome }),
        }).catch((error) => {
          logger.warn(
            { sessionId, error: String(error) },
            "[Hook] 会话级运行时初始化失败，前台 hooks fail-open",
          );
          return undefined;
        });
  return new DefaultSessionRuntime({
    session,
    goalManager,
    todoStore: new TodoStore(workDir, { picoHome }),
    toolDisclosure: options.toolDisclosure ?? new ToolDisclosure(),
    taskRegistry,
    ...(options.taskHostRuntime ? { taskHostRuntime: options.taskHostRuntime } : {}),
    backgroundManager: new BackgroundManager({
      taskRegistry,
      ownerSessionId: sessionId,
    }),
    hookRewakeQueue,
    fileIndex: FileIndex.create({ cwd: workDir }),
    steerQueue,
    codeIntelligenceManager,
    codeIntelligenceEnabled,
    unbindGoalManager,
    releaseSessionPin,
    sessionStartSource: options.sessionStartSource ?? "startup",
    ...(hookRuntime ? { hookRuntime } : {}),
    ...(options.hookService ? { hookService: options.hookService } : {}),
    ...(options.processSandbox ? { processSandbox: options.processSandbox } : {}),
  });
}

interface DefaultSessionRuntimeOptions {
  session: Session;
  goalManager: GoalManager;
  todoStore: TodoStore;
  toolDisclosure: ToolDisclosure;
  taskRegistry: TaskRegistry;
  taskHostRuntime?: TaskHostRuntime;
  backgroundManager: BackgroundManager;
  hookRewakeQueue: HookRewakeQueue;
  fileIndex: FileIndex;
  steerQueue: SteerQueue;
  codeIntelligenceManager: CodeIntelligenceManager;
  codeIntelligenceEnabled: boolean;
  unbindGoalManager: () => void;
  releaseSessionPin: () => void;
  sessionStartSource: "startup" | "resume";
  hookRuntime?: SessionHookRuntime;
  hookService?: HookService;
  processSandbox?: SessionRuntimeOptions["processSandbox"];
}

class DefaultSessionRuntime implements SessionRuntime {
  readonly workDir: string;
  readonly sessionId: string;
  readonly picoHome: string;
  readonly goalManager: GoalManager;
  readonly todoStore: TodoStore;
  readonly toolDisclosure: ToolDisclosure;
  readonly taskRegistry: TaskRegistry;
  readonly taskHostRuntime?: TaskHostRuntime;
  readonly backgroundManager: BackgroundManager;
  readonly hookRewakeQueue: HookRewakeQueue;
  readonly fileIndex: FileIndex;
  readonly steerQueue: SteerQueue;
  readonly codeIntelligenceManager: CodeIntelligenceManager;
  private _hookService?: HookService;
  private readonly hookRuntime?: SessionHookRuntime;
  private processSandbox?: SessionRuntimeOptions["processSandbox"];
  private readonly pendingHookEvents = new Set<Promise<unknown>>();
  private readonly componentHookDisposers: Array<() => Promise<void>> = [];
  private readonly taskStatuses = new Map<string, TaskSnapshot["status"]>();
  private readonly startedSubagents = new Set<string>();
  private readonly sessionStartSource: "startup" | "resume";
  private sessionStartDispatched = false;
  private readonly unsubscribeTaskHooks: () => void;
  private readonly unsubscribeWorktreeHooks?: () => void;
  private readonly unbindGoalManager: () => void;
  private readonly releaseSessionPin: () => void;
  private readonly session: Session;
  private disposePromise?: Promise<void>;
  private codeIntelligenceTransition: Promise<void> = Promise.resolve();
  private codeIntelligenceDisposing = false;
  private codeIntelligenceEnabled: boolean;

  constructor(options: DefaultSessionRuntimeOptions) {
    this.session = options.session;
    this.workDir = resolve(options.session.workDir);
    this.sessionId = options.session.id;
    this.picoHome = resolvePicoHome({ picoHome: options.session.picoHome });
    this.goalManager = options.goalManager;
    this.todoStore = options.todoStore;
    this.toolDisclosure = options.toolDisclosure;
    this.taskRegistry = options.taskRegistry;
    this.taskHostRuntime = options.taskHostRuntime;
    this.backgroundManager = options.backgroundManager;
    this.hookRewakeQueue = options.hookRewakeQueue;
    this.fileIndex = options.fileIndex;
    this.steerQueue = options.steerQueue;
    this.codeIntelligenceManager = options.codeIntelligenceManager;
    this.codeIntelligenceEnabled = options.codeIntelligenceEnabled;
    this.unbindGoalManager = options.unbindGoalManager;
    this.releaseSessionPin = options.releaseSessionPin;
    this.sessionStartSource = options.sessionStartSource;
    this.hookRuntime = options.hookRuntime;
    this.processSandbox = options.processSandbox;
    this.unsubscribeTaskHooks = this.taskRegistry.subscribe((snapshot) =>
      this.onTaskTransition(snapshot),
    );
    this.unsubscribeWorktreeHooks = this.taskHostRuntime?.supervisor.subscribeLifecycle((event) => {
      if (!this._hookService) return;
      this.ensureSessionStart();
      this.enqueueHook(
        event.type === "created"
          ? this._hookService.dispatch("WorktreeCreate", {
              path: event.path,
              branch: event.branch,
            })
          : this._hookService.dispatch("WorktreeRemove", {
              path: event.path,
              branch: event.branch,
            }),
        event.type === "created" ? "WorktreeCreate" : "WorktreeRemove",
      );
    });
    if (options.hookRuntime) this._hookService = options.hookRuntime.service;
    if (options.hookService) this.attachHookService(options.hookService);
  }

  get hookService(): HookService | undefined {
    return this._hookService;
  }

  get codeIntelligence(): CodeIntelligenceService {
    const service = this.codeIntelligenceManager.service();
    if (!service) throw new Error("代码智能当前已隔离");
    return service;
  }

  async setCodeIntelligenceEnabled(enabled: boolean): Promise<void> {
    await this.withCodeIntelligenceTransition(async () => {
      if (this.codeIntelligenceDisposing) throw new Error("SessionRuntime is disposing");
      if (enabled === this.codeIntelligenceEnabled) return;
      await this.codeIntelligenceManager.setLspEnabled(enabled);
      this.codeIntelligenceEnabled = enabled;
    });
  }

  async refreshProcessSandbox(processSandbox: SessionProcessSandboxConfig): Promise<void> {
    await this.withCodeIntelligenceTransition(async () => {
      if (this.codeIntelligenceDisposing) throw new Error("SessionRuntime is disposing");
      this.processSandbox = {
        ...processSandbox,
        ...(processSandbox.workspaceRoots
          ? { workspaceRoots: [...processSandbox.workspaceRoots] }
          : {}),
        ...(processSandbox.readRoots ? { readRoots: [...processSandbox.readRoots] } : {}),
        ...(processSandbox.writeRoots ? { writeRoots: [...processSandbox.writeRoots] } : {}),
        ...(processSandbox.readFiles ? { readFiles: [...processSandbox.readFiles] } : {}),
        ...(processSandbox.writeFiles ? { writeFiles: [...processSandbox.writeFiles] } : {}),
      };
      const scratchRoot =
        this.processSandbox?.scratchRoot ?? resolve(this.picoHome, "sandboxes", this.sessionId);
      await this.codeIntelligenceManager.updateProcessSandbox({
        workspaceRoots: this.processSandbox.workspaceRoots ?? [this.workDir],
        generation: this.processSandbox.generation ?? 0,
        scratchRoot,
        readRoots: [
          ...(this.processSandbox.readRoots ?? []),
          ...(this.processSandbox.writeRoots ?? []),
        ],
        readFiles: [
          ...(this.processSandbox.readFiles ?? []),
          ...(this.processSandbox.writeFiles ?? []),
        ],
        ...(this.processSandbox?.config ? { config: this.processSandbox.config } : {}),
      });
      this.hookRuntime?.updateProcessSandbox(
        createSandboxPolicy({
          profile: this.processSandbox?.profile ?? "workspace-write",
          workspaceRoots: this.processSandbox.workspaceRoots ?? [this.workDir],
          scratchRoot,
          generation: this.processSandbox.generation ?? 0,
          ...(this.processSandbox.readRoots ? { readRoots: this.processSandbox.readRoots } : {}),
          ...(this.processSandbox.writeRoots ? { writeRoots: this.processSandbox.writeRoots } : {}),
          ...(this.processSandbox.readFiles ? { readFiles: this.processSandbox.readFiles } : {}),
          ...(this.processSandbox.writeFiles ? { writeFiles: this.processSandbox.writeFiles } : {}),
          ...(this.processSandbox?.config ? { config: this.processSandbox.config } : {}),
        }),
      );
    });
  }

  get hookCommands(): readonly SlashCommand[] {
    return this.hookRuntime?.commands ?? [];
  }

  get hookManagement(): HookManagementService | undefined {
    return this.hookRuntime?.management;
  }

  attachHookService(service: HookService): void {
    if (this._hookService === service) return;
    if (this._hookService) {
      throw new Error("SessionRuntime 已挂载不同 HookService，禁止运行中替换。");
    }
    this._hookService = service;
    this.ensureSessionStart();
  }

  bindHookRuntime(dependencies: HookRuntimeBinding): void {
    this.hookRuntime?.bind(dependencies);
    this.ensureSessionStart();
  }

  async activateComponentHookLease(source: HookConfigSourceSpec): Promise<() => Promise<void>> {
    if (!this.hookRuntime) return async () => undefined;
    return await this.hookRuntime.activateComponentSource(source);
  }

  async activateComponentHooks(source: HookConfigSourceSpec): Promise<void> {
    this.componentHookDisposers.push(await this.activateComponentHookLease(source));
  }

  async clearComponentHooks(): Promise<void> {
    const disposers = this.componentHookDisposers.splice(0).reverse();
    for (const dispose of disposers) {
      try {
        await dispose();
      } catch (error) {
        logger.warn({ error: String(error) }, "[Hook] 组件 Hook source 释放失败");
      }
    }
  }

  async dispatchHook<E extends HookEvent>(
    event: E,
    payload: HookEventPayloadMap[E],
    context: HookExecutionContext = {},
  ): Promise<HookOutput> {
    if (!this._hookService) return { decision: "allow" };
    this.ensureSessionStart();
    // 序列边界：新的前台事件不得超过已启动的 SessionStart/任务转换。
    await this.drainHookEvents();
    return this._hookService.dispatch(event, payload, context);
  }

  async drainHookEvents(): Promise<void> {
    while (this.pendingHookEvents.size > 0) {
      await Promise.allSettled([...this.pendingHookEvents]);
    }
  }

  assertCompatible(session: Session): void {
    if (session === this.session) return;

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

  async dispose(): Promise<void> {
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
    await attempt(() => this.hookRuntime?.clearComponentSources());
    await attempt(() => this.ensureSessionStart());
    await attempt(() => this.drainHookEvents());

    let runningTasks: ReturnType<BackgroundManager["list"]> = [];
    await attempt(() => {
      runningTasks = this.backgroundManager.list().filter((task) => task.status === "running");
    });
    const ownedCleanup = await Promise.allSettled([
      this.withCodeIntelligenceTransition(() => this.codeIntelligenceManager.close()),
      ...runningTasks.map((task) => this.backgroundManager.stop(task.taskId)),
    ]);
    for (const result of ownedCleanup) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    await attempt(() => this.drainHookEvents());
    if (this._hookService) {
      await attempt(() => this._hookService!.dispatch("SessionEnd", { reason: "runtime_dispose" }));
    }

    await attempt(() => this.hookRuntime?.dispose());
    await attempt(() => detachSessionSandboxRoot(this.picoHome, this.sessionId));
    // Finalizers are terminal ownership transitions. They must all run even when
    // an earlier owned resource failed to close; callers generally discard this
    // runtime after dispose() settles and cannot safely retry a retained pin.
    await attempt(() => this.hookRewakeQueue.close());
    await attempt(() => this.unbindGoalManager());
    await attempt(() => this.releaseSessionPin());
    if (failures.length > 0) {
      throw new AggregateError(failures, `SessionRuntime ${this.sessionId} cleanup failed`);
    }
  }

  private async withCodeIntelligenceTransition<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.codeIntelligenceTransition;
    let release!: () => void;
    this.codeIntelligenceTransition = new Promise<void>((resolve) => {
      release = resolve;
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
    if (!this._hookService) return;
    this.ensureSessionStart();
    if (previous === undefined) {
      this.enqueueHook(
        this._hookService.dispatch("TaskCreated", {
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
        this._hookService.dispatch("SubagentStart", {
          agentId: snapshot.taskId,
          agentType: typeof snapshot.data?.["mode"] === "string" ? snapshot.data["mode"] : "worker",
          prompt: snapshot.description,
        }),
        "SubagentStart",
      );
    }
    if (isTerminalTaskStatus(snapshot.status) && !isTerminalTaskStatus(previous ?? "pending")) {
      this.enqueueHook(
        this._hookService.dispatch("TaskCompleted", {
          taskId: snapshot.taskId,
          status: snapshot.status,
        }),
        "TaskCompleted",
      );
      if (this.startedSubagents.has(snapshot.taskId)) {
        this.enqueueHook(
          this._hookService.dispatch("SubagentStop", {
            agentId: snapshot.taskId,
            status: snapshot.status,
            ...(snapshot.error ? { result: snapshot.error } : {}),
          }),
          "SubagentStop",
        );
      }
    }
  }

  private enqueueHook(promise: Promise<unknown>, event: HookEvent): void {
    const tracked = promise.catch((error) => {
      logger.warn(
        { event, sessionId: this.sessionId, error: String(error) },
        "[Hook] 会话生命周期事件执行失败",
      );
    });
    this.pendingHookEvents.add(tracked);
    void tracked.finally(() => this.pendingHookEvents.delete(tracked));
  }

  private ensureSessionStart(): void {
    if (!this._hookService || this.sessionStartDispatched) return;
    this.sessionStartDispatched = true;
    this.enqueueHook(
      this._hookService.dispatch("SessionStart", { source: this.sessionStartSource }),
      "SessionStart",
    );
  }
}

function detachSessionSandboxRoot(picoHome: string, sessionId: string): void {
  const parent = resolve(picoHome, "sandboxes");
  const target = resolve(parent, sessionId);
  const child = relative(parent, target);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`拒绝清理非会话沙箱目录: ${target}`);
  }
  if (!existsSync(target)) return;
  const detached = resolve(parent, `.cleanup-${randomUUID()}`);
  renameSync(target, detached);
  // 原子移出活动会话路径后再后台删除：同 session 重建时不会复用
  // 旧 HOME/cache，也不让递归 I/O 延迟已完成的前台 Run 返回。
  setImmediate(() => {
    void rm(detached, { recursive: true, force: true }).catch((error: unknown) =>
      logger.warn({ detached, error: String(error) }, "[沙箱] 会话隔离目录后台清理失败"),
    );
  });
}
