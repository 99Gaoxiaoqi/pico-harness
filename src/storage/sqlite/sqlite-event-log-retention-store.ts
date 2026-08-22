import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_EVENT_LOG_RETENTION_POLICY,
  allowsEventLogWrite,
  planEventLogRetention,
  type EventLogRetentionCandidate,
  type EventLogRetentionPlan,
  type EventLogRetentionPolicy,
  type EventLogWriteIntent,
} from "../event-log-retention-policy.js";
import {
  runIdleSqliteRetentionMaintenance,
  type SqliteRetentionMaintenanceResult,
} from "./sqlite-retention-maintenance.js";
import { withWorkspaceSqliteLease } from "./workspace-scopes.js";

export interface ReadEventLogStorageStatusOptions {
  readonly storageRoot: string;
  readonly currentSessionId?: string | null;
  readonly policy?: EventLogRetentionPolicy;
}

export interface EventLogSessionStorageBreakdown {
  readonly eventLogBytes: number;
  readonly projectionBytes: number;
  readonly partialBytes: number;
  readonly toolBytes: number;
  readonly transcriptBytes: number;
  readonly checkpointAndMetadataBytes: number;
  readonly attachmentManifestBytes: number;
  /** Memory bytes attributed to this Session for observation only; excluded from EventLog quota. */
  readonly memoryBytes: number;
  readonly controlBytes: number;
  /** Blob bytes reclaimable only when this session is their sole remaining owner. */
  readonly exclusiveBlobBytes: number;
}

export interface EventLogSessionStorageStatus extends EventLogRetentionCandidate {
  readonly breakdown: EventLogSessionStorageBreakdown;
}

export interface EventLogStorageStatus {
  /**
   * EventLog UTF-8 text/blob payload bytes plus explicit external blob byte lengths.
   * Long-term Memory bytes are reported separately and excluded from this admission total.
   * SQLite integer encodings, row headers, indexes, free pages and WAL bytes are intentionally excluded.
   */
  readonly logicalBytes: number;
  readonly unattributedSharedBlobBytes: number;
  /** Workspace settings and manual memory overlays that have no Session-owned source. */
  readonly unattributedMemoryBytes: number;
  readonly unattributedControlBytes: number;
  readonly sessions: readonly EventLogSessionStorageStatus[];
  readonly plan: EventLogRetentionPlan;
}

export interface AssertEventLogWriteAllowedOptions extends Omit<
  ReadEventLogStorageStatusOptions,
  "currentSessionId"
> {
  readonly intent: EventLogWriteIntent;
}

export class EventLogQuotaBlockedError extends Error {
  constructor(
    readonly logicalBytes: number,
    readonly hardLimitBytes: number,
  ) {
    super(
      `EventLog logical storage ${logicalBytes} bytes reached the ${hardLimitBytes} byte hard limit`,
    );
    this.name = "EventLogQuotaBlockedError";
  }
}

export type EventLogRetentionSkipReason =
  | "missing"
  | "current"
  | "not_archived"
  | "pinned"
  | "active_run"
  | "unfinished_operation";

export interface EventLogRetentionSkippedSession {
  readonly sessionId: string;
  readonly reason: EventLogRetentionSkipReason;
}

export type EventLogBlobGcKind = "evidence" | "file_history" | "runtime_asset";

/**
 * A post-commit filesystem deletion request. The caller must re-check its own
 * global CAS namespace before unlinking; this store never unlinks inside a DB transaction.
 */
export interface EventLogBlobGcIntent {
  readonly intentId: string;
  readonly kind: EventLogBlobGcKind;
  readonly digest: string;
  readonly byteLength: number;
  readonly status: "pending" | "failed";
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ReadEventLogBlobGcIntentsOptions {
  readonly storageRoot: string;
  readonly limit?: number;
}

export interface RecordEventLogBlobGcResultOptions {
  readonly storageRoot: string;
  readonly intentId: string;
  readonly result:
    | { readonly status: "completed" }
    | { readonly status: "failed"; readonly error: string };
}

export type EventLogRetentionMaintenanceOutcome =
  | { readonly status: "completed"; readonly result: SqliteRetentionMaintenanceResult }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "not_needed" };

export type EnforceEventLogRetentionOptions = ReadEventLogStorageStatusOptions & {
  /** Test/host coordination hook executed after planning and before the write transaction. */
  readonly beforeApply?: () => void;
};

export interface EventLogRetentionResult {
  readonly before: EventLogStorageStatus;
  readonly after: EventLogStorageStatus;
  readonly deletedSessionIds: readonly string[];
  readonly skippedSessions: readonly EventLogRetentionSkippedSession[];
  readonly blobGcIntents: readonly EventLogBlobGcIntent[];
  readonly logicalBytesReclaimed: number;
  readonly maintenance: EventLogRetentionMaintenanceOutcome;
}

export type AdmitEventLogNewWorkOptions = ReadEventLogStorageStatusOptions;

interface MutableBreakdown {
  eventLogBytes: number;
  projectionBytes: number;
  partialBytes: number;
  toolBytes: number;
  transcriptBytes: number;
  checkpointAndMetadataBytes: number;
  attachmentManifestBytes: number;
  memoryBytes: number;
  controlBytes: number;
  exclusiveBlobBytes: number;
}

interface BlobReference {
  readonly sessionId: string;
  readonly digest: string;
  readonly byteLength: number;
}

interface BlobReferenceSnapshot {
  readonly evidence: readonly BlobReference[];
  readonly fileHistory: readonly BlobReference[];
  readonly runtimeAsset: readonly BlobReference[];
}

interface RetentionTransactionResult {
  readonly deletedSessionIds: readonly string[];
  readonly skippedSessions: readonly EventLogRetentionSkippedSession[];
  readonly blobGcIntents: readonly EventLogBlobGcIntent[];
}

interface NewBlobGcIntent {
  readonly kind: EventLogBlobGcKind;
  readonly digest: string;
  readonly byteLength: number;
}

const EMPTY_BREAKDOWN = Object.freeze({
  eventLogBytes: 0,
  projectionBytes: 0,
  partialBytes: 0,
  toolBytes: 0,
  transcriptBytes: 0,
  checkpointAndMetadataBytes: 0,
  attachmentManifestBytes: 0,
  memoryBytes: 0,
  controlBytes: 0,
  exclusiveBlobBytes: 0,
} satisfies EventLogSessionStorageBreakdown);

const TERMINAL_JOB_STATUSES = [
  "succeeded",
  "partial",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
] as const;

export function readEventLogStorageStatus(
  options: ReadEventLogStorageStatusOptions,
): EventLogStorageStatus {
  const currentSessionId = normalizeCurrentSessionId(options.currentSessionId);
  const policy = options.policy ?? DEFAULT_EVENT_LOG_RETENTION_POLICY;
  return withWorkspaceSqliteLease(options.storageRoot, (lease) =>
    lease.transaction("read", () =>
      readStorageStatusLocked(lease.database, currentSessionId, policy),
    ),
  );
}

export function assertEventLogWriteAllowed(
  options: AssertEventLogWriteAllowedOptions,
): EventLogStorageStatus {
  const policy = options.policy ?? DEFAULT_EVENT_LOG_RETENTION_POLICY;
  const status = readEventLogStorageStatus({ storageRoot: options.storageRoot, policy });
  if (!allowsEventLogWrite(status.logicalBytes, options.intent, policy)) {
    throw new EventLogQuotaBlockedError(status.logicalBytes, policy.hardLimitBytes);
  }
  return status;
}

/**
 * Runs deterministic retention before admitting a new Runtime run. Closure writes
 * deliberately bypass this gate so an already-started operation can always settle.
 */
export function admitEventLogNewWork(
  options: AdmitEventLogNewWorkOptions,
): EventLogRetentionResult {
  const result = enforceEventLogRetention(options);
  const policy = options.policy ?? DEFAULT_EVENT_LOG_RETENTION_POLICY;
  if (!allowsEventLogWrite(result.after.logicalBytes, "new_work", policy)) {
    throw new EventLogQuotaBlockedError(result.after.logicalBytes, policy.hardLimitBytes);
  }
  return result;
}

export function readPendingEventLogBlobGcIntents(
  options: ReadEventLogBlobGcIntentsOptions,
): readonly EventLogBlobGcIntent[] {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("limit must be a positive safe integer");
  }
  return withWorkspaceSqliteLease(options.storageRoot, (lease) =>
    lease.transaction("read", () =>
      readBlobGcIntentRows(
        lease.database
          .prepare(
            `SELECT intent_id, blob_kind, digest, byte_length, status,
                    attempt_count, last_error, created_at, updated_at
             FROM retention_gc_intents
             WHERE completed_at IS NULL
             ORDER BY updated_at, intent_id LIMIT ?`,
          )
          .all(limit) as Array<Record<string, unknown>>,
      ),
    ),
  );
}

export function recordEventLogBlobGcResult(options: RecordEventLogBlobGcResultOptions): void {
  if (!options.intentId.trim()) throw new TypeError("intentId must be a non-empty string");
  if (options.result.status === "failed" && !options.result.error.trim()) {
    throw new TypeError("failed GC result requires a non-empty error");
  }
  withWorkspaceSqliteLease(options.storageRoot, (lease) =>
    lease.transaction("write", () => {
      const now = Date.now();
      const result =
        options.result.status === "completed"
          ? lease.database
              .prepare(
                `UPDATE retention_gc_intents
                 SET status = 'completed', attempt_count = attempt_count + 1,
                     last_error = NULL, updated_at = ?, completed_at = ?
                 WHERE intent_id = ? AND completed_at IS NULL`,
              )
              .run(now, now, options.intentId)
          : lease.database
              .prepare(
                `UPDATE retention_gc_intents
                 SET status = 'failed', attempt_count = attempt_count + 1,
                     last_error = ?, updated_at = ?
                 WHERE intent_id = ? AND completed_at IS NULL`,
              )
              .run(options.result.error, now, options.intentId);
      if (result.changes !== 1) {
        throw new Error(`Blob GC intent ${options.intentId} is missing or already completed`);
      }
    }),
  );
}

export function enforceEventLogRetention(
  options: EnforceEventLogRetentionOptions,
): EventLogRetentionResult {
  const currentSessionId = normalizeCurrentSessionId(options.currentSessionId);
  const policy = options.policy ?? DEFAULT_EVENT_LOG_RETENTION_POLICY;
  return withWorkspaceSqliteLease(options.storageRoot, (lease) => {
    const before = lease.transaction("read", () =>
      readStorageStatusLocked(lease.database, currentSessionId, policy),
    );
    if (before.plan.sessionIdsToDelete.length === 0) {
      return {
        before,
        after: before,
        deletedSessionIds: [],
        skippedSessions: [],
        blobGcIntents: [],
        logicalBytesReclaimed: 0,
        maintenance: { status: "not_needed" },
      };
    }
    options.beforeApply?.();
    const applied = lease.transaction("write", () =>
      applyRetentionPlanLocked(lease.database, before.plan.sessionIdsToDelete, currentSessionId),
    );
    const after = lease.transaction("read", () =>
      readStorageStatusLocked(lease.database, currentSessionId, policy),
    );
    const logicalBytesReclaimed = Math.max(0, before.logicalBytes - after.logicalBytes);
    let maintenance: EventLogRetentionMaintenanceOutcome = { status: "not_needed" };
    if (applied.deletedSessionIds.length > 0) {
      try {
        maintenance = {
          status: "completed",
          result: runIdleSqliteRetentionMaintenance(lease.database, {
            estimatedLogicalBytesReclaimed: logicalBytesReclaimed,
          }),
        };
      } catch (error) {
        maintenance = { status: "failed", error: errorMessage(error) };
      }
    }
    return {
      before,
      after,
      ...applied,
      logicalBytesReclaimed,
      maintenance,
    };
  });
}

function readStorageStatusLocked(
  database: DatabaseSync,
  currentSessionId: string | null,
  policy: EventLogRetentionPolicy,
): EventLogStorageStatus {
  const rows = database
    .prepare(
      `SELECT session_id, archived_at, pinned_at, COALESCE(last_event_at, created_at) AS activity_at
       FROM sessions ORDER BY session_id`,
    )
    .all() as Array<Record<string, unknown>>;
  const breakdowns = new Map<string, MutableBreakdown>();
  for (const row of rows) {
    breakdowns.set(requireString(row["session_id"], "sessions.session_id"), {
      ...EMPTY_BREAKDOWN,
    });
  }

  addGroupedBytes(database, breakdowns, "eventLogBytes", [
    groupedTextQuery("sessions", "session_id", [
      "session_id",
      "work_dir",
      "created_at",
      "last_tx_id",
      "fork_parent_session_id",
      "last_event_at",
      "updated_at",
    ]),
    groupedTextQuery("runtime_events", "session_id", [
      "event_id",
      "session_id",
      "invocation_id",
      "run_id",
      "turn_id",
      "kind",
      "visibility",
      "tx_id",
      "tool_call_id",
      "provider_call_id",
      "operation_id",
      "payload_json",
      "at",
      "committed_at",
    ]),
  ]);
  addGroupedBytes(database, breakdowns, "projectionBytes", [
    groupedTextQuery("session_catalog_projection", "session_id", [
      "session_id",
      "work_dir",
      "created_at",
      "updated_at",
      "activity_at",
      "title",
      "first_message",
      "last_message",
      "last_message_preview",
      "fork_parent_session_id",
      "fork_event_id",
      "fold_json",
    ]),
    groupedTextQuery("session_messages", "session_id", [
      "session_id",
      "event_id",
      "message_id",
      "role",
      "message_ts",
      "payload_json",
    ]),
    groupedTextQuery("runtime_run_projection", "session_id", [
      "session_id",
      "run_id",
      "started_event_id",
      "terminal_event_id",
      "terminal_status",
    ]),
    groupedTextQuery("runtime_owner_fences", "session_id", ["session_id", "updated_at"]),
    groupedTextQuery("runtime_continuation_claims", "source_session_id", [
      "claim_id",
      "source_session_id",
      "source_run_id",
      "source_prefix_digest",
      "target_session_id",
      "target_run_id",
      "created_at",
    ]),
  ]);
  addGroupedBytes(database, breakdowns, "partialBytes", [
    groupedTextQuery("runtime_partial_snapshots", "session_id", [
      "session_id",
      "run_id",
      "partial_id",
      "kind",
      "payload_json",
      "updated_at",
    ]),
    groupedTextQuery("runtime_partial_segments", "session_id", [
      "session_id",
      "run_id",
      "partial_id",
      "payload_json",
      "created_at",
    ]),
  ]);
  addGroupedBytes(database, breakdowns, "toolBytes", [
    groupedTextQuery("runtime_tool_operations", "session_id", [
      "session_id",
      "run_id",
      "tool_call_id",
      "provider_call_id",
      "tool_name",
      "arguments_hash",
      "state",
      "prepared_event_id",
      "outcome_event_id",
      "prepared_at",
      "settled_at",
    ]),
    groupedTextQuery("runtime_tool_journal", "session_id", [
      "session_id",
      "run_id",
      "tool_call_id",
      "phase",
      "event_id",
      "payload_json",
      "created_at",
    ]),
  ]);
  addGroupedBytes(database, breakdowns, "transcriptBytes", [
    groupedTextQuery("runtime_transcript_records", "session_id", [
      "record_id",
      "session_id",
      "source_event_id",
      "kind",
      "payload_json",
      "created_at",
    ]),
    `SELECT records.session_id AS session_id,
            COALESCE(SUM(${textBytes("chunks.record_id")} + ${textBytes("chunks.text_value")}), 0)
              AS logical_bytes
     FROM runtime_transcript_chunks AS chunks
     JOIN runtime_transcript_records AS records ON records.record_id = chunks.record_id
     GROUP BY records.session_id`,
  ]);
  addGroupedBytes(database, breakdowns, "checkpointAndMetadataBytes", [
    groupedTextQuery("runtime_checkpoint_projection", "session_id", [
      "checkpoint_id",
      "session_id",
      "run_id",
      "event_id",
      "through_event_id",
      "source_digest",
      "previous_checkpoint_id",
      "created_at",
    ]),
    groupedTextQuery("runtime_eventlog_metadata", "session_id", [
      "session_id",
      "metadata_key",
      "value_json",
      "updated_at",
    ]),
    groupedTextQuery("runtime_storage_assets", "session_id", [
      "asset_id",
      "session_id",
      "run_id",
      "asset_kind",
      "storage_uri",
      "content_digest",
      "metadata_json",
      "created_at",
    ]),
  ]);
  addGroupedBytes(database, breakdowns, "attachmentManifestBytes", [
    groupedTextQuery("evidence_records", "session_id", [
      "session_id",
      "content_hash",
      "kind",
      "archived_at",
      "content_json",
    ]),
    groupedTextQuery("file_history", "session_id", ["session_id", "state_json", "updated_at"]),
    groupedTextQuery("file_history_snapshots", "session_id", [
      "session_id",
      "message_id",
      "source_message_event_id",
      "user_prompt",
      "timestamp",
      "snapshot_json",
    ]),
  ]);
  const memoryTotals = attributeMemoryBytes(database, breakdowns);
  addGroupedBytes(database, breakdowns, "controlBytes", controlByteQueries());

  const blobRefs = readBlobReferences(database);
  const blobTotals = attributeExclusiveBlobBytes(database, breakdowns, blobRefs);
  const sessions = rows.map((row): EventLogSessionStorageStatus => {
    const sessionId = requireString(row["session_id"], "sessions.session_id");
    const breakdown = breakdowns.get(sessionId)!;
    const hasActiveRun = hasActiveRunLocked(database, sessionId);
    const hasUnfinishedOperation = hasUnfinishedOperationLocked(database, sessionId);
    return {
      sessionId,
      logicalBytes: sumEventLogBreakdown(breakdown),
      archivedAt: optionalNonNegativeInteger(row["archived_at"], "sessions.archived_at"),
      activityAt: requireString(row["activity_at"], "sessions.activity_at"),
      pinned: row["pinned_at"] !== null && row["pinned_at"] !== undefined,
      hasActiveRun,
      hasUnfinishedOperation,
      breakdown: { ...breakdown },
    };
  });
  const sessionLogicalBytes = sessions.reduce(
    (sum, session) => safeAdd(sum, session.logicalBytes, "session logical bytes"),
    0,
  );
  const unattributedControlBytes = readUnattributedControlBytes(database);
  const logicalBytes = safeAdd(
    safeAdd(sessionLogicalBytes, blobTotals.sharedBytes, "workspace logical bytes"),
    unattributedControlBytes,
    "workspace logical bytes",
  );
  return {
    logicalBytes,
    unattributedSharedBlobBytes: blobTotals.sharedBytes,
    unattributedMemoryBytes: memoryTotals.unattributedBytes,
    unattributedControlBytes,
    sessions,
    plan: planEventLogRetention({
      currentLogicalBytes: logicalBytes,
      currentSessionId,
      sessions,
      policy,
    }),
  };
}

function applyRetentionPlanLocked(
  database: DatabaseSync,
  sessionIds: readonly string[],
  currentSessionId: string | null,
): RetentionTransactionResult {
  const deletedSessionIds: string[] = [];
  const skippedSessions: EventLogRetentionSkippedSession[] = [];
  const beforeRefs = readBlobReferences(database);
  for (const sessionId of sessionIds) {
    const reason = retentionSkipReasonLocked(database, sessionId, currentSessionId);
    if (reason) {
      skippedSessions.push({ sessionId, reason });
      continue;
    }
    deleteSessionOwnedRowsLocked(database, sessionId);
    deletedSessionIds.push(sessionId);
  }
  const afterRefs = readBlobReferences(database);
  const newBlobGcIntents = collectOrphanGcIntents(
    database,
    beforeRefs,
    afterRefs,
    new Set(deletedSessionIds),
  );
  const blobGcIntents = persistBlobGcIntentsLocked(database, newBlobGcIntents);
  return { deletedSessionIds, skippedSessions, blobGcIntents };
}

function retentionSkipReasonLocked(
  database: DatabaseSync,
  sessionId: string,
  currentSessionId: string | null,
): EventLogRetentionSkipReason | undefined {
  if (sessionId === currentSessionId) return "current";
  const row = database
    .prepare("SELECT archived_at, pinned_at FROM sessions WHERE session_id = ?")
    .get(sessionId) as { archived_at?: unknown; pinned_at?: unknown } | undefined;
  if (!row) return "missing";
  if (row.archived_at === null || row.archived_at === undefined) return "not_archived";
  if (row.pinned_at !== null && row.pinned_at !== undefined) return "pinned";
  if (hasActiveRunLocked(database, sessionId)) return "active_run";
  if (hasUnfinishedOperationLocked(database, sessionId)) return "unfinished_operation";
  return undefined;
}

function hasActiveRunLocked(database: DatabaseSync, sessionId: string): boolean {
  return (
    database
      .prepare(
        `SELECT 1 FROM runtime_run_projection
         WHERE session_id = ? AND started_event_id IS NOT NULL AND terminal_event_id IS NULL
         LIMIT 1`,
      )
      .get(sessionId) !== undefined
  );
}

function hasUnfinishedOperationLocked(database: DatabaseSync, sessionId: string): boolean {
  const storageOperation = database
    .prepare(
      `SELECT 1 FROM storage_operations
       WHERE (session_id = ? OR target_session_id = ?)
         AND state NOT IN ('completed','aborted') LIMIT 1`,
    )
    .get(sessionId, sessionId);
  if (storageOperation !== undefined) return true;
  const toolOperation = database
    .prepare(
      "SELECT 1 FROM runtime_tool_operations WHERE session_id = ? AND state = 'prepared' LIMIT 1",
    )
    .get(sessionId);
  if (toolOperation !== undefined) return true;
  const job = database
    .prepare(
      `SELECT 1 FROM jobs
       WHERE (owner_session_id = ? OR child_session_id = ?)
         AND status NOT IN (${TERMINAL_JOB_STATUSES.map(() => "?").join(",")}) LIMIT 1`,
    )
    .get(sessionId, sessionId, ...TERMINAL_JOB_STATUSES);
  if (job !== undefined) return true;
  return (
    database
      .prepare(
        `SELECT 1 FROM daemon_runs WHERE session_id = ?
         AND status IN ('running','pause_requested','paused','cancelling') LIMIT 1`,
      )
      .get(sessionId) !== undefined
  );
}

function deleteSessionOwnedRowsLocked(database: DatabaseSync, sessionId: string): void {
  invalidateSessionMemoryRowsLocked(database, sessionId);

  const claimKeys = database
    .prepare(
      "SELECT workspace_path, idempotency_key FROM desktop_first_send_claims WHERE session_id = ?",
    )
    .all(sessionId) as Array<Record<string, unknown>>;
  for (const row of claimKeys) {
    database
      .prepare("DELETE FROM desktop_idempotency WHERE workspace_path = ? AND idempotency_key = ?")
      .run(
        requireString(row["workspace_path"], "desktop_first_send_claims.workspace_path"),
        requireString(row["idempotency_key"], "desktop_first_send_claims.idempotency_key"),
      );
  }
  database
    .prepare(
      `DELETE FROM desktop_idempotency
       WHERE json_valid(result_json) AND json_extract(result_json, '$.sessionId') = ?`,
    )
    .run(sessionId);
  database.prepare("DELETE FROM desktop_input_queue WHERE session_id = ?").run(sessionId);
  database.prepare("DELETE FROM desktop_first_send_claims WHERE session_id = ?").run(sessionId);

  // Job/Attempt/command/outbox/merge rows belong to the independent control
  // ledger. Retention may detach their weak Session pointers after terminal,
  // but must not erase those facts just because the referenced Session expires.
  database
    .prepare(
      `UPDATE jobs SET
         owner_session_id = CASE WHEN owner_session_id = ? THEN NULL ELSE owner_session_id END,
         child_session_id = CASE WHEN child_session_id = ? THEN NULL ELSE child_session_id END
       WHERE owner_session_id = ? OR child_session_id = ?`,
    )
    .run(sessionId, sessionId, sessionId, sessionId);
  database
    .prepare("UPDATE daemon_runs SET session_id = NULL, checkpoint_id = NULL WHERE session_id = ?")
    .run(sessionId);
  database
    .prepare(
      "UPDATE usage_provider_calls SET session_id = NULL, conversation_id = NULL WHERE session_id = ?",
    )
    .run(sessionId);
  database
    .prepare("UPDATE usage_baselines SET session_id = NULL WHERE session_id = ?")
    .run(sessionId);
  database
    .prepare("DELETE FROM storage_operations WHERE session_id = ? OR target_session_id = ?")
    .run(sessionId, sessionId);
  database
    .prepare("DELETE FROM runtime_continuation_claims WHERE target_session_id = ?")
    .run(sessionId);

  database.prepare("DELETE FROM evidence_records WHERE session_id = ?").run(sessionId);
  database.prepare("DELETE FROM file_history_snapshots WHERE session_id = ?").run(sessionId);
  database.prepare("DELETE FROM file_history WHERE session_id = ?").run(sessionId);
  // runtime_events is the one sessions child whose original schema predates ON DELETE CASCADE.
  database.prepare("DELETE FROM runtime_events WHERE session_id = ?").run(sessionId);
  const deleted = database.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  if (deleted.changes !== 1) {
    throw new Error(`Retention lost session ${sessionId} during its write transaction`);
  }
}

function invalidateSessionMemoryRowsLocked(database: DatabaseSync, sessionId: string): void {
  const at = new Date().toISOString();
  let changes = 0;

  const sourceTargets = `session_id = ? AND availability = 'available'`;
  recordBulkMemoryMutationsLocked(
    database,
    "memory_sources",
    "source_id",
    "source",
    "source.updated",
    sourceTargets,
    [sessionId],
    at,
  );
  changes += sqliteChangeCount(
    database
      .prepare(
        `UPDATE memory_sources
         SET availability = 'unavailable', invalidated_at = ?, invalidation_code = 'session_deleted',
             version = version + 1, updated_at = ?
         WHERE ${sourceTargets}`,
      )
      .run(at, at, sessionId).changes,
  );

  const proposalTargets = `source_id IN (
    SELECT source_id FROM memory_sources WHERE session_id = ?
  ) AND status <> 'deleted'`;
  recordBulkMemoryMutationsLocked(
    database,
    "memory_proposals",
    "proposal_id",
    "proposal",
    "proposal.deleted",
    proposalTargets,
    [sessionId],
    at,
  );
  changes += sqliteChangeCount(
    database
      .prepare(
        `UPDATE memory_proposals
         SET title = NULL, content = NULL, reason = NULL, status = 'deleted',
             version = version + 1, updated_at = ?, deleted_at = ?
         WHERE ${proposalTargets}`,
      )
      .run(at, at, sessionId).changes,
  );

  // A job with an explicit Source is owned by that Source. Source-less extraction
  // and lifecycle jobs may instead point at the Session or one of its Memory entities.
  const jobTargets = `status IN ('queued','running','failed') AND (
    source_id IN (SELECT source_id FROM memory_sources WHERE session_id = ?)
    OR (source_id IS NULL AND (
      json_extract(cursor_json, '$.sessionId') = ?
      OR json_extract(cursor_json, '$.eventId') IN (
        SELECT source_id FROM memory_sources WHERE session_id = ?
      )
      OR json_extract(cursor_json, '$.eventId') IN (
        SELECT fact_id FROM memory_facts WHERE source_id IN (
          SELECT source_id FROM memory_sources WHERE session_id = ?
        )
      )
      OR json_extract(cursor_json, '$.eventId') IN (
        SELECT proposal_id FROM memory_proposals WHERE source_id IN (
          SELECT source_id FROM memory_sources WHERE session_id = ?
        )
      )
    ))
  )`;
  const jobTargetParams = [sessionId, sessionId, sessionId, sessionId, sessionId] as const;
  recordBulkMemoryMutationsLocked(
    database,
    "memory_jobs",
    "job_id",
    "job",
    "job.updated",
    jobTargets,
    jobTargetParams,
    at,
  );
  changes += sqliteChangeCount(
    database
      .prepare(
        `UPDATE memory_jobs
         SET status = 'cancelled', next_attempt_at = NULL,
             error_code = 'memory_source_unavailable', version = version + 1,
             updated_at = ?, terminal_at = ?
         WHERE ${jobTargets}`,
      )
      .run(at, at, ...jobTargetParams).changes,
  );

  if (changes > 0) bumpMemoryRevisionLocked(database);
}

function recordBulkMemoryMutationsLocked(
  database: DatabaseSync,
  table: "memory_sources" | "memory_proposals" | "memory_jobs",
  idColumn: "source_id" | "proposal_id" | "job_id",
  entityType: "source" | "proposal" | "job",
  action: "source.updated" | "proposal.deleted" | "job.updated",
  where: string,
  parameters: readonly string[],
  at: string,
): void {
  database
    .prepare(
      `WITH mutation_base AS (
         SELECT COALESCE(MAX(sequence), 0) AS base_sequence FROM memory_mutations
       ), targets AS (
         SELECT ${idColumn} AS entity_id, version,
                ROW_NUMBER() OVER (ORDER BY ${idColumn}) AS offset
         FROM ${table} WHERE ${where}
       )
       INSERT INTO memory_mutations (
         sequence, mutation_id, entity_type, entity_id, action, from_version, to_version,
         idempotency_key_hash, created_at
       )
       SELECT mutation_base.base_sequence + targets.offset,
              'mutation:' || lower(hex(randomblob(16))), ?, targets.entity_id, ?,
              targets.version, targets.version + 1, NULL, ?
       FROM targets CROSS JOIN mutation_base`,
    )
    .run(...parameters, entityType, action, at);
}

function bumpMemoryRevisionLocked(database: DatabaseSync): void {
  const row = database
    .prepare("SELECT value_json FROM memory_metadata WHERE key = 'revision'")
    .get() as Record<string, unknown> | undefined;
  if (!row) throw new Error("memory_metadata.revision is missing during EventLog retention");
  const revision = parseJson(row["value_json"], "memory_metadata.revision");
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("memory_metadata.revision is invalid during EventLog retention");
  }
  database
    .prepare("UPDATE memory_metadata SET value_json = ? WHERE key = 'revision'")
    .run(JSON.stringify(safeAdd(revision, 1, "memory revision")));
}

function collectOrphanGcIntents(
  database: DatabaseSync,
  before: BlobReferenceSnapshot,
  after: BlobReferenceSnapshot,
  deletedSessionIds: ReadonlySet<string>,
): NewBlobGcIntent[] {
  const intents: NewBlobGcIntent[] = [];
  for (const kind of ["evidence", "fileHistory", "runtimeAsset"] as const) {
    const survivors = new Set(after[kind].map(({ digest }) => digest));
    const candidates = new Map<string, number>();
    for (const reference of before[kind]) {
      if (deletedSessionIds.has(reference.sessionId)) {
        candidates.set(
          reference.digest,
          Math.max(candidates.get(reference.digest) ?? 0, reference.byteLength),
        );
      }
    }
    for (const [digest, byteLength] of candidates) {
      if (survivors.has(digest)) continue;
      if (kind === "evidence") {
        const row = database
          .prepare("SELECT size_bytes FROM evidence_blobs WHERE digest = ?")
          .get(digest) as { size_bytes?: unknown } | undefined;
        if (!row) continue;
        database.prepare("DELETE FROM evidence_blobs WHERE digest = ?").run(digest);
        intents.push({
          kind: "evidence",
          digest,
          byteLength: requireNonNegativeInteger(row.size_bytes, "evidence_blobs.size_bytes"),
        });
      } else {
        intents.push({
          kind: kind === "fileHistory" ? "file_history" : "runtime_asset",
          digest,
          byteLength,
        });
      }
    }
  }
  return intents.toSorted(
    (left, right) => left.kind.localeCompare(right.kind) || left.digest.localeCompare(right.digest),
  );
}

function persistBlobGcIntentsLocked(
  database: DatabaseSync,
  intents: readonly NewBlobGcIntent[],
): EventLogBlobGcIntent[] {
  const persisted: EventLogBlobGcIntent[] = [];
  for (const intent of intents) {
    const existing = database
      .prepare(
        `SELECT intent_id, blob_kind, digest, byte_length, status,
                attempt_count, last_error, created_at, updated_at
         FROM retention_gc_intents
         WHERE blob_kind = ? AND digest = ? AND completed_at IS NULL`,
      )
      .get(intent.kind, intent.digest) as Record<string, unknown> | undefined;
    if (existing) {
      const intentId = requireString(existing["intent_id"], "retention_gc_intents.intent_id");
      if (
        requireNonNegativeInteger(existing["byte_length"], "retention_gc_intents.byte_length") <
        intent.byteLength
      ) {
        database
          .prepare(
            "UPDATE retention_gc_intents SET byte_length = ?, updated_at = ? WHERE intent_id = ?",
          )
          .run(intent.byteLength, Date.now(), intentId);
        const updated = database
          .prepare(
            `SELECT intent_id, blob_kind, digest, byte_length, status,
                    attempt_count, last_error, created_at, updated_at
             FROM retention_gc_intents WHERE intent_id = ?`,
          )
          .get(intentId) as Record<string, unknown>;
        persisted.push(...readBlobGcIntentRows([updated]));
      } else {
        persisted.push(...readBlobGcIntentRows([existing]));
      }
      continue;
    }
    const now = Date.now();
    const inserted = database
      .prepare(
        `INSERT INTO retention_gc_intents (
           intent_id, blob_kind, digest, byte_length, status,
           attempt_count, last_error, created_at, updated_at, completed_at
         ) VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'pending', 0, NULL, ?, ?, NULL)
         RETURNING intent_id, blob_kind, digest, byte_length, status,
                   attempt_count, last_error, created_at, updated_at`,
      )
      .get(intent.kind, intent.digest, intent.byteLength, now, now) as Record<string, unknown>;
    persisted.push(...readBlobGcIntentRows([inserted]));
  }
  return persisted.toSorted(
    (left, right) => left.kind.localeCompare(right.kind) || left.digest.localeCompare(right.digest),
  );
}

function readBlobGcIntentRows(rows: readonly Record<string, unknown>[]): EventLogBlobGcIntent[] {
  return rows.map((row) => {
    const status = requireString(row["status"], "retention_gc_intents.status");
    if (status !== "pending" && status !== "failed") {
      throw new Error(`retention_gc_intents.status ${status} is not consumable`);
    }
    const lastError = row["last_error"];
    if (lastError !== null && lastError !== undefined && typeof lastError !== "string") {
      throw new Error("retention_gc_intents.last_error is invalid");
    }
    return {
      intentId: requireString(row["intent_id"], "retention_gc_intents.intent_id"),
      kind: requireBlobGcKind(row["blob_kind"]),
      digest: requireDigest(row["digest"], "retention_gc_intents.digest"),
      byteLength: requireNonNegativeInteger(row["byte_length"], "retention_gc_intents.byte_length"),
      status,
      attemptCount: requireNonNegativeInteger(
        row["attempt_count"],
        "retention_gc_intents.attempt_count",
      ),
      lastError: lastError ?? null,
      createdAt: requireNonNegativeInteger(row["created_at"], "retention_gc_intents.created_at"),
      updatedAt: requireNonNegativeInteger(row["updated_at"], "retention_gc_intents.updated_at"),
    };
  });
}

function readUnattributedControlBytes(database: DatabaseSync): number {
  const queries = [
    unattributedTextQuery(
      "jobs",
      [
        "job_id",
        "type",
        "status",
        "execution_class",
        "completion_policy",
        "description",
        "tool_use_id",
        "output_path",
        "data_json",
        "error",
      ],
      "owner_session_id IS NULL AND child_session_id IS NULL",
    ),
    unattributedJobChildTextQuery("job_attempts", [
      "attempt_id",
      "job_id",
      "status",
      "owner_id",
      "output_path",
      "error",
      "result_json",
    ]),
    unattributedJobChildTextQuery("job_commands", ["command_id", "job_id", "kind", "payload_json"]),
    unattributedJobChildTextQuery("completion_outbox", [
      "completion_id",
      "job_id",
      "attempt_id",
      "policy",
      "status",
      "payload_json",
    ]),
    unattributedJobChildTextQuery("merge_requests", [
      "merge_request_id",
      "job_id",
      "attempt_id",
      "source_branch",
      "source_worktree",
      "target_branch",
      "target_worktree",
      "source_head",
      "status",
      "error",
    ]),
    unattributedTextQuery(
      "daemon_runs",
      [
        "run_id",
        "workspace_path",
        "checkpoint_id",
        "description",
        "status",
        "result_json",
        "error",
      ],
      "session_id IS NULL",
    ),
    unattributedTextQuery(
      "usage_provider_calls",
      [
        "call_id",
        "tx_id",
        "conversation_id",
        "goal_id",
        "job_id",
        "attempt_id",
        "purpose",
        "provider",
        "model",
        "route",
        "status",
        "reported_json",
      ],
      "session_id IS NULL",
    ),
    unattributedTextQuery(
      "usage_baselines",
      ["baseline_id", "goal_id", "source_json"],
      "session_id IS NULL",
    ),
    unattributedTextQuery("retention_gc_intents", [
      "intent_id",
      "blob_kind",
      "digest",
      "status",
      "last_error",
    ]),
  ];
  return queries.reduce((total, query) => {
    const row = database.prepare(query).get() as Record<string, unknown>;
    return safeAdd(
      total,
      requireNonNegativeInteger(row["logical_bytes"], "unattributed control logical_bytes"),
      "unattributed control bytes",
    );
  }, 0);
}

/**
 * Memory is a mixed workspace/session ledger. Rows reachable from a Source are
 * attributed to that Source's Session exactly once for observation; settings and
 * source-less manual overlays remain workspace-level observations. Neither group
 * contributes to EventLog admission or reclaim accounting.
 * SQLite performs the ownership joins and aggregation; Node receives at most one
 * row per Session plus one unattributed row, never the memory bodies themselves.
 */
function attributeMemoryBytes(
  database: DatabaseSync,
  breakdowns: Map<string, MutableBreakdown>,
): { readonly unattributedBytes: number } {
  assertMemoryAccountingRowsValid(database);
  const rows = database.prepare(memoryByteAggregationQuery()).all() as Array<
    Record<string, unknown>
  >;
  let unattributedBytes = 0;
  for (const row of rows) {
    const rawSessionId = row["session_id"];
    const sessionId =
      rawSessionId === null || rawSessionId === undefined
        ? null
        : requireString(rawSessionId, "memory logical_bytes.session_id");
    const bytes = requireNonNegativeInteger(row["logical_bytes"], "memory logical_bytes");
    const breakdown = sessionId === null ? undefined : breakdowns.get(sessionId);
    if (!breakdown) {
      unattributedBytes = safeAdd(unattributedBytes, bytes, "unattributed memory bytes");
      continue;
    }
    breakdown.memoryBytes = safeAdd(breakdown.memoryBytes, bytes, "breakdown.memoryBytes");
  }
  return { unattributedBytes };
}

function assertMemoryAccountingRowsValid(database: DatabaseSync): void {
  const invalidJob = database
    .prepare(
      `SELECT job_id FROM memory_jobs
       WHERE CASE WHEN json_valid(cursor_json) THEN
         json_type(cursor_json) <> 'object'
         OR typeof(json_extract(cursor_json, '$.sessionId')) <> 'text'
         OR length(json_extract(cursor_json, '$.sessionId')) = 0
         OR typeof(json_extract(cursor_json, '$.eventId')) <> 'text'
         OR length(json_extract(cursor_json, '$.eventId')) = 0
       ELSE 1 END
       LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  if (invalidJob) {
    throw new Error(
      `memory_jobs[${requireString(invalidJob["job_id"], "memory_jobs.job_id")}].cursor_json is invalid`,
    );
  }
  const invalidMarker = database
    .prepare(
      `SELECT operation_key FROM memory_idempotency
       WHERE CASE WHEN json_valid(marker_json)
         THEN json_type(marker_json) <> 'object'
         ELSE 1
       END
       LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  if (invalidMarker) {
    throw new Error(
      `memory_idempotency[${requireString(
        invalidMarker["operation_key"],
        "memory_idempotency.operation_key",
      )}].marker_json is invalid`,
    );
  }
}

function memoryByteAggregationQuery(): string {
  return `
    WITH
    source_owners AS (
      SELECT source.source_id,
             CASE WHEN session.session_id IS NULL THEN NULL ELSE source.session_id END
               AS owner_session_id
      FROM memory_sources AS source
      LEFT JOIN sessions AS session ON session.session_id = source.session_id
    ),
    fact_owners AS (
      SELECT fact.fact_id, source_owner.owner_session_id
      FROM memory_facts AS fact
      LEFT JOIN source_owners AS source_owner ON source_owner.source_id = fact.source_id
    ),
    proposal_owners AS (
      SELECT proposal.proposal_id, source_owner.owner_session_id
      FROM memory_proposals AS proposal
      LEFT JOIN source_owners AS source_owner ON source_owner.source_id = proposal.source_id
    ),
    job_owners AS (
      SELECT job.job_id,
             CASE WHEN job.source_id IS NOT NULL
               THEN source_owner.owner_session_id
               ELSE COALESCE(
                 cursor_session.session_id,
                 source_event.owner_session_id,
                 fact_event.owner_session_id,
                 proposal_event.owner_session_id
               )
             END AS owner_session_id
      FROM memory_jobs AS job
      LEFT JOIN source_owners AS source_owner ON source_owner.source_id = job.source_id
      LEFT JOIN sessions AS cursor_session
        ON cursor_session.session_id = json_extract(job.cursor_json, '$.sessionId')
      LEFT JOIN source_owners AS source_event
        ON source_event.source_id = json_extract(job.cursor_json, '$.eventId')
      LEFT JOIN fact_owners AS fact_event
        ON fact_event.fact_id = json_extract(job.cursor_json, '$.eventId')
      LEFT JOIN proposal_owners AS proposal_event
        ON proposal_event.proposal_id = json_extract(job.cursor_json, '$.eventId')
    ),
    mutation_owners AS (
      SELECT mutation.sequence,
             CASE mutation.entity_type
               WHEN 'source' THEN source_owner.owner_session_id
               WHEN 'fact' THEN fact_owner.owner_session_id
               WHEN 'proposal' THEN proposal_owner.owner_session_id
               WHEN 'job' THEN job_owner.owner_session_id
               ELSE NULL
             END AS owner_session_id
      FROM memory_mutations AS mutation
      LEFT JOIN source_owners AS source_owner
        ON mutation.entity_type = 'source' AND source_owner.source_id = mutation.entity_id
      LEFT JOIN fact_owners AS fact_owner
        ON mutation.entity_type = 'fact' AND fact_owner.fact_id = mutation.entity_id
      LEFT JOIN proposal_owners AS proposal_owner
        ON mutation.entity_type = 'proposal' AND proposal_owner.proposal_id = mutation.entity_id
      LEFT JOIN job_owners AS job_owner
        ON mutation.entity_type = 'job' AND job_owner.job_id = mutation.entity_id
    ),
    marker_candidates AS (
      SELECT replay.operation_key, source_owner.owner_session_id
      FROM memory_idempotency AS replay
      JOIN source_owners AS source_owner
        ON source_owner.source_id = json_extract(replay.marker_json, '$.sourceId')
      WHERE source_owner.owner_session_id IS NOT NULL
      UNION ALL
      SELECT replay.operation_key, fact_owner.owner_session_id
      FROM memory_idempotency AS replay
      JOIN fact_owners AS fact_owner
        ON fact_owner.fact_id = json_extract(replay.marker_json, '$.factId')
      WHERE fact_owner.owner_session_id IS NOT NULL
      UNION ALL
      SELECT replay.operation_key, proposal_owner.owner_session_id
      FROM memory_idempotency AS replay
      JOIN proposal_owners AS proposal_owner
        ON proposal_owner.proposal_id = json_extract(replay.marker_json, '$.proposalId')
      WHERE proposal_owner.owner_session_id IS NOT NULL
      UNION ALL
      SELECT replay.operation_key, job_owner.owner_session_id
      FROM memory_idempotency AS replay
      JOIN job_owners AS job_owner
        ON job_owner.job_id = json_extract(replay.marker_json, '$.jobId')
      WHERE job_owner.owner_session_id IS NOT NULL
    ),
    marker_owners AS (
      SELECT operation_key,
             CASE WHEN COUNT(DISTINCT owner_session_id) = 1
               THEN MIN(owner_session_id)
               ELSE NULL
             END AS owner_session_id
      FROM marker_candidates
      GROUP BY operation_key
    ),
    memory_rows AS (
      SELECT NULL AS owner_session_id,
             ${memoryTextBytes("metadata", ["key", "value_json"])} AS logical_bytes
      FROM memory_metadata AS metadata
      UNION ALL
      SELECT owner.owner_session_id,
             ${memoryTextBytes("source", [
               "source_id",
               "session_id",
               "run_id",
               "branch_id",
               "event_ids_json",
               "digest",
               "evidence_ref_json",
               "availability",
               "extraction_suppressed_at",
               "invalidated_at",
               "invalidation_code",
               "created_at",
               "updated_at",
             ])} AS logical_bytes
      FROM memory_sources AS source
      JOIN source_owners AS owner ON owner.source_id = source.source_id
      UNION ALL
      SELECT owner.owner_session_id,
             ${memoryTextBytes("fact", [
               "fact_id",
               "kind",
               "title",
               "content",
               "source_id",
               "state",
               "expires_at",
               "last_used_at",
               "created_at",
               "updated_at",
               "forgotten_at",
             ])} AS logical_bytes
      FROM memory_facts AS fact
      JOIN fact_owners AS owner ON owner.fact_id = fact.fact_id
      UNION ALL
      SELECT owner.owner_session_id,
             ${memoryTextBytes("proposal", [
               "proposal_id",
               "kind",
               "title",
               "content",
               "reason",
               "source_id",
               "status",
               "conflict_status",
               "conflict_fact_id",
               "resolved_fact_id",
               "created_at",
               "updated_at",
               "reviewed_at",
               "deleted_at",
             ])} AS logical_bytes
      FROM memory_proposals AS proposal
      JOIN proposal_owners AS owner ON owner.proposal_id = proposal.proposal_id
      UNION ALL
      SELECT owner.owner_session_id,
             ${memoryTextBytes("job", [
               "job_id",
               "type",
               "status",
               "terminal_event_id",
               "extractor_version",
               "cursor_json",
               "source_id",
               "next_attempt_at",
               "error_code",
               "created_at",
               "updated_at",
               "terminal_at",
             ])} AS logical_bytes
      FROM memory_jobs AS job
      JOIN job_owners AS owner ON owner.job_id = job.job_id
      UNION ALL
      SELECT owner.owner_session_id,
             ${memoryTextBytes("mutation", [
               "mutation_id",
               "entity_type",
               "entity_id",
               "action",
               "idempotency_key_hash",
               "created_at",
             ])} AS logical_bytes
      FROM memory_mutations AS mutation
      JOIN mutation_owners AS owner ON owner.sequence = mutation.sequence
      UNION ALL
      SELECT owner.owner_session_id,
             ${memoryTextBytes("replay", [
               "operation_key",
               "request_hash",
               "marker_json",
               "created_at",
             ])} AS logical_bytes
      FROM memory_idempotency AS replay
      LEFT JOIN marker_owners AS owner ON owner.operation_key = replay.operation_key
    )
    SELECT owner_session_id AS session_id,
           COALESCE(SUM(logical_bytes), 0) AS logical_bytes
    FROM memory_rows
    GROUP BY owner_session_id`;
}

function memoryTextBytes(alias: string, columns: readonly string[]): string {
  return columns.map((column) => textBytes(`${alias}.${column}`)).join(" + ");
}

function unattributedTextQuery(table: string, columns: readonly string[], where?: string): string {
  return `SELECT COALESCE(SUM(${columns.map(textBytes).join(" + ")}), 0) AS logical_bytes
          FROM ${table}${where ? ` WHERE ${where}` : ""}`;
}

function unattributedJobChildTextQuery(table: string, columns: readonly string[]): string {
  return `SELECT COALESCE(SUM(${columns
    .map((column) => textBytes(`${table}.${column}`))
    .join(" + ")}), 0) AS logical_bytes
          FROM ${table} JOIN jobs ON jobs.job_id = ${table}.job_id
          WHERE jobs.owner_session_id IS NULL AND jobs.child_session_id IS NULL`;
}

function readBlobReferences(database: DatabaseSync): BlobReferenceSnapshot {
  return {
    evidence: readEvidenceReferences(database),
    fileHistory: readFileHistoryReferences(database),
    runtimeAsset: readRuntimeAssetReferences(database),
  };
}

function readEvidenceReferences(database: DatabaseSync): BlobReference[] {
  const blobSizes = new Map(
    (
      database.prepare("SELECT digest, size_bytes FROM evidence_blobs").all() as Array<
        Record<string, unknown>
      >
    ).map((row) => [
      requireDigest(row["digest"], "evidence_blobs.digest"),
      requireNonNegativeInteger(row["size_bytes"], "evidence_blobs.size_bytes"),
    ]),
  );
  const rows = database
    .prepare("SELECT session_id, content_json FROM evidence_records")
    .all() as Array<Record<string, unknown>>;
  return rows.flatMap((row) =>
    extractBlobReferences(
      requireString(row["session_id"], "evidence_records.session_id"),
      parseJson(row["content_json"], "evidence_records.content_json"),
    ).map((reference) => ({
      ...reference,
      byteLength: blobSizes.get(reference.digest) ?? reference.byteLength,
    })),
  );
}

function readFileHistoryReferences(database: DatabaseSync): BlobReference[] {
  const references: BlobReference[] = [];
  const headers = database
    .prepare("SELECT session_id, state_json FROM file_history")
    .all() as Array<Record<string, unknown>>;
  for (const row of headers) {
    references.push(
      ...extractBlobReferences(
        requireString(row["session_id"], "file_history.session_id"),
        parseJson(row["state_json"], "file_history.state_json"),
      ),
    );
  }
  const snapshots = database
    .prepare("SELECT session_id, snapshot_json FROM file_history_snapshots")
    .all() as Array<Record<string, unknown>>;
  for (const row of snapshots) {
    references.push(
      ...extractBlobReferences(
        requireString(row["session_id"], "file_history_snapshots.session_id"),
        parseJson(row["snapshot_json"], "file_history_snapshots.snapshot_json"),
      ),
    );
  }
  return references;
}

function readRuntimeAssetReferences(database: DatabaseSync): BlobReference[] {
  return (
    database
      .prepare("SELECT session_id, content_digest, byte_length FROM runtime_storage_assets")
      .all() as Array<Record<string, unknown>>
  ).map((row) => ({
    sessionId: requireString(row["session_id"], "runtime_storage_assets.session_id"),
    digest: requireDigest(row["content_digest"], "runtime_storage_assets.content_digest"),
    byteLength: requireNonNegativeInteger(row["byte_length"], "runtime_storage_assets.byte_length"),
  }));
}

function extractBlobReferences(sessionId: string, value: unknown): BlobReference[] {
  const references: BlobReference[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isRecord(candidate)) return;
    if (
      candidate["algorithm"] === "sha256" &&
      typeof candidate["digest"] === "string" &&
      /^[a-f0-9]{64}$/u.test(candidate["digest"]) &&
      typeof candidate["sizeBytes"] === "number" &&
      Number.isSafeInteger(candidate["sizeBytes"]) &&
      candidate["sizeBytes"] >= 0
    ) {
      references.push({
        sessionId,
        digest: candidate["digest"],
        byteLength: candidate["sizeBytes"],
      });
    }
    Object.values(candidate).forEach(visit);
  };
  visit(value);
  return references;
}

function attributeExclusiveBlobBytes(
  database: DatabaseSync,
  breakdowns: Map<string, MutableBreakdown>,
  snapshots: BlobReferenceSnapshot,
): { readonly sharedBytes: number } {
  let sharedBytes = 0;
  for (const references of [snapshots.evidence, snapshots.fileHistory, snapshots.runtimeAsset]) {
    const byDigest = new Map<string, { byteLength: number; sessionIds: Set<string> }>();
    for (const reference of references) {
      const entry = byDigest.get(reference.digest) ?? {
        byteLength: reference.byteLength,
        sessionIds: new Set<string>(),
      };
      entry.byteLength = Math.max(entry.byteLength, reference.byteLength);
      entry.sessionIds.add(reference.sessionId);
      byDigest.set(reference.digest, entry);
    }
    for (const { byteLength, sessionIds } of byDigest.values()) {
      if (sessionIds.size === 1) {
        const sessionId = [...sessionIds][0]!;
        const breakdown = breakdowns.get(sessionId);
        if (breakdown) {
          breakdown.exclusiveBlobBytes = safeAdd(
            breakdown.exclusiveBlobBytes,
            byteLength,
            "exclusive blob bytes",
          );
          continue;
        }
      }
      sharedBytes = safeAdd(sharedBytes, byteLength, "shared blob bytes");
    }
  }
  const referencedEvidenceDigests = new Set(snapshots.evidence.map(({ digest }) => digest));
  const evidenceRows = database
    .prepare("SELECT digest, size_bytes FROM evidence_blobs")
    .all() as Array<Record<string, unknown>>;
  for (const row of evidenceRows) {
    const digest = requireDigest(row["digest"], "evidence_blobs.digest");
    if (referencedEvidenceDigests.has(digest)) continue;
    sharedBytes = safeAdd(
      sharedBytes,
      requireNonNegativeInteger(row["size_bytes"], "evidence_blobs.size_bytes"),
      "orphan evidence blob bytes",
    );
  }
  return { sharedBytes };
}

function addGroupedBytes(
  database: DatabaseSync,
  breakdowns: Map<string, MutableBreakdown>,
  field: keyof MutableBreakdown,
  queries: readonly string[],
): void {
  for (const query of queries) {
    const rows = database.prepare(query).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const rawSessionId = row["session_id"];
      // Independent control facts survive Session retention with their weak
      // reference cleared. Their bytes become workspace-level unattributed
      // control overhead and must not make the status decoder fail.
      if (rawSessionId === null || rawSessionId === undefined) continue;
      const sessionId = requireString(rawSessionId, "logical_bytes.session_id");
      const breakdown = breakdowns.get(sessionId);
      if (!breakdown) continue;
      breakdown[field] = safeAdd(
        breakdown[field],
        requireNonNegativeInteger(row["logical_bytes"], "logical_bytes"),
        `breakdown.${field}`,
      );
    }
  }
}

function groupedTextQuery(
  table: string,
  sessionColumn: string,
  columns: readonly string[],
): string {
  return `SELECT ${sessionColumn} AS session_id,
                 COALESCE(SUM(${columns.map(textBytes).join(" + ")}), 0) AS logical_bytes
          FROM ${table} GROUP BY ${sessionColumn}`;
}

function controlByteQueries(): readonly string[] {
  return [
    groupedTextQuery("desktop_input_queue", "session_id", [
      "queue_id",
      "workspace_path",
      "session_id",
      "input_json",
    ]),
    groupedTextQuery("desktop_first_send_claims", "session_id", [
      "workspace_path",
      "idempotency_key",
      "session_id",
      "request_fingerprint",
    ]),
    `SELECT claims.session_id AS session_id,
            COALESCE(SUM(${[
              "idempotency.workspace_path",
              "idempotency.idempotency_key",
              "idempotency.request_fingerprint",
              "idempotency.result_json",
            ]
              .map(textBytes)
              .join(" + ")}), 0) AS logical_bytes
     FROM desktop_idempotency AS idempotency
     JOIN desktop_first_send_claims AS claims
       ON claims.workspace_path = idempotency.workspace_path
      AND claims.idempotency_key = idempotency.idempotency_key
     GROUP BY claims.session_id`,
    `SELECT json_extract(idempotency.result_json, '$.sessionId') AS session_id,
            COALESCE(SUM(${[
              "idempotency.workspace_path",
              "idempotency.idempotency_key",
              "idempotency.request_fingerprint",
              "idempotency.result_json",
            ]
              .map(textBytes)
              .join(" + ")}), 0) AS logical_bytes
     FROM desktop_idempotency AS idempotency
     WHERE json_valid(idempotency.result_json)
       AND typeof(json_extract(idempotency.result_json, '$.sessionId')) = 'text'
       AND NOT EXISTS (
         SELECT 1 FROM desktop_first_send_claims AS claims
         WHERE claims.workspace_path = idempotency.workspace_path
           AND claims.idempotency_key = idempotency.idempotency_key
       )
     GROUP BY json_extract(idempotency.result_json, '$.sessionId')`,
    groupedTextQuery("daemon_runs", "session_id", [
      "run_id",
      "workspace_path",
      "session_id",
      "checkpoint_id",
      "description",
      "status",
      "result_json",
      "error",
    ]),
    groupedTextQuery("usage_provider_calls", "session_id", [
      "call_id",
      "tx_id",
      "session_id",
      "conversation_id",
      "goal_id",
      "job_id",
      "attempt_id",
      "purpose",
      "provider",
      "model",
      "route",
      "status",
      "reported_json",
    ]),
    groupedTextQuery("usage_baselines", "session_id", [
      "baseline_id",
      "session_id",
      "goal_id",
      "source_json",
    ]),
    groupedTextQuery("storage_operations", "session_id", [
      "operation_id",
      "kind",
      "state",
      "session_id",
      "target_session_id",
      "operation_json",
      "created_at",
      "updated_at",
    ]),
    `SELECT COALESCE(owner_session_id, child_session_id) AS session_id,
            COALESCE(SUM(${[
              "job_id",
              "type",
              "status",
              "execution_class",
              "completion_policy",
              "description",
              "owner_session_id",
              "child_session_id",
              "tool_use_id",
              "output_path",
              "data_json",
              "error",
            ]
              .map(textBytes)
              .join(" + ")}), 0) AS logical_bytes
     FROM jobs
     WHERE COALESCE(owner_session_id, child_session_id) IS NOT NULL
     GROUP BY COALESCE(owner_session_id, child_session_id)`,
    jobChildTextQuery("job_attempts", [
      "attempt_id",
      "job_id",
      "status",
      "owner_id",
      "output_path",
      "error",
      "result_json",
    ]),
    jobChildTextQuery("job_commands", ["command_id", "job_id", "kind", "payload_json"]),
    jobChildTextQuery("completion_outbox", [
      "completion_id",
      "job_id",
      "attempt_id",
      "policy",
      "status",
      "payload_json",
    ]),
    jobChildTextQuery("merge_requests", [
      "merge_request_id",
      "job_id",
      "attempt_id",
      "source_branch",
      "source_worktree",
      "target_branch",
      "target_worktree",
      "source_head",
      "status",
      "error",
    ]),
  ];
}

function jobChildTextQuery(table: string, columns: readonly string[]): string {
  return `SELECT COALESCE(jobs.owner_session_id, jobs.child_session_id) AS session_id,
                 COALESCE(SUM(${columns.map((column) => textBytes(`${table}.${column}`)).join(" + ")}), 0)
                   AS logical_bytes
          FROM ${table} JOIN jobs ON jobs.job_id = ${table}.job_id
          WHERE COALESCE(jobs.owner_session_id, jobs.child_session_id) IS NOT NULL
          GROUP BY COALESCE(jobs.owner_session_id, jobs.child_session_id)`;
}

function textBytes(column: string): string {
  return `length(CAST(COALESCE(${column}, '') AS BLOB))`;
}

function sumEventLogBreakdown(value: MutableBreakdown): number {
  return Object.entries(value).reduce(
    (sum, [kind, bytes]) =>
      kind === "memoryBytes" ? sum : safeAdd(sum, bytes, "session breakdown"),
    0,
  );
}

function normalizeCurrentSessionId(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!value.trim()) throw new TypeError("currentSessionId must be a non-empty string");
  return value;
}

function parseJson(value: unknown, field: string): unknown {
  const raw = requireString(value, field);
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${field} is invalid JSON: ${errorMessage(error)}`, { cause: error });
  }
}

function requireBlobGcKind(value: unknown): EventLogBlobGcKind {
  if (value === "evidence" || value === "file_history" || value === "runtime_asset") {
    return value;
  }
  throw new Error("retention_gc_intents.blob_kind is invalid");
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field} is not a SHA-256 digest`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is invalid`);
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} is not a non-negative safe integer`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return requireNonNegativeInteger(value, field);
}

function safeAdd(left: number, right: number, field: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new RangeError(`${field} exceeds safe integer range`);
  return sum;
}

function sqliteChangeCount(value: number | bigint): number {
  const count = typeof value === "bigint" ? Number(value) : value;
  return requireNonNegativeInteger(count, "sqlite changes");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
