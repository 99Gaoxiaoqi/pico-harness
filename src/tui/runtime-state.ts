import { resolve } from "node:path";
import { TodoStore } from "../context/todo-store.js";
import { GoalManager } from "../engine/goal-manager.js";
import type { Session } from "../engine/session.js";
import { SteerQueue } from "../engine/steer-queue.js";
import { FileIndex } from "../input/file-index.js";
import { MemoryNudger } from "../memory/memory-nudger.js";
import { SkillRegistry } from "../memory/skill-registry.js";
import { TaskRegistry } from "../tasks/task-registry.js";
import type { TaskHostRuntime } from "../tasks/task-runtime.js";
import { BackgroundManager } from "../tools/background-manager.js";
import { DelegationManager } from "../tools/delegation-manager.js";
import { ToolDisclosure } from "../tools/tool-disclosure.js";
import {
  CodeIntelligenceManager,
  type CodeIntelligenceService,
  type LspServerConfig,
} from "../code-intelligence/index.js";

export interface TuiRuntimeStateOptions {
  workDir: string;
  sessionId: string;
  session: Session;
  toolDisclosure?: ToolDisclosure;
  lspServers?: readonly LspServerConfig[];
  taskHostRuntime?: TaskHostRuntime;
}

export interface TuiRuntimeState {
  readonly workDir: string;
  readonly sessionId: string;
  readonly goalManager: GoalManager;
  readonly todoStore: TodoStore;
  readonly toolDisclosure: ToolDisclosure;
  readonly taskRegistry: TaskRegistry;
  readonly taskHostRuntime?: TaskHostRuntime;
  readonly backgroundManager: BackgroundManager;
  readonly delegationManager: DelegationManager;
  readonly skillRegistry: SkillRegistry;
  readonly memoryNudger: MemoryNudger | undefined;
  readonly fileIndex: FileIndex;
  readonly steerQueue: SteerQueue;
  readonly codeIntelligence: CodeIntelligenceService;
  readonly codeIntelligenceManager: CodeIntelligenceManager;
  assertCompatible(workDir: string, sessionId: string): void;
  conversationTurnCount(session: Session): number;
  dispose(): Promise<void>;
}

export async function createTuiRuntimeState(
  options: TuiRuntimeStateOptions,
): Promise<TuiRuntimeState> {
  const workDir = resolve(options.workDir);
  if (options.session.id !== options.sessionId) {
    throw new Error(
      `TUI runtime session mismatch: expected ${options.sessionId}, received ${options.session.id}`,
    );
  }
  if (resolve(options.session.workDir) !== workDir) {
    throw new Error(
      `TUI runtime workDir mismatch: expected ${workDir}, received ${options.session.workDir}`,
    );
  }

  const taskRegistry = options.taskHostRuntime?.taskRegistry ?? new TaskRegistry();
  const skillRegistry = new SkillRegistry(workDir);
  await skillRegistry.init();
  const goalManager = new GoalManager();
  const unbindGoalManager = options.session.bindGoalManager(goalManager);
  const codeIntelligenceManager = new CodeIntelligenceManager({
    rootDir: workDir,
    ...(options.lspServers ? { lspServers: options.lspServers } : {}),
  });
  await codeIntelligenceManager.start();
  const codeIntelligence = codeIntelligenceManager.service();
  if (!codeIntelligence) {
    await codeIntelligenceManager.close();
    unbindGoalManager();
    throw new Error("代码智能服务启动后未提供 LSP 或 Repo Map 后端");
  }

  return new DefaultTuiRuntimeState({
    workDir,
    sessionId: options.sessionId,
    goalManager,
    todoStore: new TodoStore(workDir),
    toolDisclosure: options.toolDisclosure ?? new ToolDisclosure(),
    taskRegistry,
    ...(options.taskHostRuntime ? { taskHostRuntime: options.taskHostRuntime } : {}),
    backgroundManager: new BackgroundManager({ taskRegistry }),
    delegationManager: new DelegationManager({ taskRegistry }),
    skillRegistry,
    memoryNudger: new MemoryNudger(skillRegistry, options.session.sessionSummaryStore),
    fileIndex: FileIndex.create({ cwd: workDir }),
    steerQueue: new SteerQueue(),
    codeIntelligence,
    codeIntelligenceManager,
    unbindGoalManager,
  });
}

interface DefaultTuiRuntimeStateOptions {
  workDir: string;
  sessionId: string;
  goalManager: GoalManager;
  todoStore: TodoStore;
  toolDisclosure: ToolDisclosure;
  taskRegistry: TaskRegistry;
  taskHostRuntime?: TaskHostRuntime;
  backgroundManager: BackgroundManager;
  delegationManager: DelegationManager;
  skillRegistry: SkillRegistry;
  memoryNudger: MemoryNudger | undefined;
  fileIndex: FileIndex;
  steerQueue: SteerQueue;
  codeIntelligence: CodeIntelligenceService;
  codeIntelligenceManager: CodeIntelligenceManager;
  unbindGoalManager: () => void;
}

class DefaultTuiRuntimeState implements TuiRuntimeState {
  readonly workDir: string;
  readonly sessionId: string;
  readonly goalManager: GoalManager;
  readonly todoStore: TodoStore;
  readonly toolDisclosure: ToolDisclosure;
  readonly taskRegistry: TaskRegistry;
  readonly taskHostRuntime?: TaskHostRuntime;
  readonly backgroundManager: BackgroundManager;
  readonly delegationManager: DelegationManager;
  readonly skillRegistry: SkillRegistry;
  readonly memoryNudger: MemoryNudger | undefined;
  readonly fileIndex: FileIndex;
  readonly steerQueue: SteerQueue;
  readonly codeIntelligence: CodeIntelligenceService;
  readonly codeIntelligenceManager: CodeIntelligenceManager;
  private readonly unbindGoalManager: () => void;
  private disposePromise?: Promise<void>;

  constructor(options: DefaultTuiRuntimeStateOptions) {
    this.workDir = options.workDir;
    this.sessionId = options.sessionId;
    this.goalManager = options.goalManager;
    this.todoStore = options.todoStore;
    this.toolDisclosure = options.toolDisclosure;
    this.taskRegistry = options.taskRegistry;
    this.taskHostRuntime = options.taskHostRuntime;
    this.backgroundManager = options.backgroundManager;
    this.delegationManager = options.delegationManager;
    this.skillRegistry = options.skillRegistry;
    this.memoryNudger = options.memoryNudger;
    this.fileIndex = options.fileIndex;
    this.steerQueue = options.steerQueue;
    this.codeIntelligence = options.codeIntelligence;
    this.codeIntelligenceManager = options.codeIntelligenceManager;
    this.unbindGoalManager = options.unbindGoalManager;
  }

  assertCompatible(workDir: string, sessionId: string): void {
    if (resolve(workDir) !== this.workDir) {
      throw new Error(
        `TUI runtime workDir mismatch: expected ${this.workDir}, received ${resolve(workDir)}`,
      );
    }
    if (sessionId !== this.sessionId) {
      throw new Error(
        `TUI runtime session mismatch: expected ${this.sessionId}, received ${sessionId}`,
      );
    }
  }

  conversationTurnCount(session: Session): number {
    this.assertCompatible(session.workDir, session.id);
    return session
      .getHistory()
      .filter((message) => message.role === "user" && message.toolCallId === undefined).length;
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      try {
        const runningTasks = this.backgroundManager
          .list()
          .filter((task) => task.status === "running");
        await Promise.allSettled([
          this.delegationManager.dispose(),
          this.codeIntelligenceManager.close(),
          ...runningTasks.map((task) => this.backgroundManager.stop(task.taskId)),
        ]);
      } finally {
        this.unbindGoalManager();
      }
    })();
    return this.disposePromise;
  }
}
