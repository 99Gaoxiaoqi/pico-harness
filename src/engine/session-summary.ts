import { isMessageHiddenFromTranscript } from "../schema/message.js";
import type { RuntimeEventStoreEntry, RuntimeSessionManifest } from "../storage/runtime-event-store.js";
import { RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX } from "../runtime/runtime-run.js";
import { projectRuntimeSessionMessages, projectRuntimeSessionState } from "./session-runtime-projection.js";

/**
 * 会话摘要的引擎层实现：cli 的 session-resolver 与 storage 的会话目录
 * （session-catalog）共用同一套口径，保证"读时现算 / 写时维护 /
 * 全量重建"三条路径构造性一致。
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

export function summaryFromRuntimeSession(
  manifest: RuntimeSessionManifest,
  entries: readonly RuntimeEventStoreEntry[],
): SequencedCliSessionSummary {
  const events = entries.map(({ event }) => event);
  const messages = projectRuntimeSessionMessages(events);
  const runtimeState = projectRuntimeSessionState(events);
  const visibleUserMessages = messages.filter(
    (message) =>
      message.role === "user" &&
      message.toolCallId === undefined &&
      !isMessageHiddenFromTranscript(message) &&
      message.content.trim().length > 0,
  );
  const firstMessage = compactSessionText(visibleUserMessages[0]?.content);
  const lastMessage = compactSessionText(visibleUserMessages.at(-1)?.content);
  const title = runtimeState.settings?.title ?? firstMessage;
  const forkEvent = events.findLast((event) => event.kind === "session.forked");
  const forkFrom = forkEvent?.data.parentSessionId ?? runtimeState.settings?.forkFrom;
  const head = entries.at(-1);

  return {
    summary: {
      id: manifest.sessionId,
      cwd: manifest.workDir,
      createdAt: new Date(manifest.createdAt),
      updatedAt: new Date(head?.event.at ?? manifest.createdAt),
      messageCount: messages.length,
      ...(title ? { title } : {}),
      ...(firstMessage ? { firstMessage } : {}),
      ...(lastMessage ? { lastMessage } : {}),
      ...(forkFrom ? { forkFrom } : {}),
      historySource: manifest.historySource,
      logId: manifest.sessionId,
      ...(forkEvent ? { parentLogId: forkEvent.data.parentSessionId } : {}),
      ...(forkEvent ? { forkEventId: forkEvent.eventId } : {}),
    },
    headSequence: head?.sequence ?? 0,
  };
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
  const hasForkFacts = entries.some(
    ({ event }) =>
      event.kind === "session.forked" || event.runId.startsWith(RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX),
  );
  const completedBootstrap =
    hasForkFacts &&
    entries.some(
      ({ sequence: markerSequence, event: marker }) =>
        marker.kind === "session.forked" &&
        entries.some(
          ({ sequence: terminalSequence, event: terminal }) =>
            terminalSequence > markerSequence &&
            terminal.kind === "run.terminal" &&
            terminal.runId === marker.runId &&
            terminal.data.status === "completed",
        ),
    );
  return { hasForkFacts, completedBootstrap };
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
