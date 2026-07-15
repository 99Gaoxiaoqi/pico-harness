import type { ModelRoute } from "../provider/model-router.js";
import { type CredentialVault } from "../provider/credential-vault.js";
import {
  resolveAutomationCredentialTarget,
  type AutomationCredentialTarget,
} from "../provider/automation-credential.js";
import { filterBackgroundEligibleTools } from "../safety/background-yolo-policy.js";
import type { CronCreationReceipt, CronDraft } from "./cron-draft.js";
import { nextCronRuns, type CronService } from "./cron-service.js";

export interface CronWorkspaceRegistrar {
  registerWorkspace(workspacePath: string): Promise<{ available: boolean; message: string }>;
  statusWorkspace(workspacePath: string): Promise<{ available: boolean; message: string }>;
  importAutomationCredential?(input: {
    workspacePath: string;
    modelRouteId: string;
    expectedCredentialRef: string;
    secret: string;
  }): Promise<{ status: "ok" | "unavailable" | "rejected"; message: string }>;
  createAutomation?(input: {
    workspacePath: string;
    prompt: string;
    schedule: string;
    timeZone?: string;
    modelRouteId: string;
    expectedCredentialRef: string;
    allowedTools: readonly string[];
    toolNetworkPolicy: "allow" | "disabled" | "allowlist";
    enabled?: boolean;
  }): Promise<
    | {
        status: "ok";
        message: string;
        job: {
          jobId: string;
          enabled: boolean;
          schedule: string;
          timeZone?: unknown;
        };
      }
    | { status: "unavailable" | "rejected"; message: string }
  >;
}

export interface CronDraftApplicationOptions {
  cronService: CronService;
  workspacePath: string;
  resolveModelRoute: () => ModelRoute;
  listAllowedTools: () => readonly string[];
  credentialVault: CredentialVault;
  credentialEnv?: Readonly<Record<string, string | undefined>>;
  /** Host-supplied source-aware resolver; TUI uses it to prefer shared v2 credentials. */
  resolveCredentialTarget?: (route: ModelRoute) => Promise<AutomationCredentialTarget>;
  workspaceRegistrar: CronWorkspaceRegistrar;
  now?: () => number;
}

/** TUI-owned application service behind the ephemeral draft coordinator. */
export class CronDraftApplication {
  private readonly now: () => number;

  constructor(private readonly options: CronDraftApplicationOptions) {
    this.now = options.now ?? Date.now;
  }

  async context(): Promise<{
    workspacePath: string;
    modelRouteId: string;
    allowedTools: string[];
    credentialStatus: CronDraft["credentialStatus"];
    daemonStatus: string;
  }> {
    const route = this.requireConfiguredRoute();
    const allowedTools = filterBackgroundEligibleTools(this.options.listAllowedTools());
    const capability = this.options.credentialVault.capability();
    let credentialStatus: CronDraft["credentialStatus"] = "unavailable";
    if (capability.available) {
      const target = await this.resolveCredentialTarget(route);
      credentialStatus = (await this.options.credentialVault.has(target.ref))
        ? "available"
        : "missing";
    }
    const daemonStatus = await this.options.workspaceRegistrar
      .statusWorkspace(this.options.workspacePath)
      .then(
        (status) => status.message,
        () => "本机 Runtime daemon 当前不可达",
      );
    return {
      workspacePath: this.options.workspacePath,
      modelRouteId: route.id,
      allowedTools,
      credentialStatus,
      daemonStatus,
    };
  }

  async commit(draft: CronDraft, signal?: AbortSignal): Promise<CronCreationReceipt> {
    signal?.throwIfAborted();
    const route = this.requireConfiguredRoute();
    if (route.id !== draft.modelRouteId) {
      throw new Error("草案创建后模型路由已变化，请重新提交定时任务");
    }
    const currentTools = filterBackgroundEligibleTools(this.options.listAllowedTools());
    if (!sameStringSet(currentTools, draft.allowedTools)) {
      throw new Error("草案创建后可用工具已变化，请重新提交定时任务");
    }

    const vault = this.options.credentialVault;
    if (!vault.capability().available) throw new Error(vault.capability().diagnostic);
    const credential = await this.resolveCredentialTarget(route);
    if (!(await vault.has(credential.ref))) {
      const importer = this.options.workspaceRegistrar.importAutomationCredential;
      if (!importer) {
        throw new Error("本机 Runtime daemon 不支持安全的 Automation 凭证导入");
      }
      const secret = firstCredentialSecret(
        (this.options.credentialEnv ?? process.env)[route.apiKeyEnv],
      );
      if (!secret) throw new Error(`缺少凭证环境变量 ${route.apiKeyEnv}，无法导入。`);
      const imported = await importer({
        workspacePath: this.options.workspacePath,
        modelRouteId: route.id,
        expectedCredentialRef: credential.ref,
        secret,
      });
      if (imported.status !== "ok") throw new Error(imported.message);
    }
    signal?.throwIfAborted();
    const create = this.options.workspaceRegistrar.createAutomation;
    if (!create) throw new Error("本机 Runtime daemon 不支持安全的 Automation 创建");
    const result = await create({
      workspacePath: this.options.workspacePath,
      schedule: draft.cronExpression,
      timeZone: draft.timeZone,
      prompt: draft.prompt,
      modelRouteId: route.id,
      expectedCredentialRef: credential.ref,
      allowedTools: draft.allowedTools,
      toolNetworkPolicy: "allow",
      enabled: true,
    });
    if (result.status !== "ok") throw new Error(result.message);
    const finalJob = result.job;
    const timeZone = typeof finalJob.timeZone === "string" ? finalJob.timeZone : draft.timeZone;
    const nextRun = nextCronRuns(finalJob.schedule, timeZone, this.now(), 1)[0];
    return {
      cronJobId: finalJob.jobId,
      enabled: finalJob.enabled,
      schedule: finalJob.schedule,
      timeZone,
      ...(nextRun !== undefined ? { nextRun } : {}),
      daemonMessage: result.message,
    };
  }

  private requireConfiguredRoute(): ModelRoute {
    const route = this.options.resolveModelRoute();
    if (route.source === "legacy") {
      throw new Error("后台定时任务需要 .pico/config.json 中的 providerID/modelID 路由");
    }
    return route;
  }

  private async resolveCredentialTarget(route: ModelRoute): Promise<AutomationCredentialTarget> {
    return this.options.resolveCredentialTarget
      ? this.options.resolveCredentialTarget(route)
      : resolveAutomationCredentialTarget({
          route,
          workspacePath: this.options.workspacePath,
        });
  }
}

function firstCredentialSecret(value: string | undefined): string | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .find(Boolean);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
