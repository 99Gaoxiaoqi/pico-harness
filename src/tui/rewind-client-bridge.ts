import type { FileHistorySnapshotSummary } from "../cli/file-history.js";
import type { FileHistoryDiffStat, FileHistoryDiffFileStat } from "../safety/file-history.js";

/**
 * rewind.* RPC 结果 → TUI 复用形状（3-D Phase 3：/rewind /changes 客户端镜像）。
 *
 * RewindCommandDialog（in-process 与客户端共享组件）消费 FileHistorySnapshotSummary
 * / FileHistoryDiffStat；daemon 正向映射见 desktop-runtime-service.ts 的
 * listRewindPoints/runtimeChange（label=userPrompt、created→added）。此处逆向：
 * added→created；modified/renamed→modified（daemon 从不产生 renamed，防御收口）。
 * 快照 summary 的 RPC 加宽字段（changedFileCount/additions/deletions/incomplete）
 * 逐字段安全读取，必填展示字段给中性默认。
 */

interface RewindListResult {
  readonly checkpoints?: readonly Record<string, unknown>[];
}

export function snapshotSummariesFromRewindList(result: unknown): FileHistorySnapshotSummary[] {
  const checkpoints =
    typeof result === "object" && result !== null && Array.isArray((result as RewindListResult).checkpoints)
      ? (result as RewindListResult).checkpoints!
      : [];
  return checkpoints.map((checkpoint) => {
    const label = readString(checkpoint["label"]) ?? "";
    const changedFileCount = readNumber(checkpoint["changedFileCount"]);
    const addedLines = readNumber(checkpoint["additions"]);
    const removedLines = readNumber(checkpoint["deletions"]);
    return {
      messageId: readString(checkpoint["checkpointId"]) ?? "",
      timestamp:
        typeof checkpoint["createdAt"] === "number" && Number.isFinite(checkpoint["createdAt"])
          ? new Date(checkpoint["createdAt"]).toISOString()
          : new Date().toISOString(),
      userPrompt: label,
      trackedFileCount: 0,
      backedUpFileCount: 0,
      deletedFileCount: 0,
      messageIndex: 0,
      ...(changedFileCount !== undefined ? { changedFileCount } : {}),
      ...(addedLines !== undefined ? { addedLines } : {}),
      ...(removedLines !== undefined ? { removedLines } : {}),
      ...(checkpoint["incomplete"] === true ? { incomplete: true } : {}),
    };
  });
}

export interface RewindPreviewProjection {
  readonly diffStat: FileHistoryDiffStat;
  /** apply 时回传（expectedFingerprint——preview→apply 间的一致性校验）。 */
  readonly fingerprint: string;
}

export function diffStatFromRewindPreview(
  result: unknown,
  checkpointId: string,
): RewindPreviewProjection {
  const record = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
  const changes = Array.isArray(record["changes"]) ? record["changes"] : [];
  const files: FileHistoryDiffFileStat[] = [];
  let addedLines = 0;
  let removedLines = 0;
  for (const change of changes) {
    if (typeof change !== "object" || change === null) continue;
    const entry = change as Record<string, unknown>;
    const status = readString(entry["status"]);
    if (status !== "added" && status !== "modified" && status !== "deleted" && status !== "renamed") {
      continue;
    }
    const additions = readNumber(entry["additions"]) ?? 0;
    const deletions = readNumber(entry["deletions"]) ?? 0;
    addedLines += additions;
    removedLines += deletions;
    files.push({
      filePath: readString(entry["path"]) ?? "(unknown)",
      status:
        status === "added" ? "created" : status === "deleted" ? "deleted" : "modified",
      addedLines: additions,
      removedLines: deletions,
    });
  }
  return {
    diffStat: {
      messageId: checkpointId,
      changedFileCount: files.length,
      addedLines,
      removedLines,
      files,
    },
    fingerprint: readString(record["fingerprint"]) ?? "",
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
