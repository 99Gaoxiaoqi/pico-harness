import { canonicalizeWorkspacePath } from "../paths/pico-paths.js";
import { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import { childRecord, type ChildRecord } from "./configured-subagent-output-store.js";
import { requireSubagentCapability } from "../agents/subagent-profiles.js";

/** Restore capabilities from the child's own Host admission, never from UI or copied history. */
export async function readConfiguredSubagentDefinition(
  store: SqliteRuntimeEventStore,
  sessionId: string,
  workDir: string,
) {
  const admission = await readConfiguredSubagentAdmission(store, sessionId);
  if (!admission) return undefined;
  if (canonicalizeWorkspacePath(admission.workDir) !== canonicalizeWorkspacePath(workDir))
    throw new Error("Child session workspace changed");
  if (!admission.profile) throw new Error("Child capability snapshot is unavailable");
  return requireSubagentCapability(admission.profile);
}

/** Admission is written before the child's first model call, independently of its outcome.
 * Read a fixed prefix through the existing session/kind index, never the growing transcript.
 * Copied fork history and parent-side records cannot establish the target's identity.
 */
export async function readConfiguredSubagentAdmission(
  store: SqliteRuntimeEventStore,
  sessionId: string,
): Promise<ChildRecord | undefined> {
  const entries = await store.readSessionEventsByKind(sessionId, "message.committed", {
    limit: 100,
  });
  for (const { event } of entries) {
    const record = childRecord(event);
    if (
      record &&
      record.childSessionId === sessionId &&
      record.parentSessionId !== sessionId &&
      record.runId === event.runId &&
      record.turnId === event.turnId
    )
      return record;
  }
  return undefined;
}

export async function configuredSubagentParent(
  store: SqliteRuntimeEventStore,
  sessionId: string,
): Promise<{ sessionId: string; workspacePath: string; agentName?: string } | undefined> {
  const admission = await readConfiguredSubagentAdmission(store, sessionId);
  if (!admission) return undefined;
  return {
    sessionId: admission.parentSessionId,
    workspacePath: canonicalizeWorkspacePath(admission.parentWorkspacePath),
    ...(admission.agentName ? { agentName: admission.agentName } : {}),
  };
}
