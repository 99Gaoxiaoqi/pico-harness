import type { Session } from "../engine/session.js";
import type { FileHistorySnapshot } from "../safety/file-history.js";

export type RewindMode = "code" | "conversation" | "both";

export interface FileHistorySnapshotSummary {
  messageId: string;
  timestamp: string;
  userPrompt?: string;
  trackedFileCount: number;
  backedUpFileCount: number;
  deletedFileCount: number;
  changeSummary?: string;
  messageIndex?: number;
  transcriptIndex?: number;
  interactionMode?: string;
  prePlanMode?: string;
  changedFileCount?: number;
  addedLines?: number;
  removedLines?: number;
  changedFiles?: string[];
  incomplete?: boolean;
  warnings?: string[];
  legacy?: boolean;
}

export interface FileHistoryRewindResult {
  changed: boolean;
  output: string;
}

export function defaultCliSessionId(workDir: string): string {
  return `console:${workDir}`;
}

export function parseRewindMode(value: string | undefined): RewindMode {
  if (value === undefined || value === "both") return "both";
  if (value === "code" || value === "conversation") return value;
  throw new Error(`不支持的 rewind mode: ${value}。可选值: code / conversation / both`);
}

export function assertFileHistoryCliFlags(input: {
  listSnapshots?: boolean;
  rewind?: boolean;
}): void {
  if (input.listSnapshots && input.rewind) {
    throw new Error("--list-snapshots 不能和 --rewind 同时使用");
  }
}

export function listFileHistorySnapshotSummaries(session: Session): FileHistorySnapshotSummary[] {
  const history = typeof session.getHistory === "function" ? session.getHistory() : [];
  return session.fileHistory.snapshots.map((snapshot, index) => {
    const relevantPaths =
      snapshot.userPrompt !== undefined && snapshot.editedFilePaths !== undefined
        ? snapshot.editedFilePaths
        : new Set(snapshot.trackedFileBackups.keys());
    let backedUpFileCount = 0;
    let deletedFileCount = 0;
    for (const filePath of relevantPaths) {
      const backup = snapshot.trackedFileBackups.get(filePath);
      if (!backup) continue;
      if (backup.backupFileName === null) {
        deletedFileCount++;
      } else {
        backedUpFileCount++;
      }
    }

    return {
      messageId: snapshot.messageId,
      timestamp: snapshot.timestamp.toISOString(),
      userPrompt: snapshot.userPrompt ?? inferLegacyPrompt(history, snapshot.messageIndex, index),
      trackedFileCount: relevantPaths.size,
      backedUpFileCount,
      deletedFileCount,
      changeSummary: formatSnapshotChangeSummary({
        trackedFileCount: relevantPaths.size,
        backedUpFileCount,
        deletedFileCount,
      }),
      ...(snapshot.messageIndex !== undefined ? { messageIndex: snapshot.messageIndex } : {}),
      ...(snapshot.transcriptIndex !== undefined
        ? { transcriptIndex: snapshot.transcriptIndex }
        : {}),
      ...(snapshot.interactionMode !== undefined
        ? { interactionMode: snapshot.interactionMode }
        : {}),
      ...(snapshot.prePlanMode !== undefined ? { prePlanMode: snapshot.prePlanMode } : {}),
      ...(snapshot.journalWarnings?.length
        ? { incomplete: true, warnings: [...snapshot.journalWarnings] }
        : {}),
      ...(snapshot.userPrompt === undefined ? { legacy: true } : {}),
    };
  });
}

export async function listRewindPointSummaries(
  session: Session,
): Promise<FileHistorySnapshotSummary[]> {
  return Promise.all(
    listFileHistorySnapshotSummaries(session)
      // 旧 turn-N 没有可靠的“用户消息之前”边界；保留显式 code rewind
      // 兼容，但不在 Claude 风格消息选择器里制造重复/误导选项。
      .filter((summary) => !summary.legacy)
      .map(async (summary) => {
        const stat = await session.getRewindPointChangeStat(summary.messageId);
        return {
          ...summary,
          trackedFileCount: stat.changedFileCount,
          changedFileCount: stat.changedFileCount,
          addedLines: stat.addedLines,
          removedLines: stat.removedLines,
          changedFiles: stat.files.map((file) => file.filePath),
          ...(stat.incomplete ? { incomplete: true, warnings: [...(stat.warnings ?? [])] } : {}),
        };
      }),
  );
}

export function formatFileHistorySnapshots(
  sessionId: string,
  summaries: readonly FileHistorySnapshotSummary[],
): string {
  if (summaries.length === 0) {
    return `session ${sessionId} 没有文件历史快照。`;
  }

  const lines = [`session ${sessionId} 的可回滚消息:`];
  for (const summary of summaries) {
    lines.push(
      [
        `- ${summary.userPrompt}${summary.legacy ? ` (legacy id=${summary.messageId})` : ""}`,
        `timestamp=${summary.timestamp}`,
        `files=${summary.trackedFileCount}`,
        `tracked=${summary.trackedFileCount}`,
        `backups=${summary.backedUpFileCount}`,
        `deleted=${summary.deletedFileCount}`,
        `coverage=${summary.incomplete ? "incomplete" : "complete"}`,
        `summary=${summary.changeSummary ?? formatSnapshotChangeSummary(summary)}`,
      ].join(" "),
    );
  }
  return lines.join("\n");
}

function inferLegacyPrompt(
  history: ReturnType<Session["getHistory"]>,
  messageIndex: number | undefined,
  fallbackIndex: number,
): string {
  const start = Math.min(messageIndex ?? history.length, history.length) - 1;
  for (let index = start; index >= 0; index--) {
    const message = history[index];
    if (message?.role === "user" && message.toolCallId === undefined && message.content.trim()) {
      return message.content;
    }
  }
  return `Earlier conversation checkpoint ${fallbackIndex + 1}`;
}

export async function rewindFileHistoryFromCli(
  session: Session,
  messageId: string | undefined,
  mode: RewindMode = "both",
): Promise<FileHistoryRewindResult> {
  if (!messageId) {
    const summaries = listFileHistorySnapshotSummaries(session);
    return {
      changed: false,
      output: formatCliRewindUsage(session.id, summaries),
    };
  }

  const snapshot = findSnapshot(session, messageId);

  if (mode === "code") {
    await session.rewindCode(messageId);
  } else if (mode === "conversation") {
    const messageIndex = resolveSnapshotMessageIndex(session, snapshot);
    await session.rewindConversation(messageIndex, messageId);
  } else {
    const messageIndex = resolveSnapshotMessageIndex(session, snapshot);
    await session.rewindBoth(messageId, messageIndex);
  }

  return {
    changed: true,
    output: `已回滚 session ${session.id}: messageId=${messageId} mode=${mode} (${describeRewindMode(mode)})`,
  };
}

function findSnapshot(session: Session, messageId: string): FileHistorySnapshot {
  const snapshot = session.fileHistory.snapshots.find((item) => item.messageId === messageId);
  if (!snapshot) {
    throw new Error(
      `找不到 messageId=${messageId} 的文件历史快照。请先运行 --list-snapshots 查看可用快照。`,
    );
  }
  return snapshot;
}

export function formatSnapshotChangeSummary(input: {
  trackedFileCount: number;
  backedUpFileCount: number;
  deletedFileCount: number;
}): string {
  const unchangedFileCount =
    input.trackedFileCount - input.backedUpFileCount - input.deletedFileCount;
  const parts: string[] = [];
  if (input.backedUpFileCount > 0) {
    parts.push(`${input.backedUpFileCount} 个文件有备份`);
  }
  if (input.deletedFileCount > 0) {
    parts.push(`${input.deletedFileCount} 个文件将在 rewind 时删除`);
  }
  if (unchangedFileCount > 0) {
    parts.push(`${unchangedFileCount} 个文件沿用上一版`);
  }
  return parts.length === 0 ? "无文件变更" : parts.join(", ");
}

function formatCliRewindUsage(
  sessionId: string,
  summaries: readonly FileHistorySnapshotSummary[],
): string {
  const lines = [
    "请提供 messageId 和 rewind mode。",
    "用法: --rewind <message-id> --rewind-mode code|conversation|both",
    "mode: code=只回滚文件, conversation=只回滚对话, both=同时回滚文件和对话",
  ];
  const latest = summaries.at(-1);
  if (latest) {
    lines.push(
      `最近快照: ${latest.messageId}`,
      "可回滚快照:",
      formatFileHistorySnapshots(sessionId, summaries),
    );
  } else {
    lines.push(formatFileHistorySnapshots(sessionId, summaries));
  }
  return lines.join("\n");
}

function describeRewindMode(mode: RewindMode): string {
  if (mode === "code") return "只回滚文件";
  if (mode === "conversation") return "只回滚对话";
  return "同时回滚文件和对话";
}

function resolveSnapshotMessageIndex(session: Session, snapshot: FileHistorySnapshot): number {
  if (snapshot.messageIndex !== undefined) {
    return snapshot.messageIndex;
  }

  const turnNumber = parseTurnNumber(snapshot.messageId);
  if (turnNumber !== undefined) {
    const inferred = inferMessageIndexAfterUserTurn(session, turnNumber);
    if (inferred !== undefined) return inferred;
  }

  throw new Error(`快照 ${snapshot.messageId} 缺少 messageIndex，无法执行 conversation rewind`);
}

function parseTurnNumber(messageId: string): number | undefined {
  const match = /^turn-(\d+)$/u.exec(messageId);
  if (!match) return undefined;
  return Number(match[1]);
}

function inferMessageIndexAfterUserTurn(session: Session, turnNumber: number): number | undefined {
  let seenUserTurns = 0;
  const history = session.getHistory();
  for (let i = 0; i < history.length; i++) {
    if (history[i]!.role !== "user") continue;
    seenUserTurns++;
    if (seenUserTurns === turnNumber) {
      const nextUserIndex = history.findIndex((msg, index) => index > i && msg.role === "user");
      return nextUserIndex === -1 ? history.length : nextUserIndex;
    }
  }
  return undefined;
}
