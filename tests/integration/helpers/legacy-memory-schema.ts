import type { DatabaseSync } from "node:sqlite";

/** SQL-only historical fixture. Retired production APIs must never seed new data. */
export const LEGACY_LESSON_SCHEMA_SQL = `
CREATE TABLE execution_lesson_candidates (
  candidate_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, session_id TEXT NOT NULL,
  state TEXT NOT NULL, item_id TEXT UNIQUE, record_json TEXT NOT NULL,
  FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE SET NULL
);
CREATE INDEX execution_lessons_by_scope ON execution_lesson_candidates(workspace_key,session_id,state);
`;

export function seedLegacyLesson(
  db: DatabaseSync,
  input: {
    candidateId: string;
    workspaceKey?: string;
    itemId?: string;
    content?: string;
    state?: "candidate" | "confirmed" | "invalidated";
    receiptOnly?: boolean;
  },
) {
  const item = input.itemId
    ? db.prepare("SELECT * FROM memory_items WHERE item_id=?").get(input.itemId)
    : undefined;
  const state = input.state ?? (input.itemId ? "confirmed" : "candidate");
  const candidate = {
    candidateId: input.candidateId,
    version: 2,
    state,
    workspaceKey: input.workspaceKey ?? "workspace",
    sessionId: "session",
    content: input.content ?? "LegacyBodyCanary",
    taskFamily: "LegacyFamilyCanary",
    commandHash: "a".repeat(64),
    evidenceBoundary: 1,
    failure: { sessionId: "session", runId: "run", turnId: "turn", eventId: "failure" },
    verifications:
      state === "confirmed"
        ? ["one", "two", "three"].map((eventId) => ({
            sessionId: "session",
            runId: "run",
            turnId: "turn",
            eventId,
          }))
        : [],
    deletionRevision: 0,
    settingsVersion: 1,
    createdAt: 1,
    updatedAt: 2,
    confirmedAt: state === "confirmed" ? 2 : null,
    itemId: state === "invalidated" ? null : (input.itemId ?? null),
    itemContentHash: state === "invalidated" ? null : (item?.content_hash ?? null),
  };
  if (!input.receiptOnly)
    db.prepare("INSERT INTO execution_lesson_candidates VALUES(?,?,?,?,?,?)").run(
      candidate.candidateId,
      candidate.workspaceKey,
      candidate.sessionId,
      candidate.state,
      candidate.itemId,
      JSON.stringify(candidate),
    );
  if (input.itemId)
    db.prepare("INSERT INTO memory_write_operations VALUES(?,'create',?,?,?)").run(
      `execution-lesson:${input.candidateId}`,
      "b".repeat(64),
      JSON.stringify([
        {
          mutationIndex: 0,
          mutationType: "create",
          itemId: input.itemId,
          version: 1,
          lifecycleState: "active",
          outcome: "created",
        },
      ]),
      1,
    );
  return candidate;
}
