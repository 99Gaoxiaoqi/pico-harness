import type { CredentialRef } from "../provider/credential-vault.js";
import { CronService } from "../tasks/cron-service.js";
import { RuntimeConflictError } from "../tasks/runtime-store.js";
import type { CronJobRecord, CronRunRecord, YoloPolicySnapshot } from "../tasks/runtime-types.js";
import {
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type RuntimeJob,
  type RuntimeRun,
} from "./protocol.js";

export interface DesktopAutomationSecurity {
  readonly policySnapshot: YoloPolicySnapshot;
  readonly credentialRef: CredentialRef;
  /** 创建时固定的 Provider/模型路由；v1 兼容调用方可省略并由 credentialRef 反推。 */
  readonly modelRouteId?: string;
}

export interface DesktopAutomationServiceOptions {
  prepareSecurity(workspacePath: string): Promise<DesktopAutomationSecurity>;
  ensureWorkspaceRuntime(workspacePath: string): Promise<void>;
  runNow(workspacePath: string, jobId: string): Promise<CronRunRecord>;
  now?: () => number;
}

/**
 * Typed desktop adapter over the existing Cron SQLite ledger. It never keeps a
 * renderer-owned copy: every response is projected from the durable records.
 */
export class DesktopAutomationService {
  constructor(private readonly options: DesktopAutomationServiceOptions) {}

  list(workspacePath: string): RuntimeJob[] {
    return this.withCron(workspacePath, (cron) =>
      cron.list(workspacePath).map((job) => this.projectJob(cron, job)),
    );
  }

  async create(
    workspacePath: string,
    input: { name: string; prompt: string; schedule: string; enabled?: boolean },
  ): Promise<RuntimeJob> {
    const name = requiredText(input.name, "name");
    const prompt = requiredText(input.prompt, "prompt");
    const schedule = requiredText(input.schedule, "schedule");
    const security = await this.options.prepareSecurity(workspacePath);
    let created = this.withCron(workspacePath, (cron) =>
      cron.create({
        workspacePath,
        name,
        prompt,
        schedule,
        enabled: false,
        policySnapshot: security.policySnapshot,
        credentialRef: security.credentialRef,
        modelRouteId: security.modelRouteId,
      }),
    );
    try {
      await this.options.ensureWorkspaceRuntime(workspacePath);
      if (input.enabled !== false) {
        created = this.withCron(workspacePath, (cron) =>
          cron.setEnabled(created.cronJobId, created.version, true),
        );
      }
      return this.withCron(workspacePath, (cron) => this.projectJob(cron, created));
    } catch (error) {
      // The durable disabled row is intentionally retained for diagnosis/retry.
      throw desktopAutomationError(error);
    }
  }

  update(
    workspacePath: string,
    jobId: string,
    patch: { name?: string; prompt?: string; schedule?: string },
  ): RuntimeJob {
    if (patch.name === undefined && patch.prompt === undefined && patch.schedule === undefined) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "jobs.update 至少需要一个可修改字段",
      );
    }
    return this.withCron(workspacePath, (cron) => {
      const current = requireWorkspaceJob(cron, workspacePath, jobId);
      const updated = cron.update(jobId, current.version, {
        ...(patch.name === undefined ? {} : { name: requiredText(patch.name, "name") }),
        ...(patch.prompt === undefined ? {} : { prompt: requiredText(patch.prompt, "prompt") }),
        ...(patch.schedule === undefined
          ? {}
          : { schedule: requiredText(patch.schedule, "schedule") }),
      });
      return this.projectJob(cron, updated);
    });
  }

  delete(workspacePath: string, jobId: string): boolean {
    return this.withCron(workspacePath, (cron) => {
      const current = requireWorkspaceJob(cron, workspacePath, jobId);
      cron.delete(jobId, current.version);
      return true;
    });
  }

  setEnabled(workspacePath: string, jobId: string, enabled: boolean): RuntimeJob {
    return this.withCron(workspacePath, (cron) => {
      const current = requireWorkspaceJob(cron, workspacePath, jobId);
      if (current.enabled === enabled) return this.projectJob(cron, current);
      return this.projectJob(cron, cron.setEnabled(jobId, current.version, enabled));
    });
  }

  async runNow(workspacePath: string, jobId: string): Promise<{ job: RuntimeJob; runId: string }> {
    this.withCron(workspacePath, (cron) => requireWorkspaceJob(cron, workspacePath, jobId));
    const run = await this.options.runNow(workspacePath, jobId).catch((error: unknown) => {
      throw desktopAutomationError(error);
    });
    const job = this.withCron(workspacePath, (cron) => {
      const current = requireWorkspaceJob(cron, workspacePath, jobId);
      return this.projectJob(cron, current);
    });
    return { job, runId: run.cronRunId };
  }

  history(workspacePath: string, jobId: string, limit?: number): RuntimeRun[] {
    const normalizedLimit = normalizeLimit(limit);
    return this.withCron(workspacePath, (cron) => {
      const job = requireWorkspaceJob(cron, workspacePath, jobId);
      return cron
        .runs({ cronJobId: jobId, workspacePath, limit: normalizedLimit })
        .map((run) => projectRun(job, run));
    });
  }

  enabledProviderReferences(
    providerId: string,
    workspacePaths: readonly string[],
  ): Array<EnabledAutomationReference & { readonly modelRouteId: string }> {
    return this.enabledReferences(workspacePaths).filter(
      (reference): reference is EnabledAutomationReference & { readonly modelRouteId: string } =>
        providerIdForRoute(reference.modelRouteId) === providerId &&
        reference.modelRouteId !== undefined,
    );
  }

  enabledReferences(workspacePaths: readonly string[]): EnabledAutomationReference[] {
    const references: EnabledAutomationReference[] = [];
    for (const workspacePath of workspacePaths) {
      this.withCron(workspacePath, (cron) => {
        for (const job of cron.store.listCronJobs({ workspacePath, enabled: true })) {
          references.push({
            workspacePath,
            jobId: job.cronJobId,
            ...(job.modelRouteId ? { modelRouteId: job.modelRouteId } : {}),
          });
        }
      });
    }
    return references;
  }

  private projectJob(cron: CronService, job: CronJobRecord): RuntimeJob {
    const latest = cron.runs({ cronJobId: job.cronJobId, limit: 1 })[0];
    return {
      jobId: job.cronJobId,
      workspacePath: job.workspacePath,
      name: job.name,
      prompt: job.prompt,
      schedule: job.schedule,
      enabled: job.enabled,
      status: jobStatus(latest),
      updatedAt: Math.max(job.updatedAt, latest?.finishedAt ?? latest?.createdAt ?? 0),
      timeZone: job.timeZone,
      version: job.version,
      ...(job.modelRouteId ? { modelRouteId: job.modelRouteId } : {}),
      ...(latest ? { latestRunId: latest.cronRunId } : {}),
    };
  }

  private withCron<Result>(
    workspacePath: string,
    operation: (cron: CronService) => Result,
  ): Result {
    const cron = new CronService({
      workDir: workspacePath,
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    try {
      return operation(cron);
    } catch (error) {
      throw desktopAutomationError(error);
    } finally {
      cron.close();
    }
  }
}

export interface EnabledAutomationReference {
  readonly workspacePath: string;
  readonly jobId: string;
  readonly modelRouteId?: string;
}

function providerIdForRoute(modelRouteId: string | undefined): string | undefined {
  if (!modelRouteId) return undefined;
  const separator = modelRouteId.indexOf("/");
  return separator > 0 ? modelRouteId.slice(0, separator) : undefined;
}

function requireWorkspaceJob(
  cron: CronService,
  workspacePath: string,
  jobId: string,
): CronJobRecord {
  const job = cron.store.getCronJob(jobId);
  if (!job || job.workspacePath !== workspacePath) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.NOT_FOUND,
      `Automation ${jobId} 不存在于工作区 ${workspacePath}`,
    );
  }
  return job;
}

function projectRun(job: CronJobRecord, run: CronRunRecord): RuntimeRun {
  const status =
    run.status === "queued" || run.status === "running"
      ? "running"
      : run.status === "succeeded"
        ? "succeeded"
        : run.status === "cancelled"
          ? "cancelled"
          : "failed";
  return {
    runId: run.cronRunId,
    workspacePath: run.workspacePath,
    description: job.prompt,
    status,
    startedAt: run.startedAt ?? run.scheduledFor,
    updatedAt: run.finishedAt ?? run.startedAt ?? run.createdAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.reason === undefined ? {} : { error: run.reason }),
    version: run.version,
    scheduledFor: run.scheduledFor,
    cronStatus: run.status,
  };
}

function jobStatus(run: CronRunRecord | undefined): RuntimeJob["status"] {
  if (!run) return "idle";
  if (run.status === "queued" || run.status === "running") return "running";
  if (run.status === "succeeded") return "succeeded";
  return "failed";
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, `${field} 必须是非空字符串`);
  }
  return normalized;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "jobs.history limit 必须是 1..10000 的整数",
    );
  }
  return limit;
}

function desktopAutomationError(error: unknown): Error {
  if (error instanceof RuntimeProtocolError) return error;
  if (error instanceof RuntimeConflictError) {
    return new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/Cron (?:Job name|Job prompt|表达式|起始时间|运行次数)|Cron .* 字段/u.test(message)) {
    return new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, message);
  }
  return error instanceof Error ? error : new Error(message);
}
