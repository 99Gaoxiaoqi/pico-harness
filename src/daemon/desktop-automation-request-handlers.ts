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
  createDesktopAutomationRequestHandlers as createHostDesktopAutomationRequestHandlers,
  type DesktopAutomationPort,
} from "@pico/pico-host/desktop-automation-request-handlers";
import { type RuntimeRequest, type JsonValue } from "@pico/protocol";
import type { EffectiveConfigResolver } from "../input/effective-config.js";

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
    return importDesktopAutomationCredential(canonical, params, {
      credentialVault: context.credentialVault,
      effectiveConfigResolver: context.effectiveConfigResolver,
      userConfigStore: context.userConfigStore,
    });
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
          createTrustedDesktopAutomation(context.automations!, workspacePath, params, {
            credentialVault: context.credentialVault,
            effectiveConfigResolver: context.effectiveConfigResolver,
            userConfigStore: context.userConfigStore,
            foregroundOnlyTools,
            now: context.now,
          }),
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
