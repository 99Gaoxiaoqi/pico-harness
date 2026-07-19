import {
  isEphemeralRuntimeNotificationTopic,
  isRunLiveRuntimeNotification,
  type RuntimeNotification,
  type RuntimeNotificationMap,
} from "./runtime.js";

export const DEFAULT_PENDING_RUNTIME_EVENT_LIMIT = 512;
export const DEFAULT_PENDING_RUNTIME_BYTES_LIMIT = 2 * 1024 * 1024;
export const DEFAULT_PENDING_LIVE_REASONING_CHARS = 64 * 1024;
const MAX_REMEMBERED_LIVE_TERMINALS = 10_000;

export interface RuntimeNotificationBufferOptions {
  readonly maxEvents?: number;
  readonly maxBytes?: number;
  readonly maxLiveReasoningChars?: number;
}

/**
 * Bounded pre-delivery queue shared by daemon, Main, and preload.
 * Durable events are never dropped: push returns false so the host can fail/re-hydrate explicitly.
 * Ephemeral run.live updates are coalesced and evicted oldest-first under pressure.
 */
export class RuntimeNotificationBuffer {
  private readonly events: RuntimeNotification[] = [];
  private readonly terminalLiveStreams = new Set<string>();
  private readonly truncatedLiveStreams = new Set<string>();
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly maxLiveReasoningChars: number;

  constructor(options: RuntimeNotificationBufferOptions = {}) {
    this.maxEvents = options.maxEvents ?? DEFAULT_PENDING_RUNTIME_EVENT_LIMIT;
    this.maxBytes = options.maxBytes ?? DEFAULT_PENDING_RUNTIME_BYTES_LIMIT;
    this.maxLiveReasoningChars =
      options.maxLiveReasoningChars ?? DEFAULT_PENDING_LIVE_REASONING_CHARS;
  }

  push(event: RuntimeNotification): boolean {
    if (event.topic === "run.live" && !isRunLiveRuntimeNotification(event)) return true;
    if (event.topic === "run.live") {
      const payload = event.payload as RuntimeNotificationMap["run.live"];
      const key = this.liveStreamKey(event, payload.item.streamId);
      const runKey = this.liveStreamKey(event);
      if (
        payload.item.operation === "append" &&
        (this.terminalLiveStreams.has(key) || this.terminalLiveStreams.has(runKey))
      ) {
        return true;
      }
      if (payload.item.operation === "complete" || payload.item.operation === "clear") {
        this.terminalLiveStreams.add(key);
        this.forgetLiveTruncation(event, payload.item.streamId);
        if (this.terminalLiveStreams.size > MAX_REMEMBERED_LIVE_TERMINALS) {
          const oldest = this.terminalLiveStreams.values().next().value;
          if (oldest !== undefined) this.terminalLiveStreams.delete(oldest);
        }
      } else if (payload.item.truncated === true) {
        this.rememberTruncatedLiveStream(key);
      } else if (this.truncatedLiveStreams.has(key)) {
        event = this.withTruncatedLiveAppend(event);
      }
    }
    if (event.topic === "run.live" && this.coalesceLiveAppend(event)) {
      this.trimEphemeral();
      return true;
    }
    this.events.push(event);
    if (this.fits()) return true;
    // Durable events get first claim on the queue: shed best-effort live updates before
    // reporting durable overflow to the host.
    this.trimEphemeral();
    if (this.fits() || isEphemeralRuntimeNotificationTopic(event.topic)) return true;
    this.events.pop();
    return false;
  }

  drain(): RuntimeNotification[] {
    return this.events.splice(0);
  }

  clear(): void {
    this.events.length = 0;
    this.terminalLiveStreams.clear();
    this.truncatedLiveStreams.clear();
  }

  get size(): number {
    return this.events.length;
  }

  private coalesceLiveAppend(event: RuntimeNotification): boolean {
    if (!isRunLiveRuntimeNotification(event)) return false;
    const payload = event.payload as RuntimeNotificationMap["run.live"];
    const item = payload.item;
    if (item.operation !== "append" || !item.streamId) return false;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const candidate = this.events[index];
      // Never move a later append ahead of a durable event or another live stream.
      if (candidate?.topic !== "run.live" || !isRunLiveRuntimeNotification(candidate)) return false;
      const candidatePayload = candidate.payload as RuntimeNotificationMap["run.live"];
      const differentRun =
        candidate.scope.workspacePath !== event.scope.workspacePath ||
        candidate.scope.sessionId !== event.scope.sessionId ||
        candidatePayload.runId !== payload.runId;
      if (differentRun) return false;
      const candidateItem = candidatePayload.item;
      if (candidateItem.operation === "clear") return false;
      if (candidateItem.streamId !== item.streamId) return false;
      if (candidateItem.operation !== "append") return false;
      const combined = `${candidateItem.delta ?? ""}${item.delta ?? ""}`;
      const truncated =
        candidateItem.truncated === true ||
        item.truncated === true ||
        combined.length > this.maxLiveReasoningChars;
      const delta = combined.slice(0, this.maxLiveReasoningChars);
      this.events[index] = {
        ...event,
        payload: {
          ...payload,
          item: { ...item, delta, ...(truncated ? { truncated: true } : {}) },
        },
      };
      return true;
    }
    return false;
  }

  private trimEphemeral(): void {
    while (!this.fits()) {
      // Append deltas are reconstructible and are evicted before complete/clear tombstones.
      const appendIndex = this.events.findIndex(
        (event) =>
          isRunLiveRuntimeNotification(event) &&
          (event.payload as RuntimeNotificationMap["run.live"]).item.operation === "append",
      );
      const index =
        appendIndex >= 0
          ? appendIndex
          : this.events.findIndex((event) => isEphemeralRuntimeNotificationTopic(event.topic));
      if (index < 0) return;
      const [removed] = this.events.splice(index, 1);
      if (removed) this.rememberLiveGap(removed);
    }
  }

  private fits(): boolean {
    return this.events.length <= this.maxEvents && this.byteLength() <= this.maxBytes;
  }

  private byteLength(): number {
    return Buffer.byteLength(JSON.stringify(this.events), "utf8");
  }

  private liveStreamKey(event: RuntimeNotification, streamId?: string): string {
    return [
      event.scope.workspacePath,
      event.scope.sessionId ?? "",
      event.scope.runId ?? "",
      streamId ?? "*",
    ].join("\0");
  }

  private rememberLiveGap(event: RuntimeNotification): void {
    if (!isRunLiveRuntimeNotification(event)) return;
    const payload = event.payload as RuntimeNotificationMap["run.live"];
    if (payload.item.operation !== "append" || !payload.item.streamId) return;
    const key = this.liveStreamKey(event, payload.item.streamId);
    const runKey = this.liveStreamKey(event);
    if (this.terminalLiveStreams.has(key) || this.terminalLiveStreams.has(runKey)) return;
    this.rememberTruncatedLiveStream(key);
    for (const [index, candidate] of this.events.entries()) {
      if (!isRunLiveRuntimeNotification(candidate)) continue;
      const candidatePayload = candidate.payload as RuntimeNotificationMap["run.live"];
      if (
        candidatePayload.item.operation === "append" &&
        candidatePayload.item.streamId &&
        this.liveStreamKey(candidate, candidatePayload.item.streamId) === key
      ) {
        this.events[index] = this.withTruncatedLiveAppend(candidate);
      }
    }
  }

  private forgetLiveTruncation(event: RuntimeNotification, streamId?: string): void {
    if (streamId) {
      this.truncatedLiveStreams.delete(this.liveStreamKey(event, streamId));
      return;
    }
    const prefix = this.liveStreamKey(event, "");
    for (const key of this.truncatedLiveStreams) {
      if (key.startsWith(prefix)) this.truncatedLiveStreams.delete(key);
    }
  }

  private rememberTruncatedLiveStream(key: string): void {
    this.truncatedLiveStreams.add(key);
    if (this.truncatedLiveStreams.size > MAX_REMEMBERED_LIVE_TERMINALS) {
      const oldest = this.truncatedLiveStreams.values().next().value;
      if (oldest !== undefined) this.truncatedLiveStreams.delete(oldest);
    }
  }

  private withTruncatedLiveAppend(event: RuntimeNotification): RuntimeNotification {
    const payload = event.payload as RuntimeNotificationMap["run.live"];
    return {
      ...event,
      payload: {
        ...payload,
        item: { ...payload.item, truncated: true },
      },
    } as RuntimeNotification;
  }
}
