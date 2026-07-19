import type { LLMProvider } from "../provider/interface.js";
import type {
  PluginCapabilityActivationScope,
  PluginCapabilityRegistry,
} from "./plugin-capability.js";
import type { PluginRuntimeSnapshot } from "./plugin-runtime-snapshot.js";

/** Apply the ordered Provider decorators from one immutable Plugin snapshot. */
export function activatePluginProviderCapabilities(
  snapshot: PluginRuntimeSnapshot | undefined,
  capabilityRegistry: PluginCapabilityRegistry | undefined,
  provider: LLMProvider,
  activationScope: PluginCapabilityActivationScope,
): LLMProvider {
  const capabilities = snapshot?.capabilities.filter((item) => item.kind === "provider") ?? [];
  if (capabilities.length === 0) return provider;
  if (!capabilityRegistry) {
    throw new Error(
      "Plugin snapshot contains provider capabilities but no host capability registry was supplied",
    );
  }
  return capabilityRegistry.activateProvider(capabilities, provider, activationScope);
}
