import { resolve } from "node:path";
import { WorkspaceTodoStore as TodoStore } from "@pico/pico-host/workspace-todo-store";
import { GoalManager } from "@pico/runtime/goal-manager";
import { globalSessionManager, type Session, type SessionManager } from "../engine/session.js";
import type { SessionManagerLease } from "../engine/session-manager.js";
import { SteerQueue } from "@pico/runtime";
import { FileIndex } from "@pico/pico-host/file-index";
import { logger } from "../observability/logger.js";
import { TaskRegistry } from "@pico/runtime/task-registry";
import type { TaskHostRuntime } from "@pico/pico-host/task-host-runtime";
import { BackgroundManager } from "@pico/pico-host/background-manager";
import { ToolDisclosure } from "@pico/runtime/tool-disclosure";
import {
  CodeIntelligenceManager,
  type CodeIntelligenceService,
  type LspServerConfig,
} from "@pico/pico-host/code-intelligence";
import { HookService } from "@pico/pico-host/hooks/service";
import {
  createSessionHookRuntime,
  type HookRuntimeBinding,
  type SessionHookRuntime,
} from "../hooks/runtime.js";
import type { SlashCommand } from "../input/types.js";
import type { HookConfigSourceSpec } from "../hooks/config.js";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import type { HookManagementService } from "../hooks/management/service.js";
import type {
  HookEvent,
  HookEventPayloadMap,
  HookExecutionContext,
  HookOutput,
} from "@pico/pico-host/hooks/types";
import { resolvePicoHome } from "../paths/pico-paths.js";
import {
  createSandboxPolicy,
  type SandboxConfig,
  type SandboxProfile,
} from "@pico/pico-host/process-sandbox";
import { HookRewakeQueue } from "@pico/runtime/hook-rewake";
export {
  HookRewakeCoordinator,
  HookRewakeQueue,
  type HookRewakeCoordinatorOptions,
  type HookRewakeEntry,
} from "@pico/runtime/hook-rewake";
import {
  SessionRuntimeLifecycle,
  type HostSessionProcessSandboxConfig,
  type SessionLifecycleHookPort,
} from "@pico/pico-host/session-runtime-lifecycle";

/** UI-independent services scoped to one persisted session. */
export type SessionProcessSandboxConfig = HostSessionProcessSandboxConfig<
  SandboxProfile,
  SandboxConfig
>;

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
    logger,
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
    todoStore: new TodoStore(workDir, { picoHome }, logger),
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
  private readonly lifecycle: SessionRuntimeLifecycle<
    SessionProcessSandboxConfig,
    HookConfigSourceSpec
  >;

  constructor(options: DefaultSessionRuntimeOptions) {
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
    this.hookRuntime = options.hookRuntime;
    this.lifecycle = new SessionRuntimeLifecycle({
      session: options.session,
      taskRegistry: options.taskRegistry,
      ...(options.taskHostRuntime ? { taskHostRuntime: options.taskHostRuntime } : {}),
      backgroundManager: options.backgroundManager,
      hookRewakeQueue: options.hookRewakeQueue,
      codeIntelligenceEnabled: options.codeIntelligenceEnabled,
      sessionStartSource: options.sessionStartSource,
      unbindGoalManager: options.unbindGoalManager,
      releaseSessionPin: options.releaseSessionPin,
      diagnostics: {
        warn: (context, message) => logger.warn(context, message),
      },
      code: {
        setEnabled: (enabled) => this.codeIntelligenceManager.setLspEnabled(enabled),
        applyProcessSandbox: async (processSandbox) => {
          const scratchRoot =
            processSandbox.scratchRoot ??
            resolve(this.lifecycle.picoHome, "sandboxes", this.lifecycle.sessionId);
          await this.codeIntelligenceManager.updateProcessSandbox({
            workspaceRoots: processSandbox.workspaceRoots ?? [this.lifecycle.workDir],
            generation: processSandbox.generation ?? 0,
            scratchRoot,
            readRoots: [
              ...(processSandbox.readRoots ?? []),
              ...(processSandbox.writeRoots ?? []),
            ],
            readFiles: [
              ...(processSandbox.readFiles ?? []),
              ...(processSandbox.writeFiles ?? []),
            ],
            ...(processSandbox.config ? { config: processSandbox.config } : {}),
          });
          this.hookRuntime?.updateProcessSandbox(
            createSandboxPolicy({
              profile: processSandbox.profile ?? "workspace-write",
              workspaceRoots: processSandbox.workspaceRoots ?? [this.lifecycle.workDir],
              scratchRoot,
              generation: processSandbox.generation ?? 0,
              ...(processSandbox.readRoots ? { readRoots: processSandbox.readRoots } : {}),
              ...(processSandbox.writeRoots ? { writeRoots: processSandbox.writeRoots } : {}),
              ...(processSandbox.readFiles ? { readFiles: processSandbox.readFiles } : {}),
              ...(processSandbox.writeFiles ? { writeFiles: processSandbox.writeFiles } : {}),
              ...(processSandbox.config ? { config: processSandbox.config } : {}),
            }),
          );
        },
        close: () => this.codeIntelligenceManager.close(),
      },
      ...(options.hookRuntime
        ? {
            componentHooks: {
              activate: (source: HookConfigSourceSpec) =>
                options.hookRuntime!.activateComponentSource(source),
              clearSources: () => options.hookRuntime!.clearComponentSources(),
              dispose: () => options.hookRuntime!.dispose(),
            },
          }
        : {}),
    });
    this.workDir = this.lifecycle.workDir;
    this.sessionId = this.lifecycle.sessionId;
    this.picoHome = this.lifecycle.picoHome;
    if (options.hookRuntime) {
      this._hookService = options.hookRuntime.service;
      this.lifecycle.attachHookService(this.lifecycleHookPort(options.hookRuntime.service));
    }
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
    await this.lifecycle.setCodeIntelligenceEnabled(enabled);
  }

  async refreshProcessSandbox(processSandbox: SessionProcessSandboxConfig): Promise<void> {
    await this.lifecycle.refreshProcessSandbox({
      ...processSandbox,
      ...(processSandbox.workspaceRoots
        ? { workspaceRoots: [...processSandbox.workspaceRoots] }
        : {}),
      ...(processSandbox.readRoots ? { readRoots: [...processSandbox.readRoots] } : {}),
      ...(processSandbox.writeRoots ? { writeRoots: [...processSandbox.writeRoots] } : {}),
      ...(processSandbox.readFiles ? { readFiles: [...processSandbox.readFiles] } : {}),
      ...(processSandbox.writeFiles ? { writeFiles: [...processSandbox.writeFiles] } : {}),
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
    this.lifecycle.attachHookService(this.lifecycleHookPort(service));
  }

  bindHookRuntime(dependencies: HookRuntimeBinding): void {
    this.hookRuntime?.bind(dependencies);
    this.lifecycle.ensureSessionStart();
  }

  async activateComponentHookLease(source: HookConfigSourceSpec): Promise<() => Promise<void>> {
    return this.lifecycle.activateComponentHookLease(source);
  }

  async activateComponentHooks(source: HookConfigSourceSpec): Promise<void> {
    await this.lifecycle.activateComponentHooks(source);
  }

  async clearComponentHooks(): Promise<void> {
    await this.lifecycle.clearComponentHooks();
  }

  async dispatchHook<E extends HookEvent>(
    event: E,
    payload: HookEventPayloadMap[E],
    context: HookExecutionContext = {},
  ): Promise<HookOutput> {
    if (!this._hookService) return { decision: "allow" };
    this.lifecycle.ensureSessionStart();
    // 序列边界：新的前台事件不得超过已启动的 SessionStart/任务转换。
    await this.drainHookEvents();
    return this._hookService.dispatch(event, payload, context);
  }

  async drainHookEvents(): Promise<void> {
    await this.lifecycle.drainHookEvents();
  }

  assertCompatible(session: Session): void {
    this.lifecycle.assertCompatible(session);
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }

  private lifecycleHookPort(service: HookService): SessionLifecycleHookPort {
    return {
      dispatch: (event, payload) => service.dispatch(event, payload as never),
    };
  }
}
