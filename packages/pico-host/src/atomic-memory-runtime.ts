import { AtomicMemoryLifecycle } from "@pico/runtime";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { withProviderCallContext } from "@pico/runtime";
import type { Message, ToolDefinition, RuntimeMemoryExtractionBoundary } from "@pico/core";
import { RUNTIME_MESSAGE_EVENT_ID, isMessageHiddenFromTranscript } from "@pico/core";
import type { LLMProvider } from "@pico/core";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import type { RuntimeEventStoreEntry } from "@pico/storage/runtime-event-store-contracts";
import { materializeRuntimeHistory } from "@pico/runtime/session-runtime-read-model";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { AtomicMemoryExtractionEngine } from "@pico/runtime/atomic-memory/extraction-engine";
import { buildMemoryRequestMessages } from "@pico/runtime/atomic-memory/extraction-budget";
import { sessionMemoryLane } from "@pico/runtime/atomic-memory/session-lane";
import {
  memorySessionKey,
  type AtomicMemoryResult,
  type MemoryExtractionModel,
  type MemoryExtractionSnapshot,
  type MemoryGateResult,
} from "@pico/core/atomic-memory-runtime-contracts";
import { logger } from "@pico/pico-host/logger";
import { MemoryItemStoreConflictError } from "@pico/core/atomic-memory-contracts";
import { resolveRequestedReferenceNote } from "./atomic-memory-reference-note.js";

export function atomicMemoryDatabasePath(picoHome: string): string {
  return join(picoHome, "memory.sqlite");
}

/** Admission reads fail closed without turning an ordinary conversation into a memory error. */
export async function captureAtomicMemoryAdmission(options: {
  workDir: string;
  picoHome: string;
  supported: boolean;
  gate: () => Promise<MemoryGateResult>;
}): Promise<RuntimeMemoryExtractionBoundary> {
  if (!options.supported) return { disposition: "policy_denied" };
  let store: SqliteMemoryItemStore | undefined;
  try {
    store = new SqliteMemoryItemStore(atomicMemoryDatabasePath(options.picoHome));
    const workspaceKey = resolvePicoPaths(options.workDir, { picoHome: options.picoHome }).workspace
      .id;
    const settings = await store.readSettings(workspaceKey);
    return {
      disposition:
        settings.enabled && settings.autoExtract && (await options.gate()).allowed
          ? "eligible"
          : "policy_denied",
      deletionRevision: await store.readDeletionRevision(),
      settingsVersion: settings.version,
    };
  } catch (error) {
    logger.debug({ error: String(error) }, "[Memory] automatic admission unavailable");
    return { disposition: "policy_denied" };
  } finally {
    try {
      store?.close();
    } catch (error) {
      logger.debug({ error: String(error) }, "[Memory] admission cleanup unavailable");
    }
  }
}

/** No retries outside the engine's per-range call budget. */
export class ProviderAtomicMemoryModel implements MemoryExtractionModel {
  constructor(private readonly provider: LLMProvider) {}
  async call(request: Parameters<MemoryExtractionModel["call"]>[0]): Promise<string> {
    const tools =
      request.stage !== "canonicalize" && this.provider.requestCapabilities?.toolChoiceNoneWithTools
        ? [...(request.sourceTools ?? [])]
        : [];
    const messages = buildMemoryRequestMessages(request, request.prompt, request.stage);
    const response = await withProviderCallContext({ purpose: "memory_review" }, () =>
      this.provider.generate(messages, tools, {
        ...(request.signal ? { signal: request.signal } : {}),
        timeoutMs: 60_000,
        ...(tools.length ? { toolChoice: "none" as const } : {}),
      }),
    );
    if (response.toolCalls?.length) throw new Error("memory_model_returned_tools");
    return response.content;
  }
}

export interface AtomicMemoryModelLease {
  readonly model: MemoryExtractionModel;
  dispose?(): void | Promise<void>;
}
export interface AtomicMemoryRuntimeOptions {
  readonly workDir: string;
  readonly picoHome: string;
  readonly sessionId: string;
  readonly gate: (trigger?: MemoryExtractionSnapshot["trigger"]) => Promise<MemoryGateResult>;
  readonly modelFactory: () => Promise<AtomicMemoryModelLease>;
  readonly supported: boolean;
  readonly preserveSourceTools?: boolean;
  readonly contextWindowTokens?: number;
  readonly reservedOutputTokens?: number;
  readonly lifecycle?: AtomicMemoryLifecycle;
  readonly onChanged?: () => void;
}

/** One foreground run owns snapshots; background tasks own their own connections/model leases. */
export class AtomicMemoryRuntime {
  private source: MemoryExtractionSnapshot | undefined;
  private extractRequestedRevision: number | undefined;
  private readonly completedRuns = new Set<string>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly workspaceKey: string;
  private readonly laneKey: string;
  private readonly lifecycle: AtomicMemoryLifecycle;

  constructor(private readonly options: AtomicMemoryRuntimeOptions) {
    this.lifecycle = options.lifecycle ?? new AtomicMemoryLifecycle();
    this.workspaceKey = resolvePicoPaths(options.workDir, {
      picoHome: options.picoHome,
    }).workspace.id;
    this.laneKey = `${options.picoHome}:${memorySessionKey(this.workspaceKey, options.sessionId)}`;
  }

  async capture(messages: readonly Message[], tools: readonly ToolDefinition[]): Promise<void> {
    if (!this.options.supported) return;
    try {
      this.source = await this.snapshot("remember", await this.readDeletionRevision(), undefined, {
        messages: structuredClone(messages),
        tools: this.options.preserveSourceTools === false ? [] : structuredClone(tools),
        positions: messageEventPositions(messages),
      });
    } catch (error) {
      this.source = undefined;
      logger.debug({ error: String(error) }, "[Memory] source snapshot unavailable");
    }
  }

  async remember(signal?: AbortSignal): Promise<AtomicMemoryResult> {
    if (!this.options.supported) return unavailable("provider_unsupported");
    if (!this.source) return unavailable("source_unavailable");
    const snapshot = { ...this.source, ...(signal ? { signal } : {}) };
    return this.lifecycle.run(
      "remember",
      () => sessionMemoryLane.run(this.laneKey, "foreground", () => this.rememberFrozen(snapshot)),
      () => unavailable("draining"),
    );
  }

  private async rememberFrozen(snapshot: MemoryExtractionSnapshot): Promise<AtomicMemoryResult> {
    let store: SqliteMemoryItemStore | undefined;
    try {
      const entries = await this.readEntries();
      const completedRunIds = new Set(
        entries.flatMap(({ event }) =>
          event.kind === "run.terminal" &&
          event.data.status === "completed" &&
          !event.data.recovered
            ? [event.runId]
            : [],
        ),
      );
      const lastUser = snapshot.events.findLast((event) => event.role === "user");
      const started = entries.find(
        ({ event }) => event.kind === "run.started" && event.runId === snapshot.runId,
      );
      const prior =
        started &&
        entries.findLast(
          ({ event, sequence }) => event.kind === "run.terminal" && sequence < started.sequence,
        );
      const wrapperInput =
        lastUser &&
        prior?.event.runId === lastUser.runId &&
        prior.event.kind === "run.terminal" &&
        prior.event.data.status === "completed" &&
        !prior.event.data.recovered &&
        isDesktopInputWrapper(entries.filter(({ event }) => event.runId === lastUser.runId));
      const reference = resolveRequestedReferenceNote(snapshot, {
        completedRunIds,
        // Tool discovery/retries can start another Turn within the same Run.
        // The latest real User input still owns that Run's explicit request.
        ...(lastUser && (lastUser.runId === snapshot.runId || wrapperInput)
          ? { authorizationEventId: lastUser.eventId }
          : {}),
      });
      if (reference.status === "not_requested") return this.execute(snapshot);
      if (reference.status === "unresolved") return unavailable(reference.reason);
      if (snapshot.signal?.aborted) return unavailable("aborted");
      const gate = await this.options.gate("remember");
      if (!gate.allowed) return unavailable(gate.reason);
      if (this.lifecycle.isDraining) return unavailable("draining");
      if (!(await this.sessionAvailable())) return unavailable("session_unavailable");
      store = new SqliteMemoryItemStore(atomicMemoryDatabasePath(this.options.picoHome));
      if (!(await store.readSettings(this.workspaceKey)).enabled)
        return unavailable("memory_disabled");
      if (snapshot.signal?.aborted) return unavailable("aborted");
      const operationId = `memory_reference_${createHash("sha256")
        .update(
          JSON.stringify([
            snapshot.sessionId,
            reference.authorizationEventId,
            reference.targetEventId,
          ]),
        )
        .digest("hex")}`;
      const result = await store.applyMutations({
        operationId,
        expectedDeletionRevision: snapshot.deletionRevision,
        mutations: reference.items.map((item) => ({ type: "create", item })),
      });
      const records = await Promise.all(
        result.results.map(({ itemId }) => store!.readItem(itemId)),
      );
      const requestedItems = records.flatMap((record) =>
        record?.item.lifecycleState === "active"
          ? [{ itemId: record.item.itemId, content: record.item.content }]
          : [],
      );
      if (requestedItems.length) this.options.onChanged?.();
      return {
        operationId,
        sessionId: snapshot.sessionId,
        status: requestedItems.length ? "remembered" : "not_applicable",
        requestedItems,
        committedAt: result.committedAt,
      };
    } catch (error) {
      if (error instanceof MemoryItemStoreConflictError && error.reason === "deletion_conflict")
        return unavailable("memory_deleted");
      logger.debug({ error: String(error) }, "[Memory] reference note unavailable");
      return unavailable("unavailable");
    } finally {
      store?.close();
    }
  }

  async requestExtract(): Promise<{ status: "accepted" | "unavailable"; reason?: string }> {
    if (!this.options.supported) return { status: "unavailable", reason: "provider_unsupported" };
    const deletionRevision = await this.readDeletionRevision();
    const gate = await this.options.gate("extract");
    if (!gate.allowed) return { status: "unavailable", reason: gate.reason };
    if (this.lifecycle.isDraining) return { status: "unavailable", reason: "draining" };
    const store = new SqliteMemoryItemStore(atomicMemoryDatabasePath(this.options.picoHome));
    try {
      const settings = await store.readSettings(this.workspaceKey);
      if (!settings.enabled || !settings.autoExtract)
        return { status: "unavailable", reason: "memory_disabled" };
    } finally {
      store.close();
    }
    this.extractRequestedRevision = deletionRevision;
    return { status: "accepted" };
  }

  async completed(runId: string): Promise<void> {
    if (!this.options.supported || this.completedRuns.has(runId)) return;
    this.completedRuns.add(runId);
    const requestedRevision = this.extractRequestedRevision;
    this.extractRequestedRevision = undefined;
    this.enqueue("extract", async () => {
      const entries = await this.readEntries();
      const terminal = entries.find(
        ({ event }) =>
          event.kind === "run.terminal" &&
          event.runId === runId &&
          event.data.status === "completed" &&
          !event.data.recovered,
      );
      if (!terminal || terminal.event.kind !== "run.terminal") return;
      const admission = terminal.event.data.memoryExtractionBoundary;
      if (!admission && requestedRevision === undefined) return;
      const revision = requestedRevision ?? admission?.deletionRevision;
      if (revision === undefined) return;
      return this.snapshot("extract", revision, terminal.sequence);
    });
  }

  async compactionDisposition(): Promise<"eligible" | "policy_denied" | undefined> {
    if (!this.options.supported) return undefined;
    const store = new SqliteMemoryItemStore(atomicMemoryDatabasePath(this.options.picoHome));
    try {
      const settings = await store.readSettings(this.workspaceKey);
      if (!settings.enabled || !settings.autoExtract) return "policy_denied";
      const gate = await this.options.gate("compaction");
      if (
        !gate.allowed &&
        !["unavailable", "draining", "configuration", "aborted"].includes(gate.reason)
      )
        return "policy_denied";
      return "eligible";
    } finally {
      store.close();
    }
  }

  async checkpoint(checkpointId: string): Promise<void> {
    if (!this.options.supported) return;
    const deletionRevision = await this.readDeletionRevision();
    this.enqueue("compaction", async () => {
      const entries = await this.readEntries();
      const checkpoint = entries.find(
        ({ event }) =>
          event.kind === "context.checkpoint.recorded" && event.data.checkpointId === checkpointId,
      );
      if (
        !checkpoint ||
        checkpoint.event.kind !== "context.checkpoint.recorded" ||
        !checkpoint.event.data.memoryExtractionBoundary
      )
        return;
      const snapshot = await this.snapshot("compaction", deletionRevision, checkpoint.sequence);
      const checkpointEvent = checkpoint.event;
      const through =
        checkpointEvent.kind === "context.checkpoint.recorded"
          ? entries.find((entry) => entry.event.eventId === checkpointEvent.data.throughEventId)
          : undefined;
      if (snapshot && through)
        return {
          ...snapshot,
          boundaryOrdinal: through.sequence,
          boundaryEventId: through.event.eventId,
          compactionCheckpointId: checkpointId,
        };
      return undefined;
    });
  }

  async drain(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  private enqueue(
    trigger: "extract" | "compaction",
    prepare: () => Promise<MemoryExtractionSnapshot | undefined>,
  ): void {
    const task = this.lifecycle.run(
      trigger,
      async () => {
        const snapshot = await prepare();
        if (snapshot)
          await sessionMemoryLane.run(this.laneKey, "background", () => this.execute(snapshot));
      },
      () => undefined,
    );
    this.background.add(task);
    void task
      .catch((error) =>
        logger.warn({ error: String(error) }, "[Memory] background extraction unavailable"),
      )
      .finally(() => this.background.delete(task));
  }

  private async execute(snapshot: MemoryExtractionSnapshot): Promise<AtomicMemoryResult> {
    const store = new SqliteMemoryItemStore(atomicMemoryDatabasePath(this.options.picoHome));
    let lease: AtomicMemoryModelLease | undefined;
    try {
      const gate = async (
        trigger: MemoryExtractionSnapshot["trigger"],
      ): Promise<MemoryGateResult> => {
        const upper = await this.options.gate(trigger);
        if (!upper.allowed) return upper;
        // Session deletion stops new extraction but does not remove committed memory.
        if (!(await this.sessionAvailable()))
          return { allowed: false, reason: "session_unavailable" };
        const settings = await store.readSettings(this.workspaceKey);
        if (!settings.enabled || (trigger !== "remember" && !settings.autoExtract))
          return { allowed: false, reason: "memory_disabled" };
        if (
          trigger !== "remember" &&
          snapshot.settingsVersion !== undefined &&
          snapshot.settingsVersion !== settings.version
        )
          return { allowed: false, reason: "memory_disabled" };
        return this.lifecycle.isDraining
          ? { allowed: false, reason: "draining" }
          : { allowed: true };
      };
      const model: MemoryExtractionModel = {
        call: async (request) => {
          lease ??= await this.options.modelFactory();
          return lease.model.call(request);
        },
      };
      const result = await new AtomicMemoryExtractionEngine({ store, model, gate }).execute(
        snapshot,
      );
      if (result.status === "unavailable" && result.reason === "retry_later") {
        const pending = await store.readPendingExtractionFailure(snapshot.sessionId);
        if (pending)
          return unavailable(
            pending.firstFailureClass === "provider"
              ? "provider_review_failed"
              : pending.firstFailureClass === "evidence"
                ? "evidence_rejected"
                : "invalid_memory_response",
          );
      }
      if (result.status !== "unavailable") this.options.onChanged?.();
      return result;
    } finally {
      try {
        await lease?.dispose?.();
      } finally {
        store.close();
      }
    }
  }

  private async sessionAvailable(): Promise<boolean> {
    const paths = resolvePicoPaths(this.options.workDir, { picoHome: this.options.picoHome });
    const store = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
    try {
      const entry = await store.findSessionCatalogEntry(this.options.sessionId);
      return !!entry && !entry.isArchived;
    } finally {
      store.close();
    }
  }

  private async readEntries(): Promise<readonly RuntimeEventStoreEntry[]> {
    const paths = resolvePicoPaths(this.options.workDir, { picoHome: this.options.picoHome });
    const store = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
    try {
      return await store.readSessionEntries(this.options.sessionId);
    } finally {
      store.close();
    }
  }

  private async readDeletionRevision(): Promise<number> {
    const store = new SqliteMemoryItemStore(atomicMemoryDatabasePath(this.options.picoHome));
    try {
      return await store.readDeletionRevision();
    } finally {
      store.close();
    }
  }

  private async snapshot(
    trigger: MemoryExtractionSnapshot["trigger"],
    deletionRevision: number,
    maxSequence?: number,
    source?: {
      messages: readonly Message[];
      tools: readonly ToolDefinition[];
      positions: Readonly<Record<string, readonly number[]>>;
    },
  ): Promise<MemoryExtractionSnapshot | undefined> {
    const all = await this.readEntries();
    const entries = all.filter(
      (entry) => maxSequence === undefined || entry.sequence <= maxSequence,
    );
    const last = entries.at(-1);
    if (!last) return undefined;
    // Verify checkpoint digests using the same canonical read model as the main agent.
    materializeRuntimeHistory(entries.map((entry) => entry.event));
    const events = entries.map(({ event, sequence }) => {
      const message =
        event.kind === "message.committed" && event.visibility === "model" && !event.partial
          ? event.data.message
          : undefined;
      const visible = message && !isMessageHiddenFromTranscript(message) && !message.toolCallId;
      const user =
        visible &&
        message.role === "user" &&
        (message.providerData?.["picoKind"] === undefined ||
          message.providerData?.["picoKind"] === "desktop_user_input");
      return {
        ordinal: sequence,
        eventId: event.eventId,
        runId: event.runId,
        turnId: event.turnId,
        observedAt: Date.parse(event.at),
        role: user
          ? ("user" as const)
          : visible && message.role === "assistant"
            ? ("assistant" as const)
            : ("other" as const),
        text: visible ? message.content : "",
      };
    });
    const checkpoints = entries.flatMap(({ event, sequence }) => {
      if (event.kind !== "context.checkpoint.recorded") return [];
      const through = entries.find((entry) => entry.event.eventId === event.data.throughEventId);
      if (!through) throw new Error("memory_checkpoint_boundary_missing");
      return [
        {
          checkpointId: event.data.checkpointId,
          ordinal: sequence,
          throughOrdinal: through.sequence,
          ...(event.data.memoryExtractionBoundary
            ? { disposition: event.data.memoryExtractionBoundary.disposition }
            : { bootstrap: true }),
        },
      ];
    });
    const completedBoundaries = entries.flatMap(({ event, sequence }) => {
      if (event.kind !== "run.terminal") return [];
      const admission = event.data.memoryExtractionBoundary;
      // Desktop input commits can use a small synthetic Run before the actual
      // AgentRuntime resumes. Its user message belongs to that following admission,
      // so this input-only wrapper must not become a legacy policy barrier.
      if (!admission && event.data.status === "completed" && !event.data.recovered) {
        if (isDesktopInputWrapper(entries.filter((entry) => entry.event.runId === event.runId)))
          return [];
      }
      return [
        {
          ordinal: sequence,
          disposition:
            event.data.status === "completed" && !event.data.recovered && admission
              ? admission.disposition
              : ("policy_denied" as const),
          ...(admission?.deletionRevision !== undefined
            ? { deletionRevision: admission.deletionRevision }
            : {}),
          ...(admission?.settingsVersion !== undefined
            ? { settingsVersion: admission.settingsVersion }
            : {}),
        },
      ];
    });
    let settingsVersion: number;
    const settingsStore = new SqliteMemoryItemStore(
      atomicMemoryDatabasePath(this.options.picoHome),
    );
    try {
      settingsVersion = (await settingsStore.readSettings(this.workspaceKey)).version;
    } finally {
      settingsStore.close();
    }
    const messages =
      source?.messages ??
      (trigger === "extract" && this.source?.sourceMessages
        ? [
            ...this.source.sourceMessages,
            ...events
              .filter((e) => e.ordinal > this.source!.boundaryOrdinal && e.role === "assistant")
              .map((e) => ({ role: "assistant" as const, content: e.text })),
          ]
        : events
            .filter((e) => e.role !== "other")
            .map((e) => ({ role: e.role as "user" | "assistant", content: e.text })));
    const sourceEventMessagePositions =
      source?.positions ??
      (trigger === "extract" && this.source?.sourceMessages
        ? this.source.sourceEventMessagePositions
        : Object.fromEntries(
            events
              .filter((event) => event.role !== "other")
              .map((event, index) => [event.eventId, [index]]),
          ));
    return {
      trigger,
      deletionRevision,
      sessionId: memorySessionKey(this.workspaceKey, this.options.sessionId),
      workspaceKey: this.workspaceKey,
      runId: last.event.runId,
      turnId: last.event.turnId,
      boundaryOrdinal: last.sequence,
      boundaryEventId: last.event.eventId,
      events,
      checkpoints,
      completedBoundaries,
      settingsVersion,
      sourceMessages: messages,
      ...(sourceEventMessagePositions !== undefined ? { sourceEventMessagePositions } : {}),
      ...(this.options.contextWindowTokens !== undefined
        ? { contextWindowTokens: this.options.contextWindowTokens }
        : {}),
      ...(this.options.reservedOutputTokens !== undefined
        ? { reservedOutputTokens: this.options.reservedOutputTokens }
        : {}),
      ...(source?.tools
        ? { sourceTools: source.tools }
        : this.source?.sourceTools
          ? { sourceTools: this.source.sourceTools }
          : {}),
    };
  }
}

function unavailable(reason: string): AtomicMemoryResult {
  return { status: "unavailable", reason, requestedItems: [] };
}

function isDesktopInputWrapper(entries: readonly RuntimeEventStoreEntry[]): boolean {
  const desktopInput = ({ event }: RuntimeEventStoreEntry): boolean =>
    event.kind === "message.committed" &&
    event.data.message.role === "user" &&
    event.data.message.providerData?.["picoKind"] === "desktop_user_input";
  return (
    entries.some(desktopInput) &&
    entries.every(
      (entry) =>
        entry.event.kind === "run.started" ||
        entry.event.kind === "run.terminal" ||
        desktopInput(entry),
    )
  );
}

function messageEventPositions(messages: readonly Message[]): Record<string, number[]> {
  const positions: Record<string, number[]> = {};
  messages.forEach((message, index) => {
    const eventId = message[RUNTIME_MESSAGE_EVENT_ID];
    if (eventId) (positions[eventId] ??= []).push(index);
  });
  return positions;
}
