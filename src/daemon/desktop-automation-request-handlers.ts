import type { EffectiveConfigResolver } from "../input/effective-config.js";
import type { UserConfigStore } from "../input/user-config-store.js";
import { mcpToolNameMayBelongToServer } from "../mcp/types.js";
import type { CredentialVault } from "../provider/credential-vault.js";
import type { PluginRuntimeSnapshotRegistry } from "../plugins/plugin-runtime-snapshot-registry.js";
import {
  createTrustedDesktopAutomation,
  DesktopAutomationService,
  importDesktopAutomationCredential,
} from "./desktop-automation-service.js";
import type { DesktopRequestHandlers } from "./desktop-request-router.js";
import {
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type JsonValue,
  type RuntimeRequest,
} from "./protocol.js";

/** Dependencies retained by the Desktop composition root. */
export interface DesktopAutomationRequestContext {
  readonly automations?: DesktopAutomationService;
  readonly credentialVault: CredentialVault;
  readonly effectiveConfigResolver: EffectiveConfigResolver;
  readonly userConfigStore: UserConfigStore;
  readonly pluginRuntimeSnapshotRegistry: PluginRuntimeSnapshotRegistry;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
  readonly requireTrustedWorkspace: (workspacePath: string) => Promise<string>;
  readonly publishJob: (job: JsonValue) => void;
  readonly withProviderDependencyLock: (operation: () => Promise<JsonValue>) => Promise<JsonValue>;
}

/** Build the Automation CRUD/import request boundary. */
export function createDesktopAutomationRequestHandlers(
  context: DesktopAutomationRequestContext,
): Pick<
  DesktopRequestHandlers,
  | "jobs.list"
  | "jobs.create"
  | "jobs.update"
  | "jobs.delete"
  | "jobs.setEnabled"
  | "jobs.runNow"
  | "jobs.history"
  | "automation.credential.import"
  | "automation.create"
> {
  const requireAutomations = (): DesktopAutomationService => {
    if (context.automations) return context.automations;
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
      "Automations 尚未连接到 daemon Cron runtime",
    );
  };

  const listJobs = async (workspacePath: string): Promise<JsonValue> => {
    const [canonical, automations] = await Promise.all([
      context.requireTrustedWorkspace(workspacePath),
      Promise.resolve(requireAutomations()),
    ]);
    return { jobs: automations.list(canonical) };
  };

  const importAutomationCredential = async (
    params: RuntimeRequest<"automation.credential.import">["params"],
  ): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(params.workspacePath);
    return importDesktopAutomationCredential(canonical, params, {
      credentialVault: context.credentialVault,
      effectiveConfigResolver: context.effectiveConfigResolver,
      userConfigStore: context.userConfigStore,
      env: context.env,
    });
  };

  const createTrustedAutomation = async (
    params: RuntimeRequest<"automation.create">["params"],
  ): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(params.workspacePath);
    const pluginSnapshot = await context.pluginRuntimeSnapshotRegistry.get(canonical);
    const foregroundOnlyTools = new Set(
      context.pluginRuntimeSnapshotRegistry.capabilityRegistry.toolNames(
        pluginSnapshot.capabilities.filter((capability) => capability.kind === "tool"),
      ),
    );
    const pluginMcpServers = pluginSnapshot.mcpSources.flatMap((source) =>
      Object.keys(source.config?.mcpServers ?? {}),
    );
    for (const toolName of params.allowedTools) {
      if (pluginMcpServers.some((server) => mcpToolNameMayBelongToServer(toolName, server))) {
        foregroundOnlyTools.add(toolName);
      }
    }
    const job = await createTrustedDesktopAutomation(requireAutomations(), canonical, params, {
      credentialVault: context.credentialVault,
      effectiveConfigResolver: context.effectiveConfigResolver,
      userConfigStore: context.userConfigStore,
      env: context.env,
      foregroundOnlyTools,
      now: context.now,
    });
    context.publishJob(job);
    return { job };
  };

  const createJob = async (params: RuntimeRequest<"jobs.create">["params"]): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(params.workspacePath);
    const job = await requireAutomations().create(canonical, params);
    context.publishJob(job);
    return { job };
  };

  const updateJob = async (params: RuntimeRequest<"jobs.update">["params"]): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(params.workspacePath);
    const job = requireAutomations().update(canonical, params.jobId, params);
    context.publishJob(job);
    return { job };
  };

  const deleteJob = async (workspacePath: string, jobId: string): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(workspacePath);
    return { deleted: requireAutomations().delete(canonical, jobId) };
  };

  const setJobEnabled = async (
    workspacePath: string,
    jobId: string,
    enabled: boolean,
  ): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(workspacePath);
    const job = await requireAutomations().setEnabled(canonical, jobId, enabled);
    context.publishJob(job);
    return { job };
  };

  const runJobNow = async (workspacePath: string, jobId: string): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(workspacePath);
    const result = await requireAutomations().runNow(canonical, jobId);
    context.publishJob(result.job);
    return result;
  };

  const jobHistory = async (
    workspacePath: string,
    jobId: string,
    limit?: number,
  ): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(workspacePath);
    return { runs: requireAutomations().history(canonical, jobId, limit) };
  };

  return {
    "jobs.list": (request) => listJobs(request.params.workspacePath),
    "jobs.create": (request) => context.withProviderDependencyLock(() => createJob(request.params)),
    "jobs.update": (request) => updateJob(request.params),
    "jobs.delete": (request) => deleteJob(request.params.workspacePath, request.params.jobId),
    "jobs.setEnabled": (request) =>
      context.withProviderDependencyLock(() =>
        setJobEnabled(request.params.workspacePath, request.params.jobId, request.params.enabled),
      ),
    "jobs.runNow": (request) =>
      context.withProviderDependencyLock(() =>
        runJobNow(request.params.workspacePath, request.params.jobId),
      ),
    "jobs.history": (request) =>
      jobHistory(request.params.workspacePath, request.params.jobId, request.params.limit),
    "automation.credential.import": (request) =>
      context.withProviderDependencyLock(() => importAutomationCredential(request.params)),
    "automation.create": (request) =>
      context.withProviderDependencyLock(() => createTrustedAutomation(request.params)),
  };
}
