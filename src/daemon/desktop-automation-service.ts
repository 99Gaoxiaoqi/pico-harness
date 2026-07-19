import type { EffectiveConfigResolver } from "../input/effective-config.js";
import type { UserConfigStore } from "../input/user-config-store.js";
import { resolveAutomationCredentialTarget } from "../provider/automation-credential.js";
import {
  parseAnyCredentialRef,
  type CredentialRef,
  type CredentialVault,
} from "../provider/credential-vault.js";
import { resolveModelRouteCapabilities } from "../provider/model-capabilities.js";
import type { ModelRoute } from "../provider/model-router.js";
import { fingerprintBackgroundMcpConfig } from "../safety/background-mcp-policy.js";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
  filterBackgroundEligibleTools,
} from "../safety/background-yolo-policy.js";
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
  /** Re-validates a persisted Job against the latest Provider/config/vault state. */
  validateSecurity(job: CronJobRecord): Promise<void>;
  ensureWorkspaceRuntime(workspacePath: string): Promise<void>;
  runNow(workspacePath: string, jobId: string): Promise<CronRunRecord>;
  picoHome?: string;
  now?: () => number;
}

export interface DesktopAutomationAuthorityDependencies {
  readonly credentialVault: CredentialVault;
  readonly effectiveConfigResolver: EffectiveConfigResolver;
  readonly userConfigStore: UserConfigStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Foreground-only Plugin tools rejected before an Automation is persisted. */
  readonly foregroundOnlyTools?: ReadonlySet<string>;
  readonly now?: () => number;
}

export interface DesktopAutomationCredentialImport {
  readonly modelRouteId: string;
  readonly expectedCredentialRef: string;
  readonly secret: string;
}

export interface DesktopTrustedAutomationInput {
  readonly name?: string;
  readonly prompt: string;
  readonly schedule: string;
  readonly timeZone?: string;
  readonly modelRouteId: string;
  readonly expectedCredentialRef: string;
  readonly allowedTools: readonly string[];
  readonly toolNetworkPolicy: "allow" | "disabled" | "allowlist";
  readonly allowedToolNetworkHosts?: readonly string[];
  readonly enabled?: boolean;
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
    const security = await this.options.prepareSecurity(workspacePath);
    return this.createWithSecurity(workspacePath, input, security);
  }

  /** Trusted daemon-only path used by TUI Cron after policy and authority validation. */
  async createWithSecurity(
    workspacePath: string,
    input: {
      name?: string;
      prompt: string;
      schedule: string;
      timeZone?: string;
      enabled?: boolean;
    },
    security: DesktopAutomationSecurity,
  ): Promise<RuntimeJob> {
    const name = input.name === undefined ? undefined : requiredText(input.name, "name");
    const prompt = requiredText(input.prompt, "prompt");
    const schedule = requiredText(input.schedule, "schedule");
    let created = this.withCron(workspacePath, (cron) =>
      cron.create({
        workspacePath,
        ...(name ? { name } : {}),
        prompt,
        schedule,
        ...(input.timeZone ? { timeZone: requiredText(input.timeZone, "timeZone") } : {}),
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

  async setEnabled(workspacePath: string, jobId: string, enabled: boolean): Promise<RuntimeJob> {
    const current = this.withCron(workspacePath, (cron) =>
      requireWorkspaceJob(cron, workspacePath, jobId),
    );
    if (enabled) await this.options.validateSecurity(current);
    return this.withCron(workspacePath, (cron) => {
      const latest = requireWorkspaceJob(cron, workspacePath, jobId);
      if (latest.version !== current.version) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `Automation ${jobId} 在安全校验期间已变化，请刷新后重试`,
        );
      }
      if (latest.enabled === enabled) return this.projectJob(cron, latest);
      return this.projectJob(cron, cron.setEnabled(jobId, latest.version, enabled));
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

  /**
   * Provider dependencies include durable enabled jobs and queued/running Cron
   * Runs. A disabled job therefore keeps its Provider alive until a manual Run
   * reaches a terminal state.
   */
  providerReferences(
    providerId: string,
    workspacePaths: readonly string[],
  ): AutomationProviderReference[] {
    const references = new Map<string, AutomationProviderReference>();
    for (const reference of this.enabledReferences(workspacePaths)) {
      if (providerIdForReference(reference) !== providerId) continue;
      references.set(`${reference.workspacePath}:${reference.jobId}`, reference);
    }
    for (const reference of this.activeRunReferences(workspacePaths)) {
      if (providerIdForReference(reference) !== providerId) continue;
      references.set(`${reference.workspacePath}:${reference.jobId}`, reference);
    }
    return [...references.values()];
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
            ...(job.credentialRef ? { credentialRef: job.credentialRef } : {}),
          });
        }
      });
    }
    return references;
  }

  activeRunReferences(workspacePaths: readonly string[]): ActiveAutomationReference[] {
    const references: ActiveAutomationReference[] = [];
    for (const workspacePath of workspacePaths) {
      this.withCron(workspacePath, (cron) => {
        for (const run of cron.store.listActiveCronRuns(workspacePath)) {
          const job = cron.store.getCronJob(run.cronJobId);
          if (!job) continue;
          references.push({
            workspacePath,
            jobId: job.cronJobId,
            runId: run.cronRunId,
            ...(job.modelRouteId ? { modelRouteId: job.modelRouteId } : {}),
            ...(job.credentialRef ? { credentialRef: job.credentialRef } : {}),
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
      ...(this.options.picoHome ? { picoHome: this.options.picoHome } : {}),
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

export async function importDesktopAutomationCredential(
  workspacePath: string,
  input: DesktopAutomationCredentialImport,
  dependencies: DesktopAutomationAuthorityDependencies,
): Promise<{ readonly imported: true; readonly credentialRef: CredentialRef }> {
  const capability = dependencies.credentialVault.capability();
  if (!capability.available) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.FORBIDDEN, capability.diagnostic);
  }
  const target = await resolveDesktopAutomationTarget(
    workspacePath,
    input.modelRouteId,
    dependencies,
  );
  if (target.ref !== input.expectedCredentialRef) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      "Automation Provider authority 已变化，请刷新配置后重试",
    );
  }
  await dependencies.credentialVault.put(target.ref, requireSecret(input.secret));
  return { imported: true, credentialRef: target.ref };
}

export async function createTrustedDesktopAutomation(
  automations: DesktopAutomationService,
  workspacePath: string,
  input: DesktopTrustedAutomationInput,
  dependencies: DesktopAutomationAuthorityDependencies,
): Promise<RuntimeJob> {
  const requestedTools = uniqueNonEmptyStrings(input.allowedTools, "allowedTools");
  const foregroundOnlyTools = requestedTools.filter((tool) =>
    dependencies.foregroundOnlyTools?.has(tool),
  );
  if (foregroundOnlyTools.length > 0) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.FORBIDDEN,
      `Automation 不支持前台 Plugin 工具: ${foregroundOnlyTools.join(", ")}`,
    );
  }
  const eligibleTools = filterBackgroundEligibleTools(requestedTools);
  if (!sameStringValues(requestedTools, eligibleTools)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.FORBIDDEN,
      "Automation 包含不允许在后台运行的交互式工具",
    );
  }
  const target = await resolveDesktopAutomationTarget(
    workspacePath,
    input.modelRouteId,
    dependencies,
  );
  if (target.ref !== input.expectedCredentialRef) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      "Automation Provider authority 已变化，请刷新配置后重试",
    );
  }
  if (!(await dependencies.credentialVault.has(target.ref))) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      `模型路由 ${input.modelRouteId} 尚未导入系统凭证库`,
    );
  }
  const allowedHosts = uniqueNonEmptyStrings(
    input.allowedToolNetworkHosts ?? [],
    "allowedToolNetworkHosts",
  );
  if (input.toolNetworkPolicy === "allowlist" && allowedHosts.length === 0) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "toolNetworkPolicy=allowlist 时必须提供 allowedToolNetworkHosts",
    );
  }
  if (input.toolNetworkPolicy !== "allowlist" && allowedHosts.length > 0) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "只有 toolNetworkPolicy=allowlist 可提供 allowedToolNetworkHosts",
    );
  }
  const mcpConfigFingerprint = requestedTools.some((tool) => tool.startsWith("mcp__"))
    ? await fingerprintBackgroundMcpConfig(workspacePath)
    : undefined;
  return automations.createWithSecurity(
    workspacePath,
    {
      ...(input.name ? { name: input.name } : {}),
      prompt: input.prompt,
      schedule: input.schedule,
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      enabled: input.enabled,
    },
    {
      credentialRef: target.ref,
      modelRouteId: input.modelRouteId,
      policySnapshot: {
        mode: "yolo",
        backgroundEnabled: true,
        trustedWorkspace: true,
        toolNetworkPolicy: input.toolNetworkPolicy,
        ...(allowedHosts.length > 0 ? { allowedToolNetworkHosts: allowedHosts } : {}),
        ...(mcpConfigFingerprint ? { mcpConfigFingerprint } : {}),
        allowedTools: requestedTools,
        hardlineVersion: BACKGROUND_HARDLINE_VERSION,
        hookVersion: BACKGROUND_HOOK_VERSION,
        createdAt: (dependencies.now ?? Date.now)(),
      },
    },
  );
}

async function resolveDesktopAutomationTarget(
  workspacePath: string,
  modelRouteId: string,
  dependencies: DesktopAutomationAuthorityDependencies,
) {
  const normalizedRouteId = requiredText(modelRouteId, "modelRouteId");
  const separator = normalizedRouteId.indexOf("/");
  if (separator <= 0 || separator === normalizedRouteId.length - 1) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "modelRouteId 必须采用 providerID/modelID 格式",
    );
  }
  const providerId = normalizedRouteId.slice(0, separator);
  const model = normalizedRouteId.slice(separator + 1);
  const effective = await dependencies.effectiveConfigResolver.resolve({
    workDir: workspacePath,
    projectTrusted: true,
    env: dependencies.env,
  });
  const provider = effective.providers[providerId];
  if (!provider || !provider.models.includes(model)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      `模型路由 ${normalizedRouteId} 已不存在，请刷新配置后重试`,
    );
  }
  const route: ModelRoute = {
    id: normalizedRouteId,
    providerId,
    provider: provider.protocol,
    model,
    baseURL: provider.baseURL,
    apiKeyEnv: provider.apiKeyEnv,
    source: "config",
    capabilities: resolveModelRouteCapabilities(
      provider.protocol,
      model,
      provider.modelCapabilities?.[model],
      { baseURL: provider.baseURL },
    ),
  };
  const userProvider = (await dependencies.userConfigStore.read()).config.providers[providerId];
  try {
    return resolveAutomationCredentialTarget({
      route,
      workspacePath,
      ...(userProvider ? { userProvider } : {}),
      configSource: effective.sources[`providers.${providerId}`],
    });
  } catch (error) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.FORBIDDEN,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export interface EnabledAutomationReference {
  readonly workspacePath: string;
  readonly jobId: string;
  readonly modelRouteId?: string;
  readonly credentialRef?: CredentialRef;
}

export interface ActiveAutomationReference extends EnabledAutomationReference {
  readonly runId: string;
}

export type AutomationProviderReference = EnabledAutomationReference | ActiveAutomationReference;

function providerIdForReference(reference: AutomationProviderReference): string | undefined {
  const routeProviderId = providerIdForRoute(reference.modelRouteId);
  if (routeProviderId) return routeProviderId;
  if (!reference.credentialRef) return undefined;
  try {
    const parsed = parseAnyCredentialRef(reference.credentialRef);
    return parsed.version === "v2" ? parsed.providerId : providerIdForRoute(parsed.modelRouteId);
  } catch {
    return undefined;
  }
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

function requireSecret(value: string): string {
  if (!value.trim() || /[\r\n]/u.test(value)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "secret 必须是不含换行的非空字符串",
    );
  }
  return value.trim();
}

function uniqueNonEmptyStrings(values: readonly string[], label: string): string[] {
  return [...new Set(values.map((value) => requiredText(value, label)))];
}

function sameStringValues(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
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
