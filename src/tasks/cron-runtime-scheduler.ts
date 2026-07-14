import type { CronJobRecord, CronRunRecord } from "./runtime-types.js";
import { CronService, type CronTickResult } from "./cron-service.js";
import {
  WorkspaceTaskRuntime,
  type WorkspaceRunContext,
  type WorkspaceRunSnapshot,
} from "../runtime/workspace-runtime.js";

export interface CronRuntimeSchedulerOptions {
  cronService: CronService;
  /** daemon owns runtimes; scheduler merely asks for the workspace selected by a Job. */
  getWorkspaceRuntime(workspacePath: string): Promise<WorkspaceTaskRuntime>;
  execute(
    job: CronJobRecord,
    context: WorkspaceRunContext,
  ): Promise<Record<string, unknown> | void>;
  /** Revalidates trust/hardline/hooks immediately before a background run starts. */
  canRun(job: CronJobRecord): Promise<{ allowed: boolean; reason?: string }>;
  /** Must stay shorter than the SQLite lease TTL used by CronService. */
  leaseHeartbeatMs?: number;
  now?: () => number;
}

/**
 * Executes durable Cron ledger entries through WorkspaceTaskRuntime.
 * The scheduler deliberately never queues a second run for a busy workspace: the
 * corresponding ledger row is terminal `skipped`, so a daemon restart cannot replay it.
 */
export class CronRuntimeScheduler {
  private readonly now: () => number;
  private readonly leaseHeartbeatMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private readonly activeTicks = new Set<Promise<void>>();

  constructor(private readonly options: CronRuntimeSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.leaseHeartbeatMs = Math.max(1_000, options.leaseHeartbeatMs ?? 10_000);
  }

  async tick(at = this.now()): Promise<CronTickResult> {
    const tick = this.options.cronService.tick(at);
    await Promise.all(tick.runs.map((run) => this.dispatch(run)));
    return tick;
  }

  /** Persist a manual trigger and dispatch it without blocking the IPC response. */
  runNow(cronJobId: string): CronRunRecord {
    const run = this.options.cronService.runNow(cronJobId);
    this.track(this.dispatch(run));
    return run;
  }

  /** Starts a minute-aligned loop. Calling it twice is idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.launchTick();
    this.scheduleNextMinute();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async stopAndWait(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.activeTicks]);
  }

  private scheduleNextMinute(): void {
    if (!this.running) return;
    const delay = 60_000 - (this.now() % 60_000) + 5;
    this.timer = setTimeout(() => {
      this.launchTick(true);
    }, delay);
  }

  private launchTick(scheduleAfter = false): void {
    const active = this.tick().then(
      () => undefined,
      () => undefined,
    );
    this.track(active, scheduleAfter);
  }

  private track(active: Promise<void>, scheduleAfter = false): void {
    const settled = active.then(
      () => undefined,
      () => undefined,
    );
    this.activeTicks.add(settled);
    void settled.finally(() => {
      this.activeTicks.delete(settled);
      if (scheduleAfter) this.scheduleNextMinute();
    });
  }

  private async dispatch(initial: CronRunRecord): Promise<void> {
    if (initial.status !== "queued") return;
    let job: CronJobRecord;
    let runtime: WorkspaceTaskRuntime;
    let claimed: ReturnType<CronService["claim"]>;
    try {
      const currentJob = this.options.cronService.store.getCronJob(initial.cronJobId);
      if (!currentJob) {
        this.options.cronService.block(initial.cronRunId, "job_missing");
        return;
      }
      job = currentJob;
      const decision = await this.options.canRun(job);
      if (!decision.allowed) {
        this.options.cronService.block(initial.cronRunId, decision.reason ?? "policy_blocked");
        return;
      }
      runtime = await this.options.getWorkspaceRuntime(job.workspacePath);
      if (runtime.listRuns().some((run) => !isTerminal(run))) {
        this.options.cronService.skip(initial.cronRunId);
        return;
      }
      claimed = this.options.cronService.claim(initial.cronRunId);
    } catch (error) {
      this.blockQueuedAfterPreflightFailure(initial.cronRunId, error);
      return;
    }
    if (claimed.run.status !== "running" || !claimed.lease) return;
    let run: WorkspaceRunSnapshot;
    try {
      run = runtime.startRun({ description: job.prompt }, (context) =>
        this.options.execute(job, context),
      );
    } catch (error) {
      this.options.cronService.finish({
        cronRunId: claimed.run.cronRunId,
        leaseEpoch: claimed.lease.leaseEpoch,
        expectedVersion: claimed.run.version,
        status: "failed",
        reason: errorMessage(error),
      });
      return;
    }
    const heartbeat = setInterval(() => {
      try {
        this.options.cronService.heartbeat(claimed.run.cronRunId, claimed.lease!.leaseEpoch);
      } catch {
        // The completion CAS below is authoritative. Do not silently extend an
        // ownership lease after another daemon has taken it.
        runtime.cancel(run.runId, "cron lease lost");
      }
    }, this.leaseHeartbeatMs);
    heartbeat.unref?.();
    try {
      const terminal = await runtime.waitForRun(run.runId);
      this.options.cronService.finish({
        cronRunId: claimed.run.cronRunId,
        leaseEpoch: claimed.lease.leaseEpoch,
        expectedVersion: claimed.run.version,
        status:
          terminal.status === "succeeded"
            ? "succeeded"
            : terminal.status === "cancelled"
              ? "cancelled"
              : "failed",
        ...(terminal.error ? { reason: terminal.error } : {}),
        ...(terminal.result ? { result: terminal.result } : {}),
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private blockQueuedAfterPreflightFailure(cronRunId: string, error: unknown): void {
    const current = this.options.cronService.store.getCronRun(cronRunId);
    if (current?.status !== "queued") return;
    try {
      this.options.cronService.block(
        cronRunId,
        `scheduler_preflight_failed:${errorMessage(error)}`,
      );
    } catch {
      // Another scheduler may have claimed or terminalized the run after the read.
      // Its durable state is authoritative, so never overwrite it here.
    }
  }
}

function isTerminal(run: WorkspaceRunSnapshot): boolean {
  return run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
