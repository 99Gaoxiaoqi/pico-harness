import type {
  EffectiveConfigSnapshot,
  ResolveEffectiveConfigOptions,
} from "../input/effective-config.js";
import type { PicoUserConfig, UserConfigSnapshot } from "../input/user-config-store.js";

/**
 * Narrow configuration boundary consumed by provider runtime assembly.
 *
 * The provider layer only needs these two read operations. Concrete input stores and resolvers
 * are created by the host (TUI/daemon) and injected at the composition root.
 */
export interface ModelRuntimeConfigResolver {
  resolve(options: ResolveEffectiveConfigOptions): Promise<EffectiveConfigSnapshot>;
}

export interface ModelRuntimeUserConfigStore {
  read(): Promise<UserConfigSnapshot>;
}

/** Pure schema parser injected by the host into the durable provider-operation journal. */
export type ProviderUserConfigParser = (value: unknown, configPath: string) => PicoUserConfig;
