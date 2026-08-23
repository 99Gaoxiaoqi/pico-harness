import type { RuntimeActiveOverlayEntry } from "./protocol.js";

export const ACTIVE_OVERLAY_FLUSH_INTERVAL_MS = 80;
export const ACTIVE_OVERLAY_FLUSH_BYTES = 8 * 1024;
export const ACTIVE_OVERLAY_RUN_MAX_BYTES = 16 * 1024 * 1024;

export type ActiveOverlayKind = RuntimeActiveOverlayEntry["kind"];

export interface ActiveOverlayAppendInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly streamId: string;
  readonly kind: ActiveOverlayKind;
  readonly text: string;
  readonly anchorSequence: number;
  readonly stream?: "stdout" | "stderr";
}

export interface ActiveOverlayPersistInput {
  readonly partialId: string;
  readonly kind: "assistant_text" | "thinking" | "tool_output";
  readonly expectedVersion: number;
  readonly payload: ActiveOverlayPayload;
}

export interface ActiveOverlayPayload {
  readonly version: 1;
  readonly runId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly streamId: string;
  readonly kind: ActiveOverlayKind;
  readonly anchorSequence: number;
  readonly startOffsetBytes: number;
  readonly endOffsetBytes: number;
  readonly truncatedBeforeBytes: number;
  readonly text: string;
  readonly stream?: "stdout" | "stderr";
  readonly complete?: true;
}

export interface ActiveOverlayPersistence {
  upsert(input: ActiveOverlayPersistInput): Promise<{ readonly version: number }>;
}

export interface ActiveOverlayLiveDelta {
  readonly type: "subscription.session_delta";
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly streamId: string;
  readonly kind: ActiveOverlayKind;
  readonly startOffsetBytes: number;
  readonly text: string;
  readonly stream?: "stdout" | "stderr";
}

export interface ActiveOverlayPublisher {
  publishDelta(delta: ActiveOverlayLiveDelta): void;
  publishContinuityDegraded(reason: "partial_persistence_failed"): void;
}

interface ActiveStreamState {
  readonly input: Omit<ActiveOverlayAppendInput, "text">;
  readonly partialId: string;
  version: number;
  text: string;
  pendingBytes: number;
  endOffsetBytes: number;
  truncatedBeforeBytes: number;
  complete: boolean;
  persistedOnce: boolean;
  recoverable: boolean;
  timer?: ReturnType<typeof setTimeout>;
  flushChain: Promise<void>;
}

/**
 * Persists the recoverable prefix independently from the low-latency live frame path.
 * The first delta is durable before publication; later deltas are flushed at 80ms/8KiB.
 */
export class PersistentActiveOverlay {
  readonly #streams = new Map<string, ActiveStreamState>();
  readonly #degradedRuns = new Set<string>();

  constructor(
    private readonly persistence: ActiveOverlayPersistence,
    private readonly publisher: ActiveOverlayPublisher,
    private readonly flushIntervalMs = ACTIVE_OVERLAY_FLUSH_INTERVAL_MS,
    private readonly maxRunBytes = ACTIVE_OVERLAY_RUN_MAX_BYTES,
  ) {}

  async append(input: ActiveOverlayAppendInput): Promise<void> {
    if (!input.text) return;
    const state = this.stream(input);
    const startOffsetBytes = state.endOffsetBytes;
    const deltaBytes = utf8ByteLength(input.text);
    state.text += input.text;
    state.pendingBytes += deltaBytes;
    state.endOffsetBytes += deltaBytes;
    this.truncateRunIfNeeded(input.runId);

    if (!state.persistedOnce) {
      await this.flushState(state);
    } else if (state.pendingBytes >= ACTIVE_OVERLAY_FLUSH_BYTES) {
      void this.flushState(state);
    } else {
      this.schedule(state);
    }

    this.publisher.publishDelta({
      type: "subscription.session_delta",
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      itemId: input.itemId,
      streamId: input.streamId,
      kind: input.kind,
      startOffsetBytes,
      text: input.text,
      ...(input.stream ? { stream: input.stream } : {}),
    });
  }

  async complete(streamId: string): Promise<void> {
    const state = this.#streams.get(streamId);
    if (!state) return;
    state.complete = true;
    await this.flushState(state);
  }

  async flush(streamId?: string): Promise<void> {
    if (streamId !== undefined) {
      const state = this.#streams.get(streamId);
      if (state) await this.flushState(state);
      return;
    }
    await Promise.all([...this.#streams.values()].map((state) => this.flushState(state)));
  }

  snapshot(runId?: string): readonly RuntimeActiveOverlayEntry[] {
    return [...this.#streams.values()]
      .filter((state) => runId === undefined || state.input.runId === runId)
      .map((state) => overlayEntry(state));
  }

  private stream(input: ActiveOverlayAppendInput): ActiveStreamState {
    const existing = this.#streams.get(input.streamId);
    if (existing) {
      if (
        existing.input.sessionId !== input.sessionId ||
        existing.input.runId !== input.runId ||
        existing.input.itemId !== input.itemId ||
        existing.input.kind !== input.kind ||
        existing.input.stream !== input.stream
      ) {
        throw new Error(`Active overlay stream identity conflict: ${input.streamId}`);
      }
      return existing;
    }
    const { text: _text, ...identity } = input;
    const state: ActiveStreamState = {
      input: identity,
      partialId: activeOverlayPartialId(input),
      version: 0,
      text: "",
      pendingBytes: 0,
      endOffsetBytes: 0,
      truncatedBeforeBytes: 0,
      complete: false,
      persistedOnce: false,
      recoverable: !this.#degradedRuns.has(input.runId),
      flushChain: Promise.resolve(),
    };
    this.#streams.set(input.streamId, state);
    return state;
  }

  private schedule(state: ActiveStreamState): void {
    if (state.timer || !state.recoverable) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.flushState(state);
    }, this.flushIntervalMs);
  }

  private flushState(state: ActiveStreamState): Promise<void> {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.pendingBytes === 0 || !state.recoverable) return state.flushChain;
    state.flushChain = state.flushChain.then(async () => {
      if (state.pendingBytes === 0 || !state.recoverable) return;
      try {
        const persistThroughOffset = state.endOffsetBytes;
        const result = await this.persistence.upsert({
          partialId: state.partialId,
          kind: persistentKind(state.input.kind),
          expectedVersion: state.version,
          payload: overlayPayload(state),
        });
        state.version = result.version;
        state.persistedOnce = true;
        state.pendingBytes = state.endOffsetBytes - persistThroughOffset;
      } catch {
        this.degradeRun(state.input.runId);
        if (!this.#degradedRuns.has(state.input.runId)) {
          this.#degradedRuns.add(state.input.runId);
          this.publisher.publishContinuityDegraded("partial_persistence_failed");
        }
      }
    });
    return state.flushChain;
  }

  private degradeRun(runId: string): void {
    for (const state of this.#streams.values()) {
      if (state.input.runId !== runId) continue;
      state.recoverable = false;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
    }
  }

  private truncateRunIfNeeded(runId: string): void {
    const runStreams = [...this.#streams.values()].filter((state) => state.input.runId === runId);
    let totalBytes = runStreams.reduce((sum, state) => sum + utf8ByteLength(state.text), 0);
    if (totalBytes <= this.maxRunBytes) return;
    for (const state of runStreams) {
      if (totalBytes <= this.maxRunBytes) break;
      const currentBytes = utf8ByteLength(state.text);
      const removeBytes = Math.min(currentBytes, totalBytes - this.maxRunBytes);
      const trimmed = trimUtf8Prefix(state.text, removeBytes);
      state.text = trimmed.text;
      state.truncatedBeforeBytes += trimmed.removedBytes;
      state.pendingBytes = Math.max(state.pendingBytes, 1);
      totalBytes -= trimmed.removedBytes;
    }
  }
}

export function parseActiveOverlayPayload(value: unknown): ActiveOverlayPayload | undefined {
  if (!isRecord(value) || value["version"] !== 1) return undefined;
  if (
    typeof value["runId"] !== "string" ||
    typeof value["turnId"] !== "string" ||
    typeof value["itemId"] !== "string" ||
    typeof value["streamId"] !== "string" ||
    !["text", "thinking", "toolOutput"].includes(String(value["kind"])) ||
    !nonNegativeInteger(value["anchorSequence"]) ||
    !nonNegativeInteger(value["startOffsetBytes"]) ||
    !nonNegativeInteger(value["endOffsetBytes"]) ||
    !nonNegativeInteger(value["truncatedBeforeBytes"]) ||
    typeof value["text"] !== "string"
  ) {
    return undefined;
  }
  if (
    value["stream"] !== undefined &&
    value["stream"] !== "stdout" &&
    value["stream"] !== "stderr"
  ) {
    return undefined;
  }
  if (value["complete"] !== undefined && value["complete"] !== true) return undefined;
  if (utf8ByteLength(value["text"]) + value["truncatedBeforeBytes"] !== value["endOffsetBytes"]) {
    return undefined;
  }
  return value as unknown as ActiveOverlayPayload;
}

function overlayPayload(state: ActiveStreamState): ActiveOverlayPayload {
  return {
    version: 1,
    runId: state.input.runId,
    turnId: state.input.turnId,
    itemId: state.input.itemId,
    streamId: state.input.streamId,
    kind: state.input.kind,
    anchorSequence: state.input.anchorSequence,
    startOffsetBytes: state.truncatedBeforeBytes,
    endOffsetBytes: state.endOffsetBytes,
    truncatedBeforeBytes: state.truncatedBeforeBytes,
    text: state.text,
    ...(state.input.stream ? { stream: state.input.stream } : {}),
    ...(state.complete ? { complete: true } : {}),
  };
}

function overlayEntry(state: ActiveStreamState): RuntimeActiveOverlayEntry {
  const payload = overlayPayload(state);
  return {
    runId: payload.runId,
    turnId: payload.turnId,
    itemId: payload.itemId,
    streamId: payload.streamId,
    kind: payload.kind,
    anchorSequence: payload.anchorSequence,
    startOffsetBytes: payload.startOffsetBytes,
    endOffsetBytes: payload.endOffsetBytes,
    text: payload.text,
    ...(payload.stream ? { stream: payload.stream } : {}),
    ...(payload.truncatedBeforeBytes > 0
      ? { truncatedBeforeBytes: payload.truncatedBeforeBytes }
      : {}),
    ...(payload.complete ? { complete: true } : {}),
  };
}

function activeOverlayPartialId(input: ActiveOverlayAppendInput): string {
  return `active-overlay:${input.itemId}:${input.stream ?? input.kind}`;
}

function persistentKind(kind: ActiveOverlayKind): ActiveOverlayPersistInput["kind"] {
  if (kind === "text") return "assistant_text";
  if (kind === "thinking") return "thinking";
  return "tool_output";
}

function trimUtf8Prefix(
  text: string,
  minimumBytes: number,
): { text: string; removedBytes: number } {
  if (minimumBytes <= 0) return { text, removedBytes: 0 };
  const bytes = new TextEncoder().encode(text);
  if (minimumBytes >= bytes.byteLength) return { text: "", removedBytes: bytes.byteLength };
  let offset = minimumBytes;
  while (offset < bytes.byteLength && (bytes[offset]! & 0xc0) === 0x80) offset += 1;
  return {
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset)),
    removedBytes: offset,
  };
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
