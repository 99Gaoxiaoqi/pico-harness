/** Safe diagnostic projection; it deliberately excludes credential material and endpoints. */
export interface WorkspaceConfigurationDiagnostic {
  readonly defaultModelRouteId?: string;
  readonly defaultProviderId?: string;
  readonly defaultSource?: string;
  readonly providerSources: Readonly<Record<string, string>>;
  readonly credentialStates: Readonly<Record<string, string>>;
}

export interface EffectiveModelRuntimeDiagnosticPort {
  readonly config: {
    readonly providers: Readonly<Record<string, unknown>>;
    readonly sources: Readonly<Record<string, string | undefined>>;
    readonly defaultModelRouteId?: string;
  };
  readonly credentials: Readonly<Record<string, { readonly state: string } | undefined>>;
  readonly router: {
    resolve(
      routeId: string | undefined,
    ): { readonly id: string; readonly providerId: string } | undefined;
  };
}

export function workspaceConfigurationDiagnosticFromRuntime(
  runtime: EffectiveModelRuntimeDiagnosticPort,
): WorkspaceConfigurationDiagnostic {
  const providerSources: Record<string, string> = {};
  const credentialStates: Record<string, string> = {};
  for (const providerId of Object.keys(runtime.config.providers)) {
    providerSources[providerId] = runtime.config.sources[`providers.${providerId}`] ?? "unknown";
    credentialStates[providerId] = runtime.credentials[providerId]?.state ?? "missing";
  }
  const resolvedDefaultRoute = runtime.router.resolve(runtime.config.defaultModelRouteId);
  return Object.freeze({
    ...(resolvedDefaultRoute ? { defaultModelRouteId: resolvedDefaultRoute.id } : {}),
    ...(resolvedDefaultRoute ? { defaultProviderId: resolvedDefaultRoute.providerId } : {}),
    ...(runtime.config.sources["defaults.modelRouteId"]
      ? { defaultSource: runtime.config.sources["defaults.modelRouteId"] }
      : {}),
    providerSources: Object.freeze(providerSources),
    credentialStates: Object.freeze(credentialStates),
  });
}
