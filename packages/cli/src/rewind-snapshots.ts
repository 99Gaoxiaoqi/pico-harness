import type { FileHistorySnapshotSummary } from "@pico/pico-host/file-history";

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
