/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { createHash, randomUUID } from "node:crypto";
import { ExecutionLearningSqliteStore } from "./execution-learning-store.js";
import { SqliteExperienceLedgerStore, scrubExperienceLedger } from "./experience-feedback-store.js";
import {
  closeSync,
  mkdirSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { scoreMemoryContent } from "@pico/core/atomic-memory-search";
import type {
  AtomicMemoryStore,
  AtomicMemorySettings,
} from "@pico/core/atomic-memory-runtime-contracts";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import {
  MemoryItemStoreConflictError,
  isMemoryItemKind,
  isMemoryItemOrigin,
  isMemoryKeyOrigin,
  isMemoryKeyType,
  isMemoryLifecycleState,
  isMemoryScopeType,
  isMemoryStatementType,
  isMemoryTemporalType,
  normalizeLongTermMemoryContent,
  validateMemoryTemporalBounds,
  type ApplyMemoryMutationsRequest,
  type CommitMemoryExtractionRequest,
  type EnqueueMemoryExtractionJobRequest,
  type MemoryExtractionJob,
  type MemoryExtractionJobClaim,
  type MemoryExtractionCommitResult,
  type MemoryCompactionPolicyDenial,
  type MemoryExtractionCursor,
  type MemoryExtractionFailureClass,
  type MemoryExtractionReceipt,
  type MemoryExtractionSummary,
  type MemoryExtractionMetrics,
  type MemoryExtractionMetricGroup,
  type MemoryConsolidationArchiveInput,
  type MemoryConsolidationArchiveReason,
  type MemoryConsolidationClaim,
  type MemoryConsolidationReceipt,
  type MemoryConsolidationArchivedItem,
  type CommitMemoryConsolidationRequest,
  type UndoMemoryConsolidationRequest,
  type UndoMemoryConsolidationResult,
  type MemoryItem,
  type MemoryItemKey,
  type MemoryItemKeyInput,
  type MemoryItemMutation,
  type MemoryItemRecord,
  type MemoryItemSource,
  type MemoryItemWrite,
  type MemoryMutationResult,
  type MemoryWriteOperationResult,
  type PendingMemoryExtractionFailure,
  type SearchMemoryItemsByKeyRequest,
  type SearchMemoryItemsByContentRequest,
  type SettleMemoryExtractionFailureRequest,
  type SettleMemoryExtractionFailureResult,
} from "@pico/core/atomic-memory-contracts";
import {
  assertSupportedSqliteLongTermMemorySchemaVersion,
  configureSqliteLongTermMemoryDatabase,
  initializeSqliteLongTermMemoryDatabase,
  readSqliteLongTermMemorySchemaVersion,
} from "./atomic-memory-schema.js";

const MAX_MUTATIONS_PER_OPERATION = 32;
const MAX_KEYS_PER_ITEM = 32;
const MAX_SOURCES_PER_ITEM = 256;
const MAX_SEARCH_TERMS = 32;
const MAX_SEARCH_RESULTS = 100;
const MAX_IDENTIFIER_CODE_POINTS = 512;
const MAX_KEY_CODE_POINTS = 256;
const MAX_OPERATION_RESULT_JSON_CODE_UNITS = 128 * 1_024;
const MAX_MEMORY_CONSOLIDATION_CANDIDATES = 256;
const MAX_MEMORY_CONSOLIDATION_JSON_CODE_UNITS = 512 * 1_024;
const MEMORY_CONSOLIDATION_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
const MEMORY_CONSOLIDATION_UNDO_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

const require = createRequire(import.meta.url);

export type SqliteMemoryItemStoreFailpoint =
  | "after_item_write"
  | "after_keys_write"
  | "after_sources_write"
  | "after_cursor_write"
  | "before_operation_write"
  | "after_commit";

export interface SqliteMemoryItemStoreOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly failpoint?: (point: SqliteMemoryItemStoreFailpoint) => void;
}

export class MemoryItemListCursorError extends Error {}

export interface MemoryItemListPage {
  readonly items: readonly {
    readonly item: MemoryItem;
    readonly executionEvidence?: MemoryItemRecord["executionEvidence"];
    readonly sourceCount: number;
    readonly sourceType?: MemoryItemRecord["sourceType"];
    readonly taskAcceptance?: MemoryItemRecord["taskAcceptance"];
    readonly taskExperience?: MemoryItemRecord["taskExperience"];
    readonly firstSource?: MemoryItemSource;
  }[];
  readonly pageInfo: {
    readonly revision: number;
    readonly nextCursor?: string;
    readonly counts: { readonly active: number; readonly archived: number; readonly total: number };
  };
  /** Per-row continuation tokens allow the transport to trim a page by serialized bytes. */
  readonly cursors: readonly string[];
}

interface MemoryListCursor {
  readonly version: 1;
  readonly binding: string;
  readonly revision: number;
  readonly updatedAt: number;
  readonly itemId: string;
}

interface NormalizedMemoryWrite {
  readonly content: string;
  readonly kind: MemoryItem["kind"];
  readonly statementType: MemoryItem["statementType"];
  readonly temporalType: MemoryItem["temporalType"];
  readonly scopeType: MemoryItem["scopeType"];
  readonly scopeKey: string | null;
  readonly eventStartedAt: number | null;
  readonly eventEndedAt: number | null;
  readonly observedAt: number;
  readonly origin: MemoryItem["origin"];
  readonly contentHash: string;
  readonly keys: readonly MemoryItemKey[];
  readonly sources: readonly MemoryItemSource[];
}

type NormalizedMutation =
  | { readonly type: "create"; readonly item: NormalizedMemoryWrite }
  | {
      readonly type: "update";
      readonly itemId: string;
      readonly expectedVersion: number;
      readonly item: NormalizedMemoryWrite;
    }
  | { readonly type: "archive"; readonly itemId: string; readonly expectedVersion: number }
  | { readonly type: "restore"; readonly itemId: string; readonly expectedVersion: number };

interface MemoryItemRow {
  item_id: unknown;
  version: unknown;
  content: unknown;
  kind: unknown;
  statement_type: unknown;
  temporal_type: unknown;
  scope_type: unknown;
  scope_key: unknown;
  event_started_at: unknown;
  event_ended_at: unknown;
  observed_at: unknown;
  lifecycle_state: unknown;
  origin: unknown;
  content_hash: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface MemoryKeyRow {
  key_text: unknown;
  normalized_key: unknown;
  key_type: unknown;
  key_origin: unknown;
}

interface MemorySourceRow {
  session_id: unknown;
  run_id: unknown;
  turn_id: unknown;
  event_id: unknown;
}

interface MemoryOperationRow {
  operation_id: unknown;
  operation_type: unknown;
  request_hash: unknown;
  result_json: unknown;
  committed_at: unknown;
}

interface MemoryExtractionCursorRow {
  session_id: unknown;
  processed_ordinal: unknown;
  updated_at: unknown;
}

interface MemoryExtractionFailureRow {
  session_id: unknown;
  from_ordinal: unknown;
  through_ordinal: unknown;
  coverage_hash: unknown;
  first_operation_id: unknown;
  first_trigger: unknown;
  compaction_checkpoint_id: unknown;
  first_failure_class: unknown;
  failed_at: unknown;
  deletion_revision: unknown;
}

interface MemoryExtractionReceiptRow {
  operation_id: unknown;
  session_id: unknown;
  request_hash: unknown;
  result_json: unknown;
  committed_at: unknown;
}

interface SqliteMemoryKeySearchQuery {
  readonly sql: string;
  readonly parameters: readonly (string | number)[];
}

/** Atomic memory database. The composition root owns its private directory and lifetime. */
export class SqliteMemoryItemStore implements AtomicMemoryStore {
  readonly executionLearning: ExecutionLearningSqliteStore;
  readonly experienceLedger: SqliteExperienceLedgerStore;
  get taskExperiences(): ExecutionLearningSqliteStore {
    return this.executionLearning;
  }
  readonly #database: DatabaseSync;
  readonly #options: SqliteMemoryItemStoreOptions;
  #closed = false;

  constructor(path: string, options: SqliteMemoryItemStoreOptions = {}) {
    if (path.trim() === "") throw new Error("Long-term memory SQLite path cannot be empty");
    this.#options = options;
    if (path !== ":memory:") preparePrivateDatabaseFiles(path);
    const Database = loadDatabaseSync();
    this.#database = new Database(path);
    try {
      assertSupportedSqliteLongTermMemorySchemaVersion(this.#database);
      configureSqliteLongTermMemoryDatabase(this.#database);
      initializeSqliteLongTermMemoryDatabase(this.#database);
      this.experienceLedger = new SqliteExperienceLedgerStore(this.#database, {
        now: this.#options.now ?? Date.now,
        settings: (workspaceKey) => this.#readSettings(workspaceKey),
        deletionRevision: () => this.#deletionRevision(),
        itemAcceptance: (itemId, contentHash) =>
          this.executionLearning.readItemAcceptance(itemId, contentHash),
        cursorError: (message) => new MemoryItemListCursorError(message),
      });
      this.executionLearning = new ExecutionLearningSqliteStore(this.#database, {
        experienceLedger: this.experienceLedger,
        now: this.#options.now ?? Date.now,
        settings: (workspaceKey) => this.#readSettings(workspaceKey),
        deletionRevision: () => this.#deletionRevision(),
        createExperienceItem: (candidate, now) => {
          const write = normalizeWrite({
            content: candidate.content,
            kind: "failure",
            statementType: "fact",
            temporalType: "undated",
            scopeType: "workspace",
            scopeKey: candidate.workspaceKey,
            observedAt: now,
            origin: "agent_extracted",
            keys: taskExperienceSearchKeys(candidate.goal, candidate.content),
            sources: candidate.sources,
          });
          const saved = this.#createItem(write, 0, now);
          this.#database
            .prepare("INSERT INTO memory_write_operations VALUES(?,'create',?,?,?)")
            .run(
              `task-experience-review:${candidate.candidateId}:${candidate.contentVersion}`,
              hashCanonical({
                candidateId: candidate.candidateId,
                contentVersion: candidate.contentVersion,
              }),
              JSON.stringify([saved]),
              now,
            );
          return { itemId: saved.itemId, contentHash: write.contentHash };
        },
      });
      this.executionLearning.repairDeletedExperiences();
      if (path !== ":memory:") secureExistingDatabaseFiles(path);
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  schemaVersion(): number {
    this.#assertOpen();
    return readSqliteLongTermMemorySchemaVersion(this.#database);
  }

  journalMode(): string {
    this.#assertOpen();
    const row = this.#database.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: unknown }
      | undefined;
    return typeof row?.journal_mode === "string" ? row.journal_mode.toLowerCase() : "";
  }

  foreignKeysEnabled(): boolean {
    this.#assertOpen();
    const row = this.#database.prepare("PRAGMA foreign_keys").get() as
      | { foreign_keys?: unknown }
      | undefined;
    return row?.foreign_keys === 1;
  }

  async applyMutations(request: ApplyMemoryMutationsRequest): Promise<MemoryWriteOperationResult> {
    this.#assertOpen();
    const committedAt = normalizeTimestamp((this.#options.now ?? Date.now)(), "current time");
    const operationId = normalizeIdentifier(request.operationId, "operationId");
    const mutations = normalizeMutations(request.mutations);
    const requestHash = hashCanonical(mutations);
    const operationType = mutations.length === 1 ? mutations[0]!.type : "batch";

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertNotDeleteOperation(operationId);
      const existing = this.#readOperationRow(operationId);
      if (existing) {
        if (requiredHash(existing.request_hash, "request_hash") !== requestHash) {
          throw new MemoryItemStoreConflictError(
            "operation_reused",
            `Memory operation ${operationId} was already used for a different request`,
          );
        }
        this.#database.exec("COMMIT");
        return { ...decodeOperation(existing), replayed: true };
      }

      if (request.expectedDeletionRevision !== undefined)
        this.#assertDeletionRevision(request.expectedDeletionRevision);
      validateObservedAtForCommit(mutations, committedAt);

      const results: MemoryMutationResult[] = [];
      for (let index = 0; index < mutations.length; index += 1) {
        const result = this.#applyMutation(mutations[index]!, index, committedAt);
        results.push(result);
      }

      this.#options.failpoint?.("before_operation_write");
      this.#database
        .prepare(
          `INSERT INTO memory_write_operations(
             operation_id, operation_type, request_hash, result_json, committed_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(operationId, operationType, requestHash, JSON.stringify(results), committedAt);
      this.#database.exec("COMMIT");
      this.#options.failpoint?.("after_commit");
      return { operationId, operationType, replayed: false, committedAt, results };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async commitExtraction(
    request: CommitMemoryExtractionRequest,
  ): Promise<MemoryExtractionCommitResult> {
    this.#assertOpen();
    const committedAt = normalizeTimestamp((this.#options.now ?? Date.now)(), "current time");
    const operationId = normalizeIdentifier(request.operationId, "operationId");
    const sessionId = normalizeIdentifier(request.sessionId, "sessionId");
    const expectedCursorOrdinal = normalizeCursorOrdinal(
      request.expectedCursorOrdinal,
      "expectedCursorOrdinal",
      true,
    );
    const nextCursorOrdinal = normalizeCursorOrdinal(
      request.nextCursorOrdinal,
      "nextCursorOrdinal",
      false,
    );
    const coverageHash = requiredHash(request.coverageHash, "coverageHash");
    if (nextCursorOrdinal <= expectedCursorOrdinal) {
      throw new Error("Memory extraction Cursor must advance");
    }
    const items = normalizeExtractionItems(request.items);
    const requestedItemIndexes = normalizeRequestedItemIndexes(
      request.requestedItemIndexes,
      items.length,
    );
    const noOpReason = normalizeExtractionNoOpReason(request.noOpReason);
    const skipReason = normalizeExtractionSkipReason(request.skipReason);
    const trigger = normalizeExtractionTrigger(request.trigger);
    const compactionCheckpointId = normalizeCompactionCheckpointId(
      trigger,
      request.compactionCheckpointId,
    );
    if (trigger !== "remember" && requestedItemIndexes.length > 0) {
      throw new Error("Incidental extraction cannot expose requested Items");
    }
    if (
      noOpReason &&
      (trigger !== "remember" || items.length > 0 || requestedItemIndexes.length > 0)
    ) {
      throw new Error("A rejected explicit Memory request must commit as an empty no-op");
    }
    if (
      skipReason &&
      ((skipReason === "policy_denied" && trigger === "remember") ||
        items.length > 0 ||
        requestedItemIndexes.length > 0)
    ) {
      throw new Error("A policy-skipped Memory extraction must be an empty automatic commit");
    }
    validateExtractionObservedAtForCommit(items, committedAt);
    const requestHash = hashCanonical({
      kind: "memory_extraction",
      sessionId,
      expectedCursorOrdinal,
      nextCursorOrdinal,
      coverageHash,
      items,
      requestedItemIndexes,
      noOpReason: noOpReason ?? null,
      skipReason: skipReason ?? null,
      trigger,
      compactionCheckpointId: compactionCheckpointId ?? null,
    });

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertNotDeleteOperation(operationId);
      const existingReceipt = this.#readExtractionReceiptRow(operationId);
      if (existingReceipt) {
        if (requiredHash(existingReceipt.request_hash, "request_hash") !== requestHash) {
          throw new MemoryItemStoreConflictError(
            "operation_reused",
            `Memory operation ${operationId} was already used for a different request`,
          );
        }
        const existing = this.#readOperationRow(operationId);
        if (!existing) throw new Error(`Memory extraction ${operationId} is missing its operation`);
        const decoded = decodeOperation(existing);
        const receipt = decodeExtractionReceipt(existingReceipt);
        this.#database.exec("COMMIT");
        return {
          ...decoded,
          replayed: true,
          cursor: {
            sessionId,
            processedOrdinal: nextCursorOrdinal,
            updatedAt: decoded.committedAt,
          },
          receipt,
        };
      }

      if (request.jobClaim) this.#assertExtractionJobClaim(request.jobClaim, committedAt);

      this.#assertDeletionRevision(request.expectedDeletionRevision);
      const currentCursor = this.#readExtractionCursorRow(sessionId);
      const currentOrdinal = currentCursor
        ? requiredPositiveInteger(currentCursor.processed_ordinal, "processed_ordinal")
        : 0;
      if (currentOrdinal !== expectedCursorOrdinal) {
        throw new MemoryItemStoreConflictError(
          "cursor_conflict",
          `Memory extraction Cursor for Session ${sessionId} is ${currentOrdinal}, expected ${expectedCursorOrdinal}`,
        );
      }

      const pendingFailure = this.#readPendingExtractionFailureRow(sessionId);
      if (pendingFailure) {
        const pending = decodePendingExtractionFailure(pendingFailure);
        const pendingMatchesCommit = skipReason
          ? (skipReason === "memory_deleted" || pending.firstTrigger !== "remember") &&
            pending.fromOrdinal === expectedCursorOrdinal + 1 &&
            pending.throughOrdinal <= nextCursorOrdinal
          : pending.firstOperationId !== operationId &&
            pending.fromOrdinal === expectedCursorOrdinal + 1 &&
            pending.throughOrdinal === nextCursorOrdinal &&
            pending.coverageHash === coverageHash &&
            pending.firstTrigger === trigger &&
            pending.compactionCheckpointId === compactionCheckpointId;
        if (!pendingMatchesCommit) {
          throw new MemoryItemStoreConflictError(
            "cursor_conflict",
            `Memory extraction pending range for Session ${sessionId} does not match the commit`,
          );
        }
      }

      const results = items.map((item, index) => this.#createItem(item, index, committedAt));
      const requestedItems = requestedItemIndexes.map((index) => {
        const result = results[index]!;
        return { itemId: result.itemId, content: items[index]!.content };
      });
      const receipt: MemoryExtractionReceipt = {
        operationId,
        sessionId,
        status: skipReason
          ? "skipped"
          : trigger !== "remember"
            ? "extracted"
            : requestedItems.length > 0
              ? "remembered"
              : "not_applicable",
        requestedItems,
        ...(noOpReason ? { noOpReason } : {}),
        ...(skipReason ? { skipReason } : {}),
        committedAt,
        ...(request.summary
          ? {
              summary: normalizeExtractionSummary({
                trigger,
                createdItemCount: results.length,
                modelCallCount: request.summary.modelCallCount,
                durationMs: request.summary.durationMs,
              }),
            }
          : {}),
      };

      if (currentCursor) {
        const updated = this.#database
          .prepare(
            `UPDATE memory_extraction_cursors
             SET processed_ordinal = ?, updated_at = ?
             WHERE session_id = ? AND processed_ordinal = ?`,
          )
          .run(nextCursorOrdinal, committedAt, sessionId, expectedCursorOrdinal);
        if (updated.changes !== 1) {
          throw new MemoryItemStoreConflictError(
            "cursor_conflict",
            `Memory extraction Cursor for Session ${sessionId} changed during commit`,
          );
        }
      } else {
        this.#database
          .prepare(
            `INSERT INTO memory_extraction_cursors(session_id, processed_ordinal, updated_at)
             VALUES (?, ?, ?)`,
          )
          .run(sessionId, nextCursorOrdinal, committedAt);
      }
      if (pendingFailure) {
        this.#database
          .prepare("DELETE FROM memory_extraction_failures WHERE session_id = ?")
          .run(sessionId);
      }
      this.#options.failpoint?.("after_cursor_write");

      this.#options.failpoint?.("before_operation_write");
      this.#database
        .prepare(
          `INSERT INTO memory_write_operations(
             operation_id, operation_type, request_hash, result_json, committed_at
           ) VALUES (?, 'batch', ?, ?, ?)`,
        )
        .run(operationId, requestHash, JSON.stringify(results), committedAt);
      this.#database
        .prepare(
          `INSERT INTO memory_extraction_receipts(
             operation_id, session_id, request_hash, result_json, committed_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(operationId, sessionId, requestHash, JSON.stringify(receipt), committedAt);
      if (request.jobClaim) {
        const settled = this.#database
          .prepare(
            `UPDATE memory_extraction_jobs
             SET state='settled', owner_id=NULL, lease_until=0, reason=NULL, updated_at=?
             WHERE job_id=? AND state='working' AND owner_id=? AND fencing_token=? AND lease_until>?`,
          )
          .run(
            committedAt,
            request.jobClaim.jobId,
            request.jobClaim.ownerId,
            request.jobClaim.fencingToken,
            committedAt,
          );
        if (settled.changes !== 1)
          throw new MemoryItemStoreConflictError(
            "cursor_conflict",
            "Memory extraction job claim was fenced",
          );
      }
      this.#database.exec("COMMIT");
      this.#options.failpoint?.("after_commit");
      return {
        operationId,
        operationType: "batch",
        replayed: false,
        committedAt,
        results,
        cursor: { sessionId, processedOrdinal: nextCursorOrdinal, updatedAt: committedAt },
        receipt,
      };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async recordCompactionPolicyDenial(
    denial: MemoryCompactionPolicyDenial,
  ): Promise<MemoryCompactionPolicyDenial> {
    this.#assertOpen();
    const normalized = {
      sessionId: normalizeIdentifier(denial.sessionId, "sessionId"),
      compactionCheckpointId: normalizeIdentifier(
        denial.compactionCheckpointId,
        "compactionCheckpointId",
      ),
      deniedAt: normalizeTimestamp(denial.deniedAt, "deniedAt"),
    };
    this.#database
      .prepare(
        `INSERT INTO memory_compaction_policy_denials(
           session_id, compaction_checkpoint_id, denied_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(session_id, compaction_checkpoint_id) DO NOTHING`,
      )
      .run(normalized.sessionId, normalized.compactionCheckpointId, normalized.deniedAt);
    const row = this.#database
      .prepare(
        `SELECT session_id, compaction_checkpoint_id, denied_at
         FROM memory_compaction_policy_denials
         WHERE session_id = ? AND compaction_checkpoint_id = ?`,
      )
      .get(normalized.sessionId, normalized.compactionCheckpointId) as
      | { session_id: unknown; compaction_checkpoint_id: unknown; denied_at: unknown }
      | undefined;
    if (!row) throw new Error("Compaction policy denial was not persisted");
    return decodeCompactionPolicyDenial(row);
  }

  async readCompactionPolicyDenials(
    sessionId: string,
  ): Promise<readonly MemoryCompactionPolicyDenial[]> {
    this.#assertOpen();
    const normalizedSessionId = normalizeIdentifier(sessionId, "sessionId");
    return (
      this.#database
        .prepare(
          `SELECT session_id, compaction_checkpoint_id, denied_at
           FROM memory_compaction_policy_denials
           WHERE session_id = ?
           ORDER BY denied_at ASC, compaction_checkpoint_id ASC`,
        )
        .all(normalizedSessionId) as Array<{
        session_id: unknown;
        compaction_checkpoint_id: unknown;
        denied_at: unknown;
      }>
    ).map(decodeCompactionPolicyDenial);
  }

  async initializeExtractionCursor(
    sessionId: string,
    processedOrdinal: number,
  ): Promise<MemoryExtractionCursor> {
    this.#assertOpen();
    const normalizedSessionId = normalizeIdentifier(sessionId, "sessionId");
    const normalizedOrdinal = normalizeCursorOrdinal(processedOrdinal, "processedOrdinal", false);
    const updatedAt = normalizeTimestamp((this.#options.now ?? Date.now)(), "current time");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#readExtractionCursorRow(normalizedSessionId);
      if (existing) {
        const decoded = decodeExtractionCursor(existing);
        this.#database.exec("COMMIT");
        return decoded;
      }
      if (this.#readPendingExtractionFailureRow(normalizedSessionId)) {
        throw new MemoryItemStoreConflictError(
          "cursor_conflict",
          `Memory extraction for Session ${normalizedSessionId} has a pending failed range`,
        );
      }
      this.#database
        .prepare(
          `INSERT INTO memory_extraction_cursors(session_id, processed_ordinal, updated_at)
           VALUES (?, ?, ?)`,
        )
        .run(normalizedSessionId, normalizedOrdinal, updatedAt);
      this.#database.exec("COMMIT");
      return { sessionId: normalizedSessionId, processedOrdinal: normalizedOrdinal, updatedAt };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async readExtractionCursor(sessionId: string): Promise<MemoryExtractionCursor | undefined> {
    this.#assertOpen();
    const normalizedSessionId = normalizeIdentifier(sessionId, "sessionId");
    return this.#readSnapshot(() => {
      const row = this.#readExtractionCursorRow(normalizedSessionId);
      return row ? decodeExtractionCursor(row) : undefined;
    });
  }

  async readPendingExtractionFailure(
    sessionId: string,
  ): Promise<PendingMemoryExtractionFailure | undefined> {
    this.#assertOpen();
    const normalizedSessionId = normalizeIdentifier(sessionId, "sessionId");
    return this.#readSnapshot(() => {
      const row = this.#readPendingExtractionFailureRow(normalizedSessionId);
      return row ? decodePendingExtractionFailure(row) : undefined;
    });
  }

  async settleExtractionFailure(
    request: SettleMemoryExtractionFailureRequest,
  ): Promise<SettleMemoryExtractionFailureResult> {
    this.#assertOpen();
    const operationId = normalizeIdentifier(request.operationId, "operationId");
    const sessionId = normalizeIdentifier(request.sessionId, "sessionId");
    const expectedCursorOrdinal = normalizeCursorOrdinal(
      request.expectedCursorOrdinal,
      "expectedCursorOrdinal",
      true,
    );
    const failedThroughOrdinal = normalizeCursorOrdinal(
      request.failedThroughOrdinal,
      "failedThroughOrdinal",
      false,
    );
    if (failedThroughOrdinal <= expectedCursorOrdinal) {
      throw new Error("Memory extraction failed range must advance beyond the Cursor");
    }
    const coverageHash = requiredHash(request.coverageHash, "coverageHash");
    const failureClass = normalizeExtractionFailureClass(request.failureClass);
    const trigger = normalizeExtractionTrigger(request.trigger);
    const compactionCheckpointId = normalizeCompactionCheckpointId(
      trigger,
      request.compactionCheckpointId,
    );
    const recordedAt = normalizeTimestamp((this.#options.now ?? Date.now)(), "current time");

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertNotDeleteOperation(operationId);
      if (request.jobClaim) this.#assertExtractionJobClaim(request.jobClaim, recordedAt);
      const existingReceipt = this.#readExtractionReceiptRow(operationId);
      if (existingReceipt) {
        const receipt = decodeExtractionReceipt(existingReceipt);
        if (receipt.status !== "discarded") {
          throw new MemoryItemStoreConflictError(
            "operation_reused",
            `Memory operation ${operationId} already completed successfully`,
          );
        }
        const discarded = receipt.discardedRange!;
        const replayHash = hashCanonical({
          kind: "memory_extraction_discard",
          sessionId,
          trigger,
          compactionCheckpointId: compactionCheckpointId ?? null,
          discardedRange: discarded,
        });
        if (
          receipt.sessionId !== sessionId ||
          requiredHash(existingReceipt.request_hash, "request_hash") !== replayHash ||
          discarded.fromOrdinal !== expectedCursorOrdinal + 1 ||
          discarded.throughOrdinal !== failedThroughOrdinal ||
          discarded.coverageHash !== coverageHash ||
          discarded.finalFailureClass !== failureClass
        ) {
          throw new MemoryItemStoreConflictError(
            "operation_reused",
            `Memory operation ${operationId} was already used for a different failed range`,
          );
        }
        const cursor = this.#readExtractionCursorRow(sessionId);
        if (!cursor) throw new Error(`Discarded Memory extraction ${operationId} lost its Cursor`);
        this.#database.exec("COMMIT");
        return {
          status: "discarded",
          replayed: true,
          receipt,
          cursor: decodeExtractionCursor(cursor),
        };
      }

      this.#assertDeletionRevision(request.expectedDeletionRevision);
      const cursorRow = this.#readExtractionCursorRow(sessionId);
      const currentOrdinal = cursorRow
        ? requiredPositiveInteger(cursorRow.processed_ordinal, "processed_ordinal")
        : 0;
      if (currentOrdinal !== expectedCursorOrdinal) {
        throw new MemoryItemStoreConflictError(
          "cursor_conflict",
          `Memory extraction Cursor for Session ${sessionId} is ${currentOrdinal}, expected ${expectedCursorOrdinal}`,
        );
      }

      const pendingRow = this.#readPendingExtractionFailureRow(sessionId);
      if (!pendingRow) {
        const pending: PendingMemoryExtractionFailure = {
          sessionId,
          fromOrdinal: expectedCursorOrdinal + 1,
          throughOrdinal: failedThroughOrdinal,
          coverageHash,
          firstOperationId: operationId,
          firstTrigger: trigger,
          ...(compactionCheckpointId ? { compactionCheckpointId } : {}),
          firstFailureClass: failureClass,
          failedAt: recordedAt,
          deletionRevision: request.expectedDeletionRevision,
        };
        this.#database
          .prepare(
            `INSERT INTO memory_extraction_failures(
               session_id, from_ordinal, through_ordinal, coverage_hash,
               first_operation_id, first_trigger, compaction_checkpoint_id,
               first_failure_class, failed_at, deletion_revision
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sessionId,
            pending.fromOrdinal,
            pending.throughOrdinal,
            pending.coverageHash,
            pending.firstOperationId,
            pending.firstTrigger,
            pending.compactionCheckpointId ?? null,
            pending.firstFailureClass,
            pending.failedAt,
            pending.deletionRevision,
          );
        if (request.jobClaim)
          this.#releaseExtractionJobClaim(request.jobClaim, recordedAt, "provider_retry");
        this.#database.exec("COMMIT");
        return { status: "retry_later", replayed: false, pending };
      }

      const pending = decodePendingExtractionFailure(pendingRow);
      if (pending.firstOperationId === operationId) {
        if (
          pending.fromOrdinal !== expectedCursorOrdinal + 1 ||
          pending.throughOrdinal !== failedThroughOrdinal ||
          pending.coverageHash !== coverageHash ||
          pending.firstTrigger !== trigger ||
          pending.compactionCheckpointId !== compactionCheckpointId ||
          pending.firstFailureClass !== failureClass
        ) {
          throw new MemoryItemStoreConflictError(
            "operation_reused",
            `Memory operation ${operationId} was already used for a different failed range`,
          );
        }
        if (request.jobClaim)
          this.#releaseExtractionJobClaim(request.jobClaim, recordedAt, "provider_retry");
        this.#database.exec("COMMIT");
        return { status: "retry_later", replayed: true, pending };
      }
      if (
        pending.fromOrdinal !== expectedCursorOrdinal + 1 ||
        pending.throughOrdinal !== failedThroughOrdinal ||
        pending.coverageHash !== coverageHash ||
        pending.firstTrigger !== trigger ||
        pending.compactionCheckpointId !== compactionCheckpointId
      ) {
        throw new MemoryItemStoreConflictError(
          "cursor_conflict",
          `Memory extraction failed range for Session ${sessionId} changed before discard`,
        );
      }

      const discardedRange = {
        fromOrdinal: pending.fromOrdinal,
        throughOrdinal: pending.throughOrdinal,
        coverageHash: pending.coverageHash,
        firstFailureClass: pending.firstFailureClass,
        finalFailureClass: failureClass,
      } as const;
      const receipt: MemoryExtractionReceipt = {
        operationId,
        sessionId,
        status: "discarded",
        requestedItems: [],
        discardedRange,
        committedAt: recordedAt,
      };
      const requestHash = hashCanonical({
        kind: "memory_extraction_discard",
        sessionId,
        trigger,
        compactionCheckpointId: compactionCheckpointId ?? null,
        discardedRange,
      });

      if (cursorRow) {
        const updated = this.#database
          .prepare(
            `UPDATE memory_extraction_cursors
             SET processed_ordinal = ?, updated_at = ?
             WHERE session_id = ? AND processed_ordinal = ?`,
          )
          .run(failedThroughOrdinal, recordedAt, sessionId, expectedCursorOrdinal);
        if (updated.changes !== 1) {
          throw new MemoryItemStoreConflictError(
            "cursor_conflict",
            `Memory extraction Cursor for Session ${sessionId} changed during discard`,
          );
        }
      } else {
        this.#database
          .prepare(
            `INSERT INTO memory_extraction_cursors(session_id, processed_ordinal, updated_at)
             VALUES (?, ?, ?)`,
          )
          .run(sessionId, failedThroughOrdinal, recordedAt);
      }
      this.#options.failpoint?.("after_cursor_write");
      this.#database
        .prepare("DELETE FROM memory_extraction_failures WHERE session_id = ?")
        .run(sessionId);
      this.#options.failpoint?.("before_operation_write");
      this.#database
        .prepare(
          `INSERT INTO memory_write_operations(
             operation_id, operation_type, request_hash, result_json, committed_at
           ) VALUES (?, 'batch', ?, '[]', ?)`,
        )
        .run(operationId, requestHash, recordedAt);
      this.#database
        .prepare(
          `INSERT INTO memory_extraction_receipts(
             operation_id, session_id, request_hash, result_json, committed_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(operationId, sessionId, requestHash, JSON.stringify(receipt), recordedAt);
      if (request.jobClaim) this.#settleExtractionJobClaim(request.jobClaim, recordedAt);
      this.#database.exec("COMMIT");
      this.#options.failpoint?.("after_commit");
      return {
        status: "discarded",
        replayed: false,
        receipt,
        cursor: { sessionId, processedOrdinal: failedThroughOrdinal, updatedAt: recordedAt },
      };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async readExtractionReceipt(operationId: string): Promise<MemoryExtractionReceipt | undefined> {
    this.#assertOpen();
    const normalizedOperationId = normalizeIdentifier(operationId, "operationId");
    return this.#readSnapshot(() => {
      const row = this.#readExtractionReceiptRow(normalizedOperationId);
      return row ? decodeExtractionReceipt(row) : undefined;
    });
  }

  async enqueueExtractionJob(
    request: EnqueueMemoryExtractionJobRequest,
  ): Promise<MemoryExtractionJob> {
    this.#assertOpen();
    const now = normalizeTimestamp((this.#options.now ?? Date.now)(), "current time");
    const jobId = normalizeIdentifier(request.jobId, "jobId");
    const sessionId = normalizeIdentifier(request.sessionId, "sessionId");
    const workspaceKey = normalizeIdentifier(request.workspaceKey, "workspaceKey");
    const workDir = normalizeIdentifier(request.workDir, "workDir");
    const sourceEventId = normalizeIdentifier(request.sourceEventId, "sourceEventId");
    const sourceHash = normalizeIdentifier(request.sourceHash, "sourceHash");
    const sourceOrdinal = normalizeCursorOrdinal(request.sourceOrdinal, "sourceOrdinal", false);
    const throughOrdinal = normalizeCursorOrdinal(request.throughOrdinal, "throughOrdinal", false);
    if (throughOrdinal < sourceOrdinal) throw new Error("Invalid extraction job source range");
    const trigger = normalizeExtractionTrigger(request.trigger);
    const checkpointId = normalizeCompactionCheckpointId(trigger, request.compactionCheckpointId);
    const deletionRevision = normalizeCursorOrdinal(
      request.deletionRevision,
      "deletionRevision",
      true,
    );
    const settingsVersion = normalizeCursorOrdinal(
      request.settingsVersion,
      "settingsVersion",
      false,
    );
    const notBefore = normalizeTimestamp(request.notBefore, "notBefore");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          `INSERT INTO memory_extraction_jobs(
          job_id,session_id,workspace_key,work_dir,source_event_id,source_hash,source_kind,source_ordinal,through_ordinal,
          trigger,compaction_checkpoint_id,deletion_revision,settings_version,state,not_before,
          created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)
        ON CONFLICT(session_id,source_event_id,trigger) DO NOTHING`,
        )
        .run(
          jobId,
          sessionId,
          workspaceKey,
          workDir,
          sourceEventId,
          sourceHash,
          request.sourceKind,
          sourceOrdinal,
          throughOrdinal,
          trigger,
          checkpointId ?? null,
          deletionRevision,
          settingsVersion,
          notBefore,
          now,
          now,
        );
      const row = this.#database
        .prepare(
          "SELECT * FROM memory_extraction_jobs WHERE job_id=? OR (session_id=? AND source_event_id=? AND trigger=?)",
        )
        .get(jobId, sessionId, sourceEventId, trigger) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Memory extraction job was not persisted");
      if (row.job_id !== jobId)
        throw new MemoryItemStoreConflictError(
          "operation_reused",
          "Memory extraction source already has a different job identity",
        );
      this.#database.exec("COMMIT");
      return decodeMemoryExtractionJob(row);
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async claimExtractionJob(input: {
    jobId: string;
    ownerId: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<MemoryExtractionJobClaim | undefined> {
    this.#assertOpen();
    const jobId = normalizeIdentifier(input.jobId, "jobId");
    const ownerId = normalizeIdentifier(input.ownerId, "ownerId");
    const now = normalizeTimestamp(input.now, "now");
    const leaseDurationMs = normalizeCursorOrdinal(input.leaseDurationMs, "leaseDurationMs", false);
    const leaseUntil = now + leaseDurationMs;
    if (!Number.isSafeInteger(leaseUntil))
      throw new Error("Extraction job lease exceeds safe integer range");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare("SELECT * FROM memory_extraction_jobs WHERE job_id=?")
        .get(jobId) as Record<string, unknown> | undefined;
      if (!row) {
        this.#database.exec("COMMIT");
        return undefined;
      }
      const job = decodeMemoryExtractionJob(row);
      if (
        !(
          (job.state === "pending" && job.notBefore <= now) ||
          (job.state === "working" && (job.leaseUntil ?? 0) <= now)
        )
      ) {
        this.#database.exec("COMMIT");
        return undefined;
      }
      const fencingToken = job.fencingToken + 1;
      if (!Number.isSafeInteger(fencingToken))
        throw new Error("Extraction job fencing token overflow");
      this.#database
        .prepare(
          `UPDATE memory_extraction_jobs SET state='working', owner_id=?, lease_until=?,
         fencing_token=?, updated_at=? WHERE job_id=?`,
        )
        .run(ownerId, leaseUntil, fencingToken, now, jobId);
      const claimed = this.#database
        .prepare("SELECT * FROM memory_extraction_jobs WHERE job_id=?")
        .get(jobId) as Record<string, unknown>;
      this.#database.exec("COMMIT");
      return decodeMemoryExtractionJob(claimed) as MemoryExtractionJobClaim;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async reserveExtractionModelCall(claim: MemoryExtractionJobClaim): Promise<number> {
    this.#assertOpen();
    const now = normalizeTimestamp((this.#options.now ?? Date.now)(), "current time");
    this.#assertExtractionJobClaim(claim, now);
    const updated = this.#database
      .prepare(
        `UPDATE memory_extraction_jobs SET model_calls=model_calls+1, updated_at=?
       WHERE job_id=? AND state='working' AND owner_id=? AND fencing_token=? AND lease_until>?
         AND model_calls < 6`,
      )
      .run(now, claim.jobId, claim.ownerId, claim.fencingToken, now);
    if (updated.changes !== 1) {
      this.#assertExtractionJobClaim(claim, now);
      throw new Error("memory_extraction_budget_exhausted");
    }
    const row = this.#database
      .prepare("SELECT model_calls FROM memory_extraction_jobs WHERE job_id=?")
      .get(claim.jobId) as { model_calls: unknown };
    return requiredNonNegativeInteger(row.model_calls, "model_calls");
  }

  async transitionExtractionJob(input: {
    claim: MemoryExtractionJobClaim;
    state: "pending" | "blocked";
    notBefore?: number;
    reason?: string;
  }): Promise<void> {
    this.#assertOpen();
    const now = normalizeTimestamp((this.#options.now ?? Date.now)(), "current time");
    const claim = input.claim;
    this.#assertExtractionJobClaim(claim, now);
    const notBefore =
      input.state === "pending" ? normalizeTimestamp(input.notBefore ?? now, "notBefore") : now;
    const reason = input.reason === undefined ? null : normalizeIdentifier(input.reason, "reason");
    const updated = this.#database
      .prepare(
        `UPDATE memory_extraction_jobs SET state=?, not_before=?, owner_id=NULL, lease_until=0,
       reason=?, updated_at=? WHERE job_id=? AND state='working' AND owner_id=? AND fencing_token=? AND lease_until>?`,
      )
      .run(
        input.state,
        notBefore,
        reason,
        now,
        claim.jobId,
        claim.ownerId,
        claim.fencingToken,
        now,
      );
    if (updated.changes !== 1)
      throw new MemoryItemStoreConflictError(
        "cursor_conflict",
        "Memory extraction job claim was fenced",
      );
  }

  async listRecoverableExtractionJobs(input: {
    now: number;
    limit?: number;
  }): Promise<readonly MemoryExtractionJob[]> {
    this.#assertOpen();
    const now = normalizeTimestamp(input.now, "now");
    const limit =
      input.limit === undefined ? 100 : normalizeCursorOrdinal(input.limit, "limit", false);
    return this.#readSnapshot(() =>
      (
        this.#database
          .prepare(
            `SELECT * FROM memory_extraction_jobs WHERE (state='pending' AND not_before<=?)
       OR (state='working' AND lease_until<=?) ORDER BY not_before,created_at,job_id LIMIT ?`,
          )
          .all(now, now, Math.min(limit, 500)) as Array<Record<string, unknown>>
      ).map(decodeMemoryExtractionJob),
    );
  }

  async readExtractionJob(jobId: string): Promise<MemoryExtractionJob | undefined> {
    this.#assertOpen();
    const id = normalizeIdentifier(jobId, "jobId");
    return this.#readSnapshot(() => {
      const row = this.#database
        .prepare("SELECT * FROM memory_extraction_jobs WHERE job_id=?")
        .get(id) as Record<string, unknown> | undefined;
      return row ? decodeMemoryExtractionJob(row) : undefined;
    });
  }

  #assertExtractionJobClaim(claim: MemoryExtractionJobClaim, now: number): void {
    const row = this.#database
      .prepare(
        `SELECT 1 FROM memory_extraction_jobs WHERE job_id=? AND state='working' AND owner_id=?
       AND fencing_token=? AND lease_until>?`,
      )
      .get(claim.jobId, claim.ownerId, claim.fencingToken, now);
    if (!row)
      throw new MemoryItemStoreConflictError(
        "cursor_conflict",
        "Memory extraction job claim was fenced",
      );
  }

  #releaseExtractionJobClaim(claim: MemoryExtractionJobClaim, now: number, reason: string): void {
    const updated = this.#database
      .prepare(
        `UPDATE memory_extraction_jobs SET state='pending', not_before=?, owner_id=NULL,
         lease_until=0, reason=?, updated_at=?
         WHERE job_id=? AND state='working' AND owner_id=? AND fencing_token=? AND lease_until>?`,
      )
      .run(
        now + 60_000,
        normalizeIdentifier(reason, "reason"),
        now,
        claim.jobId,
        claim.ownerId,
        claim.fencingToken,
        now,
      );
    if (updated.changes !== 1)
      throw new MemoryItemStoreConflictError(
        "cursor_conflict",
        "Memory extraction job claim was fenced",
      );
  }

  #settleExtractionJobClaim(claim: MemoryExtractionJobClaim, now: number): void {
    const updated = this.#database
      .prepare(
        `UPDATE memory_extraction_jobs SET state='settled', owner_id=NULL, lease_until=0,
         reason=NULL, updated_at=?
         WHERE job_id=? AND state='working' AND owner_id=? AND fencing_token=? AND lease_until>?`,
      )
      .run(now, claim.jobId, claim.ownerId, claim.fencingToken, now);
    if (updated.changes !== 1)
      throw new MemoryItemStoreConflictError(
        "cursor_conflict",
        "Memory extraction job claim was fenced",
      );
  }

  async listExtractionReceipts(
    sessionId: string,
    limit = 100,
  ): Promise<readonly MemoryExtractionReceipt[]> {
    this.#assertOpen();
    const session = normalizeIdentifier(sessionId, "sessionId");
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Invalid extraction receipt limit");
    return this.#readSnapshot(() =>
      (
        this.#database
          .prepare(
            "SELECT * FROM memory_extraction_receipts WHERE session_id=? ORDER BY committed_at DESC,operation_id ASC LIMIT ?",
          )
          .all(session, Math.min(100, limit)) as unknown as MemoryExtractionReceiptRow[]
      ).map(decodeExtractionReceipt),
    );
  }

  async readItem(itemId: string): Promise<MemoryItemRecord | undefined> {
    this.#assertOpen();
    return this.#readSnapshot(() => this.#readItemRecord(normalizeIdentifier(itemId, "itemId")));
  }

  async searchByKeys(request: SearchMemoryItemsByKeyRequest): Promise<readonly MemoryItemRecord[]> {
    this.#assertOpen();
    if (request.match !== "exact" && request.match !== "prefix") {
      throw new Error("Memory key match must be exact or prefix");
    }
    if (!Array.isArray(request.terms) || request.terms.length === 0) {
      throw new Error("Memory key search requires at least one term");
    }
    if (request.terms.length > MAX_SEARCH_TERMS) {
      throw new Error(`Memory key search accepts at most ${MAX_SEARCH_TERMS} terms`);
    }
    if (request.includeArchived !== undefined && typeof request.includeArchived !== "boolean") {
      throw new Error("Memory key includeArchived must be a boolean");
    }
    const terms = [...new Set(request.terms.map(normalizeSearchTerm))].sort(compareText);
    const workspaceKey =
      request.workspaceKey === undefined
        ? undefined
        : normalizeIdentifier(request.workspaceKey, "workspaceKey");
    const limit = request.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
      throw new Error(`Memory key search limit must be between 1 and ${MAX_SEARCH_RESULTS}`);
    }

    const query = buildSqliteMemoryKeySearchQuery({
      terms,
      match: request.match,
      ...(workspaceKey !== undefined ? { workspaceKey } : {}),
      includeArchived: request.includeArchived ?? false,
      limit,
    });
    return this.#readSnapshot(() => {
      const rows = this.#database.prepare(query.sql).all(...query.parameters) as Array<{
        item_id?: unknown;
      }>;

      return rows.map((row) => {
        if (typeof row.item_id !== "string") throw new Error("Invalid Memory Item search result");
        const record = this.#readItemRecord(row.item_id);
        if (!record) throw new Error(`Memory Item ${row.item_id} disappeared during read`);
        return record;
      });
    });
  }

  async searchByContent(
    request: SearchMemoryItemsByContentRequest,
  ): Promise<readonly MemoryItemRecord[]> {
    this.#assertOpen();
    const workspaceKey = normalizeIdentifier(request.workspaceKey, "workspaceKey");
    const limit = request.limit ?? MAX_SEARCH_RESULTS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS)
      throw new Error(`Memory content search limit must be between 1 and ${MAX_SEARCH_RESULTS}`);
    const signals = {
      paths: request.paths.map(normalizeSearchTerm),
      tokens: request.tokens.map(normalizeSearchTerm),
      cjkBigrams: request.cjkBigrams.map(normalizeSearchTerm),
    };
    const count = signals.paths.length + signals.tokens.length + signals.cjkBigrams.length;
    if (count > MAX_SEARCH_TERMS)
      throw new Error(`Memory content search accepts at most ${MAX_SEARCH_TERMS} terms`);
    if (!count) return [];
    return this.#readSnapshot(() => {
      const ranked: Array<{ id: string; score: number; updatedAt: number }> = [];
      const rows = this.#database
        .prepare(
          `SELECT item_id, content, updated_at FROM memory_items
        WHERE lifecycle_state = 'active' AND (scope_type = 'global' OR (scope_type = 'workspace' AND scope_key = ?))`,
        )
        .iterate(workspaceKey);
      for (const row of rows) {
        const content = requiredString(row.content, "content").replace(
          /^用户要求保留的助手笔记（未经独立核实） \[[1-9]\d*\/[1-9]\d*\]：/u,
          "",
        );
        const score = scoreMemoryContent(content, signals);
        if (score > 0)
          ranked.push({
            id: requiredIdentifierString(row.item_id, "item_id"),
            score,
            updatedAt: requiredNonNegativeInteger(row.updated_at, "updated_at"),
          });
      }
      ranked.sort(
        (a, b) => b.score - a.score || b.updatedAt - a.updatedAt || compareText(a.id, b.id),
      );
      return ranked.slice(0, limit).map(({ id }) => this.#requireItemRecord(id));
    });
  }

  async readExtractionMetrics(input: {
    from: number;
    to: number;
  }): Promise<MemoryExtractionMetrics> {
    this.#assertOpen();
    const from = normalizeTimestamp(input.from, "from");
    const to = normalizeTimestamp(input.to, "to");
    if (from > to) throw new Error("Memory metrics from must not exceed to");
    return this.#readSnapshot(() => {
      const groups = new Map<
        MemoryExtractionSummary["trigger"],
        {
          trigger: MemoryExtractionSummary["trigger"];
          settledCount: number;
          evaluatedCount: number;
          createdItemCount: number;
          modelCallCount: number;
          emptyCount: number;
          durationMs: number;
        }
      >();
      let unknownReceiptCount = 0;
      for (const row of this.#database
        .prepare(
          "SELECT * FROM memory_extraction_receipts WHERE committed_at >= ? AND committed_at <= ?",
        )
        .iterate(from, to)) {
        const receipt = decodeExtractionReceipt(row as unknown as MemoryExtractionReceiptRow);
        const summary = receipt.summary;
        if (!summary) {
          unknownReceiptCount++;
          continue;
        }
        const group = groups.get(summary.trigger) ?? {
          trigger: summary.trigger,
          settledCount: 0,
          evaluatedCount: 0,
          createdItemCount: 0,
          modelCallCount: 0,
          emptyCount: 0,
          durationMs: 0,
        };
        group.settledCount++;
        group.createdItemCount += summary.createdItemCount;
        group.modelCallCount += summary.modelCallCount;
        group.durationMs += summary.durationMs;
        if (
          summary.modelCallCount > 0 &&
          receipt.status !== "skipped" &&
          receipt.status !== "discarded"
        ) {
          group.evaluatedCount++;
          if (summary.createdItemCount === 0) group.emptyCount++;
        }
        groups.set(summary.trigger, group);
      }
      const projected: MemoryExtractionMetricGroup[] = [...groups.values()].map((group) => ({
        ...group,
        emptyRate: group.evaluatedCount ? group.emptyCount / group.evaluatedCount : null,
      }));
      return {
        scope: "user",
        from,
        to,
        groups: projected.sort((a, b) => compareText(a.trigger, b.trigger)),
        unknownReceiptCount,
      };
    });
  }

  async claimMemoryConsolidation(input: {
    readonly ownerId: string;
    readonly now: number;
    readonly leaseDurationMs: number;
  }): Promise<MemoryConsolidationClaim | undefined> {
    this.#assertOpen();
    const ownerId = normalizeIdentifier(input.ownerId, "ownerId");
    const now = normalizeTimestamp(input.now, "now");
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1)
      throw new Error("leaseDurationMs must be a positive safe integer");
    const leaseUntil = now + input.leaseDurationMs;
    if (!Number.isSafeInteger(leaseUntil)) throw new Error("leaseUntil exceeds safe integer range");

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.#database
        .prepare("SELECT * FROM memory_consolidation_state WHERE singleton=1")
        .get() as Record<string, unknown> | undefined;
      if (!state) throw new Error("Memory consolidation state is missing");
      const lastCommittedAt = requiredNonNegativeInteger(
        state.last_committed_at,
        "last_committed_at",
      );
      const currentLeaseId = nullableIdentifierString(state.lease_id, "lease_id");
      const currentLeaseUntil = requiredNonNegativeInteger(state.lease_until, "lease_until");
      const previousFencingToken = requiredNonNegativeInteger(state.fencing_token, "fencing_token");
      if (currentLeaseId && currentLeaseUntil > now) {
        this.#database.exec("COMMIT");
        return undefined;
      }
      // This existing watermark now includes the latest claimed attempt. Failed
      // model requests must cool down too, instead of retrying every extraction.
      if (previousFencingToken > 0 && now - lastCommittedAt < MEMORY_CONSOLIDATION_COOLDOWN_MS) {
        this.#database.exec("COMMIT");
        return undefined;
      }

      const ids = this.#database
        .prepare(
          `SELECT i.item_id FROM memory_items i
           WHERE i.origin='agent_extracted' AND i.lifecycle_state='active'
             AND NOT EXISTS (
               SELECT 1 FROM execution_learning_items e
               WHERE e.item_id=i.item_id
             )
           ORDER BY i.updated_at DESC, i.item_id ASC LIMIT ?`,
        )
        .all(MAX_MEMORY_CONSOLIDATION_CANDIDATES) as Array<{ item_id: unknown }>;
      const candidates: MemoryItemRecord[] = [];
      for (const row of ids) {
        const itemId = requiredIdentifierString(row.item_id, "item_id");
        const record = this.#readItemRecord(itemId);
        if (record && isMemoryConsolidationEligible(record)) candidates.push(record);
      }
      if (candidates.length === 0) {
        if (currentLeaseId) this.#clearMemoryConsolidationLease();
        this.#database.exec("COMMIT");
        return undefined;
      }

      const fencingToken = previousFencingToken + 1;
      if (!Number.isSafeInteger(fencingToken))
        throw new Error("Memory consolidation fencing token exceeds safe integer range");
      const claimId = randomUUID();
      const claimItems = candidates.map(({ item }) => ({
        itemId: item.itemId,
        expectedVersion: item.version,
      }));
      this.#database
        .prepare(
          `UPDATE memory_consolidation_state
           SET lease_id=?, lease_owner=?, lease_until=?, fencing_token=?, lease_items_json=?,
             last_committed_at=?
           WHERE singleton=1`,
        )
        .run(claimId, ownerId, leaseUntil, fencingToken, JSON.stringify(claimItems), now);
      this.#database.exec("COMMIT");
      return { claimId, ownerId, fencingToken, claimedAt: now, leaseUntil, candidates };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async releaseMemoryConsolidationClaim(input: {
    readonly claimId: string;
    readonly ownerId: string;
    readonly fencingToken: number;
  }): Promise<void> {
    this.#assertOpen();
    const claimId = normalizeIdentifier(input.claimId, "claimId");
    const ownerId = normalizeIdentifier(input.ownerId, "ownerId");
    const fencingToken = normalizeVersion(input.fencingToken);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.#ownsMemoryConsolidationLease(claimId, ownerId, fencingToken)) {
        throw new MemoryItemStoreConflictError(
          "consolidation_claim_conflict",
          "Memory consolidation claim is no longer owned by this worker",
        );
      }
      this.#clearMemoryConsolidationLease();
      this.#database.exec("COMMIT");
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async commitMemoryConsolidation(
    input: CommitMemoryConsolidationRequest,
  ): Promise<MemoryConsolidationReceipt> {
    this.#assertOpen();
    const batchId = normalizeIdentifier(input.batchId, "batchId");
    const claimId = normalizeIdentifier(input.claimId, "claimId");
    const ownerId = normalizeIdentifier(input.ownerId, "ownerId");
    const fencingToken = normalizeVersion(input.fencingToken);
    const now = normalizeTimestamp(input.now, "now");
    const archive = normalizeMemoryConsolidationArchive(input.archive);
    const requestHash = hashCanonical({ claimId, archive });
    const internalOperationId = memoryConsolidationOperationId(batchId, "commit");

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#readMemoryConsolidationReceiptRow(batchId);
      if (existing) {
        if (requiredHash(existing.request_hash, "request_hash") !== requestHash)
          throw new MemoryItemStoreConflictError(
            "operation_reused",
            `Memory consolidation batch ${batchId} was reused for different changes`,
          );
        const receipt = decodeMemoryConsolidationReceipt(existing);
        this.#database.exec("COMMIT");
        return receipt;
      }
      if (!this.#ownsMemoryConsolidationLease(claimId, ownerId, fencingToken, now))
        throw new MemoryItemStoreConflictError(
          "consolidation_claim_conflict",
          "Memory consolidation claim expired or changed before commit",
        );
      if (this.#readOperationRow(internalOperationId))
        throw new MemoryItemStoreConflictError(
          "operation_reused",
          "Memory consolidation operation identity is already in use",
        );

      const state = this.#database
        .prepare("SELECT lease_items_json FROM memory_consolidation_state WHERE singleton=1")
        .get() as { lease_items_json?: unknown } | undefined;
      const claimedItems = decodeMemoryConsolidationClaimItems(state?.lease_items_json);
      const claimed = new Map(claimedItems.map((item) => [item.itemId, item.expectedVersion]));
      for (const item of archive) {
        if (claimed.get(item.itemId) !== item.expectedVersion)
          throw new MemoryItemStoreConflictError(
            "consolidation_claim_conflict",
            `Memory Item ${item.itemId} is not in this consolidation claim snapshot`,
            item.itemId,
          );
      }

      // The model chose archives relative to the entire claim, including the
      // Items it kept. Recheck that snapshot in this writer transaction so a
      // concurrent edit/delete/archive of a keeper cannot invalidate the choice.
      for (const selected of claimedItems) {
        const current = this.#readItemRecord(selected.itemId);
        if (
          !current ||
          current.item.version !== selected.expectedVersion ||
          !isMemoryConsolidationEligible(current)
        )
          throw new MemoryItemStoreConflictError(
            "consolidation_claim_conflict",
            `Memory Item ${selected.itemId} changed after consolidation was captured`,
            selected.itemId,
          );
      }

      const receiptItems: MemoryConsolidationArchivedItem[] = [];
      for (const [index, selected] of archive.entries()) {
        const current = this.#database
          .prepare(
            `SELECT i.version, i.updated_at, i.lifecycle_state
             FROM memory_items i WHERE i.item_id=?`,
          )
          .get(selected.itemId) as
          | {
              version: unknown;
              updated_at: unknown;
              lifecycle_state: unknown;
            }
          | undefined;
        if (!current)
          throw new MemoryItemStoreConflictError(
            "item_not_found",
            `Memory Item ${selected.itemId} no longer exists`,
            selected.itemId,
          );
        const currentVersion = requiredPositiveInteger(current.version, "version");
        const currentRecord = this.#readItemRecord(selected.itemId);
        if (
          currentVersion !== selected.expectedVersion ||
          current.lifecycle_state !== "active" ||
          !currentRecord ||
          !hasMemoryConsolidationEligibleMetadata(currentRecord)
        )
          throw new MemoryItemStoreConflictError(
            "version_conflict",
            `Memory Item ${selected.itemId} changed or is not eligible for automatic consolidation`,
            selected.itemId,
          );
        const archivedVersion = currentVersion + 1;
        // Lifecycle maintenance must not make old content appear newer than
        // the fact that superseded it, including after a later undo.
        const changed = this.#database
          .prepare(
            `UPDATE memory_items SET lifecycle_state='archived', version=version+1
             WHERE item_id=? AND version=? AND lifecycle_state='active' AND origin='agent_extracted'
               AND NOT EXISTS(SELECT 1 FROM execution_learning_items e
                 WHERE e.item_id=memory_items.item_id)`,
          )
          .run(selected.itemId, selected.expectedVersion);
        assertChanged(changed.changes, selected.itemId);
        receiptItems.push({
          itemId: selected.itemId,
          fromVersion: selected.expectedVersion,
          archivedVersion,
          reason: selected.reason,
        });
        this.#options.failpoint?.(
          index === archive.length - 1 ? "before_operation_write" : "after_item_write",
        );
      }

      const receipt: MemoryConsolidationReceipt = {
        batchId,
        status: "undoable",
        consideredCount: claimedItems.length,
        changes: receiptItems.length,
        createdAt: now,
        expiresAt: now + MEMORY_CONSOLIDATION_UNDO_WINDOW_MS,
        items: receiptItems,
      };
      if (!Number.isSafeInteger(receipt.expiresAt))
        throw new Error("Memory consolidation undo expiry exceeds safe integer range");
      this.#database
        .prepare(
          `INSERT INTO memory_consolidation_receipts(
             operation_id, request_hash, claim_id, committed_at, undo_expires_at, undone_at, result_json
           ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(batchId, requestHash, claimId, now, receipt.expiresAt, JSON.stringify(receipt));
      this.#database
        .prepare(
          `INSERT INTO memory_write_operations(
             operation_id, operation_type, request_hash, result_json, committed_at
           ) VALUES (?, 'batch', ?, '[]', ?)`,
        )
        .run(internalOperationId, requestHash, now);
      this.#database
        .prepare(
          `UPDATE memory_consolidation_state SET last_committed_at=?,
             lease_id=NULL, lease_owner=NULL, lease_until=0, lease_items_json='[]'
           WHERE singleton=1 AND lease_id=? AND lease_owner=? AND fencing_token=?`,
        )
        .run(now, claimId, ownerId, fencingToken);
      this.#database.exec("COMMIT");
      return receipt;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async listMemoryConsolidationHistory(input: {
    readonly now: number;
  }): Promise<readonly MemoryConsolidationReceipt[]> {
    this.#assertOpen();
    const now = normalizeTimestamp(input.now, "now");
    const cutoff = Math.max(0, now - MEMORY_CONSOLIDATION_UNDO_WINDOW_MS);
    return this.#readSnapshot(() =>
      this.#database
        .prepare(
          `SELECT operation_id, request_hash, committed_at, undo_expires_at, undone_at, result_json
           FROM memory_consolidation_receipts
           WHERE committed_at >= ? AND committed_at <= ?
             AND (undo_expires_at > ? OR undone_at IS NOT NULL)
           ORDER BY committed_at DESC, operation_id ASC`,
        )
        .all(cutoff, now, now)
        .map((row) => decodeMemoryConsolidationReceipt(row as Record<string, unknown>))
        .filter((receipt) => receipt.changes > 0),
    );
  }

  async undoMemoryConsolidation(
    input: UndoMemoryConsolidationRequest,
  ): Promise<UndoMemoryConsolidationResult> {
    this.#assertOpen();
    const batchId = normalizeIdentifier(input.batchId, "batchId");
    const now = normalizeTimestamp(input.now, "now");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#readMemoryConsolidationReceiptRow(batchId);
      if (!row) {
        this.#database.exec("COMMIT");
        return { status: "not_found", batchId };
      }
      const receipt = decodeMemoryConsolidationReceipt(row);
      const undoneAt = nullableNonNegativeInteger(row.undone_at, "undone_at");
      if (undoneAt !== null) {
        this.#database.exec("COMMIT");
        return { status: "already_undone", receipt };
      }
      if (now >= receipt.expiresAt) {
        this.#database.exec("COMMIT");
        return { status: "expired", receipt };
      }

      const conflicts: Array<{
        itemId: string;
        expectedVersion: number;
        actualVersion?: number;
        reason: "missing" | "version_changed" | "not_archived" | "ineligible";
      }> = [];
      for (const item of receipt.items) {
        const current = this.#database
          .prepare(
            `SELECT i.version, i.updated_at, i.lifecycle_state
             FROM memory_items i WHERE i.item_id=?`,
          )
          .get(item.itemId) as
          | {
              version: unknown;
              updated_at: unknown;
              lifecycle_state: unknown;
            }
          | undefined;
        if (!current) {
          conflicts.push({
            itemId: item.itemId,
            expectedVersion: item.archivedVersion,
            reason: "missing",
          });
          continue;
        }
        const currentVersion = requiredPositiveInteger(current.version, "version");
        const currentRecord = this.#readItemRecord(item.itemId);
        if (currentVersion !== item.archivedVersion) {
          conflicts.push({
            itemId: item.itemId,
            expectedVersion: item.archivedVersion,
            actualVersion: currentVersion,
            reason: "version_changed",
          });
        } else if (current.lifecycle_state !== "archived") {
          conflicts.push({
            itemId: item.itemId,
            expectedVersion: item.archivedVersion,
            actualVersion: currentVersion,
            reason: "not_archived",
          });
        } else if (!currentRecord || !hasMemoryConsolidationEligibleMetadata(currentRecord)) {
          conflicts.push({
            itemId: item.itemId,
            expectedVersion: item.archivedVersion,
            actualVersion: currentVersion,
            reason: "ineligible",
          });
        }
      }
      if (conflicts.length) {
        this.#database.exec("COMMIT");
        return { status: "conflict", batchId, conflicts };
      }

      const undoOperationId = memoryConsolidationOperationId(batchId, "undo");
      const undoRequestHash = hashCanonical({ batchId, action: "undo", items: receipt.items });
      if (this.#readOperationRow(undoOperationId))
        throw new MemoryItemStoreConflictError(
          "operation_reused",
          "Memory consolidation undo operation identity is already in use",
        );
      for (const item of receipt.items) {
        const changed = this.#database
          .prepare(
            `UPDATE memory_items SET lifecycle_state='active', version=version+1
             WHERE item_id=? AND version=? AND lifecycle_state='archived' AND origin='agent_extracted'
               AND NOT EXISTS(SELECT 1 FROM execution_learning_items e
                 WHERE e.item_id=memory_items.item_id)`,
          )
          .run(item.itemId, item.archivedVersion);
        assertChanged(changed.changes, item.itemId);
      }
      const undone: MemoryConsolidationReceipt = {
        ...receipt,
        status: "undone",
        undoneAt: now,
      };
      this.#database
        .prepare(
          "UPDATE memory_consolidation_receipts SET undone_at=?, result_json=? WHERE operation_id=? AND undone_at IS NULL",
        )
        .run(now, JSON.stringify(undone), batchId);
      this.#database
        .prepare(
          `INSERT INTO memory_write_operations(
             operation_id, operation_type, request_hash, result_json, committed_at
           ) VALUES (?, 'batch', ?, '[]', ?)`,
        )
        .run(undoOperationId, undoRequestHash, now);
      this.#database.exec("COMMIT");
      return { status: "undone", receipt: undone };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async listItems(input: {
    workspaceKey: string;
    includeArchived?: boolean;
    limit?: number;
    learningVersion?: 2;
  }): Promise<readonly MemoryItemRecord[]> {
    this.#assertOpen();
    const workspaceKey = normalizeIdentifier(input.workspaceKey, "workspaceKey");
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Memory list limit must be between 1 and 1000");
    if (input.includeArchived !== undefined && typeof input.includeArchived !== "boolean")
      throw new Error("includeArchived must be boolean");
    return this.#readSnapshot(() => {
      const rows = this.#database
        .prepare(
          `SELECT item_id FROM memory_items
        WHERE (scope_type = 'global' OR (scope_type = 'workspace' AND scope_key = ?))
          AND ${input.includeArchived ? "1=1" : "lifecycle_state = 'active'"}
          AND ${input.learningVersion === 2 ? "1=1" : "NOT EXISTS (SELECT 1 FROM execution_learning_items e WHERE e.item_id=memory_items.item_id AND e.source_type='reviewed-reference')"}
        ORDER BY updated_at DESC, item_id ASC LIMIT ?`,
        )
        .all(workspaceKey, limit) as { item_id: string }[];
      return rows.map((row) => this.#requireItemRecord(row.item_id));
    });
  }

  async listItemsPage(input: {
    workspaceKey: string;
    lifecycleStates?: readonly MemoryItem["lifecycleState"][];
    kinds?: readonly MemoryItem["kind"][];
    cursor?: string;
    limit?: number;
    learningVersion?: 2;
  }): Promise<MemoryItemListPage> {
    this.#assertOpen();
    const workspaceKey = normalizeIdentifier(input.workspaceKey, "workspaceKey");
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new MemoryItemListCursorError("Memory list limit must be between 1 and 1000");
    const states = normalizeListFilter(input.lifecycleStates, isMemoryLifecycleState);
    const kinds = normalizeListFilter(input.kinds, isMemoryItemKind);
    const binding = hashText(
      JSON.stringify([workspaceKey, states, kinds, input.learningVersion ?? 1]),
    );
    const cursor = input.cursor === undefined ? undefined : decodeListCursor(input.cursor);
    if (cursor && cursor.binding !== binding)
      throw new MemoryItemListCursorError("Memory cursor does not match this workspace or filter");
    const conditions = ["(scope_type = 'global' OR (scope_type = 'workspace' AND scope_key = ?))"];
    if (input.learningVersion !== 2)
      conditions.push(
        "NOT EXISTS (SELECT 1 FROM execution_learning_items e WHERE e.item_id=memory_items.item_id AND e.source_type='reviewed-reference')",
      );
    const parameters: Array<string | number> = [workspaceKey];
    if (states !== undefined) {
      conditions.push(states.length ? `lifecycle_state IN (${placeholders(states.length)})` : "0");
      parameters.push(...states);
    }
    if (kinds !== undefined) {
      conditions.push(kinds.length ? `kind IN (${placeholders(kinds.length)})` : "0");
      parameters.push(...kinds);
    }
    return this.#readSnapshot(() => {
      const revision =
        (
          this.#database
            .prepare("SELECT count(*) AS revision FROM memory_write_operations")
            .get() as {
            revision: number;
          }
        ).revision + (input.learningVersion === 2 ? this.executionLearning.readRevision() : 0);
      if (cursor && cursor.revision !== revision)
        throw new MemoryItemStoreConflictError("version_conflict", "Memory list changed; refresh");
      const counts = this.#database
        .prepare(
          `SELECT count(*) AS total,
            coalesce(sum(lifecycle_state = 'active'), 0) AS active,
            coalesce(sum(lifecycle_state = 'archived'), 0) AS archived
           FROM memory_items WHERE ${conditions.join(" AND ")}`,
        )
        .get(...parameters) as MemoryItemListPage["pageInfo"]["counts"];
      const pageConditions = [...conditions];
      const pageParameters = [...parameters];
      if (cursor) {
        pageConditions.push("(updated_at < ? OR (updated_at = ? AND item_id > ?))");
        pageParameters.push(cursor.updatedAt, cursor.updatedAt, cursor.itemId);
      }
      const rows = this.#database
        .prepare(
          `SELECT * FROM memory_items WHERE ${pageConditions.join(" AND ")}
           ORDER BY updated_at DESC, item_id ASC LIMIT ?`,
        )
        .all(...pageParameters, limit + 1) as unknown as MemoryItemRow[];
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => {
        const item = decodeItem(row);
        const sourceCount = (
          this.#database
            .prepare("SELECT count(*) AS count FROM memory_item_sources WHERE item_id = ?")
            .get(item.itemId) as { count: number }
        ).count;
        const firstSource = this.#database
          .prepare(
            `SELECT session_id, run_id, turn_id, event_id FROM memory_item_sources
             WHERE item_id = ? ORDER BY event_id ASC LIMIT 1`,
          )
          .get(item.itemId) as MemorySourceRow | undefined;
        return {
          item,
          sourceCount,
          ...this.executionLearning.readItemAcceptance(item.itemId, item.contentHash),
          ...(firstSource ? { firstSource: decodeSource(firstSource) } : {}),
        };
      });
      const cursors = items.map(({ item }) =>
        Buffer.from(
          JSON.stringify({
            version: 1,
            binding,
            revision,
            updatedAt: item.updatedAt,
            itemId: item.itemId,
          }),
        ).toString("base64url"),
      );
      return {
        items,
        pageInfo: {
          revision,
          counts: { ...counts },
          ...(hasMore ? { nextCursor: cursors.at(-1)! } : {}),
        },
        cursors,
      };
    });
  }

  async readSettings(workspaceKey: string): Promise<AtomicMemorySettings> {
    this.#assertOpen();
    return this.#readSnapshot(() =>
      this.#readSettings(normalizeIdentifier(workspaceKey, "workspaceKey")),
    );
  }

  #readSettings(workspaceKey: string): AtomicMemorySettings {
    const row = this.#database
      .prepare("SELECT * FROM memory_settings WHERE workspace_key = ?")
      .get("__pico_user_memory_settings__") as
      | { version: number; enabled: number; auto_extract: number; recall_enabled: number }
      | undefined;
    return row
      ? {
          workspaceKey,
          version: row.version,
          enabled: row.enabled === 1,
          autoExtract: row.auto_extract === 1,
          recallEnabled: row.recall_enabled === 1,
        }
      : { workspaceKey, version: 1, enabled: true, autoExtract: true, recallEnabled: true };
  }

  async updateSettings(input: {
    workspaceKey: string;
    expectedVersion: number;
    enabled?: boolean;
    autoExtract?: boolean;
    recallEnabled?: boolean;
  }): Promise<AtomicMemorySettings> {
    this.#assertOpen();
    const workspaceKey = normalizeIdentifier(input.workspaceKey, "workspaceKey");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
      throw new Error("Invalid settings expectedVersion");
    for (const value of [input.enabled, input.autoExtract, input.recallEnabled]) {
      if (value !== undefined && typeof value !== "boolean")
        throw new Error("Memory settings must be boolean");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#readSettings(workspaceKey);
      if (current.version !== input.expectedVersion)
        throw new MemoryItemStoreConflictError(
          "version_conflict",
          "Memory settings version changed",
        );
      const next = {
        workspaceKey,
        version: current.version + 1,
        enabled: input.enabled ?? current.enabled,
        autoExtract: input.autoExtract ?? current.autoExtract,
        recallEnabled: input.recallEnabled ?? current.recallEnabled,
      };
      this.#database
        .prepare(
          `INSERT INTO memory_settings (workspace_key, version, enabled, auto_extract, recall_enabled)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_key) DO UPDATE SET version=excluded.version,
        enabled=excluded.enabled, auto_extract=excluded.auto_extract, recall_enabled=excluded.recall_enabled`,
        )
        .run(
          "__pico_user_memory_settings__",
          next.version,
          Number(next.enabled),
          Number(next.autoExtract),
          Number(next.recallEnabled),
        );
      // Remove obsolete project preferences atomically with the user-wide save.
      this.#database
        .prepare("DELETE FROM memory_settings WHERE workspace_key != ?")
        .run("__pico_user_memory_settings__");
      this.#database.exec("COMMIT");
      return next;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async readDeletionRevision(): Promise<number> {
    this.#assertOpen();
    return this.#deletionRevision();
  }

  #deletionRevision(): number {
    // Delete receipts are append-only; retries do not increment this generation.
    const row = this.#database
      .prepare(
        "SELECT count(*) AS revision FROM memory_write_operations WHERE operation_type = 'delete'",
      )
      .get()!;
    return requiredNonNegativeInteger(row.revision, "deletion revision");
  }

  #assertDeletionRevision(expected: number): void {
    const revision = requiredNonNegativeInteger(expected, "expectedDeletionRevision");
    if (revision !== this.#deletionRevision()) {
      throw new MemoryItemStoreConflictError(
        "deletion_conflict",
        "Memory was deleted after this extraction was captured",
      );
    }
  }

  #assertNotDeleteOperation(operationId: string): void {
    if (this.#readOperationRow(operationId)?.operation_type === "delete") {
      throw new MemoryItemStoreConflictError(
        "operation_reused",
        "Operation already deleted a Memory Item",
      );
    }
  }

  async deleteItem(input: {
    itemId: string;
    expectedVersion: number;
    operationId: string;
  }): Promise<void> {
    this.#assertOpen();
    const itemId = normalizeIdentifier(input.itemId, "itemId");
    const operationId = normalizeIdentifier(input.operationId, "operationId");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
      throw new Error("Invalid expectedVersion");
    const requestHash = hashCanonical({ itemId, expectedVersion: input.expectedVersion });
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.#readOperationRow(operationId);
      if (previous) {
        if (previous.operation_type !== "delete" || previous.request_hash !== requestHash)
          throw new MemoryItemStoreConflictError("operation_reused", "Delete operation was reused");
        this.#database.exec("COMMIT");
        this.#checkpointAfterDelete();
        return;
      }
      if (
        this.#readOperationRow(operationId) ||
        this.#database
          .prepare("SELECT 1 FROM memory_extraction_failures WHERE first_operation_id = ?")
          .get(operationId)
      ) {
        throw new MemoryItemStoreConflictError(
          "operation_reused",
          "Memory operation already exists",
        );
      }
      this.#requireVersion(itemId, input.expectedVersion);
      if (
        this.#database
          .prepare(
            "SELECT 1 FROM execution_learning_items WHERE item_id=? AND source_type='reviewed-reference'",
          )
          .get(itemId)
      )
        throw new Error("Reviewed task experience must be deleted through experience review");
      // Operation results contain only IDs, versions and lifecycle metadata. Extraction
      // receipts also contain requested prose: redact every historical copy atomically.
      const receipts = this.#database
        .prepare("SELECT * FROM memory_extraction_receipts")
        .all() as unknown as MemoryExtractionReceiptRow[];
      for (const row of receipts) {
        const receipt = decodeExtractionReceipt(row);
        const requestedItems = receipt.requestedItems.filter((item) => item.itemId !== itemId);
        if (requestedItems.length === receipt.requestedItems.length) continue;
        const redacted = {
          ...receipt,
          requestedItems,
          status:
            receipt.status === "remembered" && requestedItems.length === 0
              ? "not_applicable"
              : receipt.status,
        };
        this.#database
          .prepare("UPDATE memory_extraction_receipts SET result_json = ? WHERE operation_id = ?")
          .run(JSON.stringify(redacted), receipt.operationId);
      }
      const deletedAt = (this.#options.now ?? Date.now)();
      // Resolve provenance before the item's foreign-key cascade removes its mapping.
      this.executionLearning.invalidateItem(itemId, deletedAt);
      this.#database.prepare("DELETE FROM memory_items WHERE item_id = ?").run(itemId);
      scrubExperienceLedger(this.#database, { itemId }, deletedAt);
      this.#options.failpoint?.("after_item_write");
      this.#options.failpoint?.("before_operation_write");
      this.#database
        .prepare(
          `INSERT INTO memory_write_operations
          (operation_id, operation_type, request_hash, result_json, committed_at)
          VALUES (?, 'delete', ?, '[]', ?)`,
        )
        .run(
          operationId,
          requestHash,
          normalizeTimestamp((this.#options.now ?? Date.now)(), "current time"),
        );
      this.#database.exec("COMMIT");
      this.#checkpointAfterDelete();
      this.#options.failpoint?.("after_commit");
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  #checkpointAfterDelete(): void {
    // secure_delete clears database pages; checkpoint also retires old WAL prose.
    // Another connection may hold a reader. The committed logical delete remains
    // authoritative, and repeating the same delete operation retries checkpoint.
    try {
      this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Do not report a committed delete as rolled back because a reader is busy.
    }
  }

  async readOperation(operationId: string): Promise<MemoryWriteOperationResult | undefined> {
    this.#assertOpen();
    const row = this.#readOperationRow(normalizeIdentifier(operationId, "operationId"));
    return row ? decodeOperation(row) : undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #applyMutation(
    mutation: NormalizedMutation,
    mutationIndex: number,
    committedAt: number,
  ): MemoryMutationResult {
    switch (mutation.type) {
      case "create":
        return this.#createItem(mutation.item, mutationIndex, committedAt);
      case "update":
        return this.#updateItem(mutation, mutationIndex, committedAt);
      case "archive":
        return this.#changeLifecycle(mutation, mutationIndex, committedAt, "archived");
      case "restore":
        return this.#changeLifecycle(mutation, mutationIndex, committedAt, "active");
    }
  }

  #createItem(
    write: NormalizedMemoryWrite,
    mutationIndex: number,
    committedAt: number,
  ): MemoryMutationResult {
    const itemId = normalizeIdentifier(
      (this.#options.idFactory ?? randomUUID)(),
      "generated itemId",
    );
    this.#database
      .prepare(
        `INSERT INTO memory_items(
           item_id, version, content, kind, statement_type, temporal_type,
           scope_type, scope_key, event_started_at, event_ended_at, observed_at,
           lifecycle_state, origin, content_hash, created_at, updated_at
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        itemId,
        write.content,
        write.kind,
        write.statementType,
        write.temporalType,
        write.scopeType,
        write.scopeKey,
        write.eventStartedAt,
        write.eventEndedAt,
        write.observedAt,
        write.origin,
        write.contentHash,
        committedAt,
        committedAt,
      );
    this.#options.failpoint?.("after_item_write");
    this.#replaceKeys(itemId, write.keys);
    this.#options.failpoint?.("after_keys_write");
    this.#replaceSources(itemId, write.sources);
    this.#options.failpoint?.("after_sources_write");
    return mutationResult(mutationIndex, "create", this.#requireItemRecord(itemId).item, "created");
  }

  #updateItem(
    mutation: Extract<NormalizedMutation, { type: "update" }>,
    mutationIndex: number,
    committedAt: number,
  ): MemoryMutationResult {
    const current = this.#requireVersion(mutation.itemId, mutation.expectedVersion);
    const currentRecord = this.#requireItemRecord(mutation.itemId);
    if (currentRecord.sourceType === "reviewed-reference")
      throw new MemoryItemStoreConflictError(
        "version_conflict",
        "Reviewed task experience must be edited through experience review",
        mutation.itemId,
      );
    if (!currentRecord.sourceType && recordMatchesWrite(currentRecord, mutation.item)) {
      return mutationResult(mutationIndex, "update", current, "noop");
    }
    const updatedAt = Math.max(committedAt, current.updatedAt);
    this.executionLearning.invalidateItem(
      mutation.itemId,
      updatedAt,
      mutation.item.origin === "user_requested" && mutation.item.sources.length === 0,
    );
    const result = this.#database
      .prepare(
        `UPDATE memory_items
         SET version = version + 1,
             content = ?, kind = ?, statement_type = ?, temporal_type = ?,
             scope_type = ?, scope_key = ?, event_started_at = ?, event_ended_at = ?,
             observed_at = ?, origin = ?, content_hash = ?, updated_at = ?
         WHERE item_id = ? AND version = ?`,
      )
      .run(
        mutation.item.content,
        mutation.item.kind,
        mutation.item.statementType,
        mutation.item.temporalType,
        mutation.item.scopeType,
        mutation.item.scopeKey,
        mutation.item.eventStartedAt,
        mutation.item.eventEndedAt,
        mutation.item.observedAt,
        mutation.item.origin,
        mutation.item.contentHash,
        updatedAt,
        mutation.itemId,
        mutation.expectedVersion,
      );
    assertChanged(result.changes, mutation.itemId);
    this.#options.failpoint?.("after_item_write");
    this.#replaceKeys(mutation.itemId, mutation.item.keys);
    this.#options.failpoint?.("after_keys_write");
    this.#replaceSources(mutation.itemId, mutation.item.sources);
    this.#options.failpoint?.("after_sources_write");
    return mutationResult(
      mutationIndex,
      "update",
      this.#requireItemRecord(mutation.itemId).item,
      "updated",
    );
  }

  #changeLifecycle(
    mutation: Extract<NormalizedMutation, { type: "archive" | "restore" }>,
    mutationIndex: number,
    committedAt: number,
    target: MemoryItem["lifecycleState"],
  ): MemoryMutationResult {
    const current = this.#requireVersion(mutation.itemId, mutation.expectedVersion);
    if (this.#requireItemRecord(mutation.itemId).sourceType === "reviewed-reference")
      throw new MemoryItemStoreConflictError(
        "version_conflict",
        "Reviewed task experience lifecycle must be managed through experience review",
        mutation.itemId,
      );
    const expected = target === "archived" ? "active" : "archived";
    if (current.lifecycleState !== expected) {
      throw new MemoryItemStoreConflictError(
        "invalid_lifecycle_transition",
        `Memory Item ${mutation.itemId} is ${current.lifecycleState}, expected ${expected}`,
        mutation.itemId,
      );
    }
    const updatedAt = Math.max(committedAt, current.updatedAt);
    const result = this.#database
      .prepare(
        `UPDATE memory_items
         SET version = version + 1, lifecycle_state = ?, updated_at = ?
         WHERE item_id = ? AND version = ? AND lifecycle_state = ?`,
      )
      .run(target, updatedAt, mutation.itemId, mutation.expectedVersion, expected);
    assertChanged(result.changes, mutation.itemId);
    this.#options.failpoint?.("after_item_write");
    return mutationResult(
      mutationIndex,
      mutation.type,
      this.#requireItemRecord(mutation.itemId).item,
      target === "active" ? "restored" : "archived",
    );
  }

  #requireVersion(itemId: string, expectedVersion: number): MemoryItem {
    const record = this.#readItemRecord(itemId);
    if (!record) {
      throw new MemoryItemStoreConflictError(
        "item_not_found",
        `Memory Item ${itemId} does not exist`,
        itemId,
      );
    }
    if (record.item.version !== expectedVersion) {
      throw new MemoryItemStoreConflictError(
        "version_conflict",
        `Memory Item ${itemId} is version ${record.item.version}, expected ${expectedVersion}`,
        itemId,
      );
    }
    return record.item;
  }

  #replaceKeys(itemId: string, keys: readonly MemoryItemKey[]): void {
    this.#database.prepare("DELETE FROM memory_item_keys WHERE item_id = ?").run(itemId);
    const insert = this.#database.prepare(
      `INSERT INTO memory_item_keys(item_id, key_text, normalized_key, key_type, key_origin)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const key of keys) {
      insert.run(itemId, key.key, key.normalizedKey, key.keyType, key.keyOrigin);
    }
  }

  #replaceSources(itemId: string, sources: readonly MemoryItemSource[]): void {
    this.#database.prepare("DELETE FROM memory_item_sources WHERE item_id = ?").run(itemId);
    const insert = this.#database.prepare(
      `INSERT INTO memory_item_sources(item_id, session_id, run_id, turn_id, event_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const source of sources) {
      insert.run(itemId, source.sessionId, source.runId, source.turnId, source.eventId);
    }
  }

  #readItemRecord(itemId: string): MemoryItemRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM memory_items WHERE item_id = ?")
      .get(itemId) as MemoryItemRow | undefined;
    if (!row) return undefined;
    const keys = this.#database
      .prepare(
        `SELECT key_text, normalized_key, key_type, key_origin
         FROM memory_item_keys WHERE item_id = ? ORDER BY normalized_key ASC
         LIMIT ${MAX_KEYS_PER_ITEM + 1}`,
      )
      .all(itemId) as unknown as MemoryKeyRow[];
    const sources = this.#database
      .prepare(
        `SELECT session_id, run_id, turn_id, event_id
         FROM memory_item_sources WHERE item_id = ? ORDER BY event_id ASC
         LIMIT ${MAX_SOURCES_PER_ITEM + 1}`,
      )
      .all(itemId) as unknown as MemorySourceRow[];
    assertChildCardinality("keys", keys.length, MAX_KEYS_PER_ITEM);
    if (sources.length > 0 || row.origin !== "user_requested") {
      assertChildCardinality("sources", sources.length, MAX_SOURCES_PER_ITEM);
    }
    const item = decodeItem(row);
    return {
      item,
      keys: keys.map(decodeKey),
      sources: sources.map(decodeSource),
      ...this.executionLearning.readItemAcceptance(item.itemId, item.contentHash),
    };
  }

  #requireItemRecord(itemId: string): MemoryItemRecord {
    const record = this.#readItemRecord(itemId);
    if (!record) throw new Error(`Memory Item ${itemId} disappeared during transaction`);
    return record;
  }

  #readOperationRow(operationId: string): MemoryOperationRow | undefined {
    return this.#database
      .prepare(
        `SELECT operation_id, operation_type, request_hash, result_json, committed_at
         FROM memory_write_operations WHERE operation_id = ?`,
      )
      .get(operationId) as MemoryOperationRow | undefined;
  }

  #readExtractionCursorRow(sessionId: string): MemoryExtractionCursorRow | undefined {
    return this.#database
      .prepare(
        `SELECT session_id, processed_ordinal, updated_at
         FROM memory_extraction_cursors WHERE session_id = ?`,
      )
      .get(sessionId) as MemoryExtractionCursorRow | undefined;
  }

  #readPendingExtractionFailureRow(sessionId: string): MemoryExtractionFailureRow | undefined {
    return this.#database
      .prepare(
        `SELECT session_id, from_ordinal, through_ordinal, coverage_hash,
                first_operation_id, first_trigger, compaction_checkpoint_id,
                first_failure_class, failed_at, deletion_revision
         FROM memory_extraction_failures WHERE session_id = ?`,
      )
      .get(sessionId) as MemoryExtractionFailureRow | undefined;
  }

  #readExtractionReceiptRow(operationId: string): MemoryExtractionReceiptRow | undefined {
    return this.#database
      .prepare(
        `SELECT operation_id, session_id, request_hash, result_json, committed_at
         FROM memory_extraction_receipts WHERE operation_id = ?`,
      )
      .get(operationId) as MemoryExtractionReceiptRow | undefined;
  }

  #readMemoryConsolidationReceiptRow(batchId: string): Record<string, unknown> | undefined {
    return this.#database
      .prepare(
        `SELECT operation_id, request_hash, claim_id, committed_at, undo_expires_at,
                undone_at, result_json
         FROM memory_consolidation_receipts WHERE operation_id=?`,
      )
      .get(batchId) as Record<string, unknown> | undefined;
  }

  #ownsMemoryConsolidationLease(
    claimId: string,
    ownerId: string,
    fencingToken: number,
    now?: number,
  ): boolean {
    const row = this.#database
      .prepare(
        `SELECT lease_id, lease_owner, lease_until, fencing_token
         FROM memory_consolidation_state WHERE singleton=1`,
      )
      .get() as Record<string, unknown> | undefined;
    if (
      !row ||
      row.lease_id !== claimId ||
      row.lease_owner !== ownerId ||
      requiredNonNegativeInteger(row.fencing_token, "fencing_token") !== fencingToken
    )
      return false;
    return now === undefined || requiredNonNegativeInteger(row.lease_until, "lease_until") > now;
  }

  #clearMemoryConsolidationLease(): void {
    this.#database
      .prepare(
        `UPDATE memory_consolidation_state
         SET lease_id=NULL, lease_owner=NULL, lease_until=0, lease_items_json='[]'
         WHERE singleton=1`,
      )
      .run();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLite Memory Item Store is closed");
  }

  #readSnapshot<T>(operation: () => T): T {
    this.#database.exec("BEGIN");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }
}

function loadDatabaseSync(): typeof import("node:sqlite").DatabaseSync {
  return (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
}

function isMemoryConsolidationEligible(record: MemoryItemRecord): boolean {
  return hasMemoryConsolidationEligibleMetadata(record) && record.item.lifecycleState === "active";
}

function hasMemoryConsolidationEligibleMetadata(record: MemoryItemRecord): boolean {
  return (
    record.item.origin === "agent_extracted" &&
    record.sourceType === undefined &&
    record.taskExperience === undefined
  );
}

function normalizeMemoryConsolidationArchive(
  value: readonly MemoryConsolidationArchiveInput[],
): MemoryConsolidationArchiveInput[] {
  if (!Array.isArray(value) || value.length > MAX_MEMORY_CONSOLIDATION_CANDIDATES)
    throw new Error(
      `Memory consolidation accepts at most ${MAX_MEMORY_CONSOLIDATION_CANDIDATES} Items`,
    );
  const seen = new Set<string>();
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object")
        throw new Error("Invalid Memory consolidation archive entry");
      const itemId = normalizeIdentifier(entry.itemId, "itemId");
      const expectedVersion = normalizeVersion(entry.expectedVersion);
      const reason = normalizeMemoryConsolidationArchiveReason(entry.reason);
      if (seen.has(itemId)) throw new Error(`Memory Item ${itemId} is repeated in archive batch`);
      seen.add(itemId);
      return { itemId, expectedVersion, reason };
    })
    .sort((left, right) => compareText(left.itemId, right.itemId));
}

function normalizeMemoryConsolidationArchiveReason(
  value: unknown,
): MemoryConsolidationArchiveReason {
  if (value !== "duplicate" && value !== "superseded" && value !== "stale" && value !== "low_value")
    throw new Error("Invalid Memory consolidation archive reason");
  return value;
}

function decodeMemoryConsolidationClaimItems(value: unknown): Array<{
  itemId: string;
  expectedVersion: number;
}> {
  const json = requiredString(value, "lease_items_json");
  if (json.length > MAX_MEMORY_CONSOLIDATION_JSON_CODE_UNITS)
    throw invalidColumn("lease_items_json");
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    throw invalidColumn("lease_items_json");
  }
  if (!Array.isArray(decoded) || decoded.length > MAX_MEMORY_CONSOLIDATION_CANDIDATES)
    throw invalidColumn("lease_items_json");
  const seen = new Set<string>();
  return decoded.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw invalidColumn("lease_items_json");
    const record = entry as Record<string, unknown>;
    const itemId = requiredIdentifierString(record.itemId, "lease itemId");
    const expectedVersion = requiredPositiveInteger(
      record.expectedVersion,
      "lease expectedVersion",
    );
    if (seen.has(itemId)) throw invalidColumn("lease_items_json");
    seen.add(itemId);
    return { itemId, expectedVersion };
  });
}

function decodeMemoryConsolidationReceipt(
  row: Record<string, unknown>,
): MemoryConsolidationReceipt {
  const batchId = requiredIdentifierString(row.operation_id, "operation_id");
  requiredHash(row.request_hash, "request_hash");
  const committedAt = requiredNonNegativeInteger(row.committed_at, "committed_at");
  const expiresAt = requiredNonNegativeInteger(row.undo_expires_at, "undo_expires_at");
  const undoneAt = nullableNonNegativeInteger(row.undone_at, "undone_at");
  const encoded = requiredString(row.result_json, "result_json");
  if (encoded.length > MAX_MEMORY_CONSOLIDATION_JSON_CODE_UNITS) throw invalidColumn("result_json");
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw invalidColumn("result_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidColumn("result_json");
  const receipt = value as Record<string, unknown>;
  if (
    receipt.batchId !== batchId ||
    receipt.createdAt !== committedAt ||
    receipt.expiresAt !== expiresAt ||
    receipt.status !== (undoneAt === null ? "undoable" : "undone")
  )
    throw invalidColumn("result_json");
  const consideredCount = requiredNonNegativeInteger(receipt.consideredCount, "consideredCount");
  const changes = requiredNonNegativeInteger(receipt.changes, "changes");
  if (
    changes > consideredCount ||
    !Array.isArray(receipt.items) ||
    receipt.items.length !== changes
  )
    throw invalidColumn("result_json");
  const seen = new Set<string>();
  const items = receipt.items.map((value): MemoryConsolidationArchivedItem => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw invalidColumn("result_json");
    const item = value as Record<string, unknown>;
    const itemId = requiredIdentifierString(item.itemId, "itemId");
    const fromVersion = requiredPositiveInteger(item.fromVersion, "fromVersion");
    const archivedVersion = requiredPositiveInteger(item.archivedVersion, "archivedVersion");
    if (archivedVersion !== fromVersion + 1 || seen.has(itemId)) throw invalidColumn("result_json");
    seen.add(itemId);
    return {
      itemId,
      fromVersion,
      archivedVersion,
      reason: normalizeMemoryConsolidationArchiveReason(item.reason),
    };
  });
  return {
    batchId,
    status: undoneAt === null ? "undoable" : "undone",
    consideredCount,
    changes,
    createdAt: committedAt,
    expiresAt,
    ...(undoneAt !== null ? { undoneAt } : {}),
    items,
  };
}

function memoryConsolidationOperationId(batchId: string, action: "commit" | "undo"): string {
  return `memory-consolidation:${action}:${hashText(batchId)}`;
}

function normalizeListFilter<T extends string>(
  input: readonly T[] | undefined,
  accepts: (value: string) => boolean,
): readonly T[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string" || !accepts(value)))
    throw new MemoryItemListCursorError("Invalid Memory list filter");
  return [...new Set(input)].sort();
}

function decodeListCursor(value: string): MemoryListCursor {
  try {
    if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(value))
      throw new Error("Invalid cursor encoding");
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as MemoryListCursor;
    if (
      !cursor ||
      Object.keys(cursor).sort().join(",") !== "binding,itemId,revision,updatedAt,version" ||
      cursor.version !== 1 ||
      typeof cursor.binding !== "string" ||
      !/^[a-f0-9]{64}$/u.test(cursor.binding) ||
      !Number.isSafeInteger(cursor.revision) ||
      cursor.revision < 0 ||
      !Number.isSafeInteger(cursor.updatedAt) ||
      cursor.updatedAt < 0 ||
      typeof cursor.itemId !== "string"
    )
      throw new Error("Invalid cursor fields");
    normalizeIdentifier(cursor.itemId, "itemId");
    return cursor;
  } catch {
    throw new MemoryItemListCursorError("Invalid Memory list cursor");
  }
}

export function buildSqliteMemoryKeySearchQuery(input: {
  readonly terms: readonly string[];
  readonly match: "exact" | "prefix";
  readonly workspaceKey?: string;
  readonly includeArchived: boolean;
  readonly limit: number;
}): SqliteMemoryKeySearchQuery {
  const parameters: Array<string | number> = [];
  let matchingKeysSql: string;
  if (input.match === "exact") {
    matchingKeysSql = `
      SELECT item_id, normalized_key AS matched_term
      FROM memory_item_keys INDEXED BY memory_item_keys_by_normalized_key
      WHERE normalized_key IN (${placeholders(input.terms.length)})`;
    parameters.push(...input.terms);
  } else {
    matchingKeysSql = input.terms
      .map((term, index) => {
        const upperBound = prefixUpperBound(term);
        parameters.push(term);
        if (upperBound) {
          parameters.push(upperBound);
          return `
            SELECT item_id, ${index} AS matched_term
            FROM memory_item_keys INDEXED BY memory_item_keys_by_normalized_key
            WHERE normalized_key >= ? AND normalized_key < ?`;
        }
        return `
          SELECT item_id, ${index} AS matched_term
          FROM memory_item_keys INDEXED BY memory_item_keys_by_normalized_key
          WHERE normalized_key >= ?`;
      })
      .join("\nUNION ALL\n");
  }
  const scopeClause = input.workspaceKey
    ? `(i.scope_type = 'global' OR (i.scope_type = 'workspace' AND i.scope_key = ?))`
    : `i.scope_type = 'global'`;
  if (input.workspaceKey) parameters.push(input.workspaceKey);
  parameters.push(input.limit);
  return {
    sql: `
      WITH matching_keys AS MATERIALIZED (
        ${matchingKeysSql}
      )
      SELECT i.item_id
      FROM matching_keys m
      JOIN memory_items i ON i.item_id = m.item_id
      WHERE ${scopeClause}
        AND ${input.includeArchived ? "1 = 1" : `i.lifecycle_state = 'active'`}
      GROUP BY i.item_id
      ORDER BY COUNT(DISTINCT m.matched_term) DESC, i.updated_at DESC, i.item_id ASC
      LIMIT ?`,
    parameters,
  };
}

function normalizeMutations(
  mutations: readonly MemoryItemMutation[],
): readonly NormalizedMutation[] {
  if (!Array.isArray(mutations) || mutations.length === 0) {
    throw new Error("Memory operation requires at least one mutation");
  }
  if (mutations.length > MAX_MUTATIONS_PER_OPERATION) {
    throw new Error(`Memory operation accepts at most ${MAX_MUTATIONS_PER_OPERATION} mutations`);
  }
  return mutations.map((mutation): NormalizedMutation => {
    if (!mutation || typeof mutation !== "object") throw new Error("Invalid Memory mutation");
    switch (mutation.type) {
      case "create":
        return { type: "create", item: normalizeWrite(mutation.item) };
      case "update":
        return {
          type: "update",
          itemId: normalizeIdentifier(mutation.itemId, "itemId"),
          expectedVersion: normalizeVersion(mutation.expectedVersion),
          item: normalizeWrite(mutation.item),
        };
      case "archive":
      case "restore":
        return {
          type: mutation.type,
          itemId: normalizeIdentifier(mutation.itemId, "itemId"),
          expectedVersion: normalizeVersion(mutation.expectedVersion),
        };
      default:
        throw new Error("Unknown Memory mutation type");
    }
  });
}

function normalizeExtractionItems(
  items: readonly MemoryItemWrite[],
): readonly NormalizedMemoryWrite[] {
  if (!Array.isArray(items)) throw new Error("Memory extraction items must be an array");
  if (items.length > MAX_MUTATIONS_PER_OPERATION) {
    throw new Error(`Memory extraction accepts at most ${MAX_MUTATIONS_PER_OPERATION} Items`);
  }
  return items.map(normalizeWrite);
}

function assertChildCardinality(child: "keys" | "sources", count: number, maximum: number): void {
  if (count < 1 || count > maximum) {
    throw new Error(
      `Invalid Memory Item ${child} cardinality: expected 1..${maximum}, got ${count}`,
    );
  }
}

function validateObservedAtForCommit(
  mutations: readonly NormalizedMutation[],
  committedAt: number,
): void {
  for (const mutation of mutations) {
    if (
      (mutation.type === "create" || mutation.type === "update") &&
      mutation.item.observedAt > committedAt
    ) {
      throw new Error("observedAt cannot be later than commit time");
    }
  }
}

function validateExtractionObservedAtForCommit(
  items: readonly NormalizedMemoryWrite[],
  committedAt: number,
): void {
  for (const item of items) {
    if (item.observedAt > committedAt) {
      throw new Error("observedAt cannot be later than commit time");
    }
  }
}

function normalizeWrite(input: MemoryItemWrite): NormalizedMemoryWrite {
  if (!input || typeof input !== "object") throw new Error("Memory Item write must be an object");
  const content = normalizeLongTermMemoryContent(input.content);
  if (!content.ok) throw new Error(content.message);
  if (!isMemoryItemKind(input.kind)) throw new Error("Invalid Memory Item kind");
  if (!isMemoryStatementType(input.statementType)) throw new Error("Invalid Memory statement type");
  if (!isMemoryTemporalType(input.temporalType)) throw new Error("Invalid Memory temporal type");
  if (!isMemoryScopeType(input.scopeType)) throw new Error("Invalid Memory scope type");
  if (!isMemoryItemOrigin(input.origin)) throw new Error("Invalid Memory Item origin");

  const scopeKey = normalizeScopeKey(input.scopeType, input.scopeKey);
  const eventStartedAt = normalizeOptionalTimestamp(input.eventStartedAt, "eventStartedAt");
  const eventEndedAt = normalizeOptionalTimestamp(input.eventEndedAt, "eventEndedAt");
  validateMemoryTemporalBounds({
    temporalType: input.temporalType,
    eventStartedAt,
    eventEndedAt,
  });
  const observedAt = normalizeTimestamp(input.observedAt, "observedAt");
  return {
    content: content.value,
    kind: input.kind,
    statementType: input.statementType,
    temporalType: input.temporalType,
    scopeType: input.scopeType,
    scopeKey,
    eventStartedAt,
    eventEndedAt,
    observedAt,
    origin: input.origin,
    contentHash: hashText(content.value),
    keys: normalizeKeys(input.keys),
    sources: normalizeSources(input.sources, input.origin === "user_requested"),
  };
}

function normalizeScopeKey(
  scopeType: MemoryItem["scopeType"],
  input: string | null | undefined,
): string | null {
  if (scopeType === "global") {
    if (input !== undefined && input !== null) {
      throw new Error("Global Memory Item cannot have a scopeKey");
    }
    return null;
  }
  return normalizeIdentifier(input, "workspace scopeKey");
}

function normalizeKeys(input: readonly MemoryItemKeyInput[]): readonly MemoryItemKey[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Memory Item requires at least one search key");
  }
  if (input.length > MAX_KEYS_PER_ITEM) {
    throw new Error(`Memory Item accepts at most ${MAX_KEYS_PER_ITEM} search keys`);
  }
  const winners = new Map<string, MemoryItemKey>();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object") throw new Error("Invalid Memory search key");
    if (!isMemoryKeyType(candidate.keyType)) throw new Error("Invalid Memory key type");
    if (!isMemoryKeyOrigin(candidate.keyOrigin)) throw new Error("Invalid Memory key origin");
    const key = normalizeVisibleText(candidate.key, "Memory search key", MAX_KEY_CODE_POINTS);
    const normalized: MemoryItemKey = {
      key,
      normalizedKey: normalizeSearchTerm(key),
      keyType: candidate.keyType,
      keyOrigin: candidate.keyOrigin,
    };
    const existing = winners.get(normalized.normalizedKey);
    if (!existing || keyPriority(normalized) > keyPriority(existing)) {
      winners.set(normalized.normalizedKey, normalized);
    } else if (
      existing &&
      keyPriority(normalized) === keyPriority(existing) &&
      compareText(normalized.key, existing.key) < 0
    ) {
      winners.set(normalized.normalizedKey, normalized);
    }
  }
  return [...winners.values()].sort((left, right) =>
    compareText(left.normalizedKey, right.normalizedKey),
  );
}

function normalizeSources(
  input: readonly MemoryItemSource[],
  allowEmpty = false,
): readonly MemoryItemSource[] {
  if (!Array.isArray(input) || (!allowEmpty && input.length === 0)) {
    throw new Error("Memory Item requires at least one source Event");
  }
  if (input.length > MAX_SOURCES_PER_ITEM) {
    throw new Error(`Memory Item accepts at most ${MAX_SOURCES_PER_ITEM} sources`);
  }
  const sources = new Map<string, MemoryItemSource>();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object") throw new Error("Invalid Memory Item source");
    const source: MemoryItemSource = {
      sessionId: normalizeIdentifier(candidate.sessionId, "source sessionId"),
      runId: normalizeIdentifier(candidate.runId, "source runId"),
      turnId: normalizeIdentifier(candidate.turnId, "source turnId"),
      eventId: normalizeIdentifier(candidate.eventId, "source eventId"),
    };
    const existing = sources.get(source.eventId);
    if (existing && !sameSource(existing, source)) {
      throw new Error(`Source eventId ${source.eventId} has conflicting provenance`);
    }
    sources.set(source.eventId, source);
  }
  return [...sources.values()].sort((left, right) => compareText(left.eventId, right.eventId));
}

function sameSource(left: MemoryItemSource, right: MemoryItemSource): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.turnId === right.turnId &&
    left.eventId === right.eventId
  );
}

function normalizeIdentifier(input: unknown, name: string): string {
  if (typeof input !== "string") throw new Error(`${name} must be a string`);
  if (input.normalize("NFC") !== input || input.trim() !== input) {
    throw new Error(`${name} must already be NFC-normalized without surrounding whitespace`);
  }
  return normalizeVisibleText(input, name, MAX_IDENTIFIER_CODE_POINTS);
}

function normalizeVisibleText(input: unknown, name: string, maxCodePoints: number): string {
  if (typeof input !== "string") throw new Error(`${name} must be a string`);
  const value = input.normalize("NFC").trim();
  if (value === "") throw new Error(`${name} cannot be empty`);
  if (/[\p{Cc}\p{Cs}\u200B-\u200D\uFEFF]/u.test(value)) {
    throw new Error(`${name} cannot contain control or zero-width characters`);
  }
  if (Array.from(value).length > maxCodePoints) {
    throw new Error(`${name} must be ${maxCodePoints} code points or fewer`);
  }
  return value;
}

function normalizeSearchTerm(input: unknown): string {
  return normalizeVisibleText(input, "Memory search term", MAX_KEY_CODE_POINTS)
    .replace(/\s+/gu, " ")
    .toLowerCase();
}
/** Derived keys are bounded visible labels; raw task input may contain attachment markup. */
function taskExperienceSearchKeys(goal: string, content: string): readonly MemoryItemKeyInput[] {
  const keys = [goal, content]
    .map((value) =>
      Array.from(
        value
          .normalize("NFC")
          .replace(/pico:\/\/artifact\/[^\s)\]}>]*/giu, " ")
          .replace(/[\p{Cc}\p{Cs}]/gu, " ")
          .replace(/[\u200B-\u200D\uFEFF]/gu, "")
          .replace(/\s+/gu, " ")
          .trim(),
      )
        .slice(0, Math.min(512, MAX_KEY_CODE_POINTS))
        .join(""),
    )
    .filter(Boolean);
  return [...new Set(keys)].map((key) => ({ key, keyType: "concept", keyOrigin: "llm" }));
}

function normalizeVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("expectedVersion must be a positive safe integer");
  }
  return value as number;
}

function normalizeCursorOrdinal(value: unknown, name: string, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return value as number;
}

function normalizeExtractionFailureClass(value: unknown): MemoryExtractionFailureClass {
  if (
    value !== "provider" &&
    value !== "schema" &&
    value !== "evidence" &&
    value !== "localization" &&
    value !== "requested_admission"
  ) {
    throw new Error("Invalid Memory extraction failure class");
  }
  return value;
}

function normalizeExtractionTrigger(value: unknown): "remember" | "extract" | "compaction" {
  if (value !== "remember" && value !== "extract" && value !== "compaction") {
    throw new Error("Invalid Memory extraction trigger");
  }
  return value;
}

function normalizeCompactionCheckpointId(
  trigger: "remember" | "extract" | "compaction",
  value: unknown,
): string | undefined {
  if (trigger === "compaction") {
    return normalizeIdentifier(value, "compactionCheckpointId");
  }
  if (value !== undefined) {
    throw new Error("Only Compaction extraction may carry a checkpoint ID");
  }
  return undefined;
}

function normalizeExtractionNoOpReason(value: unknown): "sensitive_information" | undefined {
  if (value === undefined) return undefined;
  if (value !== "sensitive_information") {
    throw new Error("Invalid Memory extraction no-op reason");
  }
  return value;
}

function normalizeExtractionSkipReason(value: unknown): MemoryExtractionReceipt["skipReason"] {
  if (value === undefined) return undefined;
  if (value !== "policy_denied" && value !== "memory_deleted") {
    throw new Error("Invalid Memory extraction skip reason");
  }
  return value;
}

function normalizeRequestedItemIndexes(value: unknown, itemCount: number): number[] {
  if (!Array.isArray(value)) throw new Error("requestedItemIndexes must be an array");
  const indexes = [...new Set(value)];
  for (const index of indexes) {
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= itemCount) {
      throw new Error("requestedItemIndexes contains an out-of-range index");
    }
  }
  return (indexes as number[]).sort((left, right) => left - right);
}

function normalizeTimestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer UTC millisecond timestamp`);
  }
  return value as number;
}

function normalizeOptionalTimestamp(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  return normalizeTimestamp(value, name);
}

function keyPriority(key: MemoryItemKey): number {
  const origin = { user: 3, deterministic: 2, llm: 1 } as const;
  const type = { code: 5, exact: 4, entity: 3, concept: 2, alias: 1 } as const;
  return origin[key.keyOrigin] * 10 + type[key.keyType];
}

function recordMatchesWrite(record: MemoryItemRecord, write: NormalizedMemoryWrite): boolean {
  return hashCanonical(writeFromRecord(record)) === hashCanonical(write);
}

function writeFromRecord(record: MemoryItemRecord): NormalizedMemoryWrite {
  return {
    content: record.item.content,
    kind: record.item.kind,
    statementType: record.item.statementType,
    temporalType: record.item.temporalType,
    scopeType: record.item.scopeType,
    scopeKey: record.item.scopeKey,
    eventStartedAt: record.item.eventStartedAt,
    eventEndedAt: record.item.eventEndedAt,
    observedAt: record.item.observedAt,
    origin: record.item.origin,
    contentHash: record.item.contentHash,
    keys: record.keys,
    sources: record.sources,
  };
}

function mutationResult(
  mutationIndex: number,
  mutationType: MemoryMutationResult["mutationType"],
  item: MemoryItem,
  outcome: MemoryMutationResult["outcome"],
): MemoryMutationResult {
  return {
    mutationIndex,
    mutationType,
    itemId: item.itemId,
    version: item.version,
    lifecycleState: item.lifecycleState,
    outcome,
  };
}

function decodeItem(row: MemoryItemRow): MemoryItem {
  const kind = requiredString(row.kind, "kind");
  const statementType = requiredString(row.statement_type, "statement_type");
  const temporalType = requiredString(row.temporal_type, "temporal_type");
  const scopeType = requiredString(row.scope_type, "scope_type");
  const lifecycleState = requiredString(row.lifecycle_state, "lifecycle_state");
  const origin = requiredString(row.origin, "origin");
  if (!isMemoryItemKind(kind)) throw invalidColumn("kind");
  if (!isMemoryStatementType(statementType)) throw invalidColumn("statement_type");
  if (!isMemoryTemporalType(temporalType)) throw invalidColumn("temporal_type");
  if (!isMemoryScopeType(scopeType)) throw invalidColumn("scope_type");
  if (!isMemoryLifecycleState(lifecycleState)) throw invalidColumn("lifecycle_state");
  if (!isMemoryItemOrigin(origin)) throw invalidColumn("origin");
  const itemId = requiredIdentifierString(row.item_id, "item_id");
  const version = requiredPositiveInteger(row.version, "version");
  const content = requiredNonEmptyString(row.content, "content");
  const normalizedContent = normalizeLongTermMemoryContent(content);
  if (!normalizedContent.ok || normalizedContent.value !== content) throw invalidColumn("content");
  const scopeKey = nullableIdentifierString(row.scope_key, "scope_key");
  const eventStartedAt = nullableNonNegativeInteger(row.event_started_at, "event_started_at");
  const eventEndedAt = nullableNonNegativeInteger(row.event_ended_at, "event_ended_at");
  const observedAt = requiredNonNegativeInteger(row.observed_at, "observed_at");
  const contentHash = requiredHash(row.content_hash, "content_hash");
  const createdAt = requiredNonNegativeInteger(row.created_at, "created_at");
  const updatedAt = requiredNonNegativeInteger(row.updated_at, "updated_at");
  if (
    (scopeType === "global" && scopeKey !== null) ||
    (scopeType === "workspace" && (scopeKey === null || scopeKey.length === 0))
  ) {
    throw invalidColumn("scope_key");
  }
  validateMemoryTemporalBounds({ temporalType, eventStartedAt, eventEndedAt });
  if (createdAt > updatedAt || observedAt > updatedAt) throw invalidColumn("timestamps");
  if (hashText(content) !== contentHash) throw invalidColumn("content_hash");
  return {
    itemId,
    version,
    content,
    kind,
    statementType,
    temporalType,
    scopeType,
    scopeKey,
    eventStartedAt,
    eventEndedAt,
    observedAt,
    lifecycleState,
    origin,
    contentHash,
    createdAt,
    updatedAt,
  };
}

function decodeKey(row: MemoryKeyRow): MemoryItemKey {
  const keyType = requiredString(row.key_type, "key_type");
  const keyOrigin = requiredString(row.key_origin, "key_origin");
  if (!isMemoryKeyType(keyType)) throw invalidColumn("key_type");
  if (!isMemoryKeyOrigin(keyOrigin)) throw invalidColumn("key_origin");
  const key = requiredNonEmptyString(row.key_text, "key_text");
  const normalizedKey = requiredNonEmptyString(row.normalized_key, "normalized_key");
  if (normalizeSearchTerm(key) !== normalizedKey) throw invalidColumn("normalized_key");
  return {
    key,
    normalizedKey,
    keyType,
    keyOrigin,
  };
}

function decodeSource(row: MemorySourceRow): MemoryItemSource {
  return {
    sessionId: requiredIdentifierString(row.session_id, "session_id"),
    runId: requiredIdentifierString(row.run_id, "run_id"),
    turnId: requiredIdentifierString(row.turn_id, "turn_id"),
    eventId: requiredIdentifierString(row.event_id, "event_id"),
  };
}

function decodeExtractionCursor(row: MemoryExtractionCursorRow): MemoryExtractionCursor {
  return {
    sessionId: requiredIdentifierString(row.session_id, "session_id"),
    processedOrdinal: requiredPositiveInteger(row.processed_ordinal, "processed_ordinal"),
    updatedAt: requiredNonNegativeInteger(row.updated_at, "updated_at"),
  };
}

function decodeCompactionPolicyDenial(row: {
  readonly session_id: unknown;
  readonly compaction_checkpoint_id: unknown;
  readonly denied_at: unknown;
}): MemoryCompactionPolicyDenial {
  return {
    sessionId: requiredIdentifierString(row.session_id, "session_id"),
    compactionCheckpointId: requiredIdentifierString(
      row.compaction_checkpoint_id,
      "compaction_checkpoint_id",
    ),
    deniedAt: requiredNonNegativeInteger(row.denied_at, "denied_at"),
  };
}

function decodePendingExtractionFailure(
  row: MemoryExtractionFailureRow,
): PendingMemoryExtractionFailure {
  return {
    sessionId: requiredIdentifierString(row.session_id, "session_id"),
    fromOrdinal: requiredPositiveInteger(row.from_ordinal, "from_ordinal"),
    throughOrdinal: requiredPositiveInteger(row.through_ordinal, "through_ordinal"),
    coverageHash: requiredHash(row.coverage_hash, "coverage_hash"),
    firstOperationId: requiredIdentifierString(row.first_operation_id, "first_operation_id"),
    firstTrigger: normalizeExtractionTrigger(row.first_trigger),
    ...(row.compaction_checkpoint_id === null
      ? {}
      : {
          compactionCheckpointId: requiredIdentifierString(
            row.compaction_checkpoint_id,
            "compaction_checkpoint_id",
          ),
        }),
    firstFailureClass: normalizeExtractionFailureClass(row.first_failure_class),
    failedAt: requiredNonNegativeInteger(row.failed_at, "failed_at"),
    deletionRevision: requiredNonNegativeInteger(row.deletion_revision, "deletion_revision"),
  };
}

function normalizeExtractionSummary(value: unknown): MemoryExtractionSummary {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid memory extraction summary");
  const summary = value as Record<string, unknown>;
  const durationMs = summary.durationMs;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0)
    throw new Error("Invalid memory extraction duration");
  return {
    trigger: normalizeExtractionTrigger(summary.trigger),
    createdItemCount: requiredNonNegativeInteger(summary.createdItemCount, "createdItemCount"),
    modelCallCount: requiredNonNegativeInteger(summary.modelCallCount, "modelCallCount"),
    durationMs,
  };
}

function decodeExtractionReceipt(row: MemoryExtractionReceiptRow): MemoryExtractionReceipt {
  const operationId = requiredIdentifierString(row.operation_id, "operation_id");
  const sessionId = requiredIdentifierString(row.session_id, "session_id");
  requiredHash(row.request_hash, "request_hash");
  const committedAt = requiredNonNegativeInteger(row.committed_at, "committed_at");
  const encoded = requiredString(row.result_json, "result_json");
  if (encoded.length > MAX_OPERATION_RESULT_JSON_CODE_UNITS) {
    throw new Error(`Memory extraction ${operationId} result JSON is too large`);
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (error) {
    throw new Error(`Invalid result JSON for Memory extraction ${operationId}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid receipt for Memory extraction ${operationId}`);
  }
  const receipt = value as Record<string, unknown>;
  if (
    receipt.operationId !== operationId ||
    receipt.sessionId !== sessionId ||
    !["remembered", "not_applicable", "extracted", "discarded", "skipped"].includes(
      String(receipt.status),
    ) ||
    receipt.committedAt !== committedAt ||
    !Array.isArray(receipt.requestedItems)
  ) {
    throw new Error(`Invalid receipt for Memory extraction ${operationId}`);
  }
  const requestedItems = receipt.requestedItems.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Invalid requested Item in Memory extraction ${operationId}`);
    }
    const record = item as Record<string, unknown>;
    return {
      itemId: normalizeIdentifier(record.itemId, "receipt itemId"),
      content: requiredString(record.content, "receipt content"),
    };
  });
  if (requestedItems.length > MAX_MUTATIONS_PER_OPERATION) {
    throw new Error(`Memory extraction ${operationId} has too many requested Items`);
  }
  if (
    (receipt.status === "remembered" && requestedItems.length === 0) ||
    (receipt.status !== "remembered" && requestedItems.length > 0)
  ) {
    throw new Error(`Memory extraction ${operationId} has inconsistent requested Items`);
  }
  const noOpReason = normalizeExtractionNoOpReason(receipt.noOpReason);
  if (noOpReason && receipt.status !== "not_applicable") {
    throw new Error(`Memory extraction ${operationId} has an invalid no-op reason`);
  }
  const skipReason = normalizeExtractionSkipReason(receipt.skipReason);
  if ((receipt.status === "skipped") !== Boolean(skipReason)) {
    throw new Error(`Memory extraction ${operationId} has an invalid skip reason`);
  }
  let discardedRange: MemoryExtractionReceipt["discardedRange"];
  if (receipt.status === "discarded") {
    const value = receipt.discardedRange;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Memory extraction ${operationId} is missing its discarded range`);
    }
    const range = value as Record<string, unknown>;
    discardedRange = {
      fromOrdinal: requiredPositiveInteger(range.fromOrdinal, "discarded fromOrdinal"),
      throughOrdinal: requiredPositiveInteger(range.throughOrdinal, "discarded throughOrdinal"),
      coverageHash: requiredHash(range.coverageHash, "discarded coverageHash"),
      firstFailureClass: normalizeExtractionFailureClass(range.firstFailureClass),
      finalFailureClass: normalizeExtractionFailureClass(range.finalFailureClass),
    };
    if (discardedRange.throughOrdinal < discardedRange.fromOrdinal) {
      throw new Error(`Memory extraction ${operationId} has an invalid discarded range`);
    }
  } else if (receipt.discardedRange !== undefined) {
    throw new Error(`Memory extraction ${operationId} has an unexpected discarded range`);
  }
  return {
    operationId,
    sessionId,
    status: receipt.status as MemoryExtractionReceipt["status"],
    requestedItems,
    ...(noOpReason ? { noOpReason } : {}),
    ...(skipReason ? { skipReason } : {}),
    ...(discardedRange ? { discardedRange } : {}),
    committedAt,
    ...(receipt.summary !== undefined
      ? { summary: normalizeExtractionSummary(receipt.summary) }
      : {}),
  };
}

function decodeOperation(row: MemoryOperationRow): MemoryWriteOperationResult {
  const operationId = requiredIdentifierString(row.operation_id, "operation_id");
  const operationType = requiredString(row.operation_type, "operation_type");
  if (!["create", "update", "archive", "restore", "batch", "delete"].includes(operationType)) {
    throw invalidColumn("operation_type");
  }
  requiredHash(row.request_hash, "request_hash");
  const resultJson = requiredString(row.result_json, "result_json");
  if (resultJson.length > MAX_OPERATION_RESULT_JSON_CODE_UNITS) {
    throw new Error(`Memory operation ${operationId} result JSON is too large`);
  }
  let results: unknown;
  try {
    results = JSON.parse(resultJson);
  } catch (error) {
    throw new Error(`Invalid result JSON for Memory operation ${operationId}`, { cause: error });
  }
  if (!Array.isArray(results))
    throw new Error(`Invalid results for Memory operation ${operationId}`);
  if (results.length > MAX_MUTATIONS_PER_OPERATION) {
    throw new Error(
      `Memory operation results accept at most ${MAX_MUTATIONS_PER_OPERATION} mutations`,
    );
  }
  const decodedResults = results.map((result, index) => decodeMutationResult(result, index));
  if (
    operationType === "delete"
      ? decodedResults.length !== 0
      : operationType !== "batch" &&
        (decodedResults.length !== 1 || decodedResults[0]?.mutationType !== operationType)
  ) {
    throw new Error(`Invalid results for Memory operation ${operationId}`);
  }
  for (const result of decodedResults) validateMutationResultOutcome(result);
  return {
    operationId,
    operationType: operationType as MemoryWriteOperationResult["operationType"],
    replayed: false,
    committedAt: requiredNonNegativeInteger(row.committed_at, "committed_at"),
    results: decodedResults,
  };
}

function decodeMemoryExtractionJob(row: Record<string, unknown>): MemoryExtractionJob {
  const state = requiredString(row.state, "state");
  if (!(["pending", "working", "settled", "blocked"] as const).includes(state as never))
    throw invalidColumn("state");
  const trigger = normalizeExtractionTrigger(row.trigger);
  const ownerId = nullableIdentifierString(row.owner_id, "owner_id");
  const leaseUntil = requiredNonNegativeInteger(row.lease_until, "lease_until");
  if ((state === "working") !== (ownerId !== null && leaseUntil > 0)) throw invalidColumn("lease");
  const checkpointId = normalizeCompactionCheckpointId(
    trigger,
    row.compaction_checkpoint_id === null ? undefined : row.compaction_checkpoint_id,
  );
  return {
    jobId: requiredIdentifierString(row.job_id, "job_id"),
    sessionId: requiredIdentifierString(row.session_id, "session_id"),
    workspaceKey: requiredIdentifierString(row.workspace_key, "workspace_key"),
    workDir: requiredIdentifierString(row.work_dir, "work_dir"),
    sourceEventId: requiredIdentifierString(row.source_event_id, "source_event_id"),
    sourceHash: requiredIdentifierString(row.source_hash, "source_hash"),
    sourceKind: row.source_kind as MemoryExtractionJob["sourceKind"],
    sourceOrdinal: requiredPositiveInteger(row.source_ordinal, "source_ordinal"),
    throughOrdinal: requiredPositiveInteger(row.through_ordinal, "through_ordinal"),
    trigger,
    ...(checkpointId ? { compactionCheckpointId: checkpointId } : {}),
    deletionRevision: requiredNonNegativeInteger(row.deletion_revision, "deletion_revision"),
    settingsVersion: requiredPositiveInteger(row.settings_version, "settings_version"),
    state: state as MemoryExtractionJob["state"],
    notBefore: requiredNonNegativeInteger(row.not_before, "not_before"),
    ...(ownerId ? { ownerId } : {}),
    ...(leaseUntil > 0 ? { leaseUntil } : {}),
    fencingToken: requiredNonNegativeInteger(row.fencing_token, "fencing_token"),
    modelCalls: requiredNonNegativeInteger(row.model_calls, "model_calls"),
    ...(row.reason === null ? {} : { reason: requiredIdentifierString(row.reason, "reason") }),
  };
}

function decodeMutationResult(value: unknown, expectedIndex: number): MemoryMutationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Memory mutation result");
  }
  const result = value as Record<string, unknown>;
  const mutationIndex = requiredNonNegativeInteger(result.mutationIndex, "mutationIndex");
  const mutationType = requiredString(result.mutationType, "mutationType");
  const lifecycleState = requiredString(result.lifecycleState, "lifecycleState");
  const outcome = requiredString(result.outcome, "outcome");
  if (mutationIndex !== expectedIndex) throw invalidColumn("mutationIndex");
  if (!["create", "update", "archive", "restore"].includes(mutationType)) {
    throw invalidColumn("mutationType");
  }
  if (!isMemoryLifecycleState(lifecycleState)) throw invalidColumn("lifecycleState");
  if (!["created", "updated", "archived", "restored", "noop"].includes(outcome)) {
    throw invalidColumn("outcome");
  }
  return {
    mutationIndex,
    mutationType: mutationType as MemoryMutationResult["mutationType"],
    itemId: requiredIdentifierString(result.itemId, "itemId"),
    version: requiredPositiveInteger(result.version, "version"),
    lifecycleState,
    outcome: outcome as MemoryMutationResult["outcome"],
  };
}

function validateMutationResultOutcome(result: MemoryMutationResult): void {
  const valid =
    (result.mutationType === "create" &&
      result.outcome === "created" &&
      result.lifecycleState === "active") ||
    (result.mutationType === "update" &&
      (result.outcome === "updated" || result.outcome === "noop")) ||
    (result.mutationType === "archive" &&
      result.outcome === "archived" &&
      result.lifecycleState === "archived") ||
    (result.mutationType === "restore" &&
      result.outcome === "restored" &&
      result.lifecycleState === "active");
  if (!valid) throw new Error("Invalid Memory mutation result outcome");
}

function requiredString(value: unknown, column: string): string {
  if (typeof value !== "string") throw invalidColumn(column);
  return value;
}

function requiredNonEmptyString(value: unknown, column: string): string {
  const result = requiredString(value, column);
  if (result.length === 0) throw invalidColumn(column);
  return result;
}

function requiredIdentifierString(value: unknown, column: string): string {
  const result = requiredNonEmptyString(value, column);
  try {
    return normalizeIdentifier(result, column);
  } catch {
    throw invalidColumn(column);
  }
}

function nullableIdentifierString(value: unknown, column: string): string | null {
  return value === null ? null : requiredIdentifierString(value, column);
}

function requiredInteger(value: unknown, column: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalidColumn(column);
  return value;
}

function requiredNonNegativeInteger(value: unknown, column: string): number {
  const result = requiredInteger(value, column);
  if (result < 0) throw invalidColumn(column);
  return result;
}

function requiredPositiveInteger(value: unknown, column: string): number {
  const result = requiredInteger(value, column);
  if (result < 1) throw invalidColumn(column);
  return result;
}

function nullableNonNegativeInteger(value: unknown, column: string): number | null {
  return value === null ? null : requiredNonNegativeInteger(value, column);
}

function requiredHash(value: unknown, column: string): string {
  const result = requiredString(value, column);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw invalidColumn(column);
  return result;
}

function invalidColumn(column: string): Error {
  return new Error(`Invalid long-term memory SQLite column ${column}`);
}

function assertChanged(changes: number | bigint, itemId: string): void {
  if (Number(changes) !== 1) {
    throw new MemoryItemStoreConflictError(
      "version_conflict",
      `Memory Item ${itemId} changed concurrently`,
      itemId,
    );
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashCanonical(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** Smallest Unicode string strictly greater than every string with this prefix. */
function prefixUpperBound(prefix: string): string | undefined {
  const points = Array.from(prefix, (character) => character.codePointAt(0)!);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    if (point < 0x10ffff) {
      const successor = point === 0xd7ff ? 0xe000 : point + 1;
      return String.fromCodePoint(...points.slice(0, index), successor);
    }
  }
  return undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function preparePrivateDatabaseFiles(path: string): void {
  const directory = dirname(resolve(path));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink())
    throw new Error("Memory directory must not be a symbolic link");
  const descriptor = openSync(
    directory,
    fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW),
  );
  try {
    if (!fstatSync(descriptor).isDirectory()) throw new Error("Memory parent must be a directory");
    if (process.platform !== "win32") fchmodSync(descriptor, 0o700);
  } finally {
    closeSync(descriptor);
  }
  secureFile(path, true, false);
  for (const sidecar of databaseSidecars(path)) secureFile(sidecar, false, true);
}

function secureExistingDatabaseFiles(path: string): void {
  secureFile(path, false, false);
  for (const sidecar of databaseSidecars(path)) secureFile(sidecar, false, true);
}

function secureFile(path: string, create: boolean, allowUnlinked: boolean): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Long-term memory SQLite path must not be a symbolic link: ${path}`);
    }
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
  }
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDWR | noFollow | (create ? fsConstants.O_CREAT : 0),
      0o600,
    );
    const status = fstatSync(descriptor);
    if (!status.isFile()) {
      throw new Error(`Long-term memory SQLite path is not a regular file: ${path}`);
    }
    if (status.nlink === 0 && allowUnlinked) return;
    if (status.nlink !== 1) {
      throw new Error(`Long-term memory SQLite path must not be hard-linked: ${path}`);
    }
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
  } catch (error) {
    if (!create && isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function databaseSidecars(path: string): readonly string[] {
  return [`${path}-wal`, `${path}-shm`, `${path}-journal`];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the write failure that triggered rollback.
  }
}
