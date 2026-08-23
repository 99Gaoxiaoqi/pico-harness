import { randomUUID } from "node:crypto";
import type {
  JsonObject,
  RuntimeActiveOverlayEntry,
  RuntimeNotification,
  RuntimeParams,
  RuntimeResult,
  RuntimeRun,
  RuntimeSessionSubscriptionFrame,
  RuntimeTranscriptAdvanceCursor,
  RuntimeTranscriptPageCursor,
  RuntimeTranscriptWatermark,
} from "./protocol.js";
import type { DesktopReporterEvent } from "./desktop-reporter.js";

const MAX_PENDING_FRAMES = 512;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const MAX_DELTA_BYTES = 8 * 1024;
const DELTA_FLUSH_MS = 80;
const MAX_OVERLAY_TEXT_BYTES = 64 * 1024;

type SubscriptionOpenResult = RuntimeResult<"session.subscription.open">;
type TranscriptPageResult = RuntimeResult<"session.transcript.page">;
type TranscriptAdvanceResult = RuntimeResult<"session.transcript.advance">;

export interface SessionSubscriptionSnapshot extends Omit<
  SubscriptionOpenResult,
  "hostEpoch" | "subscriptionId" | "nextSequence"
> {}

export interface SessionContinuityDataSource {
  readOpenSnapshot(
    params: RuntimeParams<"session.subscription.open">,
  ): Promise<SessionSubscriptionSnapshot>;
  readTranscriptPage(
    params: RuntimeParams<"session.transcript.page">,
  ): Promise<TranscriptPageResult>;
  readTranscriptAdvance(
    params: RuntimeParams<"session.transcript.advance">,
  ): Promise<TranscriptAdvanceResult>;
  readTranscriptWatermark(
    workspacePath: string,
    sessionId: string,
  ): Promise<RuntimeTranscriptWatermark>;
}

export interface SessionSubscriptionConnection {
  readonly connectionId: string;
  readonly push: (frame: RuntimeSessionSubscriptionFrame) => Promise<void>;
}

/** Stable-ID delta seam used by the persistent Active Overlay publisher. */
export interface SessionLiveDeltaInput {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly streamId: string;
  readonly kind: "text" | "thinking" | "toolOutput";
  readonly text: string;
  readonly stream?: "stdout" | "stderr";
}

interface SessionFrameBody {
  readonly type: RuntimeSessionSubscriptionFrame["type"];
  readonly [key: string]: unknown;
}

interface LiveStreamState {
  readonly runId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly streamId: string;
  readonly kind: "text" | "thinking" | "toolOutput";
  readonly stream?: "stdout" | "stderr";
  readonly anchorSequence: number;
  startOffsetBytes: number;
  endOffsetBytes: number;
  text: string;
  pendingStartOffsetBytes: number;
  pendingText: string;
  published: boolean;
  complete: boolean;
  timer?: NodeJS.Timeout;
}

interface OpenSubscriptionOptions {
  readonly connection: SessionSubscriptionConnection;
  readonly snapshot: SessionSubscriptionSnapshot;
}

/** Owns the serial live lane and all subscribers for one Session. */
class SessionSubscriptionOwner {
  readonly #subscriptions = new Map<string, SessionWireSubscription>();
  readonly #streams = new Map<string, LiveStreamState>();
  readonly #toolCallIds = new Map<string, string>();
  #lane: Promise<void> = Promise.resolve();
  #watermarkThroughSequence = 0;
  #publishedWatermark: RuntimeTranscriptWatermark | undefined;

  constructor(
    readonly workspacePath: string,
    readonly sessionId: string,
    private readonly hostEpoch: string,
  ) {}

  run<Result>(operation: () => Promise<Result> | Result): Promise<Result> {
    const result = this.#lane.then(operation, operation);
    this.#lane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  open(options: OpenSubscriptionOptions): SubscriptionOpenResult {
    const subscriptionId = randomUUID();
    const subscription = new SessionWireSubscription({
      hostEpoch: this.hostEpoch,
      subscriptionId,
      sessionId: this.sessionId,
      connectionId: options.connection.connectionId,
      push: options.connection.push,
      onTerminal: () => this.#subscriptions.delete(subscriptionId),
    });
    this.#subscriptions.set(subscriptionId, subscription);
    this.#watermarkThroughSequence = Math.max(
      this.#watermarkThroughSequence,
      options.snapshot.watermark.throughSequence,
    );
    this.#publishedWatermark = options.snapshot.watermark;
    const activeOverlay = mergeOverlayEntries(
      options.snapshot.activeOverlay,
      [...this.#streams.values()].map(projectOverlayEntry),
    );
    return {
      ...options.snapshot,
      hostEpoch: this.hostEpoch,
      subscriptionId,
      nextSequence: subscription.nextSequence,
      activeOverlay,
    };
  }

  activate(subscriptionId: string, connectionId: string): void {
    const subscription = this.#subscriptions.get(subscriptionId);
    if (subscription?.connectionId !== connectionId) return;
    subscription.activate();
  }

  close(subscriptionId: string, connectionId: string): boolean {
    const subscription = this.#subscriptions.get(subscriptionId);
    if (!subscription || subscription.connectionId !== connectionId) return false;
    this.#subscriptions.delete(subscriptionId);
    subscription.dispose();
    return true;
  }

  releaseConnection(connectionId: string): void {
    for (const [subscriptionId, subscription] of this.#subscriptions) {
      if (subscription.connectionId !== connectionId) continue;
      this.#subscriptions.delete(subscriptionId);
      subscription.dispose();
    }
  }

  shutdown(): void {
    for (const subscription of this.#subscriptions.values()) subscription.closeForHostShutdown();
    this.#subscriptions.clear();
    for (const stream of this.#streams.values()) {
      if (stream.timer) clearTimeout(stream.timer);
    }
    this.#streams.clear();
  }

  acceptReporterEvent(event: DesktopReporterEvent): void {
    if (event.type === "assistant.delta" || event.type === "assistant.reasoning.delta") {
      const text = stringField(event.payload, "delta");
      if (!text) return;
      const turn = integerField(event.payload, "turn") ?? 0;
      const thinking = event.type === "assistant.reasoning.delta";
      this.#appendDelta({
        runId: event.runId,
        turnId: turnId(event.runId, turn),
        itemId: messageItemId(turnId(event.runId, turn), thinking),
        streamId: `${thinking ? "thinking" : "assistant"}:live:${event.runId}:${turn}`,
        kind: thinking ? "thinking" : "text",
        text,
      });
      return;
    }
    if (event.type === "tool.output") {
      const text = stringField(event.payload, "chunk");
      const providerCallId = stringField(event.payload, "providerCallId");
      const toolCallId = this.#toolCallIds.get(providerCallId);
      if (!text || !providerCallId || !toolCallId) return;
      const stream = event.payload["stream"] === "stderr" ? "stderr" : "stdout";
      const turn = integerField(event.payload, "turn") ?? 0;
      this.#appendDelta({
        runId: event.runId,
        turnId: turnId(event.runId, turn),
        itemId: `tool:${toolCallId}`,
        streamId: `tool:live:${event.runId}:${toolCallId}:${stream}`,
        kind: "toolOutput",
        stream,
        text,
      });
      return;
    }
    if (event.type === "assistant.message") {
      const turn = integerField(event.payload, "turn") ?? 0;
      const streamId = `assistant:live:${event.runId}:${turn}`;
      const content = stringField(event.payload, "content");
      if (!this.#streams.has(streamId) && content) {
        this.#appendDelta({
          runId: event.runId,
          turnId: turnId(event.runId, turn),
          itemId: messageItemId(turnId(event.runId, turn), false),
          streamId,
          kind: "text",
          text: content,
        });
      }
      this.#completeStream(streamId);
      this.#completeStream(`thinking:live:${event.runId}:${turn}`);
      return;
    }
    if (event.type === "assistant.suppressed" || event.type === "run.interrupted") {
      this.#resetRunStreams(event.runId);
      return;
    }
    if (event.type === "tool.started" || event.type === "tool.completed") {
      this.#flushRunStreams(event.runId);
      if (event.type === "tool.started") {
        const providerCallId = stringField(event.payload, "providerCallId");
        const canonicalStart = event.payload["canonicalTranscriptStart"];
        const toolCallId =
          canonicalStart && typeof canonicalStart === "object" && !Array.isArray(canonicalStart)
            ? stringField(canonicalStart as Readonly<Record<string, unknown>>, "toolCallId")
            : "";
        if (providerCallId && toolCallId) this.#toolCallIds.set(providerCallId, toolCallId);
      }
      this.#publish({
        type: "subscription.tool_event",
        payload: reporterPayload(event),
      });
      return;
    }
    if (event.type === "subagent.activity") {
      this.#publish({
        type: "subscription.subagent_update",
        payload: reporterPayload(event),
      });
      return;
    }
    if (event.type === "run.finished") this.#flushRunStreams(event.runId, true);
  }

  acceptRuntimeNotification(notification: RuntimeNotification): void {
    if (
      notification.topic !== "run.started" &&
      notification.topic !== "run.updated" &&
      notification.topic !== "run.finished"
    ) {
      return;
    }
    const run = (notification.payload as { readonly run?: unknown }).run;
    if (!isRuntimeRunLike(run) || run.sessionId !== this.sessionId) return;
    this.#publish({ type: "subscription.run_state", run });
  }

  continuityDegraded(reason: "partial_persistence_failed" | "recovery_failed"): void {
    this.#publish({ type: "subscription.continuity_degraded", reason });
  }

  transcriptAdvanced(watermark: RuntimeTranscriptWatermark): void {
    const prior = this.#publishedWatermark;
    if (
      prior &&
      prior.historyEpoch === watermark.historyEpoch &&
      prior.projectorVersion === watermark.projectorVersion &&
      watermark.throughSequence <= prior.throughSequence
    ) {
      return;
    }
    this.#publishedWatermark = watermark;
    this.#watermarkThroughSequence = watermark.throughSequence;
    this.#publish({ type: "subscription.transcript_advanced", watermark });
  }

  acceptDelta(input: Omit<SessionLiveDeltaInput, "workspacePath" | "sessionId">): void {
    this.#appendDelta(input);
  }

  #appendDelta(input: {
    readonly runId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly streamId: string;
    readonly kind: "text" | "thinking" | "toolOutput";
    readonly stream?: "stdout" | "stderr";
    readonly text: string;
  }): void {
    let state = this.#streams.get(input.streamId);
    if (!state) {
      state = {
        runId: input.runId,
        turnId: input.turnId,
        itemId: input.itemId,
        streamId: input.streamId,
        kind: input.kind,
        ...(input.stream ? { stream: input.stream } : {}),
        anchorSequence: this.#watermarkThroughSequence,
        startOffsetBytes: 0,
        endOffsetBytes: 0,
        text: "",
        pendingStartOffsetBytes: 0,
        pendingText: "",
        published: false,
        complete: false,
      };
      this.#streams.set(input.streamId, state);
    }
    if (state.complete) return;
    const chunks = splitUtf8(input.text, MAX_DELTA_BYTES);
    for (const chunk of chunks) {
      const startOffsetBytes = state.endOffsetBytes;
      state.endOffsetBytes += utf8Bytes(chunk);
      state.text += chunk;
      trimOverlayText(state);
      if (!state.published) {
        state.published = true;
        this.#publishDelta(state, startOffsetBytes, chunk);
        continue;
      }
      if (!state.pendingText) state.pendingStartOffsetBytes = startOffsetBytes;
      state.pendingText += chunk;
      if (utf8Bytes(state.pendingText) >= MAX_DELTA_BYTES) this.#flushStream(state);
      else this.#scheduleFlush(state);
    }
  }

  #scheduleFlush(state: LiveStreamState): void {
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.run(() => this.#flushStream(state!));
    }, DELTA_FLUSH_MS);
    state.timer.unref?.();
  }

  #flushStream(state: LiveStreamState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (!state.pendingText) return;
    const text = state.pendingText;
    const startOffsetBytes = state.pendingStartOffsetBytes;
    state.pendingText = "";
    this.#publishDelta(state, startOffsetBytes, text);
  }

  #publishDelta(
    state: LiveStreamState,
    startOffsetBytes: number,
    text: string,
    flags: { readonly complete?: true; readonly reset?: true } = {},
  ): void {
    this.#publish({
      type: "subscription.session_delta",
      runId: state.runId,
      turnId: state.turnId,
      itemId: state.itemId,
      streamId: state.streamId,
      kind: state.kind,
      startOffsetBytes,
      text,
      ...(state.stream ? { stream: state.stream } : {}),
      ...flags,
    });
  }

  #completeStream(streamId: string): void {
    const state = this.#streams.get(streamId);
    if (!state || state.complete) return;
    this.#flushStream(state);
    state.complete = true;
    this.#publishDelta(state, state.endOffsetBytes, "", { complete: true });
  }

  #flushRunStreams(runId: string, complete = false): void {
    for (const state of this.#streams.values()) {
      if (state.runId !== runId) continue;
      this.#flushStream(state);
      if (complete && !state.complete) {
        state.complete = true;
        this.#publishDelta(state, state.endOffsetBytes, "", { complete: true });
      }
    }
  }

  #resetRunStreams(runId: string): void {
    for (const [streamId, state] of [...this.#streams]) {
      if (state.runId !== runId) continue;
      this.#flushStream(state);
      this.#publishDelta(state, state.endOffsetBytes, "", { reset: true });
      if (state.timer) clearTimeout(state.timer);
      this.#streams.delete(streamId);
    }
  }

  #publish(body: SessionFrameBody): void {
    for (const subscription of this.#subscriptions.values()) subscription.enqueue(body);
  }
}

interface SessionWireSubscriptionOptions {
  readonly hostEpoch: string;
  readonly subscriptionId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly push: (frame: RuntimeSessionSubscriptionFrame) => Promise<void>;
  readonly onTerminal: () => void;
}

class SessionWireSubscription {
  readonly connectionId: string;
  readonly #options: SessionWireSubscriptionOptions;
  readonly #pending: Array<{ frame: RuntimeSessionSubscriptionFrame; bytes: number }> = [];
  #pendingBytes = 0;
  #nextSequence = 1;
  #active = false;
  #accepting = true;
  #pumping = false;

  constructor(options: SessionWireSubscriptionOptions) {
    this.#options = options;
    this.connectionId = options.connectionId;
  }

  get nextSequence(): number {
    return this.#nextSequence;
  }

  activate(): void {
    if (this.#active) return;
    this.#active = true;
    this.#pump();
  }

  enqueue(body: SessionFrameBody): void {
    if (!this.#accepting) return;
    const frame = this.#frame(body);
    const bytes = utf8Bytes(JSON.stringify(frame));
    this.#pending.push({ frame, bytes });
    this.#pendingBytes += bytes;
    if (this.#pending.length > MAX_PENDING_FRAMES || this.#pendingBytes > MAX_PENDING_BYTES) {
      this.#closeSlowConsumer();
      return;
    }
    this.#pump();
  }

  dispose(): void {
    this.#accepting = false;
    this.#pending.length = 0;
    this.#pendingBytes = 0;
  }

  closeForHostShutdown(): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    this.#pending.length = 0;
    this.#pendingBytes = 0;
    this.#enqueueTerminal("host_shutdown");
    this.activate();
  }

  #closeSlowConsumer(): void {
    this.#accepting = false;
    this.#pending.length = 0;
    this.#pendingBytes = 0;
    this.#enqueueTerminal("slow_consumer");
    this.#pump();
  }

  #enqueueTerminal(reason: "slow_consumer" | "host_shutdown"): void {
    const frame = this.#frame({ type: "subscription.closed", reason });
    const bytes = utf8Bytes(JSON.stringify(frame));
    this.#pending.push({ frame, bytes });
    this.#pendingBytes = bytes;
  }

  #frame(body: SessionFrameBody): RuntimeSessionSubscriptionFrame {
    return {
      hostEpoch: this.#options.hostEpoch,
      subscriptionId: this.#options.subscriptionId,
      sequence: this.#nextSequence++,
      sessionId: this.#options.sessionId,
      ...body,
    } as RuntimeSessionSubscriptionFrame;
  }

  #pump(): void {
    if (!this.#active || this.#pumping) return;
    this.#pumping = true;
    void (async () => {
      try {
        while (this.#active) {
          const pending = this.#pending.shift();
          if (!pending) return;
          this.#pendingBytes -= pending.bytes;
          await this.#options.push(pending.frame);
          if (pending.frame.type === "subscription.closed") {
            this.#options.onTerminal();
            return;
          }
        }
      } catch {
        this.dispose();
        this.#options.onTerminal();
      } finally {
        this.#pumping = false;
        if (this.#active && this.#pending.length > 0) this.#pump();
      }
    })();
  }
}

export class SessionSubscriptionRegistry {
  readonly #owners = new Map<string, SessionSubscriptionOwner>();
  #closed = false;

  constructor(
    readonly hostEpoch: string,
    private readonly dataSource: SessionContinuityDataSource,
  ) {}

  async open(
    params: RuntimeParams<"session.subscription.open">,
    connection: SessionSubscriptionConnection,
  ): Promise<SubscriptionOpenResult> {
    if (this.#closed) throw new Error("Session subscription registry is closed");
    const owner = this.#owner(params.workspacePath, params.sessionId);
    return owner.run(async () => {
      const snapshot = await this.dataSource.readOpenSnapshot(params);
      return owner.open({ connection, snapshot });
    });
  }

  activate(
    workspacePath: string,
    sessionId: string,
    subscriptionId: string,
    connectionId: string,
  ): void {
    void this.#owners
      .get(ownerKey(workspacePath, sessionId))
      ?.run(() =>
        this.#owners
          .get(ownerKey(workspacePath, sessionId))
          ?.activate(subscriptionId, connectionId),
      );
  }

  async close(
    params: RuntimeParams<"session.subscription.close">,
    connectionId: string,
  ): Promise<RuntimeResult<"session.subscription.close">> {
    const owner = this.#owners.get(ownerKey(params.workspacePath, params.sessionId));
    if (owner) await owner.run(() => owner.close(params.subscriptionId, connectionId));
    return { closed: true };
  }

  readTranscriptPage(
    params: RuntimeParams<"session.transcript.page">,
  ): Promise<TranscriptPageResult> {
    return this.dataSource.readTranscriptPage(params);
  }

  readTranscriptAdvance(
    params: RuntimeParams<"session.transcript.advance">,
  ): Promise<TranscriptAdvanceResult> {
    return this.dataSource.readTranscriptAdvance(params);
  }

  publishReporterEvent(workspacePath: string, event: DesktopReporterEvent): void {
    if (this.#closed) return;
    if (!event.sessionId) return;
    const owner = this.#owner(workspacePath, event.sessionId);
    void owner.run(() => owner.acceptReporterEvent(event));
  }

  publishSessionDelta(input: SessionLiveDeltaInput): void {
    if (this.#closed) return;
    const owner = this.#owner(input.workspacePath, input.sessionId);
    void owner.run(() =>
      owner.acceptDelta({
        runId: input.runId,
        turnId: input.turnId,
        itemId: input.itemId,
        streamId: input.streamId,
        kind: input.kind,
        text: input.text,
        ...(input.stream ? { stream: input.stream } : {}),
      }),
    );
  }

  publishRuntimeNotification(notification: RuntimeNotification): void {
    if (this.#closed) return;
    const sessionId = notification.scope.sessionId;
    if (!sessionId) return;
    const owner = this.#owners.get(ownerKey(notification.scope.workspacePath, sessionId));
    if (!owner) return;
    void owner.run(() => owner.acceptRuntimeNotification(notification));
  }

  publishContinuityDegraded(
    workspacePath: string,
    sessionId: string,
    reason: "partial_persistence_failed" | "recovery_failed",
  ): void {
    const owner = this.#owner(workspacePath, sessionId);
    void owner.run(() => owner.continuityDegraded(reason));
  }

  publishTranscriptAdvanced(workspacePath: string, sessionId: string): void {
    if (this.#closed) return;
    const owner = this.#owner(workspacePath, sessionId);
    void owner.run(async () => {
      const watermark = await this.dataSource.readTranscriptWatermark(workspacePath, sessionId);
      owner.transcriptAdvanced(watermark);
    });
  }

  releaseConnection(connectionId: string): void {
    for (const owner of this.#owners.values()) {
      void owner.run(() => owner.releaseConnection(connectionId));
    }
  }

  shutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const owner of this.#owners.values()) void owner.run(() => owner.shutdown());
    this.#owners.clear();
  }

  #owner(workspacePath: string, sessionId: string): SessionSubscriptionOwner {
    const key = ownerKey(workspacePath, sessionId);
    let owner = this.#owners.get(key);
    if (!owner) {
      owner = new SessionSubscriptionOwner(workspacePath, sessionId, this.hostEpoch);
      this.#owners.set(key, owner);
    }
    return owner;
  }
}

function ownerKey(workspacePath: string, sessionId: string): string {
  return `${workspacePath}\0${sessionId}`;
}

function projectOverlayEntry(state: LiveStreamState): RuntimeActiveOverlayEntry {
  return {
    runId: state.runId,
    turnId: state.turnId,
    itemId: state.itemId,
    streamId: state.streamId,
    kind: state.kind,
    startOffsetBytes: state.startOffsetBytes,
    endOffsetBytes: state.endOffsetBytes,
    text: state.text,
    anchorSequence: state.anchorSequence,
    ...(state.stream ? { stream: state.stream } : {}),
    ...(state.startOffsetBytes > 0 ? { truncatedBeforeBytes: state.startOffsetBytes } : {}),
    ...(state.complete ? { complete: true } : {}),
  };
}

function mergeOverlayEntries(
  persisted: readonly RuntimeActiveOverlayEntry[],
  live: readonly RuntimeActiveOverlayEntry[],
): RuntimeActiveOverlayEntry[] {
  const merged = new Map(persisted.map((entry) => [entry.streamId, entry]));
  for (const entry of live) merged.set(entry.streamId, entry);
  return [...merged.values()];
}

function trimOverlayText(state: LiveStreamState): void {
  const bytes = Buffer.from(state.text, "utf8");
  if (bytes.byteLength <= MAX_OVERLAY_TEXT_BYTES) return;
  const suffix = bytes.subarray(bytes.byteLength - MAX_OVERLAY_TEXT_BYTES).toString("utf8");
  const suffixBytes = utf8Bytes(suffix);
  state.text = suffix;
  state.startOffsetBytes = state.endOffsetBytes - suffixBytes;
}

function splitUtf8(text: string, maxBytes: number): string[] {
  if (utf8Bytes(text) <= maxBytes) return [text];
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of text) {
    const characterBytes = utf8Bytes(character);
    if (current && bytes + characterBytes > maxBytes) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += characterBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function integerField(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function turnId(runId: string, turn: number): string {
  return `turn:${runId}:${turn}`;
}

function messageItemId(stableTurnId: string, thinking: boolean): string {
  return `message:${stableTurnId}:${thinking ? "thinking" : "assistant"}`;
}

function reporterPayload(event: DesktopReporterEvent): JsonObject {
  return {
    runId: event.runId,
    type: event.type,
    at: event.at,
    payload: event.payload as JsonObject,
  };
}

function isRuntimeRunLike(value: unknown): value is RuntimeRun {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { runId?: unknown }).runId === "string" &&
    typeof (value as { sessionId?: unknown }).sessionId === "string"
  );
}

export type {
  RuntimeTranscriptAdvanceCursor,
  RuntimeTranscriptPageCursor,
  RuntimeTranscriptWatermark,
};
