import type { ClientSessionRuntime } from "../client-session-runtime.js";
import type { AutomationCredentialImportProposalStore } from "../automation-credential-proposal.js";
import type { ClientCommandRegistryDeps as CliClientCommandRegistryDeps } from "@pico/cli/resources-commands";

export interface ClientCommandRegistryDeps extends CliClientCommandRegistryDeps {
  readonly runtime: ClientSessionRuntime;
  readonly workspacePath: string;
  /** One in-memory confirmation scope per command session; injectable for deterministic tests. */
  readonly automationCredentialProposals?: AutomationCredentialImportProposalStore;
  readonly credentialEnv?: Readonly<Record<string, string | undefined>>;
}
