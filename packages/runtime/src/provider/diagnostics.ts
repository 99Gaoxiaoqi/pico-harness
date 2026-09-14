export interface ProviderDiagnostics {
  warn(bindings: object, message: string): void;
}

export const NOOP_PROVIDER_DIAGNOSTICS: ProviderDiagnostics = { warn: () => undefined };
