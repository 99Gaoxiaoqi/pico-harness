import type { DatabaseSync } from "node:sqlite";
import type { TaskExperienceCandidate } from "@pico/core";
import {
  experienceConditions,
  experienceContentRisk,
  experienceHints,
  experienceLocked,
  experienceSummary,
} from "./task-experience-policy.js";

/** Runs in the schema initialization transaction. Never invents delivery or evidence. */
export function migrateTaskExperienceV16(db: DatabaseSync): void {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(experience_feedback)")
      .all()
      .map((row) => row.name),
  );
  for (const [name, type] of [
    ["action", "TEXT"],
    ["source_json", "TEXT"],
    ["content_version", "INTEGER"],
  ])
    if (!columns.has(name)) db.exec(`ALTER TABLE experience_feedback ADD COLUMN ${name} ${type}`);
  let changed = false;
  for (const row of db
    .prepare(
      "SELECT candidate_id,record_json FROM execution_learning_candidates WHERE json_extract(record_json,'$.kind')='task-lesson'",
    )
    .all()) {
    const old = JSON.parse(String(row.record_json)) as TaskExperienceCandidate;
    const next = migrate(old);
    db.prepare(
      "UPDATE execution_learning_candidates SET revision=?,record_json=?,item_id=? WHERE candidate_id=?",
    ).run(next.recordRevision, JSON.stringify(next), next.itemId ?? null, next.candidateId);
    db.prepare("UPDATE execution_learning_items SET metadata_json=? WHERE candidate_id=?").run(
      JSON.stringify(experienceSummary(next)),
      next.candidateId,
    );
    if (old.itemId && next.representation === "case")
      db.prepare(
        "UPDATE memory_items SET lifecycle_state='archived',version=version+1 WHERE item_id=? AND lifecycle_state='active'",
      ).run(old.itemId);
    changed = true;
  }
  // This table also contains identity links and Run bindings. Only candidate projections migrate.
  for (const row of db
    .prepare(
      "SELECT operation_id,workspace_key,candidate_id,result_json FROM task_experience_actions",
    )
    .all()) {
    const value = JSON.parse(String(row.result_json)) as TaskExperienceCandidate;
    if (
      value &&
      value.kind === "task-lesson" &&
      typeof value.candidateId === "string" &&
      value.candidateId === row.candidate_id &&
      value.workspaceKey === row.workspace_key
    )
      db.prepare("UPDATE task_experience_actions SET result_json=? WHERE operation_id=?").run(
        JSON.stringify(migrate(value)),
        String(row.operation_id),
      );
  }
  if (changed)
    db.prepare(
      "INSERT INTO execution_learning_control(scope,management_revision,resource_revision) VALUES('*',1,1) ON CONFLICT(scope) DO UPDATE SET management_revision=management_revision+1,resource_revision=resource_revision+1",
    ).run();
}
function migrate(old: TaskExperienceCandidate): TaskExperienceCandidate {
  const deleted =
    ["discarded", "invalidated", "expired"].includes(old.state) || old.review === "rejected";
  const risk = experienceContentRisk(`${old.content}\n${old.applicability.conditions.join("\n")}`);
  const published = !!old.itemId && old.state === "saved";
  const method = published || (risk === "high" && ["pending", "deferred"].includes(old.review));
  const blocked = deleted || experienceLocked(old) || risk === "blocked";
  const { itemId, ...body } = old;
  const scope = experienceConditions(old, undefined, true);
  const reviewRequired = method && !published;
  return {
    ...body,
    ...(method && itemId ? { itemId } : {}),
    representation: method ? "method" : "case",
    usagePolicy: blocked
      ? "blocked"
      : !method
        ? "case_only"
        : reviewRequired
          ? "review_required"
          : "suggestion",
    matchHints: experienceHints(undefined, old.content),
    ...scope,
    enabled: !blocked && published && old.enabled,
    review: !method && !deleted ? "unneeded" : old.review,
    ...(reviewRequired
      ? {
          decisionKind: "high_impact",
          reviewReason: "该方法涉及具体高影响操作，需要决定是否在所列范围内使用。",
        }
      : {}),
    ...(!method && !deleted && old.content
      ? {
          state: "ready",
          reason: "historical_unproven_case",
          reviewReason: "历史任务案例，过程可查，因果关系未经证实。",
        }
      : {}),
    recordRevision: old.recordRevision + 1,
  };
}
