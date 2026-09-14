export interface OwnerLeaseDiagnostics {
  onTransientHeartbeatError?: ((error: unknown) => void) | undefined;
}

let onTransientHeartbeatError: ((error: unknown) => void) | undefined;

/**
 * Optional host diagnostic hook. Lease correctness never depends on diagnostics:
 * a reporter failure must not affect a later heartbeat attempt.
 */
export function configureOwnerLeaseDiagnostics(
  diagnostics: OwnerLeaseDiagnostics | undefined,
): void {
  onTransientHeartbeatError = diagnostics?.onTransientHeartbeatError;
}

export function reportTransientOwnerLeaseHeartbeatError(error: unknown): void {
  try {
    onTransientHeartbeatError?.(error);
  } catch {
    // Diagnostics are deliberately best-effort.
  }
}
