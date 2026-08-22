import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalizeWorkspacePath } from "../../paths/pico-paths.js";
import {
  deriveRecoverableTaskLaunchId,
  deriveRecoverableTaskRuntimeLaunchIdentity,
  validateRecoverableTaskLaunchReceipt,
} from "../../tasks/recoverable-task.js";
import {
  TASK_ATTEMPT_TERMINAL_STATUSES,
  TASK_RESUME_PARK_REASONS,
  TASK_RUN_EVENT_SCHEMA_VERSION,
  TASK_RUN_FILE_SCHEMA_VERSION,
  TASK_RUN_TERMINAL_STATUSES,
  type RecoverableTaskAdapterIdentity,
  type RecoverableTaskLaunchReceipt,
  type TaskAttemptExecutionProjection,
  type TaskAttemptLaunchProjection,
  type TaskAttemptProjection,
  type TaskAttemptTerminalStatus,
  type TaskResumeParkReason,
  type TaskRunEvent,
  type TaskRunEventEntry,
  type TaskRunFileHeader,
  type TaskRunProjection,
  type TaskRunTerminalStatus,
  type TaskSafeBoundary,
} from "../../tasks/task-run-contract.js";
import {
  hashTaskRunInput,
  TaskRunStoreIntegrityError,
  TaskRunStoreRevisionConflictError,
  type AppendTaskRunBatchOptions,
  type InitializeTaskRunOptions,
  type TaskRunAppendResult,
  type TaskRunSnapshot,
  type TaskRunStoreInspection,
  type TaskRunStoreOptions,
  type TaskRunStorageRootMismatch,
} from "../../tasks/task-run-store-contracts.js";
import { operationalDatabasePath, type OperationalDatabaseLease } from "./sqlite-database.js";
import { prepareWorkspaceSqliteStorageSync } from "./sqlite-workspace-storage.js";
import { ALL_WORKSPACE_SQLITE_SCOPES } from "./workspace-scopes.js";

/**
 * SQLite 版 TaskRunStore(票 05,ADR 24 §4.2)。
 *
 * 语义对齐旧 JSONL 实现(src/tasks/task-run-store.ts,票 09 退役):header 不可变、
 * 事件批原子提交、transactionId 请求级幂等、expectedRevision CAS、逐事件重放投影、
 * 重启恢复 = SQL 查询。事实全部住在 pico.sqlite 的 task_runs/task_run_events 两表,
 * task-runs/ 目录与 manifest.json 不再产生。错误类型与选项/结果形状直接复用旧 store
 * 的导出,装配替换(票 03)时消费方零改动。
 */

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

interface LoadedTaskRunEvent {
  readonly entry: TaskRunEventEntry;
  readonly transactionId: string;
  readonly revision: number;
}

interface LoadedTaskRun {
  readonly header: TaskRunFileHeader;
  readonly projection: TaskRunProjection;
  readonly events: readonly LoadedTaskRunEvent[];
  readonly transactions: ReadonlyMap<string, readonly LoadedTaskRunEvent[]>;
}

interface MutableTaskAttempt {
  attemptId: string;
  attemptNumber: number;
  execution?: TaskAttemptExecutionProjection;
  sourceAttemptId?: string;
  status: "running" | TaskAttemptTerminalStatus;
  startedAt: string;
  finishedAt?: string;
  boundary?: TaskSafeBoundary;
  result?: Readonly<Record<string, unknown>>;
  error?: string;
  launch?: TaskAttemptLaunchProjection;
}

interface MutableTaskRunProjection {
  header: TaskRunFileHeader;
  revision: number;
  lastTransactionId?: string;
  status: TaskRunProjection["status"];
  attempts: MutableTaskAttempt[];
  parkReasons: TaskResumeParkReason[];
  parkDiagnostics: string[];
  terminal?: TaskRunProjection["terminal"];
}

interface ProjectionIndexes {
  readonly attempts: Map<string, MutableTaskAttempt>;
  readonly claims: Map<
    string,
    {
      readonly claimId: string;
      readonly sourceAttemptId: string;
      readonly successorAttemptId: string;
      readonly ownerId: string;
      readonly leaseEpoch: number;
    }
  >;
  readonly claimIds: Set<string>;
}

export class SqliteTaskRunStore {
  readonly storageRoot: string;
  readonly storageRootId: string;
  private readonly lease: OperationalDatabaseLease;
  private readonly now: () => Date;
  private open = true;

  constructor(options: TaskRunStoreOptions) {
    if (!options.storageRoot.trim()) throw new Error("SqliteTaskRunStore requires storageRoot");
    const preparation = prepareWorkspaceSqliteStorageSync(
      options.storageRoot,
      ALL_WORKSPACE_SQLITE_SCOPES,
    );
    this.lease = preparation.lease;
    this.storageRoot = preparation.rootIdentity.canonicalPath;
    this.storageRootId = preparation.rootIdentity.storageRootId;
    this.now = options.now ?? (() => new Date());
  }

  /** Releases the process-wide database lease; the store must not be used afterwards. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.lease.release();
  }

  async initializeTaskRun(options: InitializeTaskRunOptions): Promise<TaskRunProjection> {
    this.assertOpen();
    if (options.storageRootId !== undefined && options.storageRootId !== this.storageRootId) {
      throw new TaskRunStoreIntegrityError(
        `TaskRun ${options.taskRunId} storageRootId does not match the verified workspace root`,
      );
    }
    const requestedHeader = createTaskRunHeader(
      { ...options, storageRootId: this.storageRootId },
      options.now ?? this.now,
    );
    return this.lease.transaction("write", () => {
      const existing = this.loadTaskRun(requestedHeader.taskRunId);
      if (existing) {
        this.assertTaskRunStorageRoot(existing);
        if (!sameImmutableHeader(existing.header, requestedHeader)) {
          throw new TaskRunStoreIntegrityError(
            `TaskRun ${requestedHeader.taskRunId} is already bound to different immutable metadata`,
          );
        }
        return cloneProjection(existing.projection);
      }
      const projection = initialProjection(requestedHeader);
      this.lease.database
        .prepare(
          `INSERT INTO task_runs (
             task_run_id, work_dir, storage_root_id, adapter_id, adapter_version,
             adapter_input_json, input_hash, max_attempts, created_at,
             last_event_seq, last_tx_id, revision, status, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?)`,
        )
        .run(
          requestedHeader.taskRunId,
          requestedHeader.workDir,
          requestedHeader.storageRootId,
          requestedHeader.adapter.id,
          requestedHeader.adapter.version,
          canonicalJson(requestedHeader.adapter.input),
          requestedHeader.adapter.inputHash,
          requestedHeader.maxAttempts,
          requestedHeader.createdAt,
          projection.status,
          requestedHeader.createdAt,
        );
      return cloneProjection(projection);
    });
  }

  async append(
    taskRunId: string,
    event: TaskRunEvent,
    options: AppendTaskRunBatchOptions = {},
  ): Promise<TaskRunAppendResult> {
    const results = await this.appendBatch(taskRunId, [event], options);
    return results[0]!;
  }

  /**
   * Appends one atomic event batch. Event IDs are exactly-once within a TaskRun, while an
   * explicitly supplied transaction ID makes replay of the whole request exactly-once.
   */
  async appendBatch(
    taskRunId: string,
    events: readonly TaskRunEvent[],
    options: AppendTaskRunBatchOptions = {},
  ): Promise<readonly TaskRunAppendResult[]> {
    this.assertOpen();
    if (!taskRunId) throw new Error("TaskRun ID must not be empty");
    if (events.length === 0) return [];
    const canonicalEvents = events.map((event) => decodeTaskRunEvent(toCanonicalJson(event)));
    assertUniqueRequestedEventIds(canonicalEvents);
    assertResumeBatchPairs(canonicalEvents, `TaskRun ${taskRunId} append request`);

    return this.lease.transaction("write", () => {
      const loaded = this.requireTaskRun(taskRunId);
      this.assertTaskRunStorageRoot(loaded);
      const requestedTransactionId = options.transactionId;
      if (requestedTransactionId !== undefined) {
        assertNonEmptyIdentifier(requestedTransactionId, "transactionId");
        const replayed = loaded.transactions.get(requestedTransactionId);
        if (replayed) {
          const payloadDiffers =
            replayed.length !== canonicalEvents.length ||
            replayed.some(
              (persisted, index) =>
                !isDeepStrictEqual(persisted.entry.event, canonicalEvents[index]),
            );
          if (!payloadDiffers) {
            return replayed.map(({ entry, revision, transactionId }) => ({
              inserted: false,
              entry: structuredClone(entry),
              revision,
              transactionId,
            }));
          }
          if (
            options.expectedRevision !== undefined &&
            loaded.projection.revision !== options.expectedRevision
          ) {
            throw new TaskRunStoreRevisionConflictError(cloneProjection(loaded.projection));
          }
          throw new TaskRunStoreIntegrityError(
            `TaskRun transaction ${requestedTransactionId} is already bound to another payload`,
          );
        }
      }
      if (
        options.expectedRevision !== undefined &&
        loaded.projection.revision !== options.expectedRevision
      ) {
        throw new TaskRunStoreRevisionConflictError(cloneProjection(loaded.projection));
      }

      const existingByEventId = new Map(
        loaded.events.map((persisted) => [persisted.entry.event.eventId, persisted]),
      );
      const results: Array<TaskRunAppendResult | undefined> = [];
      const newEvents: TaskRunEvent[] = [];
      let existingEventCount = 0;
      for (const event of canonicalEvents) {
        if (event.taskRunId !== taskRunId) {
          throw new TaskRunStoreIntegrityError(
            `TaskRun event ${event.eventId} belongs to another TaskRun`,
          );
        }
        const existing = existingByEventId.get(event.eventId);
        if (existing) {
          if (!isDeepStrictEqual(existing.entry.event, event)) {
            throw new TaskRunStoreIntegrityError(
              `TaskRun event ID ${event.eventId} is already bound to another payload`,
            );
          }
          results.push({
            inserted: false,
            entry: structuredClone(existing.entry),
            revision: existing.revision,
            transactionId: existing.transactionId,
          });
          existingEventCount++;
          continue;
        }
        results.push(undefined);
        newEvents.push(event);
      }
      if (newEvents.length === 0) return results as TaskRunAppendResult[];
      if (requestedTransactionId !== undefined && existingEventCount > 0) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun transaction ${requestedTransactionId} mixes replayed and new events`,
        );
      }

      const transactionId = requestedTransactionId ?? randomUUID();
      if (loaded.transactions.has(transactionId)) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun transaction ${transactionId} is already present`,
        );
      }
      const committedAt = canonicalTimestamp((options.now ?? this.now)(), "committedAt");
      const revision = loaded.projection.revision + 1;
      const entries = newEvents.map(
        (event, index): TaskRunEventEntry => ({
          sequence: loaded.events.length + index + 1,
          committedAt,
          event,
        }),
      );

      const nextProjection = replayProjection(loaded.header, [
        ...loaded.events,
        ...entries.map((entry) => ({ entry, transactionId, revision })),
      ]);
      const insertEvent = this.lease.database.prepare(
        `INSERT INTO task_run_events (
           event_id, task_run_id, event_seq, kind, tx_id, payload_json, committed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of entries) {
        insertEvent.run(
          entry.event.eventId,
          taskRunId,
          entry.sequence,
          entry.event.kind,
          transactionId,
          canonicalJson(entry.event),
          entry.committedAt,
        );
      }
      this.lease.database
        .prepare(
          `UPDATE task_runs
           SET last_event_seq = ?, last_tx_id = ?, revision = ?, status = ?, updated_at = ?
           WHERE task_run_id = ?`,
        )
        .run(
          loaded.events.length + entries.length,
          transactionId,
          revision,
          nextProjection.status,
          committedAt,
          taskRunId,
        );

      let newEntryIndex = 0;
      return results.map((result): TaskRunAppendResult => {
        if (result) return result;
        const entry = entries[newEntryIndex++]!;
        return {
          inserted: true,
          entry: structuredClone(entry),
          revision,
          transactionId,
        };
      });
    });
  }

  async readTaskRunProjection(taskRunId: string): Promise<TaskRunProjection | undefined> {
    this.assertOpen();
    return this.lease.transaction("read", () => {
      const loaded = this.loadTaskRun(taskRunId);
      return loaded ? cloneProjection(loaded.projection) : undefined;
    });
  }

  /** Reads projection and canonical facts under one read transaction for recovery planning. */
  async readTaskRun(taskRunId: string): Promise<TaskRunSnapshot | undefined> {
    this.assertOpen();
    return this.lease.transaction("read", () => {
      const loaded = this.loadTaskRun(taskRunId);
      return loaded
        ? {
            projection: cloneProjection(loaded.projection),
            events: loaded.events.map(({ entry }) => structuredClone(entry)),
          }
        : undefined;
    });
  }

  async readTaskRunEvents(taskRunId: string): Promise<readonly TaskRunEventEntry[]> {
    this.assertOpen();
    return this.lease.transaction("read", () =>
      this.requireTaskRun(taskRunId).events.map(({ entry }) => structuredClone(entry)),
    );
  }

  async listTaskRunProjections(): Promise<readonly TaskRunProjection[]> {
    this.assertOpen();
    return this.lease.transaction("read", () =>
      this.loadAllTaskRuns().map(({ projection }) => cloneProjection(projection)),
    );
  }

  async inspectTaskRuns(): Promise<TaskRunStoreInspection> {
    this.assertOpen();
    return this.lease.transaction("read", () => {
      const loaded = this.loadAllTaskRuns();
      return {
        projections: loaded.map(({ projection }) => cloneProjection(projection)),
        staleManifestPaths: [],
        storageRootMismatches: loaded
          .filter(({ header }) => header.storageRootId !== this.storageRootId)
          .map(
            ({ header }): TaskRunStorageRootMismatch => ({
              taskRunId: header.taskRunId,
              ledgerPath: operationalDatabasePath(this.storageRoot),
              taskRunStorageRootId: header.storageRootId,
              currentStorageRootId: this.storageRootId,
            }),
          )
          .sort((left, right) => left.taskRunId.localeCompare(right.taskRunId)),
      };
    });
  }

  private assertOpen(): void {
    if (!this.open) throw new Error("SqliteTaskRunStore is closed");
  }

  private assertTaskRunStorageRoot(loaded: LoadedTaskRun): void {
    if (loaded.header.storageRootId === this.storageRootId) return;
    throw new TaskRunStoreIntegrityError(
      `TaskRun ${loaded.header.taskRunId} storageRootId ${loaded.header.storageRootId} does not match the verified workspace root ${this.storageRootId}`,
    );
  }

  private requireTaskRun(taskRunId: string): LoadedTaskRun {
    const loaded = this.loadTaskRun(taskRunId);
    if (!loaded) {
      throw new TaskRunStoreIntegrityError(`TaskRun ${taskRunId} has not been initialized`);
    }
    return loaded;
  }

  private loadTaskRun(taskRunId: string): LoadedTaskRun | undefined {
    const row = this.lease.database
      .prepare(
        `SELECT task_run_id, work_dir, storage_root_id, adapter_id, adapter_version,
                adapter_input_json, input_hash, max_attempts, created_at,
                last_event_seq, last_tx_id, revision, status, updated_at
         FROM task_runs WHERE task_run_id = ?`,
      )
      .get(taskRunId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const header = decodeTaskRunRowHeader(row, taskRunId);
    const lastEventSeq = requireNonNegativeInteger(
      row["last_event_seq"],
      "last_event_seq",
      taskRunId,
    );
    const revision = requireNonNegativeInteger(row["revision"], "revision", taskRunId);
    const lastTxId = row["last_tx_id"];
    if (lastTxId != null && !isNonEmptyString(lastTxId)) {
      throw new TaskRunStoreIntegrityError(`TaskRun ${taskRunId} last_tx_id is invalid`);
    }

    const eventRows = this.lease.database
      .prepare(
        `SELECT event_id, event_seq, kind, tx_id, payload_json, committed_at
         FROM task_run_events WHERE task_run_id = ? ORDER BY event_seq ASC`,
      )
      .all(taskRunId) as Array<Record<string, unknown>>;
    const events: LoadedTaskRunEvent[] = [];
    const transactions = new Map<string, readonly LoadedTaskRunEvent[]>();
    let currentTxId: string | undefined;
    let batchRevision = 0;
    for (const eventRow of eventRows) {
      const eventId = requireNonEmptyString(eventRow["event_id"], "event_id", taskRunId);
      const eventSeq = requirePositiveInteger(eventRow["event_seq"], "event_seq", taskRunId);
      const kind = requireNonEmptyString(eventRow["kind"], "kind", taskRunId);
      const txId = requireNonEmptyString(eventRow["tx_id"], "tx_id", taskRunId);
      const committedAt = eventRow["committed_at"];
      if (!isCanonicalTimestamp(committedAt)) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun ${taskRunId} event ${eventId} committedAt is invalid`,
        );
      }
      const payloadJson = eventRow["payload_json"];
      if (typeof payloadJson !== "string") {
        throw new TaskRunStoreIntegrityError(
          `TaskRun ${taskRunId} event ${eventId} payload is missing`,
        );
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(payloadJson);
      } catch {
        throw new TaskRunStoreIntegrityError(
          `TaskRun ${taskRunId} event ${eventId} payload is not valid JSON`,
        );
      }
      const event = decodeTaskRunEvent(decoded);
      if (event.eventId !== eventId) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun ${taskRunId} event ${eventId} does not match its payload projection`,
        );
      }
      if (event.kind !== kind) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun ${taskRunId} event ${eventId} does not match its kind projection`,
        );
      }
      if (event.taskRunId !== taskRunId) {
        throw new TaskRunStoreIntegrityError(`TaskRun event ${eventId} belongs to another TaskRun`);
      }
      const expectedSequence = events.length + 1;
      if (eventSeq !== expectedSequence) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun ${taskRunId} sequence ${eventSeq} is not contiguous`,
        );
      }
      if (txId !== currentTxId) {
        if (transactions.has(txId)) {
          throw new TaskRunStoreIntegrityError(
            `TaskRun ${taskRunId} transaction ${txId} is duplicated`,
          );
        }
        batchRevision += 1;
        currentTxId = txId;
        transactions.set(txId, []);
      }
      const persisted: LoadedTaskRunEvent = {
        entry: { sequence: eventSeq, committedAt, event },
        transactionId: txId,
        revision: batchRevision,
      };
      events.push(persisted);
      (transactions.get(txId) as LoadedTaskRunEvent[]).push(persisted);
    }
    for (const [txId, transactionEvents] of transactions) {
      assertResumeBatchPairs(
        transactionEvents.map(({ entry }) => entry.event),
        `TaskRun ${taskRunId} transaction ${txId}`,
      );
    }
    if (
      lastEventSeq !== events.length ||
      revision !== batchRevision ||
      (events.length > 0 ? lastTxId !== events[events.length - 1]!.transactionId : lastTxId != null)
    ) {
      throw new TaskRunStoreIntegrityError(
        `TaskRun ${taskRunId} watermark does not match its event ledger`,
      );
    }

    const projection = replayProjection(header, events);
    const status = row["status"];
    if (status != null && status !== projection.status) {
      throw new TaskRunStoreIntegrityError(
        `TaskRun ${taskRunId} status projection does not match its event ledger`,
      );
    }
    return { header, projection, events, transactions };
  }

  private loadAllTaskRuns(): LoadedTaskRun[] {
    const rows = this.lease.database
      .prepare("SELECT task_run_id FROM task_runs ORDER BY created_at DESC, task_run_id DESC")
      .all() as Array<Record<string, unknown>>;
    const loaded: LoadedTaskRun[] = [];
    for (const row of rows) {
      const taskRunId = row["task_run_id"];
      if (!isNonEmptyString(taskRunId)) {
        throw new TaskRunStoreIntegrityError("TaskRun row has an invalid task_run_id");
      }
      loaded.push(this.requireTaskRun(taskRunId));
    }
    return loaded;
  }
}

function createTaskRunHeader(
  options: InitializeTaskRunOptions & { readonly storageRootId: string },
  now: () => Date,
): TaskRunFileHeader {
  assertNonEmptyIdentifier(options.taskRunId, "taskRunId");
  assertNonEmptyIdentifier(options.storageRootId, "storageRootId");
  if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new Error("TaskRun maxAttempts must be a positive safe integer");
  }
  const adapter = decodeTaskAdapter(toCanonicalJson(options.adapter), "TaskRun adapter");
  if (hashTaskRunInput(adapter.input) !== adapter.inputHash) {
    throw new TaskRunStoreIntegrityError(
      `TaskRun ${options.taskRunId} adapter inputHash does not match its immutable input`,
    );
  }
  return {
    type: "task-run",
    schemaVersion: TASK_RUN_FILE_SCHEMA_VERSION,
    taskRunId: options.taskRunId,
    workDir: canonicalizeWorkspacePath(options.workDir),
    storageRootId: options.storageRootId,
    adapter,
    maxAttempts: options.maxAttempts,
    createdAt: canonicalTimestamp(now(), "createdAt"),
  };
}

function decodeTaskRunRowHeader(
  row: Record<string, unknown>,
  taskRunId: string,
): TaskRunFileHeader {
  const context = `TaskRun ${taskRunId} row`;
  if (
    !isNonEmptyString(row["task_run_id"]) ||
    !isNonEmptyString(row["work_dir"]) ||
    !isNonEmptyString(row["storage_root_id"]) ||
    !isNonEmptyString(row["adapter_id"]) ||
    !isPositiveSafeInteger(row["adapter_version"]) ||
    !isPositiveSafeInteger(row["max_attempts"]) ||
    !isCanonicalTimestamp(row["created_at"]) ||
    !isNonEmptyString(row["input_hash"])
  ) {
    throw new TaskRunStoreIntegrityError(`${context} header is invalid`);
  }
  const workDir = row["work_dir"] as string;
  if (canonicalizeWorkspacePath(workDir) !== workDir) {
    throw new TaskRunStoreIntegrityError(`${context} workDir is not canonical`);
  }
  const inputHash = row["input_hash"] as string;
  if (!SHA256_PATTERN.test(inputHash)) {
    throw new TaskRunStoreIntegrityError(`${context} inputHash is invalid`);
  }
  if (typeof row["adapter_input_json"] !== "string") {
    throw new TaskRunStoreIntegrityError(`${context} adapter input is missing`);
  }
  let adapterInput: unknown;
  try {
    adapterInput = JSON.parse(row["adapter_input_json"] as string);
  } catch {
    throw new TaskRunStoreIntegrityError(`${context} adapter input is not valid JSON`);
  }
  const adapter = decodeTaskAdapter(
    { id: row["adapter_id"], version: row["adapter_version"], input: adapterInput, inputHash },
    `${context} adapter`,
  );
  if (hashTaskRunInput(adapter.input) !== inputHash) {
    throw new TaskRunStoreIntegrityError(`${context} adapter inputHash does not match its input`);
  }
  return {
    type: "task-run",
    schemaVersion: TASK_RUN_FILE_SCHEMA_VERSION,
    taskRunId: row["task_run_id"] as string,
    workDir,
    storageRootId: row["storage_root_id"] as string,
    adapter,
    maxAttempts: row["max_attempts"] as number,
    createdAt: row["created_at"] as string,
  };
}

function decodeTaskAdapter(value: unknown, context: string): RecoverableTaskAdapterIdentity {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value["id"]) ||
    !isPositiveSafeInteger(value["version"]) ||
    !isRecord(value["input"]) ||
    typeof value["inputHash"] !== "string" ||
    !SHA256_PATTERN.test(value["inputHash"])
  ) {
    throw new TaskRunStoreIntegrityError(`${context} is invalid`);
  }
  const input = toCanonicalJson(value["input"]) as Readonly<Record<string, unknown>>;
  return {
    id: value["id"],
    version: value["version"],
    input,
    inputHash: value["inputHash"],
  };
}

function decodeTaskRunEvent(value: unknown): TaskRunEvent {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== TASK_RUN_EVENT_SCHEMA_VERSION ||
    !isNonEmptyString(value["eventId"]) ||
    !isNonEmptyString(value["taskRunId"]) ||
    !isCanonicalTimestamp(value["at"]) ||
    !isRecord(value["data"])
  ) {
    throw new TaskRunStoreIntegrityError("TaskRun event is invalid");
  }
  const base = {
    schemaVersion: TASK_RUN_EVENT_SCHEMA_VERSION,
    eventId: value["eventId"],
    taskRunId: value["taskRunId"],
    at: value["at"],
  } as const;
  const data = value["data"];

  switch (value["kind"]) {
    case "attempt.started": {
      if (
        !isNonEmptyString(data["attemptId"]) ||
        !isPositiveSafeInteger(data["attemptNumber"]) ||
        (data["sourceAttemptId"] !== undefined && !isNonEmptyString(data["sourceAttemptId"]))
      ) {
        throw new TaskRunStoreIntegrityError("TaskRun attempt.started event is invalid");
      }
      return {
        ...base,
        kind: "attempt.started",
        data: {
          attemptId: data["attemptId"],
          attemptNumber: data["attemptNumber"],
          ...(typeof data["sourceAttemptId"] === "string"
            ? { sourceAttemptId: data["sourceAttemptId"] }
            : {}),
        },
      };
    }
    case "attempt.execution.claimed":
    case "attempt.execution.renewed": {
      if (
        !isNonEmptyString(data["attemptId"]) ||
        !isNonEmptyString(data["ownerId"]) ||
        !isPositiveSafeInteger(data["leaseEpoch"]) ||
        !isCanonicalTimestamp(data["expiresAt"])
      ) {
        throw new TaskRunStoreIntegrityError(`TaskRun ${value["kind"]} event is invalid`);
      }
      return {
        ...base,
        kind: value["kind"],
        data: {
          attemptId: data["attemptId"],
          ownerId: data["ownerId"],
          leaseEpoch: data["leaseEpoch"],
          expiresAt: data["expiresAt"],
        },
      };
    }
    case "attempt.execution.released": {
      if (
        !isNonEmptyString(data["attemptId"]) ||
        !isNonEmptyString(data["ownerId"]) ||
        !isPositiveSafeInteger(data["leaseEpoch"])
      ) {
        throw new TaskRunStoreIntegrityError("TaskRun attempt.execution.released event is invalid");
      }
      return {
        ...base,
        kind: "attempt.execution.released",
        data: {
          attemptId: data["attemptId"],
          ownerId: data["ownerId"],
          leaseEpoch: data["leaseEpoch"],
        },
      };
    }
    case "attempt.checkpointed": {
      if (
        !isNonEmptyString(data["attemptId"]) ||
        !isNonEmptyString(data["ownerId"]) ||
        !isPositiveSafeInteger(data["leaseEpoch"])
      ) {
        throw new TaskRunStoreIntegrityError("TaskRun attempt.checkpointed event is invalid");
      }
      return {
        ...base,
        kind: "attempt.checkpointed",
        data: {
          attemptId: data["attemptId"],
          ownerId: data["ownerId"],
          leaseEpoch: data["leaseEpoch"],
          boundary: decodeTaskSafeBoundary(data["boundary"]),
        },
      };
    }
    case "attempt.finished": {
      if (
        !isNonEmptyString(data["attemptId"]) ||
        !isNonEmptyString(data["ownerId"]) ||
        !isPositiveSafeInteger(data["leaseEpoch"]) ||
        !isTaskAttemptTerminalStatus(data["status"]) ||
        (data["result"] !== undefined && !isRecord(data["result"])) ||
        (data["error"] !== undefined && typeof data["error"] !== "string")
      ) {
        throw new TaskRunStoreIntegrityError("TaskRun attempt.finished event is invalid");
      }
      return {
        ...base,
        kind: "attempt.finished",
        data: {
          attemptId: data["attemptId"],
          ownerId: data["ownerId"],
          leaseEpoch: data["leaseEpoch"],
          status: data["status"],
          ...(isRecord(data["result"])
            ? {
                result: toCanonicalJson(data["result"]) as Readonly<Record<string, unknown>>,
              }
            : {}),
          ...(typeof data["error"] === "string" ? { error: data["error"] } : {}),
        },
      };
    }
    case "task.resume.claimed": {
      if (
        !isNonEmptyString(data["claimId"]) ||
        !isNonEmptyString(data["sourceAttemptId"]) ||
        !isNonEmptyString(data["successorAttemptId"]) ||
        !isNonEmptyString(data["ownerId"]) ||
        !isPositiveSafeInteger(data["leaseEpoch"])
      ) {
        throw new TaskRunStoreIntegrityError("TaskRun task.resume.claimed event is invalid");
      }
      return {
        ...base,
        kind: "task.resume.claimed",
        data: {
          claimId: data["claimId"],
          sourceAttemptId: data["sourceAttemptId"],
          successorAttemptId: data["successorAttemptId"],
          ownerId: data["ownerId"],
          leaseEpoch: data["leaseEpoch"],
        },
      };
    }
    case "attempt.launch.claimed": {
      if (
        !isNonEmptyString(data["attemptId"]) ||
        !isNonEmptyString(data["launchId"]) ||
        !isNonEmptyString(data["ownerId"]) ||
        !isPositiveSafeInteger(data["leaseEpoch"]) ||
        !isCanonicalTimestamp(data["expiresAt"])
      ) {
        throw new TaskRunStoreIntegrityError("TaskRun attempt.launch.claimed event is invalid");
      }
      return {
        ...base,
        kind: "attempt.launch.claimed",
        data: {
          attemptId: data["attemptId"],
          launchId: data["launchId"],
          ownerId: data["ownerId"],
          leaseEpoch: data["leaseEpoch"],
          expiresAt: data["expiresAt"],
        },
      };
    }
    case "attempt.launch.succeeded": {
      if (
        !isNonEmptyString(data["attemptId"]) ||
        !isNonEmptyString(data["launchId"]) ||
        !isNonEmptyString(data["ownerId"]) ||
        !isPositiveSafeInteger(data["leaseEpoch"])
      ) {
        throw new TaskRunStoreIntegrityError("TaskRun attempt.launch.succeeded event is invalid");
      }
      return {
        ...base,
        kind: "attempt.launch.succeeded",
        data: {
          attemptId: data["attemptId"],
          launchId: data["launchId"],
          ownerId: data["ownerId"],
          leaseEpoch: data["leaseEpoch"],
          receipt: decodeLaunchReceipt(data["receipt"]),
        },
      };
    }
    case "attempt.launch.failed": {
      if (
        !isNonEmptyString(data["attemptId"]) ||
        !isNonEmptyString(data["launchId"]) ||
        !isNonEmptyString(data["ownerId"]) ||
        !isPositiveSafeInteger(data["leaseEpoch"]) ||
        !isNonEmptyString(data["error"])
      ) {
        throw new TaskRunStoreIntegrityError("TaskRun attempt.launch.failed event is invalid");
      }
      return {
        ...base,
        kind: "attempt.launch.failed",
        data: {
          attemptId: data["attemptId"],
          launchId: data["launchId"],
          ownerId: data["ownerId"],
          leaseEpoch: data["leaseEpoch"],
          error: data["error"],
        },
      };
    }
    case "task.parked": {
      if (
        (data["sourceAttemptId"] !== undefined && !isNonEmptyString(data["sourceAttemptId"])) ||
        !Array.isArray(data["reasons"]) ||
        data["reasons"].length === 0 ||
        data["reasons"].some((reason) => !isTaskResumeParkReason(reason)) ||
        new Set(data["reasons"]).size !== data["reasons"].length ||
        (data["diagnostics"] !== undefined &&
          (!Array.isArray(data["diagnostics"]) ||
            data["diagnostics"].some((diagnostic) => typeof diagnostic !== "string")))
      ) {
        throw new TaskRunStoreIntegrityError("TaskRun task.parked event is invalid");
      }
      return {
        ...base,
        kind: "task.parked",
        data: {
          ...(typeof data["sourceAttemptId"] === "string"
            ? { sourceAttemptId: data["sourceAttemptId"] }
            : {}),
          reasons: [...data["reasons"]] as TaskResumeParkReason[],
          ...(Array.isArray(data["diagnostics"])
            ? { diagnostics: [...data["diagnostics"]] as string[] }
            : {}),
        },
      };
    }
    case "task.finished": {
      if (
        !isTaskRunTerminalStatus(data["status"]) ||
        (data["attemptId"] !== undefined && !isNonEmptyString(data["attemptId"])) ||
        (data["completionId"] !== undefined && !isNonEmptyString(data["completionId"])) ||
        (data["result"] !== undefined && !isRecord(data["result"])) ||
        (data["error"] !== undefined && typeof data["error"] !== "string")
      ) {
        throw new TaskRunStoreIntegrityError("TaskRun task.finished event is invalid");
      }
      return {
        ...base,
        kind: "task.finished",
        data: {
          status: data["status"],
          ...(typeof data["attemptId"] === "string" ? { attemptId: data["attemptId"] } : {}),
          ...(typeof data["completionId"] === "string"
            ? { completionId: data["completionId"] }
            : {}),
          ...(isRecord(data["result"])
            ? {
                result: toCanonicalJson(data["result"]) as Readonly<Record<string, unknown>>,
              }
            : {}),
          ...(typeof data["error"] === "string" ? { error: data["error"] } : {}),
        },
      };
    }
    default:
      throw new TaskRunStoreIntegrityError("TaskRun event kind is invalid");
  }
}

function decodeTaskSafeBoundary(value: unknown): TaskSafeBoundary {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value["storageRootId"]) ||
    !isNonEmptyString(value["workspacePath"]) ||
    typeof value["backgroundOperationsSettled"] !== "boolean" ||
    (value["toolCatalogHash"] !== undefined && !isNonEmptyString(value["toolCatalogHash"])) ||
    (value["checkpointRef"] !== undefined && !isNonEmptyString(value["checkpointRef"]))
  ) {
    throw new TaskRunStoreIntegrityError("TaskRun safe boundary is invalid");
  }
  const workspacePath = canonicalizeWorkspacePath(value["workspacePath"]);
  if (workspacePath !== value["workspacePath"]) {
    throw new TaskRunStoreIntegrityError("TaskRun safe boundary workspacePath is not canonical");
  }
  let runtime: TaskSafeBoundary["runtime"];
  if (value["runtime"] !== undefined) {
    const candidate = value["runtime"];
    if (
      !isRecord(candidate) ||
      !isNonEmptyString(candidate["sessionId"]) ||
      !isNonEmptyString(candidate["runId"]) ||
      !isNonNegativeSafeInteger(candidate["eventHighWater"]) ||
      (candidate["terminalEventId"] !== undefined &&
        !isNonEmptyString(candidate["terminalEventId"]))
    ) {
      throw new TaskRunStoreIntegrityError("TaskRun Runtime boundary is invalid");
    }
    runtime = {
      sessionId: candidate["sessionId"],
      runId: candidate["runId"],
      eventHighWater: candidate["eventHighWater"],
      ...(typeof candidate["terminalEventId"] === "string"
        ? { terminalEventId: candidate["terminalEventId"] }
        : {}),
    };
  }
  return {
    storageRootId: value["storageRootId"],
    workspacePath,
    backgroundOperationsSettled: value["backgroundOperationsSettled"],
    ...(runtime ? { runtime } : {}),
    ...(typeof value["toolCatalogHash"] === "string"
      ? { toolCatalogHash: value["toolCatalogHash"] }
      : {}),
    ...(typeof value["checkpointRef"] === "string"
      ? { checkpointRef: value["checkpointRef"] }
      : {}),
  };
}

function decodeLaunchReceipt(value: unknown): RecoverableTaskLaunchReceipt {
  try {
    return validateRecoverableTaskLaunchReceipt(value);
  } catch {
    throw new TaskRunStoreIntegrityError("TaskRun launch receipt is invalid");
  }
}

function replayProjection(
  header: TaskRunFileHeader,
  events: readonly LoadedTaskRunEvent[],
): TaskRunProjection {
  const projection: MutableTaskRunProjection = {
    header,
    revision: 0,
    status: "queued",
    attempts: [],
    parkReasons: [],
    parkDiagnostics: [],
  };
  const indexes: ProjectionIndexes = {
    attempts: new Map(),
    claims: new Map(),
    claimIds: new Set(),
  };
  let lastSequence = 0;
  let lastRevision = 0;
  for (const persisted of events) {
    if (persisted.entry.sequence !== lastSequence + 1) {
      throw new TaskRunStoreIntegrityError(
        `TaskRun ${header.taskRunId} sequence ${persisted.entry.sequence} is not contiguous`,
      );
    }
    if (persisted.revision < lastRevision || persisted.revision > lastRevision + 1) {
      throw new TaskRunStoreIntegrityError(
        `TaskRun ${header.taskRunId} revision ${persisted.revision} is not contiguous`,
      );
    }
    applyTaskRunEvent(projection, indexes, persisted.entry.event, persisted.entry.committedAt);
    lastSequence = persisted.entry.sequence;
    lastRevision = persisted.revision;
    projection.revision = persisted.revision;
    projection.lastTransactionId = persisted.transactionId;
  }
  return immutableProjection(projection);
}

function applyTaskRunEvent(
  projection: MutableTaskRunProjection,
  indexes: ProjectionIndexes,
  event: TaskRunEvent,
  committedAt: string,
): void {
  if (projection.terminal) {
    throw new TaskRunStoreIntegrityError(
      `TaskRun ${projection.header.taskRunId} has events after its terminal fact`,
    );
  }
  switch (event.kind) {
    case "attempt.started": {
      if (projection.attempts.some(({ status }) => status === "running")) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun ${projection.header.taskRunId} already has a running Attempt`,
        );
      }
      if (indexes.attempts.has(event.data.attemptId)) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun Attempt ${event.data.attemptId} is duplicated`,
        );
      }
      const expectedAttemptNumber = projection.attempts.length + 1;
      if (
        event.data.attemptNumber !== expectedAttemptNumber ||
        event.data.attemptNumber > projection.header.maxAttempts
      ) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun Attempt ${event.data.attemptId} has an invalid attemptNumber`,
        );
      }
      if (event.data.attemptNumber === 1) {
        if (event.data.sourceAttemptId !== undefined) {
          throw new TaskRunStoreIntegrityError("Initial TaskRun Attempt cannot have a source");
        }
      } else {
        const sourceAttemptId = event.data.sourceAttemptId;
        const source = sourceAttemptId ? indexes.attempts.get(sourceAttemptId) : undefined;
        const claim = sourceAttemptId ? indexes.claims.get(sourceAttemptId) : undefined;
        if (
          !source ||
          source.status !== "interrupted" ||
          !source.execution ||
          !claim ||
          claim.successorAttemptId !== event.data.attemptId ||
          claim.leaseEpoch !== source.execution.leaseEpoch + 1
        ) {
          throw new TaskRunStoreIntegrityError(
            `TaskRun successor Attempt ${event.data.attemptId} has no valid resume claim`,
          );
        }
      }
      const attempt: MutableTaskAttempt = {
        attemptId: event.data.attemptId,
        attemptNumber: event.data.attemptNumber,
        ...(event.data.sourceAttemptId ? { sourceAttemptId: event.data.sourceAttemptId } : {}),
        status: "running",
        startedAt: event.at,
      };
      projection.attempts.push(attempt);
      indexes.attempts.set(attempt.attemptId, attempt);
      projection.status = "running";
      projection.parkReasons = [];
      projection.parkDiagnostics = [];
      break;
    }
    case "attempt.execution.claimed": {
      const attempt = requireRunningAttempt(indexes, event.data.attemptId);
      if (event.data.expiresAt <= committedAt) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun Attempt ${attempt.attemptId} execution lease expires before its claim`,
        );
      }
      const current = attempt.execution;
      if (!current) {
        if (attempt.sourceAttemptId) {
          const source = indexes.attempts.get(attempt.sourceAttemptId);
          const claim = indexes.claims.get(attempt.sourceAttemptId);
          if (
            !source?.execution ||
            !claim ||
            claim.successorAttemptId !== attempt.attemptId ||
            claim.ownerId !== event.data.ownerId ||
            claim.leaseEpoch !== event.data.leaseEpoch ||
            event.data.leaseEpoch !== source.execution.leaseEpoch + 1
          ) {
            throw new TaskRunStoreIntegrityError(
              `TaskRun successor Attempt ${attempt.attemptId} has no valid execution owner`,
            );
          }
        }
      } else if (
        current.expiresAt > committedAt ||
        event.data.leaseEpoch !== current.leaseEpoch + 1
      ) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun Attempt ${attempt.attemptId} execution lease cannot be transferred`,
        );
      }
      attempt.execution = {
        ownerId: event.data.ownerId,
        leaseEpoch: event.data.leaseEpoch,
        claimedAt: event.at,
        expiresAt: event.data.expiresAt,
      };
      break;
    }
    case "attempt.execution.renewed": {
      const attempt = requireOwnedRunningAttempt(
        indexes,
        event.data.attemptId,
        event.data.ownerId,
        event.data.leaseEpoch,
        committedAt,
      );
      if (event.data.expiresAt <= attempt.execution!.expiresAt) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun Attempt ${attempt.attemptId} execution lease renewal must extend expiry`,
        );
      }
      attempt.execution = {
        ...attempt.execution!,
        expiresAt: event.data.expiresAt,
        renewedAt: event.at,
      };
      break;
    }
    case "attempt.execution.released": {
      const attempt = requireOwnedRunningAttempt(
        indexes,
        event.data.attemptId,
        event.data.ownerId,
        event.data.leaseEpoch,
        committedAt,
      );
      attempt.execution = {
        ...attempt.execution!,
        expiresAt: committedAt,
        releasedAt: event.at,
      };
      break;
    }
    case "attempt.checkpointed": {
      const attempt = requireOwnedRunningAttempt(
        indexes,
        event.data.attemptId,
        event.data.ownerId,
        event.data.leaseEpoch,
        committedAt,
      );
      assertAttemptWasLaunched(attempt);
      attempt.boundary = structuredClone(event.data.boundary);
      break;
    }
    case "attempt.finished": {
      const attempt = requireOwnedRunningAttempt(
        indexes,
        event.data.attemptId,
        event.data.ownerId,
        event.data.leaseEpoch,
        committedAt,
      );
      assertAttemptCanFinish(attempt, event.data.status);
      attempt.status = event.data.status;
      attempt.finishedAt = event.at;
      attempt.result = event.data.result;
      attempt.error = event.data.error;
      projection.status = "queued";
      break;
    }
    case "task.resume.claimed": {
      const source = indexes.attempts.get(event.data.sourceAttemptId);
      if (
        !source ||
        source.status !== "interrupted" ||
        projection.attempts.at(-1)?.attemptId !== source.attemptId
      ) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun resume claim ${event.data.claimId} source is not interrupted`,
        );
      }
      if (indexes.claimIds.has(event.data.claimId) || indexes.claims.has(source.attemptId)) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun resume claim ${event.data.claimId} is duplicated`,
        );
      }
      if (
        indexes.attempts.has(event.data.successorAttemptId) ||
        !source.execution ||
        event.data.leaseEpoch !== source.execution.leaseEpoch + 1 ||
        projection.attempts.length >= projection.header.maxAttempts
      ) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun resume claim ${event.data.claimId} has an invalid successor`,
        );
      }
      indexes.claimIds.add(event.data.claimId);
      indexes.claims.set(source.attemptId, event.data);
      break;
    }
    case "attempt.launch.claimed": {
      const attempt = requireRunningAttempt(indexes, event.data.attemptId);
      if (!attempt.sourceAttemptId) {
        throw new TaskRunStoreIntegrityError(
          `Initial TaskRun Attempt ${attempt.attemptId} cannot use a resume launch lease`,
        );
      }
      const current = attempt.launch;
      const execution = attempt.execution;
      if (
        !execution ||
        execution.ownerId !== event.data.ownerId ||
        execution.expiresAt <= committedAt ||
        event.data.leaseEpoch <= (current?.leaseEpoch ?? 0) ||
        event.data.expiresAt <= committedAt ||
        (current !== undefined && current.launchId !== event.data.launchId) ||
        current?.status === "succeeded" ||
        (current?.status === "claimed" && current.expiresAt > committedAt)
      ) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun Attempt ${attempt.attemptId} has an invalid launch lease claim`,
        );
      }
      attempt.launch = {
        launchId: event.data.launchId,
        status: "claimed",
        ownerId: event.data.ownerId,
        leaseEpoch: event.data.leaseEpoch,
        executionLeaseEpoch: execution.leaseEpoch,
        claimedAt: event.at,
        expiresAt: event.data.expiresAt,
      };
      break;
    }
    case "attempt.launch.succeeded": {
      const attempt = requireCurrentLaunch(indexes, event, committedAt);
      assertLaunchReceiptMatchesSourceBoundary(indexes, attempt, event.data.receipt);
      attempt.launch = {
        ...attempt.launch!,
        status: "succeeded",
        settledAt: event.at,
        receipt: structuredClone(event.data.receipt),
      };
      break;
    }
    case "attempt.launch.failed": {
      const attempt = requireCurrentLaunch(indexes, event, committedAt);
      attempt.launch = {
        ...attempt.launch!,
        status: "failed",
        settledAt: event.at,
        error: event.data.error,
      };
      break;
    }
    case "task.parked": {
      if (projection.attempts.some(({ status }) => status === "running")) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun ${projection.header.taskRunId} cannot be parked while an Attempt is running`,
        );
      }
      if (
        event.data.sourceAttemptId !== undefined &&
        !indexes.attempts.has(event.data.sourceAttemptId)
      ) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun parked fact references an unknown source Attempt`,
        );
      }
      projection.status = "parked";
      projection.parkReasons = [...event.data.reasons];
      projection.parkDiagnostics = [...(event.data.diagnostics ?? [])];
      break;
    }
    case "task.finished": {
      if (projection.attempts.some(({ status }) => status === "running")) {
        throw new TaskRunStoreIntegrityError(
          `TaskRun ${projection.header.taskRunId} cannot finish while an Attempt is running`,
        );
      }
      if (event.data.attemptId !== undefined) {
        const attempt = indexes.attempts.get(event.data.attemptId);
        if (
          !attempt ||
          attempt.status === "running" ||
          attempt.status === "interrupted" ||
          attempt.status !== event.data.status
        ) {
          throw new TaskRunStoreIntegrityError(
            `TaskRun terminal fact does not match Attempt ${event.data.attemptId}`,
          );
        }
      }
      projection.status = event.data.status;
      projection.terminal = structuredClone(event.data);
      projection.parkReasons = [];
      projection.parkDiagnostics = [];
      break;
    }
  }
}

function requireRunningAttempt(indexes: ProjectionIndexes, attemptId: string): MutableTaskAttempt {
  const attempt = indexes.attempts.get(attemptId);
  if (!attempt || attempt.status !== "running") {
    throw new TaskRunStoreIntegrityError(`TaskRun Attempt ${attemptId} is not running`);
  }
  return attempt;
}

function requireOwnedRunningAttempt(
  indexes: ProjectionIndexes,
  attemptId: string,
  ownerId: string,
  leaseEpoch: number,
  committedAt: string,
): MutableTaskAttempt {
  const attempt = requireRunningAttempt(indexes, attemptId);
  if (
    !attempt.execution ||
    attempt.execution.ownerId !== ownerId ||
    attempt.execution.leaseEpoch !== leaseEpoch ||
    attempt.execution.expiresAt <= committedAt
  ) {
    throw new TaskRunStoreIntegrityError(
      `TaskRun Attempt ${attemptId} execution lease fence rejected a stale mutation`,
    );
  }
  return attempt;
}

function requireCurrentLaunch(
  indexes: ProjectionIndexes,
  event:
    | Extract<TaskRunEvent, { kind: "attempt.launch.succeeded" }>
    | Extract<TaskRunEvent, { kind: "attempt.launch.failed" }>,
  committedAt: string,
): MutableTaskAttempt {
  const attempt = requireRunningAttempt(indexes, event.data.attemptId);
  const launch = attempt.launch;
  const execution = attempt.execution;
  if (
    !launch ||
    launch.status !== "claimed" ||
    launch.launchId !== event.data.launchId ||
    launch.ownerId !== event.data.ownerId ||
    launch.leaseEpoch !== event.data.leaseEpoch ||
    committedAt >= launch.expiresAt ||
    !execution ||
    execution.ownerId !== launch.ownerId ||
    execution.leaseEpoch !== launch.executionLeaseEpoch ||
    execution.expiresAt <= committedAt
  ) {
    throw new TaskRunStoreIntegrityError(
      `TaskRun Attempt ${attempt.attemptId} launch settlement lost its lease`,
    );
  }
  return attempt;
}

function assertLaunchReceiptMatchesSourceBoundary(
  indexes: ProjectionIndexes,
  attempt: MutableTaskAttempt,
  receipt: RecoverableTaskLaunchReceipt,
): void {
  const source = attempt.sourceAttemptId
    ? indexes.attempts.get(attempt.sourceAttemptId)
    : undefined;
  const runtime = source?.boundary?.runtime;
  const launch = attempt.launch!;
  const identity = deriveRecoverableTaskRuntimeLaunchIdentity(launch.launchId);
  const expectedSequence = runtime ? runtime.eventHighWater + 1 : undefined;
  if (
    !runtime ||
    !Number.isSafeInteger(expectedSequence) ||
    receipt.launchId !== launch.launchId ||
    receipt.sessionId !== runtime.sessionId ||
    receipt.runId !== identity.runId ||
    receipt.runStartedEventId !== identity.runStartedEventId ||
    receipt.runStartedSequence !== expectedSequence
  ) {
    throw new TaskRunStoreIntegrityError(
      `TaskRun Attempt ${attempt.attemptId} launch receipt does not match its source Runtime boundary`,
    );
  }
}

function assertAttemptWasLaunched(attempt: MutableTaskAttempt): void {
  if (attempt.sourceAttemptId && attempt.launch?.status !== "succeeded") {
    throw new TaskRunStoreIntegrityError(
      `TaskRun successor Attempt ${attempt.attemptId} has not completed launch`,
    );
  }
}

function assertAttemptCanFinish(
  attempt: MutableTaskAttempt,
  status: TaskAttemptTerminalStatus,
): void {
  if (
    attempt.sourceAttemptId &&
    attempt.launch?.status !== "succeeded" &&
    !(status === "interrupted" && attempt.launch?.status === "failed")
  ) {
    throw new TaskRunStoreIntegrityError(
      `TaskRun successor Attempt ${attempt.attemptId} has not completed launch`,
    );
  }
}

function initialProjection(header: TaskRunFileHeader): TaskRunProjection {
  return {
    header,
    revision: 0,
    status: "queued",
    attempts: [],
    parkReasons: [],
    parkDiagnostics: [],
  };
}

function immutableProjection(projection: MutableTaskRunProjection): TaskRunProjection {
  return {
    header: structuredClone(projection.header),
    revision: projection.revision,
    ...(projection.lastTransactionId ? { lastTransactionId: projection.lastTransactionId } : {}),
    status: projection.status,
    attempts: projection.attempts.map(
      (attempt): TaskAttemptProjection => ({
        attemptId: attempt.attemptId,
        attemptNumber: attempt.attemptNumber,
        execution: requireExecutionProjection(attempt),
        ...(attempt.sourceAttemptId ? { sourceAttemptId: attempt.sourceAttemptId } : {}),
        status: attempt.status,
        startedAt: attempt.startedAt,
        ...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
        ...(attempt.boundary ? { boundary: structuredClone(attempt.boundary) } : {}),
        ...(attempt.result ? { result: structuredClone(attempt.result) } : {}),
        ...(attempt.error !== undefined ? { error: attempt.error } : {}),
        ...(attempt.launch ? { launch: structuredClone(attempt.launch) } : {}),
      }),
    ),
    parkReasons: [...projection.parkReasons],
    parkDiagnostics: [...projection.parkDiagnostics],
    ...(projection.terminal ? { terminal: structuredClone(projection.terminal) } : {}),
  };
}

function requireExecutionProjection(attempt: MutableTaskAttempt): TaskAttemptExecutionProjection {
  if (!attempt.execution) {
    throw new TaskRunStoreIntegrityError(
      `TaskRun Attempt ${attempt.attemptId} has no execution lease`,
    );
  }
  return structuredClone(attempt.execution);
}

function cloneProjection(projection: TaskRunProjection): TaskRunProjection {
  return structuredClone(projection);
}

function sameImmutableHeader(left: TaskRunFileHeader, right: TaskRunFileHeader): boolean {
  return (
    left.taskRunId === right.taskRunId &&
    left.workDir === right.workDir &&
    left.storageRootId === right.storageRootId &&
    left.maxAttempts === right.maxAttempts &&
    isDeepStrictEqual(left.adapter, right.adapter)
  );
}

function assertUniqueRequestedEventIds(events: readonly TaskRunEvent[]): void {
  const eventIds = new Set<string>();
  for (const event of events) {
    if (eventIds.has(event.eventId)) {
      throw new TaskRunStoreIntegrityError(
        `TaskRun append request duplicates event ID ${event.eventId}`,
      );
    }
    eventIds.add(event.eventId);
  }
}

function assertResumeBatchPairs(events: readonly TaskRunEvent[], context: string): void {
  const claims = events.filter(
    (event): event is Extract<TaskRunEvent, { kind: "task.resume.claimed" }> =>
      event.kind === "task.resume.claimed",
  );
  const successors = events.filter(
    (event): event is Extract<TaskRunEvent, { kind: "attempt.started" }> =>
      event.kind === "attempt.started" && event.data.sourceAttemptId !== undefined,
  );
  const startedAttempts = events.filter(
    (event): event is Extract<TaskRunEvent, { kind: "attempt.started" }> =>
      event.kind === "attempt.started",
  );
  const executionClaims = events.filter(
    (event): event is Extract<TaskRunEvent, { kind: "attempt.execution.claimed" }> =>
      event.kind === "attempt.execution.claimed",
  );
  const launchClaims = events.filter(
    (event): event is Extract<TaskRunEvent, { kind: "attempt.launch.claimed" }> =>
      event.kind === "attempt.launch.claimed",
  );
  for (const started of startedAttempts) {
    const matchingExecutionClaims = executionClaims.filter(
      (claim) => claim.data.attemptId === started.data.attemptId,
    );
    if (matchingExecutionClaims.length !== 1) {
      throw new TaskRunStoreIntegrityError(
        `${context} must atomically pair every started Attempt with one execution lease claim`,
      );
    }
  }
  if (claims.length !== successors.length) {
    throw new TaskRunStoreIntegrityError(
      `${context} must atomically pair every resume claim with its successor Attempt`,
    );
  }
  if (claims.length > 0 && launchClaims.length !== successors.length) {
    throw new TaskRunStoreIntegrityError(
      `${context} must atomically pair every resume claim with one successor launch claim`,
    );
  }
  for (const claim of claims) {
    const matching = successors.filter(
      (successor) =>
        successor.data.sourceAttemptId === claim.data.sourceAttemptId &&
        successor.data.attemptId === claim.data.successorAttemptId,
    );
    const matchingExecutionClaims = executionClaims.filter(
      (executionClaim) =>
        executionClaim.data.attemptId === claim.data.successorAttemptId &&
        executionClaim.data.ownerId === claim.data.ownerId &&
        executionClaim.data.leaseEpoch === claim.data.leaseEpoch,
    );
    const successor = matching[0];
    const matchingLaunchClaims = launchClaims.filter(
      (launchClaim) => launchClaim.data.attemptId === claim.data.successorAttemptId,
    );
    const launchClaim = matchingLaunchClaims[0];
    if (
      matching.length !== 1 ||
      matchingExecutionClaims.length !== 1 ||
      matchingLaunchClaims.length !== 1 ||
      !successor ||
      !launchClaim ||
      launchClaim.data.ownerId !== claim.data.ownerId ||
      launchClaim.data.leaseEpoch !== 1 ||
      launchClaim.data.launchId !==
        deriveRecoverableTaskLaunchId(
          claim.taskRunId,
          claim.data.sourceAttemptId,
          successor.data.attemptNumber,
        )
    ) {
      throw new TaskRunStoreIntegrityError(
        `${context} has a resume claim without one matching successor execution and launch owner`,
      );
    }
  }
}

function requireNonEmptyString(value: unknown, field: string, taskRunId: string): string {
  if (!isNonEmptyString(value)) {
    throw new TaskRunStoreIntegrityError(`TaskRun ${taskRunId} ${field} is invalid`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string, taskRunId: string): number {
  if (!isPositiveSafeInteger(value)) {
    throw new TaskRunStoreIntegrityError(`TaskRun ${taskRunId} ${field} is invalid`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string, taskRunId: string): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new TaskRunStoreIntegrityError(`TaskRun ${taskRunId} ${field} is invalid`);
  }
  return value;
}

function canonicalTimestamp(date: Date, field: string): string {
  const value = date.toISOString();
  if (!isCanonicalTimestamp(value)) throw new Error(`TaskRun ${field} is invalid`);
  return value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function assertNonEmptyIdentifier(value: string, field: string): void {
  if (!value.trim()) throw new Error(`TaskRun ${field} must not be empty`);
}

function isTaskAttemptTerminalStatus(value: unknown): value is TaskAttemptTerminalStatus {
  return (
    typeof value === "string" &&
    (TASK_ATTEMPT_TERMINAL_STATUSES as readonly string[]).includes(value)
  );
}

function isTaskRunTerminalStatus(value: unknown): value is TaskRunTerminalStatus {
  return (
    typeof value === "string" && (TASK_RUN_TERMINAL_STATUSES as readonly string[]).includes(value)
  );
}

function isTaskResumeParkReason(value: unknown): value is TaskResumeParkReason {
  return (
    typeof value === "string" && (TASK_RESUME_PARK_REASONS as readonly string[]).includes(value)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toCanonicalJson(value: unknown): unknown {
  return JSON.parse(canonicalJson(value)) as unknown;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TaskRunStoreIntegrityError("TaskRun JSON contains a non-finite number");
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TaskRunStoreIntegrityError("TaskRun JSON contains a non-plain object");
      }
      return `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
        )
        .join(",")}}`;
    }
    default:
      throw new TaskRunStoreIntegrityError(
        `TaskRun JSON contains unsupported ${typeof value} data`,
      );
  }
}
