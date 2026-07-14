import { AgentRuntime } from "../runtime/agent-runtime.js";
import { SilentReporter } from "../engine/reporter.js";
import { loadPicoConfig } from "../input/pico-config.js";
import {
  assertCredentialRefMatchesModelRoute,
  createPlatformCredentialVault,
  parseCredentialRef,
  type CredentialVault,
} from "../provider/credential-vault.js";
import { resolveModelRouteCapabilities } from "../provider/model-capabilities.js";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
  prepareBackgroundYoloPolicy,
} from "../safety/background-yolo-policy.js";
import { WorkspaceTrustStore } from "../security/workspace-trust.js";
import type { CronJobRecord } from "../tasks/runtime-types.js";
import { createCronWorkspaceRuntimeFactory } from "./cron-workspace-runtime.js";
import { DesktopRuntimeService } from "./desktop-runtime-service.js";
import type { LocalDaemonEndpoint } from "./endpoint.js";
import { LocalDaemonHost } from "./runtime-host.js";
import { WorkspaceRegistrationStore } from "./workspace-registration.js";
import { WorkspaceRuntimeService } from "./workspace-runtime-service.js";

export interface ProductionLocalDaemonHostOptions {
  endpoint?: LocalDaemonEndpoint;
  registrationStore?: WorkspaceRegistrationStore;
  trustStore?: WorkspaceTrustStore;
  agentRuntime?: AgentRuntime;
  credentialVault?: CredentialVault;
}

/**
 * Production-safe assembly. Cron is the only autonomous execution source and every
 * invocation re-enters AgentRuntime through its strict background policy boundary.
 * Unscoped IPC run.start remains fail-closed until the protocol carries a policy snapshot.
 */
export function createProductionLocalDaemonHost(
  options: ProductionLocalDaemonHostOptions = {},
): LocalDaemonHost {
  const trustStore = options.trustStore ?? new WorkspaceTrustStore();
  const agentRuntime = options.agentRuntime ?? new AgentRuntime();
  const credentialVault = options.credentialVault ?? createPlatformCredentialVault();
  const registrationStore = options.registrationStore ?? new WorkspaceRegistrationStore();
  const service = new WorkspaceRuntimeService({
    registrationStore,
    execute: async () => {
      throw new Error("daemon run.start 缺少后台 policySnapshot，已按 fail-closed 拒绝执行");
    },
  });
  const desktopService = new DesktopRuntimeService({
    runtimeService: service,
    registrationStore,
    trustStore,
  });
  const validate = async (job: CronJobRecord): Promise<{ allowed: boolean; reason?: string }> => {
    try {
      await prepareBackgroundYoloPolicy({
        workDir: job.workspacePath,
        policy: job.policySnapshot,
        trustStore,
      });
      if (!job.credentialRef) throw new Error("Cron Job 缺少 credentialRef");
      await resolveCronModelRoute(job);
      if (!(await credentialVault.has(job.credentialRef))) {
        throw new Error(`系统凭证库中不存在 ${job.credentialRef}`);
      }
      return { allowed: true };
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
  const cronRuntimeFactory = createCronWorkspaceRuntimeFactory({
    getWorkspaceRuntime: (workspacePath) => service.getWorkspaceRuntime(workspacePath),
    canRun: validate,
    policyGuard: {
      evaluate: (job) =>
        job.policySnapshot.hardlineVersion === BACKGROUND_HARDLINE_VERSION &&
        job.policySnapshot.hookVersion === BACKGROUND_HOOK_VERSION
          ? { allowed: true }
          : { allowed: false, reason: "background_policy_version_mismatch" },
    },
    execute: async (job, context) => {
      if (!job.credentialRef) throw new Error("Cron Job 缺少 credentialRef");
      const route = await resolveCronModelRoute(job);
      const result = await agentRuntime.execute(
        {
          prompt: job.prompt,
          dir: job.workspacePath,
          provider: route.provider,
          baseURL: route.baseURL,
          model: route.model,
          modelRouteId: route.modelRouteId,
          modelCapabilities: route.capabilities,
          allowModelFallback: false,
          credentialRef: job.credentialRef,
          execution: { kind: "background", policy: job.policySnapshot },
        },
        {
          signal: context.signal,
          reporter: new SilentReporter(),
          backgroundTrustStore: trustStore,
          credentialResolver: credentialVault,
        },
      );
      return {
        sessionId: result.sessionId,
        finalMessage: result.finalMessage,
        usage: result.usage,
      };
    },
  });
  const host = new LocalDaemonHost({
    service: desktopService,
    cronRuntimeFactory,
    registrationStore,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });
  service.setRegistrationChangedListener(() => host.refreshRegisteredWorkspaces());
  return host;
}

async function resolveCronModelRoute(job: CronJobRecord) {
  if (!job.credentialRef) throw new Error("Cron Job 缺少 credentialRef");
  const { modelRouteId } = parseCredentialRef(job.credentialRef);
  const slash = modelRouteId.indexOf("/");
  const providerId = modelRouteId.slice(0, slash);
  const model = modelRouteId.slice(slash + 1);
  const config = await loadPicoConfig(job.workspacePath);
  const provider = config.providers[providerId];
  if (!provider) throw new Error(`配置模型路由 ${modelRouteId} 的 provider 已不存在`);
  if (!provider.models.includes(model)) {
    throw new Error(`配置模型路由 ${modelRouteId} 不在显式 models 列表中`);
  }
  const resolved = {
    id: modelRouteId,
    provider: provider.protocol,
    baseURL: provider.baseURL,
    model,
    apiKeyEnv: provider.apiKeyEnv,
    modelRouteId,
    capabilities: resolveModelRouteCapabilities(
      provider.protocol,
      model,
      provider.modelCapabilities?.[model],
    ),
  };
  assertCredentialRefMatchesModelRoute(job.credentialRef, resolved, job.workspacePath);
  return resolved;
}
