import { join } from "node:path";
import type { Message, ToolDefinition } from "../schema/message.js";
import { isMessageHiddenFromTranscript } from "../schema/message.js";
import type { LLMProvider } from "../provider/interface.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import type { RuntimeEventStoreEntry } from "../storage/runtime-event-store-contracts.js";
import { materializeRuntimeHistory } from "../engine/session-runtime-read-model.js";
import { SqliteMemoryItemStore } from "../storage/sqlite/sqlite-memory-item-store.js";
import { AtomicMemoryExtractionEngine } from "../memory/atomic/extraction-engine.js";
import { sessionMemoryLane } from "../memory/atomic/session-lane.js";
import {
  memorySessionKey,
  type AtomicMemoryResult,
  type MemoryExtractionModel,
  type MemoryExtractionSnapshot,
  type MemoryGateResult,
} from "../memory/atomic/runtime-contracts.js";
import { logger } from "../observability/logger.js";
import { ensureAtomicMemoryWorkspace } from "../memory/atomic/migration.js";

export function atomicMemoryDatabasePath(picoHome: string): string {
  return join(picoHome, "memory.sqlite");
}

/** No retries outside the engine's per-range call budget. */
export class ProviderAtomicMemoryModel implements MemoryExtractionModel {
  constructor(private readonly provider: LLMProvider) {}
  async call(request: Parameters<MemoryExtractionModel["call"]>[0]): Promise<string> {
    const prefix = request.stage === "canonicalize" ? [] : [...(request.sourceMessages ?? [])];
    const tools =
      request.stage !== "canonicalize" && this.provider.requestCapabilities?.toolChoiceNoneWithTools
        ? [...(request.sourceTools ?? [])]
        : [];
    const messages: Message[] = prefix.length
      ? [...prefix, { role: "user", content: request.prompt }]
      : [{ role: "system", content: request.prompt }];
    const response = await this.provider.generate(messages, tools, {
      ...(request.signal ? { signal: request.signal } : {}),
      timeoutMs: 60_000,
      purpose: "memory_review",
      ...(tools.length ? { toolChoice: "none" as const } : {}),
    });
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
  readonly gate: () => Promise<MemoryGateResult>;
  readonly modelFactory: () => Promise<AtomicMemoryModelLease>;
  readonly supported: boolean;
  readonly onChanged?: () => void;
}

/** One foreground run owns snapshots; background tasks own their own connections/model leases. */
export class AtomicMemoryRuntime {
  private source?: MemoryExtractionSnapshot;
  private extractRequested = false;
  private readonly background = new Set<Promise<unknown>>();
  private readonly workspaceKey: string;
  private readonly laneKey: string;

  constructor(private readonly options: AtomicMemoryRuntimeOptions) {
    this.workspaceKey = resolvePicoPaths(options.workDir, {
      picoHome: options.picoHome,
    }).workspace.id;
    this.laneKey = `${options.picoHome}:${memorySessionKey(this.workspaceKey, options.sessionId)}`;
  }

  async capture(messages: readonly Message[], tools: readonly ToolDefinition[]): Promise<void> {
    if (!this.options.supported) return;
    try {
      this.source = await this.snapshot("remember", undefined, {
        messages: structuredClone(messages),
        tools: structuredClone(tools),
      });
    } catch (error) {
      this.source = undefined;
      logger.debug({ error: String(error) }, "[Memory] source snapshot unavailable");
    }
  }

  async remember(signal?: AbortSignal): Promise<AtomicMemoryResult> {
    if (!this.options.supported || !this.source)
      return unavailable("provider_or_source_unavailable");
    const snapshot = { ...this.source, ...(signal ? { signal } : {}) };
    return sessionMemoryLane.run(this.laneKey, "foreground", () => this.execute(snapshot));
  }

  async requestExtract(): Promise<{ status: "accepted" | "unavailable" }> {
    if (!this.options.supported || !(await this.options.gate()).allowed)
      return { status: "unavailable" };
    this.extractRequested = true;
    return { status: "accepted" };
  }

  async completed(runId: string): Promise<void> {
    if (!this.extractRequested) return;
    this.extractRequested = false;
    try {
      const entries = await this.readEntries();
      const terminal = entries.find(
        ({ event }) =>
          event.kind === "run.terminal" &&
          event.runId === runId &&
          event.data.status === "completed" &&
          !event.data.recovered,
      );
      if (!terminal) return;
      const snapshot = await this.snapshot("extract", terminal.sequence);
      if (snapshot) this.enqueue(snapshot);
    } catch (error) {
      logger.warn({ error: String(error) }, "[Memory] post-terminal extraction unavailable");
    }
  }

  async checkpoint(checkpointId: string): Promise<void> {
    if (!this.options.supported) return;
    try {
      const entries = await this.readEntries();
      const checkpoint = entries.find(
        ({ event }) =>
          event.kind === "context.checkpoint.recorded" && event.data.checkpointId === checkpointId,
      );
      if (!checkpoint) return;
      const snapshot = await this.snapshot("compaction", checkpoint.sequence);
      const checkpointEvent = checkpoint.event;
      const through =
        checkpointEvent.kind === "context.checkpoint.recorded"
          ? entries.find((entry) => entry.event.eventId === checkpointEvent.data.throughEventId)
          : undefined;
      if (snapshot && through)
        this.enqueue({
          ...snapshot,
          boundaryOrdinal: through.sequence,
          boundaryEventId: through.event.eventId,
          compactionCheckpointId: checkpointId,
        });
    } catch (error) {
      logger.warn({ error: String(error) }, "[Memory] compaction extraction unavailable");
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.background]);
  }

  private enqueue(snapshot: MemoryExtractionSnapshot): void {
    const task = sessionMemoryLane.run(this.laneKey, "background", () => this.execute(snapshot));
    this.background.add(task);
    void task
      .catch((error) =>
        logger.warn({ error: String(error) }, "[Memory] background extraction unavailable"),
      )
      .finally(() => this.background.delete(task));
  }

  private async execute(snapshot: MemoryExtractionSnapshot): Promise<AtomicMemoryResult> {
    await ensureAtomicMemoryWorkspace(this.options.workDir, this.options.picoHome);
    const store = new SqliteMemoryItemStore(atomicMemoryDatabasePath(this.options.picoHome));
    let lease: AtomicMemoryModelLease | undefined;
    try {
      const gate = async (): Promise<MemoryGateResult> => {
        const upper = await this.options.gate();
        if (!upper.allowed) return upper;
        // Session deletion stops new extraction but does not remove committed memory.
        if (!(await this.sessionAvailable()))
          return { allowed: false, reason: "session_unavailable" };
        const settings = await store.readSettings(this.workspaceKey);
        return settings.enabled && (snapshot.trigger === "remember" || settings.autoExtract)
          ? { allowed: true }
          : { allowed: false, reason: "memory_disabled" };
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
      if (result.status !== "unavailable") this.options.onChanged?.();
      return result;
    } finally {
      await lease?.dispose?.();
      store.close();
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

  private async snapshot(
    trigger: MemoryExtractionSnapshot["trigger"],
    maxSequence?: number,
    source?: {
      messages: readonly Message[];
      tools: readonly ToolDefinition[];
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
        },
      ];
    });
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
    return {
      trigger,
      sessionId: memorySessionKey(this.workspaceKey, this.options.sessionId),
      workspaceKey: this.workspaceKey,
      runId: last.event.runId,
      turnId: last.event.turnId,
      boundaryOrdinal: last.sequence,
      boundaryEventId: last.event.eventId,
      events,
      checkpoints,
      sourceMessages: messages,
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
