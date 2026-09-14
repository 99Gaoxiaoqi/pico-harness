import { raceWithDeadline } from "@pico/runtime/deadline";

export interface CronWorkspaceServicePort<Run> {
  recoverInterruptedRuns(reason?: string): readonly Run[];
  close(): void;
}

export interface CronWorkspaceSchedulerPort<Run> {
  runNow(cronJobId: string): Run;
  start(): void;
  stop(): void;
  stopAndWait(): Promise<void>;
}

export interface CronWorkspaceLifecycleOptions<Run> {
  readonly cronService: CronWorkspaceServicePort<Run>;
  readonly scheduler: CronWorkspaceSchedulerPort<Run>;
  readonly closeDrainTimeoutMs?: number;
}

/**
 * Host-owned shutdown fence for a single workspace Cron runtime.
 * Concrete scheduler and durable store implementations are supplied by outer composition.
 */
export class CronWorkspaceLifecycle<Run> {
  private readonly closeDrainTimeoutMs: number;
  private closed = false;
  private closePromise?: Promise<void>;
  private ownershipReleasePending = false;
  private ownershipReleasePromise: Promise<void> = Promise.resolve();

  constructor(private readonly options: CronWorkspaceLifecycleOptions<Run>) {
    this.closeDrainTimeoutMs = normalizeCloseDrainTimeoutMs(options.closeDrainTimeoutMs);
  }

  recoverInterruptedRuns(reason?: string): readonly Run[] {
    return this.options.cronService.recoverInterruptedRuns(reason);
  }

  runNow(cronJobId: string): Run {
    if (this.closed) throw new Error("Cron workspace runtime 已关闭");
    return this.options.scheduler.runNow(cronJobId);
  }

  start(): void {
    if (this.closed) throw new Error("Cron workspace runtime 已关闭");
    this.options.scheduler.start();
  }

  beginClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.scheduler.stop();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.beginClose();
    let resolveClose: () => void = () => undefined;
    let rejectClose: (reason: unknown) => void = () => undefined;
    const closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    this.closePromise = closePromise;
    void this.performClose().then(resolveClose, rejectClose);
    return closePromise;
  }

  hasPendingOwnership(): boolean {
    return this.ownershipReleasePending;
  }

  waitForOwnershipRelease(): Promise<void> {
    return this.ownershipReleasePromise;
  }

  private async performClose(): Promise<void> {
    const activeTickDrain = this.options.scheduler.stopAndWait();
    const drained = await raceWithDeadline(activeTickDrain, this.closeDrainTimeoutMs);
    const releaseOwnership = async (): Promise<void> => {
      await activeTickDrain;
      this.options.cronService.close();
    };
    if (drained) {
      await releaseOwnership();
      return;
    }

    this.ownershipReleasePending = true;
    const ownershipRelease = releaseOwnership();
    this.ownershipReleasePromise = ownershipRelease;
    ownershipRelease.then(
      () => {
        this.ownershipReleasePending = false;
      },
      () => undefined,
    );
    void ownershipRelease.catch(() => undefined);
  }
}

function normalizeCloseDrainTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("Cron closeDrainTimeoutMs 必须是非负有限数");
  }
  return timeoutMs;
}
