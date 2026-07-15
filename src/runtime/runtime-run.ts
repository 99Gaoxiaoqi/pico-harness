import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { isAbortError } from "../provider/errors.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { RunLedger } from "../engine/run-ledger.js";
import type { CommitReceipt } from "../engine/session-store.js";
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
import {
  RuntimeEventStore,
  createRuntimeEventId,
  type RuntimeEventStoreOptions,
} from "./runtime-event-store.js";

const runtimeRunContext = new AsyncLocalStorage<RuntimeRun>();
const runtimeToolCallContext = new AsyncLocalStorage<string>();

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
 * Coordinates one Agent invocation. Runtime events are authoritative; Session JSONL
 * and the smaller RunLedger remain durable projections for existing UI and tooling.
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
        baseDir: resolvePicoPaths(workDir).workspace.runs,
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
        baseDir: resolvePicoPaths(options.workDir).workspace.runs,
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
      new RuntimeEventStore({ baseDir: resolvePicoPaths(options.workDir).workspace.runs });
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
    await this.store.append(event);
    return session.commitProjectionMessageOnce(eventId, message);
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

  async recordCheckpoint(
    checkpointId: string,
    coveredEventCount: number,
    sourceDigest: string,
  ): Promise<void> {
    this.assertOpen();
    const event: RuntimeCheckpointRecordedEvent = {
      ...this.base(createRuntimeEventId("context-checkpoint"), true, "internal"),
      kind: "context.checkpoint.recorded",
      data: { checkpointId, coveredEventCount, sourceDigest },
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

  async recordSessionForked(parentSessionId: string, throughEventId?: string): Promise<void> {
    this.assertOpen();
    const event: RuntimeSessionForkedEvent = {
      ...this.base(createRuntimeEventId("session-forked"), false, "internal"),
      kind: "session.forked",
      data: { parentSessionId, ...(throughEventId ? { throughEventId } : {}) },
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

function runtimeFailureReason(error: unknown): string {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return detail.slice(0, 1_000);
}
