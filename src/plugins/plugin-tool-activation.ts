import type {
  PluginCapabilityActivationScope,
  PluginCapabilityRegistry,
} from "./plugin-capability.js";
import type { PluginRuntimeSnapshot } from "./plugin-runtime-snapshot.js";
import { createToolRegistrationOwner, type ToolRegistry } from "../tools/registry-impl.js";

/** Activate one immutable Plugin snapshot into a normal ToolRegistry ownership boundary. */
export function registerPluginCapabilityTools(
  registry: ToolRegistry,
  snapshot: PluginRuntimeSnapshot | undefined,
  capabilityRegistry: PluginCapabilityRegistry | undefined,
  workDir: string,
  activationScope: PluginCapabilityActivationScope,
): void {
  const capabilities = snapshot?.capabilities.filter((item) => item.kind === "tool") ?? [];
  if (capabilities.length === 0) return;
  if (!capabilityRegistry) {
    throw new Error(
      "Plugin snapshot contains tool capabilities but no host capability registry was supplied",
    );
  }
  const owner = createToolRegistrationOwner(
    "plugin",
    capabilities
      .map((descriptor) => `${descriptor.pluginId}:${descriptor.id}@${descriptor.version}`)
      .join(","),
  );
  const advertisedNames = capabilityRegistry.toolNames(capabilities);
  for (const name of advertisedNames) {
    const existing = registry.getTool(name);
    if (!existing) continue;
    const existingOwner = registry.getToolOwner(name);
    const ownerLabel = existingOwner
      ? `${existingOwner.kind}:${existingOwner.id}`
      : "an existing host tool";
    throw new Error(`Tool '${name}' conflicts with ${ownerLabel}`);
  }
  const tools = capabilityRegistry.activateTools(capabilities, { workDir }, activationScope);
  const registered: string[] = [];
  try {
    for (const tool of tools) {
      registry.registerOwned(tool, owner);
      registered.push(tool.name());
    }
  } catch (error) {
    for (const name of registered) registry.unregisterOwned(name, owner);
    throw error;
  }
}
