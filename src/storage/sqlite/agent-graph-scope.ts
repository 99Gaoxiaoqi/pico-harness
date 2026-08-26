import type { SqliteSchemaScope } from "./sqlite-schema.js";

export const AGENT_GRAPH_SCOPE_NAME = "agent_graph";

/**
 * Graph v2 durable control plane. RuntimeRun/RuntimeEvent remain the execution
 * authority; these tables only own scheduling admission, exact identities and
 * restart-safe supervisor delivery.
 */
export const AGENT_GRAPH_SCOPE: SqliteSchemaScope = {
  name: AGENT_GRAPH_SCOPE_NAME,
  migrations: new Map<number, string>([
    [
      1,
      `
      CREATE TABLE agent_graphs (
        graph_id TEXT PRIMARY KEY,
        root_session_id TEXT NOT NULL,
        epoch INTEGER NOT NULL CHECK (epoch >= 1),
        phase TEXT NOT NULL CHECK (phase IN ('open','finished')),
        head_revision INTEGER NOT NULL CHECK (head_revision >= 0),
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        UNIQUE (root_session_id, epoch),
        CHECK ((phase = 'open' AND finished_at IS NULL) OR (phase = 'finished' AND finished_at IS NOT NULL))
      );

      CREATE TABLE agent_graph_schedule_revisions (
        graph_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        operation_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('add','stop','finish')),
        command_json TEXT NOT NULL CHECK (json_valid(command_json)),
        source_session_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        source_tool_call_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (graph_id, revision),
        UNIQUE (graph_id, operation_id),
        FOREIGN KEY (graph_id) REFERENCES agent_graphs(graph_id) ON DELETE RESTRICT
      ) WITHOUT ROWID;

      CREATE INDEX agent_graph_schedule_by_operation
        ON agent_graph_schedule_revisions(operation_id);

      CREATE TABLE agent_graph_operator_provisions (
        provision_id TEXT PRIMARY KEY,
        graph_id TEXT NOT NULL,
        operator_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        schedule_revision INTEGER NOT NULL CHECK (schedule_revision >= 1),
        provision_fingerprint TEXT NOT NULL,
        child_session_id TEXT NOT NULL UNIQUE,
        profile_snapshot_json TEXT NOT NULL CHECK (json_valid(profile_snapshot_json)),
        workspace_binding_json TEXT NOT NULL CHECK (json_valid(workspace_binding_json)),
        created_at INTEGER NOT NULL,
        UNIQUE (graph_id, operator_id, generation),
        FOREIGN KEY (graph_id, schedule_revision)
          REFERENCES agent_graph_schedule_revisions(graph_id, revision) ON DELETE RESTRICT,
        FOREIGN KEY (graph_id) REFERENCES agent_graphs(graph_id) ON DELETE RESTRICT
      );

      CREATE INDEX agent_graph_provisions_by_graph
        ON agent_graph_operator_provisions(graph_id, created_at, provision_id);

      CREATE TABLE agent_graph_activation_claims (
        claim_id TEXT PRIMARY KEY,
        graph_id TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        operator_id TEXT NOT NULL,
        operator_generation INTEGER NOT NULL CHECK (operator_generation >= 1),
        schedule_revision INTEGER NOT NULL CHECK (schedule_revision >= 1),
        intent_fingerprint TEXT NOT NULL,
        readiness_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('claimed','executing','cancelled')),
        target_session_id TEXT NOT NULL,
        target_turn_id TEXT NOT NULL UNIQUE,
        target_run_id TEXT NOT NULL UNIQUE,
        target_invocation_id TEXT NOT NULL UNIQUE,
        run_started_event_id TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL CHECK (version >= 1),
        claimed_at INTEGER NOT NULL,
        executing_at INTEGER,
        cancelled_at INTEGER,
        cancellation_reason TEXT,
        UNIQUE (graph_id, intent_id),
        UNIQUE (graph_id, claim_id),
        FOREIGN KEY (graph_id, schedule_revision)
          REFERENCES agent_graph_schedule_revisions(graph_id, revision) ON DELETE RESTRICT,
        FOREIGN KEY (graph_id, operator_id, operator_generation)
          REFERENCES agent_graph_operator_provisions(graph_id, operator_id, generation) ON DELETE RESTRICT,
        FOREIGN KEY (graph_id) REFERENCES agent_graphs(graph_id) ON DELETE RESTRICT,
        CHECK ((state = 'claimed' AND executing_at IS NULL AND cancelled_at IS NULL AND cancellation_reason IS NULL)
          OR (state = 'executing' AND executing_at IS NOT NULL AND cancelled_at IS NULL AND cancellation_reason IS NULL)
          OR (state = 'cancelled' AND cancelled_at IS NOT NULL))
      );

      CREATE INDEX agent_graph_claims_by_graph_state
        ON agent_graph_activation_claims(graph_id, state, claimed_at, claim_id);
      CREATE INDEX agent_graph_claims_by_operator_state
        ON agent_graph_activation_claims(graph_id, operator_id, operator_generation, state, claimed_at);

      CREATE TABLE agent_graph_record_refs (
        record_id TEXT PRIMARY KEY,
        graph_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        operator_id TEXT NOT NULL,
        operator_generation INTEGER NOT NULL CHECK (operator_generation >= 1),
        record_fingerprint TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_turn_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('agent_output','artifact','evidence')),
        created_at INTEGER NOT NULL,
        UNIQUE (graph_id, source_event_id),
        FOREIGN KEY (graph_id, claim_id)
          REFERENCES agent_graph_activation_claims(graph_id, claim_id) ON DELETE RESTRICT,
        FOREIGN KEY (graph_id) REFERENCES agent_graphs(graph_id) ON DELETE RESTRICT
      );

      CREATE INDEX agent_graph_record_refs_by_graph
        ON agent_graph_record_refs(graph_id, created_at, record_id);
      CREATE INDEX agent_graph_record_refs_by_claim
        ON agent_graph_record_refs(claim_id, created_at, record_id);

      CREATE TABLE agent_graph_supervisor_wakes (
        wake_id TEXT PRIMARY KEY,
        graph_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        wake_fingerprint TEXT NOT NULL,
        cause TEXT NOT NULL CHECK (cause IN ('schedule_updated','runtime_terminal','startup_recovery','retry')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        status TEXT NOT NULL CHECK (status IN ('pending','running','delivered','waiting_permission','retryable_failed')),
        available_at INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        version INTEGER NOT NULL CHECK (version >= 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        last_error TEXT,
        UNIQUE (graph_id, dedupe_key),
        UNIQUE (graph_id, wake_id),
        FOREIGN KEY (graph_id) REFERENCES agent_graphs(graph_id) ON DELETE RESTRICT,
        CHECK ((status = 'delivered' AND delivered_at IS NOT NULL) OR (status <> 'delivered' AND delivered_at IS NULL))
      );

      CREATE INDEX agent_graph_wakes_due
        ON agent_graph_supervisor_wakes(status, available_at, created_at)
        WHERE status IN ('pending','retryable_failed');

      CREATE TABLE agent_graph_supervisor_wake_attempts (
        attempt_id TEXT PRIMARY KEY,
        wake_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
        root_session_id TEXT NOT NULL,
        target_turn_id TEXT NOT NULL UNIQUE,
        target_run_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('running','completed','waiting_permission','failed')),
        version INTEGER NOT NULL CHECK (version >= 1),
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER,
        error TEXT,
        UNIQUE (wake_id, attempt_number),
        FOREIGN KEY (wake_id) REFERENCES agent_graph_supervisor_wakes(wake_id) ON DELETE RESTRICT,
        CHECK ((status = 'running' AND finished_at IS NULL AND error IS NULL)
          OR (status = 'waiting_permission' AND finished_at IS NULL)
          OR (status = 'completed' AND finished_at IS NOT NULL AND error IS NULL)
          OR (status = 'failed' AND finished_at IS NOT NULL))
      );

      CREATE INDEX agent_graph_wake_attempts_by_wake
        ON agent_graph_supervisor_wake_attempts(wake_id, attempt_number);
      `,
    ],
  ]),
};
