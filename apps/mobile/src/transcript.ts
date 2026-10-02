import { TranscriptReplica, type TranscriptReplicaView } from "@pico/transcript-replica";
import type { RuntimeSessionSubscriptionFrame, RuntimeResult } from "@pico/protocol/mobile";
import type { RuntimePort } from "./core";

/** Owns one subscription, including pages and advance cursors; stale results never cross sessions. */
export class MobileTranscript {
  readonly replica: TranscriptReplica;
  #disposed = false;
  #advancing = false;
  #opening = false;
  #planControl: RuntimeResult<"session.subscription.open">["planControl"];
  constructor(
    readonly port: RuntimePort,
    readonly workspaceId: string,
    readonly sessionId: string,
    readonly changed: (view: TranscriptReplicaView) => void,
  ) {
    this.replica = new TranscriptReplica(sessionId);
  }
  get planControl() {
    return this.#planControl;
  }
  async open() {
    if (this.#disposed || this.#opening) return;
    this.#opening = true;
    const old = this.replica.view.subscriptionId;
    if (old)
      await this.port
        .request(
          "session.subscription.close",
          { sessionId: this.sessionId, subscriptionId: old },
          this.workspaceId,
        )
        .catch(() => undefined);
    const token = this.replica.beginOpen();
    this.changed(this.replica.view);
    try {
      const result = await this.port.request(
        "session.subscription.open",
        { sessionId: this.sessionId, tailLimit: 40, maxBytes: 384 * 1024 },
        this.workspaceId,
      );
      if (this.#disposed) {
        void this.port
          .request(
            "session.subscription.close",
            { sessionId: this.sessionId, subscriptionId: result.subscriptionId },
            this.workspaceId,
          )
          .catch(() => undefined);
        return;
      }
      this.#planControl = result.planControl;
      if (!this.replica.installOpen(token, result)) throw new Error("会话同步不完整，请重新连接");
      this.changed(this.replica.view);
    } catch (error) {
      this.replica.failOpen(token);
      if (!this.#disposed) this.changed(this.replica.view);
      throw error;
    } finally {
      this.#opening = false;
    }
  }
  async receive(frame: RuntimeSessionSubscriptionFrame) {
    if (this.#disposed) return;
    const result = this.replica.receiveFrame(frame);
    this.changed(this.replica.view);
    if (result.kind === "recovering") return this.open();
    await this.advance();
  }
  async advance() {
    if (this.#advancing || this.#disposed) return;
    this.#advancing = true;
    try {
      let request = this.replica.beginAdvance();
      while (request && !this.#disposed) {
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
        const result = this.replica.applyAdvancePage(request, page);
        if (result.kind === "recovering") {
          await this.open();
          break;
        }
        request = result.kind === "next" ? result.request : this.replica.beginAdvance();
      }
      if (!this.#disposed) this.changed(this.replica.view);
    } finally {
      this.#advancing = false;
    }
  }
  async older() {
    const request = this.replica.beginOlderPage();
    if (!request || this.#disposed) return;
    const page = await this.port.request(
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
    if (this.#disposed) return;
    if (this.replica.applyOlderPage(request, page) === "recovering") await this.open();
    this.changed(this.replica.view);
  }
  dispose() {
    this.#disposed = true;
    const subscriptionId = this.replica.view.subscriptionId;
    if (subscriptionId)
      void this.port
        .request(
          "session.subscription.close",
          { sessionId: this.sessionId, subscriptionId },
          this.workspaceId,
        )
        .catch(() => undefined);
    this.replica.reset();
  }
}
