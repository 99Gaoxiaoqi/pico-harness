import type { UserConfigStore } from "../input/user-config-store.js";
import { mcpToolNameMayBelongToServer } from "../mcp/types.js";
import type { CredentialVault } from "../provider/credential-vault.js";
import { resolveAutomationCredentialTarget } from "../provider/automation-credential.js";
import type { ModelRoute } from "../provider/model-router.js";
import type { PluginRuntimeSnapshotRegistry } from "../plugins/plugin-runtime-snapshot-registry.js";
import {
  createTrustedDesktopAutomation,
  DesktopAutomationService,
  importDesktopAutomationCredential,
  type DesktopAutomationAuthorityDependencies,
  type DesktopAutomationCredentialTarget,
} from "@pico/pico-host/desktop-automation-service";
import type { DesktopRequestHandlers } from "./desktop-request-router.js";
import {
  createDesktopAutomationRequestHandlers as createHostDesktopAutomationRequestHandlers,
  type DesktopAutomationPort,
} from "@pico/pico-host/desktop-automation-request-handlers";
import {
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type RuntimeRequest,
  type JsonValue,
} from "@pico/protocol";
import type { EffectiveConfigResolver } from "../input/effective-config.js";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
} from "../safety/background-autonomous-policy.js";

/** Dependencies retained by the Desktop composition root. */
export interface DesktopAutomationRequestContext {
  readonly automations?: DesktopAutomationService;
  readonly credentialVault: CredentialVault;
  readonly effectiveConfigResolver: EffectiveConfigResolver;
  readonly userConfigStore: UserConfigStore;
  readonly pluginRuntimeSnapshotRegistry: PluginRuntimeSnapshotRegistry;
  readonly now: () => number;
  readonly requireTrustedWorkspace: (workspacePath: string) => Promise<string>;
  readonly publishJob: (job: JsonValue) => void;
  readonly withProviderDependencyLock: (operation: () => Promise<JsonValue>) => Promise<JsonValue>;
}

/** @deprecated Desktop Automation request routing has moved to @pico/pico-host. */
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
  const importAutomationCredential = async (
    params: RuntimeRequest<"automation.credential.import">["params"],
  ): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(params.workspacePath);
    return importDesktopAutomationCredential(canonical, params, authorityDependencies(context));
  };

  const foregroundOnlyTools = async (
    canonical: string,
    allowedTools: readonly string[],
  ): Promise<ReadonlySet<string>> => {
    const pluginSnapshot = await context.pluginRuntimeSnapshotRegistry.get(canonical);
    const tools = new Set(
      context.pluginRuntimeSnapshotRegistry.capabilityRegistry.toolNames(
        pluginSnapshot.capabilities.filter((capability) => capability.kind === "tool"),
      ),
    );
    const pluginMcpServers = pluginSnapshot.mcpSources.flatMap((source) =>
      Object.keys(source.config?.mcpServers ?? {}),
    );
    for (const toolName of allowedTools) {
      if (pluginMcpServers.some((server) => mcpToolNameMayBelongToServer(toolName, server))) {
        tools.add(toolName);
      }
    }
    return tools;
  };

  const automations: DesktopAutomationPort | undefined = context.automations
    ? {
        list: (workspacePath) => context.automations!.list(workspacePath),
        create: (workspacePath, params) => context.automations!.create(workspacePath, params),
        createTrusted: (workspacePath, params, foregroundOnlyTools) =>
          createTrustedDesktopAutomation(
            context.automations!,
            workspacePath,
            params,
            authorityDependencies(context, foregroundOnlyTools),
          ),
        update: (workspacePath, jobId, params) =>
          context.automations!.update(workspacePath, jobId, params),
        delete: (workspacePath, jobId) => context.automations!.delete(workspacePath, jobId),
        setEnabled: (workspacePath, jobId, enabled) =>
          context.automations!.setEnabled(workspacePath, jobId, enabled),
        runNow: (workspacePath, jobId) => context.automations!.runNow(workspacePath, jobId),
        history: (workspacePath, jobId, limit) =>
          context.automations!.history(workspacePath, jobId, limit),
      }
    : undefined;

  return {
    ...createHostDesktopAutomationRequestHandlers({
      ...(automations ? { automations } : {}),
      foregroundOnlyTools,
      requireTrustedWorkspace: context.requireTrustedWorkspace,
      publishJob: context.publishJob,
      withProviderDependencyLock: context.withProviderDependencyLock,
    }),
    "automation.credential.import": (request) =>
      context.withProviderDependencyLock(() => importAutomationCredential(request.params)),
  };
}

function authorityDependencies(
  context: DesktopAutomationRequestContext,
  foregroundOnlyTools?: ReadonlySet<string>,
): DesktopAutomationAuthorityDependencies {
  return {
    credentialVault: context.credentialVault,
    resolveCredentialTarget: (workspacePath, modelRouteId) =>
      resolveDesktopAutomationCredentialTarget(context, workspacePath, modelRouteId),
    ...(foregroundOnlyTools ? { foregroundOnlyTools } : {}),
    now: context.now,
    backgroundHardlineVersion: BACKGROUND_HARDLINE_VERSION,
    backgroundHookVersion: BACKGROUND_HOOK_VERSION,
  };
}

/** Provider/config authority stays in the daemon composition root. */
async function resolveDesktopAutomationCredentialTarget(
  context: DesktopAutomationRequestContext,
  workspacePath: string,
  modelRouteId: string,
): Promise<DesktopAutomationCredentialTarget> {
  const separator = modelRouteId.indexOf("/");
  const providerId = modelRouteId.slice(0, separator);
  const model = modelRouteId.slice(separator + 1);
  const effective = await context.effectiveConfigResolver.resolve({
    workDir: workspacePath,
    projectTrusted: true,
  });
  const provider = effective.providers[providerId];
  if (!provider || !provider.models.includes(model)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      `模型路由 ${modelRouteId} 已不存在，请刷新配置后重试`,
    );
  }
  const route: ModelRoute = {
    id: modelRouteId,
    providerId,
    provider: provider.modelProtocols?.[model] ?? provider.protocol,
    model,
    baseURL: provider.baseURL,
    apiKeyEnv: provider.apiKeyEnv,
    ...(provider.auth ? { auth: provider.auth } : {}),
    source: "config",
    capabilities: resolveModelRouteCapabilities(
      provider.modelProtocols?.[model] ?? provider.protocol,
      model,
      provider.modelCapabilities?.[model],
      { baseURL: provider.baseURL },
    ),
  };
  const userProvider = (await context.userConfigStore.read()).config.providers[providerId];
  try {
    return {
      ref: resolveAutomationCredentialTarget({
        route,
        ...(userProvider ? { userProvider } : {}),
        configSource: effective.sources[`providers.${providerId}`],
      }).ref,
      auth: provider.auth ?? "api-key",
    };
  } catch (error) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.FORBIDDEN,
      error instanceof Error ? error.message : String(error),
    );
  }
}
