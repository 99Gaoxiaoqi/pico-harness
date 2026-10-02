import { TranscriptReplica, type TranscriptReplicaView } from "@pico/transcript-replica";
import type { RuntimeSessionSubscriptionFrame, RuntimeResult } from "@pico/protocol/mobile";
import type { RuntimePort } from "./core.js";

type LoadedRange = {
  historyEpoch: string;
  projectorVersion: number;
  positionSequence: number;
  positionOrdinal: number;
};
const RESTORE_PAGES = 20;
const RESTORE_MS = 15_000;
const restoreLimitMessage = "已同步最新记录，较早历史恢复未完成，请继续加载更早记录";

/** Owns one session's history; transport generations never reuse requests or cursors. */
export class MobileTranscript {
  readonly replica: TranscriptReplica;
  #disposed = false;
  #suspended = false;
  #generation = 0;
  #advancing: number | undefined;
  #opening: Promise<void> | undefined;
  #older: Promise<void> | undefined;
  #ready = false;
  #restoreVersion = 0;
  #loadedRange: LoadedRange | undefined;
  #lastView: TranscriptReplicaView | undefined;
  #restoringView: TranscriptReplicaView | undefined;
  #planControl: RuntimeResult<"session.subscription.open">["planControl"];
  constructor(
    public port: RuntimePort,
    readonly workspaceId: string,
    readonly sessionId: string,
    readonly changed: (view: TranscriptReplicaView) => void,
  ) {
    this.replica = new TranscriptReplica(sessionId);
  }
  get planControl() {
    return this.#planControl;
  }
  get ready() {
    return this.#ready && !this.#suspended && this.replica.view.phase === "ready";
  }
  get restoreVersion() {
    return this.#restoreVersion;
  }
  #current(generation: number) {
    return !this.#disposed && !this.#suspended && generation === this.#generation;
  }
  #publish() {
    if (this.#disposed) return;
    const actual = this.replica.view;
    const view: TranscriptReplicaView = this.#restoringView
      ? { ...this.#restoringView, phase: "opening" }
      : this.#suspended
        ? { ...(this.#lastView ?? actual), phase: "recovering" }
        : actual;
    this.#lastView = view;
    this.changed(view);
  }
  #rememberRange() {
    const { records, watermark } = this.replica.view;
    const first = records[0];
    if (!watermark || !first) return;
    const old = this.#loadedRange;
    if (
      !old ||
      old.historyEpoch !== watermark.historyEpoch ||
      old.projectorVersion !== watermark.projectorVersion ||
      beforeOrEqual(first, old)
    )
      this.#loadedRange = {
        historyEpoch: watermark.historyEpoch,
        projectorVersion: watermark.projectorVersion,
        positionSequence: first.positionSequence,
        positionOrdinal: first.positionOrdinal,
      };
  }
  #close(subscriptionId: string, port = this.port) {
    return port
      .request(
        "session.subscription.close",
        { sessionId: this.sessionId, subscriptionId },
        this.workspaceId,
      )
      .catch(() => undefined);
  }
  open(port = this.port): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.port = port;
    if (this.#opening) return this.#opening;
    this.#suspended = false;
    const generation = ++this.#generation;
    this.#older = undefined;
    this.#ready = false;
    this.#restoringView = this.#lastView ?? this.replica.view;
    this.#publish();
    const operation = this.#open(generation);
    this.#opening = operation;
    const finished = () => {
      if (this.#opening === operation) this.#opening = undefined;
    };
    void operation.then(finished, finished);
    return operation;
  }
  async #open(generation: number) {
    const port = this.port;
    const old = this.replica.view.subscriptionId;
    if (old) await this.#close(old);
    if (!this.#current(generation)) return;
    const token = this.replica.beginOpen();
    try {
      const result = await port.request(
        "session.subscription.open",
        { sessionId: this.sessionId, tailLimit: 40, maxBytes: 384 * 1024 },
        this.workspaceId,
      );
      if (!this.#current(generation)) {
        void this.#close(result.subscriptionId, port);
        return;
      }
      this.#planControl = result.planControl;
      if (!this.replica.installOpen(token, result)) throw new Error("会话同步不完整，请重新连接");
      const range = this.#loadedRange;
      if (
        range &&
        range.historyEpoch === result.watermark.historyEpoch &&
        range.projectorVersion === result.watermark.projectorVersion
      ) {
        const deadline = Date.now() + RESTORE_MS;
        let pages = 0;
        while (this.#current(generation)) {
          const view = this.replica.view;
          if (!view.olderCursor || (view.records[0] && beforeOrEqual(view.records[0], range)))
            break;
          if (pages++ >= RESTORE_PAGES || Date.now() >= deadline)
            throw new Error(restoreLimitMessage);
          const outcome = await this.#page(generation, deadline);
          if (!this.#current(generation)) return;
          if (outcome !== "applied") throw new Error("较早历史已改变，请重新同步会话");
        }
      } else this.#loadedRange = undefined;
      if (!this.#current(generation)) return;
      if (!(await this.#advancePages(generation))) throw new Error("会话同步不完整，请重新连接");
      if (!this.#current(generation)) return;
      this.#ready = true;
      this.#restoreVersion++;
      this.#rememberRange();
      this.#restoringView = undefined;
      this.#publish();
    } catch (error) {
      if (!this.#current(generation)) return;
      this.replica.failOpen(token);
      // A valid new snapshot stays usable even if restoring the reading range failed.
      this.#ready = this.replica.view.phase === "ready";
      this.#restoringView = undefined;
      this.#publish();
      throw error;
    }
  }
  async receive(frame: RuntimeSessionSubscriptionFrame) {
    if (this.#disposed || this.#suspended) return;
    const result = this.replica.receiveFrame(frame);
    if (result.kind === "recovering") this.#ready = false;
    this.#publish();
    if (this.#opening) return;
    if (result.kind === "recovering") return this.open();
    await this.advance();
  }
  async #advancePages(generation: number) {
    let request = this.replica.beginAdvance();
    while (request && this.#current(generation)) {
      const page = await this.port.request(
        "session.transcript.advance",
        {
          sessionId: this.sessionId,
          after: request.after,
          through: request.through,
          ...(request.cursor ? { cursor: request.cursor } : {}),
          limit: 40,
          maxBytes: 384 * 1024,
        },
        this.workspaceId,
      );
      if (!this.#current(generation)) return false;
      const result = this.replica.applyAdvancePage(request, page);
      if (result.kind === "recovering") return false;
      request = result.kind === "next" ? result.request : this.replica.beginAdvance();
    }
    return this.replica.view.phase === "ready";
  }
  async advance() {
    const generation = this.#generation;
    if (this.#advancing === generation || this.#opening || !this.#current(generation)) return;
    this.#advancing = generation;
    try {
      if (!(await this.#advancePages(generation))) {
        if (this.#current(generation)) await this.open();
        return;
      }
      if (this.#current(generation)) {
        this.#rememberRange();
        this.#publish();
      }
    } finally {
      if (this.#advancing === generation) this.#advancing = undefined;
    }
  }
  async #page(generation: number, deadline?: number) {
    const request = this.replica.beginOlderPage();
    if (!request || !this.#current(generation)) return "ignored";
    const pending = this.port.request(
      "session.transcript.page",
      {
        sessionId: this.sessionId,
        through: request.through,
        cursor: request.cursor,
        limit: 40,
        maxBytes: 384 * 1024,
      },
      this.workspaceId,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const page = await (deadline === undefined
        ? pending
        : Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(restoreLimitMessage)),
                Math.max(0, deadline - Date.now()),
              );
            }),
          ]));
      if (!this.#current(generation)) return "ignored";
      return this.replica.applyOlderPage(request, page);
    } finally {
      clearTimeout(timer);
    }
  }
  older(): Promise<void> {
    if (this.#opening) return this.#opening;
    if (this.#older) return this.#older;
    if (!this.#current(this.#generation)) return Promise.resolve();
    const generation = this.#generation;
    const operation = (async () => {
      const outcome = await this.#page(generation);
      if (!this.#current(generation)) return;
      if (outcome === "recovering") return this.open();
      this.#rememberRange();
      this.#publish();
    })();
    this.#older = operation;
    const finished = () => {
      if (this.#older === operation) this.#older = undefined;
    };
    void operation.then(finished, finished);
    return operation;
  }
  suspend() {
    if (this.#disposed || this.#suspended) return;
    this.#suspended = true;
    this.#generation++;
    this.#opening = undefined;
    this.#older = undefined;
    this.#ready = false;
    this.#restoringView = undefined;
    const subscriptionId = this.replica.view.subscriptionId;
    if (subscriptionId) void this.#close(subscriptionId);
    this.#publish();
  }
  dispose() {
    this.suspend();
    this.#disposed = true;
    this.replica.reset();
  }
}

function beforeOrEqual(
  a: { positionSequence: number; positionOrdinal: number },
  b: { positionSequence: number; positionOrdinal: number },
) {
  return (
    a.positionSequence < b.positionSequence ||
    (a.positionSequence === b.positionSequence && a.positionOrdinal <= b.positionOrdinal)
  );
}
