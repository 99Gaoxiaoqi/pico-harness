/** Additive v12 state. Candidate and leased job rows use the existing learning tables. */
export const TASK_EXPERIENCE_SCHEMA_SQL = `
CREATE TABLE task_experience_tasks(task_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,session_id TEXT NOT NULL,task_version INTEGER NOT NULL,through_sequence INTEGER NOT NULL,updated_at INTEGER NOT NULL,record_json TEXT NOT NULL);
CREATE INDEX task_experience_tasks_scope ON task_experience_tasks(workspace_key,session_id,updated_at DESC);
CREATE TABLE task_experience_observations(observation_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,task_version INTEGER NOT NULL,record_json TEXT NOT NULL,FOREIGN KEY(task_id) REFERENCES task_experience_tasks(task_id) ON DELETE CASCADE);
CREATE INDEX task_experience_observations_task ON task_experience_observations(task_id,task_version);
CREATE TABLE task_experience_reuse(reuse_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,session_id TEXT NOT NULL,candidate_id TEXT NOT NULL,content_version INTEGER NOT NULL,record_json TEXT NOT NULL);
CREATE INDEX task_experience_reuse_scope ON task_experience_reuse(workspace_key,session_id);
CREATE TABLE task_experience_actions(operation_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,candidate_id TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL);
`;
