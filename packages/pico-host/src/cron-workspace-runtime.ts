import type { WorkspaceTaskRuntime } from "./workspace-task-runtime.js";
import { CronWorkspaceLifecycle } from "./cron-workspace-lifecycle.js";
import {
  CronRuntimeScheduler,
  type CronRuntimeSchedulerOptions,
} from "./cron-runtime-scheduler.js";
import { resolvePicoPaths } from "./pico-paths.js";
import { CronService, type CronPolicyGuard } from "@pico/runtime/cron-service";
import type { CronRunRecord } from "@pico/storage/runtime-control-types";

export interface CronWorkspaceRuntimeOptions extends Omit<
  CronRuntimeSchedulerOptions,
  "cronService"
> {
  workspacePath: string;
  ownerId: string;
  storageRoot?: string;
  picoHome?: string;
  policyGuard?: CronPolicyGuard;
  closeDrainTimeoutMs?: number;
}

/** A daemon-owned Cron ledger and scheduler for one canonical workspace. */
export class CronWorkspaceRuntime {
  readonly cronService: CronService;
  readonly scheduler: CronRuntimeScheduler;
  private readonly lifecycle: CronWorkspaceLifecycle<CronRunRecord>;

  constructor(options: CronWorkspaceRuntimeOptions) {
    this.cronService = new CronService({
      storageRoot:
        options.storageRoot ??
        resolvePicoPaths(options.workspacePath, {
          ...(options.picoHome ? { picoHome: options.picoHome } : {}),
        }).workspace.root,
      ownerId: options.ownerId,
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
    this.lifecycle = new CronWorkspaceLifecycle({
      cronService: this.cronService,
      scheduler: this.scheduler,
      ...(options.closeDrainTimeoutMs !== undefined
        ? { closeDrainTimeoutMs: options.closeDrainTimeoutMs }
        : {}),
    });
  }

  recoverInterruptedRuns(reason?: string): CronRunRecord[] {
    return [...this.lifecycle.recoverInterruptedRuns(reason)];
  }

  runNow(cronJobId: string): CronRunRecord {
    return this.lifecycle.runNow(cronJobId);
  }

  start(): void {
    this.lifecycle.start();
  }

  beginClose(): void {
    this.lifecycle.beginClose();
  }

  close(): Promise<void> {
    return this.lifecycle.close();
  }

  hasPendingOwnership(): boolean {
    return this.lifecycle.hasPendingOwnership();
  }

  waitForOwnershipRelease(): Promise<void> {
    return this.lifecycle.waitForOwnershipRelease();
  }
}

export interface CronWorkspaceRuntimeFactoryInput {
  workspacePath: string;
  ownerId: string;
}

export interface ManagedCronWorkspaceRuntime {
  recoverInterruptedRuns(reason?: string): readonly CronRunRecord[];
  runNow(cronJobId: string): CronRunRecord;
  start(): void;
  /** Stops timers and rejects new manual Runs before asynchronous drain begins. */
  beginClose(): void;
  close(): Promise<void>;
  hasPendingOwnership(): boolean;
  waitForOwnershipRelease(): Promise<void>;
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
