import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Session } from "../engine/session.js";
import { fileHistoryChanges, type FileHistoryChanges } from "../safety/file-history.js";
import { RUNTIME_ERROR_CODES, RuntimeProtocolError } from "./protocol.js";

export interface DesktopCheckpointProjection {
  readonly sessionId: string;
  readonly checkpointId: string;
  readonly changes: FileHistoryChanges;
  readonly fingerprint: string;
}

export async function projectDesktopCheckpoint(
  session: Session,
  checkpointId: string,
): Promise<DesktopCheckpointProjection> {
  const checkpoint = session.fileHistory.snapshots.find(
    (candidate) => candidate.messageId === checkpointId,
  );
  if (!checkpoint) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.NOT_FOUND,
      `Session ${session.id} 中不存在检查点 ${checkpointId}`,
    );
  }
  const changes = await fileHistoryChanges(
    session.fileHistory,
    checkpointId,
    session.id,
    session.fileHistoryBaseDir,
  );
  return {
    sessionId: session.id,
    checkpointId,
    changes,
    fingerprint: changesFingerprint(session, checkpointId, changes),
  };
}

export function assertDesktopChangesComplete(changes: FileHistoryChanges, operation: string): void {
  if (changes.incomplete) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      `${operation} 捕获不完整，拒绝在不完整文件集上继续`,
    );
  }
}

export function assertDesktopChangesFingerprint(
  expectedFingerprint: string,
  actualFingerprint: string,
  operation: string,
): void {
  if (expectedFingerprint !== actualFingerprint) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      `${operation} 指纹已变化，请刷新后重试`,
    );
  }
}

/**
 * 计算 rewind 前的指纹前置校验，返回 checkpoint 各文件当前指纹的映射，
 * 供 non-destructive fork 在应用工作区文件时做安全校验。
 */
export async function projectDesktopRewindFingerprints(
  session: Session,
  checkpointId: string,
  expectedFingerprint: string,
): Promise<Record<string, string>> {
  const projection = await projectDesktopCheckpoint(session, checkpointId);
  assertDesktopChangesComplete(projection.changes, "Rewind");
  assertDesktopChangesFingerprint(expectedFingerprint, projection.fingerprint, "Rewind");
  return Object.fromEntries(
    projection.changes.files.map((file) => [file.filePath, file.currentFingerprint]),
  );
}

function changesFingerprint(
  session: Session,
  checkpointId: string,
  changes: FileHistoryChanges,
): string {
  const payload = {
    version: 1,
    sessionId: session.id,
    checkpointId,
    fileHistoryRevision: session.fileHistory.revision,
    incomplete: changes.incomplete === true,
    warnings: [...(changes.warnings ?? [])].toSorted(),
    files: changes.files
      .map((file) => ({
        filePath: resolve(file.filePath),
        status: file.status,
        addedLines: file.addedLines,
        removedLines: file.removedLines,
        currentFingerprint: file.currentFingerprint,
      }))
      .toSorted((left, right) => left.filePath.localeCompare(right.filePath)),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
