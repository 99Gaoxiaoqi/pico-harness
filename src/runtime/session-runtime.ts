import { resolve } from "node:path";
import { TodoStore } from "../context/todo-store.js";
import { GoalManager } from "../engine/goal-manager.js";
import type { Session } from "../engine/session.js";
import { SteerQueue } from "../engine/steer-queue.js";
import type { Message } from "../schema/message.js";
import { FileIndex } from "../input/file-index.js";
import { MemoryNudger } from "../memory/memory-nudger.js";
import { logger } from "../observability/logger.js";
import { SkillRegistry } from "../memory/skill-registry.js";
import { TaskRegistry } from "../tasks/task-registry.js";
import type { TaskHostRuntime } from "../tasks/task-runtime.js";
import type { CompletionOutboxRecord } from "../tasks/runtime-types.js";
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

/** UI-independent services scoped to one persisted session. */
export interface SessionRuntimeOptions {
  workDir: string;
  sessionId: string;
  session: Session;
  toolDisclosure?: ToolDisclosure;
  lspServers?: readonly LspServerConfig[];
  taskHostRuntime?: TaskHostRuntime;
  /** Durable completion outbox 的活态发现间隔。 */
  completionPollIntervalMs?: number;
}

export interface SessionRuntime {
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
      picoCompletionId: completion.completionId,
      picoCompletionSeq: completion.completionSeq,
      picoCompletionOwnerSessionId: completion.ownerSessionId,
      picoCompletionJobId: completion.jobId,
      picoCompletionActivityIds: [...completion.activityIds],
      picoCompletionPolicy: completion.completionPolicy,
      picoCompletionStatus: completion.status,
    },
  };
}

export interface DelegationCompletionWakeQueueOptions {
  deliver: (completion: DelegationCompletionEnvelope) => void | Promise<void>;
}

/**
 * 将可续跑 completion 按 completionSeq 去重并合并为一次待消费 wake。
 * seen 序号在消费后仍保留，迟到或重复通知不会再次驱动主 Agent。
 */
export class DelegationCompletionWakeQueue {
  private readonly seenCompletionIds = new Set<string>();
  private readonly pendingCompletions = new Map<number, DelegationCompletionEnvelope>();
  private readonly subscribers = new Set<() => void>();
  private readonly deliver: DelegationCompletionWakeQueueOptions["deliver"];
  private closed = false;

  constructor(options: DelegationCompletionWakeQueueOptions) {
    this.deliver = options.deliver;
  }

  enqueue(completion: DelegationCompletionEnvelope): boolean {
    if (
      this.closed ||
      this.seenCompletionIds.has(completion.completionId) ||
      !shouldWakeForCompletion(completion)
    ) {
      return false;
    }

    this.seenCompletionIds.add(completion.completionId);
    const shouldNotify = this.pendingCompletions.size === 0;
    let queueSequence = completion.completionSeq;
    while (this.pendingCompletions.has(queueSequence)) queueSequence++;
    this.pendingCompletions.set(queueSequence, completion);
    if (shouldNotify) {
      for (const subscriber of this.subscribers) subscriber();
    }
    return true;
  }

  pendingCompletionSeqs(): readonly number[] {
    return [...this.pendingCompletions.keys()].sort((left, right) => left - right);
  }

  /**
   * 拿到 TUI 空闲执行权后才把对应 completion 写入 Session。
   * 先 deliver 再删除：若 Session 写入失败，未写入项仍可在下一次空闲边界重试。
   */
  async deliverPendingCompletionSeqs(
    sequences: readonly number[],
  ): Promise<readonly DelegationCompletionEnvelope[]> {
    const delivered: DelegationCompletionEnvelope[] = [];
    for (const sequence of sequences) {
      const completion = this.pendingCompletions.get(sequence);
      if (!completion) continue;
      await this.deliver(completion);
      this.pendingCompletions.delete(sequence);
      delivered.push(completion);
    }
    return delivered;
  }

  get hasPending(): boolean {
    return this.pendingCompletions.size > 0;
  }

  subscribe(subscriber: () => void): () => void {
    if (this.closed) return () => undefined;
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  close(): void {
    this.closed = true;
    this.pendingCompletions.clear();
    this.subscribers.clear();
  }
}

export interface DelegationWakeCoordinatorOptions {
  queue: DelegationCompletionWakeQueue;
  isIdle: () => boolean;
  resume: (
    completionSeqs: readonly number[],
    deliverCompletions: () => Promise<readonly DelegationCompletionEnvelope[]>,
  ) => Promise<void>;
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
    const completionSeqs = this.options.queue.pendingCompletionSeqs();
    if (completionSeqs.length === 0) return;

    this.running = true;
    let deliveredCompletions: readonly DelegationCompletionEnvelope[] | undefined;
    try {
      await this.options.resume(completionSeqs, async () => {
        if (deliveredCompletions) return deliveredCompletions;
        deliveredCompletions =
          await this.options.queue.deliverPendingCompletionSeqs(completionSeqs);
        return deliveredCompletions;
      });
    } catch (error) {
      // 已 deliver 的 completion 保留在 Session，续跑失败不自动重试，避免无限唤醒；
      // 尚未 deliver 说明空闲保留失败，继续留在队列等待下一次 idle 通知。
      this.options.onError?.(error);
    } finally {
      this.running = false;
      // 仅在本批已交付时主动调度运行期间新到的 completion；保留失败由下一次 idle 唤醒，
      // 避免 isIdle 仍为 true 的异常实现形成微任务自旋。
      if (deliveredCompletions !== undefined && this.options.queue.hasPending) this.request();
    }
  }
}

function shouldWakeForCompletion(completion: DelegationCompletionEnvelope): boolean {
  if (completion.completionPolicy === "optional") return true;
  return completion.status !== "completed";
}

export async function createSessionRuntime(
  options: SessionRuntimeOptions,
): Promise<SessionRuntime> {
  const workDir = resolve(options.workDir);
  const completionPollIntervalMs = options.taskHostRuntime
    ? positiveDuration(options.completionPollIntervalMs ?? 250, "completionPollIntervalMs")
    : undefined;
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
  const jobService = options.taskHostRuntime?.jobService;
  const delegationCompletionQueue = new DelegationCompletionWakeQueue({
    deliver: async (completion) => {
      if (jobService) {
        const pending = jobService
          .pendingCompletions({ ownerSessionId: options.sessionId, limit: 1_000 })
          .find((candidate) => candidate.completionId === completion.completionId);
        // Durable outbox 是新 completion 的权威源。如果消息已经入会话且
        // outbox 已 ack，这是崩溃恢复的 resume-only wake，不得重复注入。
        if (!pending) {
          const alreadyCommitted = options.session
            .getHistory()
            .some(
              (message) =>
                message.providerData?.["picoKind"] === "subagent_completion" &&
                message.providerData?.["picoCompletionId"] === completion.completionId,
            );
          if (alreadyCommitted) return;
          throw new Error(
            `Delegation completion ${completion.completionId} has no pending durable outbox record`,
          );
        }
        await options.session.commitMessageOnce(
          completion.completionId,
          createDelegationCompletionMessage(completion),
        );
        jobService.markCompletionDelivered(completion.completionId);
        return;
      }
      await options.session.commitMessages(createDelegationCompletionMessage(completion));
    },
  });
  let completionPollTimer: ReturnType<typeof setInterval> | undefined;
  if (jobService) {
    if (completionPollIntervalMs === undefined) {
      throw new Error("taskHostRuntime 缺少 completion poll 配置");
    }
    const scanDurableCompletions = (): void => {
      try {
        for (const completion of jobService.pendingCompletions({
          ownerSessionId: options.sessionId,
          limit: 1_000,
        })) {
          const envelope = delegationEnvelopeFromOutbox(completion, options.sessionId);
          if (envelope) delegationCompletionQueue.enqueue(envelope);
        }
      } catch (error) {
        logger.warn(
          { sessionId: options.sessionId, error: String(error) },
          "[runtime-store] 扫描 durable completion outbox 失败",
        );
      }
    };
    scanDurableCompletions();
    completionPollTimer = setInterval(scanDurableCompletions, completionPollIntervalMs);
    completionPollTimer.unref?.();
    for (const completion of unconsumedDelegationCompletions(
      options.session.getHistory(),
      options.sessionId,
    )) {
      delegationCompletionQueue.enqueue(completion);
    }
  }
  return new DefaultSessionRuntime({
    workDir,
    sessionId: options.sessionId,
    goalManager,
    todoStore: new TodoStore(workDir),
    toolDisclosure: options.toolDisclosure ?? new ToolDisclosure(),
    taskRegistry,
    ...(options.taskHostRuntime ? { taskHostRuntime: options.taskHostRuntime } : {}),
    backgroundManager: new BackgroundManager({
      taskRegistry,
      ownerSessionId: options.sessionId,
    }),
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
    stopDelegationCompletionPolling: () => {
      if (completionPollTimer) clearInterval(completionPollTimer);
      completionPollTimer = undefined;
    },
  });
}

function delegationEnvelopeFromOutbox(
  completion: CompletionOutboxRecord,
  ownerSessionId: string,
): DelegationCompletionEnvelope | undefined {
  const payload = completion.payload?.["delegationCompletion"];
  if (!isRecord(payload)) return undefined;
  const completionId = payload["completionId"];
  const jobId = payload["jobId"];
  const completionSeq = payload["completionSeq"];
  const completionPolicy = payload["completionPolicy"];
  const status = payload["status"];
  const outputSummary = payload["outputSummary"];
  const activityIds = payload["activityIds"];
  const payloadOwner = payload["ownerSessionId"];
  if (
    completionId !== completion.completionId ||
    typeof jobId !== "string" ||
    payloadOwner !== ownerSessionId ||
    (completionPolicy !== "required" &&
      completionPolicy !== "optional" &&
      completionPolicy !== "detached") ||
    (status !== "completed" &&
      status !== "partial" &&
      status !== "error" &&
      status !== "timed_out" &&
      status !== "cancelled") ||
    typeof outputSummary !== "string" ||
    !Array.isArray(activityIds) ||
    !activityIds.every((value) => typeof value === "string")
  ) {
    return undefined;
  }
  return {
    completionId,
    jobId,
    ownerSessionId,
    completionSeq:
      typeof completionSeq === "number" && Number.isSafeInteger(completionSeq)
        ? completionSeq
        : completion.createdAt,
    activityIds,
    completionPolicy,
    status,
    outputSummary,
    ...(typeof payload["error"] === "string" ? { error: payload["error"] } : {}),
  };
}

/**
 * 恢复“Session 已持久化 + outbox 已 ack，但 Agent 还没真正续跑”的窄崩溃窗口。
 * 只查看最近一条 assistant 响应之后的隐藏 completion；一旦看到新的显式
 * 用户输入就停止，避免越过独立的用户轮次自动续跑。
 */
function unconsumedDelegationCompletions(
  history: readonly Message[],
  ownerSessionId: string,
): readonly DelegationCompletionEnvelope[] {
  const recovered: DelegationCompletionEnvelope[] = [];
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    if (message.role === "assistant") break;
    if (
      message.role === "user" &&
      message.toolCallId === undefined &&
      message.providerData?.["picoHiddenFromTranscript"] !== true
    ) {
      break;
    }
    if (message.providerData?.["picoKind"] !== "subagent_completion") continue;
    const completion = delegationEnvelopeFromCommittedMessage(message, ownerSessionId);
    if (completion) recovered.unshift(completion);
  }
  return recovered;
}

function delegationEnvelopeFromCommittedMessage(
  message: Message,
  ownerSessionId: string,
): DelegationCompletionEnvelope | undefined {
  const data = message.providerData;
  if (!data) return undefined;
  const completionId = data["picoCompletionId"];
  const completionSeq = data["picoCompletionSeq"];
  const payloadOwner = data["picoCompletionOwnerSessionId"];
  const jobId = data["picoCompletionJobId"];
  const activityIds = data["picoCompletionActivityIds"];
  const completionPolicy = data["picoCompletionPolicy"];
  const status = data["picoCompletionStatus"];
  if (
    typeof completionId !== "string" ||
    typeof completionSeq !== "number" ||
    !Number.isSafeInteger(completionSeq) ||
    payloadOwner !== ownerSessionId ||
    typeof jobId !== "string" ||
    !Array.isArray(activityIds) ||
    !activityIds.every((value) => typeof value === "string") ||
    (completionPolicy !== "required" &&
      completionPolicy !== "optional" &&
      completionPolicy !== "detached") ||
    (status !== "completed" &&
      status !== "partial" &&
      status !== "error" &&
      status !== "timed_out" &&
      status !== "cancelled")
  ) {
    return undefined;
  }
  return {
    completionId,
    completionSeq,
    ownerSessionId,
    jobId,
    activityIds,
    completionPolicy,
    status,
    outputSummary: message.content,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface DefaultSessionRuntimeOptions {
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
  stopDelegationCompletionPolling: () => void;
}

class DefaultSessionRuntime implements SessionRuntime {
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
  private readonly stopDelegationCompletionPolling: () => void;
  private disposePromise?: Promise<void>;

  constructor(options: DefaultSessionRuntimeOptions) {
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
    this.stopDelegationCompletionPolling = options.stopDelegationCompletionPolling;
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
      this.stopDelegationCompletionPolling();
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

function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须为正数`);
  return value;
}
