import type { SqliteSchemaScope } from "./sqlite-schema.js";

/**
 * scope `memory`(ADR 24 §4.4,票 07):memory/state.json 六实体表化。
 *
 * - memory_metadata:workspaceId 绑定 + revision(CAS 于 BEGIN IMMEDIATE 内)+ settings
 *   整体 JSON(单行小对象,无查询面,不值得拆列)。
 * - mutations.sequence 从 1 连续:INTEGER PRIMARY KEY + 写事务内
 *   `MAX(sequence)+1` 分配(BEGIN IMMEDIATE 独占,同 event_seq 分配口径);
 *   mutation_id UNIQUE 兜底防重复审计行。
 * - jobs 的 (terminal_event_id, extractor_version) UNIQUE:enqueue 幂等身份。
 * - facts 注入部分索引(state='active' 按 pinned/updated_at):listFacts 主路径。
 * - 墓碑状态机落 CHECK:forgotten fact 必须 title/content NULL + forgotten_at;
 *   deleted proposal 必须 title/content/reason NULL + deleted_at——写路径校验之外
 *   库层再拦一道,等价旧 decodeMemoryFileState 的 fail-closed 断言。
 * - 幂等键哈希列 64 位小写 hex(写路径恒为 sha256 hex,CHECK 兜底)。
 */
export const MEMORY_SCOPE_NAME = "memory";

export const MEMORY_SCOPE: SqliteSchemaScope = {
  name: MEMORY_SCOPE_NAME,
  migrations: new Map<number, string>([
    [
      1,
      `
      CREATE TABLE memory_metadata (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE memory_sources (
        source_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        branch_id TEXT,
        event_ids_json TEXT NOT NULL,
        start_sequence INTEGER CHECK (start_sequence IS NULL OR start_sequence > 0),
        end_sequence INTEGER CHECK (end_sequence IS NULL OR end_sequence > 0),
        digest TEXT NOT NULL,
        evidence_ref_json TEXT,
        availability TEXT NOT NULL CHECK (availability IN ('available','unavailable')),
        extraction_suppressed_at TEXT,
        invalidated_at TEXT,
        invalidation_code TEXT,
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX memory_sources_by_session ON memory_sources(session_id, source_id);

      CREATE TABLE memory_facts (
        fact_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('preference','correction','project_fact','reference')),
        title TEXT,
        content TEXT,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        source_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('active','disabled','archived','forgotten')),
        pinned INTEGER NOT NULL CHECK (pinned IN (0,1)),
        expires_at TEXT,
        last_used_at TEXT,
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        forgotten_at TEXT,
        CHECK (
          (state = 'forgotten' AND title IS NULL AND content IS NULL AND forgotten_at IS NOT NULL)
          OR (state <> 'forgotten' AND title IS NOT NULL AND content IS NOT NULL AND forgotten_at IS NULL)
        )
      );
      CREATE INDEX memory_facts_injection
        ON memory_facts(state, pinned DESC, updated_at DESC) WHERE state = 'active';

      CREATE TABLE memory_proposals (
        proposal_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('preference','correction','project_fact','reference')),
        title TEXT,
        content TEXT,
        reason TEXT,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        source_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','deleted')),
        conflict_status TEXT NOT NULL
          CHECK (conflict_status IN ('none','potential','confirmed','resolved')),
        conflict_fact_id TEXT,
        resolved_fact_id TEXT,
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        reviewed_at TEXT,
        deleted_at TEXT,
        CHECK (
          (status = 'deleted' AND title IS NULL AND content IS NULL AND reason IS NULL AND deleted_at IS NOT NULL)
          OR (status <> 'deleted' AND title IS NOT NULL AND content IS NOT NULL AND reason IS NOT NULL AND deleted_at IS NULL)
        )
      );
      CREATE INDEX memory_proposals_pending
        ON memory_proposals(updated_at DESC) WHERE status = 'pending';
      CREATE INDEX memory_proposals_pending_by_source
        ON memory_proposals(source_id, proposal_id)
        WHERE status = 'pending' AND source_id IS NOT NULL;

      CREATE TABLE memory_mutations (
        sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
        mutation_id TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL
          CHECK (entity_type IN ('settings','fact','proposal','source','job')),
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN (
          'settings.updated',
          'fact.created',
          'fact.updated',
          'fact.forgotten',
          'proposal.created',
          'proposal.updated',
          'proposal.accepted',
          'proposal.rejected',
          'proposal.deleted',
          'source.created',
          'source.updated',
          'job.created',
          'job.updated'
        )),
        from_version INTEGER CHECK (from_version IS NULL OR from_version > 0),
        to_version INTEGER NOT NULL CHECK (to_version > 0),
        idempotency_key_hash TEXT
          CHECK (idempotency_key_hash IS NULL
            OR (length(idempotency_key_hash) = 64 AND idempotency_key_hash GLOB '[0-9a-f]*')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX memory_mutations_by_entity ON memory_mutations(entity_type, entity_id, sequence);

      CREATE TABLE memory_jobs (
        job_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
        terminal_event_id TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        cursor_json TEXT NOT NULL,
        source_id TEXT,
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        next_attempt_at TEXT,
        error_code TEXT,
        model_calls INTEGER NOT NULL CHECK (model_calls >= 0),
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        cost_usd REAL NOT NULL CHECK (cost_usd >= 0),
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT,
        UNIQUE (terminal_event_id, extractor_version),
        CHECK (
          (status IN ('succeeded','failed','cancelled') AND terminal_at IS NOT NULL)
          OR (status NOT IN ('succeeded','failed','cancelled') AND terminal_at IS NULL)
        )
      );
      CREATE INDEX memory_jobs_by_scan
        ON memory_jobs(type, extractor_version, created_at, job_id);
      CREATE INDEX memory_jobs_pending_by_ready
        ON memory_jobs(status, next_attempt_at) WHERE status IN ('queued','failed');

      CREATE TABLE memory_idempotency (
        operation_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        marker_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) WITHOUT ROWID;
      `,
    ],
  ]),
};
