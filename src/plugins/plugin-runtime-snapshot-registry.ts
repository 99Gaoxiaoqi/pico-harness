import { resolve } from "node:path";
import {
  loadPluginRuntimeSnapshot,
  type PluginRuntimeSnapshot,
  type PluginRuntimeSnapshotOptions,
} from "./plugin-runtime-snapshot.js";
import {
  createBuiltinPluginCapabilityRegistry,
  type PluginCapabilityRegistry,
} from "./plugin-capability.js";

export interface PluginRuntimeSnapshotRegistryOptions extends Omit<
  PluginRuntimeSnapshotOptions,
  "workDir"
> {
  /** Test seam for a host-owned snapshot loader. */
  readonly loadSnapshot?: (
    workDir: string,
    options: Omit<PluginRuntimeSnapshotOptions, "workDir">,
  ) => Promise<PluginRuntimeSnapshot>;
}

/**
 * Host-owned immutable Plugin projections, keyed by canonical workspace path.
 *
 * A Desktop catalog request and the following session.send must observe the same
 * materialized plugin tree. The registry also gives the owner one place to release
 * the runtime copies after all workspace runs have stopped.
 */
export class PluginRuntimeSnapshotRegistry {
  private readonly snapshots = new Map<string, Promise<PluginRuntimeSnapshot>>();
  readonly capabilityRegistry: PluginCapabilityRegistry;
  private readonly options: PluginRuntimeSnapshotRegistryOptions;
  private disposed = false;

  constructor(options: PluginRuntimeSnapshotRegistryOptions = {}) {
    this.capabilityRegistry = options.capabilityRegistry ?? createBuiltinPluginCapabilityRegistry();
    this.options = { ...options, capabilityRegistry: this.capabilityRegistry };
  }

  get(workDir: string): Promise<PluginRuntimeSnapshot> {
    if (this.disposed) throw new Error("Plugin runtime snapshot registry is disposed");
    const key = resolve(workDir);
    const existing = this.snapshots.get(key);
    if (existing) return existing;

    const { loadSnapshot, ...snapshotOptions } = this.options;
    const loading = (
      loadSnapshot
        ? loadSnapshot(key, snapshotOptions)
        : loadPluginRuntimeSnapshot({ workDir: key, ...snapshotOptions })
    ).catch((error: unknown) => {
      this.snapshots.delete(key);
      throw error;
    });
    this.snapshots.set(key, loading);
    return loading;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const snapshots = await Promise.allSettled(this.snapshots.values());
    this.snapshots.clear();
    const disposal = snapshots.map((result) =>
      result.status === "fulfilled" ? result.value.dispose() : Promise.resolve(),
    );
    const results = await Promise.allSettled(disposal);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Plugin runtime snapshot disposal failed");
    }
  }
}
