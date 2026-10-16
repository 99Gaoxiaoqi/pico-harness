PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE memory_compaction_policy_denials (
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      compaction_checkpoint_id TEXT NOT NULL CHECK (length(compaction_checkpoint_id) > 0),
      denied_at INTEGER NOT NULL CHECK (denied_at >= 0),
      PRIMARY KEY(session_id, compaction_checkpoint_id)
    ) WITHOUT ROWID;
CREATE TABLE memory_extraction_cursors (
      session_id TEXT PRIMARY KEY CHECK (length(session_id) > 0),
      processed_ordinal INTEGER NOT NULL CHECK (processed_ordinal > 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    );
CREATE TABLE memory_extraction_failures (
      session_id TEXT PRIMARY KEY CHECK (length(session_id) > 0),
      from_ordinal INTEGER NOT NULL CHECK (from_ordinal > 0),
      through_ordinal INTEGER NOT NULL CHECK (through_ordinal >= from_ordinal),
      coverage_hash TEXT NOT NULL CHECK (length(coverage_hash) = 64),
      first_operation_id TEXT NOT NULL UNIQUE CHECK (length(first_operation_id) > 0),
      first_trigger TEXT NOT NULL CHECK (
        first_trigger IN ('remember', 'extract', 'compaction')
      ),
      compaction_checkpoint_id TEXT CHECK (
        compaction_checkpoint_id IS NULL OR length(compaction_checkpoint_id) > 0
      ),
      first_failure_class TEXT NOT NULL CHECK (
        first_failure_class IN (
          'provider', 'schema', 'evidence', 'localization', 'requested_admission'
        )
      ),
      failed_at INTEGER NOT NULL CHECK (failed_at >= 0),
      deletion_revision INTEGER NOT NULL CHECK (deletion_revision >= 0),
      CHECK (
        (first_trigger = 'compaction' AND compaction_checkpoint_id IS NOT NULL)
        OR (first_trigger != 'compaction' AND compaction_checkpoint_id IS NULL)
      )
    );
CREATE TABLE memory_extraction_receipts (
      operation_id TEXT PRIMARY KEY CHECK (length(operation_id) > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
      result_json TEXT NOT NULL,
      committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
      FOREIGN KEY (operation_id) REFERENCES memory_write_operations(operation_id) ON DELETE CASCADE
    );
CREATE TABLE memory_item_keys (
      item_id TEXT NOT NULL,
      key_text TEXT NOT NULL CHECK (length(key_text) > 0),
      normalized_key TEXT NOT NULL CHECK (length(normalized_key) > 0),
      key_type TEXT NOT NULL CHECK (key_type IN ('exact', 'entity', 'concept', 'alias', 'code')),
      key_origin TEXT NOT NULL CHECK (key_origin IN ('deterministic', 'llm', 'user')),
      PRIMARY KEY(item_id, normalized_key),
      FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
CREATE TABLE memory_item_sources (
      item_id TEXT NOT NULL,
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      run_id TEXT NOT NULL CHECK (length(run_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      event_id TEXT NOT NULL CHECK (length(event_id) > 0),
      PRIMARY KEY(item_id, event_id),
      FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
CREATE TABLE memory_items (
      item_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version >= 1),
      content TEXT NOT NULL CHECK (length(content) > 0),
      kind TEXT NOT NULL CHECK (
        kind IN ('preference', 'identity', 'context', 'knowledge', 'failure', 'note')
      ),
      statement_type TEXT NOT NULL CHECK (statement_type IN ('fact', 'plan', 'prediction')),
      temporal_type TEXT NOT NULL CHECK (
        temporal_type IN ('undated', 'point', 'interval', 'open_ended')
      ),
      scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'workspace')),
      scope_key TEXT,
      event_started_at INTEGER,
      event_ended_at INTEGER,
      observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
      lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'archived')),
      origin TEXT NOT NULL CHECK (origin IN ('agent_extracted', 'user_requested')),
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK (
        (scope_type = 'global' AND scope_key IS NULL)
        OR
        (scope_type = 'workspace' AND scope_key IS NOT NULL AND length(scope_key) > 0)
      ),
      CHECK (
        (temporal_type = 'undated'
          AND event_started_at IS NULL
          AND event_ended_at IS NULL)
        OR
        (temporal_type = 'point'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND (event_ended_at IS NULL OR event_ended_at > event_started_at))
        OR
        (temporal_type = 'interval'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND event_ended_at IS NOT NULL
          AND event_ended_at > event_started_at)
        OR
        (temporal_type = 'open_ended'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND event_ended_at IS NULL)
      ),
      CHECK (created_at <= updated_at),
      CHECK (observed_at <= updated_at)
    );
CREATE TABLE memory_settings (
    workspace_key TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK(version >= 1),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    auto_extract INTEGER NOT NULL CHECK(auto_extract IN (0, 1)),
    recall_enabled INTEGER NOT NULL CHECK(recall_enabled IN (0, 1))
  );
CREATE TABLE memory_write_operations (
      operation_id TEXT PRIMARY KEY,
      operation_type TEXT NOT NULL CHECK (
        operation_type IN ('create', 'update', 'archive', 'restore', 'batch', 'delete')
      ),
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
      result_json TEXT NOT NULL,
      committed_at INTEGER NOT NULL CHECK (committed_at >= 0)
    );
CREATE TABLE execution_learning_control(scope TEXT PRIMARY KEY,input_epoch INTEGER NOT NULL DEFAULT 0,management_revision INTEGER NOT NULL DEFAULT 0,resource_revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE execution_learning_admissions(admission_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL,record_json TEXT NOT NULL,UNIQUE(session_id,run_id));
CREATE TABLE execution_learning_native_facts(admission_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,prepared_event_id TEXT NOT NULL,kind TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(admission_id,tool_call_id,kind));
CREATE TABLE execution_learning_candidates(candidate_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL,failure_key TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,item_id TEXT,updated_at INTEGER NOT NULL,record_json TEXT NOT NULL);
CREATE TABLE execution_learning_tickets(ticket_id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,record_json TEXT NOT NULL,result_json TEXT,FOREIGN KEY(candidate_id) REFERENCES execution_learning_candidates(candidate_id));
CREATE TABLE execution_learning_jobs(job_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,candidate_id TEXT NOT NULL,state TEXT NOT NULL,lease_until INTEGER NOT NULL,fencing_token INTEGER NOT NULL,updated_at INTEGER NOT NULL,record_json TEXT NOT NULL,FOREIGN KEY(candidate_id) REFERENCES execution_learning_candidates(candidate_id));
CREATE TABLE execution_learning_tombstones(failure_key TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
CREATE TABLE execution_learning_attempts(failure_key TEXT NOT NULL,workspace_key TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE execution_learning_items(item_id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,item_content_hash TEXT NOT NULL,source_type TEXT NOT NULL DEFAULT 'execution-validated',metadata_json TEXT,FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE);
CREATE TABLE task_experience_tasks(task_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,session_id TEXT NOT NULL,task_version INTEGER NOT NULL,through_sequence INTEGER NOT NULL,updated_at INTEGER NOT NULL,record_json TEXT NOT NULL);
CREATE TABLE task_experience_observations(observation_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,task_version INTEGER NOT NULL,record_json TEXT NOT NULL,FOREIGN KEY(task_id) REFERENCES task_experience_tasks(task_id) ON DELETE CASCADE);
CREATE TABLE task_experience_actions(operation_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,candidate_id TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE memory_consolidation_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_committed_at INTEGER NOT NULL DEFAULT 0 CHECK (last_committed_at >= 0),
  lease_id TEXT,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0 CHECK (lease_until >= 0),
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_items_json TEXT NOT NULL DEFAULT '[]',
  CHECK (
    (lease_id IS NULL AND lease_owner IS NULL AND lease_until = 0 AND lease_items_json = '[]')
    OR
    (lease_id IS NOT NULL AND length(lease_id) > 0 AND lease_owner IS NOT NULL
      AND length(lease_owner) > 0 AND lease_until > 0)
  )
) WITHOUT ROWID;
INSERT INTO memory_consolidation_state VALUES(1,0,NULL,NULL,0,0,'[]');
CREATE TABLE memory_consolidation_receipts (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  claim_id TEXT NOT NULL UNIQUE,
  committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
  undo_expires_at INTEGER NOT NULL CHECK (undo_expires_at >= committed_at),
  undone_at INTEGER CHECK (undone_at IS NULL OR undone_at >= committed_at),
  result_json TEXT NOT NULL
);
CREATE TABLE experience_uses(use_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,session_id TEXT NOT NULL,item_id TEXT NOT NULL,source_kind TEXT NOT NULL,candidate_id TEXT NOT NULL,record_json TEXT NOT NULL);
CREATE TABLE experience_effects(effect_id TEXT PRIMARY KEY,use_id TEXT NOT NULL,outcome_event_id TEXT NOT NULL,record_json TEXT NOT NULL,UNIQUE(use_id,outcome_event_id),FOREIGN KEY(use_id) REFERENCES experience_uses(use_id) ON DELETE CASCADE);
CREATE TABLE experience_diagnostics(diagnostic_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,session_id TEXT NOT NULL,created_at INTEGER NOT NULL,record_json TEXT NOT NULL);
CREATE TABLE experience_feedback(operation_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,use_id TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL, action TEXT, source_json TEXT, content_version INTEGER);
CREATE INDEX memory_write_operations_by_type ON memory_write_operations(operation_type);
CREATE INDEX memory_item_keys_by_normalized_key
      ON memory_item_keys(normalized_key, item_id);
CREATE INDEX memory_item_sources_by_event
      ON memory_item_sources(event_id, item_id);
CREATE INDEX memory_item_sources_by_turn
      ON memory_item_sources(session_id, turn_id, item_id);
CREATE INDEX memory_items_by_scope_and_lifecycle
      ON memory_items(scope_type, scope_key, lifecycle_state, updated_at DESC, item_id);
CREATE INDEX execution_learning_candidates_scope ON execution_learning_candidates(workspace_key,state,updated_at);
CREATE INDEX execution_learning_jobs_ready ON execution_learning_jobs(state,lease_until,updated_at);
CREATE INDEX execution_learning_attempts_scope ON execution_learning_attempts(workspace_key,created_at);
CREATE INDEX task_experience_tasks_scope ON task_experience_tasks(workspace_key,session_id,updated_at DESC);
CREATE INDEX task_experience_observations_task ON task_experience_observations(task_id,task_version);
CREATE INDEX memory_consolidation_receipts_recent
  ON memory_consolidation_receipts(committed_at DESC, operation_id ASC);
CREATE INDEX experience_uses_scope ON experience_uses(workspace_key,session_id);
CREATE INDEX experience_uses_item ON experience_uses(item_id);
CREATE INDEX experience_diagnostics_scope ON experience_diagnostics(workspace_key,session_id,created_at DESC);
PRAGMA user_version=16;
COMMIT;
