import { lstatSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ExperienceUse } from "@pico/core";
import { operationalDatabasePath } from "@pico/storage";
import { isPreparedMemoryRecallDiagnostic } from "@pico/runtime";
import { resolvePicoPaths } from "./pico-paths.js";

export interface ExperienceDeliveryEvidenceOptions {
  readonly workDir: string;
  readonly picoHome: string;
}

/** Read native, request-bound evidence only. Missing or expired audit data stays unknown. */
export function hasConfirmedExperienceDelivery(
  use: ExperienceUse,
  options: ExperienceDeliveryEvidenceOptions,
): boolean {
  if (
    use.delivery !== "carried" ||
    use.historical ||
    use.deleted ||
    !use.physicalAttemptId ||
    !use.providerCallId ||
    !use.recallEventId ||
    !use.deliverySequence
  )
    return false;
  let db: DatabaseSync | undefined;
  try {
    const paths = resolvePicoPaths(options.workDir, { picoHome: options.picoHome });
    if (paths.workspace.id !== use.workspaceKey) return false;
    const physical = lstatSync(paths.workspace.root);
    if (!physical.isDirectory() || physical.isSymbolicLink()) return false;
    db = new DatabaseSync(operationalDatabasePath(paths.workspace.root), { readOnly: true });
    const binding = db
      .prepare(
        "SELECT canonical_path, device, inode FROM workspace_storage_binding WHERE singleton=1",
      )
      .get();
    if (
      binding?.canonical_path !== realpathSync.native(paths.workspace.root) ||
      binding.device !== String(physical.dev) ||
      binding.inode !== String(physical.ino)
    )
      return false;
    const row = db
      .prepare(
        "SELECT record_json FROM usage_physical_attempts WHERE physical_attempt_id=? AND provider_call_id=? AND session_id=?",
      )
      .get(use.physicalAttemptId, use.providerCallId, use.sessionId);
    if (typeof row?.record_json !== "string") return false;
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    if (
      record.accountingSource !== "physical" ||
      record.accountingVersion !== 1 ||
      record.physicalAttemptId !== use.physicalAttemptId ||
      record.providerCallId !== use.providerCallId ||
      record.sessionId !== use.sessionId ||
      (record.runId !== use.runId && (!use.hostRunId || record.runId !== use.hostRunId)) ||
      record.purpose !== "main" ||
      !["observed", "succeeded", "failed", "cancelled", "interrupted"].includes(
        record.status as string,
      ) ||
      typeof record.httpStatus !== "number" ||
      !Number.isSafeInteger(record.httpStatus) ||
      record.httpStatus < 200 ||
      record.httpStatus >= 300
    )
      return false;
    const diagnostic = record.requestDiagnostic as Record<string, unknown> | undefined;
    const recall = diagnostic?.memoryRecall;
    if (
      !isPreparedMemoryRecallDiagnostic(recall) ||
      !recall.recalls.some(
        (entry) =>
          entry.recallEventId === use.recallEventId &&
          entry.references.some(
            (reference) =>
              reference.itemId === use.itemId &&
              reference.referenceHash === use.referenceHash &&
              reference.present,
          ),
      )
    )
      return false;
    const event = db
      .prepare(
        "SELECT payload_json FROM runtime_events WHERE session_id=? AND run_id=? AND event_seq=? AND kind='model.call.started'",
      )
      .get(use.sessionId, use.runId, use.deliverySequence);
    if (typeof event?.payload_json !== "string") return false;
    const started = JSON.parse(event.payload_json) as {
      data?: { providerCallId?: string; recallEventIds?: string[] };
    };
    return (
      started.data?.providerCallId === use.providerCallId &&
      Array.isArray(started.data.recallEventIds) &&
      started.data.recallEventIds.includes(use.recallEventId)
    );
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** Preserve the frozen reference, effects and user state; correct only the read projection. */
export function projectExperienceDelivery(
  use: ExperienceUse,
  options: ExperienceDeliveryEvidenceOptions,
): ExperienceUse {
  return use.delivery === "carried" && !hasConfirmedExperienceDelivery(use, options)
    ? { ...use, delivery: "unknown" }
    : use;
}
