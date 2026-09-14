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

interface PluginRuntimeSnapshotGeneration {
  readonly snapshot: Promise<PluginRuntimeSnapshot>;
}

/**
 * Host-owned immutable Plugin projections, keyed by canonical workspace path.
 *
 * A Desktop catalog request and the following session.send must observe the same
 * materialized plugin tree. The registry also gives the owner one place to release
 * the runtime copies after all workspace runs have stopped.
 */
export class PluginRuntimeSnapshotRegistry {
  private readonly active = new Map<string, PluginRuntimeSnapshotGeneration>();
  /**
   * Invalidated generations stay alive until the owner closes the registry. Requests and Runs
   * may already hold their immutable snapshot, so eager disposal would revoke live authorities.
   */
  private readonly retired = new Set<PluginRuntimeSnapshotGeneration>();
  readonly capabilityRegistry: PluginCapabilityRegistry;
  private readonly options: PluginRuntimeSnapshotRegistryOptions;
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(options: PluginRuntimeSnapshotRegistryOptions = {}) {
    this.capabilityRegistry = options.capabilityRegistry ?? createBuiltinPluginCapabilityRegistry();
    this.options = { ...options, capabilityRegistry: this.capabilityRegistry };
  }

  get(workDir: string): Promise<PluginRuntimeSnapshot> {
    if (this.disposed) throw new Error("Plugin runtime snapshot registry is disposed");
    const key = resolve(workDir);
    const existing = this.active.get(key);
    if (existing) return existing.snapshot;

    const { loadSnapshot, ...snapshotOptions } = this.options;
    const loading = Promise.resolve().then(() =>
      loadSnapshot
        ? loadSnapshot(key, snapshotOptions)
        : loadPluginRuntimeSnapshot({ workDir: key, ...snapshotOptions }),
    );
    const generation = { snapshot: loading };
    void loading.catch(() => {
      if (this.active.get(key) === generation) this.active.delete(key);
      this.retired.delete(generation);
    });
    this.active.set(key, generation);
    return loading;
  }

  /**
   * Retire the current workspace generation without disposing it. A later get starts a fresh
   * generation, while resources borrowed by in-flight work remain valid until owner close.
   */
  invalidate(workDir: string): boolean {
    if (this.disposed) throw new Error("Plugin runtime snapshot registry is disposed");
    const key = resolve(workDir);
    const generation = this.active.get(key);
    if (!generation) return false;
    this.active.delete(key);
    this.retired.add(generation);
    return true;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const generations = new Set([...this.active.values(), ...this.retired]);
    this.active.clear();
    this.retired.clear();
    this.disposePromise = disposeGenerations(generations);
    return this.disposePromise;
  }
}

async function disposeGenerations(
  generations: ReadonlySet<PluginRuntimeSnapshotGeneration>,
): Promise<void> {
  const loaded = await Promise.allSettled([...generations].map(({ snapshot }) => snapshot));
  const snapshots = new Set(
    loaded.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
  );
  const results = await Promise.allSettled(
    [...snapshots].map((snapshot) => Promise.resolve().then(() => snapshot.dispose())),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Plugin runtime snapshot disposal failed");
  }
}
