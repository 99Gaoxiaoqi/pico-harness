import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
  type RuntimeEvent,
} from "./runtime-event.js";
import {
  FileStorageIntegrityError,
  commitFileTransactionSync,
  readFirstJsonLineSync,
  readLastJsonLineSync,
  readJsonFileSync,
  readJsonLinesSync,
  recoverFileTransactionSync,
  syncDirectorySync,
  withFileLockSync,
  writeJsonAtomicSync,
} from "./local-file-storage.js";
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
  readonly activeBranchId: string;
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
}

export interface RuntimeEventStoreEntry {
  readonly sequence: number;
  readonly event: RuntimeEvent;
}

export interface RuntimeSessionProjectionSnapshot {
  readonly manifest: RuntimeSessionManifest;
  readonly activeBranchId: string;
  readonly entries: readonly RuntimeEventStoreEntry[];
  readonly cursor?: SessionCursor;
}

export interface RuntimeSessionProjectionDelta {
  readonly activeBranchId: string;
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
  readonly activeBranchId: string;
  readonly entries: readonly RuntimeEventBatchEntry[];
}

interface LoadedRuntimeSession {
  readonly header: RuntimeSessionFileHeader;
  readonly manifest: RuntimeSessionManifest;
  readonly entries: readonly RuntimeEventStoreEntry[];
}

interface MutableRuntimeSession {
  readonly loaded: LoadedRuntimeSession;
  readonly entries: RuntimeEventStoreEntry[];
  readonly eventById: Map<string, RuntimeEventStoreEntry>;
  readonly appended: RuntimeEventBatchEntry[];
  activeBranchId: string;
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
      const manifest = manifestFromHeader(header, "main");
      const headerLine = encodeJsonLine(header);
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
      const sessions = new Map<string, MutableRuntimeSession>();
      for (const event of canonicalEvents) {
        if (sessions.has(event.sessionId)) continue;
        const loaded = this.requireSession(event.sessionId);
        sessions.set(event.sessionId, {
          loaded,
          entries: [...loaded.entries],
          eventById: new Map(loaded.entries.map((entry) => [entry.event.eventId, entry])),
          appended: [],
          activeBranchId: loaded.manifest.activeBranchId,
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
      let hasNewEvent = false;
      const requestedEventBySession = new Map<string, Map<string, RuntimeEvent>>();
      for (const event of canonicalEvents) {
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
          canonicalizeWorkspacePath(event.data.workDir) !== session.loaded.manifest.workDir
        ) {
          throw new RuntimeEventStoreIntegrityError(
            `Runtime event workspace does not match session ${event.sessionId}`,
          );
        }
        const existing = session.eventById.get(event.eventId);
        if (!existing) {
          hasNewEvent = true;
          continue;
        }
        if (!isDeepStrictEqual(existing.event, event)) {
          throw new RuntimeEventStoreIntegrityError(
            `Runtime event ID ${event.eventId} is already bound to another payload`,
          );
        }
      }
      if (!hasNewEvent) {
        return canonicalEvents.map((event) => {
          const session = sessions.get(event.sessionId)!;
          return this.appendResult(session.entries, session.eventById.get(event.eventId)!, false);
        });
      }
      for (const [sessionId, expectedHighWater] of Object.entries(
        options.expectedSessionHighWater ?? {},
      )) {
        const session = sessions.get(sessionId)!;
        if (session.entries.length !== expectedHighWater) {
          throw new RuntimeEventStoreHighWaterConflictError(
            sessionId,
            expectedHighWater,
            session.entries.length,
          );
        }
      }

      const results: RuntimeEventStoreAppendResult[] = [];
      for (const event of canonicalEvents) {
        const session = sessions.get(event.sessionId)!;
        const existing = session.eventById.get(event.eventId);
        if (existing) {
          if (!isDeepStrictEqual(existing.event, event)) {
            throw new RuntimeEventStoreIntegrityError(
              `Runtime event ID ${event.eventId} is already bound to another payload`,
            );
          }
          results.push(this.appendResult(session.entries, existing, false));
          continue;
        }

        const entry: RuntimeEventStoreEntry = {
          sequence: session.entries.length + 1,
          event,
        };
        session.entries.push(entry);
        session.eventById.set(event.eventId, entry);
        session.appended.push({
          sequence: entry.sequence,
          committedAt: event.at,
          event,
        });
        if (event.kind === "history.rewound") session.activeBranchId = event.data.branchId;
        results.push(this.appendResult(session.entries, entry, true));
      }

      const transactionId = randomUUID();
      const transactionCommittedAt = new Date().toISOString();
      const appendedSessions = [...sessions.entries()].filter(
        ([, session]) => session.appended.length > 0,
      );
      const batchLines = new Map<string, string>();
      const appends = appendedSessions.map(([sessionId, session]) => {
        const batch: RuntimeEventBatch = {
          type: "event-batch",
          schemaVersion: RUNTIME_SESSION_FILE_VERSION,
          txId: transactionId,
          committedAt: transactionCommittedAt,
          activeBranchId: session.activeBranchId,
          entries: session.appended,
        };
        const content = encodeJsonLine(batch);
        batchLines.set(sessionId, content);
        return {
          relativePath: this.sessionRelativePath(sessionId, SESSION_FILE_NAME),
          content,
        };
      });
      const replacements = appendedSessions.map(([sessionId, session]) => {
        this.assertSessionDigestBoundary(sessionDigest(sessionId));
        const manifest = {
          ...session.loaded.manifest,
          activeBranchId: session.activeBranchId,
        };
        const ledgerByteLength =
          statSync(this.sessionFilePath(sessionId)).size +
          Buffer.byteLength(batchLines.get(sessionId)!);
        return {
          relativePath: this.sessionRelativePath(sessionId, MANIFEST_FILE_NAME),
          content: encodeJsonDocument(
            createManifestProjection(
              manifest,
              ledgerByteLength,
              session.entries.length,
              transactionId,
            ),
          ),
        };
      });

      if (appends.length > 0) {
        commitFileTransactionSync(
          this.storageRoot,
          { appends, replacements },
          {
            ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
            transactionId,
          },
        );
      }
      return results;
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
    expectedBranchId: string,
  ): Promise<RuntimeSessionProjectionDelta | undefined> {
    if (
      after.logId !== sessionId ||
      through.logId !== sessionId ||
      through.seq <= after.seq ||
      !expectedBranchId
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
        headEntry.event.eventId !== through.eventId ||
        activeBranchAt(loaded.entries, after.seq) !== expectedBranchId
      ) {
        return undefined;
      }

      const entries = loaded.entries.filter(
        (entry) => entry.sequence > after.seq && entry.sequence <= through.seq,
      );
      if (entries.at(-1)?.event.eventId !== through.eventId) return undefined;
      let epoch = after.epoch;
      let activeBranchId = expectedBranchId;
      for (const entry of entries) {
        if (entry.event.kind !== "history.rewound") continue;
        epoch++;
        activeBranchId = entry.event.data.branchId;
      }
      if (epoch !== through.epoch || activeBranchId !== loaded.manifest.activeBranchId) {
        return undefined;
      }
      return { activeBranchId, entries, cursor: { ...through } };
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
    try {
      if (this.rootIdentity) {
        assertWorkspaceStorageRootIdentitySync(this.storageRoot, this.rootIdentity);
      }
      this.assertSessionsBoundary();
      if (this.readOnly) return operation();
      return withFileLockSync(this.lockDirectory, this.ownerId, () => {
        if (this.rootIdentity) {
          assertWorkspaceStorageRootIdentitySync(this.storageRoot, this.rootIdentity);
        }
        this.assertSessionsBoundary();
        recoverFileTransactionSync(this.storageRoot, WORKSPACE_RUNTIME_TRANSACTION_OPTIONS);
        this.assertSessionsBoundary();
        return operation();
      });
    } catch (error) {
      if (error instanceof RuntimeEventStoreIntegrityError) throw error;
      if (error instanceof FileStorageIntegrityError || error instanceof SyntaxError) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime event storage is invalid: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private appendResult(
    entries: readonly RuntimeEventStoreEntry[],
    entry: RuntimeEventStoreEntry,
    inserted: boolean,
  ): RuntimeEventStoreAppendResult {
    return {
      inserted,
      cursor: cursorForEntries(entry.event.sessionId, entries, entry.sequence, entry.event.eventId),
      committedAt: entry.event.at,
    };
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
    let activeBranchId = "main";
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
        if (batchEntry.event.kind === "history.rewound") {
          activeBranchId = batchEntry.event.data.branchId;
        }
      }
      if (activeBranchId !== batch.activeBranchId) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime event batch ${batch.txId} active branch does not match its entries`,
        );
      }
    }

    const derivedManifest = manifestFromHeader(header, activeBranchId);
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
          manifestFromHeader(header, projection.manifest.activeBranchId),
          projection.manifest,
        )
      ) {
        return undefined;
      }
      const lastRecord = readLastJsonLineSync(logPath);
      if (projection.ledger.lastSequence === 0) {
        if (
          !isDeepStrictEqual(lastRecord, readFirstJsonLineSync(logPath)) ||
          projection.ledger.lastTxId !== undefined ||
          projection.manifest.activeBranchId !== "main"
        ) {
          return undefined;
        }
      } else {
        const lastBatch = decodeEventBatch(lastRecord, logPath, -1);
        if (
          lastBatch.txId !== projection.ledger.lastTxId ||
          lastBatch.entries.at(-1)?.sequence !== projection.ledger.lastSequence ||
          lastBatch.activeBranchId !== projection.manifest.activeBranchId
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
      activeBranchId: loaded.manifest.activeBranchId,
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
    typeof value["activeBranchId"] !== "string" ||
    !value["activeBranchId"] ||
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
    activeBranchId: value["activeBranchId"],
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
    typeof value["createdAt"] !== "string" ||
    typeof value["activeBranchId"] !== "string" ||
    !value["activeBranchId"]
  ) {
    throw new RuntimeEventStoreIntegrityError(`Runtime session manifest is invalid in ${path}`);
  }
  return {
    schemaVersion: RUNTIME_SESSION_MANIFEST_VERSION,
    sessionId: value["sessionId"],
    workDir: value["workDir"],
    historySource: "runtime-event-v2",
    createdAt: value["createdAt"],
    activeBranchId: value["activeBranchId"],
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
  activeBranchId: string,
): RuntimeSessionManifest {
  return {
    schemaVersion: RUNTIME_SESSION_MANIFEST_VERSION,
    sessionId: header.sessionId,
    workDir: header.workDir,
    historySource: "runtime-event-v2",
    createdAt: header.createdAt,
    activeBranchId,
  };
}

function cursorForEntries(
  sessionId: string,
  entries: readonly RuntimeEventStoreEntry[],
  sequence: number,
  eventId: string,
): SessionCursor {
  return {
    logId: sessionId,
    seq: sequence,
    epoch: entries.filter(
      (entry) => entry.sequence <= sequence && entry.event.kind === "history.rewound",
    ).length,
    eventId,
  };
}

function activeBranchAt(entries: readonly RuntimeEventStoreEntry[], sequence: number): string {
  let activeBranchId = "main";
  for (const entry of entries) {
    if (entry.sequence > sequence) break;
    if (entry.event.kind === "history.rewound") {
      activeBranchId = entry.event.data.branchId;
    }
  }
  return activeBranchId;
}

function sessionDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
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
    return decodeRuntimeEvent(JSON.parse(encoded) as unknown);
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
