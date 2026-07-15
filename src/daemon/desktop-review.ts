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
  if (!checkpoint || checkpoint.userPrompt === undefined) {
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

export async function applyDesktopRewind(
  session: Session,
  checkpointId: string,
  expectedFingerprint: string,
): Promise<void> {
  const checkpoint = session.fileHistory.snapshots.find(
    (candidate) => candidate.messageId === checkpointId,
  );
  if (!checkpoint || checkpoint.userPrompt === undefined || checkpoint.messageIndex === undefined) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.NOT_FOUND,
      `Session ${session.id} 中不存在可完整回滚的检查点 ${checkpointId}`,
    );
  }
  const projection = await projectDesktopCheckpoint(session, checkpointId);
  assertDesktopChangesComplete(projection.changes, "Rewind");
  assertDesktopChangesFingerprint(expectedFingerprint, projection.fingerprint, "Rewind");
  const expectedCurrentFingerprints = new Map(
    projection.changes.files.map((file) => [file.filePath, file.currentFingerprint]),
  );
  try {
    await session.rewindBoth(checkpointId, checkpoint.messageIndex, expectedCurrentFingerprints);
  } catch (error) {
    if (isRewindConflict(error)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Rewind 安全检查失败: ${errorMessage(error)}`,
      );
    }
    throw error;
  }
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

function isRewindConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:conflict|drift|fingerprint|revision|变化|变更|预检|人工处理)/iu.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
