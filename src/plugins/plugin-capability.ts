import type {
  PluginCapabilityDeclaration,
  PluginCapabilityKind,
  ResolvedPluginIdentity,
} from "./plugin-types.js";

/**
 * Host-owned capability factory boundary.
 *
 * A plugin manifest can only describe a capability.  It cannot provide a module
 * path, executable, callback or Runtime object.  Factories are installed by the
 * host and produce a data-only descriptor that can be handed to a capability
 * adapter later in the composition root.
 */
export interface PluginCapabilityFactoryRequest {
  readonly plugin: Pick<ResolvedPluginIdentity, "id" | "version">;
  readonly declaration: PluginCapabilityDeclaration;
  readonly resourceDigest?: string;
}

export interface PluginCapabilityDescriptor {
  readonly id: string;
  readonly version: string;
  readonly kind: PluginCapabilityKind;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface PluginCapabilityFactory {
  /** Stable host capability id (for example `provider` or `tool`). */
  readonly id: string;
  /** Exact versions supported by this factory. `*` accepts every manifest version. */
  readonly versions: readonly string[];
  /** Capability family selected by the host, never by the manifest. */
  readonly kind: PluginCapabilityKind;
  /** Only built-in or explicitly trusted host factories may enter the registry. */
  readonly trust: PluginCapabilityFactoryTrust;
  /** Pure host-owned projection; it must not return Runtime-private objects. */
  readonly resolve: (request: PluginCapabilityFactoryRequest) => PluginCapabilityDescriptor;
}

export type PluginCapabilityFactoryTrust = "builtin" | "trusted-host";

export interface PluginCapabilityResolutionDiagnostic {
  readonly code:
    | "plugin_capability_unknown"
    | "plugin_capability_version_unsupported"
    | "plugin_capability_factory_failed"
    | "plugin_capability_result_invalid";
  readonly message: string;
  readonly capabilityId: string;
  readonly version: string;
}

export interface PluginCapabilityResolution {
  readonly capabilities: readonly PluginCapabilityDescriptor[];
  readonly diagnostics: readonly PluginCapabilityResolutionDiagnostic[];
}

/**
 * Declare a host-owned factory.  This helper intentionally accepts only a
 * factory function supplied by host code; plugin manifests never carry one.
 */
export function defineTrustedPluginCapabilityFactory(
  factory: Omit<PluginCapabilityFactory, "trust"> & {
    readonly trust?: PluginCapabilityFactoryTrust;
  },
): PluginCapabilityFactory {
  const trust = factory.trust ?? "trusted-host";
  if (trust !== "builtin" && trust !== "trusted-host") {
    throw new Error(`Unsupported plugin capability factory trust: ${String(trust)}`);
  }
  return Object.freeze({ ...factory, versions: Object.freeze([...factory.versions]), trust });
}

/**
 * Registry owned by the composition root.  The default registry is empty: an
 * unrecognised Provider/Tool capability is not guessed, executed or forwarded.
 */
export class PluginCapabilityRegistry {
  private readonly factories = new Map<string, PluginCapabilityFactory>();

  constructor(factories: readonly PluginCapabilityFactory[] = []) {
    for (const factory of factories) this.register(factory);
  }

  register(factory: PluginCapabilityFactory): void {
    assertTrustedFactory(factory);
    if (this.factories.has(factory.id)) {
      throw new Error(`Plugin capability factory already registered: ${factory.id}`);
    }
    validateFactoryShape(factory);
    this.factories.set(
      factory.id,
      Object.freeze({ ...factory, versions: Object.freeze([...factory.versions]) }),
    );
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  resolve(
    plugin: Pick<ResolvedPluginIdentity, "id" | "version">,
    declarations: readonly PluginCapabilityDeclaration[],
    options: { readonly resourceDigest?: string } = {},
  ): PluginCapabilityResolution {
    const capabilities: PluginCapabilityDescriptor[] = [];
    const diagnostics: PluginCapabilityResolutionDiagnostic[] = [];
    const seen = new Set<string>();

    for (const declaration of declarations) {
      const key = `${declaration.id}@${declaration.version}`;
      if (seen.has(key)) {
        diagnostics.push({
          code: "plugin_capability_result_invalid",
          message: `Plugin capability is declared more than once: ${key}`,
          capabilityId: declaration.id,
          version: declaration.version,
        });
        continue;
      }
      seen.add(key);

      const factory = this.factories.get(declaration.id);
      if (!factory) {
        diagnostics.push({
          code: "plugin_capability_unknown",
          message: `Unknown plugin capability '${declaration.id}' was rejected; no host factory is registered.`,
          capabilityId: declaration.id,
          version: declaration.version,
        });
        continue;
      }
      if (!supportsVersion(factory, declaration.version)) {
        diagnostics.push({
          code: "plugin_capability_version_unsupported",
          message: `Plugin capability '${declaration.id}@${declaration.version}' is not supported by the host factory.`,
          capabilityId: declaration.id,
          version: declaration.version,
        });
        continue;
      }

      try {
        const descriptor = factory.resolve({
          plugin,
          declaration: freezeDeclaration(declaration),
          ...(options.resourceDigest ? { resourceDigest: options.resourceDigest } : {}),
        });
        capabilities.push(validateDescriptor(factory, declaration, descriptor));
      } catch (error) {
        diagnostics.push({
          code: "plugin_capability_factory_failed",
          message: `Plugin capability '${declaration.id}@${declaration.version}' factory failed: ${errorMessage(error)}`,
          capabilityId: declaration.id,
          version: declaration.version,
        });
      }
    }

    return Object.freeze({
      capabilities: Object.freeze(capabilities),
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

/** Explicitly empty host registry used by normal runtime startup. */
export function createBuiltinPluginCapabilityRegistry(): PluginCapabilityRegistry {
  return new PluginCapabilityRegistry();
}

function assertTrustedFactory(factory: PluginCapabilityFactory): void {
  if (!factory || (factory.trust !== "builtin" && factory.trust !== "trusted-host")) {
    throw new Error("Plugin capability factory must be builtin or trusted-host");
  }
}

function validateFactoryShape(factory: PluginCapabilityFactory): void {
  if (!isIdentifier(factory.id))
    throw new Error(`Invalid plugin capability factory id: ${factory.id}`);
  if (!isCapabilityKind(factory.kind)) {
    throw new Error(`Invalid plugin capability factory kind: ${String(factory.kind)}`);
  }
  if (
    factory.versions.length === 0 ||
    factory.versions.some((version) => typeof version !== "string" || !version.trim())
  ) {
    throw new Error(`Plugin capability factory ${factory.id} must declare supported versions`);
  }
  if (typeof factory.resolve !== "function") {
    throw new Error(`Plugin capability factory ${factory.id} must provide resolve()`);
  }
}

function supportsVersion(factory: PluginCapabilityFactory, version: string): boolean {
  return factory.versions.includes("*") || factory.versions.includes(version);
}

function validateDescriptor(
  factory: PluginCapabilityFactory,
  declaration: PluginCapabilityDeclaration,
  descriptor: PluginCapabilityDescriptor,
): PluginCapabilityDescriptor {
  if (!isRecord(descriptor)) throw new Error("factory result must be an object");
  const keys = Object.keys(descriptor);
  if (keys.some((key) => !["id", "version", "kind", "config"].includes(key))) {
    throw new Error("factory result may only contain id, version, kind and config");
  }
  if (descriptor.id !== declaration.id || descriptor.id !== factory.id) {
    throw new Error("factory result id does not match the declared capability");
  }
  if (descriptor.version !== declaration.version) {
    throw new Error("factory result version does not match the declared capability");
  }
  if (descriptor.kind !== factory.kind || !isCapabilityKind(descriptor.kind)) {
    throw new Error("factory result kind does not match the host factory");
  }
  if (!isRecord(descriptor.config)) throw new Error("factory result config must be an object");
  return Object.freeze({
    id: descriptor.id,
    version: descriptor.version,
    kind: descriptor.kind,
    config: deepFreezeClone(descriptor.config),
  });
}

function freezeDeclaration(declaration: PluginCapabilityDeclaration): PluginCapabilityDeclaration {
  return Object.freeze({
    id: declaration.id,
    version: declaration.version,
    config: deepFreezeClone(declaration.config ?? {}),
  });
}

function deepFreezeClone(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const clone = structuredClone(value) as Record<string, unknown>;
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9._-]*$/u.test(value);
}

function isCapabilityKind(value: unknown): value is PluginCapabilityKind {
  return value === "provider" || value === "tool";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
