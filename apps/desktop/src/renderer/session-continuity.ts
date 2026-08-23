import {
  type RuntimeParams,
  type RuntimeResult,
  type RuntimeSessionSubscriptionFrame,
} from "@pico/protocol";
import { TranscriptReplica, type TranscriptReplicaView } from "@pico/transcript-replica";

export interface DesktopSessionContinuityTransport {
  open(
    params: RuntimeParams<"session.subscription.open">,
  ): Promise<RuntimeResult<"session.subscription.open">>;
  close(
    params: RuntimeParams<"session.subscription.close">,
  ): Promise<RuntimeResult<"session.subscription.close">>;
  page(
    params: RuntimeParams<"session.transcript.page">,
  ): Promise<RuntimeResult<"session.transcript.page">>;
  advance(
    params: RuntimeParams<"session.transcript.advance">,
  ): Promise<RuntimeResult<"session.transcript.advance">>;
  subscribeFrames(
    listener: (frame: RuntimeSessionSubscriptionFrame) => void,
    onDisconnect?: () => void,
  ): { dispose(): void };
}

export interface DesktopSessionContinuityOptions {
  readonly transport: DesktopSessionContinuityTransport;
  readonly onView: (workspacePath: string, sessionId: string, view: TranscriptReplicaView) => void;
  readonly onError?: (error: unknown) => void;
}

interface Binding {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly replica: TranscriptReplica;
  advancing: boolean;
  advanceAgain: boolean;
  reopening: boolean;
  retryAttempt: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  disposed: boolean;
}

/** Renderer-owned v2 continuity controller. Host frames remain a distinct wire channel. */
export class DesktopSessionContinuity {
  readonly #bindings = new Map<string, Binding>();
  readonly #frameSubscription: { dispose(): void };
  #disposed = false;

  constructor(private readonly options: DesktopSessionContinuityOptions) {
    // Install the raw frame listener before any session.subscription.open request.
    this.#frameSubscription = options.transport.subscribeFrames(
      (frame) => this.acceptSessionFrame(frame),
      () => this.handleDisconnect(),
    );
  }

  async open(workspacePath: string, sessionId: string): Promise<TranscriptReplicaView> {
    this.assertActive();
    const key = bindingKey(workspacePath, sessionId);
    const previous = this.#bindings.get(key);
    if (previous) {
      previous.disposed = true;
      this.clearRetry(previous);
      await this.closeBinding(previous);
    }
    const binding: Binding = {
      workspacePath,
      sessionId,
      replica: new TranscriptReplica(sessionId),
      advancing: false,
      advanceAgain: false,
      reopening: false,
      retryAttempt: 0,
      disposed: false,
    };
    this.#bindings.set(key, binding);
    try {
      await this.installOpen(binding);
    } catch (error) {
      this.scheduleRetry(binding);
      throw error;
    }
    return binding.replica.view;
  }

  acceptSessionFrame(frame: RuntimeSessionSubscriptionFrame): void {
    if (this.#disposed) return;
    const binding = [...this.#bindings.values()].find(
      (candidate) => !candidate.disposed && candidate.sessionId === frame.sessionId,
    );
    if (!binding) return;
    const outcome = binding.replica.receiveFrame(frame);
    if (outcome.kind === "applied") {
      this.emit(binding);
      if (binding.replica.view.pendingWatermark) void this.advance(binding);
    } else if (outcome.kind === "recovering") {
      void this.reopen(binding);
    }
  }

  private handleDisconnect(): void {
    if (this.#disposed) return;
    for (const binding of this.#bindings.values()) void this.reopen(binding);
  }

  view(workspacePath: string, sessionId: string): TranscriptReplicaView | undefined {
    return this.#bindings.get(bindingKey(workspacePath, sessionId))?.replica.view;
  }

  async close(workspacePath: string, sessionId: string): Promise<void> {
    const key = bindingKey(workspacePath, sessionId);
    const binding = this.#bindings.get(key);
    if (!binding) return;
    binding.disposed = true;
    this.clearRetry(binding);
    this.#bindings.delete(key);
    await this.closeBinding(binding);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#frameSubscription.dispose();
    for (const binding of this.#bindings.values()) {
      binding.disposed = true;
      this.clearRetry(binding);
      void this.closeBinding(binding);
    }
    this.#bindings.clear();
  }

  private async installOpen(binding: Binding): Promise<void> {
    const token = binding.replica.beginOpen();
    const opened = await this.options.transport.open({
      workspacePath: binding.workspacePath,
      sessionId: binding.sessionId,
      tailLimit: 200,
    });
    if (!this.isCurrent(binding)) {
      await this.closeOpened(binding, opened.subscriptionId);
      return;
    }
    if (!binding.replica.installOpen(token, opened)) {
      await this.closeOpened(binding, opened.subscriptionId);
      throw new Error(
        `Session continuity open failed (${binding.replica.view.recoveryReason ?? "unknown"})`,
      );
    }
    this.emit(binding);

    let older = binding.replica.beginOlderPage();
    while (older) {
      const page = await this.options.transport.page({
        workspacePath: binding.workspacePath,
        sessionId: binding.sessionId,
        through: older.through,
        cursor: older.cursor,
        limit: 200,
      });
      if (!this.isCurrent(binding)) return;
      const outcome = binding.replica.applyOlderPage(older, page);
      if (outcome === "recovering") throw new Error("Session continuity older-page gap");
      if (outcome === "ignored") return;
      older = binding.replica.beginOlderPage();
    }
    this.emit(binding);
    if (binding.replica.view.pendingWatermark) await this.advance(binding);
  }

  private async advance(binding: Binding): Promise<void> {
    if (!this.isCurrent(binding)) return;
    if (binding.advancing) {
      binding.advanceAgain = true;
      return;
    }
    binding.advancing = true;
    try {
      do {
        binding.advanceAgain = false;
        let request = binding.replica.beginAdvance();
        while (request) {
          const page = await this.options.transport.advance({
            workspacePath: binding.workspacePath,
            sessionId: binding.sessionId,
            after: request.after,
            through: request.through,
            ...(request.cursor ? { cursor: request.cursor } : {}),
            limit: 200,
          });
          if (!this.isCurrent(binding)) return;
          const outcome = binding.replica.applyAdvancePage(request, page);
          if (outcome.kind === "recovering") {
            void this.reopen(binding);
            return;
          }
          request = outcome.kind === "next" ? outcome.request : undefined;
        }
        this.emit(binding);
        if (binding.replica.view.pendingWatermark) binding.advanceAgain = true;
      } while (binding.advanceAgain);
    } catch (error) {
      this.options.onError?.(error);
      void this.reopen(binding);
    } finally {
      binding.advancing = false;
    }
  }

  private async reopen(binding: Binding): Promise<void> {
    if (!this.isCurrent(binding) || binding.reopening) return;
    binding.reopening = true;
    this.clearRetry(binding);
    try {
      await this.closeBinding(binding);
      if (!this.isCurrent(binding)) return;
      await this.installOpen(binding);
      binding.retryAttempt = 0;
    } catch (error) {
      this.options.onError?.(error);
      this.scheduleRetry(binding);
    } finally {
      binding.reopening = false;
    }
  }

  private scheduleRetry(binding: Binding): void {
    if (!this.isCurrent(binding) || binding.retryTimer) return;
    const delay = Math.min(250 * 2 ** binding.retryAttempt, 5_000);
    binding.retryAttempt += 1;
    binding.retryTimer = setTimeout(() => {
      binding.retryTimer = undefined;
      void this.reopen(binding);
    }, delay);
  }

  private clearRetry(binding: Binding): void {
    if (!binding.retryTimer) return;
    clearTimeout(binding.retryTimer);
    binding.retryTimer = undefined;
  }

  private async closeBinding(binding: Binding): Promise<void> {
    const subscriptionId = binding.replica.view.subscriptionId;
    if (!subscriptionId) return;
    try {
      await this.options.transport.close({
        workspacePath: binding.workspacePath,
        sessionId: binding.sessionId,
        subscriptionId,
      });
    } catch {
      // Close is idempotent best effort; the Host also drops it with the connection.
    }
  }

  private async closeOpened(binding: Binding, subscriptionId: string): Promise<void> {
    try {
      await this.options.transport.close({
        workspacePath: binding.workspacePath,
        sessionId: binding.sessionId,
        subscriptionId,
      });
    } catch {
      // A stale open is connection-scoped and close is best effort.
    }
  }

  private emit(binding: Binding): void {
    if (!this.isCurrent(binding) || binding.replica.view.phase !== "ready") return;
    this.options.onView(binding.workspacePath, binding.sessionId, binding.replica.view);
  }

  private isCurrent(binding: Binding): boolean {
    return (
      !this.#disposed &&
      !binding.disposed &&
      this.#bindings.get(bindingKey(binding.workspacePath, binding.sessionId)) === binding
    );
  }

  private assertActive(): void {
    if (this.#disposed) throw new Error("DesktopSessionContinuity is disposed");
  }
}

function bindingKey(workspacePath: string, sessionId: string): string {
  return `${workspacePath}\u0000${sessionId}`;
}
