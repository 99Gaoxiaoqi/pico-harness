import { randomUUID } from "node:crypto";

/** Rewind operation modes shared by CLI and interactive entrypoints. */
export type RewindMode = "code" | "conversation" | "both";

/** Stable, renderable projection of one durable File History checkpoint. */
export interface FileHistorySnapshotSummary {
  readonly messageId: string;
  readonly timestamp: string;
  readonly userPrompt: string;
  readonly changedFileCount: number;
  readonly backedUpFileCount: number;
  readonly deletedFileCount: number;
  readonly changeSummary?: string;
  readonly messageIndex: number;
  readonly transcriptIndex?: number;
  readonly collaborationMode?: "agent" | "plan" | "research";
  readonly permissionMode?: "ask" | "auto" | "full-access";
  readonly addedLines?: number;
  readonly removedLines?: number;
  readonly changedFiles?: readonly string[];
  readonly incomplete?: boolean;
  readonly warnings?: readonly string[];
}

export interface FileHistoryRewindResult {
  readonly changed: boolean;
  readonly output: string;
}

/** Minimal checkpoint shape required for host command projections. */
export interface FileHistorySnapshotPort {
  readonly messageId: string;
  readonly timestamp: Date;
  readonly userPrompt: string;
  readonly messageIndex: number;
  readonly transcriptIndex?: number;
  readonly collaborationMode?: "agent" | "plan" | "research";
  readonly permissionMode?: "ask" | "auto" | "full-access";
  readonly editedFilePaths: ReadonlySet<string>;
  readonly trackedFileBackups: ReadonlyMap<string, { readonly backupFileName: string | null }>;
  readonly journalWarnings?: readonly string[];
}

export interface FileHistoryRewindPointChangeStat {
  readonly changedFileCount: number;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly files: readonly { readonly filePath: string }[];
  readonly incomplete?: boolean;
  readonly warnings?: readonly string[];
}

/** Read-only boundary between the Host projection and an Engine Session. */
export interface FileHistoryReadSessionPort {
  readonly id: string;
  readonly fileHistory: { readonly snapshots: readonly FileHistorySnapshotPort[] };
  getRewindPointChangeStat(messageId: string): Promise<FileHistoryRewindPointChangeStat>;
}

/**
 * The Host invokes but never inspects the Engine fork authority.  Keeping it
 * generic prevents this package from importing Engine implementation types.
 */
export interface FileHistoryForkSessionPort<RuntimePort> extends FileHistoryReadSessionPort {
  forkFromCheckpoint(
    checkpointId: string,
    mode: RewindMode,
    runtimePort: RuntimePort,
    createTargetSessionId: () => string,
  ): Promise<{ readonly targetSessionId: string }>;
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
  readonly listSnapshots?: boolean;
  readonly rewind?: boolean;
}): void {
  if (input.listSnapshots && input.rewind) {
    throw new Error("--list-snapshots 不能和 --rewind 同时使用");
  }
}

export function listFileHistorySnapshotSummaries(
  session: FileHistoryReadSessionPort,
): FileHistorySnapshotSummary[] {
  return session.fileHistory.snapshots.map((snapshot) => {
    const relevantPaths = snapshot.editedFilePaths;
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
      userPrompt: snapshot.userPrompt,
      changedFileCount: relevantPaths.size,
      backedUpFileCount,
      deletedFileCount,
      changeSummary: formatSnapshotChangeSummary({
        changedFileCount: relevantPaths.size,
        backedUpFileCount,
        deletedFileCount,
      }),
      messageIndex: snapshot.messageIndex,
      ...(snapshot.transcriptIndex !== undefined
        ? { transcriptIndex: snapshot.transcriptIndex }
        : {}),
      ...(snapshot.collaborationMode !== undefined
        ? { collaborationMode: snapshot.collaborationMode }
        : {}),
      ...(snapshot.permissionMode !== undefined ? { permissionMode: snapshot.permissionMode } : {}),
      ...(snapshot.journalWarnings?.length
        ? { incomplete: true, warnings: [...snapshot.journalWarnings] }
        : {}),
    };
  });
}

export async function listRewindPointSummaries(
  session: FileHistoryReadSessionPort,
): Promise<FileHistorySnapshotSummary[]> {
  return Promise.all(
    listFileHistorySnapshotSummaries(session).map(async (summary) => {
      const stat = await session.getRewindPointChangeStat(summary.messageId);
      return {
        ...summary,
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
        `- ${summary.userPrompt}`,
        `timestamp=${summary.timestamp}`,
        `files=${summary.changedFileCount}`,
        `backups=${summary.backedUpFileCount}`,
        `deleted=${summary.deletedFileCount}`,
        `coverage=${summary.incomplete ? "incomplete" : "complete"}`,
        `summary=${summary.changeSummary ?? formatSnapshotChangeSummary(summary)}`,
      ].join(" "),
    );
  }
  return lines.join("\n");
}

export async function rewindFileHistoryFromCli<RuntimePort>(
  session: FileHistoryForkSessionPort<RuntimePort>,
  messageId: string | undefined,
  mode: RewindMode = "both",
  forkRuntimePort?: RuntimePort,
): Promise<FileHistoryRewindResult> {
  if (!messageId) {
    const summaries = listFileHistorySnapshotSummaries(session);
    return {
      changed: false,
      output: formatCliRewindUsage(session.id, summaries),
    };
  }

  findSnapshot(session, messageId);

  if (!forkRuntimePort) {
    throw new Error(
      "rewindFileHistoryFromCli 需要 forkRuntimePort 以执行 non-destructive fork；" +
        "请在调用处注入 createSessionForkRuntimePort()。",
    );
  }

  const fork = await session.forkFromCheckpoint(
    messageId,
    mode,
    forkRuntimePort,
    () => `cli-rewind:${randomUUID()}`,
  );

  const target = fork.targetSessionId;
  const isFork = target !== session.id;
  return {
    changed: true,
    output: isFork
      ? `已从 checkpoint fork 新 session ${target}: messageId=${messageId} mode=${mode} (${describeRewindMode(mode)}); 原 session ${session.id} 未改动。`
      : `已回滚 session ${session.id}: messageId=${messageId} mode=${mode} (${describeRewindMode(mode)})`,
  };
}

export function formatSnapshotChangeSummary(input: {
  readonly changedFileCount: number;
  readonly backedUpFileCount: number;
  readonly deletedFileCount: number;
}): string {
  const unchangedFileCount =
    input.changedFileCount - input.backedUpFileCount - input.deletedFileCount;
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

function findSnapshot(
  session: FileHistoryReadSessionPort,
  messageId: string,
): FileHistorySnapshotPort {
  const snapshot = session.fileHistory.snapshots.find((item) => item.messageId === messageId);
  if (!snapshot) {
    throw new Error(
      `找不到 messageId=${messageId} 的文件历史快照。请先运行 --list-snapshots 查看可用快照。`,
    );
  }
  return snapshot;
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
