import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { RUNTIME_ERROR_CODES, RuntimeProtocolError } from "@pico/protocol";

export interface DesktopCheckpointChangeFile {
  readonly filePath: string;
  readonly status: "modified" | "created" | "deleted";
  readonly addedLines: number;
  readonly removedLines: number;
  readonly patch: string;
  readonly currentFingerprint: string;
}

export interface DesktopCheckpointChanges {
  readonly incomplete?: boolean;
  readonly warnings?: readonly string[];
  readonly files: readonly DesktopCheckpointChangeFile[];
}

export interface DesktopCheckpointSession<FileHistory> {
  readonly id: string;
  readonly fileHistory: FileHistory & {
    readonly snapshots: readonly { readonly messageId: string }[];
    readonly revision: number;
  };
  readonly fileHistoryBaseDir: string;
}

export type ReadDesktopCheckpointChanges<FileHistory> = (
  fileHistory: FileHistory,
  checkpointId: string,
  sessionId: string,
  baseDir: string,
) => Promise<DesktopCheckpointChanges>;

export interface DesktopCheckpointProjection {
  readonly sessionId: string;
  readonly checkpointId: string;
  readonly changes: DesktopCheckpointChanges;
  readonly fingerprint: string;
}

export async function projectDesktopCheckpoint<FileHistory>(
  session: DesktopCheckpointSession<FileHistory>,
  checkpointId: string,
  readChanges: ReadDesktopCheckpointChanges<FileHistory>,
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
  const changes = await readChanges(
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

export function assertDesktopChangesComplete(
  changes: DesktopCheckpointChanges,
  operation: string,
): void {
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

export async function projectDesktopRewindFingerprints<FileHistory>(
  session: DesktopCheckpointSession<FileHistory>,
  checkpointId: string,
  expectedFingerprint: string,
  readChanges: ReadDesktopCheckpointChanges<FileHistory>,
): Promise<Record<string, string>> {
  const projection = await projectDesktopCheckpoint(session, checkpointId, readChanges);
  assertDesktopChangesComplete(projection.changes, "Rewind");
  assertDesktopChangesFingerprint(expectedFingerprint, projection.fingerprint, "Rewind");
  return Object.fromEntries(
    projection.changes.files.map((file) => [file.filePath, file.currentFingerprint]),
  );
}

function changesFingerprint<FileHistory>(
  session: DesktopCheckpointSession<FileHistory>,
  checkpointId: string,
  changes: DesktopCheckpointChanges,
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
