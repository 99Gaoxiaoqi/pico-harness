import {
  createProductionLocalDaemonHost,
  LocalDaemonAlreadyRunningError,
  type LocalDaemonHost,
} from "../../../../src/daemon/index.js";

/** Owns a daemon started by this app while leaving an existing user daemon untouched. */
export class DesktopDaemonController {
  private host: LocalDaemonHost | undefined;
  private owned = false;

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
    const host = this.host;
    this.host = undefined;
    this.owned = false;
    if (host) await host.stop();
  }
}
