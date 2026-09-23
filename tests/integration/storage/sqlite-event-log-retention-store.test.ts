import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EVENT_LOG_CLOSURE_WRITE_INTENTS } from "@pico/storage";
import { closeAllOperationalDatabasesForTest } from "@pico/storage";
import {
  EventLogQuotaBlockedError,
  admitEventLogNewWork,
  assertEventLogWriteAllowed,
  enforceEventLogRetention,
  readEventLogStorageStatus,
  readPendingEventLogBlobGcIntents,
  recordEventLogBlobGcResult,
} from "@pico/storage/sqlite/event-log-retention-store";
import { withWorkspaceSqliteLease } from "@pico/storage";

const TINY_POLICY = { hardLimitBytes: 2, lowWatermarkBytes: 1 } as const;
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

function byteLength(...values: readonly string[]): number {
  return values.reduce((total, value) => total + Buffer.byteLength(value), 0);
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

test("sqlite EventLog retention: attributes current transcript projection bytes", async () => {
  const { root, storageRoot } = await fixture("transcript-bytes");
  try {
    const sessionId = "session-transcript";
    const historyEpoch = "epoch-1";
    const itemId = "message:event-1";
    const payload = JSON.stringify({ role: "assistant", text: "你好👋" });
    const digest = "d".repeat(64);
    seedSession(storageRoot, sessionId);
    withWorkspaceSqliteLease(storageRoot, (lease) =>
      lease.transaction("write", () => {
        lease.database
          .prepare(
            `INSERT INTO runtime_transcript_projection_state
             (session_id, history_epoch, projector_version, through_sequence, change_floor_sequence)
             VALUES (?, ?, 2, 1, 0)`,
          )
          .run(sessionId, historyEpoch);
        lease.database
          .prepare(
            `INSERT INTO runtime_transcript_item_versions
             (session_id, item_id, item_revision, valid_from_sequence, valid_to_sequence,
              position_sequence, position_ordinal, payload_json, payload_digest)
             VALUES (?, ?, 1, 1, NULL, 1, 0, ?, ?)`,
          )
          .run(sessionId, itemId, payload, digest);
        lease.database
          .prepare(
            `INSERT INTO runtime_transcript_changes
             (session_id, change_sequence, change_ordinal, op, item_id, item_revision, payload_json)
             VALUES (?, 1, 0, 'upsert', ?, 1, ?)`,
          )
          .run(sessionId, itemId, payload);
      }),
    );

    const status = readEventLogStorageStatus({ storageRoot });
    assert.equal(
      status.sessions[0]!.breakdown.transcriptBytes,
      byteLength(
        sessionId,
        historyEpoch,
        sessionId,
        itemId,
        payload,
        digest,
        sessionId,
        "upsert",
        itemId,
        payload,
      ),
    );
  } finally {
    await cleanup(root);
  }
});

test("sqlite EventLog retention: retained control over the cap does not affect admission", async () => {
  const { root, storageRoot } = await fixture("control-quota-independent");
  try {
    seedSession(storageRoot, "archived");
    seedSession(storageRoot, "current", { archived: false });
    const before = readEventLogStorageStatus({ storageRoot, currentSessionId: "current" });
    const policy = {
      hardLimitBytes: before.logicalBytes + 1,
      lowWatermarkBytes: before.logicalBytes,
    } as const;
    withWorkspaceSqliteLease(storageRoot, (lease) =>
      lease.transaction("write", () => {
        lease.database
          .prepare(
            `INSERT INTO daemon_runs (
               run_id, workspace_path, session_id, description, status,
               started_at, updated_at, finished_at, version
             ) VALUES ('large-control', '/workspace', 'archived', ?, 'succeeded', 1, 1, 1, 1)`,
          )
          .run("control".repeat(policy.hardLimitBytes));
      }),
    );

    const measured = readEventLogStorageStatus({
      storageRoot,
      currentSessionId: "current",
      policy,
    });
    assert.equal(measured.logicalBytes, before.logicalBytes);
    assert.equal(
      measured.sessions.find(({ sessionId }) => sessionId === "archived")!.breakdown.controlBytes >
        policy.hardLimitBytes,
      true,
    );
    assert.deepEqual(measured.plan.sessionIdsToDelete, []);
    assert.equal(measured.plan.canStartNewWork, true);

    const admitted = admitEventLogNewWork({ storageRoot, currentSessionId: "current", policy });
    assert.deepEqual(admitted.deletedSessionIds, []);
    assert.equal(admitted.after.plan.canStartNewWork, true);
    assert.equal(
      admitted.after.sessions.some(({ sessionId }) => sessionId === "archived"),
      true,
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
    const historyJson = JSON.stringify({
      blob: { algorithm: "sha256", digest: FILE_HISTORY_DIGEST, sizeBytes: 202 },
    });
    withWorkspaceSqliteLease(storageRoot, (lease) =>
      lease.transaction("write", () => {
        for (const sessionId of ["first", "second"]) {
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
            `INSERT INTO usage_physical_attempts VALUES (
               'physical-second', 'usage-second', 'second', NULL, NULL, 'run', 'owner', 0,
               'succeeded', '2026', '{"accountingSource":"physical","sessionId":"second","runId":"run"}'
             )`,
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
        { kind: "file_history", digest: FILE_HISTORY_DIGEST, byteLength: 202 },
        { kind: "runtime_asset", digest: ASSET_DIGEST, byteLength: 303 },
      ],
    );
    assert.equal(
      second.blobGcIntents.find(({ kind }) => kind === "runtime_asset")?.storageUri,
      "cas://shared",
    );
    closeAllOperationalDatabasesForTest();
    assert.equal(readPendingEventLogBlobGcIntents({ storageRoot }).length, 2);
    withWorkspaceSqliteLease(storageRoot, (lease) =>
      lease.transaction("read", () => {
        assert.equal(lease.database.prepare("SELECT 1 FROM sessions").get(), undefined);
        assert.equal(lease.database.prepare("SELECT 1 FROM file_history").get(), undefined);
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
          "usage_physical_attempts",
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
            "SELECT session_id, run_id FROM usage_physical_attempts WHERE provider_call_id = 'usage-second'",
          )
          .get() as Record<string, unknown>;
        assert.equal(usage["session_id"], null);
        assert.equal(usage["run_id"], null);
        assert.equal(
          lease.database.prepare("SELECT COUNT(*) AS count FROM retention_gc_intents").get()![
            "count"
          ],
          2,
        );
      }),
    );

    const historyIntent = second.blobGcIntents.find(({ kind }) => kind === "file_history")!;
    recordEventLogBlobGcResult({
      storageRoot,
      intentId: historyIntent.intentId,
      result: { status: "failed", error: "busy" },
    });
    const failed = readPendingEventLogBlobGcIntents({ storageRoot }).find(
      ({ intentId }) => intentId === historyIntent.intentId,
    )!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.attemptCount, 1);
    assert.equal(failed.lastError, "busy");
    recordEventLogBlobGcResult({
      storageRoot,
      intentId: historyIntent.intentId,
      result: { status: "completed" },
    });
    assert.equal(
      readPendingEventLogBlobGcIntents({ storageRoot }).some(
        ({ intentId }) => intentId === historyIntent.intentId,
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

test("sqlite EventLog retention: new-work admission prunes first and blocks only when still full", async () => {
  const { root, storageRoot } = await fixture("admission");
  try {
    seedSession(storageRoot, "archived");
    seedSession(storageRoot, "current", { archived: false });
    withWorkspaceSqliteLease(storageRoot, (lease) =>
      lease.transaction("write", () => {
        lease.database
          .prepare(
            `INSERT INTO runtime_storage_assets (
               asset_id, session_id, asset_kind, storage_uri, content_digest,
               byte_length, metadata_json, created_at
             ) VALUES ('large', 'archived', 'tool', 'cas://large', ?, 1000, '{}', '2026')`,
          )
          .run(ASSET_DIGEST);
      }),
    );
    const measured = readEventLogStorageStatus({ storageRoot });
    const currentBytes = measured.sessions.find(
      ({ sessionId }) => sessionId === "current",
    )!.logicalBytes;
    const policy = {
      hardLimitBytes: currentBytes + 500,
      lowWatermarkBytes: currentBytes + 400,
    } as const;

    const admitted = admitEventLogNewWork({
      storageRoot,
      currentSessionId: "current",
      policy,
    });
    assert.deepEqual(admitted.deletedSessionIds, ["archived"]);
    assert.equal(admitted.after.plan.canStartNewWork, true);
    assert.equal(
      admitted.after.sessions.some(({ sessionId }) => sessionId === "archived"),
      false,
    );

    assert.throws(
      () => admitEventLogNewWork({ storageRoot, currentSessionId: "current", policy: TINY_POLICY }),
      EventLogQuotaBlockedError,
    );
  } finally {
    await cleanup(root);
  }
});
