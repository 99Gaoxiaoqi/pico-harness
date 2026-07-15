import type { ModelRoute } from "../provider/model-router.js";
import { type CredentialVault } from "../provider/credential-vault.js";
import {
  importAutomationCredential,
  resolveAutomationCredentialTarget,
  type AutomationCredentialTarget,
} from "../provider/automation-credential.js";
import { fingerprintBackgroundMcpConfig } from "../safety/background-mcp-policy.js";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
  filterBackgroundEligibleTools,
} from "../safety/background-yolo-policy.js";
import type { CronCreationReceipt, CronDraft } from "./cron-draft.js";
import { nextCronRuns, type CronService } from "./cron-service.js";

export interface CronWorkspaceRegistrar {
  registerWorkspace(workspacePath: string): Promise<{ available: boolean; message: string }>;
  statusWorkspace(workspacePath: string): Promise<{ available: boolean; message: string }>;
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

    const mcpConfigFingerprint = draft.allowedTools.some((tool) => tool.startsWith("mcp__"))
      ? await fingerprintBackgroundMcpConfig(this.options.workspacePath)
      : undefined;
    signal?.throwIfAborted();

    const vault = this.options.credentialVault;
    if (!vault.capability().available) throw new Error(vault.capability().diagnostic);
    const credential = await this.resolveCredentialTarget(route);
    if (!(await vault.has(credential.ref))) {
      await importAutomationCredential({
        target: credential,
        route,
        workspacePath: this.options.workspacePath,
        vault,
        env: this.options.credentialEnv ?? process.env,
      });
    }
    signal?.throwIfAborted();

    const job = this.options.cronService.create({
      workspacePath: this.options.workspacePath,
      schedule: draft.cronExpression,
      timeZone: draft.timeZone,
      prompt: draft.prompt,
      credentialRef: credential.ref,
      modelRouteId: route.id,
      enabled: false,
      policySnapshot: {
        mode: "yolo",
        backgroundEnabled: true,
        trustedWorkspace: true,
        toolNetworkPolicy: "allow",
        allowedTools: [...draft.allowedTools],
        hardlineVersion: BACKGROUND_HARDLINE_VERSION,
        hookVersion: BACKGROUND_HOOK_VERSION,
        createdAt: this.now(),
        ...(mcpConfigFingerprint ? { mcpConfigFingerprint } : {}),
      },
    });

    const registration = await this.options.workspaceRegistrar
      .registerWorkspace(this.options.workspacePath)
      .catch(() => ({ available: false, message: "本机 Runtime daemon 当前不可达" }));
    const finalJob = registration.available
      ? this.options.cronService.setEnabled(job.cronJobId, job.version, true)
      : job;
    const nextRun = nextCronRuns(finalJob.schedule, finalJob.timeZone, this.now(), 1)[0];
    return {
      cronJobId: finalJob.cronJobId,
      enabled: finalJob.enabled,
      schedule: finalJob.schedule,
      timeZone: finalJob.timeZone,
      ...(nextRun !== undefined ? { nextRun } : {}),
      daemonMessage: registration.message,
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

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
