/** A host's explicit decision for one workspace trust request. */
export type WorkspaceTrustDecision = "trust" | "deny";

/** Information a host may present before it grants workspace authority. */
export interface WorkspaceTrustPromptRequest {
  readonly workspacePath: string;
  readonly risks: readonly string[];
}

/**
 * Host-owned interaction port.  The trust policy never depends on readline,
 * Electron, or another presentation implementation.
 */
export interface WorkspaceTrustPrompt {
  requestTrust(request: WorkspaceTrustPromptRequest): Promise<WorkspaceTrustDecision>;
}
