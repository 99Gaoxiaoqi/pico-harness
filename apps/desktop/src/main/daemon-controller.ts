import {
  createProductionLocalDaemonHost,
  LocalDaemonAlreadyRunningError,
  type LocalDaemonHost,
} from "../../../../src/daemon/index.js";

/** Owns a daemon started by this app while leaving an existing user daemon untouched. */
export class DesktopDaemonController {
  private host: LocalDaemonHost | undefined;
  private owned = false;
  private stoppingPromise: Promise<void> | undefined;

  get ownsProcess(): boolean {
    return this.owned;
  }

  async start(): Promise<void> {
    if (this.host) return;
    const candidate = createProductionLocalDaemonHost();
    try {
      await candidate.start();
      this.host = candidate;
      this.owned = true;
    } catch (error) {
      if (error instanceof LocalDaemonAlreadyRunningError) {
        this.host = undefined;
        this.owned = false;
        return;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stoppingPromise) return this.stoppingPromise;
    const host = this.host;
    if (!host) {
      this.owned = false;
      return;
    }
    const stoppingPromise = host.stop().finally(() => {
      if (this.host === host) this.host = undefined;
      this.owned = false;
      if (this.stoppingPromise === stoppingPromise) this.stoppingPromise = undefined;
    });
    this.stoppingPromise = stoppingPromise;
    return stoppingPromise;
  }
}

export interface DesktopBeforeQuitEvent {
  preventDefault(): void;
}

/** Keeps every repeated before-quit event fenced until the owned daemon finishes draining. */
export function createDesktopDaemonShutdownFence(
  daemon: Pick<DesktopDaemonController, "ownsProcess" | "stop">,
  quit: () => void,
): (event: DesktopBeforeQuitEvent) => void {
  let stoppingPromise: Promise<void> | undefined;
  let stopped = false;

  const finishQuit = (): void => {
    stopped = true;
    quit();
  };

  return (event) => {
    if (stopped) return;
    if (!stoppingPromise && !daemon.ownsProcess) return;
    event.preventDefault();
    if (stoppingPromise) return;
    stoppingPromise = daemon.stop();
    void stoppingPromise.then(finishQuit, finishQuit);
  };
}
