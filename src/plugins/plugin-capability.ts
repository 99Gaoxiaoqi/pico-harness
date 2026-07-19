import type {
  PluginCapabilityDeclaration,
  PluginCapabilityKind,
  PluginScope,
  ResolvedPluginIdentity,
} from "./plugin-types.js";
import type { LLMProvider } from "../provider/interface.js";
import type { BaseTool } from "../tools/registry.js";

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

export interface PluginCapabilityFactoryDescriptor {
  readonly id: string;
  readonly version: string;
  readonly kind: PluginCapabilityKind;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface PluginCapabilityDescriptor extends PluginCapabilityFactoryDescriptor {
  readonly pluginId: string;
  readonly pluginVersion?: string;
  readonly pluginScope?: PluginScope;
  readonly resourceDigest?: string;
}

interface PluginCapabilityFactoryBase {
  /** Stable host capability id (for example `provider` or `tool`). */
  readonly id: string;
  /** Exact versions supported by this factory. `*` accepts every manifest version. */
  readonly versions: readonly string[];
  /** Only built-in or explicitly trusted host factories may enter the registry. */
  readonly trust: PluginCapabilityFactoryTrust;
  /** Pure host-owned projection; it must not return Runtime-private objects. */
  readonly resolve: (request: PluginCapabilityFactoryRequest) => PluginCapabilityFactoryDescriptor;
}

export interface PluginProviderCapabilityActivationRequest {
  readonly descriptor: PluginCapabilityDescriptor;
  /** The already assembled provider. Provider capabilities are ordered decorators, not routes. */
  readonly provider: LLMProvider;
}

export interface PluginToolCapabilityActivationRequest {
  readonly descriptor: PluginCapabilityDescriptor;
  readonly workDir: string;
}

export interface PluginToolCapabilityMetadataRequest {
  readonly descriptor: PluginCapabilityDescriptor;
}

export interface PluginCapabilityActivation<Value> {
  readonly value: Value;
  /** Release resources acquired by activate(); the host scope calls this exactly once. */
  readonly dispose: () => void | Promise<void>;
}

/** Owns concrete capability activations for one host/runtime lifetime. */
export class PluginCapabilityActivationScope {
  private readonly disposers: Array<{
    readonly label: string;
    readonly dispose: () => void | Promise<void>;
  }> = [];
  private disposePromise?: Promise<void>;
  private accepting = true;

  assertAccepting(label: string): void {
    if (!this.accepting) throw new Error(`Plugin activation scope is already disposing: ${label}`);
  }

  register<Value>(label: string, activation: PluginCapabilityActivation<Value>): Value {
    this.assertAccepting(label);
    this.disposers.push({ label, dispose: activation.dispose });
    return activation.value;
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.accepting = false;
      this.disposePromise = Promise.resolve().then(() => this.disposeOnce());
    }
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    const failures: unknown[] = [];
    for (const entry of this.disposers.toReversed()) {
      try {
        await entry.dispose();
      } catch (error) {
        failures.push(
          new Error(`Plugin activation cleanup failed: ${entry.label}`, { cause: error }),
        );
      }
    }
    this.disposers.length = 0;
    if (failures.length > 0) {
      throw new AggregateError(failures, "Plugin capability activation cleanup failed");
    }
  }
}

export interface PluginProviderCapabilityFactory extends PluginCapabilityFactoryBase {
  readonly kind: "provider";
  /** Host-owned decorator. It cannot be supplied or named as a module by a plugin manifest. */
  readonly activate: (
    request: PluginProviderCapabilityActivationRequest,
  ) => PluginCapabilityActivation<LLMProvider>;
}

export interface PluginToolCapabilityFactory extends PluginCapabilityFactoryBase {
  readonly kind: "tool";
  /** Pure metadata projection used by policy/preflight paths; it must not allocate Runtime resources. */
  readonly toolNames: (request: PluginToolCapabilityMetadataRequest) => readonly string[];
  /** Host-owned tool construction. Returned tools still pass through the normal registry policy. */
  readonly activate: (
    request: PluginToolCapabilityActivationRequest,
  ) => PluginCapabilityActivation<readonly BaseTool[]>;
}

export type PluginCapabilityFactory = PluginProviderCapabilityFactory | PluginToolCapabilityFactory;

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
  factory: (
    | Omit<PluginProviderCapabilityFactory, "trust">
    | Omit<PluginToolCapabilityFactory, "trust">
  ) & {
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
  private readonly issuedDescriptors = new WeakSet<object>();

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

  activateProvider(
    descriptors: readonly PluginCapabilityDescriptor[],
    provider: LLMProvider,
    scope: PluginCapabilityActivationScope,
  ): LLMProvider {
    return descriptors
      .filter((descriptor) => descriptor.kind === "provider")
      .reduce((current, descriptor) => {
        const factory = this.requireFactory(descriptor);
        if (factory.kind !== "provider") {
          throw new Error(`Plugin capability '${descriptor.id}' is not a provider capability`);
        }
        const activationLabel = `${descriptor.pluginId}:${descriptor.id}@${descriptor.version}`;
        scope.assertAccepting(activationLabel);
        const activation = factory.activate({ descriptor, provider: current });
        if (!isActivation(activation)) {
          throw new Error(
            `Plugin provider capability '${descriptor.id}@${descriptor.version}' returned an invalid activation lease`,
          );
        }
        const activated = scope.register(activationLabel, activation);
        if (!isProvider(activated)) {
          throw new Error(
            `Plugin provider capability '${descriptor.id}@${descriptor.version}' returned an invalid provider`,
          );
        }
        if (
          typeof current.generateStream === "function" &&
          typeof activated.generateStream !== "function"
        ) {
          throw new Error(
            `Plugin provider capability '${descriptor.pluginId}:${descriptor.id}@${descriptor.version}' removed generateStream`,
          );
        }
        return activated;
      }, provider);
  }

  activateTools(
    descriptors: readonly PluginCapabilityDescriptor[],
    options: { readonly workDir: string },
    scope: PluginCapabilityActivationScope,
  ): readonly BaseTool[] {
    const tools: BaseTool[] = [];
    const names = new Set<string>();
    this.toolNames(descriptors);
    for (const descriptor of descriptors) {
      if (descriptor.kind !== "tool") continue;
      const factory = this.requireFactory(descriptor);
      if (factory.kind !== "tool") {
        throw new Error(`Plugin capability '${descriptor.id}' is not a tool capability`);
      }
      const advertisedNames = validateToolNames(
        factory.toolNames({ descriptor }),
        descriptor,
        names,
      );
      const activationLabel = `${descriptor.pluginId}:${descriptor.id}@${descriptor.version}`;
      scope.assertAccepting(activationLabel);
      const activation = factory.activate({ descriptor, workDir: options.workDir });
      if (!isActivation(activation)) {
        throw new Error(
          `Plugin tool capability '${descriptor.id}@${descriptor.version}' returned an invalid activation lease`,
        );
      }
      const activated = scope.register(activationLabel, activation);
      if (!Array.isArray(activated)) {
        throw new Error(
          `Plugin tool capability '${descriptor.id}@${descriptor.version}' must return a tool array`,
        );
      }
      const activatedNames: string[] = [];
      for (const tool of activated) {
        if (!isTool(tool)) {
          throw new Error(
            `Plugin tool capability '${descriptor.id}@${descriptor.version}' returned an invalid tool`,
          );
        }
        const name = tool.name();
        activatedNames.push(name);
        tools.push(tool);
      }
      if (!sameStrings(activatedNames, advertisedNames)) {
        throw new Error(
          `Plugin tool capability '${descriptor.id}@${descriptor.version}' activated tools that do not match toolNames()`,
        );
      }
      for (const name of advertisedNames) names.add(name);
    }
    return Object.freeze(tools);
  }

  /** Read tool names without constructing tools or acquiring plugin-owned resources. */
  toolNames(descriptors: readonly PluginCapabilityDescriptor[]): readonly string[] {
    const names = new Set<string>();
    for (const descriptor of descriptors) {
      if (descriptor.kind !== "tool") continue;
      const factory = this.requireFactory(descriptor);
      if (factory.kind !== "tool") {
        throw new Error(`Plugin capability '${descriptor.id}' is not a tool capability`);
      }
      validateToolNames(factory.toolNames({ descriptor }), descriptor, names).forEach((name) =>
        names.add(name),
      );
    }
    return Object.freeze([...names]);
  }

  resolve(
    plugin: Pick<ResolvedPluginIdentity, "id" | "version">,
    declarations: readonly PluginCapabilityDeclaration[],
    options: { readonly resourceDigest?: string; readonly pluginScope?: PluginScope } = {},
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
        const validated = validateDescriptor(factory, declaration, descriptor, plugin, options);
        this.issuedDescriptors.add(validated);
        capabilities.push(validated);
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

  private requireFactory(descriptor: PluginCapabilityDescriptor): PluginCapabilityFactory {
    if (!this.issuedDescriptors.has(descriptor)) {
      throw new Error(
        `Plugin capability '${descriptor.pluginId}:${descriptor.id}@${descriptor.version}' was not issued by this registry`,
      );
    }
    const factory = this.factories.get(descriptor.id);
    if (!factory) {
      throw new Error(
        `Plugin capability '${descriptor.id}@${descriptor.version}' has no host activation factory`,
      );
    }
    if (!supportsVersion(factory, descriptor.version) || factory.kind !== descriptor.kind) {
      throw new Error(
        `Plugin capability '${descriptor.id}@${descriptor.version}' does not match its host activation factory`,
      );
    }
    return factory;
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
  if (typeof factory.activate !== "function") {
    throw new Error(`Plugin capability factory ${factory.id} must provide activate()`);
  }
  if (factory.kind === "tool" && typeof factory.toolNames !== "function") {
    throw new Error(`Plugin tool capability factory ${factory.id} must provide toolNames()`);
  }
}

function validateToolNames(
  projected: readonly string[],
  descriptor: PluginCapabilityDescriptor,
  existing: ReadonlySet<string>,
): readonly string[] {
  if (!Array.isArray(projected)) {
    throw new Error(
      `Plugin tool capability '${descriptor.id}@${descriptor.version}' toolNames() must return an array`,
    );
  }
  const local = new Set<string>();
  for (const name of projected) {
    if (typeof name !== "string" || !name.trim() || local.has(name) || existing.has(name)) {
      throw new Error(
        `Plugin tool capability produced a duplicate or empty tool name: ${String(name)}`,
      );
    }
    local.add(name);
  }
  return Object.freeze([...local]);
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function supportsVersion(factory: PluginCapabilityFactory, version: string): boolean {
  return factory.versions.includes("*") || factory.versions.includes(version);
}

function validateDescriptor(
  factory: PluginCapabilityFactory,
  declaration: PluginCapabilityDeclaration,
  descriptor: PluginCapabilityFactoryDescriptor,
  plugin: Pick<ResolvedPluginIdentity, "id" | "version">,
  options: { readonly resourceDigest?: string; readonly pluginScope?: PluginScope },
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
    pluginId: plugin.id,
    ...(plugin.version ? { pluginVersion: plugin.version } : {}),
    ...(options.pluginScope ? { pluginScope: options.pluginScope } : {}),
    ...(options.resourceDigest ? { resourceDigest: options.resourceDigest } : {}),
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

function isProvider(value: unknown): value is LLMProvider {
  return isRecord(value) && typeof value.generate === "function";
}

function isActivation<Value>(value: unknown): value is PluginCapabilityActivation<Value> {
  return isRecord(value) && Object.hasOwn(value, "value") && typeof value.dispose === "function";
}

function isTool(value: unknown): value is BaseTool {
  return (
    isRecord(value) &&
    typeof value.name === "function" &&
    typeof value.definition === "function" &&
    typeof value.execute === "function"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
