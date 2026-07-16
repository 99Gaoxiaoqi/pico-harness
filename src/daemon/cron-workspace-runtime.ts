import type { WorkspaceTaskRuntime } from "../runtime/workspace-runtime.js";
import {
  CronRuntimeScheduler,
  type CronRuntimeSchedulerOptions,
} from "../tasks/cron-runtime-scheduler.js";
import { CronService, type CronPolicyGuard } from "../tasks/cron-service.js";
import type { CronRunRecord } from "../tasks/runtime-types.js";

export interface CronWorkspaceRuntimeOptions extends Omit<
  CronRuntimeSchedulerOptions,
  "cronService"
> {
  workspacePath: string;
  ownerId: string;
  databasePath?: string;
  picoHome?: string;
  policyGuard?: CronPolicyGuard;
  closeDrainTimeoutMs?: number;
}

/** A daemon-owned Cron ledger and scheduler for one canonical workspace. */
export class CronWorkspaceRuntime {
  readonly cronService: CronService;
  readonly scheduler: CronRuntimeScheduler;
  private readonly closeDrainTimeoutMs: number;
  private closed = false;
  private closePromise?: Promise<void>;
  private ownershipReleasePending = false;
  private ownershipReleasePromise: Promise<void> = Promise.resolve();

  constructor(options: CronWorkspaceRuntimeOptions) {
    this.cronService = new CronService({
      workDir: options.workspacePath,
      ownerId: options.ownerId,
      ...(options.databasePath ? { databasePath: options.databasePath } : {}),
      ...(options.picoHome ? { picoHome: options.picoHome } : {}),
      ...(options.policyGuard ? { policyGuard: options.policyGuard } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.scheduler = new CronRuntimeScheduler({
      cronService: this.cronService,
      getWorkspaceRuntime: options.getWorkspaceRuntime,
      execute: options.execute,
      canRun: options.canRun,
      ...(options.leaseHeartbeatMs ? { leaseHeartbeatMs: options.leaseHeartbeatMs } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.closeDrainTimeoutMs = normalizeCloseDrainTimeoutMs(options.closeDrainTimeoutMs);
  }

  recoverInterruptedRuns(reason?: string): CronRunRecord[] {
    return this.cronService.recoverInterruptedRuns(reason);
  }

  runNow(cronJobId: string): CronRunRecord {
    if (this.closed) throw new Error("Cron workspace runtime 已关闭");
    return this.scheduler.runNow(cronJobId);
  }

  start(): void {
    if (this.closed) throw new Error("Cron workspace runtime 已关闭");
    this.scheduler.start();
  }

  beginClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.scheduler.stop();
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
    const activeTickDrain = this.scheduler.stopAndWait();
    const drained = await settlesWithin(activeTickDrain, this.closeDrainTimeoutMs);
    const releaseOwnership = async (): Promise<void> => {
      await activeTickDrain;
      this.cronService.close();
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

export interface CronWorkspaceRuntimeFactoryInput {
  workspacePath: string;
  ownerId: string;
}

export interface ManagedCronWorkspaceRuntime {
  recoverInterruptedRuns(reason?: string): readonly CronRunRecord[];
  /** Optional for legacy/test factories; production runtimes always implement it. */
  runNow?(cronJobId: string): CronRunRecord;
  start(): void;
  /** Stops timers and rejects new manual Runs before asynchronous drain begins. */
  beginClose?(): void;
  close(): Promise<void>;
  hasPendingOwnership?(): boolean;
  waitForOwnershipRelease?(): Promise<void>;
}

export interface CronWorkspaceRuntimeFactory {
  create(input: CronWorkspaceRuntimeFactoryInput): Promise<ManagedCronWorkspaceRuntime>;
}

export function createCronWorkspaceRuntimeFactory(options: {
  getWorkspaceRuntime(workspacePath: string): Promise<WorkspaceTaskRuntime>;
  execute: CronRuntimeSchedulerOptions["execute"];
  canRun: CronRuntimeSchedulerOptions["canRun"];
  policyGuard?: CronPolicyGuard;
  picoHome?: string;
  leaseHeartbeatMs?: number;
  closeDrainTimeoutMs?: number;
  now?: () => number;
}): CronWorkspaceRuntimeFactory {
  return {
    create: async ({ workspacePath, ownerId }) =>
      new CronWorkspaceRuntime({
        workspacePath,
        ownerId,
        getWorkspaceRuntime: options.getWorkspaceRuntime,
        execute: options.execute,
        canRun: options.canRun,
        ...(options.picoHome ? { picoHome: options.picoHome } : {}),
        ...(options.policyGuard ? { policyGuard: options.policyGuard } : {}),
        ...(options.leaseHeartbeatMs ? { leaseHeartbeatMs: options.leaseHeartbeatMs } : {}),
        ...(options.closeDrainTimeoutMs !== undefined
          ? { closeDrainTimeoutMs: options.closeDrainTimeoutMs }
          : {}),
        ...(options.now ? { now: options.now } : {}),
      }),
  };
}

function normalizeCloseDrainTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("Cron closeDrainTimeoutMs 必须是非负有限数");
  }
  return timeoutMs;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
