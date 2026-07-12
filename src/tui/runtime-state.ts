import { resolve } from "node:path";
import { TodoStore } from "../context/todo-store.js";
import { GoalManager } from "../engine/goal-manager.js";
import type { Session } from "../engine/session.js";
import { SteerQueue } from "../engine/steer-queue.js";
import type { Message } from "../schema/message.js";
import { FileIndex } from "../input/file-index.js";
import { MemoryNudger } from "../memory/memory-nudger.js";
import { SkillRegistry } from "../memory/skill-registry.js";
import { TaskRegistry } from "../tasks/task-registry.js";
import type { TaskHostRuntime } from "../tasks/task-runtime.js";
import { BackgroundManager } from "../tools/background-manager.js";
import {
  DelegationManager,
  formatDelegationCompletions,
  type DelegationCompletionEnvelope,
} from "../tools/delegation-manager.js";
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
  readonly delegationCompletionQueue: DelegationCompletionWakeQueue;
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

export function createDelegationCompletionMessage(
  completion: DelegationCompletionEnvelope,
): Message {
  return {
    role: "user",
    content: formatDelegationCompletions([completion]),
    providerData: {
      picoKind: "subagent_completion",
      picoHiddenFromTranscript: true,
    },
  };
}

export interface DelegationCompletionWakeQueueOptions {
  deliver: (completion: DelegationCompletionEnvelope) => void;
}

/**
 * 将可续跑 completion 按 completionSeq 去重并合并为一次待消费 wake。
 * seen 序号在消费后仍保留，迟到或重复通知不会再次驱动主 Agent。
 */
export class DelegationCompletionWakeQueue {
  private readonly seenCompletionSeqs = new Set<number>();
  private readonly pendingCompletionSeqs = new Set<number>();
  private readonly subscribers = new Set<() => void>();
  private readonly deliver: DelegationCompletionWakeQueueOptions["deliver"];
  private closed = false;

  constructor(options: DelegationCompletionWakeQueueOptions) {
    this.deliver = options.deliver;
  }

  enqueue(completion: DelegationCompletionEnvelope): boolean {
    if (
      this.closed ||
      this.seenCompletionSeqs.has(completion.completionSeq) ||
      !shouldWakeForCompletion(completion)
    ) {
      return false;
    }

    this.deliver(completion);
    this.seenCompletionSeqs.add(completion.completionSeq);
    const shouldNotify = this.pendingCompletionSeqs.size === 0;
    this.pendingCompletionSeqs.add(completion.completionSeq);
    if (shouldNotify) {
      for (const subscriber of this.subscribers) subscriber();
    }
    return true;
  }

  consumePendingCompletionSeqs(): readonly number[] {
    const sequences = [...this.pendingCompletionSeqs].sort((left, right) => left - right);
    this.pendingCompletionSeqs.clear();
    return sequences;
  }

  get hasPending(): boolean {
    return this.pendingCompletionSeqs.size > 0;
  }

  subscribe(subscriber: () => void): () => void {
    if (this.closed) return () => undefined;
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  close(): void {
    this.closed = true;
    this.pendingCompletionSeqs.clear();
    this.subscribers.clear();
  }
}

export interface DelegationWakeCoordinatorOptions {
  queue: DelegationCompletionWakeQueue;
  isIdle: () => boolean;
  resume: (completionSeqs: readonly number[]) => Promise<void>;
  onError?: (error: unknown) => void;
  schedule?: (callback: () => void) => void;
}

/** 空闲时消费一批 completion 并续跑一次；运行期间的新 completion 留给下一批。 */
export class DelegationWakeCoordinator {
  private readonly unsubscribe: () => void;
  private readonly schedule: (callback: () => void) => void;
  private scheduled = false;
  private running = false;
  private disposed = false;

  constructor(private readonly options: DelegationWakeCoordinatorOptions) {
    this.schedule = options.schedule ?? queueMicrotask;
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
    this.schedule(() => {
      this.scheduled = false;
      void this.resumePending();
    });
  }

  private async resumePending(): Promise<void> {
    if (this.disposed || this.running || !this.options.isIdle()) return;
    const completionSeqs = this.options.queue.consumePendingCompletionSeqs();
    if (completionSeqs.length === 0) return;

    this.running = true;
    try {
      await this.options.resume(completionSeqs);
    } catch (error) {
      // completion 在 enqueue 时已先写入 Session。续跑失败不自动重试，避免无限唤醒；
      // 隐藏消息仍留在历史中，下一次正常用户轮可继续消费。
      this.options.onError?.(error);
    } finally {
      this.running = false;
      if (this.options.queue.hasPending) this.request();
    }
  }
}

function shouldWakeForCompletion(completion: DelegationCompletionEnvelope): boolean {
  if (completion.completionPolicy === "optional") return true;
  return completion.completionPolicy === "detached" && completion.status !== "completed";
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

  const steerQueue = new SteerQueue();
  const delegationCompletionQueue = new DelegationCompletionWakeQueue({
    deliver: (completion) => options.session.append(createDelegationCompletionMessage(completion)),
  });
  return new DefaultTuiRuntimeState({
    workDir,
    sessionId: options.sessionId,
    goalManager,
    todoStore: new TodoStore(workDir),
    toolDisclosure: options.toolDisclosure ?? new ToolDisclosure(),
    taskRegistry,
    ...(options.taskHostRuntime ? { taskHostRuntime: options.taskHostRuntime } : {}),
    backgroundManager: new BackgroundManager({ taskRegistry }),
    delegationManager: new DelegationManager({
      taskRegistry,
      onCompletion: (completion) => delegationCompletionQueue.enqueue(completion),
    }),
    delegationCompletionQueue,
    skillRegistry,
    memoryNudger: new MemoryNudger(skillRegistry, options.session.sessionSummaryStore),
    fileIndex: FileIndex.create({ cwd: workDir }),
    steerQueue,
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
  delegationCompletionQueue: DelegationCompletionWakeQueue;
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
  readonly delegationCompletionQueue: DelegationCompletionWakeQueue;
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
    this.delegationCompletionQueue = options.delegationCompletionQueue;
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
        this.delegationCompletionQueue.close();
        this.unbindGoalManager();
      }
    })();
    return this.disposePromise;
  }
}
