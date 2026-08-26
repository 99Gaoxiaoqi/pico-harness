import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  coordinateEventLogHardCut,
  EventLogHardCutBlockedError,
  EventLogHardCutIncompatibleEpochError,
} from "../../src/storage/event-log-hard-cut-coordinator.js";
import {
  CURRENT_EVENT_LOG_EPOCH,
  CURRENT_EVENT_LOG_PROTOCOL_MARKER,
  EVENT_LOG_HARD_CUT_SCOPE,
} from "../../src/storage/sqlite/event-log-hard-cut-scope.js";
import { migrateOperationalDatabaseSync } from "../../src/storage/sqlite/sqlite-schema.js";
import { prepareWorkspaceSqliteStorageSync } from "../../src/storage/sqlite/sqlite-workspace-storage.js";
import {
  ALL_WORKSPACE_SQLITE_SCOPES,
  prepareCurrentWorkspaceSqliteStorageSync,
} from "../../src/storage/sqlite/workspace-scopes.js";

const AT = "2026-08-22T00:00:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

interface Fixture {
  readonly root: string;
  readonly database: DatabaseSync;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pico-eventlog-hard-cut-"));
  const database = new DatabaseSync(join(root, "fixture.sqlite"));
  database.exec("PRAGMA foreign_keys = ON");
  migrateOperationalDatabaseSync(database, ALL_WORKSPACE_SQLITE_SCOPES);
  return { root, database };
}

function cleanup(current: Fixture): void {
  current.database.close();
  rmSync(current.root, { recursive: true, force: true });
}

function insertSession(database: DatabaseSync, sessionId = "session-old"): void {
  database
    .prepare(
      `INSERT INTO sessions (
         session_id, work_dir, created_at, updated_at, last_event_at,
         last_event_seq, event_count, storage_bytes
       ) VALUES (?, '/tmp/work', ?, ?, ?, 1, 1, 2)`,
    )
    .run(sessionId, AT, AT, AT);
  database
    .prepare(
      `INSERT INTO runtime_events (
         event_id, session_id, invocation_id, run_id, turn_id, event_seq, kind,
         visibility, partial, tx_id, payload_json, at, committed_at
       ) VALUES ('runtime-event', ?, 'inv', 'run-old', 'turn', 1, 'run.started',
                 'internal', 0, 'tx', '{}', ?, ?)`,
    )
    .run(sessionId, AT, AT);
  database
    .prepare(
      `INSERT INTO session_catalog_projection (
         session_id, work_dir, created_at, updated_at, activity_at, message_count,
         is_archived, is_pinned, is_published, head_sequence, event_count,
         storage_bytes, fold_json
       ) VALUES (?, '/tmp/work', ?, ?, ?, 0, 0, 0, 1, 1, 1, 2, '{}')`,
    )
    .run(sessionId, AT, AT, AT);
  database
    .prepare(
      `INSERT INTO session_messages (
         session_id, sequence, event_id, message_id, role, message_ts, payload_json
       ) VALUES (?, 1, 'runtime-event', 'message', 'user', ?, '{"role":"user","content":"x"}')`,
    )
    .run(sessionId, AT);
  database.prepare("INSERT INTO runtime_owner_fences VALUES (?, 2, ?)").run(sessionId, AT);
  database
    .prepare(
      `INSERT INTO runtime_run_projection (
         session_id, run_id, started_event_id, started_sequence, last_event_sequence
       ) VALUES (?, 'run-old', 'runtime-event', 1, 1)`,
    )
    .run(sessionId);
  database
    .prepare(
      `INSERT INTO runtime_partial_snapshots
       VALUES (?, 'run-old', 'partial', 'text', 1, '{}', ?)`,
    )
    .run(sessionId, AT);
  database
    .prepare(
      `INSERT INTO runtime_partial_segments
       VALUES (?, 'run-old', 'partial', 0, '{}', ?)`,
    )
    .run(sessionId, AT);
  database
    .prepare(
      `INSERT INTO runtime_tool_operations (
         session_id, run_id, tool_call_id, tool_name, arguments_hash, state,
         version, prepared_event_id, prepared_at
       ) VALUES (?, 'run-old', 'tool', 'shell', 'hash', 'prepared', 1, 'prepared-event', ?)`,
    )
    .run(sessionId, AT);
  database
    .prepare(
      `INSERT INTO runtime_tool_journal
       VALUES (?, 'run-old', 'tool', 1, 'prepared', 'prepared-event', '{}', ?)`,
    )
    .run(sessionId, AT);
  database
    .prepare(
      `INSERT INTO runtime_checkpoint_projection
       VALUES ('checkpoint', ?, 'run-old', 'checkpoint-event', 1,
               'runtime-event', 1, 'digest', NULL, ?)`,
    )
    .run(sessionId, AT);
  database
    .prepare("INSERT INTO runtime_eventlog_metadata VALUES (?, 'key', '{}', 1, ?)")
    .run(sessionId, AT);
  database
    .prepare(
      `INSERT INTO runtime_storage_assets
       VALUES ('asset', ?, 'run-old', 'trace', ?, 'opaque-digest', 7, '{}', ?)`,
    )
    .run(sessionId, join("/tmp", "eventlog-exclusive-asset"), AT);
  database
    .prepare(
      `INSERT INTO runtime_continuation_claims
       VALUES ('claim', ?, 'run-old', 1, ?, ?, 'run-target', ?)`,
    )
    .run(sessionId, DIGEST_A, sessionId, AT);
}

function insertTerminalWeakReferences(database: DatabaseSync): void {
  const taskFinished = JSON.stringify({
    schemaVersion: 1,
    eventId: "task-event",
    taskRunId: "task-terminal",
    kind: "task.finished",
    at: AT,
    data: { status: "succeeded" },
  });
  database
    .prepare(
      `INSERT INTO task_runs VALUES (
         'task-terminal', '/tmp/work', 'root', 'adapter', 1, '{}', ?, 1, ?,
         1, 'task-tx', 1, 'succeeded', ?
       )`,
    )
    .run(DIGEST_A, AT, AT);
  database
    .prepare(
      `INSERT INTO task_run_events
       VALUES ('task-event', 'task-terminal', 1, 'task.finished', 'task-tx', ?, ?)`,
    )
    .run(taskFinished, AT);

  database.prepare("INSERT INTO control_metadata VALUES ('revision', '3')").run();
  database
    .prepare(
      `INSERT INTO jobs VALUES (
         'job-terminal', 'local_agent', 'succeeded', 'recoverable', 'required', 'done',
         'session-old', 'session-child', NULL, NULL, NULL, 2, 1, 1, 1, 2, 2, NULL
       )`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO job_attempts VALUES (
         'attempt-terminal', 'job-terminal', 1, 'succeeded', 'owner', 1, NULL, 0,
         1, 2, 2, NULL, '{}', 2
       )`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO daemon_runs VALUES (
         'daemon-terminal', '/tmp/work', 'session-old', 'checkpoint', 'done',
         'succeeded', 1, 2, 2, NULL, '{}', 2
       )`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO usage_provider_calls VALUES (
         'call', 'tx', 'session-old', 'conversation', NULL, NULL, NULL,
         'main', 'provider', 'model', NULL, 'succeeded', 1, 1, 0, 0, 0, NULL, 1
       )`,
    )
    .run();
  database
    .prepare(
      "INSERT INTO usage_baselines VALUES ('baseline', 'session-old', NULL, 1, 1, 0, 0, 0, 1, NULL)",
    )
    .run();
  database
    .prepare(
      "INSERT INTO desktop_input_queue VALUES ('queue', '/tmp/work', 'session-old', '{}', 1)",
    )
    .run();
  database
    .prepare(
      "INSERT INTO desktop_first_send_claims VALUES ('/tmp/work', 'send', 'session-old', 'hash', 1)",
    )
    .run();
  database
    .prepare(
      "INSERT INTO storage_operations VALUES ('operation', 'rewind', 2, 'completed', 'session-old', NULL, '{}', ?, ?)",
    )
    .run(AT, AT);
}

function insertMemory(database: DatabaseSync): void {
  database.prepare("INSERT INTO memory_metadata VALUES ('revision', '4')").run();
  database
    .prepare(
      `INSERT INTO memory_sources VALUES (
         'source-derived', 'session-old', 'run-old', NULL, '["runtime-event"]', 1, 1, 'digest', ?,
         'available', NULL, NULL, NULL, 1, ?, ?
       )`,
    )
    .run(
      JSON.stringify({
        schemaVersion: "pico.evidence_ref.v1",
        sessionId: "session-old",
        runId: "run-old",
        coverage: {
          ledger: "session_runtime_event",
          streamId: "session-old",
          highSequence: 1,
          eventIds: ["runtime-event"],
          eventCount: 1,
        },
        digest: "digest",
      }),
      AT,
      AT,
    );
  database
    .prepare(
      `INSERT INTO memory_facts VALUES (
         'fact-derived', 'project_fact', 'edited title', 'edited durable body', 1, 'source-derived',
         'active', 1, NULL, ?, 3, ?, ?, NULL
       )`,
    )
    .run(AT, AT, AT);
  database
    .prepare(
      `INSERT INTO memory_facts VALUES (
         'fact-derived-archived', 'reference', 'archived source fact', 'keep archived body', 0.8,
         'source-derived', 'archived', 0, NULL, NULL, 2, ?, ?, NULL
       )`,
    )
    .run(AT, AT);
  database
    .prepare(
      `INSERT INTO memory_facts VALUES (
         'fact-manual', 'preference', 'manual', 'keep', 1, NULL,
         'active', 1, NULL, NULL, 1, ?, ?, NULL
       )`,
    )
    .run(AT, AT);
  database
    .prepare(
      `INSERT INTO memory_proposals VALUES (
         'proposal-derived', 'project_fact', 'derived', 'derived', 'reason', 1,
         'source-derived', 'pending', 'none', NULL, NULL, 1, ?, ?, NULL, NULL
       )`,
    )
    .run(AT, AT);
  database
    .prepare(
      `INSERT INTO memory_proposals VALUES (
         'proposal-accepted', 'project_fact', 'accepted', 'accepted body', 'accepted reason', 1,
         'source-derived', 'accepted', 'resolved', NULL, 'fact-derived', 2, ?, ?, ?, NULL
       )`,
    )
    .run(AT, AT, AT);
  database
    .prepare(
      `INSERT INTO memory_proposals VALUES (
         'proposal-manual', 'preference', 'manual', 'keep', 'reason', 1,
         NULL, 'accepted', 'resolved', 'fact-derived', 'fact-derived', 1, ?, ?, ?, NULL
       )`,
    )
    .run(AT, AT, AT);
  database
    .prepare(
      `INSERT INTO memory_jobs VALUES (
         'memory-terminal', 'terminal-extraction', 'succeeded', 'runtime-event', 'v1',
         '{"sessionId":"session-old"}', 'source-derived', 1, 1, NULL, NULL,
         0, 0, 0, 0, 1, ?, ?, ?
       )`,
    )
    .run(AT, AT, AT);
  database
    .prepare(
      `INSERT INTO memory_jobs VALUES (
         'memory-retryable', 'terminal-extraction', 'failed', 'runtime-event-retry', 'v1',
         '{"sessionId":"session-old"}', 'source-derived', 1, 3, ?, 'model_error',
         1, 10, 5, 0.01, 2, ?, ?, ?
       )`,
    )
    .run(AT, AT, AT, AT);
  database
    .prepare(
      `INSERT INTO memory_jobs VALUES (
         'memory-orphan-retryable', 'terminal-extraction', 'failed', 'orphan-runtime-event', 'v1',
         '{"sessionId":"session-already-deleted"}', NULL, 1, 3, ?, 'model_error',
         1, 10, 5, 0.01, 2, ?, ?, ?
       )`,
    )
    .run(AT, AT, AT, AT);
  for (const [sequence, entityType, entityId, action] of [
    [1, "source", "source-derived", "source.created"],
    [2, "fact", "fact-derived", "fact.created"],
    [3, "proposal", "proposal-derived", "proposal.created"],
    [4, "fact", "fact-manual", "fact.created"],
    [5, "fact", "fact-derived-archived", "fact.created"],
    [6, "proposal", "proposal-accepted", "proposal.accepted"],
    [7, "job", "memory-terminal", "job.created"],
    [8, "job", "memory-retryable", "job.created"],
    [9, "job", "memory-orphan-retryable", "job.created"],
  ] as const) {
    database
      .prepare(
        `INSERT INTO memory_mutations
         VALUES (?, ?, ?, ?, ?, NULL, 1, NULL, ?)`,
      )
      .run(sequence, `mutation-${sequence}`, entityType, entityId, action, AT);
  }
  database
    .prepare("INSERT INTO memory_idempotency VALUES ('manual-overlay', 'request-hash', '{}', ?)")
    .run(AT);
}

function insertAttachments(database: DatabaseSync): void {
  const evidence = JSON.stringify({
    kind: "tool-exchange",
    sessionId: "session-old",
    rawOutput: { algorithm: "sha256", digest: DIGEST_A, sizeBytes: 9, encoding: "utf8" },
  });
  database
    .prepare("INSERT INTO evidence_records VALUES ('session-old', ?, 'tool-exchange', ?, ?)")
    .run(DIGEST_B, AT, evidence);
  database.prepare("INSERT INTO evidence_blobs VALUES (?, 9, ?)").run(DIGEST_A, AT);
  database.prepare("INSERT INTO file_history VALUES ('session-old', 1, 1, ?, ?)").run(
    JSON.stringify({
      backup: { algorithm: "sha256", digest: DIGEST_B, sizeBytes: 11 },
    }),
    AT,
  );
  database
    .prepare(
      `INSERT INTO file_history_snapshots
       VALUES ('session-old', 0, 1, 'message', 'runtime-event', 0, 'prompt', ?, ?)`,
    )
    .run(
      AT,
      JSON.stringify({
        backup: { algorithm: "sha256", digest: DIGEST_B, sizeBytes: 11 },
      }),
    );
}

function count(database: DatabaseSync, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

function records(database: DatabaseSync, sql: string): Array<Record<string, unknown>> {
  return (database.prepare(sql).all() as Array<Record<string, unknown>>).map((row) => ({ ...row }));
}

function memorySnapshot(database: DatabaseSync): Record<string, unknown> {
  return {
    metadata: records(database, "SELECT * FROM memory_metadata ORDER BY key"),
    sources: records(database, "SELECT * FROM memory_sources ORDER BY source_id"),
    facts: records(database, "SELECT * FROM memory_facts ORDER BY fact_id"),
    proposals: records(database, "SELECT * FROM memory_proposals ORDER BY proposal_id"),
    mutations: records(database, "SELECT * FROM memory_mutations ORDER BY sequence"),
    jobs: records(database, "SELECT * FROM memory_jobs ORDER BY job_id"),
    idempotency: records(database, "SELECT * FROM memory_idempotency ORDER BY operation_key"),
  };
}

test("event log hard cut: clears old sessions while preserving committed memory facts", () => {
  const current = fixture();
  const exclusiveFile = join(current.root, "exclusive-asset");
  writeFileSync(exclusiveFile, "keep until GC worker");
  try {
    insertSession(current.database);
    current.database
      .prepare("UPDATE runtime_storage_assets SET storage_uri = ? WHERE asset_id = 'asset'")
      .run(exclusiveFile);
    insertTerminalWeakReferences(current.database);
    insertMemory(current.database);
    insertAttachments(current.database);
    const factsBefore = records(current.database, "SELECT * FROM memory_facts ORDER BY fact_id");
    const independentProposalBefore = records(
      current.database,
      "SELECT * FROM memory_proposals WHERE proposal_id = 'proposal-manual'",
    );
    const idempotencyBefore = records(current.database, "SELECT * FROM memory_idempotency");

    const result = coordinateEventLogHardCut(current.database, {
      now: () => new Date(AT),
    });

    assert.equal(result.status, "cut");
    if (result.status !== "cut") assert.fail("expected cut result");
    assert.equal(result.deletedSessionCount, 1);
    assert.equal(result.marker.epoch, CURRENT_EVENT_LOG_EPOCH);
    assert.equal(result.marker.protocolMarker, CURRENT_EVENT_LOG_PROTOCOL_MARKER);
    for (const table of [
      "sessions",
      "runtime_events",
      "runtime_run_projection",
      "runtime_partial_snapshots",
      "runtime_partial_segments",
      "runtime_tool_operations",
      "runtime_tool_journal",
      "runtime_checkpoint_projection",
      "runtime_eventlog_metadata",
      "runtime_storage_assets",
      "evidence_records",
      "evidence_blobs",
      "file_history",
      "file_history_snapshots",
      "storage_operations",
    ]) {
      assert.equal(count(current.database, table), 0, table);
    }

    assert.equal(count(current.database, "task_runs"), 1);
    assert.equal(
      (current.database.prepare("SELECT status FROM task_runs").get() as { status: string }).status,
      "succeeded",
    );
    assert.deepEqual(
      {
        ...current.database
          .prepare("SELECT status, owner_session_id, child_session_id FROM jobs")
          .get(),
      },
      { status: "succeeded", owner_session_id: null, child_session_id: null },
    );
    assert.deepEqual(
      {
        ...current.database.prepare("SELECT session_id, checkpoint_id FROM daemon_runs").get(),
      },
      { session_id: null, checkpoint_id: null },
    );
    assert.deepEqual(
      records(current.database, "SELECT * FROM memory_facts ORDER BY fact_id"),
      factsBefore,
      "hard cut must not alter source-linked, pinned, edited, archived, or independent facts",
    );
    assert.deepEqual(
      records(
        current.database,
        `SELECT source_id, availability, evidence_ref_json, invalidated_at, invalidation_code
         FROM memory_sources ORDER BY source_id`,
      ),
      [
        {
          source_id: "source-derived",
          availability: "unavailable",
          evidence_ref_json: null,
          invalidated_at: AT,
          invalidation_code: "event_log_hard_cut",
        },
      ],
    );
    assert.deepEqual(
      records(
        current.database,
        `SELECT proposal_id, title, content, reason, status, source_id,
                conflict_fact_id, resolved_fact_id, deleted_at
         FROM memory_proposals WHERE source_id IS NOT NULL ORDER BY proposal_id`,
      ),
      [
        {
          proposal_id: "proposal-accepted",
          title: null,
          content: null,
          reason: null,
          status: "deleted",
          source_id: "source-derived",
          conflict_fact_id: null,
          resolved_fact_id: "fact-derived",
          deleted_at: AT,
        },
        {
          proposal_id: "proposal-derived",
          title: null,
          content: null,
          reason: null,
          status: "deleted",
          source_id: "source-derived",
          conflict_fact_id: null,
          resolved_fact_id: null,
          deleted_at: AT,
        },
      ],
    );
    assert.deepEqual(
      records(
        current.database,
        "SELECT * FROM memory_proposals WHERE proposal_id = 'proposal-manual'",
      ),
      independentProposalBefore,
      "independent proposal overlays must stay intact",
    );
    assert.deepEqual(
      records(
        current.database,
        `SELECT job_id, status, error_code FROM memory_jobs
         WHERE type = 'terminal-extraction' ORDER BY job_id`,
      ),
      [
        {
          job_id: "memory-orphan-retryable",
          status: "cancelled",
          error_code: "memory_source_unavailable",
        },
        {
          job_id: "memory-retryable",
          status: "cancelled",
          error_code: "memory_source_unavailable",
        },
        { job_id: "memory-terminal", status: "succeeded", error_code: null },
      ],
    );
    assert.deepEqual(
      records(current.database, "SELECT * FROM memory_idempotency"),
      idempotencyBefore,
    );
    assert.equal(
      (
        current.database
          .prepare("SELECT value_json FROM memory_metadata WHERE key = 'revision'")
          .get() as { value_json: string }
      ).value_json,
      "5",
    );
    assert.deepEqual(
      result.gcIntents.map((intent) => [intent.assetScope, intent.contentDigest]),
      [
        ["evidence_blob", DIGEST_A],
        ["file_history_blob", DIGEST_B],
        ["runtime_asset", "opaque-digest"],
      ],
    );
    assert.equal(existsSync(exclusiveFile), true, "DB transaction must not unlink files");

    const replay = coordinateEventLogHardCut(current.database);
    assert.equal(replay.status, "already_current");
    if (replay.status !== "already_current") assert.fail("expected idempotent replay");
    assert.equal(replay.marker.cutoverId, result.marker.cutoverId);
    assert.deepEqual(replay.gcIntents, result.gcIntents);
  } finally {
    cleanup(current);
  }
});

test("event log hard cut: active work blocks without changing facts or projections", () => {
  const current = fixture();
  try {
    insertSession(current.database);
    insertMemory(current.database);
    current.database
      .prepare(
        `INSERT INTO memory_jobs VALUES (
           'memory-active', 'terminal-extraction', 'queued', 'runtime-event-active', 'v1',
           '{"sessionId":"session-old"}', 'source-derived', 0, 3, NULL, NULL,
           0, 0, 0, 0, 1, ?, ?, NULL
         )`,
      )
      .run(AT, AT);
    const memoryBefore = memorySnapshot(current.database);
    const started = JSON.stringify({
      schemaVersion: 1,
      eventId: "attempt-started",
      taskRunId: "task-active",
      kind: "attempt.started",
      at: AT,
      data: { attemptId: "attempt-active", attemptNumber: 1 },
    });
    current.database
      .prepare(
        `INSERT INTO task_runs VALUES (
           'task-active', '/tmp/work', 'root', 'adapter', 1, '{}', ?, 1, ?,
           1, 'task-tx', 1, 'running', ?
         )`,
      )
      .run(DIGEST_A, AT, AT);
    current.database
      .prepare(
        `INSERT INTO task_run_events
         VALUES ('attempt-started', 'task-active', 1, 'attempt.started', 'task-tx', ?, ?)`,
      )
      .run(started, AT);
    current.database
      .prepare(
        `INSERT INTO jobs VALUES (
           'job-active', 'local_agent', 'queued', 'recoverable', 'required', 'active',
           'session-old', NULL, NULL, NULL, NULL, 1, 0, 0, 1, 1, NULL, NULL
         )`,
      )
      .run();

    const result = coordinateEventLogHardCut(current.database);

    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") assert.fail("expected blocked result");
    assert.deepEqual(
      result.blockers.map((blocker) => blocker.kind),
      ["task_run", "task_attempt", "control_job", "memory_job"],
    );
    assert.equal(count(current.database, "sessions"), 1);
    assert.equal(count(current.database, "event_log_epoch"), 0);
    assert.equal(count(current.database, "event_log_blob_gc_intents"), 0);
    assert.equal(
      (current.database.prepare("SELECT status FROM task_runs").get() as { status: string }).status,
      "running",
    );
    assert.equal(
      (current.database.prepare("SELECT status FROM jobs").get() as { status: string }).status,
      "queued",
    );
    assert.deepEqual(memorySnapshot(current.database), memoryBefore);
  } finally {
    cleanup(current);
  }
});

test("event log hard cut: a crash before commit rolls back cleanup, marker, and GC intents", () => {
  const current = fixture();
  try {
    insertSession(current.database);
    insertMemory(current.database);
    const memoryBefore = memorySnapshot(current.database);
    assert.throws(
      () =>
        coordinateEventLogHardCut(current.database, {
          beforeCommit: () => {
            throw new Error("simulated crash");
          },
        }),
      /simulated crash/,
    );
    assert.equal(count(current.database, "sessions"), 1);
    assert.equal(count(current.database, "runtime_events"), 1);
    assert.equal(count(current.database, "event_log_epoch"), 0);
    assert.equal(count(current.database, "event_log_blob_gc_intents"), 0);
    assert.deepEqual(
      memorySnapshot(current.database),
      memoryBefore,
      "the failpoint must roll back Memory invalidation and tombstones with the EventLog cut",
    );

    const recovered = coordinateEventLogHardCut(current.database, { now: () => new Date(AT) });
    assert.equal(recovered.status, "cut");
    assert.equal(count(current.database, "sessions"), 0);
    assert.equal(count(current.database, "event_log_epoch"), 1);
    assert.equal(
      (
        current.database
          .prepare("SELECT availability FROM memory_sources WHERE source_id = 'source-derived'")
          .get() as { availability: string }
      ).availability,
      "unavailable",
    );
    assert.deepEqual(
      records(current.database, "SELECT * FROM memory_facts ORDER BY fact_id"),
      memoryBefore["facts"],
    );
  } finally {
    cleanup(current);
  }
});

test("event log hard cut: refuses a newer or mismatched current protocol marker", () => {
  const current = fixture();
  try {
    current.database
      .prepare("INSERT INTO event_log_epoch VALUES (1, ?, 'future', 'cut', ?)")
      .run(CURRENT_EVENT_LOG_EPOCH + 1, AT);
    assert.throws(
      () => coordinateEventLogHardCut(current.database),
      EventLogHardCutIncompatibleEpochError,
    );
    current.database.prepare("DELETE FROM event_log_epoch").run();
    current.database
      .prepare("INSERT INTO event_log_epoch VALUES (1, ?, 'other-protocol', 'cut', ?)")
      .run(CURRENT_EVENT_LOG_EPOCH, AT);
    assert.throws(
      () => coordinateEventLogHardCut(current.database),
      EventLogHardCutIncompatibleEpochError,
    );
  } finally {
    cleanup(current);
  }
});

test("event log hard cut: the single writable prepare path cuts once and reopens idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "pico-eventlog-auto-"));
  try {
    const first = prepareCurrentWorkspaceSqliteStorageSync(root);
    const firstMarker = first.lease.database
      .prepare("SELECT epoch, protocol_marker, cutover_id FROM event_log_epoch")
      .get() as Record<string, unknown>;
    first.lease.release();

    const second = prepareCurrentWorkspaceSqliteStorageSync(root);
    const secondMarker = second.lease.database
      .prepare("SELECT epoch, protocol_marker, cutover_id FROM event_log_epoch")
      .get() as Record<string, unknown>;
    second.lease.release();

    assert.equal(firstMarker["epoch"], CURRENT_EVENT_LOG_EPOCH);
    assert.equal(firstMarker["protocol_marker"], CURRENT_EVENT_LOG_PROTOCOL_MARKER);
    assert.equal(secondMarker["cutover_id"], firstMarker["cutover_id"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("event log hard cut: writable prepare throws typed blockers and leaves no silent orphan", () => {
  const root = mkdtempSync(join(tmpdir(), "pico-eventlog-blocked-open-"));
  const legacyScopes = ALL_WORKSPACE_SQLITE_SCOPES.filter(
    (scope) => scope.name !== EVENT_LOG_HARD_CUT_SCOPE.name,
  );
  try {
    const legacy = prepareWorkspaceSqliteStorageSync(root, legacyScopes);
    insertSession(legacy.lease.database);
    legacy.lease.database
      .prepare(
        `INSERT INTO task_runs VALUES (
           'task-orphan', '/tmp/work', ?, 'adapter', 1, '{}', ?, 1, ?,
           0, NULL, 0, 'running', ?
         )`,
      )
      .run(legacy.rootIdentity.storageRootId, DIGEST_A, AT, AT);
    legacy.lease.release();

    assert.throws(
      () => prepareCurrentWorkspaceSqliteStorageSync(root),
      (error: unknown) => {
        assert.ok(error instanceof EventLogHardCutBlockedError);
        assert.deepEqual(
          error.blockers.map((blocker) => blocker.kind),
          ["task_run"],
        );
        return true;
      },
    );

    const inspection = prepareWorkspaceSqliteStorageSync(root, ALL_WORKSPACE_SQLITE_SCOPES);
    assert.equal(count(inspection.lease.database, "sessions"), 1);
    assert.equal(count(inspection.lease.database, "event_log_epoch"), 0);
    assert.equal(
      (
        inspection.lease.database
          .prepare("SELECT status FROM task_runs WHERE task_run_id = 'task-orphan'")
          .get() as { status: string }
      ).status,
      "running",
    );
    inspection.lease.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
