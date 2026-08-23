import type { SqliteSchemaScope } from "./sqlite-schema.js";

/**
 * scope `sessions`(ADR 24 §4.1):事件事实表 runtime_events + 会话表 sessions。
 *
 * runtime_events 信封列照 RuntimeEventBase 全量拆出;payload_json 存完整事件
 * 对象 canonical JSON(键排序 stringify),decode 走既有 decodeRuntimeEvent。
 * tool_call_id / provider_call_id / operation_id 是索引投影列,仅服务于点查
 * 与 plan/graph CAS,不含独家信息。event_seq 分配 = 写事务内
 * COALESCE(MAX(event_seq),0)+1(BEGIN IMMEDIATE 保证独占)。
 *
 * sessions 吸收旧 JSONL 纪元的 header + manifest 水位投影:
 * last_event_seq / last_tx_id / event_count / storage_bytes / last_event_at 由
 * append 事务维护;fork_parent_session_id 由 session.forked 事件同事务维护
 * (目标冲突 fail-closed)。archived_at / pinned_at 承接原 desktop session-state
 * (票 03 并入,epoch 毫秒)。
 *
 * migration 2(票 03,ADR 24 §4.1 + 决策 25 第 3 条):catalog 投影表与消息表。
 * - `session_catalog_projection`:maka 双轨——is_archived/is_pinned/
 *   fork_parent_session_id/activity_at 是 sessions 结构列,由 AFTER UPDATE 触发器
 *   维护;title/first/last preview/message_count/fold_json 由 append 事务应用层
 *   增量维护(复用 engine/session-summary.ts 折叠器,禁止另写口径)。行内持久化
 *   SessionSummaryFold(schemaVersion 2 口径)+ 水位副本(head_sequence/event_count/
 *   storage_bytes),失配即全量重建(可丢弃派生)。is_published 只是事件侧判定
 *   (!hasForkFacts || completedBootstrap)的物化;journal 侧部分读时补查。
 * - `session_messages`:message.committed / tool.result.recorded(visibility=model
 *   且非 partial)的同事务物化;payload_json 为投影 Message canonical JSON,
 *   可从事件全量重建,启动恢复直读本表。
 *
 * migration 3(ADR 29):continuation claim 表。`runtime_continuation_claims` 是
 * 中断 run 的确定性续跑锚——(source_session_id, source_run_id) UNIQUE 保证一个
 * source run 至多被 claim 一次(C1);source_high_water/source_prefix_digest 冻结
 * claim 时刻的源前缀完整性;claim 由 store 单 BEGIN IMMEDIATE 事务写入
 * (claimContinuation),与源账本读取同事务快照。
 *
 * migration 4(EventLog foundation):全部表均为 additive expand migration。
 * owner fence / run seal 是不可丢弃的协调投影；partial、tool journal、transcript、
 * checkpoint、metadata/assets 是独立于 immutable runtime_events 的存储面。
 */

export const SESSIONS_SCOPE_NAME = "sessions";

export const SESSIONS_SCOPE: SqliteSchemaScope = {
  name: SESSIONS_SCOPE_NAME,
  migrations: new Map<number, string>([
    [
      1,
      `
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        work_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        last_tx_id TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        storage_bytes INTEGER NOT NULL DEFAULT 0,
        fork_parent_session_id TEXT,
        archived_at INTEGER,
        pinned_at INTEGER,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE runtime_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        invocation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL CHECK (event_seq > 0),
        kind TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('model','transcript','internal')),
        partial INTEGER NOT NULL CHECK (partial IN (0,1)),
        tx_id TEXT NOT NULL,
        tool_call_id TEXT,
        provider_call_id TEXT,
        operation_id TEXT,
        payload_json TEXT NOT NULL,
        at TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        UNIQUE (session_id, event_seq)
      );

      CREATE INDEX runtime_events_by_run ON runtime_events(session_id, run_id, event_seq);
      CREATE INDEX runtime_events_by_kind ON runtime_events(session_id, kind, event_seq);
      CREATE INDEX runtime_events_by_tool_call ON runtime_events(tool_call_id) WHERE tool_call_id IS NOT NULL;
      CREATE INDEX runtime_events_by_operation ON runtime_events(session_id, operation_id) WHERE operation_id IS NOT NULL;
      `,
    ],
    [
      2,
      `
      ALTER TABLE sessions ADD COLUMN last_event_at TEXT;

      CREATE TABLE session_catalog_projection (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        work_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        activity_at TEXT NOT NULL,
        title TEXT,
        first_message TEXT,
        last_message TEXT,
        last_message_preview TEXT CHECK (last_message_preview IS NULL OR length(last_message_preview) <= 96),
        message_count INTEGER NOT NULL DEFAULT 0,
        fork_parent_session_id TEXT,
        fork_event_id TEXT,
        is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
        is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0,1)),
        is_published INTEGER NOT NULL DEFAULT 0,
        head_sequence INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        storage_bytes INTEGER NOT NULL DEFAULT 0,
        fold_json TEXT NOT NULL
      );
      CREATE INDEX catalog_by_activity ON session_catalog_projection(activity_at DESC, session_id ASC);
      CREATE INDEX catalog_by_archived_activity ON session_catalog_projection(is_archived, activity_at DESC, session_id ASC);
      CREATE INDEX catalog_by_pinned_activity ON session_catalog_projection(is_pinned, is_archived, activity_at DESC, session_id ASC);

      CREATE TABLE session_messages (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        message_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system','user','assistant')),
        message_ts TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      CREATE INDEX session_messages_by_message_id ON session_messages(session_id, message_id);
      CREATE INDEX session_messages_by_ts ON session_messages(session_id, message_ts, sequence);

      CREATE TRIGGER session_catalog_projection_after_update
      AFTER UPDATE OF archived_at, pinned_at, fork_parent_session_id, last_event_at, created_at ON sessions
      BEGIN
        UPDATE session_catalog_projection
        SET is_archived = NEW.archived_at IS NOT NULL,
            is_pinned = NEW.pinned_at IS NOT NULL,
            fork_parent_session_id = NEW.fork_parent_session_id,
            activity_at = COALESCE(NEW.last_event_at, NEW.created_at)
        WHERE session_id = OLD.session_id;
      END;
      `,
    ],
    [
      3,
      `
      CREATE TABLE runtime_continuation_claims (
        claim_id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        source_run_id TEXT NOT NULL,
        source_high_water INTEGER NOT NULL CHECK (source_high_water > 0),
        source_prefix_digest TEXT NOT NULL CHECK (length(source_prefix_digest) = 64),
        target_session_id TEXT NOT NULL,
        target_run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (source_session_id, source_run_id),
        UNIQUE (target_session_id, target_run_id)
      );
      CREATE INDEX continuation_claims_by_target_run
        ON runtime_continuation_claims(target_session_id, target_run_id);
      `,
    ],
    [
      4,
      `
      CREATE TABLE runtime_owner_fences (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
        updated_at TEXT NOT NULL
      );
      INSERT INTO runtime_owner_fences (session_id, epoch, updated_at)
      SELECT session_id, 0, updated_at FROM sessions;

      CREATE TABLE runtime_run_projection (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        started_event_id TEXT,
        started_sequence INTEGER CHECK (started_sequence IS NULL OR started_sequence > 0),
        terminal_event_id TEXT,
        terminal_sequence INTEGER CHECK (terminal_sequence IS NULL OR terminal_sequence > 0),
        terminal_status TEXT CHECK (
          terminal_status IS NULL OR terminal_status IN ('completed','failed','cancelled','interrupted')
        ),
        last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence > 0),
        PRIMARY KEY (session_id, run_id),
        UNIQUE (terminal_event_id)
      );
      INSERT INTO runtime_run_projection (
        session_id, run_id, started_event_id, started_sequence,
        terminal_event_id, terminal_sequence, terminal_status, last_event_sequence
      )
      SELECT
        events.session_id,
        events.run_id,
        (
          SELECT started.event_id FROM runtime_events AS started
          WHERE started.session_id = events.session_id
            AND started.run_id = events.run_id
            AND started.kind = 'run.started'
          ORDER BY started.event_seq ASC LIMIT 1
        ),
        (
          SELECT started.event_seq FROM runtime_events AS started
          WHERE started.session_id = events.session_id
            AND started.run_id = events.run_id
            AND started.kind = 'run.started'
          ORDER BY started.event_seq ASC LIMIT 1
        ),
        (
          SELECT terminal.event_id FROM runtime_events AS terminal
          WHERE terminal.session_id = events.session_id
            AND terminal.run_id = events.run_id
            AND terminal.kind = 'run.terminal'
          ORDER BY terminal.event_seq ASC LIMIT 1
        ),
        (
          SELECT terminal.event_seq FROM runtime_events AS terminal
          WHERE terminal.session_id = events.session_id
            AND terminal.run_id = events.run_id
            AND terminal.kind = 'run.terminal'
          ORDER BY terminal.event_seq ASC LIMIT 1
        ),
        (
          SELECT json_extract(terminal.payload_json, '$.data.status')
          FROM runtime_events AS terminal
          WHERE terminal.session_id = events.session_id
            AND terminal.run_id = events.run_id
            AND terminal.kind = 'run.terminal'
          ORDER BY terminal.event_seq ASC LIMIT 1
        ),
        MAX(events.event_seq)
      FROM runtime_events AS events
      GROUP BY events.session_id, events.run_id;
      CREATE INDEX runtime_run_projection_by_terminal
        ON runtime_run_projection(session_id, terminal_sequence)
        WHERE terminal_sequence IS NOT NULL;

      CREATE TABLE runtime_partial_snapshots (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        partial_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, run_id, partial_id)
      );
      CREATE INDEX runtime_partial_snapshots_by_run
        ON runtime_partial_snapshots(session_id, run_id, updated_at, partial_id);

      CREATE TABLE runtime_partial_segments (
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        partial_id TEXT NOT NULL,
        segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, run_id, partial_id, segment_index),
        FOREIGN KEY (session_id, run_id, partial_id)
          REFERENCES runtime_partial_snapshots(session_id, run_id, partial_id) ON DELETE CASCADE
      );

      CREATE TABLE runtime_tool_operations (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        provider_call_id TEXT,
        tool_name TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared','settled')),
        version INTEGER NOT NULL CHECK (version > 0),
        prepared_event_id TEXT NOT NULL,
        outcome_event_id TEXT,
        prepared_at TEXT NOT NULL,
        settled_at TEXT,
        PRIMARY KEY (session_id, run_id, tool_call_id),
        UNIQUE (prepared_event_id),
        UNIQUE (outcome_event_id)
      );
      CREATE INDEX runtime_tool_operations_by_state
        ON runtime_tool_operations(session_id, state, run_id, tool_call_id);

      CREATE TABLE runtime_tool_journal (
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        journal_sequence INTEGER NOT NULL CHECK (journal_sequence > 0),
        phase TEXT NOT NULL CHECK (phase IN ('prepared','settled')),
        event_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, run_id, tool_call_id, journal_sequence),
        FOREIGN KEY (session_id, run_id, tool_call_id)
          REFERENCES runtime_tool_operations(session_id, run_id, tool_call_id) ON DELETE CASCADE
      );

      CREATE TABLE runtime_transcript_records (
        record_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        source_event_id TEXT NOT NULL,
        source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, source_sequence, record_id)
      );
      CREATE INDEX runtime_transcript_records_by_sequence
        ON runtime_transcript_records(session_id, source_sequence, record_id);

      CREATE TABLE runtime_transcript_chunks (
        record_id TEXT NOT NULL REFERENCES runtime_transcript_records(record_id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
        text_value TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        PRIMARY KEY (record_id, chunk_index)
      );

      CREATE TABLE runtime_checkpoint_projection (
        checkpoint_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
        through_event_id TEXT NOT NULL,
        covered_event_count INTEGER NOT NULL CHECK (covered_event_count > 0),
        source_digest TEXT NOT NULL,
        previous_checkpoint_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX runtime_checkpoint_projection_by_run
        ON runtime_checkpoint_projection(session_id, run_id, event_sequence);

      CREATE TABLE runtime_eventlog_metadata (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        metadata_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, metadata_key)
      );

      CREATE TABLE runtime_storage_assets (
        asset_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        run_id TEXT,
        asset_kind TEXT NOT NULL,
        storage_uri TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX runtime_storage_assets_by_session
        ON runtime_storage_assets(session_id, run_id, asset_kind, created_at);
      `,
    ],
    [
      5,
      `
      CREATE UNIQUE INDEX runtime_transcript_records_one_per_sequence
        ON runtime_transcript_records(session_id, source_sequence);
      `,
    ],
    [
      6,
      `
      CREATE TABLE runtime_transcript_projection_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        history_epoch TEXT NOT NULL,
        projector_version INTEGER NOT NULL CHECK (projector_version > 0),
        through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (through_sequence >= 0),
        change_floor_sequence INTEGER NOT NULL DEFAULT 0 CHECK (change_floor_sequence >= 0)
      );

      CREATE TABLE runtime_transcript_item_versions (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        item_revision INTEGER NOT NULL CHECK (item_revision > 0),
        valid_from_sequence INTEGER NOT NULL CHECK (valid_from_sequence >= 0),
        valid_to_sequence INTEGER CHECK (
          valid_to_sequence IS NULL OR valid_to_sequence > valid_from_sequence
        ),
        position_sequence INTEGER NOT NULL CHECK (position_sequence >= 0),
        position_ordinal INTEGER NOT NULL CHECK (position_ordinal >= 0),
        payload_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
        PRIMARY KEY (session_id, item_id, item_revision)
      );
      CREATE UNIQUE INDEX runtime_transcript_item_versions_current
        ON runtime_transcript_item_versions(session_id, item_id)
        WHERE valid_to_sequence IS NULL;
      CREATE INDEX runtime_transcript_item_versions_at_watermark
        ON runtime_transcript_item_versions(
          session_id, valid_from_sequence, valid_to_sequence,
          position_sequence, position_ordinal, item_id
        );

      CREATE TABLE runtime_transcript_changes (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        change_sequence INTEGER NOT NULL CHECK (change_sequence > 0),
        change_ordinal INTEGER NOT NULL CHECK (change_ordinal >= 0),
        op TEXT NOT NULL CHECK (op IN ('upsert','remove')),
        item_id TEXT NOT NULL,
        item_revision INTEGER NOT NULL CHECK (item_revision > 0),
        payload_json TEXT,
        PRIMARY KEY (session_id, change_sequence, change_ordinal),
        CHECK (
          (op = 'upsert' AND payload_json IS NOT NULL) OR
          (op = 'remove' AND payload_json IS NULL)
        )
      );
      CREATE INDEX runtime_transcript_changes_by_item
        ON runtime_transcript_changes(session_id, item_id, change_sequence, change_ordinal);
      `,
    ],
  ]),
};
