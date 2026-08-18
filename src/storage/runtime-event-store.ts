import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  SESSION_EVENT_INDEX_FILE_NAME,
  SessionEventIndexEntry,
  SessionEventIndexIntegrityError,
  decodeSessionEventIndexBatch,
  encodeSessionEventIndexBatch,
  eventPayloadHash,
  sessionEventIndexEntryFromEvent,
} from "./session-event-index.js";
import {
  createInitialSessionSummaryFold,
  finalizeSessionSummary,
  foldSessionSummaryEvent,
  type SessionSummaryFold,
} from "../engine/session-summary.js";
import {
  SESSION_RUNTIME_STATE_VERSION,
  normalizeSessionRuntimeStateWritePatch,
  type SessionRuntimeStateWritePatch,
} from "../engine/session-runtime.js";
import type { SessionCursor } from "../engine/session-persistence.js";
import { canonicalizeWorkspacePath } from "../paths/pico-paths.js";
import type { DurableTranscriptEvent } from "../presentation/transcript-event-store.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  decodeRuntimeEvent,
  isLegacyDecodeOnlyKind,
  type RuntimeEvent,
} from "./runtime-event.js";
import {
  FileStorageIntegrityError,
  assertPrivateDataFileSync,
  commitFileTransactionSync,
  readFirstJsonLineSync,
  readLastJsonLineSync,
  readJsonFileSync,
  readJsonLinesSync,
  syncDirectorySync,
  writeFileAtomicSync,
  writeJsonAtomicSync,
} from "./local-file-storage.js";
import {
  SESSION_CATALOG_RELATIVE_PATH,
  SESSION_CATALOG_SCHEMA_VERSION,
  SessionCatalogIntegrityError,
  decodeSessionCatalog,
  encodeSessionCatalog,
  type MutableSessionCatalog,
  type SessionCatalog,
  type SessionCatalogRow,
} from "./session-catalog.js";
import {
  assertWorkspaceStorageRootIdentitySync,
  ensurePrivateWorkspaceStorageDirectorySync,
  prepareWorkspaceStorageLayoutSync,
  readWorkspaceStorageRootIdentitySync,
  WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
  WORKSPACE_STORAGE_COMMIT_FILE,
  WORKSPACE_STORAGE_LOCK_DIRECTORY,
  type WorkspaceStorageRootIdentity,
} from "./workspace-storage-layout.js";
import {
  createFileStorageErrorMapper,
  withLedgerStoreLock,
} from "./ledger-store-lock.js";

const RUNTIME_SESSION_MANIFEST_VERSION = 2 as const;
const RUNTIME_SESSION_FILE_VERSION = 2 as const;
const SESSION_DIRECTORY_PATTERN = /^[a-f0-9]{64}$/u;
const SESSION_FILE_NAME = "session.jsonl";
const MANIFEST_FILE_NAME = "manifest.json";
const SESSIONS_DIRECTORY_NAME = "sessions";
export const RUNTIME_EVENT_STORE_MAX_PAGE_SIZE = 250;

export interface RuntimeSessionManifest {
  readonly schemaVersion: typeof RUNTIME_SESSION_MANIFEST_VERSION;
  readonly sessionId: string;
  readonly workDir: string;
  readonly historySource: "runtime-event-v2";
  readonly createdAt: string;
}

export interface RuntimeSessionManifestProjection {
  readonly type: "session-manifest";
  readonly schemaVersion: typeof RUNTIME_SESSION_MANIFEST_VERSION;
  readonly manifest: RuntimeSessionManifest;
  readonly ledger: {
    readonly byteLength: number;
    readonly lastSequence: number;
    readonly lastTxId?: string;
  };
}

export interface InitializeRuntimeSessionOptions {
  readonly sessionId: string;
  readonly workDir: string;
  readonly now?: () => Date;
}

export interface RuntimeEventStoreOptions {
  /** Canonical Pico workspace state root containing sessions/, task-runs/, control/, and .storage/. */
  readonly storageRoot: string;
}

interface RuntimeEventStoreRecoveryPolicy {
  /** Internal diagnostic mode: derive manifests without mutating disposable projections. */
  readonly repairManifests?: boolean;
  /** Internal diagnostic mode: report, rather than truncate, an incomplete JSONL tail. */
  readonly repairIncompleteTails?: boolean;
  /** Internal diagnostic mode: open existing files without locks, recovery, chmod, or probes. */
  readonly readOnly?: boolean;
}

export interface RuntimeSessionManifestCursor {
  readonly createdAt: string;
  readonly sessionId: string;
}

export interface RuntimeSessionManifestPageOptions {
  readonly upperBound: RuntimeSessionManifestCursor;
  readonly before?: RuntimeSessionManifestCursor;
  readonly limit?: number;
}

export interface RuntimeEventStoreEntryPageOptions {
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface ReadRuntimeSessionProjectionOptions extends RuntimeEventStoreOptions {
  readonly sessionId: string;
}

export interface RuntimeEventStoreAppendResult {
  readonly inserted: boolean;
  readonly cursor: SessionCursor;
  readonly committedAt: string;
}

export interface AppendRuntimeEventBatchOptions {
  /** Session sequence CAS checked under the canonical workspace lock before any append. */
  readonly expectedSessionHighWater?: Readonly<Record<string, number>>;
  /** Optional exactly-once identity for one Plan transition. */
  readonly planOperation?: { readonly operationId: string; readonly fingerprint: string };
}

export interface RuntimeEventStoreEntry {
  readonly sequence: number;
  readonly event: RuntimeEvent;
}

/** One workspace session read in a batched {@link RuntimeEventStore.readWorkspaceSessions} pass. */
export interface WorkspaceRuntimeSessionSnapshot {
  readonly manifest: RuntimeSessionManifest;
  readonly entries: readonly RuntimeEventStoreEntry[];
}

export interface RuntimeSessionProjectionSnapshot {
  readonly manifest: RuntimeSessionManifest;
  readonly entries: readonly RuntimeEventStoreEntry[];
  readonly cursor?: SessionCursor;
}

export interface RuntimeSessionProjectionDelta {
  readonly entries: readonly RuntimeEventStoreEntry[];
  readonly cursor: SessionCursor;
}

export interface AppendRuntimeSessionStateOptions {
  readonly eventId?: string;
  readonly now?: () => Date;
}

export interface AppendRuntimeTranscriptEventOptions {
  readonly eventId?: string;
}

interface RuntimeSessionFileHeader {
  readonly type: "session";
  readonly schemaVersion: typeof RUNTIME_SESSION_FILE_VERSION;
  readonly sessionId: string;
  readonly workDir: string;
  readonly historySource: "runtime-event-v2";
  readonly createdAt: string;
}

interface RuntimeEventBatchEntry {
  readonly sequence: number;
  readonly committedAt: string;
  readonly event: RuntimeEvent;
}

interface RuntimeEventBatch {
  readonly type: "event-batch";
  readonly schemaVersion: typeof RUNTIME_SESSION_FILE_VERSION;
  readonly txId: string;
  readonly committedAt: string;
  readonly entries: readonly RuntimeEventBatchEntry[];
}

interface LoadedRuntimeSession {
  readonly header: RuntimeSessionFileHeader;
  readonly manifest: RuntimeSessionManifest;
  readonly entries: readonly RuntimeEventStoreEntry[];
}

/** appendBatch 的每会话工作集：水位上下文 + 索引 + 本批新插入事实。 */
interface SessionAppendContext {
  readonly manifest: RuntimeSessionManifest;
  /** 追加前 ledger 的末条 sequence（CAS 与新 sequence 分配的锚）。 */
  readonly lastSequence: number;
  /** 追加前 ledger 字节数（manifest/catalog 投影的锚）。 */
  readonly ledgerByteLength: number;
  /** 事件索引（含历史与本批插入），去重与 planOperation 查重共用。 */
  readonly eventById: Map<string, SessionEventIndexEntry>;
}

interface MutableRuntimeSession {
  readonly context: SessionAppendContext;
  /** 下一条事件的 sequence（lastSequence + 已插入数）。 */
  nextSequence: number;
  readonly appended: RuntimeEventBatchEntry[];
  /** 本批新插入事件的索引条目（按插入顺序，直接进索引行）。 */
  readonly appendedIndex: SessionEventIndexEntry[];
  /** 会话目录行的折叠状态：从 catalog 行（或全量重建）起折。 */
  fold: SessionSummaryFold;
}

export class RuntimeEventStoreIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeEventStoreIntegrityError";
  }
}

export class RuntimeEventStoreHighWaterConflictError extends RuntimeEventStoreIntegrityError {
  constructor(
    readonly sessionId: string,
    readonly expectedHighWater: number,
    readonly actualHighWater: number,
  ) {
    super(
      `Runtime session ${sessionId} high-water changed from ${expectedHighWater} to ${actualHighWater}`,
    );
    this.name = "RuntimeEventStoreHighWaterConflictError";
  }
}

export class RuntimeEventStorePlanOperationConflictError extends RuntimeEventStoreIntegrityError {
  constructor(readonly operationId: string) {
    super(`Plan operation ${operationId} is already bound to another fingerprint`);
    this.name = "RuntimeEventStorePlanOperationConflictError";
  }
}

/**
 * Canonical Session and Agent runtime fact store.
 *
 * Each Session owns one append-only JSONL ledger. A workspace-global file lock and durable
 * commit marker make appendBatch atomic even when it spans multiple Session ledgers.
 */
export class RuntimeEventStore {
  readonly storageRoot: string;
  private readonly sessionsRoot: string;
  private readonly lockDirectory: string;
  private readonly repairManifests: boolean;
  private readonly repairIncompleteTails: boolean;
  private readonly readOnly: boolean;
  private readonly rootIdentity?: WorkspaceStorageRootIdentity;
  private readonly ownerId = `runtime-event-store:${process.pid}:${randomUUID()}`;

  constructor(
    options: RuntimeEventStoreOptions,
    recoveryPolicy: RuntimeEventStoreRecoveryPolicy = {},
  ) {
    if (!options.storageRoot.trim()) {
      throw new Error("RuntimeEventStore requires storageRoot");
    }
    const requestedStorageRoot = resolve(options.storageRoot);
    if (existsSync(requestedStorageRoot)) {
      const metadata = lstatSync(requestedStorageRoot);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new FileStorageIntegrityError(
          `Storage root must be a real directory: ${requestedStorageRoot}`,
        );
      }
    }
    this.readOnly = recoveryPolicy.readOnly ?? false;
    this.repairManifests = recoveryPolicy.repairManifests ?? !this.readOnly;
    this.repairIncompleteTails = recoveryPolicy.repairIncompleteTails ?? !this.readOnly;
    if (this.readOnly && (this.repairManifests || this.repairIncompleteTails)) {
      throw new Error("RuntimeEventStore readOnly mode cannot enable repairs");
    }
    const rootIdentity = this.readOnly
      ? readWorkspaceStorageRootIdentitySync(requestedStorageRoot)
      : prepareWorkspaceStorageLayoutSync(requestedStorageRoot).rootIdentity;
    this.storageRoot = existsSync(requestedStorageRoot)
      ? realpathSync.native(requestedStorageRoot)
      : requestedStorageRoot;
    this.rootIdentity = rootIdentity;
    this.sessionsRoot = join(this.storageRoot, SESSIONS_DIRECTORY_NAME);
    this.lockDirectory = join(this.storageRoot, WORKSPACE_STORAGE_LOCK_DIRECTORY);
    if (!this.readOnly) ensurePrivateWorkspaceStorageDirectorySync(this.sessionsRoot);
  }

  async initializeSession(
    options: InitializeRuntimeSessionOptions,
  ): Promise<RuntimeSessionManifest> {
    this.assertWritable();
    const workDir = canonicalizeWorkspacePath(options.workDir);
    return this.withStoreLock(() => {
      const existing = this.loadSession(options.sessionId);
      if (existing) {
        if (existing.manifest.workDir !== workDir) {
          throw new RuntimeEventStoreIntegrityError(
            `Runtime session ${options.sessionId} belongs to another workspace`,
          );
        }
        return existing.manifest;
      }

      const directory = this.sessionDirectory(options.sessionId);
      if (existsSync(directory)) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime session ${options.sessionId} directory exists without a valid ledger`,
        );
      }
      const createdAt = (options.now ?? (() => new Date()))().toISOString();
      const header: RuntimeSessionFileHeader = {
        type: "session",
        schemaVersion: RUNTIME_SESSION_FILE_VERSION,
        sessionId: options.sessionId,
        workDir,
        historySource: "runtime-event-v2",
        createdAt,
      };
      const manifest = manifestFromHeader(header);
      const headerLine = encodeJsonLine(header);
      const initialFold = createInitialSessionSummaryFold();
      const catalog = this.loadSessionCatalogForWrite();
      catalog.rows.set(options.sessionId, {
        summary: finalizeSessionSummary(manifest, initialFold).summary,
        ledgerByteLength: Buffer.byteLength(headerLine),
        fold: initialFold,
      });
      commitFileTransactionSync(
        this.storageRoot,
        {
          replacements: [
            {
              relativePath: this.sessionRelativePath(options.sessionId, SESSION_FILE_NAME),
              content: headerLine,
            },
            {
              relativePath: this.sessionRelativePath(options.sessionId, MANIFEST_FILE_NAME),
              content: encodeJsonDocument(
                createManifestProjection(manifest, Buffer.byteLength(headerLine), 0),
              ),
            },
            {
              relativePath: SESSION_CATALOG_RELATIVE_PATH,
              content: encodeSessionCatalog(catalog),
            },
          ],
        },
        { ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS, transactionId: randomUUID() },
      );
      return manifest;
    });
  }

  async readSessionManifest(sessionId: string): Promise<RuntimeSessionManifest | undefined> {
    return this.withStoreLock(() => this.loadSession(sessionId)?.manifest);
  }

  async listSessionManifests(): Promise<RuntimeSessionManifest[]> {
    return this.withStoreLock(() => this.loadAllSessionManifests());
  }

  async getSessionManifestScanUpperBound(): Promise<RuntimeSessionManifestCursor | undefined> {
    const first = (await this.listSessionManifests())[0];
    return first ? { createdAt: first.createdAt, sessionId: first.sessionId } : undefined;
  }

  /** Bounded manifest page for background maintenance. */
  async listSessionManifestsPage(
    options: RuntimeSessionManifestPageOptions,
  ): Promise<RuntimeSessionManifest[]> {
    const upperBound = normalizeManifestCursor(options.upperBound, "upperBound");
    const before = options.before ? normalizeManifestCursor(options.before, "before") : undefined;
    const limit = normalizePageLimit(options.limit);
    return this.withStoreLock(() =>
      this.loadAllSessionManifests()
        .filter((manifest) => compareManifestToCursor(manifest, upperBound) >= 0)
        .filter((manifest) => !before || compareManifestToCursor(manifest, before) > 0)
        .slice(0, limit),
    );
  }

  async append(event: RuntimeEvent): Promise<RuntimeEventStoreAppendResult> {
    this.assertWritable();
    const results = await this.appendBatch([event]);
    return results[0]!;
  }

  /**
   * Atomically appends an ordered group of facts. Validation and exact-once checks complete
   * before one commit marker publishes all affected Session batches and manifest projections.
   */
  async appendBatch(
    events: readonly RuntimeEvent[],
    options: AppendRuntimeEventBatchOptions = {},
  ): Promise<readonly RuntimeEventStoreAppendResult[]> {
    this.assertWritable();
    const canonicalEvents = events.map(canonicalizeRuntimeEvent);
    if (canonicalEvents.length === 0) return [];

    return this.withStoreLock(() => {
      const hashedEvents = canonicalEvents.map((event) => ({ event, hash: eventPayloadHash(event) }));
      // catalog 预载：折叠状态来自行内；行缺失或水位不符时全量重建该行（罕见路径）。
      const catalog = this.loadSessionCatalogForWrite();
      const sessions = new Map<string, MutableRuntimeSession>();
      for (const { event } of hashedEvents) {
        if (sessions.has(event.sessionId)) continue;
        const context = this.requireSessionAppendContext(event.sessionId);
        const row = catalog.rows.get(event.sessionId);
        const foldRow =
          row && row.fold.headSequence === context.lastSequence &&
          row.ledgerByteLength === context.ledgerByteLength
            ? row
            : catalogRowFromSession(
                context.manifest,
                this.requireSession(event.sessionId).entries,
                context.ledgerByteLength,
              );
        sessions.set(event.sessionId, {
          context,
          nextSequence: context.lastSequence + 1,
          appended: [],
          appendedIndex: [],
          fold: foldRow.fold,
        });
      }
      for (const [sessionId, expectedHighWater] of Object.entries(
        options.expectedSessionHighWater ?? {},
      )) {
        if (!Number.isSafeInteger(expectedHighWater) || expectedHighWater < 0) {
          throw new Error(`Runtime session ${sessionId} expected high-water is invalid`);
        }
        if (!sessions.has(sessionId)) {
          throw new Error(
            `Runtime session ${sessionId} high-water CAS has no event in this append batch`,
          );
        }
      }
      if (options.planOperation) {
        const { operationId, fingerprint } = options.planOperation;
        if (!operationId.trim() || !/^sha256:[a-f0-9]{64}$/u.test(fingerprint)) {
          throw new Error("Plan operation identity is invalid");
        }
        const existingOperation = [...sessions.values()]
          .flatMap((session) => [...session.context.eventById.values()])
          .find((indexed) => indexed.operationId === operationId);
        if (existingOperation) {
          if (existingOperation.fingerprint !== fingerprint) {
            throw new RuntimeEventStorePlanOperationConflictError(operationId);
          }
          return canonicalEvents.map((event) => {
            const session = sessions.get(event.sessionId)!;
            const existing = session.context.eventById.get(event.eventId);
            if (!existing)
              throw new RuntimeEventStoreIntegrityError(
                `Plan operation ${operationId} replay batch is incomplete`,
              );
            return this.appendResultFor(
              event.sessionId,
              existing.sequence,
              existing.eventId,
              existing.eventAt,
              false,
            );
          });
        }
      }
      let hasNewEvent = false;
      const requestedEventBySession = new Map<string, Map<string, RuntimeEvent>>();
      for (const { event, hash } of hashedEvents) {
        const session = sessions.get(event.sessionId)!;
        const requestedEvents =
          requestedEventBySession.get(event.sessionId) ?? new Map<string, RuntimeEvent>();
        requestedEventBySession.set(event.sessionId, requestedEvents);
        const requested = requestedEvents.get(event.eventId);
        if (requested && !isDeepStrictEqual(requested, event)) {
          throw new RuntimeEventStoreIntegrityError(
            `Runtime event ID ${event.eventId} is bound to conflicting payloads in one append batch`,
          );
        }
        if (!requested) requestedEvents.set(event.eventId, event);
        if (
          event.kind === "run.started" &&
          canonicalizeWorkspacePath(event.data.workDir) !== session.context.manifest.workDir
        ) {
          throw new RuntimeEventStoreIntegrityError(
            `Runtime event workspace does not match session ${event.sessionId}`,
          );
        }
        const existing = session.context.eventById.get(event.eventId);
        if (!existing) {
          hasNewEvent = true;
          continue;
        }
        if (existing.hash !== hash) {
          throw new RuntimeEventStoreIntegrityError(
            `Runtime event ID ${event.eventId} is already bound to another payload`,
          );
        }
      }
      if (!hasNewEvent) {
        return canonicalEvents.map((event) => {
          const session = sessions.get(event.sessionId)!;
          const existing = session.context.eventById.get(event.eventId)!;
          return this.appendResultFor(
            event.sessionId,
            existing.sequence,
            existing.eventId,
            existing.eventAt,
            false,
          );
        });
      }
      for (const [sessionId, expectedHighWater] of Object.entries(
        options.expectedSessionHighWater ?? {},
      )) {
        const session = sessions.get(sessionId)!;
        if (session.context.lastSequence !== expectedHighWater) {
          throw new RuntimeEventStoreHighWaterConflictError(
            sessionId,
            expectedHighWater,
            session.context.lastSequence,
          );
        }
      }

      const results: RuntimeEventStoreAppendResult[] = [];
      for (const { event, hash } of hashedEvents) {
        const session = sessions.get(event.sessionId)!;
        const existing = session.context.eventById.get(event.eventId);
        if (existing) {
          if (existing.hash !== hash) {
            throw new RuntimeEventStoreIntegrityError(
              `Runtime event ID ${event.eventId} is already bound to another payload`,
            );
          }
          results.push(
            this.appendResultFor(
              event.sessionId,
              existing.sequence,
              existing.eventId,
              existing.eventAt,
              false,
            ),
          );
          continue;
        }

        const sequence = session.nextSequence;
        session.nextSequence += 1;
        const indexEntry = sessionEventIndexEntryFromEvent(sequence, event, hash);
        session.context.eventById.set(event.eventId, indexEntry);
        session.appended.push({
          sequence,
          committedAt: event.at,
          event,
        });
        session.appendedIndex.push(indexEntry);
        session.fold = foldSessionSummaryEvent(session.fold, event);
        results.push(this.appendResultFor(event.sessionId, sequence, event.eventId, event.at, true));
      }

      const transactionId = randomUUID();
      const transactionCommittedAt = new Date().toISOString();
      const batchLinesForManifest = new Map<
        string,
        { ledgerByteLength: number; lastSequence: number }
      >();
      const appendedSessions = [...sessions.entries()].filter(
        ([, session]) => session.appended.length > 0,
      );
      const appends = appendedSessions.flatMap(([sessionId, session]) => {
        const batch: RuntimeEventBatch = {
          type: "event-batch",
          schemaVersion: RUNTIME_SESSION_FILE_VERSION,
          txId: transactionId,
          committedAt: transactionCommittedAt,
          entries: session.appended,
        };
        const ledgerLine = encodeJsonLine(batch);
        batchLinesForManifest.set(sessionId, {
          ledgerByteLength: session.context.ledgerByteLength + Buffer.byteLength(ledgerLine),
          lastSequence: session.nextSequence - 1,
        });
        return [
          {
            relativePath: this.sessionRelativePath(sessionId, SESSION_FILE_NAME),
            content: ledgerLine,
          },
          {
            relativePath: this.sessionRelativePath(sessionId, SESSION_EVENT_INDEX_FILE_NAME),
            content: encodeSessionEventIndexBatch({
              txId: transactionId,
              entries: session.appendedIndex,
            }),
          },
        ];
      });
      const replacements = appendedSessions.map(([sessionId, session]) => {
        this.assertSessionDigestBoundary(sessionDigest(sessionId));
        const watermark = batchLinesForManifest.get(sessionId)!;
        return {
          relativePath: this.sessionRelativePath(sessionId, MANIFEST_FILE_NAME),
          content: encodeJsonDocument(
            createManifestProjection(
              session.context.manifest,
              watermark.ledgerByteLength,
              watermark.lastSequence,
              transactionId,
            ),
          ),
        };
      });

      if (appends.length > 0) {
        for (const [sessionId, session] of appendedSessions) {
          const watermark = batchLinesForManifest.get(sessionId)!;
          catalog.rows.set(sessionId, {
            summary: finalizeSessionSummary(session.context.manifest, session.fold).summary,
            ledgerByteLength: watermark.ledgerByteLength,
            fold: session.fold,
          });
        }
        commitFileTransactionSync(
          this.storageRoot,
          {
            appends,
            replacements: [
              ...replacements,
              {
                relativePath: SESSION_CATALOG_RELATIVE_PATH,
                content: encodeSessionCatalog(catalog),
              },
            ],
          },
          {
            ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
            transactionId,
          },
        );
      }
      return results;
    });
  }

  async appendPlanOperation(
    events: readonly RuntimeEvent[],
    operation: {
      readonly operationId: string;
      readonly fingerprint: string;
      readonly expectedSessionSequence: number;
    },
  ): Promise<readonly RuntimeEventStoreAppendResult[]> {
    const sessionId = events[0]?.sessionId;
    if (!sessionId || events.some((event) => event.sessionId !== sessionId)) {
      throw new Error("Plan operation events must belong to one session");
    }
    return this.appendBatch(events, {
      expectedSessionHighWater: { [sessionId]: operation.expectedSessionSequence },
      planOperation: operation,
    });
  }

  /**
   * Appends a Graph Mode operation under the same operationId + fingerprint CAS
   * envelope as {@link appendPlanOperation}. The mechanism is identical: the
   * store deduplicates by operationId and rejects conflicting fingerprints.
   * Graph events reuse the planOperation path because the CAS contract is the
   * same durable exactly-once identity.
   */
  async appendGraphOperation(
    events: readonly RuntimeEvent[],
    operation: {
      readonly operationId: string;
      readonly fingerprint: string;
      readonly expectedSessionSequence: number;
    },
  ): Promise<readonly RuntimeEventStoreAppendResult[]> {
    const sessionId = events[0]?.sessionId;
    if (!sessionId || events.some((event) => event.sessionId !== sessionId)) {
      throw new Error("Graph operation events must belong to one session");
    }
    return this.appendBatch(events, {
      expectedSessionHighWater: { [sessionId]: operation.expectedSessionSequence },
      planOperation: operation,
    });
  }

  async appendSessionState(
    sessionId: string,
    patch: SessionRuntimeStateWritePatch,
    options: AppendRuntimeSessionStateOptions = {},
  ): Promise<RuntimeEventStoreAppendResult> {
    this.assertWritable();
    const normalized = normalizeSessionRuntimeStateWritePatch(patch);
    if (!normalized) throw new Error("Runtime session state write patch is invalid");
    const at = (options.now ?? (() => new Date()))().toISOString();
    return this.append({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      eventId: options.eventId ?? createRuntimeEventId("session-state"),
      sessionId,
      invocationId: `session:${sessionId}:state`,
      runId: "session-state",
      turnId: "session-state",
      at,
      partial: false,
      visibility: "internal",
      kind: "session.state.committed",
      data: {
        stateVersion: SESSION_RUNTIME_STATE_VERSION,
        patch: structuredClone(normalized),
      },
    });
  }

  async appendTranscriptEvent(
    sessionId: string,
    event: DurableTranscriptEvent,
    options: AppendRuntimeTranscriptEventOptions = {},
  ): Promise<RuntimeEventStoreAppendResult> {
    this.assertWritable();
    return this.append({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      eventId: options.eventId ?? `transcript:${event.eventId}`,
      sessionId,
      invocationId: `session:${sessionId}:transcript`,
      runId: "session-transcript",
      turnId: "transcript",
      at: new Date(event.createdAt).toISOString(),
      partial: false,
      visibility: "transcript",
      kind: "transcript.event.recorded",
      data: { event: structuredClone(event) },
    });
  }

  async readRun(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    return this.withStoreLock(() =>
      (this.loadSession(sessionId)?.entries ?? [])
        .filter((entry) => entry.event.runId === runId)
        .map((entry) => entry.event),
    );
  }

  async readSession(sessionId: string): Promise<RuntimeEvent[]> {
    return (await this.readSessionEntries(sessionId)).map(({ event }) => event);
  }

  async readSessionEvent(
    sessionId: string,
    eventId: string,
  ): Promise<RuntimeEventStoreEntry | undefined> {
    return this.withStoreLock(() =>
      this.loadSession(sessionId)?.entries.find((entry) => entry.event.eventId === eventId),
    );
  }

  async readSessionEntries(sessionId: string): Promise<RuntimeEventStoreEntry[]> {
    return this.withStoreLock(() => [...(this.loadSession(sessionId)?.entries ?? [])]);
  }

  /**
   * 单次锁周期内读取工作区全部会话的 manifest + ledger entries。逐会话调用
   * readSessionEntries 会为每个会话各付一次锁获取/释放仪式（含多次 fsync），
   * 会话列表类调用方应改走这里。批量路径直接从 ledger 头推导 manifest，
   * 不走 loadAllSessionManifests 的快路径校验（那会为每个会话多读一遍
   * manifest.json + 头行 + 尾行，而本方法本来就要全量读 ledger）。
   */
  async readWorkspaceSessions(): Promise<WorkspaceRuntimeSessionSnapshot[]> {
    return this.withStoreLock(() => this.loadWorkspaceSessionsLocked());
  }

  /**
   * 无锁读取会话目录：缺文件返回 undefined；结构损坏抛
   * {@link SessionCatalogIntegrityError}（调用方以此触发重建）。catalog 由
   * 原子 rename 发布，跨进程读到的要么是旧版要么是新版，不会撕裂。
   */
  readSessionCatalog(): SessionCatalog | undefined {
    const path = join(this.storageRoot, SESSION_CATALOG_RELATIVE_PATH);
    if (!existsSync(path)) return undefined;
    assertPrivateDataFileSync(path);
    return decodeSessionCatalog(readFileSync(path, "utf8"), path);
  }

  /** 锁内从 ledger 全量重建会话目录并落盘（readOnly store 只重建不落盘）。 */
  async rebuildSessionCatalog(): Promise<SessionCatalog> {
    return this.withStoreLock(() => this.rebuildSessionCatalogLocked());
  }

  /** 水位校验（无锁 stat）：catalog 行记录的 ledger 字节长度是否与当前文件一致。 */
  sessionLedgerSizeMatches(sessionId: string, expectedByteLength: number): boolean {
    const path = this.sessionFilePath(sessionId);
    if (!existsSync(path)) return false;
    return statSync(path).size === expectedByteLength;
  }

  /**
   * 列表专用：读 catalog 并剔除会话目录已不存在的行（deleteSession 崩溃窗口
   * 的幽灵行兜底）。代价是一次 readdir，不逐会话 stat。
   */
  readSessionCatalogForListing(): SessionCatalog | undefined {
    const catalog = this.readSessionCatalog();
    if (!catalog) return undefined;
    if (!existsSync(this.sessionsRoot)) return { schemaVersion: catalog.schemaVersion, rows: new Map() };
    this.assertSessionsBoundary();
    const liveDigests = new Set<string>();
    for (const entry of readdirSync(this.sessionsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && SESSION_DIRECTORY_PATTERN.test(entry.name)) {
        liveDigests.add(entry.name);
      }
    }
    const rows = new Map<string, SessionCatalogRow>();
    for (const [sessionId, row] of catalog.rows) {
      if (liveDigests.has(sessionDigest(sessionId))) rows.set(sessionId, row);
    }
    return { schemaVersion: catalog.schemaVersion, rows };
  }

  /** Bounded sequence page for cooperative background scans. */
  async readSessionEntriesPage(
    sessionId: string,
    options: RuntimeEventStoreEntryPageOptions = {},
  ): Promise<RuntimeEventStoreEntry[]> {
    const afterSequence = normalizePageOffset(options.afterSequence, "afterSequence");
    const limit = normalizePageLimit(options.limit);
    return this.withStoreLock(() =>
      (this.loadSession(sessionId)?.entries ?? [])
        .filter((entry) => entry.sequence > afterSequence)
        .slice(0, limit),
    );
  }

  /** Reads one internally consistent canonical projection for recovery or repair. */
  async readSessionProjection(
    sessionId: string,
  ): Promise<RuntimeSessionProjectionSnapshot | undefined> {
    return this.withStoreLock(() => this.projectionForSession(this.loadSession(sessionId)));
  }

  /**
   * Reads only the canonical suffix needed to advance a disposable projection.
   * Undefined means the caller must replay a full snapshot instead of inferring state.
   */
  async readSessionProjectionDelta(
    sessionId: string,
    after: SessionCursor,
    through: SessionCursor,
  ): Promise<RuntimeSessionProjectionDelta | undefined> {
    if (
      after.logId !== sessionId ||
      through.logId !== sessionId ||
      through.seq <= after.seq
    ) {
      return undefined;
    }

    return this.withStoreLock(() => {
      const loaded = this.loadSession(sessionId);
      if (!loaded) return undefined;
      const cursorEntry = loaded.entries[after.seq - 1];
      const targetEntry = loaded.entries[through.seq - 1];
      const headEntry = loaded.entries.at(-1);
      if (
        !cursorEntry ||
        !targetEntry ||
        !headEntry ||
        cursorEntry.sequence !== after.seq ||
        cursorEntry.event.eventId !== after.eventId ||
        targetEntry.sequence !== through.seq ||
        targetEntry.event.eventId !== through.eventId ||
        headEntry.sequence !== through.seq ||
        headEntry.event.eventId !== through.eventId
      ) {
        return undefined;
      }

      const entries = loaded.entries.filter(
        (entry) => entry.sequence > after.seq && entry.sequence <= through.seq,
      );
      if (entries.at(-1)?.event.eventId !== through.eventId) return undefined;
      return { entries, cursor: { ...through } };
    });
  }

  async listRunIds(sessionId: string): Promise<string[]> {
    return this.withStoreLock(() =>
      [
        ...new Set(
          (this.loadSession(sessionId)?.entries ?? [])
            .map((entry) => entry.event.runId)
            .filter((runId) => runId !== "session-state"),
        ),
      ].sort(),
    );
  }

  async getHeadCursor(sessionId: string): Promise<SessionCursor | undefined> {
    return this.withStoreLock(() => {
      const entries = this.loadSession(sessionId)?.entries ?? [];
      const head = entries.at(-1);
      return head
        ? cursorForEntries(sessionId, entries, head.sequence, head.event.eventId)
        : undefined;
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    this.assertWritable();
    return this.withStoreLock(() => {
      if (!this.loadSession(sessionId)) return false;
      const digest = sessionDigest(sessionId);
      this.assertSessionDigestBoundary(digest);
      const directory = this.sessionDirectory(sessionId);
      const tombstone = join(this.sessionsRoot, `.deleted-${digest}-${randomUUID()}`);
      renameSync(directory, tombstone);
      const tombstoneMetadata = lstatIfExists(tombstone);
      if (
        !tombstoneMetadata ||
        !tombstoneMetadata.isDirectory() ||
        tombstoneMetadata.isSymbolicLink()
      ) {
        throw new FileStorageIntegrityError(
          `Runtime session tombstone must be a real directory: ${tombstone}`,
        );
      }
      this.assertSessionsBoundary();
      syncDirectorySync(this.sessionsRoot);
      rmSync(tombstone, { recursive: true, force: true });
      this.assertSessionsBoundary();
      syncDirectorySync(this.sessionsRoot);
      // 删除不经过文件事务（rename+rm），catalog 行的清理是锁内独立原子写；
      // 这一步与目录删除之间的崩溃窗口由读取侧水位校验兜底。
      try {
        const catalog = this.readSessionCatalog();
        if (catalog?.rows.has(sessionId)) {
          mutableCatalogRows(catalog.rows).delete(sessionId);
          writeFileAtomicSync(
            join(this.storageRoot, SESSION_CATALOG_RELATIVE_PATH),
            encodeSessionCatalog(catalog),
          );
        }
      } catch (error) {
        if (!(error instanceof SessionCatalogIntegrityError)) throw error;
        // catalog 损坏：留给下一次重建，不阻塞删除。
      }
      return true;
    });
  }

  close(): void {
    // File-backed operations do not retain handles.
  }

  private assertWritable(): void {
    if (this.readOnly) throw new Error("RuntimeEventStore is read-only");
  }

  private async withStoreLock<Result>(operation: () => Result): Promise<Result> {
    const preLockAssert = () => {
      if (this.rootIdentity) {
        assertWorkspaceStorageRootIdentitySync(this.storageRoot, this.rootIdentity);
      }
      this.assertSessionsBoundary();
    };
    return withLedgerStoreLock(
      {
        lockDirectory: this.lockDirectory,
        storageRoot: this.storageRoot,
        ownerId: this.ownerId,
        transactionOptions: WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
        readOnly: this.readOnly,
        preLockAssert,
        postLockAssert: preLockAssert,
        postRecoverAssert: () => this.assertSessionsBoundary(),
        mapError: createFileStorageErrorMapper(
          RuntimeEventStoreIntegrityError,
          "Runtime event",
        ),
      },
      operation,
    );
  }

  private appendResultFor(
    sessionId: string,
    sequence: number,
    eventId: string,
    committedAt: string,
    inserted: boolean,
  ): RuntimeEventStoreAppendResult {
    return {
      inserted,
      cursor: cursorForEntries(sessionId, [], sequence, eventId),
      committedAt,
    };
  }

  /**
   * appendBatch 专用会话加载：manifest 快路径水位（头行+尾行+投影一致性
   * 校验）+ 事件索引，替代全量 loadSession。追加不再顺带全量校验 ledger
   * 中段完整性（W5 语义位移，读路径仍全量校验兜底）。
   */
  private requireSessionAppendContext(sessionId: string): SessionAppendContext {
    const watermark = this.loadSessionWatermark(sessionId);
    if (!watermark) {
      throw new RuntimeEventStoreIntegrityError(
        `Runtime session ${sessionId} must be initialized before appending events`,
      );
    }
    return {
      manifest: watermark.manifest,
      lastSequence: watermark.lastSequence,
      ledgerByteLength: watermark.ledgerByteLength,
      eventById: this.loadSessionEventIndex(sessionId, watermark.lastSequence),
    };
  }

  private loadSessionWatermark(
    sessionId: string,
  ): { manifest: RuntimeSessionManifest; lastSequence: number; ledgerByteLength: number } | undefined {
    const digest = sessionDigest(sessionId);
    this.assertSessionDigestBoundary(digest);
    const logPath = this.sessionFilePath(sessionId);
    if (!existsSync(logPath)) return undefined;
    const manifestPath = this.manifestFilePath(sessionId);
    if (existsSync(manifestPath)) {
      const projection = decodeRuntimeSessionManifestProjection(
        readJsonFileSync(manifestPath),
        manifestPath,
      );
      if (
        sessionDigest(projection.manifest.sessionId) === digest &&
        statSync(logPath).size === projection.ledger.byteLength
      ) {
        const header = readSessionHeaderSync(logPath);
        if (isDeepStrictEqual(manifestFromHeader(header), projection.manifest)) {
          const lastRecord = readLastJsonLineSync(logPath);
          if (projection.ledger.lastSequence === 0) {
            if (
              isDeepStrictEqual(lastRecord, readFirstJsonLineSync(logPath)) &&
              projection.ledger.lastTxId === undefined
            ) {
              return {
                manifest: projection.manifest,
                lastSequence: 0,
                ledgerByteLength: projection.ledger.byteLength,
              };
            }
          } else {
            const lastBatch = decodeEventBatch(lastRecord, logPath, -1);
            if (
              lastBatch.txId === projection.ledger.lastTxId &&
              lastBatch.entries.at(-1)?.sequence === projection.ledger.lastSequence
            ) {
              return {
                manifest: projection.manifest,
                lastSequence: projection.ledger.lastSequence,
                ledgerByteLength: projection.ledger.byteLength,
              };
            }
          }
        }
      }
    }
    // 快路径失配（manifest 过期/缺失/损坏）→ 全量加载兜底，保���正确性。
    const loaded = this.loadSession(sessionId);
    if (!loaded) return undefined;
    return {
      manifest: loaded.manifest,
      lastSequence: loaded.entries.at(-1)?.sequence ?? 0,
      ledgerByteLength: statSync(logPath).size,
    };
  }

  /** 事件索引加载：缺失/损坏/水位失配时从 ledger 全量重建（可丢弃投影）。 */
  private loadSessionEventIndex(
    sessionId: string,
    expectedLastSequence: number,
  ): Map<string, SessionEventIndexEntry> {
    const indexPath = join(this.sessionsRoot, sessionDigest(sessionId), SESSION_EVENT_INDEX_FILE_NAME);
    const byId = new Map<string, SessionEventIndexEntry>();
    let lastSequence = 0;
    if (existsSync(indexPath)) {
      try {
        // 不做撕裂尾修复：appends 目标的完整性由事务重放负责；索引是可丢弃
        // 投影，任何结构问题（含撕裂尾）一律重建。
        const records = readJsonLinesSync(indexPath, false);
        for (const [index, record] of records.entries()) {
          const batch = decodeSessionEventIndexBatch(record, indexPath, index + 1);
          for (const entry of batch.entries) {
            byId.set(entry.eventId, entry);
            lastSequence = entry.sequence;
          }
        }
        if (lastSequence === expectedLastSequence) return byId;
      } catch (error) {
        if (
          !(error instanceof SessionEventIndexIntegrityError) &&
          !(error instanceof FileStorageIntegrityError)
        ) {
          throw error;
        }
      }
    }
    return this.rebuildEventIndexLocked(sessionId);
  }

  private rebuildEventIndexLocked(sessionId: string): Map<string, SessionEventIndexEntry> {
    const loaded = this.requireSession(sessionId);
    const byId = new Map<string, SessionEventIndexEntry>();
    const entries: SessionEventIndexEntry[] = [];
    for (const { sequence, event } of loaded.entries) {
      const entry = sessionEventIndexEntryFromEvent(sequence, event, eventPayloadHash(event));
      byId.set(entry.eventId, entry);
      entries.push(entry);
    }
    if (!this.readOnly && entries.length > 0) {
      writeFileAtomicSync(
        join(this.sessionsRoot, sessionDigest(sessionId), SESSION_EVENT_INDEX_FILE_NAME),
        encodeSessionEventIndexBatch({ txId: `rebuild-${randomUUID()}`, entries }),
      );
    }
    return byId;
  }

  private requireSession(sessionId: string): LoadedRuntimeSession {
    const loaded = this.loadSession(sessionId);
    if (!loaded) {
      throw new RuntimeEventStoreIntegrityError(
        `Runtime session ${sessionId} must be initialized before appending events`,
      );
    }
    return loaded;
  }

  /** 写路径专用：读当前 catalog 供行级更新；缺失/损坏时锁内全量重建。 */
  private loadSessionCatalogForWrite(): MutableSessionCatalog {
    try {
      const current = this.readSessionCatalog();
      if (current) {
        return { schemaVersion: current.schemaVersion, rows: mutableCatalogRows(current.rows) };
      }
    } catch (error) {
      if (!(error instanceof SessionCatalogIntegrityError)) throw error;
    }
    return this.rebuildSessionCatalogLocked();
  }

  private rebuildSessionCatalogLocked(): MutableSessionCatalog {
    const rows = new Map<string, SessionCatalogRow>();
    for (const { manifest, entries } of this.loadWorkspaceSessionsLocked()) {
      rows.set(
        manifest.sessionId,
        catalogRowFromSession(manifest, entries, statSync(this.sessionFilePath(manifest.sessionId)).size),
      );
    }
    const catalog: MutableSessionCatalog = { schemaVersion: SESSION_CATALOG_SCHEMA_VERSION, rows };
    if (!this.readOnly) {
      writeFileAtomicSync(
        join(this.storageRoot, SESSION_CATALOG_RELATIVE_PATH),
        encodeSessionCatalog(catalog),
      );
    }
    return catalog;
  }

  private loadWorkspaceSessionsLocked(): WorkspaceRuntimeSessionSnapshot[] {
    if (!existsSync(this.sessionsRoot)) return [];
    this.assertSessionsBoundary();
    const snapshots: WorkspaceRuntimeSessionSnapshot[] = [];
    for (const entry of readdirSync(this.sessionsRoot, { withFileTypes: true })) {
      if (!SESSION_DIRECTORY_PATTERN.test(entry.name)) continue;
      this.assertSessionDigestBoundary(entry.name);
      const logPath = join(this.sessionsRoot, entry.name, SESSION_FILE_NAME);
      if (!existsSync(logPath)) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime session directory ${entry.name} has no ledger`,
        );
      }
      const header = readSessionHeaderSync(logPath);
      if (sessionDigest(header.sessionId) !== entry.name) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime session directory ${entry.name} does not match its ledger header`,
        );
      }
      const loaded = this.loadSession(header.sessionId);
      if (loaded) {
        snapshots.push({ manifest: loaded.manifest, entries: [...loaded.entries] });
      }
    }
    return snapshots.sort((a, b) => compareManifestsDescending(a.manifest, b.manifest));
  }

  private loadSession(sessionId: string): LoadedRuntimeSession | undefined {
    const digest = sessionDigest(sessionId);
    this.assertSessionDigestBoundary(digest);
    const logPath = this.sessionFilePath(sessionId);
    if (!existsSync(logPath)) return undefined;
    const records = readJsonLinesSync(logPath, this.repairIncompleteTails);
    if (records.length === 0) {
      throw new RuntimeEventStoreIntegrityError(`Runtime session ${sessionId} ledger is empty`);
    }
    const header = decodeSessionHeader(records[0], logPath);
    if (
      header.sessionId !== sessionId ||
      sessionDigest(header.sessionId) !== sessionDigest(sessionId)
    ) {
      throw new RuntimeEventStoreIntegrityError(
        `Runtime session ${sessionId} does not match its ledger header`,
      );
    }

    const entries: RuntimeEventStoreEntry[] = [];
    const eventIds = new Set<string>();
    let lastTxId: string | undefined;
    for (let index = 1; index < records.length; index++) {
      const batch = decodeEventBatch(records[index], logPath, index + 1);
      lastTxId = batch.txId;
      for (const batchEntry of batch.entries) {
        const expectedSequence = entries.length + 1;
        if (batchEntry.sequence !== expectedSequence) {
          throw new RuntimeEventStoreIntegrityError(
            `Runtime session ${sessionId} sequence ${batchEntry.sequence} is not contiguous`,
          );
        }
        if (batchEntry.event.sessionId !== sessionId) {
          throw new RuntimeEventStoreIntegrityError(
            `Runtime event ${batchEntry.event.eventId} belongs to another session`,
          );
        }
        if (eventIds.has(batchEntry.event.eventId)) {
          throw new RuntimeEventStoreIntegrityError(
            `Runtime event ID ${batchEntry.event.eventId} is duplicated in session ${sessionId}`,
          );
        }
        eventIds.add(batchEntry.event.eventId);
        entries.push({ sequence: batchEntry.sequence, event: batchEntry.event });
      }
    }

    const derivedManifest = manifestFromHeader(header);
    const derivedProjection = createManifestProjection(
      derivedManifest,
      statSync(logPath).size,
      entries.length,
      lastTxId,
    );
    const manifestPath = this.manifestFilePath(sessionId);
    let persistedProjection: RuntimeSessionManifestProjection | undefined;
    if (existsSync(manifestPath)) {
      try {
        persistedProjection = decodeRuntimeSessionManifestProjection(
          readJsonFileSync(manifestPath),
          manifestPath,
        );
      } catch (error) {
        if (
          !(error instanceof RuntimeEventStoreIntegrityError) &&
          !(error instanceof SyntaxError)
        ) {
          throw error;
        }
        // manifest.json is a disposable projection. The canonical JSONL header and facts win.
      }
    }
    if (
      this.repairManifests &&
      (!persistedProjection || !isDeepStrictEqual(persistedProjection, derivedProjection))
    ) {
      this.assertSessionDigestBoundary(digest);
      writeJsonAtomicSync(manifestPath, derivedProjection);
    }
    return { header, manifest: derivedManifest, entries };
  }

  private loadAllSessionManifests(): RuntimeSessionManifest[] {
    if (!existsSync(this.sessionsRoot)) return [];
    this.assertSessionsBoundary();
    const manifests: RuntimeSessionManifest[] = [];
    for (const entry of readdirSync(this.sessionsRoot, { withFileTypes: true })) {
      if (!SESSION_DIRECTORY_PATTERN.test(entry.name)) continue;
      this.assertSessionDigestBoundary(entry.name);
      const logPath = join(this.sessionsRoot, entry.name, SESSION_FILE_NAME);
      if (!existsSync(logPath)) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime session directory ${entry.name} has no ledger`,
        );
      }
      const fastManifest = this.loadManifestProjectionFast(entry.name, logPath);
      if (fastManifest) {
        manifests.push(fastManifest);
        continue;
      }
      const header = readSessionHeaderSync(logPath);
      if (sessionDigest(header.sessionId) !== entry.name) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime session directory ${entry.name} does not match its ledger header`,
        );
      }
      manifests.push(this.requireSession(header.sessionId).manifest);
    }
    return manifests.sort(compareManifestsDescending);
  }

  private loadManifestProjectionFast(
    sessionDirectoryName: string,
    logPath: string,
  ): RuntimeSessionManifest | undefined {
    this.assertSessionDigestBoundary(sessionDirectoryName);
    const manifestPath = join(this.sessionsRoot, sessionDirectoryName, MANIFEST_FILE_NAME);
    if (!existsSync(manifestPath)) return undefined;
    try {
      const projection = decodeRuntimeSessionManifestProjection(
        readJsonFileSync(manifestPath),
        manifestPath,
      );
      if (
        sessionDigest(projection.manifest.sessionId) !== sessionDirectoryName ||
        statSync(logPath).size !== projection.ledger.byteLength
      ) {
        return undefined;
      }
      const header = readSessionHeaderSync(logPath);
      if (
        !isDeepStrictEqual(
          manifestFromHeader(header),
          projection.manifest,
        )
      ) {
        return undefined;
      }
      const lastRecord = readLastJsonLineSync(logPath);
      if (projection.ledger.lastSequence === 0) {
        if (
          !isDeepStrictEqual(lastRecord, readFirstJsonLineSync(logPath)) ||
          projection.ledger.lastTxId !== undefined
        ) {
          return undefined;
        }
      } else {
        const lastBatch = decodeEventBatch(lastRecord, logPath, -1);
        if (
          lastBatch.txId !== projection.ledger.lastTxId ||
          lastBatch.entries.at(-1)?.sequence !== projection.ledger.lastSequence
        ) {
          return undefined;
        }
      }
      return projection.manifest;
    } catch (error) {
      if (error instanceof RuntimeEventStoreIntegrityError || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }

  private projectionForSession(
    loaded: LoadedRuntimeSession | undefined,
  ): RuntimeSessionProjectionSnapshot | undefined {
    if (!loaded) return undefined;
    const head = loaded.entries.at(-1);
    return {
      manifest: loaded.manifest,
      entries: loaded.entries,
      ...(head
        ? {
            cursor: cursorForEntries(
              loaded.header.sessionId,
              loaded.entries,
              head.sequence,
              head.event.eventId,
            ),
          }
        : {}),
    };
  }

  private sessionDirectory(sessionId: string): string {
    return join(this.sessionsRoot, sessionDigest(sessionId));
  }

  private assertSessionsBoundary(): void {
    const metadata = lstatIfExists(this.sessionsRoot);
    if (!metadata) {
      if (this.readOnly) return;
      throw new FileStorageIntegrityError(
        `Runtime Session storage directory disappeared: ${this.sessionsRoot}`,
      );
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new FileStorageIntegrityError(
        `Runtime Session storage must be a real directory: ${this.sessionsRoot}`,
      );
    }
  }

  private assertSessionDigestBoundary(digest: string): void {
    if (!SESSION_DIRECTORY_PATTERN.test(digest)) {
      throw new FileStorageIntegrityError(`Runtime Session digest is invalid: ${digest}`);
    }
    this.assertSessionsBoundary();
    const directory = join(this.sessionsRoot, digest);
    const directoryMetadata = lstatIfExists(directory);
    if (!directoryMetadata) return;
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new FileStorageIntegrityError(
        `Runtime Session directory must be a real directory: ${directory}`,
      );
    }
    for (const fileName of [SESSION_FILE_NAME, MANIFEST_FILE_NAME]) {
      const path = join(directory, fileName);
      const metadata = lstatIfExists(path);
      if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
        throw new FileStorageIntegrityError(`Runtime Session data must be a regular file: ${path}`);
      }
    }
  }

  private sessionFilePath(sessionId: string): string {
    return join(this.sessionDirectory(sessionId), SESSION_FILE_NAME);
  }

  private manifestFilePath(sessionId: string): string {
    return join(this.sessionDirectory(sessionId), MANIFEST_FILE_NAME);
  }

  private sessionRelativePath(sessionId: string, fileName: string): string {
    return join(SESSIONS_DIRECTORY_NAME, sessionDigest(sessionId), fileName);
  }
}

/**
 * Reads an existing canonical Session projection. A pending durable commit is recovered before
 * the projection is returned; a missing storage root remains a non-creating undefined result.
 */
export async function readExistingRuntimeSessionProjection(
  options: ReadRuntimeSessionProjectionOptions,
): Promise<RuntimeSessionProjectionSnapshot | undefined> {
  if (!options.storageRoot.trim()) throw new Error("RuntimeEventStore requires storageRoot");
  const root = resolve(options.storageRoot);
  const digest = sessionDigest(options.sessionId);
  if (
    !existsSync(join(root, SESSIONS_DIRECTORY_NAME, digest, SESSION_FILE_NAME)) &&
    !existsSync(join(root, WORKSPACE_STORAGE_COMMIT_FILE))
  ) {
    return undefined;
  }
  return new RuntimeEventStore(options).readSessionProjection(options.sessionId);
}

export function createRuntimeEventId(prefix = "runtime-event"): string {
  return `${prefix}:${randomUUID()}`;
}

function decodeSessionHeader(value: unknown, path: string): RuntimeSessionFileHeader {
  if (
    !isRecord(value) ||
    value["type"] !== "session" ||
    value["schemaVersion"] !== RUNTIME_SESSION_FILE_VERSION ||
    typeof value["sessionId"] !== "string" ||
    !value["sessionId"] ||
    typeof value["workDir"] !== "string" ||
    !value["workDir"] ||
    value["historySource"] !== "runtime-event-v2" ||
    typeof value["createdAt"] !== "string" ||
    !value["createdAt"]
  ) {
    throw new RuntimeEventStoreIntegrityError(`Runtime session header is invalid in ${path}`);
  }
  return {
    type: "session",
    schemaVersion: RUNTIME_SESSION_FILE_VERSION,
    sessionId: value["sessionId"],
    workDir: value["workDir"],
    historySource: "runtime-event-v2",
    createdAt: value["createdAt"],
  };
}

function readSessionHeaderSync(path: string): RuntimeSessionFileHeader {
  return decodeSessionHeader(readFirstJsonLineSync(path), path);
}

function decodeEventBatch(value: unknown, path: string, line: number): RuntimeEventBatch {
  if (
    !isRecord(value) ||
    value["type"] !== "event-batch" ||
    value["schemaVersion"] !== RUNTIME_SESSION_FILE_VERSION ||
    typeof value["txId"] !== "string" ||
    !value["txId"] ||
    typeof value["committedAt"] !== "string" ||
    !value["committedAt"] ||
    !Array.isArray(value["entries"]) ||
    value["entries"].length === 0
  ) {
    throw new RuntimeEventStoreIntegrityError(`Runtime event batch at ${path}:${line} is invalid`);
  }
  const entries = value["entries"].map((entry, index): RuntimeEventBatchEntry => {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry["sequence"]) ||
      (entry["sequence"] as number) < 1 ||
      typeof entry["committedAt"] !== "string" ||
      !entry["committedAt"]
    ) {
      throw new RuntimeEventStoreIntegrityError(
        `Runtime event batch entry ${index + 1} at ${path}:${line} is invalid`,
      );
    }
    let event: RuntimeEvent;
    try {
      event = decodeRuntimeEvent(entry["event"]);
    } catch (error) {
      throw new RuntimeEventStoreIntegrityError(
        `Runtime event batch entry ${index + 1} at ${path}:${line} is invalid`,
        { cause: error },
      );
    }
    if (entry["committedAt"] !== event.at) {
      throw new RuntimeEventStoreIntegrityError(
        `Runtime event ${event.eventId} committedAt does not match its payload`,
      );
    }
    return {
      sequence: entry["sequence"] as number,
      committedAt: entry["committedAt"],
      event,
    };
  });
  return {
    type: "event-batch",
    schemaVersion: RUNTIME_SESSION_FILE_VERSION,
    txId: value["txId"],
    committedAt: value["committedAt"],
    entries,
  };
}

export function decodeRuntimeSessionManifestProjection(
  value: unknown,
  path: string,
): RuntimeSessionManifestProjection {
  if (
    !isRecord(value) ||
    value["type"] !== "session-manifest" ||
    value["schemaVersion"] !== RUNTIME_SESSION_MANIFEST_VERSION ||
    !isRecord(value["manifest"]) ||
    !isRecord(value["ledger"])
  ) {
    throw new RuntimeEventStoreIntegrityError(`Runtime session manifest is invalid in ${path}`);
  }
  const manifestValue = value["manifest"];
  const ledgerValue = value["ledger"];
  const manifest = decodeManifestValue(manifestValue, path);
  const lastSequence = ledgerValue["lastSequence"];
  const lastTxId = ledgerValue["lastTxId"];
  if (
    !Number.isSafeInteger(ledgerValue["byteLength"]) ||
    (ledgerValue["byteLength"] as number) <= 0 ||
    !Number.isSafeInteger(lastSequence) ||
    (lastSequence as number) < 0 ||
    (lastSequence === 0 ? lastTxId !== undefined : typeof lastTxId !== "string" || !lastTxId)
  ) {
    throw new RuntimeEventStoreIntegrityError(
      `Runtime session manifest ledger is invalid in ${path}`,
    );
  }
  return {
    type: "session-manifest",
    schemaVersion: RUNTIME_SESSION_MANIFEST_VERSION,
    manifest,
    ledger: {
      byteLength: ledgerValue["byteLength"] as number,
      lastSequence: lastSequence as number,
      ...(typeof lastTxId === "string" ? { lastTxId } : {}),
    },
  };
}

function decodeManifestValue(value: Record<string, unknown>, path: string): RuntimeSessionManifest {
  if (
    value["schemaVersion"] !== RUNTIME_SESSION_MANIFEST_VERSION ||
    typeof value["sessionId"] !== "string" ||
    typeof value["workDir"] !== "string" ||
    value["historySource"] !== "runtime-event-v2" ||
    typeof value["createdAt"] !== "string"
  ) {
    throw new RuntimeEventStoreIntegrityError(`Runtime session manifest is invalid in ${path}`);
  }
  return {
    schemaVersion: RUNTIME_SESSION_MANIFEST_VERSION,
    sessionId: value["sessionId"],
    workDir: value["workDir"],
    historySource: "runtime-event-v2",
    createdAt: value["createdAt"],
  };
}

function createManifestProjection(
  manifest: RuntimeSessionManifest,
  byteLength: number,
  lastSequence: number,
  lastTxId?: string,
): RuntimeSessionManifestProjection {
  return {
    type: "session-manifest",
    schemaVersion: RUNTIME_SESSION_MANIFEST_VERSION,
    manifest,
    ledger: {
      byteLength,
      lastSequence,
      ...(lastTxId ? { lastTxId } : {}),
    },
  };
}

function manifestFromHeader(
  header: RuntimeSessionFileHeader,
): RuntimeSessionManifest {
  return {
    schemaVersion: RUNTIME_SESSION_MANIFEST_VERSION,
    sessionId: header.sessionId,
    workDir: header.workDir,
    historySource: "runtime-event-v2",
    createdAt: header.createdAt,
  };
}

function cursorForEntries(
  sessionId: string,
  _entries: readonly RuntimeEventStoreEntry[],
  sequence: number,
  eventId: string,
): SessionCursor {
  // epoch 恒为 0：rewind/branch 机制移除后无生产者。该字段是持久化 cursor
  // schema 的一部分（fork bundle / operation journal / session cursor 均含
  // epoch 并参与 conversationId 派生），保留字段以保证旧数据解码与结构稳定。
  void _entries;
  return {
    logId: sessionId,
    seq: sequence,
    epoch: 0,
    eventId,
  };
}

function sessionDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function catalogRowFromSession(
  manifest: RuntimeSessionManifest,
  entries: readonly RuntimeEventStoreEntry[],
  ledgerByteLength: number,
): SessionCatalogRow {
  let fold = createInitialSessionSummaryFold();
  for (const { event } of entries) {
    fold = foldSessionSummaryEvent(fold, event);
  }
  return {
    summary: finalizeSessionSummary(manifest, fold).summary,
    ledgerByteLength,
    fold,
  };
}

/** decode/rebuild 构造的都是真 Map；此转换只发生在单线程的写路径内部。 */
function mutableCatalogRows(
  rows: ReadonlyMap<string, SessionCatalogRow>,
): Map<string, SessionCatalogRow> {
  return rows as Map<string, SessionCatalogRow>;
}

function compareManifestsDescending(
  left: RuntimeSessionManifest,
  right: RuntimeSessionManifest,
): number {
  return (
    right.createdAt.localeCompare(left.createdAt) || right.sessionId.localeCompare(left.sessionId)
  );
}

/**
 * Returns a positive value when a descending manifest is strictly after the cursor,
 * zero for equality, and a negative value when it is before it.
 */
function compareManifestToCursor(
  manifest: RuntimeSessionManifest,
  cursor: RuntimeSessionManifestCursor,
): number {
  return (
    cursor.createdAt.localeCompare(manifest.createdAt) ||
    cursor.sessionId.localeCompare(manifest.sessionId)
  );
}

function normalizePageOffset(value = 0, field = "offset"): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Runtime event store ${field} must be a non-negative safe integer`);
  }
  return value;
}

function normalizePageLimit(value = RUNTIME_EVENT_STORE_MAX_PAGE_SIZE): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > RUNTIME_EVENT_STORE_MAX_PAGE_SIZE) {
    throw new Error(
      `Runtime event store page limit must be between 1 and ${RUNTIME_EVENT_STORE_MAX_PAGE_SIZE}`,
    );
  }
  return value;
}

function normalizeManifestCursor(
  value: RuntimeSessionManifestCursor,
  field: string,
): RuntimeSessionManifestCursor {
  if (
    !value ||
    typeof value.createdAt !== "string" ||
    !value.createdAt.trim() ||
    typeof value.sessionId !== "string" ||
    !value.sessionId.trim()
  ) {
    throw new Error(`Runtime event store ${field} manifest cursor is invalid`);
  }
  return { createdAt: value.createdAt, sessionId: value.sessionId };
}

function canonicalizeRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(event);
  } catch (error) {
    throw new RuntimeEventStoreIntegrityError(
      `Runtime event ${event.eventId} must be JSON-serializable: ${String(error)}`,
    );
  }
  if (encoded === undefined) {
    throw new RuntimeEventStoreIntegrityError(
      `Runtime event ${event.eventId} encoded to undefined`,
    );
  }
  try {
    const canonical = decodeRuntimeEvent(JSON.parse(encoded) as unknown);
    if (isLegacyDecodeOnlyKind(canonical.kind)) {
      throw new RuntimeEventStoreIntegrityError(
        `Runtime event kind ${canonical.kind} is legacy-only and cannot be appended`,
      );
    }
    return canonical;
  } catch (error) {
    if (error instanceof RuntimeEventStoreIntegrityError) throw error;
    throw new RuntimeEventStoreIntegrityError(`Runtime event ${event.eventId} is invalid`, {
      cause: error,
    });
  }
}

function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function encodeJsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
