import type { ClientSessionRuntime } from "../client-session-runtime.js";
import type { AutomationCredentialImportProposalStore } from "../automation-credential-proposal.js";
export interface ClientCommandRegistryDeps {
  readonly runtime: ClientSessionRuntime;
  readonly workspacePath: string;
  /** One in-memory confirmation scope per command session; injectable for deterministic tests. */
  readonly automationCredentialProposals?: AutomationCredentialImportProposalStore;
  readonly credentialEnv?: Readonly<Record<string, string | undefined>>;
}
