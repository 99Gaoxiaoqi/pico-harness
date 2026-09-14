import type { Session } from "../engine/session.js";
import {
  fileHistoryChanges,
  type FileHistoryChanges,
} from "@pico/pico-host/file-history-runtime";
import {
  assertDesktopChangesComplete,
  assertDesktopChangesFingerprint,
  projectDesktopCheckpoint as projectDesktopCheckpointImplementation,
  projectDesktopRewindFingerprints as projectDesktopRewindFingerprintsImplementation,
} from "@pico/pico-host/desktop-review";

export { assertDesktopChangesComplete, assertDesktopChangesFingerprint };

/** @deprecated Checkpoint review implementation has moved to @pico/pico-host. */
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
  return projectDesktopCheckpointImplementation(
    session,
    checkpointId,
    fileHistoryChanges,
  ) as Promise<DesktopCheckpointProjection>;
}

export function projectDesktopRewindFingerprints(
  session: Session,
  checkpointId: string,
  expectedFingerprint: string,
): Promise<Record<string, string>> {
  return projectDesktopRewindFingerprintsImplementation(
    session,
    checkpointId,
    expectedFingerprint,
    fileHistoryChanges,
  );
}
