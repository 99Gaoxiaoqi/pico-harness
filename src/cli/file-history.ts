import type { Session } from "../engine/session.js";
import type { FileHistorySnapshot } from "../safety/file-history.js";

export type RewindMode = "code" | "conversation" | "both";

export interface FileHistorySnapshotSummary {
  messageId: string;
  timestamp: string;
  trackedFileCount: number;
  backedUpFileCount: number;
  deletedFileCount: number;
  messageIndex?: number;
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

export function listFileHistorySnapshotSummaries(
  session: Session,
): FileHistorySnapshotSummary[] {
  return session.fileHistory.snapshots.map((snapshot) => {
    let backedUpFileCount = 0;
    let deletedFileCount = 0;
    for (const backup of snapshot.trackedFileBackups.values()) {
      if (backup.backupFileName === null) {
        deletedFileCount++;
      } else {
        backedUpFileCount++;
      }
    }

    return {
      messageId: snapshot.messageId,
      timestamp: snapshot.timestamp.toISOString(),
      trackedFileCount: snapshot.trackedFileBackups.size,
      backedUpFileCount,
      deletedFileCount,
      ...(snapshot.messageIndex !== undefined ? { messageIndex: snapshot.messageIndex } : {}),
    };
  });
}

export function formatFileHistorySnapshots(
  sessionId: string,
  summaries: readonly FileHistorySnapshotSummary[],
): string {
  if (summaries.length === 0) {
    return `session ${sessionId} 没有文件历史快照。`;
  }

  const lines = [`session ${sessionId} 的文件历史快照:`];
  for (const summary of summaries) {
    lines.push(
      [
        `- messageId=${summary.messageId}`,
        `timestamp=${summary.timestamp}`,
        `tracked=${summary.trackedFileCount}`,
        `backups=${summary.backedUpFileCount}`,
        `deleted=${summary.deletedFileCount}`,
      ].join(" "),
    );
  }
  return lines.join("\n");
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
      output:
        summaries.length === 0
          ? formatFileHistorySnapshots(session.id, summaries)
          : `可回滚快照:\n${formatFileHistorySnapshots(session.id, summaries)}`,
    };
  }

  const snapshot = findSnapshot(session, messageId);

  if (mode === "code") {
    await session.rewindCode(messageId);
  } else if (mode === "conversation") {
    const messageIndex = resolveSnapshotMessageIndex(session, snapshot);
    session.rewindConversation(messageIndex);
  } else {
    const messageIndex = resolveSnapshotMessageIndex(session, snapshot);
    await session.rewindBoth(messageId, messageIndex);
  }

  return {
    changed: true,
    output: `已回滚 session ${session.id}: messageId=${messageId} mode=${mode}`,
  };
}

function findSnapshot(session: Session, messageId: string): FileHistorySnapshot {
  const snapshot = session.fileHistory.snapshots.find((item) => item.messageId === messageId);
  if (!snapshot) {
    throw new Error(`找不到 messageId=${messageId} 的文件历史快照`);
  }
  return snapshot;
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

  throw new Error(
    `快照 ${snapshot.messageId} 缺少 messageIndex，无法执行 conversation rewind`,
  );
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
      const nextUserIndex = history.findIndex(
        (msg, index) => index > i && msg.role === "user",
      );
      return nextUserIndex === -1 ? history.length : nextUserIndex;
    }
  }
  return undefined;
}
