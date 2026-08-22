import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { FileStorageIntegrityError } from "./local-file-storage.js";
import {
  CURRENT_EVENT_LOG_EPOCH,
  CURRENT_EVENT_LOG_PROTOCOL_MARKER,
} from "./sqlite/event-log-hard-cut-scope.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const BLOCKER_SAMPLE_LIMIT = 8;
const TASK_RUN_TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const CONTROL_JOB_TERMINAL_STATUSES = [
  "succeeded",
  "partial",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
] as const;
const CRON_RUN_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "blocked",
  "skipped",
] as const;
const MEMORY_JOB_TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export type EventLogHardCutBlockerKind =
  | "task_run"
  | "task_attempt"
  | "control_job"
  | "control_attempt"
  | "control_daemon_run"
  | "control_cron_run"
  | "control_completion"
  | "memory_job"
  | "storage_operation";

export interface EventLogHardCutBlocker {
  readonly kind: EventLogHardCutBlockerKind;
  readonly count: number;
  readonly sampleIds: readonly string[];
}

export type EventLogBlobGcAssetScope = "runtime_asset" | "evidence_blob" | "file_history_blob";

export type EventLogBlobGcIntentState = "pending" | "retryable" | "completed";

export interface EventLogBlobGcIntent {
  readonly intentId: string;
  readonly cutoverId: string;
  readonly assetScope: EventLogBlobGcAssetScope;
  readonly storageUri?: string;
  readonly contentDigest: string;
  readonly byteLength?: number;
  readonly requiresReferenceCheck: boolean;
  readonly state: EventLogBlobGcIntentState;
  readonly attemptCount: number;
  readonly nextAttemptAt?: string;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EventLogEpochMarker {
  readonly epoch: number;
  readonly protocolMarker: string;
  readonly cutoverId: string;
  readonly committedAt: string;
}

export type EventLogHardCutResult =
  | {
      readonly status: "blocked";
      readonly blockers: readonly EventLogHardCutBlocker[];
    }
  | {
      readonly status: "cut" | "already_current";
      readonly marker: EventLogEpochMarker;
      readonly deletedSessionCount: number;
      readonly gcIntents: readonly EventLogBlobGcIntent[];
    };

export interface EventLogHardCutOptions {
  readonly now?: () => Date;
  /** Test/failpoint hook. Throwing here rolls back cleanup, intents, and marker together. */
  readonly beforeCommit?: () => void;
}

export class EventLogHardCutIncompatibleEpochError extends FileStorageIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = "EventLogHardCutIncompatibleEpochError";
  }
}

export class EventLogHardCutBlockedError extends FileStorageIntegrityError {
  readonly blockers: readonly EventLogHardCutBlocker[];

  constructor(blockers: readonly EventLogHardCutBlocker[]) {
    const summary = blockers.map((blocker) => `${blocker.kind}=${blocker.count}`).join(", ");
    super(
      `EventLog hard cut is blocked by active or unresolved work (${summary}); ` +
        "the workspace remains on the legacy epoch and must not be opened",
    );
    this.name = "EventLogHardCutBlockedError";
    this.blockers = blockers;
  }
}

/**
 * Applies the single-version EventLog cut exactly once for one workspace DB.
 * It owns one BEGIN IMMEDIATE transaction; callers must not nest it. Physical
 * files are never removed here: committed GC intents are replayable after a
 * crash, including when the epoch is already current on the next invocation.
 */
export function coordinateEventLogHardCut(
  database: DatabaseSync,
  options: EventLogHardCutOptions = {},
): EventLogHardCutResult {
  if (database.isTransaction) {
    const existing = readEpochMarker(database);
    if (existing) {
      assertCompatibleEpoch(existing);
      if (existing.epoch === CURRENT_EVENT_LOG_EPOCH) {
        return currentEpochResult(database, existing);
      }
    }
    throw new FileStorageIntegrityError(
      "EventLog hard cut cannot advance a legacy epoch inside an existing SQLite transaction",
    );
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = readEpochMarker(database);
    if (existing) {
      assertCompatibleEpoch(existing);
      if (existing.epoch === CURRENT_EVENT_LOG_EPOCH) {
        const result = currentEpochResult(database, existing);
        database.exec("COMMIT");
        return result;
      }
    }

    const sessionIds = readStringColumn(database, "SELECT session_id AS id FROM sessions", "id");
    const blockers = collectBlockers(database, new Set(sessionIds));
    if (blockers.length > 0) {
      database.exec("COMMIT");
      return { status: "blocked", blockers };
    }

    const committedAt = canonicalTimestamp((options.now ?? (() => new Date()))());
    const cutoverId = randomUUID();
    const candidates = collectGcCandidates(database);
    persistGcIntents(database, cutoverId, committedAt, candidates);
    clearMemoryWeakReferences(database, sessionIds);
    clearControlWeakReferences(database);
    database.prepare("DELETE FROM storage_operations").run();
    clearAttachmentRows(database);
    clearSessionOwnedRows(database);
    database
      .prepare(
        `INSERT INTO event_log_epoch (
           singleton_id, epoch, protocol_marker, cutover_id, committed_at
         ) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
           epoch = excluded.epoch,
           protocol_marker = excluded.protocol_marker,
           cutover_id = excluded.cutover_id,
           committed_at = excluded.committed_at`,
      )
      .run(CURRENT_EVENT_LOG_EPOCH, CURRENT_EVENT_LOG_PROTOCOL_MARKER, cutoverId, committedAt);

    options.beforeCommit?.();
    const marker: EventLogEpochMarker = {
      epoch: CURRENT_EVENT_LOG_EPOCH,
      protocolMarker: CURRENT_EVENT_LOG_PROTOCOL_MARKER,
      cutoverId,
      committedAt,
    };
    const gcIntents = listEventLogBlobGcIntents(database, cutoverId);
    database.exec("COMMIT");
    return {
      status: "cut",
      marker,
      deletedSessionCount: sessionIds.length,
      gcIntents,
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

function currentEpochResult(
  database: DatabaseSync,
  marker: EventLogEpochMarker,
): EventLogHardCutResult {
  return {
    status: "already_current",
    marker,
    deletedSessionCount: 0,
    gcIntents: listEventLogBlobGcIntents(database, marker.cutoverId),
  };
}

export function listEventLogBlobGcIntents(
  database: DatabaseSync,
  cutoverId?: string,
): EventLogBlobGcIntent[] {
  const rows = database
    .prepare(
      `SELECT intent_id, cutover_id, asset_scope, storage_uri, content_digest, byte_length,
              requires_reference_check, state, attempt_count, next_attempt_at, last_error,
              created_at, updated_at
       FROM event_log_blob_gc_intents
       ${cutoverId === undefined ? "" : "WHERE cutover_id = ?"}
       ORDER BY asset_scope, storage_uri, content_digest, intent_id`,
    )
    .all(...(cutoverId === undefined ? [] : [cutoverId])) as Array<Record<string, unknown>>;
  return rows.map(decodeGcIntent);
}

function assertCompatibleEpoch(marker: EventLogEpochMarker): void {
  if (marker.epoch > CURRENT_EVENT_LOG_EPOCH) {
    throw new EventLogHardCutIncompatibleEpochError(
      `EventLog epoch ${marker.epoch} is newer than supported ${CURRENT_EVENT_LOG_EPOCH}`,
    );
  }
  if (
    marker.epoch === CURRENT_EVENT_LOG_EPOCH &&
    marker.protocolMarker !== CURRENT_EVENT_LOG_PROTOCOL_MARKER
  ) {
    throw new EventLogHardCutIncompatibleEpochError(
      `EventLog epoch ${marker.epoch} has incompatible protocol marker ${marker.protocolMarker}`,
    );
  }
}

function collectBlockers(
  database: DatabaseSync,
  sessionIds: ReadonlySet<string>,
): EventLogHardCutBlocker[] {
  const blockers = [
    ...collectTaskRunBlockers(database),
    queryBlocker(
      database,
      "control_job",
      `SELECT job_id AS id FROM jobs
       WHERE status NOT IN (${sqlLiterals(CONTROL_JOB_TERMINAL_STATUSES)}) ORDER BY job_id`,
    ),
    queryBlocker(
      database,
      "control_attempt",
      `SELECT attempt_id AS id FROM job_attempts
       WHERE status NOT IN (${sqlLiterals(CONTROL_JOB_TERMINAL_STATUSES)}) ORDER BY attempt_id`,
    ),
    queryBlocker(
      database,
      "control_daemon_run",
      `SELECT run_id AS id FROM daemon_runs
       WHERE status IN ('running','pause_requested','paused','cancelling') ORDER BY run_id`,
    ),
    queryBlocker(
      database,
      "control_cron_run",
      `SELECT cron_run_id AS id FROM cron_runs
       WHERE status NOT IN (${sqlLiterals(CRON_RUN_TERMINAL_STATUSES)}) ORDER BY cron_run_id`,
    ),
    queryBlocker(
      database,
      "control_completion",
      `SELECT c.completion_id AS id FROM completion_outbox AS c
       JOIN jobs AS j ON j.job_id = c.job_id
       WHERE c.delivered_at IS NULL
         AND (j.owner_session_id IS NOT NULL OR j.child_session_id IS NOT NULL)
       ORDER BY c.completion_id`,
    ),
    ...collectMemoryJobBlockers(database, sessionIds),
    queryBlocker(
      database,
      "storage_operation",
      `SELECT operation_id AS id FROM storage_operations
       WHERE state NOT IN ('completed','aborted') ORDER BY operation_id`,
    ),
  ];
  return blockers.filter((blocker) => blocker.count > 0);
}

function collectTaskRunBlockers(database: DatabaseSync): EventLogHardCutBlocker[] {
  const runIds: string[] = [];
  const runRows = database
    .prepare("SELECT task_run_id, status FROM task_runs ORDER BY task_run_id")
    .all() as Array<Record<string, unknown>>;
  for (const row of runRows) {
    const taskRunId = requireString(row["task_run_id"], "task_runs.task_run_id");
    const status = row["status"];
    if (typeof status !== "string" || !TASK_RUN_TERMINAL_STATUSES.has(status)) {
      runIds.push(taskRunId);
      continue;
    }
    const tail = database
      .prepare(
        `SELECT kind, payload_json FROM task_run_events
         WHERE task_run_id = ? ORDER BY event_seq DESC LIMIT 1`,
      )
      .get(taskRunId) as Record<string, unknown> | undefined;
    const payload = tail
      ? parseJsonRecord(tail["payload_json"], `TaskRun ${taskRunId} tail`)
      : null;
    if (
      tail?.["kind"] !== "task.finished" ||
      payload?.["kind"] !== "task.finished" ||
      payload["taskRunId"] !== taskRunId ||
      !isRecord(payload["data"]) ||
      payload["data"]["status"] !== status
    ) {
      throw new FileStorageIntegrityError(
        `TaskRun ${taskRunId} terminal projection is not backed by its terminal fact`,
      );
    }
  }

  const openAttempts = new Map<string, string>();
  const eventRows = database
    .prepare(
      `SELECT task_run_id, kind, payload_json FROM task_run_events
       WHERE kind IN ('attempt.started','attempt.finished') ORDER BY task_run_id, event_seq`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of eventRows) {
    const taskRunId = requireString(row["task_run_id"], "task_run_events.task_run_id");
    const kind = requireString(row["kind"], "task_run_events.kind");
    const payload = parseJsonRecord(row["payload_json"], `TaskRun ${taskRunId} ${kind}`);
    if (payload["kind"] !== kind || payload["taskRunId"] !== taskRunId) {
      throw new FileStorageIntegrityError(`TaskRun ${taskRunId} event projection is inconsistent`);
    }
    const data = payload["data"];
    if (!isRecord(data)) {
      throw new FileStorageIntegrityError(`TaskRun ${taskRunId} ${kind} data is malformed`);
    }
    const attemptId = requireString(data["attemptId"], `TaskRun ${taskRunId} attemptId`);
    const key = `${taskRunId}\0${attemptId}`;
    if (kind === "attempt.started") openAttempts.set(key, `${taskRunId}:${attemptId}`);
    else openAttempts.delete(key);
  }

  return [
    blockerFromIds("task_run", runIds),
    blockerFromIds("task_attempt", [...openAttempts.values()].sort()),
  ];
}

function collectMemoryJobBlockers(
  database: DatabaseSync,
  sessionIds: ReadonlySet<string>,
): EventLogHardCutBlocker[] {
  const affected = readAffectedMemoryJobs(database, sessionIds);
  return [
    blockerFromIds(
      "memory_job",
      affected
        .filter((job) => !MEMORY_JOB_TERMINAL_STATUSES.has(job.status))
        .map((job) => job.jobId)
        .sort(),
    ),
  ];
}

function clearMemoryWeakReferences(database: DatabaseSync, sessionIds: readonly string[]): void {
  const sessionSet = new Set(sessionIds);
  const sourceIds = readStringColumn(
    database,
    "SELECT source_id AS id FROM memory_sources ORDER BY source_id",
    "id",
  );
  const factIds = readStringColumn(
    database,
    "SELECT fact_id AS id FROM memory_facts WHERE source_id IS NOT NULL ORDER BY fact_id",
    "id",
  );
  const proposalIds = readStringColumn(
    database,
    "SELECT proposal_id AS id FROM memory_proposals WHERE source_id IS NOT NULL ORDER BY proposal_id",
    "id",
  );
  const jobIds = readAffectedMemoryJobs(database, sessionSet).map((job) => job.jobId);
  let changes = 0;
  changes += clearMemoryMutationRows(database, "source", sourceIds);
  changes += clearMemoryMutationRows(database, "fact", factIds);
  changes += clearMemoryMutationRows(database, "proposal", proposalIds);
  changes += clearMemoryMutationRows(database, "job", jobIds);
  changes += runForIds(
    database,
    "UPDATE memory_proposals SET conflict_fact_id = NULL WHERE conflict_fact_id = ?",
    factIds,
  );
  changes += runForIds(
    database,
    "UPDATE memory_proposals SET resolved_fact_id = NULL WHERE resolved_fact_id = ?",
    factIds,
  );
  changes += runForIds(database, "DELETE FROM memory_jobs WHERE job_id = ?", jobIds);
  changes += runForIds(database, "DELETE FROM memory_proposals WHERE proposal_id = ?", proposalIds);
  changes += runForIds(database, "DELETE FROM memory_facts WHERE fact_id = ?", factIds);
  changes += runForIds(database, "DELETE FROM memory_sources WHERE source_id = ?", sourceIds);
  changes += sqliteChanges(database.prepare("DELETE FROM memory_idempotency").run());
  if (changes > 0) bumpJsonRevision(database, "memory_metadata");
}

function clearControlWeakReferences(database: DatabaseSync): void {
  let changes = 0;
  changes += sqliteChanges(
    database
      .prepare(
        `UPDATE jobs SET owner_session_id = NULL, child_session_id = NULL
         WHERE owner_session_id IS NOT NULL OR child_session_id IS NOT NULL`,
      )
      .run(),
  );
  changes += sqliteChanges(
    database
      .prepare(
        `UPDATE daemon_runs SET session_id = NULL, checkpoint_id = NULL
         WHERE session_id IS NOT NULL OR checkpoint_id IS NOT NULL`,
      )
      .run(),
  );
  changes += sqliteChanges(
    database
      .prepare(
        `UPDATE usage_provider_calls SET session_id = NULL, conversation_id = NULL
         WHERE session_id IS NOT NULL OR conversation_id IS NOT NULL`,
      )
      .run(),
  );
  changes += sqliteChanges(
    database
      .prepare("UPDATE usage_baselines SET session_id = NULL WHERE session_id IS NOT NULL")
      .run(),
  );
  changes += sqliteChanges(database.prepare("DELETE FROM desktop_input_queue").run());
  changes += sqliteChanges(database.prepare("DELETE FROM desktop_first_send_claims").run());
  changes += sqliteChanges(database.prepare("DELETE FROM desktop_idempotency").run());
  changes += sqliteChanges(database.prepare("DELETE FROM daemon_commands").run());
  if (changes > 0) bumpJsonRevision(database, "control_metadata");
}

function clearAttachmentRows(database: DatabaseSync): void {
  database.prepare("DELETE FROM evidence_records").run();
  database.prepare("DELETE FROM file_history_snapshots").run();
  database.prepare("DELETE FROM file_history").run();
  // A blob index row is removed only after every DB manifest reference is gone.
  database
    .prepare(
      `DELETE FROM evidence_blobs
       WHERE NOT EXISTS (
         SELECT 1 FROM evidence_records AS records, json_tree(records.content_json) AS node
         WHERE node.key = 'digest' AND node.value = evidence_blobs.digest
       )`,
    )
    .run();
}

function clearSessionOwnedRows(database: DatabaseSync): void {
  for (const table of [
    "runtime_partial_segments",
    "runtime_tool_journal",
    "runtime_transcript_chunks",
    "runtime_continuation_claims",
    "runtime_checkpoint_projection",
    "runtime_eventlog_metadata",
    "runtime_storage_assets",
    "runtime_partial_snapshots",
    "runtime_tool_operations",
    "runtime_transcript_records",
    "runtime_run_projection",
    "session_messages",
    "session_catalog_projection",
    "runtime_owner_fences",
    "runtime_events",
    "sessions",
  ] as const) {
    database.prepare(`DELETE FROM ${table}`).run();
  }
}

interface GcCandidate {
  readonly assetScope: EventLogBlobGcAssetScope;
  readonly storageUri?: string;
  readonly contentDigest: string;
  readonly byteLength?: number;
  readonly requiresReferenceCheck: boolean;
}

function collectGcCandidates(database: DatabaseSync): GcCandidate[] {
  const candidates = new Map<string, GcCandidate>();
  const add = (candidate: GcCandidate): void => {
    const identity = gcIdentity(candidate);
    const existing = candidates.get(identity);
    if (
      existing?.byteLength !== undefined &&
      candidate.byteLength !== undefined &&
      existing.byteLength !== candidate.byteLength
    ) {
      throw new FileStorageIntegrityError(
        `EventLog blob ${candidate.contentDigest} has conflicting byte lengths`,
      );
    }
    candidates.set(identity, {
      ...candidate,
      ...(existing?.byteLength !== undefined ? { byteLength: existing.byteLength } : {}),
    });
  };

  const assetRows = database
    .prepare(
      `SELECT storage_uri, content_digest, byte_length FROM runtime_storage_assets
       ORDER BY asset_id`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of assetRows) {
    add({
      assetScope: "runtime_asset",
      storageUri: requireString(row["storage_uri"], "runtime_storage_assets.storage_uri"),
      contentDigest: requireString(row["content_digest"], "runtime_storage_assets.content_digest"),
      byteLength: requireNonNegativeInteger(
        row["byte_length"],
        "runtime_storage_assets.byte_length",
      ),
      requiresReferenceCheck: false,
    });
  }

  const evidenceRows = database
    .prepare("SELECT digest, size_bytes FROM evidence_blobs ORDER BY digest")
    .all() as Array<Record<string, unknown>>;
  for (const row of evidenceRows) {
    add({
      assetScope: "evidence_blob",
      contentDigest: requireDigest(row["digest"], "evidence_blobs.digest"),
      byteLength: requireNonNegativeInteger(row["size_bytes"], "evidence_blobs.size_bytes"),
      requiresReferenceCheck: true,
    });
  }
  for (const json of readJsonColumn(
    database,
    "SELECT content_json AS json FROM evidence_records",
  )) {
    collectSha256BlobRefs(json).forEach((ref) =>
      add({
        assetScope: "evidence_blob",
        contentDigest: ref.digest,
        ...(ref.sizeBytes === undefined ? {} : { byteLength: ref.sizeBytes }),
        requiresReferenceCheck: true,
      }),
    );
  }
  for (const json of readJsonColumn(
    database,
    `SELECT state_json AS json FROM file_history
     UNION ALL SELECT snapshot_json AS json FROM file_history_snapshots`,
  )) {
    collectSha256BlobRefs(json).forEach((ref) =>
      add({
        assetScope: "file_history_blob",
        contentDigest: ref.digest,
        ...(ref.sizeBytes === undefined ? {} : { byteLength: ref.sizeBytes }),
        requiresReferenceCheck: true,
      }),
    );
  }
  return [...candidates.values()].sort((left, right) =>
    gcIdentity(left) < gcIdentity(right) ? -1 : gcIdentity(left) > gcIdentity(right) ? 1 : 0,
  );
}

function persistGcIntents(
  database: DatabaseSync,
  cutoverId: string,
  at: string,
  candidates: readonly GcCandidate[],
): void {
  const insert = database.prepare(
    `INSERT INTO event_log_blob_gc_intents (
       intent_id, cutover_id, asset_scope, storage_uri, content_digest, byte_length,
       requires_reference_check, state, attempt_count, next_attempt_at, last_error,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
     ON CONFLICT(intent_id) DO NOTHING`,
  );
  for (const candidate of candidates) {
    insert.run(
      gcIntentId(candidate),
      cutoverId,
      candidate.assetScope,
      candidate.storageUri ?? null,
      candidate.contentDigest,
      candidate.byteLength ?? null,
      candidate.requiresReferenceCheck ? 1 : 0,
      at,
      at,
    );
  }
}

function readAffectedMemoryJobs(
  database: DatabaseSync,
  sessionIds: ReadonlySet<string>,
): Array<{ readonly jobId: string; readonly status: string }> {
  const rows = database
    .prepare("SELECT job_id, status, source_id, cursor_json FROM memory_jobs ORDER BY job_id")
    .all() as Array<Record<string, unknown>>;
  const affected: Array<{ jobId: string; status: string }> = [];
  for (const row of rows) {
    const jobId = requireString(row["job_id"], "memory_jobs.job_id");
    const status = requireString(row["status"], `memory_jobs[${jobId}].status`);
    const cursor = parseJsonRecord(row["cursor_json"], `memory_jobs[${jobId}].cursor_json`);
    const cursorSessionId = requireString(
      cursor["sessionId"],
      `memory_jobs[${jobId}].cursor.sessionId`,
    );
    if (row["source_id"] !== null || sessionIds.has(cursorSessionId)) {
      affected.push({ jobId, status });
    }
  }
  return affected;
}

function readEpochMarker(database: DatabaseSync): EventLogEpochMarker | undefined {
  const row = database
    .prepare(
      `SELECT epoch, protocol_marker, cutover_id, committed_at
       FROM event_log_epoch WHERE singleton_id = 1`,
    )
    .get() as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    epoch: requireNonNegativeInteger(row["epoch"], "event_log_epoch.epoch"),
    protocolMarker: requireString(row["protocol_marker"], "event_log_epoch.protocol_marker"),
    cutoverId: requireString(row["cutover_id"], "event_log_epoch.cutover_id"),
    committedAt: requireString(row["committed_at"], "event_log_epoch.committed_at"),
  };
}

function decodeGcIntent(row: Record<string, unknown>): EventLogBlobGcIntent {
  const storageUri = optionalString(row["storage_uri"], "event_log_blob_gc_intents.storage_uri");
  const byteLength = optionalNonNegativeInteger(
    row["byte_length"],
    "event_log_blob_gc_intents.byte_length",
  );
  const nextAttemptAt = optionalString(
    row["next_attempt_at"],
    "event_log_blob_gc_intents.next_attempt_at",
  );
  const lastError = optionalString(row["last_error"], "event_log_blob_gc_intents.last_error");
  const assetScope = requireString(row["asset_scope"], "event_log_blob_gc_intents.asset_scope");
  const state = requireString(row["state"], "event_log_blob_gc_intents.state");
  if (
    !["runtime_asset", "evidence_blob", "file_history_blob"].includes(assetScope) ||
    !["pending", "retryable", "completed"].includes(state)
  ) {
    throw new FileStorageIntegrityError("EventLog blob GC intent has an invalid enum value");
  }
  return {
    intentId: requireString(row["intent_id"], "event_log_blob_gc_intents.intent_id"),
    cutoverId: requireString(row["cutover_id"], "event_log_blob_gc_intents.cutover_id"),
    assetScope: assetScope as EventLogBlobGcAssetScope,
    ...(storageUri === undefined ? {} : { storageUri }),
    contentDigest: requireString(row["content_digest"], "event_log_blob_gc_intents.content_digest"),
    ...(byteLength === undefined ? {} : { byteLength }),
    requiresReferenceCheck: requireFlag(
      row["requires_reference_check"],
      "event_log_blob_gc_intents.requires_reference_check",
    ),
    state: state as EventLogBlobGcIntentState,
    attemptCount: requireNonNegativeInteger(
      row["attempt_count"],
      "event_log_blob_gc_intents.attempt_count",
    ),
    ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
    ...(lastError === undefined ? {} : { lastError }),
    createdAt: requireString(row["created_at"], "event_log_blob_gc_intents.created_at"),
    updatedAt: requireString(row["updated_at"], "event_log_blob_gc_intents.updated_at"),
  };
}

function queryBlocker(
  database: DatabaseSync,
  kind: EventLogHardCutBlockerKind,
  sql: string,
): EventLogHardCutBlocker {
  return blockerFromIds(kind, readStringColumn(database, sql, "id"));
}

function blockerFromIds(
  kind: EventLogHardCutBlockerKind,
  ids: readonly string[],
): EventLogHardCutBlocker {
  return { kind, count: ids.length, sampleIds: ids.slice(0, BLOCKER_SAMPLE_LIMIT) };
}

function readStringColumn(database: DatabaseSync, sql: string, column: string): string[] {
  return (database.prepare(sql).all() as Array<Record<string, unknown>>).map((row) =>
    requireString(row[column], column),
  );
}

function readJsonColumn(database: DatabaseSync, sql: string): unknown[] {
  return (database.prepare(sql).all() as Array<Record<string, unknown>>).map((row, index) =>
    parseJson(row["json"], `JSON row ${index + 1}`),
  );
}

function clearMemoryMutationRows(
  database: DatabaseSync,
  entityType: string,
  ids: readonly string[],
): number {
  const statement = database.prepare(
    "DELETE FROM memory_mutations WHERE entity_type = ? AND entity_id = ?",
  );
  let changes = 0;
  for (const id of ids) changes += sqliteChanges(statement.run(entityType, id));
  return changes;
}

function runForIds(database: DatabaseSync, sql: string, ids: readonly string[]): number {
  const statement = database.prepare(sql);
  let changes = 0;
  for (const id of ids) changes += sqliteChanges(statement.run(id));
  return changes;
}

function bumpJsonRevision(
  database: DatabaseSync,
  table: "memory_metadata" | "control_metadata",
): void {
  const row = database.prepare(`SELECT value_json FROM ${table} WHERE key = 'revision'`).get() as
    | { value_json?: unknown }
    | undefined;
  if (!row) {
    throw new FileStorageIntegrityError(`${table}.revision is missing during EventLog hard cut`);
  }
  const current = parseJson(row.value_json, `${table}.revision`);
  if (typeof current !== "number" || !Number.isSafeInteger(current) || current < 0) {
    throw new FileStorageIntegrityError(`${table}.revision is invalid during EventLog hard cut`);
  }
  database
    .prepare(`UPDATE ${table} SET value_json = ? WHERE key = 'revision'`)
    .run(JSON.stringify(current + 1));
}

function collectSha256BlobRefs(value: unknown): Array<{ digest: string; sizeBytes?: number }> {
  const refs = new Map<string, number | undefined>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isRecord(candidate)) return;
    if (candidate["algorithm"] === "sha256" && DIGEST_PATTERN.test(String(candidate["digest"]))) {
      const digest = candidate["digest"] as string;
      const size = candidate["sizeBytes"];
      const sizeBytes =
        typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : undefined;
      const existing = refs.get(digest);
      if (existing !== undefined && sizeBytes !== undefined && existing !== sizeBytes) {
        throw new FileStorageIntegrityError(
          `Shared blob ${digest} has conflicting declared byte lengths`,
        );
      }
      refs.set(digest, existing ?? sizeBytes);
    }
    Object.values(candidate).forEach(visit);
  };
  visit(value);
  return [...refs].map(([digest, sizeBytes]) => ({
    digest,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  }));
}

function gcIdentity(candidate: GcCandidate): string {
  return `${candidate.assetScope}\0${candidate.storageUri ?? ""}\0${candidate.contentDigest}`;
}

function gcIntentId(candidate: GcCandidate): string {
  return `eventlog-gc:${createHash("sha256").update(gcIdentity(candidate)).digest("hex")}`;
}

function sqlLiterals(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
}

function parseJsonRecord(value: unknown, field: string): Record<string, unknown> {
  const parsed = parseJson(value, field);
  if (!isRecord(parsed)) throw new FileStorageIntegrityError(`${field} must be a JSON object`);
  return parsed;
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") throw new FileStorageIntegrityError(`${field} is not JSON text`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new FileStorageIntegrityError(`${field} is not valid JSON`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.length) {
    throw new FileStorageIntegrityError(`${field} is not a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value == null ? undefined : requireString(value, field);
}

function requireDigest(value: unknown, field: string): string {
  const digest = requireString(value, field);
  if (!DIGEST_PATTERN.test(digest)) throw new FileStorageIntegrityError(`${field} is invalid`);
  return digest;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new FileStorageIntegrityError(`${field} is not a non-negative safe integer`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  return value == null ? undefined : requireNonNegativeInteger(value, field);
}

function requireFlag(value: unknown, field: string): boolean {
  if (value !== 0 && value !== 1) throw new FileStorageIntegrityError(`${field} is not a flag`);
  return value === 1;
}

function sqliteChanges(result: { readonly changes: number | bigint }): number {
  return typeof result.changes === "number" ? result.changes : Number(result.changes);
}

function canonicalTimestamp(value: Date): string {
  const timestamp = value.toISOString();
  if (new Date(timestamp).toISOString() !== timestamp)
    throw new Error("Invalid hard-cut timestamp");
  return timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
