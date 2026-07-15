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
import { HookService } from "../hooks/service.js";
import {
  createSessionHookRuntime,
  type HookRuntimeBinding,
  type SessionHookRuntime,
} from "../hooks/runtime.js";
import type { SlashCommand } from "../input/types.js";
import type { HookConfigSourceSpec } from "../hooks/config.js";
import type { HookManagementService } from "../hooks/management/service.js";
import type {
  HookEvent,
  HookEventPayloadMap,
  HookExecutionContext,
  HookOutput,
} from "../hooks/types.js";
import { isTerminalTaskStatus, type TaskSnapshot } from "../tasks/task-registry.js";

/** UI-independent services scoped to one persisted session. */
export interface SessionRuntimeOptions {
  workDir: string;
  sessionId: string;
  session: Session;
  /** Host-owned Pico state root for session-scoped durable stores. */
  picoHome?: string;
  /** Host-owned environment inherited by the session Hook executor. */
  env?: Readonly<NodeJS.ProcessEnv>;
  toolDisclosure?: ToolDisclosure;
  lspServers?: readonly LspServerConfig[];
  taskHostRuntime?: TaskHostRuntime;
  /** Durable completion outbox 的活态发现间隔。 */
  completionPollIntervalMs?: number;
  sessionStartSource?: "startup" | "resume";
  /** 后台/Cron 显式关闭前台 HookService，继续走严格 command-only policy。 */
  hooks?: false;
  /** 测试或宿主可注入自管 HookService；注入时不创建默认 watcher/management。 */
  hookService?: HookService;
  hookUserHome?: string;
  /** 已由 Plugin 信任层冻结的扩展 Hook 来源。 */
  hookExtensionSources?: readonly HookConfigSourceSpec[];
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
  readonly hookRewakeQueue: HookRewakeQueue;
  readonly skillRegistry: SkillRegistry;
  readonly memoryNudger: MemoryNudger | undefined;
  readonly fileIndex: FileIndex;
  readonly steerQueue: SteerQueue;
  readonly codeIntelligence: CodeIntelligenceService;
  readonly codeIntelligenceManager: CodeIntelligenceManager;
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
  const skillRegistry = new SkillRegistry(workDir, { picoHome: options.picoHome });
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
  const hookRewakeQueue = new HookRewakeQueue(async (entries) => {
    await options.session.commitMessages({
      role: "user",
      content: entries.map((entry) => entry.message).join("\n\n"),
      providerData: {
        picoKind: "hook_async_rewake",
        picoHiddenFromTranscript: true,
        picoHookRewakeIds: entries.map((entry) => entry.id),
      },
    });
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
  const hookRuntime =
    options.hooks === false || options.hookService
      ? undefined
      : await createSessionHookRuntime({
          workDir,
          sessionId: options.sessionId,
          ...(options.picoHome ? { picoHome: options.picoHome } : {}),
          ...(options.env ? { env: options.env } : {}),
          ...(options.hookUserHome ? { userHome: options.hookUserHome } : {}),
          ...(options.hookExtensionSources
            ? { extensionSources: options.hookExtensionSources }
            : {}),
        }).catch((error) => {
          logger.warn(
            { sessionId: options.sessionId, error: String(error) },
            "[Hook] 会话级运行时初始化失败，前台 hooks fail-open",
          );
          return undefined;
        });
  return new DefaultSessionRuntime({
    workDir,
    sessionId: options.sessionId,
    goalManager,
    todoStore: new TodoStore(workDir, { picoHome: options.picoHome }),
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
    hookRewakeQueue,
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
    sessionStartSource: options.sessionStartSource ?? "startup",
    ...(hookRuntime ? { hookRuntime } : {}),
    ...(options.hookService ? { hookService: options.hookService } : {}),
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
  hookRewakeQueue: HookRewakeQueue;
  skillRegistry: SkillRegistry;
  memoryNudger: MemoryNudger | undefined;
  fileIndex: FileIndex;
  steerQueue: SteerQueue;
  codeIntelligence: CodeIntelligenceService;
  codeIntelligenceManager: CodeIntelligenceManager;
  unbindGoalManager: () => void;
  stopDelegationCompletionPolling: () => void;
  sessionStartSource: "startup" | "resume";
  hookRuntime?: SessionHookRuntime;
  hookService?: HookService;
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
  readonly hookRewakeQueue: HookRewakeQueue;
  readonly skillRegistry: SkillRegistry;
  readonly memoryNudger: MemoryNudger | undefined;
  readonly fileIndex: FileIndex;
  readonly steerQueue: SteerQueue;
  readonly codeIntelligence: CodeIntelligenceService;
  readonly codeIntelligenceManager: CodeIntelligenceManager;
  private _hookService?: HookService;
  private readonly hookRuntime?: SessionHookRuntime;
  private readonly pendingHookEvents = new Set<Promise<unknown>>();
  private readonly componentHookDisposers: Array<() => Promise<void>> = [];
  private readonly taskStatuses = new Map<string, TaskSnapshot["status"]>();
  private readonly startedSubagents = new Set<string>();
  private readonly sessionStartSource: "startup" | "resume";
  private sessionStartDispatched = false;
  private readonly unsubscribeTaskHooks: () => void;
  private readonly unsubscribeWorktreeHooks?: () => void;
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
    this.hookRewakeQueue = options.hookRewakeQueue;
    this.skillRegistry = options.skillRegistry;
    this.memoryNudger = options.memoryNudger;
    this.fileIndex = options.fileIndex;
    this.steerQueue = options.steerQueue;
    this.codeIntelligence = options.codeIntelligence;
    this.codeIntelligenceManager = options.codeIntelligenceManager;
    this.unbindGoalManager = options.unbindGoalManager;
    this.stopDelegationCompletionPolling = options.stopDelegationCompletionPolling;
    this.sessionStartSource = options.sessionStartSource;
    this.hookRuntime = options.hookRuntime;
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
      this.unsubscribeTaskHooks();
      this.unsubscribeWorktreeHooks?.();
      try {
        await this.clearComponentHooks();
        await this.hookRuntime?.clearComponentSources();
        this.ensureSessionStart();
        await this.drainHookEvents();
        const runningTasks = this.backgroundManager
          .list()
          .filter((task) => task.status === "running");
        await Promise.allSettled([
          this.delegationManager.dispose(),
          this.codeIntelligenceManager.close(),
          ...runningTasks.map((task) => this.backgroundManager.stop(task.taskId)),
        ]);
        await this.drainHookEvents();
        if (this._hookService) {
          await this._hookService.dispatch("SessionEnd", { reason: "runtime_dispose" });
        }
      } finally {
        await this.hookRuntime?.dispose();
        this.delegationCompletionQueue.close();
        this.hookRewakeQueue.close();
        this.unbindGoalManager();
      }
    })();
    return this.disposePromise;
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

function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须为正数`);
  return value;
}
