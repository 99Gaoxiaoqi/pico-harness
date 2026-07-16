import {
  createProductionLocalDaemonHost,
  LocalDaemonAlreadyRunningError,
  type LocalDaemonHost,
} from "../../../../src/daemon/index.js";

/** Owns a daemon started by this app while leaving an existing user daemon untouched. */
export class DesktopDaemonController {
  private host: LocalDaemonHost | undefined;
  private owned = false;
  private startingPromise: Promise<void> | undefined;
  private stoppingPromise: Promise<void> | undefined;

  get ownsProcess(): boolean {
    // Fence quit while ownership is still being resolved. stop() will wait for
    // the candidate and leave it untouched if another process owns the daemon.
    return this.owned || this.startingPromise !== undefined;
  }

  async start(): Promise<void> {
    if (this.startingPromise) return this.startingPromise;
    if (this.host) return;
    const candidate = createProductionLocalDaemonHost();
    this.host = candidate;
    const startingPromise = this.startCandidate(candidate);
    this.startingPromise = startingPromise;
    try {
      await startingPromise;
    } finally {
      if (this.startingPromise === startingPromise) this.startingPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.stoppingPromise) return this.stoppingPromise;
    const stoppingPromise = this.stopOwnedHost().finally(() => {
      if (this.stoppingPromise === stoppingPromise) this.stoppingPromise = undefined;
    });
    this.stoppingPromise = stoppingPromise;
    return stoppingPromise;
  }

  private async startCandidate(candidate: LocalDaemonHost): Promise<void> {
    try {
      await candidate.start();
      if (this.host === candidate) this.owned = true;
    } catch (error) {
      if (this.host === candidate) this.host = undefined;
      this.owned = false;
      if (error instanceof LocalDaemonAlreadyRunningError) return;
      throw error;
    }
  }

  private async stopOwnedHost(): Promise<void> {
    const startingPromise = this.startingPromise;
    if (startingPromise) await startingPromise.catch(() => undefined);
    const host = this.host;
    if (!host || !this.owned) return;
    try {
      await host.stop();
    } finally {
      if (this.host === host) this.host = undefined;
      this.owned = false;
    }
  }
}

export interface DesktopBeforeQuitEvent {
  preventDefault(): void;
}

/** Keeps every repeated before-quit event fenced until the owned daemon finishes draining. */
export function createDesktopDaemonShutdownFence(
  daemon: Pick<DesktopDaemonController, "ownsProcess" | "stop">,
  quit: () => void,
  onStopError: (error: unknown) => void,
): (event: DesktopBeforeQuitEvent) => void {
  let stoppingPromise: Promise<void> | undefined;
  let stopped = false;

  const finishQuit = (): void => {
    stopped = true;
    quit();
  };
  const finishAfterStopError = (error: unknown): void => {
    try {
      onStopError(error);
    } finally {
      finishQuit();
    }
  };

  return (event) => {
    if (stopped) return;
    if (!stoppingPromise && !daemon.ownsProcess) return;
    event.preventDefault();
    if (stoppingPromise) return;
    stoppingPromise = daemon.stop();
    void stoppingPromise.then(finishQuit, finishAfterStopError);
  };
}
