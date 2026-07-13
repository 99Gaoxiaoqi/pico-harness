import { AgentRuntime } from "../runtime/agent-runtime.js";
import { SilentReporter } from "../engine/reporter.js";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
  prepareBackgroundYoloPolicy,
} from "../safety/background-yolo-policy.js";
import { WorkspaceTrustStore } from "../security/workspace-trust.js";
import type { CronJobRecord } from "../tasks/runtime-types.js";
import { createCronWorkspaceRuntimeFactory } from "./cron-workspace-runtime.js";
import type { LocalDaemonEndpoint } from "./endpoint.js";
import { LocalDaemonHost } from "./runtime-host.js";
import { WorkspaceRegistrationStore } from "./workspace-registration.js";
import { WorkspaceRuntimeService } from "./workspace-runtime-service.js";

export interface ProductionLocalDaemonHostOptions {
  endpoint?: LocalDaemonEndpoint;
  registrationStore?: WorkspaceRegistrationStore;
  trustStore?: WorkspaceTrustStore;
  agentRuntime?: AgentRuntime;
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
  const registrationStore = options.registrationStore ?? new WorkspaceRegistrationStore();
  const service = new WorkspaceRuntimeService({
    registrationStore,
    execute: async () => {
      throw new Error("daemon run.start 缺少后台 policySnapshot，已按 fail-closed 拒绝执行");
    },
  });
  const validate = async (job: CronJobRecord): Promise<{ allowed: boolean; reason?: string }> => {
    try {
      await prepareBackgroundYoloPolicy({
        workDir: job.workspacePath,
        policy: job.policySnapshot,
        trustStore,
      });
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
      const result = await agentRuntime.execute(
        {
          prompt: job.prompt,
          dir: job.workspacePath,
          execution: { kind: "background", policy: job.policySnapshot },
        },
        { signal: context.signal, reporter: new SilentReporter(), backgroundTrustStore: trustStore },
      );
      return {
        sessionId: result.sessionId,
        finalMessage: result.finalMessage,
        usage: result.usage,
      };
    },
  });
  const host = new LocalDaemonHost({
    service,
    cronRuntimeFactory,
    registrationStore,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });
  service.setRegistrationChangedListener(() => host.refreshRegisteredWorkspaces());
  return host;
}
