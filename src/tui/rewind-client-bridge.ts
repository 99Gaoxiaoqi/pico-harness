import type { FileHistorySnapshotSummary } from "../cli/file-history.js";
import type {
  FileHistoryChanges,
  FileHistoryDiffStat,
  FileHistoryDiffFileStat,
} from "../safety/file-history.js";
import { createChangesPanelModel, type ChangesPanelModel } from "./changes-panel.js";

/**
 * rewind.* RPC 结果 → TUI 复用形状（3-D Phase 3：/rewind /changes 客户端镜像）。
 *
 * RewindCommandDialog（in-process 与客户端共享组件）消费 FileHistorySnapshotSummary
 * / FileHistoryDiffStat；daemon 正向映射见 desktop-runtime-service.ts 的
 * listRewindPoints/runtimeChange（label=userPrompt、created→added）。此处逆向：
 * added→created；modified/renamed→modified（daemon 从不产生 renamed，防御收口）。
 * rewind.list 已由 Runtime 协议验证；这里仅把当前必填 summary 字段映射成 TUI 模型。
 */
export function snapshotSummariesFromRewindList(result: unknown): FileHistorySnapshotSummary[] {
  if (typeof result !== "object" || result === null || !("checkpoints" in result)) {
    throw new Error("rewind.list 缺少 checkpoints");
  }
  const checkpoints = (result as { readonly checkpoints: unknown }).checkpoints;
  if (!Array.isArray(checkpoints)) throw new Error("rewind.list checkpoints 必须是数组");
  return checkpoints.map((value, index) => {
    if (typeof value !== "object" || value === null) {
      throw new Error(`rewind.list checkpoints[${index}] 必须是对象`);
    }
    const checkpoint = value as Record<string, unknown>;
    return {
      messageId: requiredString(checkpoint["checkpointId"], `checkpoints[${index}].checkpointId`),
      timestamp: new Date(
        requiredNumber(checkpoint["createdAt"], `checkpoints[${index}].createdAt`),
      ).toISOString(),
      userPrompt: requiredString(checkpoint["label"], `checkpoints[${index}].label`),
      changedFileCount: requiredNumber(
        checkpoint["changedFileCount"],
        `checkpoints[${index}].changedFileCount`,
      ),
      backedUpFileCount: 0,
      deletedFileCount: 0,
      messageIndex: 0,
      addedLines: requiredNumber(checkpoint["additions"], `checkpoints[${index}].additions`),
      removedLines: requiredNumber(checkpoint["deletions"], `checkpoints[${index}].deletions`),
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
  const record =
    typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
  const changes = Array.isArray(record["changes"]) ? record["changes"] : [];
  const files: FileHistoryDiffFileStat[] = [];
  let addedLines = 0;
  let removedLines = 0;
  for (const change of changes) {
    if (typeof change !== "object" || change === null) continue;
    const entry = change as Record<string, unknown>;
    const status = readString(entry["status"]);
    if (
      status !== "added" &&
      status !== "modified" &&
      status !== "deleted" &&
      status !== "renamed"
    ) {
      continue;
    }
    const additions = readNumber(entry["additions"]) ?? 0;
    const deletions = readNumber(entry["deletions"]) ?? 0;
    addedLines += additions;
    removedLines += deletions;
    files.push({
      filePath: readString(entry["path"]) ?? "(unknown)",
      status: status === "added" ? "created" : status === "deleted" ? "deleted" : "modified",
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

/**
 * rewind.changes RPC 结果 → ChangesPanelModel（3-D tier2：/changes 单文件恢复）。
 *
 * wire 的 path 是 displayChangePath 形态（工作区内正斜杠相对路径）——保持原样
 * 作为模型 filePath：展示与 restoreAction 回传（rewind.restoreFile.path）都用
 * 同一形态，daemon 侧再还原为快照绝对路径。fingerprint 即文件当前内容指纹
 * （restoreFile 的 expectedFingerprint 守卫）。
 */
export function changesModelFromRewindChanges(result: unknown): ChangesPanelModel {
  const record =
    typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
  const wireFiles = Array.isArray(record["files"]) ? record["files"] : [];
  const files = wireFiles
    .filter((file): file is Record<string, unknown> => typeof file === "object" && file !== null)
    .map((file) => ({
      filePath: readString(file["path"]) ?? "(unknown)",
      status: readStatus(file["status"]),
      addedLines: readNumber(file["additions"]) ?? 0,
      removedLines: readNumber(file["deletions"]) ?? 0,
      currentFingerprint: readString(file["fingerprint"]) ?? "",
      patch: readString(file["patch"]) ?? "",
    }));
  const warnings = Array.isArray(record["warnings"])
    ? record["warnings"].filter((entry): entry is string => typeof entry === "string")
    : [];
  const changes = {
    messageId: readString(record["checkpointId"]) ?? "",
    changedFileCount: files.length,
    addedLines: readNumber(record["addedLines"]) ?? 0,
    removedLines: readNumber(record["removedLines"]) ?? 0,
    files,
    patch: files
      .map((file) => file.patch)
      .filter(Boolean)
      .join("\n\n"),
    ...(record["partial"] === true ? { incomplete: true } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  } as FileHistoryChanges;
  return createChangesPanelModel(changes);
}

function readStatus(value: unknown): "created" | "deleted" | "modified" {
  return value === "deleted" ? "deleted" : value === "created" ? "created" : "modified";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredString(value: unknown, path: string): string {
  const parsed = readString(value);
  if (parsed === undefined) throw new Error(`rewind.list ${path} 必须是字符串`);
  return parsed;
}

function requiredNumber(value: unknown, path: string): number {
  const parsed = readNumber(value);
  if (parsed === undefined) throw new Error(`rewind.list ${path} 必须是有限数字`);
  return parsed;
}
