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
  policyGuard?: CronPolicyGuard;
}

/** A daemon-owned Cron ledger and scheduler for one canonical workspace. */
export class CronWorkspaceRuntime {
  readonly cronService: CronService;
  readonly scheduler: CronRuntimeScheduler;
  private closed = false;

  constructor(options: CronWorkspaceRuntimeOptions) {
    this.cronService = new CronService({
      workDir: options.workspacePath,
      ownerId: options.ownerId,
      ...(options.databasePath ? { databasePath: options.databasePath } : {}),
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
  }

  recoverInterruptedRuns(reason?: string): CronRunRecord[] {
    return this.cronService.recoverInterruptedRuns(reason);
  }

  start(): void {
    if (this.closed) throw new Error("Cron workspace runtime 已关闭");
    this.scheduler.start();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.scheduler.stopAndWait();
    this.cronService.close();
  }
}

export interface CronWorkspaceRuntimeFactoryInput {
  workspacePath: string;
  ownerId: string;
}

export interface ManagedCronWorkspaceRuntime {
  recoverInterruptedRuns(reason?: string): readonly CronRunRecord[];
  start(): void;
  close(): Promise<void>;
}

export interface CronWorkspaceRuntimeFactory {
  create(input: CronWorkspaceRuntimeFactoryInput): Promise<ManagedCronWorkspaceRuntime>;
}

export function createCronWorkspaceRuntimeFactory(options: {
  getWorkspaceRuntime(workspacePath: string): Promise<WorkspaceTaskRuntime>;
  execute: CronRuntimeSchedulerOptions["execute"];
  canRun: CronRuntimeSchedulerOptions["canRun"];
  policyGuard?: CronPolicyGuard;
  leaseHeartbeatMs?: number;
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
        ...(options.policyGuard ? { policyGuard: options.policyGuard } : {}),
        ...(options.leaseHeartbeatMs ? { leaseHeartbeatMs: options.leaseHeartbeatMs } : {}),
        ...(options.now ? { now: options.now } : {}),
      }),
  };
}
