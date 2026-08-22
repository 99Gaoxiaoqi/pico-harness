import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EVENT_LOG_CLOSURE_WRITE_INTENTS } from "../../src/storage/event-log-retention-policy.js";
import { closeAllOperationalDatabasesForTest } from "../../src/storage/sqlite/sqlite-database.js";
import {
  EventLogQuotaBlockedError,
  assertEventLogWriteAllowed,
  enforceEventLogRetention,
  readEventLogStorageStatus,
  readPendingEventLogBlobGcIntents,
  recordEventLogBlobGcResult,
} from "../../src/storage/sqlite/sqlite-event-log-retention-store.js";
import { withWorkspaceSqliteLease } from "../../src/storage/sqlite/workspace-scopes.js";

const TINY_POLICY = { hardLimitBytes: 2, lowWatermarkBytes: 1 } as const;
const EVIDENCE_DIGEST = "a".repeat(64);
const FILE_HISTORY_DIGEST = "b".repeat(64);
const ASSET_DIGEST = "c".repeat(64);

async function fixture(name: string): Promise<{ root: string; storageRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), `pico-retention-${name}-`));
  return { root, storageRoot: join(root, "storage") };
}

async function cleanup(root: string): Promise<void> {
  closeAllOperationalDatabasesForTest();
  await rm(root, { force: true, recursive: true });
}

function seedSession(
  storageRoot: string,
  sessionId: string,
  options: { archived?: boolean; pinned?: boolean } = {},
): void {
  withWorkspaceSqliteLease(storageRoot, (lease) =>
    lease.transaction("write", () => {
      lease.database
        .prepare(
          `INSERT INTO sessions (
             session_id, work_dir, created_at, archived_at, pinned_at, updated_at
           ) VALUES (?, '/workspace', '2026-01-01T00:00:00.000Z', ?, ?, '2026-01-01T00:00:00.000Z')`,
        )
        .run(sessionId, options.archived === false ? null : 1, options.pinned === true ? 1 : null);
    }),
  );
}

test("sqlite EventLog retention: measures UTF-8 payload bytes and shared blobs only once", async () => {
  const { root, storageRoot } = await fixture("bytes");
  try {
    seedSession(storageRoot, "one");
    seedSession(storageRoot, "two");
    const before = readEventLogStorageStatus({ storageRoot });
    const metadata = { key: "标题", value: JSON.stringify({ text: "你好👋" }), at: "2026" };
    withWorkspaceSqliteLease(storageRoot, (lease) =>
      lease.transaction("write", () => {
        lease.database
          .prepare(
            `INSERT INTO runtime_eventlog_metadata (
               session_id, metadata_key, value_json, version, updated_at
             ) VALUES ('one', ?, ?, 1, ?)`,
          )
          .run(metadata.key, metadata.value, metadata.at);
        for (const sessionId of ["one", "two"]) {
          lease.database
            .prepare(
              `INSERT INTO runtime_storage_assets (
                 asset_id, session_id, asset_kind, storage_uri, content_digest,
                 byte_length, metadata_json, created_at
               ) VALUES (?, ?, 'tool', 'cas://shared', ?, 1234, '{}', '2026')`,
            )
            .run(`asset-${sessionId}`, sessionId, ASSET_DIGEST);
        }
      }),
    );

    const after = readEventLogStorageStatus({ storageRoot });
    const one = after.sessions.find(({ sessionId }) => sessionId === "one")!;
    const two = after.sessions.find(({ sessionId }) => sessionId === "two")!;
    const metadataBytes = Buffer.byteLength("one" + metadata.key + metadata.value + metadata.at);
    assert.equal(
      one.breakdown.checkpointAndMetadataBytes -
        before.sessions[0]!.breakdown.checkpointAndMetadataBytes >=
        metadataBytes,
      true,
    );
    assert.equal(one.breakdown.exclusiveBlobBytes, 0);
    assert.equal(two.breakdown.exclusiveBlobBytes, 0);
    assert.equal(after.unattributedSharedBlobBytes, 1234);
    assert.equal(
      after.logicalBytes - before.logicalBytes,
      metadataBytes +
        Buffer.byteLength(
          "asset-oneonetoolcas://shared" +
            ASSET_DIGEST +
            "{}2026" +
            "asset-twotwotoolcas://shared" +
            ASSET_DIGEST +
            "{}2026",
        ) +
        1234,
    );
  } finally {
    await cleanup(root);
  }
});

test("sqlite EventLog retention: protects current, live, pinned, active and unfinished sessions", async () => {
  const { root, storageRoot } = await fixture("guards");
  try {
    for (const sessionId of ["eligible", "current", "pinned", "active", "unfinished"]) {
      seedSession(storageRoot, sessionId, { pinned: sessionId === "pinned" });
    }
    seedSession(storageRoot, "live", { archived: false });
    withWorkspaceSqliteLease(storageRoot, (lease) =>
      lease.transaction("write", () => {
        lease.database
          .prepare(
            `INSERT INTO runtime_run_projection (
               session_id, run_id, started_event_id, started_sequence, last_event_sequence
             ) VALUES ('active', 'run', 'event', 1, 1)`,
          )
          .run();
        lease.database
          .prepare(
            `INSERT INTO storage_operations (
               operation_id, kind, version, state, session_id, operation_json, created_at, updated_at
             ) VALUES ('operation', 'rewind', 1, 'prepared', 'unfinished', '{}', '2026', '2026')`,
          )
          .run();
      }),
    );

    const status = readEventLogStorageStatus({
      storageRoot,
      currentSessionId: "current",
      policy: TINY_POLICY,
    });
    assert.deepEqual(status.plan.sessionIdsToDelete, ["eligible"]);
    assert.equal(
      status.sessions.find(({ sessionId }) => sessionId === "active")!.hasActiveRun,
      true,
    );
    assert.equal(
      status.sessions.find(({ sessionId }) => sessionId === "unfinished")!.hasUnfinishedOperation,
      true,
    );
  } finally {
    await cleanup(root);
  }
});

test("sqlite EventLog retention: rechecks protection in the delete transaction", async () => {
  const { root, storageRoot } = await fixture("recheck");
  try {
    seedSession(storageRoot, "candidate");
    const result = enforceEventLogRetention({
      storageRoot,
      policy: TINY_POLICY,
      beforeApply: () => {
        withWorkspaceSqliteLease(storageRoot, (lease) =>
          lease.transaction("write", () => {
            lease.database
              .prepare("UPDATE sessions SET pinned_at = 2 WHERE session_id = 'candidate'")
              .run();
          }),
        );
      },
    });
    assert.deepEqual(result.deletedSessionIds, []);
    assert.deepEqual(result.skippedSessions, [{ sessionId: "candidate", reason: "pinned" }]);
    assert.equal(result.maintenance.status, "not_needed");
    assert.equal(
      result.after.sessions.some(({ sessionId }) => sessionId === "candidate"),
      true,
    );
  } finally {
    await cleanup(root);
  }
});

test("sqlite EventLog retention: cascades manifests and durably records only zero-ref blob GC", async () => {
  const { root, storageRoot } = await fixture("gc");
  try {
    seedSession(storageRoot, "first");
    seedSession(storageRoot, "second");
    const evidenceJson = JSON.stringify({
      // DB inventory is authoritative when a manifest's cached size is stale.
      blob: { algorithm: "sha256", digest: EVIDENCE_DIGEST, sizeBytes: 999 },
    });
    const historyJson = JSON.stringify({
      blob: { algorithm: "sha256", digest: FILE_HISTORY_DIGEST, sizeBytes: 202 },
    });
    withWorkspaceSqliteLease(storageRoot, (lease) =>
      lease.transaction("write", () => {
        lease.database
          .prepare(
            "INSERT INTO evidence_blobs (digest, size_bytes, created_at) VALUES (?, 101, '2026')",
          )
          .run(EVIDENCE_DIGEST);
        for (const sessionId of ["first", "second"]) {
          lease.database
            .prepare(
              `INSERT INTO evidence_records (
                 session_id, content_hash, kind, archived_at, content_json
               ) VALUES (?, ?, 'tool-exchange', '2026', ?)`,
            )
            .run(sessionId, sessionId === "first" ? "1".repeat(64) : "2".repeat(64), evidenceJson);
          lease.database
            .prepare(
              `INSERT INTO file_history (
                 session_id, revision, state_json, updated_at
               ) VALUES (?, 1, ?, '2026')`,
            )
            .run(sessionId, historyJson);
          lease.database
            .prepare(
              `INSERT INTO runtime_storage_assets (
                 asset_id, session_id, asset_kind, storage_uri, content_digest,
                 byte_length, metadata_json, created_at
               ) VALUES (?, ?, 'tool', 'cas://shared', ?, 303, '{}', '2026')`,
            )
            .run(`asset-${sessionId}`, sessionId, ASSET_DIGEST);
        }
        lease.database
          .prepare(
            `INSERT INTO desktop_idempotency (
               workspace_path, idempotency_key, request_fingerprint, result_json, created_at
             ) VALUES ('/workspace', 'send-second', 'fingerprint', '{"sessionId":"second"}', 1)`,
          )
          .run();
        lease.database
          .prepare(
            `INSERT INTO desktop_first_send_claims (
               workspace_path, idempotency_key, session_id, request_fingerprint, created_at
             ) VALUES ('/workspace', 'send-second', 'second', 'fingerprint', 1)`,
          )
          .run();
        lease.database
          .prepare(
            `INSERT INTO desktop_input_queue (
               queue_id, workspace_path, session_id, input_json, created_at
             ) VALUES ('queue-second', '/workspace', 'second', '{}', 1)`,
          )
          .run();
        lease.database
          .prepare(
            `INSERT INTO jobs (
               job_id, type, status, execution_class, completion_policy, description,
               owner_session_id, version, lease_epoch, attempt_count, created_at, updated_at
             ) VALUES (
               'job-second', 'task', 'succeeded', 'recoverable', 'required', 'done',
               'second', 1, 0, 1, 1, 1
             )`,
          )
          .run();
        lease.database
          .prepare(
            `INSERT INTO job_attempts (
               attempt_id, job_id, attempt_number, status, owner_id, lease_epoch,
               output_offset, started_at, updated_at, finished_at, result_json, version
             ) VALUES ('attempt-second', 'job-second', 1, 'succeeded', 'owner', 0, 0, 1, 1, 1, '{}', 1)`,
          )
          .run();
        lease.database
          .prepare(
            `INSERT INTO job_commands (command_id, job_id, kind, created_at, delivered_at)
             VALUES ('command-second', 'job-second', 'cancel', 1, 1)`,
          )
          .run();
        lease.database
          .prepare(
            `INSERT INTO completion_outbox (
               completion_id, job_id, attempt_id, policy, status, created_at, delivered_at
             ) VALUES ('completion-second', 'job-second', 'attempt-second', 'required', 'completed', 1, 1)`,
          )
          .run();
        lease.database
          .prepare(
            `INSERT INTO merge_requests (
               merge_request_id, job_id, attempt_id, source_branch, source_worktree,
               target_branch, target_worktree, status, version, created_at, updated_at
             ) VALUES (
               'merge-second', 'job-second', 'attempt-second', 'source', '/source',
               'target', '/target', 'merged', 1, 1, 1
             )`,
          )
          .run();
        lease.database
          .prepare(
            `INSERT INTO daemon_runs (
               run_id, workspace_path, session_id, description, status,
               started_at, updated_at, finished_at, version
             ) VALUES ('daemon-second', '/workspace', 'second', 'done', 'succeeded', 1, 1, 1, 1)`,
          )
          .run();
        lease.database
          .prepare(
            `INSERT INTO usage_provider_calls (
               call_id, tx_id, session_id, purpose, provider, model, status,
               input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, created_at
             ) VALUES (
               'usage-second', 'tx', 'second', 'test', 'provider', 'model', 'succeeded',
               0, 0, 0, 0, 0, 1
             )`,
          )
          .run();
        lease.database
          .prepare(
            `INSERT INTO usage_baselines (
               baseline_id, session_id, input_tokens, output_tokens,
               cache_read_tokens, cache_write_tokens, cost, imported_at
             ) VALUES ('baseline-second', 'second', 0, 0, 0, 0, 0, 1)`,
          )
          .run();
        lease.database
          .prepare(
            `INSERT INTO storage_operations (
               operation_id, kind, version, state, session_id, operation_json, created_at, updated_at
             ) VALUES ('operation-second', 'rewind', 1, 'completed', 'second', '{}', '2026', '2026')`,
          )
          .run();
      }),
    );

    const first = enforceEventLogRetention({
      storageRoot,
      currentSessionId: "second",
      policy: TINY_POLICY,
    });
    assert.deepEqual(first.deletedSessionIds, ["first"]);
    assert.deepEqual(first.blobGcIntents, []);
    assert.deepEqual(readPendingEventLogBlobGcIntents({ storageRoot }), []);

    const second = enforceEventLogRetention({ storageRoot, policy: TINY_POLICY });
    assert.deepEqual(second.deletedSessionIds, ["second"]);
    assert.equal(second.maintenance.status, "completed");
    assert.deepEqual(
      second.blobGcIntents.map(({ kind, digest, byteLength }) => ({ kind, digest, byteLength })),
      [
        { kind: "evidence", digest: EVIDENCE_DIGEST, byteLength: 101 },
        { kind: "file_history", digest: FILE_HISTORY_DIGEST, byteLength: 202 },
        { kind: "runtime_asset", digest: ASSET_DIGEST, byteLength: 303 },
      ],
    );
    closeAllOperationalDatabasesForTest();
    assert.equal(readPendingEventLogBlobGcIntents({ storageRoot }).length, 3);
    withWorkspaceSqliteLease(storageRoot, (lease) =>
      lease.transaction("read", () => {
        assert.equal(lease.database.prepare("SELECT 1 FROM sessions").get(), undefined);
        assert.equal(lease.database.prepare("SELECT 1 FROM evidence_records").get(), undefined);
        assert.equal(lease.database.prepare("SELECT 1 FROM file_history").get(), undefined);
        assert.equal(lease.database.prepare("SELECT 1 FROM evidence_blobs").get(), undefined);
        for (const table of [
          "desktop_idempotency",
          "desktop_first_send_claims",
          "desktop_input_queue",
          "storage_operations",
        ]) {
          assert.equal(lease.database.prepare(`SELECT 1 FROM ${table}`).get(), undefined, table);
        }
        for (const table of [
          "jobs",
          "job_attempts",
          "job_commands",
          "completion_outbox",
          "merge_requests",
          "daemon_runs",
          "usage_provider_calls",
          "usage_baselines",
        ]) {
          assert.notEqual(lease.database.prepare(`SELECT 1 FROM ${table}`).get(), undefined, table);
        }
        const job = lease.database
          .prepare(
            "SELECT owner_session_id, child_session_id FROM jobs WHERE job_id = 'job-second'",
          )
          .get() as Record<string, unknown>;
        assert.equal(job["owner_session_id"], null);
        assert.equal(job["child_session_id"], null);
        const daemonRun = lease.database
          .prepare(
            "SELECT session_id, checkpoint_id FROM daemon_runs WHERE run_id = 'daemon-second'",
          )
          .get() as Record<string, unknown>;
        assert.equal(daemonRun["session_id"], null);
        assert.equal(daemonRun["checkpoint_id"], null);
        const usage = lease.database
          .prepare(
            "SELECT session_id, conversation_id FROM usage_provider_calls WHERE call_id = 'usage-second'",
          )
          .get() as Record<string, unknown>;
        assert.equal(usage["session_id"], null);
        assert.equal(usage["conversation_id"], null);
        const baseline = lease.database
          .prepare("SELECT session_id FROM usage_baselines WHERE baseline_id = 'baseline-second'")
          .get() as Record<string, unknown>;
        assert.equal(baseline["session_id"], null);
        assert.equal(
          lease.database.prepare("SELECT COUNT(*) AS count FROM retention_gc_intents").get()![
            "count"
          ],
          3,
        );
      }),
    );

    const evidenceIntent = second.blobGcIntents.find(({ kind }) => kind === "evidence")!;
    recordEventLogBlobGcResult({
      storageRoot,
      intentId: evidenceIntent.intentId,
      result: { status: "failed", error: "busy" },
    });
    const failed = readPendingEventLogBlobGcIntents({ storageRoot }).find(
      ({ intentId }) => intentId === evidenceIntent.intentId,
    )!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.attemptCount, 1);
    assert.equal(failed.lastError, "busy");
    recordEventLogBlobGcResult({
      storageRoot,
      intentId: evidenceIntent.intentId,
      result: { status: "completed" },
    });
    assert.equal(
      readPendingEventLogBlobGcIntents({ storageRoot }).some(
        ({ intentId }) => intentId === evidenceIntent.intentId,
      ),
      false,
    );
  } finally {
    await cleanup(root);
  }
});

test("sqlite EventLog retention: blocks only new work at the hard limit", async () => {
  const { root, storageRoot } = await fixture("quota");
  try {
    seedSession(storageRoot, "current", { archived: false });
    assert.throws(
      () => assertEventLogWriteAllowed({ storageRoot, intent: "new_work", policy: TINY_POLICY }),
      EventLogQuotaBlockedError,
    );
    for (const intent of EVENT_LOG_CLOSURE_WRITE_INTENTS) {
      assert.doesNotThrow(() =>
        assertEventLogWriteAllowed({ storageRoot, intent, policy: TINY_POLICY }),
      );
    }
  } finally {
    await cleanup(root);
  }
});
