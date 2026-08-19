import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isAbortError } from "../provider/errors.js";
import { LeaseConflictError } from "../storage/owner-lease.js";
import { RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX } from "../engine/session-summary.js";
import { canonicalizeWorkspacePath } from "../paths/pico-paths.js";
import type { CommitReceipt } from "../engine/session-persistence.js";
import type { Session } from "../engine/session.js";
import { SessionForkRuntimeConflictError } from "../engine/session-fork-runtime-port.js";
import {
  assertIssuedEngineRuntimeCapability,
  type EngineRuntimeCapability,
  type EngineRuntimeToolResultInput,
  type EngineRuntimeWriteGuard,
  type LastCompactionCheckpoint,
} from "../engine/runtime-port.js";
import {
  COMPACTION_SUMMARY_OPEN_TAG,
  COMPACTION_SUMMARY_CLOSE_TAG,
} from "../context/compaction-markers.js";
import {
  projectRuntimeModelMessage,
  projectRuntimeToolResultMessage,
  runtimeEventHasModelHistoryEntry,
  type RuntimeModelHistoryEvent,
} from "../engine/runtime-model-message.js";
import {
  createCanonicalTranscriptToolStart,
  createRuntimeTranscriptToolStartEvent,
  type CanonicalTranscriptToolStart,
} from "../engine/transcript-tool-start.js";
import {
  normalizeSessionRuntimeStatePatch,
  type SessionRuntimeStateWritePatch,
} from "../engine/session-runtime.js";
import {
  assertDurableTranscriptEvent,
  projectTranscriptEvents,
  type DurableTranscriptEvent,
} from "../presentation/transcript-event-store.js";
import type { Message, ToolCall } from "../schema/message.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  assertRuntimeEvent,
  type RuntimeApprovalRequestedEvent,
  type RuntimeApprovalSettledEvent,
  type RuntimeCheckpointRecordedEvent,
  type RuntimeEvent,
  type RuntimeEventBase,
  type RuntimeEventRefs,
  type RuntimeMessageCommittedEvent,
  type RuntimeModelCallSettledEvent,
  type RuntimeRunStartedEvent,
  type RuntimeRunContinuationOf,
  type RuntimeRunTerminalEvent,
  type RuntimeSessionForkedEvent,
  type RuntimeTerminalStatus,
  type RuntimeToolRecoveryClassification,
  type RuntimeToolStartedEvent,
  type RuntimeToolResultRecordedEvent,
  type RuntimeTranscriptEventRecordedEvent,
} from "../storage/runtime-event.js";
import {
  RUNTIME_HISTORY_EVENT_KINDS,
  RUNTIME_MODEL_MESSAGE_EVENT_KINDS,
  type RuntimeHistoryProjectionEntry,
} from "../engine/session-runtime-read-model.js";
import {
  RuntimeEventStoreIntegrityError,
  createRuntimeEventId,
  type RuntimeEventStoreAppendResult,
  type RuntimeEventStoreEntry,
} from "../storage/runtime-event-store-contracts.js";
import {
  projectRuntimeSessionMessageEntries,
  projectRuntimeSessionMessages,
  projectRuntimeSessionModelToolResultEntries,
  projectRuntimeSessionState,
  projectRuntimeSessionTranscriptEventEntries,
  type RuntimeSessionForkSeedEntry,
} from "../engine/session-runtime-projection.js";
import {
  appendRuntimeEventBatchWithArbitration,
  appendRuntimeEventWithArbitration,
  SqliteRuntimeEventStore,
} from "../storage/sqlite/sqlite-runtime-event-store.js";

interface RuntimeRunContext {
  readonly run: RuntimeRun;
  active: boolean;
}

const runtimeRunContext = new AsyncLocalStorage<RuntimeRunContext>();
const runtimeToolCallContext = new AsyncLocalStorage<string>();
const liveRuntimeRuns = new Set<string>();
const externalMessageCommitTails = new Map<string, Promise<void>>();
const forkBootstrapTails = new Map<string, Promise<void>>();


interface RuntimeRunBaseOptions {
  readonly sessionId: string;
  readonly workDir: string;
  readonly runId?: string;
  readonly invocationId?: string;
  readonly runStartedEventId?: string;
  readonly terminalEventId?: string;
  readonly parentRunId?: string;
  readonly parentToolCallId?: string;
  readonly now?: () => Date;
  /**
   * ADR 29 续跑声明(可选):调用方在 claimContinuation 成功后传入,写入
   * run.started 的 data.continuationOf。前缀事件同 session 事件流天然可见,
   * 模型上下文无需特判;跨 session 续跑不在 ADR 29 范围。
   */
  readonly continuationOf?: RuntimeRunContinuationOf;
}

export interface RuntimeRunStartOptions extends Omit<
  RuntimeRunBaseOptions,
  "sessionId" | "workDir"
> {
  /** Inseparable live Session scope; identity, workspace, store, and lease cannot be mixed. */
  readonly capability: EngineRuntimeCapability;
}

type DetachedRuntimeRunStartOptions = RuntimeRunBaseOptions & {
  readonly store: SqliteRuntimeEventStore;
  readonly writeGuard: RuntimeEventWriteGuard;
};

type RuntimeRunConstructionOptions = RuntimeRunBaseOptions & {
  readonly store: SqliteRuntimeEventStore;
  readonly writeGuard: RuntimeEventWriteGuard;
  readonly runtimeCapability?: EngineRuntimeCapability;
};

/** Narrow capability that proves a live Session may still append canonical RuntimeEvents. */
export interface RuntimeEventWriteGuard {
  assertRuntimeEventWriteAllowed(): Promise<void>;
}

export interface ReconcileRuntimeRunsOptions {
  readonly now?: () => Date;
  readonly capability: EngineRuntimeCapability;
  /** A durably pre-admitted run that a cold worker is about to attach and execute. */
  readonly prestartedRunId?: string;
}

export interface RepairRuntimeSessionProjectionOptions {
  readonly capability: EngineRuntimeCapability;
}

export interface RuntimeForkBootstrapSeed {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  /** Durable fork operation identity used to make a crash retry reuse the same Runtime facts. */
  readonly operationId?: string;
  /** Durable operation timestamp; required for byte-identical cross-process retries. */
  readonly operationCreatedAt?: string;
  /** Frozen source-sequenced model and durable transcript facts. */
  readonly seedEntries: readonly RuntimeSessionForkSeedEntry[];
  /** Effective model prefix replacement frozen at the same source cursor as seedEntries. */
  readonly modelCheckpoint?: RuntimeForkModelCheckpointSeed;
  /** Last source message included in the frozen seed, before target-side rewrites. */
  readonly sourceThroughEventId?: string;
  readonly statePublication?: RuntimeForkStatePublication;
  readonly workDir: string;
  readonly store: SqliteRuntimeEventStore;
}

export interface RuntimeForkStatePublication {
  readonly patch: SessionRuntimeStateWritePatch;
  readonly eventId: string;
  readonly at: string;
}

export interface BootstrapRuntimeForkOptions extends RuntimeForkBootstrapSeed {
  readonly writeGuard: RuntimeEventWriteGuard;
}

export interface RuntimeForkModelCheckpointSeed {
  readonly coveredMessageCount: number;
  readonly summary: Message;
}

export interface RuntimeModelCallStartedOptions {
  readonly providerCallId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly purpose: string;
}

export interface RuntimeModelCallSettledOptions {
  readonly providerCallId: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly latencyMs: number;
  readonly usage?: RuntimeModelCallSettledEvent["data"]["usage"];
  readonly costCNY?: number;
  readonly costStatus?: RuntimeModelCallSettledEvent["data"]["costStatus"];
  readonly error?: string;
}

export interface RuntimeCheckpointOptions {
  readonly eventId?: string;
  readonly checkpointId: string;
  readonly coveredEventCount: number;
  readonly sourceDigest: string;
  readonly throughEventId: string;
  readonly summary: Message;
  /** 滚动摘要链:上一个 checkpoint 的 id(若存在)。 */
  readonly previousCheckpointId?: string;
}

interface RuntimeForkBootstrapCompletion {
  readonly sourceDigest: string;
  readonly messageCount: number;
}

interface RuntimeForkBootstrapIdentity {
  readonly runId: string;
  readonly invocationId: string;
  readonly runStartedEventId: string;
  readonly markerEventId: string;
  readonly terminalEventId: string;
  readonly checkpointEventId: string;
  readonly checkpointId: string;
  seedEventId(index: number): string;
}

interface PendingRuntimeToolCall {
  readonly source: RuntimeMessageCommittedEvent;
  readonly toolCall: ToolCall;
  readonly callIndex: number;
  resolved: boolean;
  /** 派发事实（ADR 27 P0）：run 账本内存在配对的 tool.started（先于 execute 落库）。 */
  dispatched: boolean;
}

interface PendingRegisteredToolResult {
  readonly event: RuntimeToolResultRecordedEvent;
  readonly message: Message;
}

interface PendingMessageCommitBatch {
  readonly messages: readonly Message[];
  readonly events: readonly RuntimeEvent[];
  readonly consumedByToolCallId: ReadonlyMap<string, number>;
}

/** The canonical run bound to the current asynchronous Agent execution. */
export function currentRuntimeRun(): RuntimeRun | undefined {
  const context = runtimeRunContext.getStore();
  return context?.active ? context.run : undefined;
}

/** Process-local guard used only to avoid reconciling a Run that is demonstrably executing now. */
export function isRuntimeRunLive(sessionId: string, runId: string): boolean {
  return liveRuntimeRuns.has(runtimeRunLiveKey(sessionId, runId));
}

/** The tool that caused the current nested Agent work, including a delegated child run. */
export function currentRuntimeToolCallId(): string | undefined {
  return runtimeToolCallContext.getStore();
}

/** Pure identity helper used by fork recovery before it trusts target Runtime facts. */
export function deriveRuntimeForkBootstrapRunId(options: RuntimeForkBootstrapSeed): string {
  const seedEntries = normalizeForkSeedEntries(options.seedEntries, options.sourceSessionId);
  const modelEntryCount = countForkModelSeedEntries(seedEntries);
  const canonicalWorkDir = canonicalizeWorkspacePath(options.workDir);
  const operationCreatedAt = normalizeForkOperationCreatedAt(options.operationCreatedAt);
  const sourceThroughEventId = normalizeForkSourceThroughEventId(
    seedEntries,
    options.sourceThroughEventId,
  );
  const statePublication = normalizeForkStatePublication(options.statePublication);
  const completion: RuntimeForkBootstrapCompletion = {
    sourceDigest: forkSeedDigest(seedEntries),
    messageCount: modelEntryCount,
  };
  const checkpoint = normalizeForkModelCheckpoint(options.modelCheckpoint, modelEntryCount);
  return runtimeForkBootstrapIdentity(
    options,
    completion,
    checkpoint,
    sourceThroughEventId,
    statePublication,
    canonicalWorkDir,
    operationCreatedAt,
  ).runId;
}

export function runWithRuntimeToolCall<Result>(toolCallId: string, run: () => Result): Result {
  return runtimeToolCallContext.run(toolCallId, run);
}

/**
 * Coordinates one Agent invocation. Runtime events are authoritative; Session memory
 * and search indexes remain replaceable projections for UI and tooling.
 */
export class RuntimeRun {
  readonly runId: string;
  readonly invocationId: string;
  readonly store: SqliteRuntimeEventStore;
  readonly runtimeCapability?: EngineRuntimeCapability;
  private readonly canonicalWorkDir: string;
  private readonly now: () => Date;
  private readonly runStartedEventId?: string;
  private readonly terminalEventId?: string;
  private readonly continuationOf?: RuntimeRunContinuationOf;
  private readonly writeGuard: RuntimeEventWriteGuard;
  private readonly parentRefs?: Pick<RuntimeEventRefs, "parentRunId" | "parentToolCallId">;
  private readonly pendingToolResults = new Map<string, PendingRegisteredToolResult[]>();
  private pendingMessageCommitBatch?: PendingMessageCommitBatch;
  private turnId: string;
  private stepId: string;
  private terminal?: RuntimeRunTerminalEvent;
  private finishPromise?: Promise<void>;

  private constructor(
    readonly sessionId: string,
    readonly workDir: string,
    options: RuntimeRunConstructionOptions,
  ) {
    this.runId = options.runId ?? randomUUID();
    this.invocationId = options.invocationId ?? `invocation:${randomUUID()}`;
    this.store = options.store;
    this.runtimeCapability = options.runtimeCapability;
    this.canonicalWorkDir = canonicalizeWorkspacePath(workDir);
    this.now = options.now ?? (() => new Date());
    this.runStartedEventId = options.runStartedEventId;
    this.terminalEventId = options.terminalEventId;
    this.continuationOf = options.continuationOf
      ? structuredClone(options.continuationOf)
      : undefined;
    this.writeGuard = options.writeGuard;
    this.parentRefs = compactRefs({
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
      ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
    });
    this.turnId = `turn:${this.runId}:input`;
    this.stepId = `step:${this.runId}:input`;
  }

  static async start(options: RuntimeRunStartOptions): Promise<RuntimeRun> {
    const { capability, ...metadata } = options;
    const store = runtimeEventStoreFromCapability(capability);
    return RuntimeRun.startInternal({
      ...metadata,
      sessionId: capability.sessionId,
      workDir: capability.workDir,
      store,
      writeGuard: capability.writeGuard,
      runtimeCapability: capability,
    });
  }

  /** Detached writes are confined to the durable fork publication path. */
  private static async startDetached(options: DetachedRuntimeRunStartOptions): Promise<RuntimeRun> {
    return RuntimeRun.startInternal(options);
  }

  private static async startInternal(options: RuntimeRunConstructionOptions): Promise<RuntimeRun> {
    const store = options.store;
    const run = new RuntimeRun(options.sessionId, options.workDir, { ...options, store });
    await run.writeCanonicalEvent(() =>
      store.initializeSession({
        sessionId: options.sessionId,
        workDir: options.workDir,
        ...(options.now ? { now: options.now } : {}),
      }),
    );
    await run.recordRunStarted();
    return run;
  }

  /** Completes old canonical runs that reached neither a terminal event nor a clean stop. */
  static async reconcileIncompleteRuns(options: ReconcileRuntimeRunsOptions): Promise<string[]> {
    const { capability } = options;
    const store = runtimeEventStoreFromCapability(capability);
    const { sessionId } = capability;
    const manifest = await store.readSessionManifest(sessionId);
    if (!manifest) return [];
    const activeMessageEventIds = new Set(
      projectRuntimeSessionMessageEntries(
        (
          await store.readSessionEntriesOfKinds(sessionId, RUNTIME_MODEL_MESSAGE_EVENT_KINDS)
        ).entries.map(({ event }) => event),
      ).map(({ eventId }) => eventId),
    );

    const reconciled: string[] = [];
    if (options.prestartedRunId) {
      const prestartedEvents = await store.readRun(sessionId, options.prestartedRunId);
      if (prestartedEvents.length !== 1 || prestartedEvents[0]?.kind !== "run.started") {
        throw new Error(
          `Prestarted Runtime run ${options.prestartedRunId} is not an unattached admission`,
        );
      }
    }
    for (const runId of await store.listRunIds(sessionId)) {
      if (runId === options.prestartedRunId) continue;
      if (isRuntimeRunLive(sessionId, runId)) continue;
      const events = await store.readRun(sessionId, runId);
      if (
        runId.startsWith(RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX) &&
        !isPublishedCompletedForkBootstrap(events)
      ) {
        continue;
      }
      const started = events.find((event) => event.kind === "run.started");
      if (!started) continue;
      const existingTerminal = events.find(
        (event): event is RuntimeRunTerminalEvent => event.kind === "run.terminal",
      );
      const last = events.at(-1) ?? started;
      const recoveryAt = existingTerminal?.at ?? last.at;
      const pendingToolCalls = findDanglingRuntimeToolCalls(events, activeMessageEventIds);
      const syntheticToolResults = pendingToolCalls.map((pending) =>
        buildInterruptedToolResultEvent(events, pending, recoveryAt),
      );
      const syntheticToolStarts = buildInterruptedTranscriptToolStartEvents({
        // kind 切片(票 04):该函数只消费 transcript.event.recorded 与
        // tool.result.recorded(工具起点配对 + 幂等 id 探测)。
        entries: (
          await store.readSessionEntriesOfKinds(sessionId, [
            "transcript.event.recorded",
            "tool.result.recorded",
          ])
        ).entries,
        pendingToolCalls,
        toolResults: syntheticToolResults,
        at: recoveryAt,
      });
      if (existingTerminal && syntheticToolResults.length === 0) continue;
      const recoveryEvents = existingTerminal
        ? buildInterruptedToolRecoveryRun({
            sourceStarted: started,
            sourceTerminal: existingTerminal,
            toolStarts: syntheticToolStarts,
            toolResults: syntheticToolResults,
            at: recoveryAt,
          })
        : undefined;
      const terminal: RuntimeRunTerminalEvent = {
        schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
        eventId: runtimeInterruptionRecoveryEventId("terminal", [sessionId, runId]),
        sessionId,
        invocationId: last.invocationId,
        runId,
        turnId: last.turnId,
        at: recoveryAt,
        partial: false,
        visibility: "internal",
        ...(last.refs ? { refs: last.refs } : {}),
        kind: "run.terminal",
        data: {
          status: "interrupted",
          reason: "recovered_without_terminal_fact",
          recovered: true,
        },
      };
      const results = await writeWithRuntimeEventGuard(
        capability.writeGuard,
        () =>
          store.appendBatch(
            recoveryEvents ?? [...syntheticToolStarts, ...syntheticToolResults, terminal],
          ),
        `Runtime reconciliation for session ${sessionId}`,
      );
      if (results.some((result) => result.inserted)) reconciled.push(runId);
    }
    return reconciled;
  }

  /** Repairs the in-memory Session projection from durable canonical facts. */
  static async repairSessionProjection(
    session: Session,
    options: RepairRuntimeSessionProjectionOptions,
  ): Promise<boolean> {
    return session.withSerializedExecution(async () => {
      const { capability } = options;
      const store = runtimeEventStoreFromCapability(capability);
      if (capability.writeGuard !== session) {
        throw new Error(`Runtime capability does not belong to Session ${session.id}`);
      }
      if (!(await store.readSessionManifest(session.id))) return false;
      const events = await store.readSession(session.id);
      const projected = projectRuntimeSessionMessages(events);
      const usage = projectRuntimeSessionState(events).usage;
      const messagesStale = !isDeepStrictEqual(session.getModelContext(), projected);
      const usageStale = !isDeepStrictEqual(session.getRuntimeStateSnapshot().usage, usage);
      if (!messagesStale && !usageStale) return false;

      const digest = createHash("sha256")
        .update(events.map((event) => event.eventId).join("\n"))
        .digest("hex");
      if (messagesStale) {
        await session.replaceRuntimeProjection(projected, `runtime-projection:${digest}`);
      }
      if (usageStale) {
        await session.replaceRuntimeUsage(usage, `runtime-usage:${digest}`);
      }
      return true;
    });
  }

  /**
   * Creates a fork from one source-sequenced model/transcript seed. The target owns
   * new immutable wrappers while durable transcript identities remain stable for UI hydration.
   */
  static async bootstrapFork(options: BootstrapRuntimeForkOptions): Promise<boolean> {
    if (options.sourceSessionId === options.targetSessionId) {
      throw new Error("Runtime fork source 与 target sessionId 不能相同");
    }
    const store = options.store;
    const seedEntries = normalizeForkSeedEntries(options.seedEntries, options.sourceSessionId);
    const modelEntryCount = countForkModelSeedEntries(seedEntries);
    const canonicalWorkDir = canonicalizeWorkspacePath(options.workDir);
    const operationCreatedAt = normalizeForkOperationCreatedAt(options.operationCreatedAt);
    const sourceThroughEventId = normalizeForkSourceThroughEventId(
      seedEntries,
      options.sourceThroughEventId,
    );
    const statePublication = normalizeForkStatePublication(options.statePublication);
    const modelCheckpoint = normalizeForkModelCheckpoint(options.modelCheckpoint, modelEntryCount);
    const completion: RuntimeForkBootstrapCompletion = {
      sourceDigest: forkSeedDigest(seedEntries),
      messageCount: modelEntryCount,
    };
    const identity = runtimeForkBootstrapIdentity(
      options,
      completion,
      modelCheckpoint,
      sourceThroughEventId,
      statePublication,
      canonicalWorkDir,
      operationCreatedAt,
    );
    const targetSessionKey = runtimeSessionKey(
      store.storageRoot,
      canonicalWorkDir,
      options.targetSessionId,
    );

    return serializeForkBootstrap(targetSessionKey, options.writeGuard, async (writeGuard) => {
      const existingEvents = await store.readSession(options.targetSessionId);
      const forkMarkers = existingEvents.filter(
        (event): event is RuntimeSessionForkedEvent => event.kind === "session.forked",
      );
      const conflictingMarker = forkMarkers.find(
        (event) => event.data.parentSessionId !== options.sourceSessionId,
      );
      if (conflictingMarker) {
        throw runtimeForkConflict(
          `Runtime fork target ${options.targetSessionId} is already bound to parent ${conflictingMarker.data.parentSessionId}`,
        );
      }
      const existingStart = assertForkBootstrapStart(
        existingEvents,
        identity,
        options.targetSessionId,
        canonicalWorkDir,
        operationCreatedAt,
      );
      const importedCount = assertForkSeedPrefix(
        existingEvents,
        seedEntries,
        options.targetSessionId,
        identity,
        existingStart?.at,
      );
      assertRuntimeForkState(existingEvents, statePublication, options.targetSessionId, false);
      const completedMarker = forkMarkers.find((event) => event.data.sourceDigest !== undefined);
      if (completedMarker) {
        if (
          completedMarker.data.sourceDigest !== completion.sourceDigest ||
          completedMarker.data.messageCount !== completion.messageCount ||
          completedMarker.data.throughEventId !== sourceThroughEventId
        ) {
          throw runtimeForkConflict(
            `Runtime fork target ${options.targetSessionId} has a conflicting frozen seed`,
          );
        }
        if (
          completedMarker.runId !== identity.runId ||
          completedMarker.eventId !== identity.markerEventId
        ) {
          throw runtimeForkConflict(
            `Runtime fork target ${options.targetSessionId} has a conflicting canonical seed`,
          );
        }
        if (!existingStart || importedCount !== seedEntries.length) {
          throw runtimeForkConflict(
            `Runtime fork target ${options.targetSessionId} published an incomplete canonical seed`,
          );
        }
        assertRuntimeForkCheckpoint(existingEvents, identity, modelCheckpoint, seedEntries);
        assertRuntimeForkState(existingEvents, statePublication, options.targetSessionId, true);
        assertRuntimeForkPublicationOrder(
          existingEvents,
          identity,
          seedEntries,
          modelCheckpoint,
          statePublication,
          completedMarker,
          options.targetSessionId,
        );
        await RuntimeRun.ensureForkTerminal(options, store, existingEvents, identity, writeGuard);
        return false;
      }

      const bootstrapAt = existingStart?.at ?? runtimeForkBootstrapAt(operationCreatedAt);
      const forkRun = await RuntimeRun.startDetached({
        sessionId: options.targetSessionId,
        workDir: canonicalWorkDir,
        runId: identity.runId,
        invocationId: identity.invocationId,
        runStartedEventId: identity.runStartedEventId,
        terminalEventId: identity.terminalEventId,
        now: () => new Date(bootstrapAt),
        store,
        writeGuard,
      });
      for (let index = importedCount; index < seedEntries.length; index += 1) {
        await forkRun.recordImportedSeedEntry(seedEntries[index]!, identity.seedEventId(index));
      }
      if (modelCheckpoint) {
        const coveredEventIds = forkModelSeedEventIds(seedEntries, identity).slice(
          0,
          modelCheckpoint.coveredMessageCount,
        );
        await forkRun.recordCheckpoint({
          eventId: identity.checkpointEventId,
          checkpointId: identity.checkpointId,
          coveredEventCount: modelCheckpoint.coveredMessageCount,
          sourceDigest: runtimeEventIdDigest(coveredEventIds),
          throughEventId: coveredEventIds.at(-1)!,
          summary: modelCheckpoint.summary,
        });
      }
      // State is part of the published fork payload. Persist it before the marker so every
      // consumer that observes session.forked also observes history, checkpoint, and state.
      await RuntimeRun.ensureForkState(
        options.targetSessionId,
        statePublication,
        store,
        writeGuard,
      );
      const publicationEvents = await store.readSession(options.targetSessionId);
      assertRuntimeForkCheckpoint(publicationEvents, identity, modelCheckpoint, seedEntries);
      assertRuntimeForkState(publicationEvents, statePublication, options.targetSessionId, true);
      assertRuntimeForkPublicationOrder(
        publicationEvents,
        identity,
        seedEntries,
        modelCheckpoint,
        statePublication,
        undefined,
        options.targetSessionId,
      );
      await forkRun.recordSessionForked(
        options.sourceSessionId,
        sourceThroughEventId,
        completion,
        identity.markerEventId,
      );
      await forkRun.finish("completed");
      return true;
    }).catch((error: unknown) => {
      if (
        error instanceof SessionForkRuntimeConflictError ||
        !(error instanceof RuntimeEventStoreIntegrityError)
      ) {
        throw error;
      }
      throw new SessionForkRuntimeConflictError(error.message, "target_conflict", {
        cause: error,
      });
    });
  }

  private static async ensureForkTerminal(
    options: BootstrapRuntimeForkOptions,
    store: SqliteRuntimeEventStore,
    events: readonly RuntimeEvent[],
    identity: RuntimeForkBootstrapIdentity,
    writeGuard: RuntimeEventWriteGuard,
  ): Promise<void> {
    const terminal = events.find(
      (event): event is RuntimeRunTerminalEvent =>
        event.kind === "run.terminal" && event.runId === identity.runId,
    );
    if (terminal) {
      if (terminal.eventId !== identity.terminalEventId || terminal.data.status !== "completed") {
        throw runtimeForkConflict(
          `Runtime fork run ${identity.runId} has a conflicting terminal fact`,
        );
      }
      return;
    }

    const started = events.find(
      (event): event is RuntimeRunStartedEvent =>
        event.kind === "run.started" && event.runId === identity.runId,
    );
    if (!started || started.eventId !== identity.runStartedEventId) {
      throw runtimeForkConflict(
        `Runtime fork run ${identity.runId} is missing its stable start fact`,
      );
    }
    const run = await RuntimeRun.startDetached({
      sessionId: options.targetSessionId,
      workDir: started.data.workDir,
      runId: identity.runId,
      invocationId: identity.invocationId,
      runStartedEventId: identity.runStartedEventId,
      terminalEventId: identity.terminalEventId,
      now: () => new Date(started.at),
      store,
      writeGuard,
    });
    await run.finish("completed");
  }

  private static async ensureForkState(
    targetSessionId: string,
    publication: RuntimeForkStatePublication | undefined,
    store: SqliteRuntimeEventStore,
    writeGuard: RuntimeEventWriteGuard,
  ): Promise<void> {
    if (!publication) return;
    const existing = await store.readSessionEvent(targetSessionId, publication.eventId);
    if (existing) {
      if (
        existing.event.kind !== "session.state.committed" ||
        existing.event.at !== publication.at ||
        !isDeepStrictEqual(existing.event.data.patch, publication.patch)
      ) {
        throw new SessionForkRuntimeConflictError(
          `Runtime fork state event ${publication.eventId} is already bound to another payload`,
          "target_conflict",
        );
      }
      return;
    }
    await writeWithRuntimeEventGuard(
      writeGuard,
      () =>
        store.appendSessionState(targetSessionId, publication.patch, {
          eventId: publication.eventId,
          now: () => new Date(publication.at),
        }),
      `Runtime fork state publication ${publication.eventId}`,
    );
  }

  /**
   * Bridges Session writes that originate while no foreground Agent run is active
   * (for example a delivered subagent completion or an async hook wake-up). RuntimeEvent
   * remains the write-ahead source; Session is updated only through the short-lived run.
   */
  static async commitExternalMessages(
    session: Session,
    messages: readonly Message[],
  ): Promise<boolean> {
    if (messages.length === 0) return true;
    const canonicalMessages = messages.map((message) => {
      const canonical = canonicalizeRuntimeMessage(message);
      assertRuntimeCommittedMessage(canonical);
      return canonical;
    });
    const capability = session.runtimeEventCapability;
    if (!capability) return false;
    const store = runtimeEventStoreFromCapability(capability);
    if (!(await store.readSessionManifest(session.id))) return false;
    const run = await RuntimeRun.start({ capability });
    await run.run(() => run.commitMessages(session, canonicalMessages));
    return true;
  }

  /**
   * Exactly-once variant for host-owned message IDs. A retry first reuses the canonical
   * message fact, repairing only its in-memory projection instead of appending a duplicate.
   */
  static async commitExternalMessageOnce(
    session: Session,
    eventId: string,
    message: Message,
  ): Promise<CommitReceipt | undefined> {
    const canonicalMessage = canonicalizeRuntimeMessage(message);
    assertRuntimeCommittedMessage(canonicalMessage);
    const capability = session.runtimeEventCapability;
    if (!capability) return undefined;
    const store = runtimeEventStoreFromCapability(capability);
    if (!(await store.readSessionManifest(session.id))) return undefined;
    const sessionKey = runtimeSessionKey(store.storageRoot, session.workDir, session.id);
    return serializeExternalMessageCommit(sessionKey, eventId, async () => {
      const existing = await store.readSessionEvent(session.id, eventId);
      if (existing) {
        if (
          existing.event.kind !== "message.committed" ||
          !isDeepStrictEqual(existing.event.data.message, canonicalMessage)
        ) {
          throw new Error(`Runtime event ID ${eventId} is already bound to another payload`);
        }
        const persisted = await writeWithRuntimeEventGuard(
          session,
          () => store.append(existing.event),
          `Runtime external message ${eventId}`,
        );
        await session.commitRuntimeProjectionBatch([persisted]);
        return runtimeCommitReceipt(persisted);
      }
      const run = await RuntimeRun.start({ capability });
      return run.run(() => run.commitMessageOnce(session, eventId, canonicalMessage));
    });
  }

  async readModelHistory(): Promise<Message[]> {
    const { materializeRuntimeHistory } = await import("../engine/session-runtime-read-model.js");
    // kind 切片查询(票 04):read-model 只消费 message/tool-result/checkpoint 三类,
    // 其余 kind 只产 soft 诊断,不进输出——折叠规则不变,数据来源窄化。
    const { entries } = await this.store.readSessionEntriesOfKinds(
      this.sessionId,
      RUNTIME_HISTORY_EVENT_KINDS,
    );
    return materializeRuntimeHistory(entries.map(({ event }) => event));
  }

  /** True only when this run owns the Session's canonical workspace and durable store. */
  claimsSession(session: Session): boolean {
    if (!this.runtimeCapability || this.runtimeCapability.writeGuard !== session) return false;
    try {
      assertIssuedEngineRuntimeCapability(this.runtimeCapability);
      return (
        this.runtimeCapability.sessionId === session.id &&
        this.runtimeCapability.runtimeAuthority === this.store &&
        canonicalizeWorkspacePath(session.workDir) === this.canonicalWorkDir
      );
    } catch {
      return false;
    }
  }

  /** Allows a nested live run to inherit the same narrow Session write capability. */
  get runtimeEventWriteGuard(): EngineRuntimeWriteGuard | undefined {
    return this.runtimeCapability?.writeGuard;
  }

  async readModelHistoryEntries(): Promise<RuntimeHistoryProjectionEntry[]> {
    const { materializeRuntimeHistoryEntries } =
      await import("../engine/session-runtime-read-model.js");
    const { entries } = await this.store.readSessionEntriesOfKinds(
      this.sessionId,
      RUNTIME_HISTORY_EVENT_KINDS,
    );
    return materializeRuntimeHistoryEntries(entries.map(({ event }) => event));
  }

  /** Raw model-message facts for Session/UI projection, intentionally without checkpoint replacement. */
  async readSessionProjectionEntries(): Promise<RuntimeHistoryProjectionEntry[]> {
    const { entries } = await this.store.readSessionEntriesOfKinds(
      this.sessionId,
      RUNTIME_MODEL_MESSAGE_EVENT_KINDS,
    );
    return projectRuntimeSessionMessageEntries(entries.map(({ event }) => event));
  }

  /**
   * 查找最后一个正常的压缩 checkpoint，用于滚动摘要增量更新。
   * 遇到 hard-reset checkpoint 时立即返回 undefined——硬重置物理上重置了上下文，
   * 其之前的 checkpoint 都已失效，不能再作为增量更新的基线。
   *
   * 票 04:末条 context.checkpoint.recorded 经 by_kind 索引点查,不再全量读——
   * 原反向扫描在遇到首个 checkpoint 事件时必然返回(值或 undefined),因此末条
   * 单点判定与全量口径等价。
   */
  async findLastCompactionCheckpoint(): Promise<LastCompactionCheckpoint | undefined> {
    const lastCheckpoint = await this.store.readLastSessionEntryOfKind(
      this.sessionId,
      "context.checkpoint.recorded",
    );
    if (!lastCheckpoint || lastCheckpoint.event.kind !== "context.checkpoint.recorded") {
      return undefined;
    }
    const data = lastCheckpoint.event.data;
    // 硬重置 checkpoint 之前的所有 checkpoint 都已失效，不再向前查找。
    if (data.checkpointId.startsWith("hard-reset:")) return undefined;
    const content = data.summary.content;
    // 用结构化标签精确定位正文边界。
    const startIdx = content.indexOf(COMPACTION_SUMMARY_OPEN_TAG);
    const endIdx = content.indexOf(COMPACTION_SUMMARY_CLOSE_TAG);
    // 标签缺失时返回 undefined，避免把 REFERENCE-ONLY 包装当 previousSummary 喂模型。
    if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) return undefined;
    const summaryText = content.slice(startIdx + COMPACTION_SUMMARY_OPEN_TAG.length, endIdx).trim();
    return { checkpointId: data.checkpointId, summaryText };
  }

  run<Result>(execute: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
    const context: RuntimeRunContext = { run: this, active: true };
    liveRuntimeRuns.add(runtimeRunLiveKey(this.sessionId, this.runId));
    return runtimeRunContext.run(context, async () => {
      try {
        const result = await execute();
        await this.finish("completed");
        return result;
      } catch (error) {
        const status: RuntimeTerminalStatus =
          signal?.aborted || isAbortError(error) ? "cancelled" : "failed";
        try {
          await this.finish(status, runtimeFailureReason(error));
        } catch (finishError) {
          throw new AggregateError(
            [error, finishError],
            "Agent run failed and its canonical terminal fact could not be persisted",
            { cause: finishError },
          );
        }
        throw error;
      } finally {
        context.active = false;
        liveRuntimeRuns.delete(runtimeRunLiveKey(this.sessionId, this.runId));
      }
    });
  }

  async recordTurnStarted(turn: number): Promise<void> {
    this.assertOpen();
    this.turnId = `turn:${this.runId}:${turn}`;
    this.stepId = `step:${this.runId}:${turn}`;
  }

  async commitMessages(session: Session, messages: readonly Message[]): Promise<void> {
    if (messages.length === 0) return;
    this.assertSession(session);
    this.assertOpen();
    const canonicalMessages = messages.map((message) => canonicalizeRuntimeMessage(message));
    let batch = this.pendingMessageCommitBatch;
    if (batch) {
      if (!isDeepStrictEqual(batch.messages, canonicalMessages)) {
        throw new Error(
          `Runtime run ${this.runId} must retry its pending message batch before committing different messages`,
        );
      }
    } else {
      const consumedByToolCallId = new Map<string, number>();
      const events = canonicalMessages.map((canonicalMessage) => {
        const toolCallId = canonicalMessage.toolCallId;
        if (toolCallId) {
          const consumed = consumedByToolCallId.get(toolCallId) ?? 0;
          const registered = this.pendingToolResults.get(toolCallId)?.[consumed];
          if (!registered) {
            throw new Error(
              `Runtime ToolResult ${toolCallId} must be registered as tool.result.recorded before commit`,
            );
          }
          if (!isDeepStrictEqual(canonicalMessage, registered.message)) {
            throw new Error(
              `Registered Runtime tool result ${toolCallId} must be committed with its canonical projection`,
            );
          }
          consumedByToolCallId.set(toolCallId, consumed + 1);
          return registered.event;
        }
        return this.messageCommittedEvent(createRuntimeEventId("message"), canonicalMessage);
      });
      batch = {
        messages: structuredClone(canonicalMessages),
        events,
        consumedByToolCallId,
      };
      this.pendingMessageCommitBatch = batch;
    }

    const persisted = await this.appendBatch(batch.events);
    await session.commitRuntimeProjectionBatch(persisted);
    for (const [toolCallId, consumed] of batch.consumedByToolCallId) {
      const queue = this.pendingToolResults.get(toolCallId);
      if (!queue) continue;
      queue.splice(0, consumed);
      if (queue.length === 0) this.pendingToolResults.delete(toolCallId);
    }
    this.pendingMessageCommitBatch = undefined;
  }

  async commitMessageOnce(
    session: Session,
    eventId: string,
    message: Message,
  ): Promise<CommitReceipt> {
    this.assertSession(session);
    this.assertOpen();
    const canonicalMessage = canonicalizeRuntimeMessage(message);
    assertRuntimeCommittedMessage(canonicalMessage);
    const existing = await this.store.readSessionEvent(session.id, eventId);
    if (existing) {
      if (
        existing.event.kind !== "message.committed" ||
        !isDeepStrictEqual(existing.event.data.message, canonicalMessage)
      ) {
        throw new Error(`Runtime event ID ${eventId} is already bound to another payload`);
      }
      const persisted = await this.append(existing.event);
      await session.commitRuntimeProjectionBatch([persisted]);
      return runtimeCommitReceipt(persisted);
    }
    const event = this.messageCommittedEvent(eventId, canonicalMessage);
    const persisted = await this.append(event);
    await session.commitRuntimeProjectionBatch([persisted]);
    return runtimeCommitReceipt(persisted);
  }

  /** Writes one immutable, usage-free message from a fork's frozen Session seed. */
  private async recordImportedMessage(
    source: Message,
    eventId = createRuntimeEventId("fork-message"),
  ): Promise<void> {
    this.assertOpen();
    const message = canonicalizeRuntimeMessage(stripMessageUsage(source));
    assertRuntimeCommittedMessage(message);
    const refs = this.refs();
    await this.append({
      ...this.base(eventId),
      ...(refs ? { refs } : {}),
      kind: "message.committed",
      data: { message },
    });
  }

  /** Imports one frozen v5 fact without degrading a ToolResult or rebuilding transcript data. */
  private async recordImportedSeedEntry(
    source: RuntimeSessionForkSeedEntry,
    eventId = createRuntimeEventId("fork-history"),
  ): Promise<void> {
    this.assertOpen();
    if (source.kind === "transcript") {
      await this.recordImportedTranscriptEvent(source.event, eventId);
      return;
    }
    if (source.event.kind === "message.committed") {
      await this.recordImportedMessage(source.event.data.message, eventId);
      return;
    }
    const event: RuntimeToolResultRecordedEvent = {
      ...this.base(eventId),
      refs: {
        ...(this.refs() ?? {}),
        toolCallId: source.event.refs.toolCallId,
        ...(source.event.refs.evidence
          ? { evidence: structuredClone(source.event.refs.evidence) }
          : {}),
      },
      kind: "tool.result.recorded",
      data: structuredClone(source.event.data),
    };
    assertRuntimeEvent(event);
    await this.append(event);
  }

  private async recordImportedTranscriptEvent(
    source: DurableTranscriptEvent,
    eventId: string,
  ): Promise<void> {
    this.assertOpen();
    assertDurableTranscriptEvent(source);
    const event: RuntimeTranscriptEventRecordedEvent = {
      ...this.base(eventId, false, "transcript"),
      kind: "transcript.event.recorded",
      data: { event: structuredClone(source) },
    };
    assertRuntimeEvent(event);
    await this.append(event);
  }

  /** Records an audit-only child-agent message without changing the parent model context. */
  async recordTranscriptMessage(message: Message): Promise<void> {
    this.assertOpen();
    const canonicalMessage = canonicalizeRuntimeMessage(message);
    assertRuntimeCommittedMessage(canonicalMessage);
    const refs = this.refs();
    await this.append({
      ...this.base(createRuntimeEventId("transcript-message"), true, "transcript"),
      ...(refs ? { refs } : {}),
      kind: "message.committed",
      data: { message: canonicalMessage },
    });
  }

  async recordToolStarted(
    toolCallId: string,
    toolName: string,
    argumentsJson: string,
  ): Promise<void> {
    this.assertOpen();
    const event: RuntimeToolStartedEvent = {
      ...this.base(createRuntimeEventId("tool-started"), true, "internal"),
      refs: this.refs({ toolCallId }),
      kind: "tool.started",
      data: {
        toolName,
        argumentsHash: createHash("sha256").update(argumentsJson).digest("hex"),
      },
    };
    await this.append(event);
  }

  async recordTranscriptToolStarts(
    session: Session,
    toolCalls: readonly ToolCall[],
  ): Promise<readonly CanonicalTranscriptToolStart[]> {
    if (toolCalls.length === 0) return [];
    this.assertSession(session);
    this.assertOpen();
    const refs = this.refs();
    return session.recordRuntimeTranscriptToolStarts({
      invocationId: this.invocationId,
      runId: this.runId,
      turnId: this.turnId,
      createdAt: this.now().getTime(),
      toolCalls,
      ...(refs ? { refs } : {}),
    });
  }

  /**
   * Persists one complete child-agent ToolResult batch in Provider order
   * without changing the parent Session model projection.
   */
  async recordTranscriptToolResults(
    inputs: readonly EngineRuntimeToolResultInput[],
  ): Promise<readonly Message[]> {
    this.assertOpen();
    if (inputs.length === 0) return [];
    const events = inputs.map((input): RuntimeToolResultRecordedEvent => {
      const canonical = canonicalizeRuntimeToolResultInput(input);
      const event: RuntimeToolResultRecordedEvent = {
        ...this.base(createRuntimeEventId("transcript-tool-result"), true, "transcript"),
        refs: {
          ...(this.refs() ?? {}),
          toolCallId: canonical.toolCallId,
          ...(canonical.evidence ? { evidence: canonical.evidence } : {}),
        },
        kind: "tool.result.recorded",
        data: {
          toolName: canonical.toolName,
          status: canonical.status,
          body: canonical.body,
          projection: canonical.projection,
        },
      };
      assertRuntimeEvent(event);
      return event;
    });
    const messages = events.map(projectRuntimeToolResultMessage);
    await this.appendBatch(events);
    return structuredClone(messages);
  }

  registerToolResult(input: EngineRuntimeToolResultInput): Message {
    this.assertOpen();
    const canonical = canonicalizeRuntimeToolResultInput(input);
    const event: RuntimeToolResultRecordedEvent = {
      ...this.base(createRuntimeEventId("tool-result")),
      refs: {
        ...(this.refs() ?? {}),
        toolCallId: canonical.toolCallId,
        ...(canonical.evidence ? { evidence: canonical.evidence } : {}),
      },
      kind: "tool.result.recorded",
      data: {
        toolName: canonical.toolName,
        status: canonical.status,
        body: canonical.body,
        projection: canonical.projection,
      },
    };
    assertRuntimeEvent(event);
    const message = projectRuntimeModelMessage(event);
    if (!message) {
      throw new Error(`Runtime tool result ${canonical.toolCallId} has no model projection`);
    }
    const queue = this.pendingToolResults.get(canonical.toolCallId) ?? [];
    queue.push({ event, message });
    this.pendingToolResults.set(canonical.toolCallId, queue);
    return structuredClone(message);
  }

  async recordApprovalRequested(
    approvalId: string,
    toolCallId: string,
    toolName: string,
  ): Promise<void> {
    this.assertOpen();
    const event: RuntimeApprovalRequestedEvent = {
      ...this.base(createRuntimeEventId("approval-requested"), true, "internal"),
      refs: this.refs({ toolCallId }),
      kind: "approval.requested",
      data: { approvalId, toolName },
    };
    await this.append(event);
  }

  async recordApprovalSettled(
    approvalId: string,
    decision: "approved" | "rejected",
  ): Promise<void> {
    this.assertOpen();
    const event: RuntimeApprovalSettledEvent = {
      ...this.base(createRuntimeEventId("approval-settled"), true, "internal"),
      kind: "approval.settled",
      data: { approvalId, decision },
    };
    await this.append(event);
  }

  async recordModelCallStarted(options: RuntimeModelCallStartedOptions): Promise<void> {
    this.assertOpen();
    await this.append({
      ...this.base(createRuntimeEventId("model-call-started"), true, "internal"),
      refs: this.refs({ providerCallId: options.providerCallId }),
      kind: "model.call.started",
      data: options,
    });
  }

  async recordModelCallSettled(options: RuntimeModelCallSettledOptions): Promise<void> {
    this.assertOpen();
    await this.append({
      ...this.base(createRuntimeEventId("model-call-settled"), true, "internal"),
      refs: this.refs({ providerCallId: options.providerCallId }),
      kind: "model.call.settled",
      data: options,
    });
  }

  async recordCheckpoint(options: RuntimeCheckpointOptions): Promise<void> {
    this.assertOpen();
    const event: RuntimeCheckpointRecordedEvent = {
      ...this.base(options.eventId ?? createRuntimeEventId("context-checkpoint"), true, "internal"),
      kind: "context.checkpoint.recorded",
      data: {
        checkpointId: options.checkpointId,
        coveredEventCount: options.coveredEventCount,
        sourceDigest: options.sourceDigest,
        throughEventId: options.throughEventId,
        summary: structuredClone(options.summary),
        ...(options.previousCheckpointId
          ? { previousCheckpointId: options.previousCheckpointId }
          : {}),
      },
    };
    await this.append(event);
  }

  async recordSessionForked(
    parentSessionId: string,
    throughEventId?: string,
    completion?: RuntimeForkBootstrapCompletion,
    eventId = createRuntimeEventId("session-forked"),
  ): Promise<void> {
    this.assertOpen();
    const event: RuntimeSessionForkedEvent = {
      ...this.base(eventId, false, "internal"),
      kind: "session.forked",
      data: {
        parentSessionId,
        ...(throughEventId ? { throughEventId } : {}),
        ...(completion ?? {}),
      },
    };
    await this.append(event);
  }

  async finish(status: RuntimeTerminalStatus, reason?: string): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.finishPromise = (async () => {
      const terminal = this.terminal ?? {
        ...this.base(
          this.terminalEventId ?? createRuntimeEventId("run-terminal"),
          false,
          "internal",
        ),
        kind: "run.terminal" as const,
        data: { status, ...(reason ? { reason } : {}) },
      };
      if (!this.terminal) {
        await this.append(terminal);
        this.terminal = terminal;
      }
      liveRuntimeRuns.delete(runtimeRunLiveKey(this.sessionId, this.runId));
    })();
    return this.finishPromise;
  }

  private async recordRunStarted(): Promise<void> {
    const event: RuntimeRunStartedEvent = {
      ...this.base(
        this.runStartedEventId ?? createRuntimeEventId("run-started"),
        false,
        "internal",
      ),
      kind: "run.started",
      data: {
        workDir: this.canonicalWorkDir,
        // ADR 29:续跑目标 run 的确定性前缀锚(claimContinuation 成功后由调用方声明)。
        ...(this.continuationOf
          ? { continuationOf: structuredClone(this.continuationOf) }
          : {}),
      },
    };
    await this.append(event);
  }

  private base(
    eventId: string,
    includeStep = true,
    visibility: RuntimeEventBase["visibility"] = "model",
  ): RuntimeEventBase {
    const refs = this.refs(undefined, includeStep);
    return {
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      eventId,
      sessionId: this.sessionId,
      invocationId: this.invocationId,
      runId: this.runId,
      turnId: this.turnId,
      at: this.now().toISOString(),
      partial: false,
      visibility,
      ...(refs ? { refs } : {}),
    };
  }

  private refs(extra?: RuntimeEventRefs, includeStep = true): RuntimeEventRefs | undefined {
    return compactRefs({
      ...(this.parentRefs ?? {}),
      ...(includeStep ? { stepId: this.stepId } : {}),
      ...(extra ?? {}),
    });
  }

  private messageCommittedEvent(eventId: string, message: Message): RuntimeMessageCommittedEvent {
    const canonicalMessage = canonicalizeRuntimeMessage(message);
    assertRuntimeCommittedMessage(canonicalMessage);
    const refs = this.refs();
    return {
      ...this.base(eventId),
      ...(refs ? { refs } : {}),
      kind: "message.committed",
      data: { message: canonicalMessage },
    };
  }

  private append(event: RuntimeEvent): Promise<RuntimeEventStoreAppendResult> {
    return this.writeCanonicalEvent(() => appendRuntimeEventWithArbitration(this.store, event));
  }

  private appendBatch(
    events: readonly RuntimeEvent[],
  ): Promise<readonly RuntimeEventStoreAppendResult[]> {
    return this.writeCanonicalEvent(() =>
      appendRuntimeEventBatchWithArbitration(this.store, events),
    );
  }

  /** Checks the live Session lease on both sides of every canonical write attempt. */
  private writeCanonicalEvent<Result>(write: () => Promise<Result>): Promise<Result> {
    return writeWithRuntimeEventGuard(this.writeGuard, write, `Runtime run ${this.runId}`);
  }

  private assertSession(session: Session): void {
    if (!this.claimsSession(session)) {
      throw new Error(
        `Runtime run ${this.runId} cannot project a Session outside its workspace/store capability`,
      );
    }
  }

  private assertOpen(): void {
    if (this.terminal || this.finishPromise) {
      throw new Error(`Runtime run ${this.runId} is already terminal`);
    }
  }
}

function runtimeRunLiveKey(sessionId: string, runId: string): string {
  return `${sessionId}\u0000${runId}`;
}

async function writeWithRuntimeEventGuard<Result>(
  guard: RuntimeEventWriteGuard,
  write: () => Promise<Result>,
  operation: string,
): Promise<Result> {
  // Windows NTFS 上 lease 校验和原子写偶发瞬时文件系统错误（EPERM/ENOENT/EBUSY）。
  // 只有 LeaseConflictError（leaseId 不匹配 = 真正丢锁）才不可重试；其余重试。
  const GUARD_RETRY_LIMIT = 3;
  for (let attempt = 0; attempt < GUARD_RETRY_LIMIT; attempt += 1) {
    try {
      await guard.assertRuntimeEventWriteAllowed();
    } catch (error) {
      if (error instanceof LeaseConflictError || attempt === GUARD_RETRY_LIMIT - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      continue;
    }
    let result: Result;
    try {
      result = await write();
    } catch (writeError) {
      try {
        await guard.assertRuntimeEventWriteAllowed();
      } catch (guardError) {
        if (
          !(guardError instanceof LeaseConflictError) &&
          !(writeError instanceof LeaseConflictError) &&
          attempt < GUARD_RETRY_LIMIT - 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
          continue;
        }
        throw new AggregateError(
          [writeError, guardError],
          `${operation} write failed after its Session lease became invalid`,
          { cause: guardError },
        );
      }
      throw writeError;
    }
    try {
      await guard.assertRuntimeEventWriteAllowed();
    } catch (error) {
      if (error instanceof LeaseConflictError || attempt === GUARD_RETRY_LIMIT - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      continue;
    }
    return result;
  }
  throw new Error(`${operation} write exhausted transient-error retries`);
}

function findDanglingRuntimeToolCalls(
  events: readonly RuntimeEvent[],
  activeMessageEventIds: ReadonlySet<string>,
): PendingRuntimeToolCall[] {
  const pending: PendingRuntimeToolCall[] = [];
  const unresolvedByToolCallId = new Map<string, PendingRuntimeToolCall[]>();

  for (const event of events) {
    // ADR 27 P0（F1/F2 判定边界）：tool.started 在 registry.execute 之前落库
    // （src/engine/loop.ts runOneTool / 子代理并发循环均如此），因此它的存在
    // 即“已派发”的 durable 事实。按 toolCallId 与 pending 队列保持与 result
    // 相同的 FIFO 配对口径（多 result/多 start 的重试场景逐个配对）。
    if (event.kind === "tool.started") {
      const startedCallId = event.refs?.toolCallId;
      const unresolved = startedCallId ? unresolvedByToolCallId.get(startedCallId) : undefined;
      const dispatchedEntry = unresolved?.find((entry) => !entry.dispatched);
      if (dispatchedEntry) dispatchedEntry.dispatched = true;
      continue;
    }
    if (!runtimeEventHasModelHistoryEntry(event)) continue;
    // Rewind keeps canonical facts but removes them from the active Session projection.
    // Both a call and its result must be matched inside that same active projection.
    if (!activeMessageEventIds.has(event.eventId)) continue;
    if (event.kind === "message.committed") {
      const message = projectRuntimeModelMessage(event);
      if (!message || message.role !== "assistant") continue;
      for (const [callIndex, toolCall] of (message.toolCalls ?? []).entries()) {
        const entry: PendingRuntimeToolCall = {
          source: event,
          toolCall,
          callIndex,
          resolved: false,
          dispatched: false,
        };
        pending.push(entry);
        const unresolved = unresolvedByToolCallId.get(toolCall.id) ?? [];
        unresolved.push(entry);
        unresolvedByToolCallId.set(toolCall.id, unresolved);
      }
      continue;
    }
    const toolCallId = event.refs.toolCallId;
    const unresolved = unresolvedByToolCallId.get(toolCallId);
    const matched = unresolved?.shift();
    if (matched) matched.resolved = true;
    if (unresolved?.length === 0) unresolvedByToolCallId.delete(toolCallId);
  }

  return pending.filter((entry) => !entry.resolved);
}

function isPublishedCompletedForkBootstrap(events: readonly RuntimeEvent[]): boolean {
  const published = events.some((event) => event.kind === "session.forked");
  const completed = events.some(
    (event) => event.kind === "run.terminal" && event.data.status === "completed",
  );
  return published && completed;
}

function buildInterruptedTranscriptToolStartEvents(options: {
  readonly entries: readonly RuntimeEventStoreEntry[];
  readonly pendingToolCalls: readonly PendingRuntimeToolCall[];
  readonly toolResults: readonly RuntimeToolResultRecordedEvent[];
  readonly at: string;
}): RuntimeTranscriptEventRecordedEvent[] {
  if (options.pendingToolCalls.length === 0) return [];
  if (options.pendingToolCalls.length !== options.toolResults.length) {
    throw new Error("Runtime recovery tool starts and results must have the same length");
  }
  const transcriptEntries = projectRuntimeSessionTranscriptEventEntries(options.entries);
  const activeToolCallIds = new Set(
    Object.keys(projectTranscriptEvents(transcriptEntries.map(({ event }) => event)).toolCalls),
  );
  const unmatchedActiveStarts = countUnmatchedActiveTranscriptToolStarts(
    options.entries,
    transcriptEntries,
    activeToolCallIds,
  );
  let nextSequence =
    transcriptEntries.reduce((maximum, { event }) => Math.max(maximum, event.sequence), 0) + 1;
  const starts: RuntimeTranscriptEventRecordedEvent[] = [];
  const durableRuntimeEventIds = new Set(options.entries.map(({ event }) => event.eventId));

  for (const [pendingIndex, pending] of options.pendingToolCalls.entries()) {
    // A retry of this same branch reuses the existing deterministic result.
    // It must not append a fresh running start after that result has closed.
    if (durableRuntimeEventIds.has(options.toolResults[pendingIndex]!.eventId)) continue;
    const source = pending.source;
    const identityInput = {
      sessionId: source.sessionId,
      runId: source.runId,
      turnId: source.turnId,
      callIndex: pending.callIndex,
    };
    const unmatchedCount = unmatchedActiveStarts.get(pending.toolCall.id) ?? 0;
    if (unmatchedCount > 0) {
      unmatchedActiveStarts.set(pending.toolCall.id, unmatchedCount - 1);
      continue;
    }

    const createdAt = Date.parse(source.at);
    if (!Number.isFinite(createdAt)) {
      throw new Error(`Runtime tool-call source ${source.eventId} has an invalid timestamp`);
    }
    const start = createCanonicalTranscriptToolStart({
      ...identityInput,
      scope: "runtime-recovery",
      toolCall: pending.toolCall,
      sequence: nextSequence++,
      createdAt,
    });
    starts.push({
      ...createRuntimeTranscriptToolStartEvent({
        sessionId: source.sessionId,
        invocationId: source.invocationId,
        runId: source.runId,
        turnId: source.turnId,
        start,
        ...(source.refs ? { refs: source.refs } : {}),
      }),
      at: options.at,
    });
  }

  return starts;
}

/**
 * Mirrors hydration's providerCallId FIFO join over the active projections.
 * Wrapper Runtime event IDs and recovery scopes may change across fork/rewind,
 * so neither can be used as the semantic "already started" identity.
 */
function countUnmatchedActiveTranscriptToolStarts(
  entries: readonly RuntimeEventStoreEntry[],
  transcriptEntries: ReturnType<typeof projectRuntimeSessionTranscriptEventEntries>,
  activeToolCallIds: ReadonlySet<string>,
): Map<string, number> {
  const startCounts = new Map<string, number>();
  for (const { event } of transcriptEntries) {
    if (event.type !== "tool.started" || !activeToolCallIds.has(event.toolCallId)) continue;
    startCounts.set(event.providerCallId, (startCounts.get(event.providerCallId) ?? 0) + 1);
  }
  const resultCounts = new Map<string, number>();
  for (const { envelope } of projectRuntimeSessionModelToolResultEntries(entries)) {
    resultCounts.set(envelope.toolCallId, (resultCounts.get(envelope.toolCallId) ?? 0) + 1);
  }
  const unmatched = new Map<string, number>();
  for (const [providerCallId, startCount] of startCounts) {
    const count = Math.max(0, startCount - (resultCounts.get(providerCallId) ?? 0));
    if (count > 0) unmatched.set(providerCallId, count);
  }
  return unmatched;
}

function buildInterruptedToolResultEvent(
  events: readonly RuntimeEvent[],
  pending: PendingRuntimeToolCall,
  at: string,
): RuntimeToolResultRecordedEvent {
  const source = pending.source;
  const toolContext = events.findLast(
    (event) => event.turnId === source.turnId && event.refs?.toolCallId === pending.toolCall.id,
  );
  const refs = compactRefs({
    ...(source.refs ?? {}),
    ...(toolContext?.refs ?? {}),
    toolCallId: pending.toolCall.id,
  });
  // ADR 27 P0 恢复决策表：tool.started 已落库（dispatched）→ indeterminate
  // （副作用可能已发生，结果未知）；否则 → not_dispatched（从未交给执行器）。
  // 模型可见文案（projection.text）必须与分类如实一致。
  const classification: RuntimeToolRecoveryClassification = pending.dispatched
    ? "indeterminate"
    : "not_dispatched";
  const content = pending.dispatched
    ? "工具执行状态未知：该工具调用已被派发，但运行进程在结果持久化前终止。该工具可能已实际执行，其副作用（例如文件写入、外部请求）可能已经发生，实际执行结果未知。请勿假定该调用未执行；如需确认实际效果，请先用只读工具核查。"
    : "工具未执行：运行进程在该工具派发前终止，该调用从未交给执行器执行，未发生任何副作用。";
  const { evidence: _evidence, ...inlineRefs } = refs ?? {};
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: runtimeInterruptionRecoveryEventId("tool-result", [
      source.sessionId,
      source.runId,
      source.eventId,
      pending.callIndex,
      pending.toolCall.id,
    ]),
    sessionId: source.sessionId,
    invocationId: source.invocationId,
    runId: source.runId,
    turnId: source.turnId,
    at,
    partial: false,
    visibility: "model",
    refs: {
      ...inlineRefs,
      toolCallId: pending.toolCall.id,
    },
    kind: "tool.result.recorded",
    data: {
      toolName: pending.toolCall.name,
      status: "interrupted",
      body: {
        storage: "inline",
        content,
        sha256: createHash("sha256").update(content, "utf8").digest("hex"),
        sizeBytes: Buffer.byteLength(content, "utf8"),
      },
      projection: {
        version: 1,
        mode: "synthetic",
        text: content,
        strategy: "runtime-interruption-recovery",
        truncated: false,
      },
      recovery: { classification },
    },
  };
}

function buildInterruptedToolRecoveryRun(options: {
  readonly sourceStarted: RuntimeRunStartedEvent;
  readonly sourceTerminal: RuntimeRunTerminalEvent;
  readonly toolStarts: readonly RuntimeTranscriptEventRecordedEvent[];
  readonly toolResults: readonly RuntimeToolResultRecordedEvent[];
  readonly at: string;
}): RuntimeEvent[] {
  const { sourceStarted, sourceTerminal, toolStarts, toolResults, at } = options;
  const recoveryRunId = runtimeInterruptionRecoveryEventId("run", [
    sourceStarted.sessionId,
    sourceStarted.runId,
    ...toolResults.map((event) => event.eventId),
  ]);
  const invocationId = `invocation:${recoveryRunId}`;
  const turnId = `turn:${recoveryRunId}:repair`;
  const parentRefs = { parentRunId: sourceStarted.runId } as const;
  const started: RuntimeRunStartedEvent = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: runtimeInterruptionRecoveryEventId("run-started", [recoveryRunId]),
    sessionId: sourceStarted.sessionId,
    invocationId,
    runId: recoveryRunId,
    turnId,
    at,
    partial: false,
    visibility: "internal",
    refs: parentRefs,
    kind: "run.started",
    data: { workDir: sourceStarted.data.workDir },
  };
  const recoveredResults = toolResults.map(
    (event): RuntimeToolResultRecordedEvent => ({
      ...event,
      invocationId,
      runId: recoveryRunId,
      turnId,
      refs: { ...(event.refs ?? {}), ...parentRefs },
    }),
  );
  const recoveredStarts = toolStarts.map(
    (event): RuntimeTranscriptEventRecordedEvent => ({
      ...event,
      invocationId,
      runId: recoveryRunId,
      turnId,
      at,
      refs: { ...(event.refs ?? {}), ...parentRefs },
    }),
  );
  const terminal: RuntimeRunTerminalEvent = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: runtimeInterruptionRecoveryEventId("terminal", [recoveryRunId]),
    sessionId: sourceStarted.sessionId,
    invocationId,
    runId: recoveryRunId,
    turnId,
    at,
    partial: false,
    visibility: "internal",
    refs: parentRefs,
    kind: "run.terminal",
    data: {
      status: "completed",
      reason: `recovered_interrupted_tool_results_after_${sourceTerminal.data.status}`,
      recovered: true,
    },
  };
  return [started, ...recoveredStarts, ...recoveredResults, terminal];
}

function runtimeInterruptionRecoveryEventId(
  kind: "run" | "run-started" | "terminal" | "tool-result",
  identity: readonly (number | string)[],
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["runtime-interruption-recovery-v1", kind, ...identity]))
    .digest("hex");
  return `runtime-recovery:${kind}:${digest}`;
}

function compactRefs(value: RuntimeEventRefs): RuntimeEventRefs | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as RuntimeEventRefs) : undefined;
}

function serializeExternalMessageCommit<Result>(
  sessionKey: string,
  eventId: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const key = `${sessionKey}\0${eventId}`;
  const previous = externalMessageCommitTails.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  externalMessageCommitTails.set(key, tail);
  return result.finally(() => {
    if (externalMessageCommitTails.get(key) === tail) {
      externalMessageCommitTails.delete(key);
    }
  });
}

function serializeForkBootstrap<Result>(
  sessionKey: string,
  writeGuard: RuntimeEventWriteGuard,
  operation: (writeGuard: RuntimeEventWriteGuard) => Promise<Result>,
): Promise<Result> {
  const previous = forkBootstrapTails.get(sessionKey) ?? Promise.resolve();
  const result = previous.then(async () => {
    await writeGuard.assertRuntimeEventWriteAllowed();
    const value = await operation(writeGuard);
    await writeGuard.assertRuntimeEventWriteAllowed();
    return value;
  });
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  forkBootstrapTails.set(sessionKey, tail);
  return result.finally(() => {
    if (forkBootstrapTails.get(sessionKey) === tail) forkBootstrapTails.delete(sessionKey);
  });
}

function runtimeEventStoreFromCapability(capability: EngineRuntimeCapability): SqliteRuntimeEventStore {
  assertIssuedEngineRuntimeCapability(capability);
  if (!(capability.runtimeAuthority instanceof SqliteRuntimeEventStore)) {
    throw new Error(`Runtime capability for Session ${capability.sessionId} has no event store`);
  }
  return capability.runtimeAuthority;
}

function runtimeSessionKey(storageRoot: string, workDir: string, sessionId: string): string {
  return `${resolve(storageRoot)}\0${canonicalizeWorkspacePath(workDir)}\0${sessionId}`;
}

function runtimeForkBootstrapIdentity(
  options: RuntimeForkBootstrapSeed,
  completion: RuntimeForkBootstrapCompletion,
  modelCheckpoint: RuntimeForkModelCheckpointSeed | undefined,
  sourceThroughEventId: string | undefined,
  statePublication: RuntimeForkStatePublication | undefined,
  canonicalWorkDir: string,
  operationCreatedAt: string | undefined,
): RuntimeForkBootstrapIdentity {
  const checkpointSeed = modelCheckpoint
    ? [modelCheckpoint.coveredMessageCount, modelCheckpoint.summary]
    : undefined;
  const stateSeed = statePublication
    ? [statePublication.eventId, statePublication.at, statePublication.patch]
    : undefined;
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        options.operationId ?? "seed-derived",
        options.sourceSessionId,
        options.targetSessionId,
        completion.sourceDigest,
        completion.messageCount,
        sourceThroughEventId ?? null,
        canonicalWorkDir,
        operationCreatedAt ?? null,
        ...(checkpointSeed ? [checkpointSeed] : []),
        ...(stateSeed ? [stateSeed] : []),
      ]),
    )
    .digest("hex");
  const eventNamespace = `fork:${digest}`;
  return {
    runId: `${RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX}${digest}`,
    invocationId: `${eventNamespace}:invocation`,
    runStartedEventId: `${eventNamespace}:started`,
    markerEventId: `${eventNamespace}:published`,
    terminalEventId: `${eventNamespace}:terminal`,
    checkpointEventId: `${eventNamespace}:checkpoint`,
    checkpointId: `${eventNamespace}:checkpoint`,
    seedEventId: (index) => `${eventNamespace}:seed:${index}`,
  };
}

function normalizeForkModelCheckpoint(
  checkpoint: RuntimeForkModelCheckpointSeed | undefined,
  messageCount: number,
): RuntimeForkModelCheckpointSeed | undefined {
  if (!checkpoint) return undefined;
  if (
    !Number.isSafeInteger(checkpoint.coveredMessageCount) ||
    checkpoint.coveredMessageCount <= 0 ||
    checkpoint.coveredMessageCount > messageCount
  ) {
    throw new Error("Runtime fork checkpoint must cover a non-empty transcript prefix");
  }
  return {
    coveredMessageCount: checkpoint.coveredMessageCount,
    summary: stripMessageUsage(checkpoint.summary),
  };
}

function normalizeForkSourceThroughEventId(
  seedEntries: readonly RuntimeSessionForkSeedEntry[],
  explicit: string | undefined,
): string | undefined {
  const derived = seedEntries.findLast((entry) => entry.kind === "model")?.event.eventId;
  if (explicit !== undefined && explicit !== derived) {
    throw new Error(`Runtime fork source boundary ${explicit} does not match its canonical seed`);
  }
  return derived;
}

function normalizeForkStatePublication(
  publication: RuntimeForkStatePublication | undefined,
): RuntimeForkStatePublication | undefined {
  if (!publication) return undefined;
  if (!publication.eventId) throw new Error("Runtime fork state eventId must be non-empty");
  const timestamp = Date.parse(publication.at);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Runtime fork state has an invalid timestamp: ${publication.at}`);
  }
  const patch = normalizeSessionRuntimeStatePatch(publication.patch);
  if (!patch) throw new Error("Runtime fork state patch is invalid");
  return {
    eventId: publication.eventId,
    at: new Date(timestamp).toISOString(),
    patch,
  };
}

function normalizeForkOperationCreatedAt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Fork operation has an invalid createdAt timestamp: ${value}`);
  }
  return new Date(timestamp).toISOString();
}

function assertRuntimeForkCheckpoint(
  events: readonly RuntimeEvent[],
  identity: RuntimeForkBootstrapIdentity,
  checkpoint: RuntimeForkModelCheckpointSeed | undefined,
  seedEntries: readonly RuntimeSessionForkSeedEntry[],
): void {
  const existing = events.find((event) => event.eventId === identity.checkpointEventId);
  if (!checkpoint) {
    if (existing) {
      throw runtimeForkConflict(
        `Runtime fork run ${identity.runId} has an unexpected checkpoint fact`,
      );
    }
    return;
  }
  const coveredEventIds = forkModelSeedEventIds(seedEntries, identity).slice(
    0,
    checkpoint.coveredMessageCount,
  );
  if (
    !existing ||
    existing.kind !== "context.checkpoint.recorded" ||
    existing.runId !== identity.runId ||
    existing.data.checkpointId !== identity.checkpointId ||
    existing.data.coveredEventCount !== checkpoint.coveredMessageCount ||
    existing.data.sourceDigest !== runtimeEventIdDigest(coveredEventIds) ||
    existing.data.throughEventId !== coveredEventIds.at(-1) ||
    !isDeepStrictEqual(existing.data.summary, checkpoint.summary)
  ) {
    throw runtimeForkConflict(
      `Runtime fork run ${identity.runId} has a conflicting checkpoint fact`,
    );
  }
}

function assertRuntimeForkState(
  events: readonly RuntimeEvent[],
  publication: RuntimeForkStatePublication | undefined,
  targetSessionId: string,
  required: boolean,
): void {
  const stateEvents = events.filter((event) => event.kind === "session.state.committed");
  if (!publication) {
    if (stateEvents.length > 0) {
      throw runtimeForkConflict(
        `Runtime fork target ${targetSessionId} has an unexpected state publication`,
      );
    }
    return;
  }
  const unexpected = stateEvents.find((event) => event.eventId !== publication.eventId);
  if (unexpected) {
    throw runtimeForkConflict(
      `Runtime fork target ${targetSessionId} has unexpected state fact ${unexpected.eventId}`,
    );
  }
  const existing = stateEvents.find((event) => event.eventId === publication.eventId);
  if (!existing) {
    if (required) {
      throw runtimeForkConflict(
        `Runtime fork target ${targetSessionId} published before its state fact`,
      );
    }
    return;
  }
  if (
    existing.at !== publication.at ||
    !isDeepStrictEqual(existing.data.patch, publication.patch)
  ) {
    throw runtimeForkConflict(
      `Runtime fork state event ${publication.eventId} has a conflicting payload`,
    );
  }
}

function assertRuntimeForkPublicationOrder(
  events: readonly RuntimeEvent[],
  identity: RuntimeForkBootstrapIdentity,
  seedEntries: readonly RuntimeSessionForkSeedEntry[],
  checkpoint: RuntimeForkModelCheckpointSeed | undefined,
  statePublication: RuntimeForkStatePublication | undefined,
  marker: RuntimeSessionForkedEvent | undefined,
  targetSessionId: string,
): void {
  const startIndex = requiredForkEventIndex(
    events,
    identity.runStartedEventId,
    targetSessionId,
    "start",
  );
  let payloadTailIndex = startIndex;
  for (const [index] of seedEntries.entries()) {
    const seedIndex = requiredForkEventIndex(
      events,
      identity.seedEventId(index),
      targetSessionId,
      `seed ${index}`,
    );
    if (seedIndex <= payloadTailIndex) {
      throw runtimeForkConflict(
        `Runtime fork target ${targetSessionId} has canonical facts outside publication order`,
      );
    }
    payloadTailIndex = seedIndex;
  }
  if (checkpoint) {
    const checkpointIndex = requiredForkEventIndex(
      events,
      identity.checkpointEventId,
      targetSessionId,
      "checkpoint",
    );
    if (checkpointIndex <= payloadTailIndex) {
      throw runtimeForkConflict(
        `Runtime fork target ${targetSessionId} has a checkpoint outside publication order`,
      );
    }
    payloadTailIndex = checkpointIndex;
  }
  if (statePublication) {
    const stateIndex = requiredForkEventIndex(
      events,
      statePublication.eventId,
      targetSessionId,
      "state",
    );
    if (stateIndex <= payloadTailIndex) {
      throw runtimeForkConflict(
        `Runtime fork target ${targetSessionId} has state outside publication order`,
      );
    }
    payloadTailIndex = stateIndex;
  }
  if (!marker) {
    const prematureTerminal = events.find(
      (event) => event.kind === "run.terminal" && event.runId === identity.runId,
    );
    if (prematureTerminal) {
      throw runtimeForkConflict(
        `Runtime fork target ${targetSessionId} reached terminal before publication`,
      );
    }
    return;
  }
  const markerIndex = requiredForkEventIndex(
    events,
    marker.eventId,
    targetSessionId,
    "publication marker",
  );
  if (markerIndex <= payloadTailIndex) {
    throw runtimeForkConflict(
      `Runtime fork target ${targetSessionId} published before its canonical payload`,
    );
  }
  const terminal = events.find(
    (event) => event.kind === "run.terminal" && event.runId === identity.runId,
  );
  if (terminal) {
    const terminalIndex = requiredForkEventIndex(
      events,
      terminal.eventId,
      targetSessionId,
      "terminal",
    );
    if (terminalIndex <= markerIndex) {
      throw runtimeForkConflict(
        `Runtime fork target ${targetSessionId} reached terminal before publication`,
      );
    }
  }
}

function requiredForkEventIndex(
  events: readonly RuntimeEvent[],
  eventId: string,
  targetSessionId: string,
  fact: string,
): number {
  const index = events.findIndex((event) => event.eventId === eventId);
  if (index >= 0) return index;
  throw runtimeForkConflict(`Runtime fork target ${targetSessionId} is missing its ${fact} fact`);
}

function runtimeForkConflict(message: string): SessionForkRuntimeConflictError {
  return new SessionForkRuntimeConflictError(message, "target_conflict");
}

function runtimeEventIdDigest(eventIds: readonly string[]): string {
  return createHash("sha256").update(eventIds.join("\n")).digest("hex");
}

function runtimeForkBootstrapAt(operationCreatedAt: string | undefined): string {
  return operationCreatedAt ?? new Date().toISOString();
}

function stripMessageUsage(message: Message): Message {
  const { usage: _usage, ...copy } = structuredClone(message);
  return copy;
}

function canonicalizeRuntimeMessage(message: Message): Message {
  try {
    const encoded = JSON.stringify(message);
    if (encoded === undefined) throw new Error("message encoded to undefined");
    return JSON.parse(encoded) as Message;
  } catch (error) {
    throw new Error("Runtime message must be JSON-serializable", { cause: error });
  }
}

function assertRuntimeCommittedMessage(message: Message): void {
  if (message.toolCallId !== undefined || message.toolResultEvidenceUri !== undefined) {
    throw new Error(
      `Runtime ToolResult projection ${message.toolCallId ?? "without call ID"} cannot be persisted as message.committed`,
    );
  }
}

function canonicalizeRuntimeToolResultInput(
  input: EngineRuntimeToolResultInput,
): EngineRuntimeToolResultInput {
  try {
    const encoded = JSON.stringify(input);
    if (encoded === undefined) throw new Error("tool result encoded to undefined");
    return JSON.parse(encoded) as EngineRuntimeToolResultInput;
  } catch (error) {
    throw new Error("Runtime tool result must be JSON-serializable", { cause: error });
  }
}

function forkSeedDigest(entries: readonly RuntimeSessionForkSeedEntry[]): string {
  return createHash("sha256")
    .update(JSON.stringify(entries.map(forkSeedPayload)))
    .digest("hex");
}

function normalizeForkSeedEntries(
  entries: readonly RuntimeSessionForkSeedEntry[],
  sourceSessionId: string,
): RuntimeSessionForkSeedEntry[] {
  let previousSourceSequence = 0;
  const transcriptEvents: DurableTranscriptEvent[] = [];
  const normalized = entries.map((source, index): RuntimeSessionForkSeedEntry => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error(`Runtime fork seed ${index} must be an object`);
    }
    if (
      !Number.isSafeInteger(source.sourceSequence) ||
      source.sourceSequence <= previousSourceSequence
    ) {
      throw new Error("Runtime fork seed source sequences must be strictly increasing");
    }
    previousSourceSequence = source.sourceSequence;
    if (source.kind === "model") {
      const event = structuredClone(source.event);
      const eventId = event.eventId;
      assertRuntimeEvent(event);
      if (!runtimeEventHasModelHistoryEntry(event)) {
        throw new Error(`Runtime fork seed event ${eventId} is not model-visible`);
      }
      if (event.sessionId !== sourceSessionId) {
        throw new Error(`Runtime fork seed event ${eventId} belongs to another Session`);
      }
      return {
        kind: "model",
        sourceSequence: source.sourceSequence,
        event:
          event.kind === "message.committed"
            ? {
                ...event,
                data: { message: stripMessageUsage(event.data.message) },
              }
            : event,
      };
    }
    if (source.kind === "transcript") {
      const event = structuredClone(source.event);
      assertDurableTranscriptEvent(event);
      transcriptEvents.push(event);
      return {
        kind: "transcript",
        sourceSequence: source.sourceSequence,
        event,
      };
    }
    throw new Error(`Runtime fork seed ${index} has an invalid kind`);
  });
  projectTranscriptEvents(transcriptEvents);
  return normalized;
}

function assertForkBootstrapStart(
  existingEvents: readonly RuntimeEvent[],
  identity: RuntimeForkBootstrapIdentity,
  targetSessionId: string,
  canonicalWorkDir: string,
  operationCreatedAt: string | undefined,
): RuntimeRunStartedEvent | undefined {
  const starts = existingEvents.filter(
    (event): event is RuntimeRunStartedEvent =>
      event.kind === "run.started" &&
      (event.runId === identity.runId || event.eventId === identity.runStartedEventId),
  );
  if (starts.length > 1) {
    throw runtimeForkConflict(
      `Runtime fork target ${targetSessionId} has conflicting bootstrap start facts`,
    );
  }
  const started = starts[0];
  if (
    started &&
    (started.eventId !== identity.runStartedEventId ||
      started.runId !== identity.runId ||
      started.invocationId !== identity.invocationId ||
      started.sessionId !== targetSessionId ||
      started.turnId !== `turn:${identity.runId}:input` ||
      started.data.workDir !== canonicalWorkDir ||
      (operationCreatedAt !== undefined && started.at !== operationCreatedAt) ||
      started.partial ||
      started.visibility !== "internal")
  ) {
    throw runtimeForkConflict(
      `Runtime fork target ${targetSessionId} has a conflicting bootstrap start fact`,
    );
  }
  return started;
}

function assertForkSeedPrefix(
  existingEvents: readonly RuntimeEvent[],
  expected: readonly RuntimeSessionForkSeedEntry[],
  targetSessionId: string,
  identity: RuntimeForkBootstrapIdentity,
  bootstrapAt: string | undefined,
): number {
  const expectedIds = new Set(expected.map((_, index) => identity.seedEventId(index)));
  const unexpected = existingEvents.find(
    (event) =>
      (runtimeEventHasModelHistoryEntry(event) || event.kind === "transcript.event.recorded") &&
      !expectedIds.has(event.eventId),
  );
  if (unexpected) {
    throw runtimeForkConflict(
      `Runtime fork target ${targetSessionId} contains unexpected canonical fact ${unexpected.eventId}`,
    );
  }

  let importedCount = 0;
  let missing = false;
  let previousLedgerIndex = -1;
  for (const [index, seed] of expected.entries()) {
    const eventId = identity.seedEventId(index);
    const ledgerIndex = existingEvents.findIndex((event) => event.eventId === eventId);
    if (ledgerIndex < 0) {
      missing = true;
      continue;
    }
    if (
      missing ||
      bootstrapAt === undefined ||
      ledgerIndex <= previousLedgerIndex ||
      !matchesImportedForkSeedEvent(
        existingEvents[ledgerIndex]!,
        seed,
        targetSessionId,
        identity,
        bootstrapAt,
      )
    ) {
      throw runtimeForkConflict(
        `Runtime fork target ${targetSessionId} diverges from its frozen v5 canonical seed`,
      );
    }
    previousLedgerIndex = ledgerIndex;
    importedCount += 1;
  }
  return importedCount;
}

function matchesImportedForkSeedEvent(
  actual: RuntimeEvent,
  expected: RuntimeSessionForkSeedEntry,
  targetSessionId: string,
  identity: RuntimeForkBootstrapIdentity,
  bootstrapAt: string,
): boolean {
  if (
    actual.sessionId !== targetSessionId ||
    actual.invocationId !== identity.invocationId ||
    actual.runId !== identity.runId ||
    actual.turnId !== `turn:${identity.runId}:input` ||
    actual.at !== bootstrapAt ||
    actual.partial
  ) {
    return false;
  }
  if (expected.kind === "transcript") {
    return (
      actual.kind === "transcript.event.recorded" &&
      actual.visibility === "transcript" &&
      actual.refs === undefined &&
      isDeepStrictEqual(actual.data.event, expected.event)
    );
  }
  if (!runtimeEventHasModelHistoryEntry(actual) || actual.visibility !== "model") return false;
  const stepId = `step:${identity.runId}:input`;
  const expectedRefs =
    expected.event.kind === "message.committed"
      ? { stepId }
      : {
          stepId,
          toolCallId: expected.event.refs.toolCallId,
          ...(expected.event.refs.evidence
            ? { evidence: structuredClone(expected.event.refs.evidence) }
            : {}),
        };
  return (
    isDeepStrictEqual(actual.refs, expectedRefs) &&
    isDeepStrictEqual(forkHistoryPayload(actual), forkHistoryPayload(expected.event))
  );
}

function countForkModelSeedEntries(entries: readonly RuntimeSessionForkSeedEntry[]): number {
  return entries.reduce((count, entry) => count + (entry.kind === "model" ? 1 : 0), 0);
}

function forkModelSeedEventIds(
  entries: readonly RuntimeSessionForkSeedEntry[],
  identity: RuntimeForkBootstrapIdentity,
): string[] {
  return entries.flatMap((entry, index) =>
    entry.kind === "model" ? [identity.seedEventId(index)] : [],
  );
}

function forkSeedPayload(entry: RuntimeSessionForkSeedEntry): unknown {
  return {
    kind: entry.kind,
    sourceSequence: entry.sourceSequence,
    event: entry.kind === "model" ? forkHistoryPayload(entry.event) : entry.event,
  };
}

function forkHistoryPayload(event: RuntimeModelHistoryEvent): unknown {
  if (event.kind === "message.committed") {
    return {
      kind: event.kind,
      data: { message: stripMessageUsage(event.data.message) },
    };
  }
  return {
    kind: event.kind,
    refs: {
      toolCallId: event.refs.toolCallId,
      ...(event.refs.evidence ? { evidence: event.refs.evidence } : {}),
    },
    data: event.data,
  };
}

function runtimeFailureReason(error: unknown): string {
  if (isAbortError(error)) return "aborted";
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return detail.slice(0, 1_000);
}

function runtimeCommitReceipt(result: RuntimeEventStoreAppendResult): CommitReceipt {
  return {
    eventId: result.cursor.eventId,
    cursor: result.cursor,
    committedAt: result.committedAt,
    durable: true,
    inserted: result.inserted,
  };
}
