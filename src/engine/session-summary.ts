import { isMessageHiddenFromTranscript } from "../schema/message.js";
import type {
  RuntimeEventStoreEntry,
  RuntimeSessionManifest,
} from "../storage/runtime-event-store-contracts.js";
import { projectRuntimeSessionState } from "./session-runtime-projection.js";
import type { RuntimeEvent } from "./session-runtime-event.js";

/** fork bootstrap 运行的 runId 前缀(engine 层契约;runtime 层从此导入)。 */
export const RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX = "fork-bootstrap:";

/**
 * 会话摘要的引擎层实现：cli 的 session-resolver 与 storage 的会话目录
 * （session-catalog）共用同一套口径，保证"读时现算 / 写时维护 /
 * 全量重建"三条路径构造性一致。
 *
 * 摘要被建模为事件折叠器（fold）：全量口径 = 对全部事件按序折叠；
 * 会话目录的增量维护 = 只把新增事件折叠进持久化的折叠状态。两条路径
 * 使用同一组折叠规则，等价性由构造保证（测试锁定）。
 */

export type CliSessionHistorySource = RuntimeSessionManifest["historySource"];

export interface CliSessionSummary {
  id: string;
  cwd: string;
  createdAt: Date;
  updatedAt: Date;
  /** daemon 会话列表（session.list）无消息计数来源——客户端映射时可缺省。 */
  messageCount?: number;
  title?: string;
  firstMessage?: string;
  lastMessage?: string;
  historySource?: CliSessionHistorySource;
  /** Source session ID persisted with a forked conversation. */
  forkFrom?: string;
  /** Durable journal identity; sessionId remains the human-facing compatibility key. */
  logId?: string;
  parentLogId?: string;
  forkEventId?: string;
}

export interface SequencedCliSessionSummary {
  readonly summary: CliSessionSummary;
  readonly headSequence: number;
}

/** 折叠状态：会话目录行持久化它以支撑增量维护。 */
export interface SessionSummaryFold {
  /** projectRuntimeSessionMessages 口径的消息计数（含 assistant/tool 消息）。 */
  messageCount: number;
  /** 首条可见用户消息（已压缩）。 */
  firstMessage?: string;
  /** 末条可见用户消息（已压缩）。 */
  lastMessage?: string;
  /** 最后一份 settings 对象的 title（整体替换语义：字段缺省即清除）。 */
  settingsTitle?: string;
  settingsForkFrom?: string;
  /** 最后一条 session.forked 事件。 */
  forkEventParent?: string;
  forkEventId?: string;
  /** 纯事件侧的发布 flags；journal 部分读时补查。 */
  hasForkFacts: boolean;
  completedBootstrap: boolean;
  /** 已出现 session.forked 但尚未等到同 runId completed terminal 的 runId。 */
  pendingForkRuns: readonly string[];
  /** 最后一条事件的 at（ISO）。 */
  lastEventAt?: string;
  headSequence: number;
}

export function createInitialSessionSummaryFold(): SessionSummaryFold {
  return {
    messageCount: 0,
    hasForkFacts: false,
    completedBootstrap: false,
    pendingForkRuns: [],
    headSequence: 0,
  };
}

/** 单事件折叠。事件必须按 sequence 顺序进入。 */
export function foldSessionSummaryEvent(
  fold: SessionSummaryFold,
  event: RuntimeEvent,
): SessionSummaryFold {
  const next: SessionSummaryFold = {
    ...fold,
    pendingForkRuns: [...fold.pendingForkRuns],
  };

  if (
    (event.kind === "message.committed" || event.kind === "tool.result.recorded") &&
    event.visibility === "model" &&
    !event.partial
  ) {
    next.messageCount += 1;
  }
  if (event.kind === "message.committed" && event.visibility === "model" && !event.partial) {
    const message = event.data.message;
    if (message.toolCallId !== undefined) {
      throw new Error("Projected model message cannot carry toolCallId");
    }
    if (
      message.role === "user" &&
      message.toolCallId === undefined &&
      !isMessageHiddenFromTranscript(message) &&
      message.content.trim().length > 0
    ) {
      const compacted = compactSessionText(message.content);
      if (compacted) {
        if (next.firstMessage === undefined) next.firstMessage = compacted;
        next.lastMessage = compacted;
      }
    }
  }
  if (event.kind === "session.state.committed") {
    const state = projectRuntimeSessionState([event]);
    const settings = state.settings;
    // settings 是整体替换：最后一份对象决定 title/forkFrom，缺省字段即清除。
    next.settingsTitle = settings?.title;
    next.settingsForkFrom = settings?.forkFrom;
  }
  if (event.kind === "session.forked") {
    next.hasForkFacts = true;
    next.forkEventParent = event.data.parentSessionId;
    next.forkEventId = event.eventId;
    next.pendingForkRuns = [...next.pendingForkRuns, event.runId];
  } else if (event.runId.startsWith(RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX)) {
    next.hasForkFacts = true;
  }
  if (
    event.kind === "run.terminal" &&
    event.data.status === "completed" &&
    next.pendingForkRuns.includes(event.runId)
  ) {
    next.completedBootstrap = true;
  }

  next.lastEventAt = event.at;
  next.headSequence += 1;
  return next;
}

/** 折叠状态 → 摘要。title/forkFrom 的回退链与整体替换语义在此落定。 */
export function finalizeSessionSummary(
  manifest: RuntimeSessionManifest,
  fold: SessionSummaryFold,
): SequencedCliSessionSummary {
  const title = fold.settingsTitle ?? fold.firstMessage;
  const forkFrom = fold.forkEventParent ?? fold.settingsForkFrom;
  const updatedAt = fold.lastEventAt ?? manifest.createdAt;
  return {
    summary: {
      id: manifest.sessionId,
      cwd: manifest.workDir,
      createdAt: new Date(manifest.createdAt),
      updatedAt: new Date(updatedAt),
      messageCount: fold.messageCount,
      ...(title ? { title } : {}),
      ...(fold.firstMessage ? { firstMessage: fold.firstMessage } : {}),
      ...(fold.lastMessage ? { lastMessage: fold.lastMessage } : {}),
      ...(forkFrom ? { forkFrom } : {}),
      historySource: manifest.historySource,
      logId: manifest.sessionId,
      ...(fold.forkEventParent ? { parentLogId: fold.forkEventParent } : {}),
      ...(fold.forkEventId ? { forkEventId: fold.forkEventId } : {}),
    },
    headSequence: fold.headSequence,
  };
}

export function summaryFromRuntimeSession(
  manifest: RuntimeSessionManifest,
  entries: readonly RuntimeEventStoreEntry[],
): SequencedCliSessionSummary {
  let fold = createInitialSessionSummaryFold();
  for (const { event } of entries) {
    fold = foldSessionSummaryEvent(fold, event);
  }
  return finalizeSessionSummary(manifest, fold);
}

export function compactSessionText(value: string | undefined): string | undefined {
  const compacted = value?.replace(/\s+/gu, " ").trim();
  if (!compacted) return undefined;
  return compacted.length <= 240 ? compacted : `${compacted.slice(0, 239)}…`;
}

export interface SessionPublicationFlags {
  /** Ledger contains fork facts (session.forked or a bootstrap run). */
  readonly hasForkFacts: boolean;
  /** A session.forked marker is followed by a completed run.terminal of the same run. */
  readonly completedBootstrap: boolean;
}

export function computeSessionPublicationFlags(
  entries: readonly RuntimeEventStoreEntry[],
): SessionPublicationFlags {
  let fold = createInitialSessionSummaryFold();
  for (const { event } of entries) {
    fold = foldSessionSummaryEvent(fold, event);
  }
  return { hasForkFacts: fold.hasForkFacts, completedBootstrap: fold.completedBootstrap };
}

export interface ForkTargetOperations {
  readonly hasCompleted: boolean;
}

/**
 * 发布判定（journal 部分）：fork journal 的状态可在无新事件时变化，因此
 * 目录（catalog）只持久化事件侧 flags，journal 部分留待读取时补查。
 */
export function isPublishedSession(
  sessionId: string,
  flags: SessionPublicationFlags,
  forkTargets: ReadonlyMap<string, ForkTargetOperations>,
): boolean {
  const targetOperations = forkTargets.get(sessionId);
  if (!flags.hasForkFacts) return targetOperations === undefined;
  if (!flags.completedBootstrap) return false;
  return targetOperations?.hasCompleted ?? true;
}
