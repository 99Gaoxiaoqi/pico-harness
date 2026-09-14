import {
  createAutomationCommands as createCliAutomationCommands,
  type AutomationCommandRegistryDeps,
} from "@pico/cli/automation-commands";
import { resolveAutomationCredentialTarget } from "../../provider/automation-credential.js";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import { AUTOMATION_TOOL_ALLOWLIST } from "@pico/runtime/automation-tool-policy";
import { AutomationCredentialImportProposalStore } from "../automation-credential-proposal.js";
import type { ClientCommandRegistryDeps } from "./types.js";

/** Bind product credential policy and command-session confirmation state to CLI ports. */
export function createAutomationCommandServices(
  deps: ClientCommandRegistryDeps,
): AutomationCommandRegistryDeps {
  return {
    runtime: deps.runtime,
    workspacePath: deps.workspacePath,
    ...(deps.credentialEnv ? { credentialEnv: deps.credentialEnv } : {}),
    allowedTools: AUTOMATION_TOOL_ALLOWLIST,
    automationCredentialProposals:
      deps.automationCredentialProposals ?? new AutomationCredentialImportProposalStore(),
    resolveCredentialTarget: (input) =>
      resolveAutomationCredentialTarget({
        ...input,
        route: {
          ...input.route,
          capabilities: resolveModelRouteCapabilities(
            input.route.provider,
            input.route.model,
            undefined,
            { baseURL: input.route.baseURL },
          ),
        },
      }),
  };
}

/** @deprecated Production dispatch directly consumes @pico/cli. */
export function createAutomationCommands(deps: ClientCommandRegistryDeps) {
  return createCliAutomationCommands(createAutomationCommandServices(deps));
}
