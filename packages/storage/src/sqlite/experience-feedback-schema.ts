import type { DatabaseSync } from 'node:sqlite';
import type { ExperienceUse, TaskExperienceReuse } from '@pico/core';
export const EXPERIENCE_FEEDBACK_SCHEMA_SQL = `
CREATE TABLE experience_uses(use_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,session_id TEXT NOT NULL,item_id TEXT NOT NULL,source_kind TEXT NOT NULL,candidate_id TEXT NOT NULL,record_json TEXT NOT NULL);
CREATE INDEX experience_uses_scope ON experience_uses(workspace_key,session_id);
CREATE INDEX experience_uses_item ON experience_uses(item_id);
CREATE TABLE experience_effects(effect_id TEXT PRIMARY KEY,use_id TEXT NOT NULL,outcome_event_id TEXT NOT NULL,record_json TEXT NOT NULL,UNIQUE(use_id,outcome_event_id),FOREIGN KEY(use_id) REFERENCES experience_uses(use_id) ON DELETE CASCADE);
CREATE TABLE experience_diagnostics(diagnostic_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,session_id TEXT NOT NULL,created_at INTEGER NOT NULL,record_json TEXT NOT NULL);
CREATE INDEX experience_diagnostics_scope ON experience_diagnostics(workspace_key,session_id,created_at DESC);
CREATE TABLE experience_feedback(operation_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,use_id TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL);
`;
/** Runs inside the initialization transaction. Older receipts keep their verdict, not invented chronology. */
export function migrateExperienceFeedback(db: DatabaseSync): void {
  db.exec(EXPERIENCE_FEEDBACK_SCHEMA_SQL);
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='task_experience_reuse'").get();
  if (!exists) return;
  const insert = db.prepare('INSERT INTO experience_uses VALUES(?,?,?,?,?,?,?)');
  for (const row of db.prepare('SELECT record_json FROM task_experience_reuse ORDER BY rowid').all()) {
    const old = JSON.parse(String(row.record_json)) as TaskExperienceReuse;
    const item = db.prepare('SELECT content_hash FROM memory_items WHERE item_id=?').get(old.itemId);
    const use: ExperienceUse = {
      useId: old.reuseId, workspaceKey: old.workspaceKey,
      source: { kind: 'reviewed-reference', candidateId: old.candidateId, contentVersion: old.contentVersion },
      itemId: old.itemId, itemVersion: old.itemVersion, contentHash: item ? String(item.content_hash) : '',
      taskId: old.taskId, taskVersion: old.taskVersion, sessionId: old.sessionId, runId: old.runId, hostRunId: old.runId,
      referenceHash: old.referenceHash, ...(old.referenceContent !== undefined ? { referenceContent: old.referenceContent } : {}),
      delivery: 'unknown', historical: true, managementRevision: 0, settingsVersion: 0, deletionRevision: 0,
      adoption: old.adoption, validation: old.validation, validationScope: 'unknown', excluded: old.excluded,
      deleted: !item, sources: old.sources, createdAt: old.createdAt, updatedAt: old.updatedAt,
    };
    if (!item) delete (use as { referenceContent?: string }).referenceContent;
    insert.run(use.useId,use.workspaceKey,use.sessionId,use.itemId,use.source.kind,use.source.candidateId,JSON.stringify(use));
  }
  db.exec('DROP TABLE task_experience_reuse');
}
