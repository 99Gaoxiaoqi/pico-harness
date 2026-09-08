import { DatabaseSync } from "node:sqlite";
import { operationalDatabasePath } from "./sqlite-database.js";

/** Legacy navigation fallback: inspect existing stores without preparing/migrating them. */
export function readConfiguredChildParentWorkspace(
  storageRoot: string,
  parentSessionId: string,
  parentRunId: string,
): string | undefined {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(operationalDatabasePath(storageRoot), { readOnly: true });
    const row = database
      .prepare(
        `SELECT work_dir FROM sessions
      WHERE session_id = ? AND EXISTS (
        SELECT 1 FROM runtime_events WHERE session_id = ? AND run_id = ? AND kind = 'run.started'
      )`,
      )
      .get(parentSessionId, parentSessionId, parentRunId);
    return typeof row?.["work_dir"] === "string" ? row["work_dir"] : undefined;
  } catch {
    // An unavailable/unmigrated unrelated workspace must not prevent opening the child.
    return undefined;
  } finally {
    database?.close();
  }
}
