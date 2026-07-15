import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAbortError } from "../provider/errors.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { RunLedger } from "../engine/run-ledger.js";
import type { CommitReceipt } from "../engine/session-persistence.js";
import type { Session } from "../engine/session.js";
import type { Message } from "../schema/message.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeApprovalRequestedEvent,
  type RuntimeApprovalSettledEvent,
  type RuntimeCheckpointRecordedEvent,
  type RuntimeEvidenceReference,
  type RuntimeEventBase,
  type RuntimeEventRefs,
  type RuntimeHistoryRewoundEvent,
  type RuntimeMessageCommittedEvent,
  type RuntimeModelCallSettledEvent,
  type RuntimeRunStartedEvent,
  type RuntimeRunTerminalEvent,
  type RuntimeSessionForkedEvent,
  type RuntimeTerminalStatus,
  type RuntimeToolStartedEvent,
} from "./runtime-event.js";
import type { RuntimeHistoryProjectionEntry } from "./runtime-event-read-model.js";
import {
  RuntimeEventStore,
  createRuntimeEventId,
  type RuntimeEventStoreAppendResult,
  type RuntimeEventStoreOptions,
} from "./runtime-event-store.js";
import {
  projectRuntimeSessionMessageEntries,
  projectRuntimeSessionMessages,
  projectRuntimeSessionState,
} from "./runtime-session-projection.js";

const runtimeRunContext = new AsyncLocalStorage<RuntimeRun>();
const runtimeToolCallContext = new AsyncLocalStorage<string>();
const externalMessageCommitTails = new Map<string, Promise<void>>();
const forkBootstrapTails = new Map<string, Promise<void>>();

export interface RuntimeRunStartOptions {
  readonly sessionId: string;
  readonly workDir: string;
  readonly runId?: string;
  readonly invocationId?: string;
  readonly parentRunId?: string;
  readonly parentToolCallId?: string;
  readonly now?: () => Date;
  readonly store?: RuntimeEventStore;
}

export interface ReconcileRuntimeRunsOptions {
  readonly sessionId: string;
  readonly workDir: string;
  readonly now?: () => Date;
  readonly store?: RuntimeEventStore;
}

export interface RepairRuntimeSessionProjectionOptions {
  readonly workDir: string;
  readonly store?: RuntimeEventStore;
}

export interface BootstrapRuntimeForkOptions {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  /** The immutable, usage-free Session seed published by SessionForkService. */
  readonly messages: readonly Message[];
  readonly workDir: string;
  readonly store?: RuntimeEventStore;
}

export interface BootstrapRuntimeSessionHistoryOptions {
  readonly session: Session;
  readonly workDir: string;
  readonly store?: RuntimeEventStore;
}

export interface RecordRuntimeSessionRewindOptions {
  readonly sessionId: string;
  readonly workDir: string;
  readonly messageIndex: number;
  readonly branchId: string;
  readonly store?: RuntimeEventStore;
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
  readonly error?: string;
}

export interface RuntimeCheckpointOptions {
  readonly checkpointId: string;
  readonly coveredEventCount: number;
  readonly sourceDigest: string;
  readonly throughEventId: string;
  readonly summary: Message;
}

interface RuntimeForkBootstrapCompletion {
  readonly sourceDigest: string;
  readonly messageCount: number;
}

/** The canonical run bound to the current asynchronous Agent execution. */
export function currentRuntimeRun(): RuntimeRun | undefined {
  return runtimeRunContext.getStore();
}

/** The tool that caused the current nested Agent work, including a delegated child run. */
export function currentRuntimeToolCallId(): string | undefined {
  return runtimeToolCallContext.getStore();
}

export function runWithRuntimeToolCall<Result>(toolCallId: string, run: () => Result): Result {
  return runtimeToolCallContext.run(toolCallId, run);
}

/**
 * Coordinates one Agent invocation. Runtime events are authoritative; Session memory
 * and the smaller RunLedger remain replaceable projections for UI and tooling.
 */
export class RuntimeRun {
  readonly runId: string;
  readonly invocationId: string;
  readonly store: RuntimeEventStore;
  readonly ledger: RunLedger;
  private readonly now: () => Date;
  private readonly parentRefs?: Pick<RuntimeEventRefs, "parentRunId" | "parentToolCallId">;
  private readonly evidenceByToolCallId = new Map<string, RuntimeEvidenceReference>();
  private turnId: string;
  private stepId: string;
  private terminal?: RuntimeRunTerminalEvent;
  private finishPromise?: Promise<void>;

  private constructor(
    readonly sessionId: string,
    readonly workDir: string,
    ledger: RunLedger,
    options: RuntimeRunStartOptions,
  ) {
    this.runId = ledger.runId;
    this.invocationId = options.invocationId ?? `invocation:${randomUUID()}`;
    this.store =
      options.store ??
      new RuntimeEventStore({
        databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
      } satisfies RuntimeEventStoreOptions);
    this.ledger = ledger;
    this.now = options.now ?? (() => new Date());
    this.parentRefs = compactRefs({
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
      ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
    });
    this.turnId = `turn:${this.runId}:input`;
    this.stepId = `step:${this.runId}:input`;
  }

  static async start(options: RuntimeRunStartOptions): Promise<RuntimeRun> {
    const store =
      options.store ??
      new RuntimeEventStore({
        databasePath: resolvePicoPaths(options.workDir).workspace.runtimeDatabase,
      });
    await store.initializeSession({
      sessionId: options.sessionId,
      workDir: options.workDir,
      ...(options.now ? { now: options.now } : {}),
    });
    const ledger = await RunLedger.start({
      baseDir: resolvePicoPaths(options.workDir).workspace.runs,
      sessionId: options.sessionId,
      workDir: options.workDir,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    const run = new RuntimeRun(options.sessionId, options.workDir, ledger, { ...options, store });
    try {
      await run.recordRunStarted();
      return run;
    } catch (error) {
      await ledger.finish("failed", "runtime_event_start_failed").catch(() => undefined);
      throw error;
    }
  }

  /** Completes old canonical runs that reached neither a terminal event nor a clean stop. */
  static async reconcileIncompleteRuns(options: ReconcileRuntimeRunsOptions): Promise<string[]> {
    const store =
      options.store ??
      new RuntimeEventStore({
        databasePath: resolvePicoPaths(options.workDir).workspace.runtimeDatabase,
      });
    const manifest = await store.readSessionManifest(options.sessionId);
    if (!manifest) return [];

    await RunLedger.reconcileIncompleteRuns({
      baseDir: resolvePicoPaths(options.workDir).workspace.runs,
      sessionId: options.sessionId,
      ...(options.now ? { now: options.now } : {}),
    });

    const reconciled: string[] = [];
    for (const runId of await store.listRunIds(options.sessionId)) {
      const events = await store.readRun(options.sessionId, runId);
      const started = events.find((event) => event.kind === "run.started");
      if (!started || events.some((event) => event.kind === "run.terminal")) continue;
      const last = events.at(-1) ?? started;
      await store.append({
        schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
        eventId: createRuntimeEventId("run-terminal"),
        sessionId: options.sessionId,
        invocationId: last.invocationId,
        runId,
        turnId: last.turnId,
        at: (options.now ?? (() => new Date()))().toISOString(),
        partial: false,
        visibility: "internal",
        ...(last.refs ? { refs: last.refs } : {}),
        kind: "run.terminal",
        data: {
          status: "interrupted",
          reason: "recovered_without_terminal_fact",
          recovered: true,
        },
      });
      reconciled.push(runId);
    }
    return reconciled;
  }

  /** Repairs the in-memory Session projection from durable canonical facts. */
  static async repairSessionProjection(
    session: Session,
    options: RepairRuntimeSessionProjectionOptions,
  ): Promise<boolean> {
    const store =
      options.store ??
      new RuntimeEventStore({
        databasePath: resolvePicoPaths(options.workDir).workspace.runtimeDatabase,
      });
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
  }

  /**
   * Creates the canonical history for a fork from a frozen source snapshot. The copied
   * message facts remain immutable and the target gets
   * its own bootstrap run, rather than silently inheriting the parent's run files.
   */
  static async bootstrapFork(options: BootstrapRuntimeForkOptions): Promise<boolean> {
    if (options.sourceSessionId === options.targetSessionId) {
      throw new Error("Runtime fork source 与 target sessionId 不能相同");
    }
    const store =
      options.store ??
      new RuntimeEventStore({
        databasePath: resolvePicoPaths(options.workDir).workspace.runtimeDatabase,
      });
    const messages = options.messages.map(stripMessageUsage);
    const completion: RuntimeForkBootstrapCompletion = {
      sourceDigest: forkSeedDigest(messages),
      messageCount: messages.length,
    };

    return serializeForkBootstrap(options.targetSessionId, async () => {
      const existingEvents = await store.readSession(options.targetSessionId);
      const forkMarkers = existingEvents.filter(
        (event): event is RuntimeSessionForkedEvent => event.kind === "session.forked",
      );
      const conflictingMarker = forkMarkers.find(
        (event) => event.data.parentSessionId !== options.sourceSessionId,
      );
      if (conflictingMarker) {
        throw new Error(
          `Runtime fork target ${options.targetSessionId} is already bound to parent ${conflictingMarker.data.parentSessionId}`,
        );
      }
      const completedMarker = forkMarkers.find((event) => event.data.sourceDigest !== undefined);
      if (completedMarker) {
        if (
          completedMarker.data.sourceDigest !== completion.sourceDigest ||
          completedMarker.data.messageCount !== completion.messageCount
        ) {
          throw new Error(
            `Runtime fork target ${options.targetSessionId} has a conflicting frozen seed`,
          );
        }
        return false;
      }

      const imported = projectRuntimeSessionMessageEntries(existingEvents).map(({ message }) =>
        stripMessageUsage(message),
      );
      if (!isMessagePrefix(imported, messages)) {
        throw new Error(
          `Runtime fork target ${options.targetSessionId} has incomplete facts that diverge from its frozen Session seed`,
        );
      }
      // Compatibility: old bootstrap wrote session.forked before its copied messages.
      // A complete old fork is already a usable history; only incomplete prefixes resume.
      if (forkMarkers.length > 0 && imported.length === messages.length) return false;

      const forkRun = await RuntimeRun.start({
        sessionId: options.targetSessionId,
        workDir: options.workDir,
        store,
      });
      await forkRun.run(async () => {
        for (const message of messages.slice(imported.length)) {
          await forkRun.recordImportedMessage(message);
        }
        const throughEventId = await resolveForkSourceThroughEventId(
          store,
          options.sourceSessionId,
          messages,
        );
        // This is the completion marker. Until it is durable, a future start can replay
        // the immutable target seed and finish a partially written bootstrap.
        await forkRun.recordSessionForked(options.sourceSessionId, throughEventId, completion);
      });
      return true;
    });
  }

  /**
   * Adopts an existing in-memory Session into canonical history before its first
   * RuntimeEvent-backed run.
   */
  static async bootstrapSessionHistory(
    options: BootstrapRuntimeSessionHistoryOptions,
  ): Promise<boolean> {
    const store =
      options.store ??
      new RuntimeEventStore({
        databasePath: resolvePicoPaths(options.workDir).workspace.runtimeDatabase,
      });
    if (await store.readSessionManifest(options.session.id)) return false;
    const history = options.session.getModelContext();
    if (history.length === 0) return false;

    const run = await RuntimeRun.start({
      sessionId: options.session.id,
      workDir: options.workDir,
      store,
    });
    await run.run(async () => {
      for (const message of history) {
        await run.recordBootstrapMessage(message);
      }
    });
    return true;
  }

  /** Appends an immutable rewind fact after the Session/UI projection has completed its saga. */
  static async recordSessionRewind(options: RecordRuntimeSessionRewindOptions): Promise<boolean> {
    const store =
      options.store ??
      new RuntimeEventStore({
        databasePath: resolvePicoPaths(options.workDir).workspace.runtimeDatabase,
      });
    if (!(await store.readSessionManifest(options.sessionId))) return false;

    const events = await store.readSession(options.sessionId);
    const messages = projectRuntimeSessionMessageEntries(events);
    const retainedCount = Math.max(0, Math.min(options.messageIndex, messages.length));
    const throughEventId = messages[retainedCount - 1]?.eventId;
    const existing = events.find(
      (event): event is RuntimeHistoryRewoundEvent =>
        event.kind === "history.rewound" && event.data.branchId === options.branchId,
    );
    if (existing) {
      if (existing.data.throughEventId !== throughEventId) {
        throw new Error(
          `Runtime rewind branch ${options.branchId} is already bound to another history boundary`,
        );
      }
      return true;
    }
    const rewindRun = await RuntimeRun.start({
      sessionId: options.sessionId,
      workDir: options.workDir,
      store,
    });
    await rewindRun.run(async () => {
      await rewindRun.recordHistoryRewound(options.branchId, throughEventId);
    });
    return true;
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
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(session.workDir).workspace.runtimeDatabase,
    });
    if (!(await store.readSessionManifest(session.id))) return false;
    const run = await RuntimeRun.start({
      sessionId: session.id,
      workDir: session.workDir,
      store,
    });
    await run.run(() => run.commitMessages(session, messages));
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
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(session.workDir).workspace.runtimeDatabase,
    });
    if (!(await store.readSessionManifest(session.id))) return undefined;
    return serializeExternalMessageCommit(session.id, eventId, async () => {
      const existing = (await store.readSession(session.id)).find(
        (event) => event.eventId === eventId,
      );
      if (existing) {
        if (
          existing.kind !== "message.committed" ||
          !isDeepStrictEqual(existing.data.message, message)
        ) {
          throw new Error(`Runtime event ID ${eventId} is already bound to another payload`);
        }
        const persisted = await store.append(existing);
        await session.commitProjectionMessageOnce(eventId, message);
        return runtimeCommitReceipt(persisted);
      }
      const run = await RuntimeRun.start({
        sessionId: session.id,
        workDir: session.workDir,
        store,
      });
      return run.run(() => run.commitMessageOnce(session, eventId, message));
    });
  }

  async readModelHistory(): Promise<Message[]> {
    const { materializeRuntimeHistory } = await import("./runtime-event-read-model.js");
    return materializeRuntimeHistory(await this.store.readSession(this.sessionId));
  }

  async readModelHistoryEntries(): Promise<RuntimeHistoryProjectionEntry[]> {
    const { materializeRuntimeHistoryEntries } = await import("./runtime-event-read-model.js");
    return materializeRuntimeHistoryEntries(await this.store.readSession(this.sessionId));
  }

  /** Raw model-message facts for Session/UI projection, intentionally without checkpoint replacement. */
  async readSessionProjectionEntries(): Promise<RuntimeHistoryProjectionEntry[]> {
    return projectRuntimeSessionMessageEntries(await this.store.readSession(this.sessionId));
  }

  run<Result>(execute: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
    return runtimeRunContext.run(this, () =>
      RunLedger.runInContext(this.ledger, async () => {
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
        }
      }),
    );
  }

  async recordTurnStarted(turn: number): Promise<void> {
    this.assertOpen();
    this.turnId = `turn:${this.runId}:${turn}`;
    this.stepId = `step:${this.runId}:${turn}`;
  }

  async commitMessages(session: Session, messages: readonly Message[]): Promise<void> {
    for (const message of messages) {
      await this.commitMessageOnce(session, createRuntimeEventId("message"), message);
    }
  }

  async commitMessageOnce(
    session: Session,
    eventId: string,
    message: Message,
  ): Promise<CommitReceipt> {
    this.assertSession(session);
    this.assertOpen();
    const refs = this.messageRefs(message);
    const event: RuntimeMessageCommittedEvent = {
      ...this.base(eventId),
      ...(refs ? { refs } : {}),
      kind: "message.committed",
      data: { message: structuredClone(message) },
    };
    const persisted = await this.store.append(event);
    await session.commitProjectionMessageOnce(eventId, message);
    return runtimeCommitReceipt(persisted);
  }

  /** Writes one immutable, usage-free message from a fork's frozen Session seed. */
  async recordImportedMessage(source: Message): Promise<void> {
    this.assertOpen();
    const message = stripMessageUsage(source);
    const refs = this.messageRefs(message);
    await this.store.append({
      ...this.base(createRuntimeEventId("fork-message")),
      ...(refs ? { refs } : {}),
      kind: "message.committed",
      data: { message },
    });
  }

  /** Persists a pre-runtime Session message without re-appending its in-memory projection. */
  async recordBootstrapMessage(message: Message): Promise<void> {
    this.assertOpen();
    const refs = this.messageRefs(message);
    await this.store.append({
      ...this.base(createRuntimeEventId("bootstrap-message")),
      ...(refs ? { refs } : {}),
      kind: "message.committed",
      data: { message: structuredClone(message) },
    });
  }

  /** Records an audit-only child-agent message without changing the parent model context. */
  async recordTranscriptMessage(message: Message): Promise<void> {
    this.assertOpen();
    const refs = this.messageRefs(message);
    await this.store.append({
      ...this.base(createRuntimeEventId("transcript-message"), true, "transcript"),
      ...(refs ? { refs } : {}),
      kind: "message.committed",
      data: { message: structuredClone(message) },
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
    await this.store.append(event);
  }

  registerToolEvidence(toolCallId: string, evidence: RuntimeEvidenceReference): void {
    this.evidenceByToolCallId.set(toolCallId, evidence);
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
    await this.store.append(event);
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
    await this.store.append(event);
  }

  async recordModelCallStarted(options: RuntimeModelCallStartedOptions): Promise<void> {
    this.assertOpen();
    await this.store.append({
      ...this.base(createRuntimeEventId("model-call-started"), true, "internal"),
      refs: this.refs({ providerCallId: options.providerCallId }),
      kind: "model.call.started",
      data: options,
    });
  }

  async recordModelCallSettled(options: RuntimeModelCallSettledOptions): Promise<void> {
    this.assertOpen();
    await this.store.append({
      ...this.base(createRuntimeEventId("model-call-settled"), true, "internal"),
      refs: this.refs({ providerCallId: options.providerCallId }),
      kind: "model.call.settled",
      data: options,
    });
  }

  async recordCheckpoint(options: RuntimeCheckpointOptions): Promise<void> {
    this.assertOpen();
    const event: RuntimeCheckpointRecordedEvent = {
      ...this.base(createRuntimeEventId("context-checkpoint"), true, "internal"),
      kind: "context.checkpoint.recorded",
      data: {
        checkpointId: options.checkpointId,
        coveredEventCount: options.coveredEventCount,
        sourceDigest: options.sourceDigest,
        throughEventId: options.throughEventId,
        summary: structuredClone(options.summary),
      },
    };
    await this.store.append(event);
  }

  async recordHistoryRewound(branchId: string, throughEventId?: string): Promise<void> {
    this.assertOpen();
    const event: RuntimeHistoryRewoundEvent = {
      ...this.base(createRuntimeEventId("history-rewound"), true, "internal"),
      kind: "history.rewound",
      data: { branchId, ...(throughEventId ? { throughEventId } : {}) },
    };
    await this.store.append(event);
  }

  async recordSessionForked(
    parentSessionId: string,
    throughEventId?: string,
    completion?: RuntimeForkBootstrapCompletion,
  ): Promise<void> {
    this.assertOpen();
    const event: RuntimeSessionForkedEvent = {
      ...this.base(createRuntimeEventId("session-forked"), false, "internal"),
      kind: "session.forked",
      data: {
        parentSessionId,
        ...(throughEventId ? { throughEventId } : {}),
        ...(completion ?? {}),
      },
    };
    await this.store.append(event);
  }

  async finish(status: RuntimeTerminalStatus, reason?: string): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.finishPromise = (async () => {
      const terminal = this.terminal ?? {
        ...this.base(createRuntimeEventId("run-terminal"), false, "internal"),
        kind: "run.terminal" as const,
        data: { status, ...(reason ? { reason } : {}) },
      };
      if (!this.terminal) {
        await this.store.append(terminal);
        this.terminal = terminal;
      }
      // The canonical terminal record is durable before its operational header projection.
      await this.ledger.finish(status, reason);
    })();
    return this.finishPromise;
  }

  private async recordRunStarted(): Promise<void> {
    const event: RuntimeRunStartedEvent = {
      ...this.base(createRuntimeEventId("run-started"), false, "internal"),
      kind: "run.started",
      data: { workDir: this.workDir },
    };
    await this.store.append(event);
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

  private messageRefs(message: Message): RuntimeEventRefs | undefined {
    if (!message.toolCallId) return this.refs();
    const evidence = this.evidenceByToolCallId.get(message.toolCallId);
    return this.refs({
      toolCallId: message.toolCallId,
      ...(evidence ? { evidence } : {}),
    });
  }

  private assertSession(session: Session): void {
    if (session.id !== this.sessionId) {
      throw new Error(`Runtime run ${this.runId} cannot project another session`);
    }
  }

  private assertOpen(): void {
    if (this.terminal || this.finishPromise) {
      throw new Error(`Runtime run ${this.runId} is already terminal`);
    }
  }
}

function compactRefs(value: RuntimeEventRefs): RuntimeEventRefs | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as RuntimeEventRefs) : undefined;
}

function serializeExternalMessageCommit<Result>(
  sessionId: string,
  eventId: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const key = `${sessionId}:${eventId}`;
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
  sessionId: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = forkBootstrapTails.get(sessionId) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  forkBootstrapTails.set(sessionId, tail);
  return result.finally(() => {
    if (forkBootstrapTails.get(sessionId) === tail) forkBootstrapTails.delete(sessionId);
  });
}

function stripMessageUsage(message: Message): Message {
  const { usage: _usage, ...copy } = structuredClone(message);
  return copy;
}

function forkSeedDigest(messages: readonly Message[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function isMessagePrefix(prefix: readonly Message[], messages: readonly Message[]): boolean {
  return (
    prefix.length <= messages.length &&
    prefix.every((message, index) => isDeepStrictEqual(message, messages[index]))
  );
}

async function resolveForkSourceThroughEventId(
  store: RuntimeEventStore,
  sourceSessionId: string,
  frozenMessages: readonly Message[],
): Promise<string | undefined> {
  if (!(await store.readSessionManifest(sourceSessionId))) return undefined;
  const sourceMessages = projectRuntimeSessionMessageEntries(await store.readSession(sourceSessionId));
  const normalizedSource = sourceMessages.map(({ message }) => stripMessageUsage(message));
  if (!isMessagePrefix(frozenMessages, normalizedSource)) return undefined;
  return sourceMessages[frozenMessages.length - 1]?.eventId;
}

function runtimeFailureReason(error: unknown): string {
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
